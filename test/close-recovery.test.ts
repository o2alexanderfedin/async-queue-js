/**
 * D8 — close() must not silently destroy blocked producers' payloads.
 *
 * Before: close() rejected each blocked producer with a bare
 * `new Error('Queue is closed')`. The error named no payload, close() returned
 * `undefined`, and the producer's item had already been moved into the waiter,
 * so a caller sitting in `await queue.enqueue(job)` was told only *that* it
 * failed, never *what* was lost. At-least-once delivery cannot be layered on
 * top of a queue that loses items without naming them.
 *
 * After: the item is reachable three ways — `QueueClosedError.item`, the
 * `onDropped` hook, and the array `close()` returns.
 */
import { AsyncQueue, QueueClosedError } from '../src/index';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

interface Job { id: number; payload: string }

describe('D8: the rejection carries the item that was not enqueued', () => {
  test('a blocked producer learns exactly which item it lost', async () => {
    const q = new AsyncQueue<Job>(1);
    await q.enqueue({ id: 0, payload: 'buffered' });

    const lost: Job[] = [];
    const p1 = q.enqueue({ id: 1, payload: 'one' }).catch((e: QueueClosedError<Job>) => { lost.push(e.item); });
    const p2 = q.enqueue({ id: 2, payload: 'two' }).catch((e: QueueClosedError<Job>) => { lost.push(e.item); });
    await sleep(5);
    expect(q.waitingProducerCount).toBe(2);

    q.close();
    await Promise.all([p1, p2]);

    expect(lost).toEqual([{ id: 1, payload: 'one' }, { id: 2, payload: 'two' }]);
  });

  test('the rejection is a QueueClosedError and still an Error with the old message', async () => {
    const q = new AsyncQueue<string>(1);
    await q.enqueue('A');
    const blocked = q.enqueue('B');
    await sleep(5);
    q.close();

    const err = await blocked.then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(QueueClosedError);
    expect(err).toBeInstanceOf(Error);              // existing catch blocks keep working
    expect((err as Error).message).toBe('Queue is closed');
    expect((err as Error).name).toBe('QueueClosedError');
    expect((err as QueueClosedError<string>).item).toBe('B');
    expect((err as Error).stack).toContain('QueueClosedError');
  });

  test('enqueue AFTER close also names the refused item', async () => {
    const q = new AsyncQueue<string>(4);
    q.close();
    const err = await q.enqueue('too late').then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(QueueClosedError);
    expect((err as QueueClosedError<string>).item).toBe('too late');
  });

  test('an item that is legitimately undefined is still identified as the lost payload', async () => {
    const q = new AsyncQueue<string | undefined>(1);
    await q.enqueue('A');
    const blocked = q.enqueue(undefined);
    await sleep(5);
    q.close();

    const err = await blocked.then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(QueueClosedError);
    expect((err as QueueClosedError<string | undefined>).item).toBeUndefined();
    // 'item' is an own property, so "carries undefined" is distinguishable from
    // "carries nothing".
    expect(Object.prototype.hasOwnProperty.call(err, 'item')).toBe(true);
  });
});

describe('D8: close() hands back everything it could not enqueue', () => {
  test('close() returns the blocked items in FIFO order', async () => {
    const q = new AsyncQueue<number>(2);
    await q.enqueue(0);
    await q.enqueue(1);                              // buffered, NOT lost

    const blocked = [2, 3, 4, 5].map(n => q.enqueue(n).catch(() => {}));
    await sleep(5);
    expect(q.waitingProducerCount).toBe(4);

    const undelivered = q.close();
    await Promise.all(blocked);

    expect(undelivered).toEqual([2, 3, 4, 5]);
    // The buffered items are not "lost" — they are still drainable.
    expect(await q.drain()).toEqual([0, 1]);
  });

  test('close() returns an empty array when nothing was blocked', async () => {
    const q = new AsyncQueue<number>(4);
    await q.enqueue(1);
    expect(q.close()).toEqual([]);
  });

  test('close() is still idempotent and reports the loss exactly once', async () => {
    const q = new AsyncQueue<number>(1);
    await q.enqueue(0);
    const blocked = q.enqueue(1).catch(() => {});
    await sleep(5);

    expect(q.close()).toEqual([1]);
    expect(q.close()).toEqual([]);
    expect(q.close()).toEqual([]);
    await blocked;
  });

  test('an aborted producer is NOT reported as dropped by close()', async () => {
    const q = new AsyncQueue<string>(1);
    await q.enqueue('A');

    const controller = new AbortController();
    const aborted = q.enqueue('ABORTED', { signal: controller.signal }).catch((e: Error) => e.name);
    const live = q.enqueue('LIVE').catch(() => {});
    await sleep(5);

    controller.abort();
    expect(await aborted).toMatch(/abort/i);

    // Its caller already knows it lost the item; close() must not claim it too.
    expect(q.close()).toEqual(['LIVE']);
    await live;
  });

  test('the three recovery channels agree, item for item', async () => {
    const viaHook: Array<[string, number]> = [];
    const q = new AsyncQueue<number>(1, {
      onDropped: (error, item) => {
        viaHook.push([error.message, item]);
        expect(error.item).toBe(item);              // both spellings, same value
      }
    });
    await q.enqueue(0);

    const viaCatch: number[] = [];
    const blocked = [1, 2, 3].map(n =>
      q.enqueue(n).catch((e: QueueClosedError<number>) => { viaCatch.push(e.item); })
    );
    await sleep(5);

    const viaReturn = q.close();
    await Promise.all(blocked);

    expect(viaReturn).toEqual([1, 2, 3]);
    expect(viaCatch).toEqual([1, 2, 3]);
    expect(viaHook).toEqual([['Queue is closed', 1], ['Queue is closed', 2], ['Queue is closed', 3]]);
  });
});

describe('D8: at-least-once delivery is now constructible', () => {
  test('a shutdown handoff loses nothing across two queues', async () => {
    const TOTAL = 40;
    const primary = new AsyncQueue<number>(2);
    const backup = new AsyncQueue<number>(TOTAL);

    const delivered: number[] = [];
    const consumer = (async () => {
      for (;;) {
        const r = await primary.dequeueResult();
        if (r.done) return;
        delivered.push(r.value);
        await sleep(0);
      }
    })();

    // Producers only *record* the loss; the queue's owner does the recovery, so
    // each lost item is rescued exactly once. Both channels see the same items,
    // which is asserted below.
    const seenByProducers: number[] = [];
    const producers = Array.from({ length: TOTAL }, (_, i) => (async () => {
      try {
        await primary.enqueue(i);
      } catch (err) {
        if (!(err instanceof QueueClosedError)) throw err;
        seenByProducers.push(err.item as number);
      }
    })());

    await sleep(5);
    // Close mid-flight; whatever was blocked at that instant is handed back.
    const undelivered = primary.close();
    for (const item of undelivered) await backup.enqueue(item);

    await Promise.all(producers);
    await consumer;
    backup.close();
    const rescued = await backup.drain();

    // The producers' view and the owner's view are the same loss, not two.
    expect(seenByProducers).toEqual(undelivered);
    expect(undelivered.length).toBeGreaterThan(0);   // the scenario really did drop items

    const all = [...delivered, ...rescued].sort((a, b) => a - b);
    expect(new Set(all).size).toBe(all.length);      // nothing delivered twice
    expect(all).toEqual(Array.from({ length: TOTAL }, (_, i) => i));   // nothing lost
  }, 30000);
});
