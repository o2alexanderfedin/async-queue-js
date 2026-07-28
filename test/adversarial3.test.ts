/**
 * Third adversarial pass — aimed at the seams the D1-D9 fixes THEMSELVES
 * introduced, rather than at the original defects.
 *
 * Two defects were found here and are pinned by D10 and D11 below. The rest of
 * the file is re-attack that found nothing, kept so the next pass does not have
 * to re-derive it.
 */
import { AsyncQueue, QueueClosedError, DequeueResult } from '../src/index';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Runs `body` with a process-level unhandledRejection recorder installed. */
async function withUnhandledRejections(body: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const onUnhandled = (r: unknown): void => { seen.push(r); };
  process.on('unhandledRejection', onUnhandled);
  try {
    await body();
    await sleep(50);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  return seen;
}

/* ------------------------------------------------------------------------- *
 * D10 — the D3 cancellation path re-opened the D1 process kill.
 *
 * D1 suppressed the rejection close() delivers to a blocked producer. D3 then
 * added a SECOND way to reject that same promise — abort — and did not suppress
 * it. `void queue.enqueue(x, { signal })` is the exact fire-and-forget shape the
 * README teaches; aborting it terminated the host process on Node >= 15.
 * ------------------------------------------------------------------------- */
describe('D10: aborting a fire-and-forget enqueue must not kill the process', () => {
  test('aborting blocked fire-and-forget producers emits no unhandled rejection', async () => {
    const seen = await withUnhandledRejections(async () => {
      const q = new AsyncQueue<number>(1);
      await q.enqueue(0);
      const controllers: AbortController[] = [];
      for (let i = 1; i <= 25; i++) {
        const c = new AbortController();
        controllers.push(c);
        void q.enqueue(i, { signal: c.signal });   // no handler attached anywhere
      }
      await sleep(5);
      expect(q.waitingProducerCount).toBe(25);
      for (const c of controllers) c.abort();      // shutdown cancels them all
      expect(q.waitingProducerCount).toBe(0);
    });
    expect(seen).toEqual([]);
  });

  test('a fire-and-forget enqueue with an ALREADY-aborted signal is not reported globally', async () => {
    const seen = await withUnhandledRejections(async () => {
      const q = new AsyncQueue<number>(1);
      await q.enqueue(0);                          // fill it, so the next call blocks
      const c = new AbortController();
      c.abort();
      void q.enqueue(1, { signal: c.signal });
    });
    expect(seen).toEqual([]);
  });

  test('close() and abort() racing over the same producer set stay silent', async () => {
    const seen = await withUnhandledRejections(async () => {
      const q = new AsyncQueue<number>(1);
      await q.enqueue(0);
      const controllers: AbortController[] = [];
      for (let i = 1; i <= 20; i++) {
        const c = new AbortController();
        controllers.push(c);
        void q.enqueue(i, { signal: c.signal });
      }
      await sleep(5);
      for (let i = 0; i < controllers.length; i += 2) controllers[i]!.abort();  // cancel half
      q.close();                                                               // close the rest
      for (const c of controllers) c.abort();                                  // abort again, post-close
    });
    expect(seen).toEqual([]);
  });

  test('suppression does not consume the abort: awaiting callers still see it', async () => {
    const q = new AsyncQueue<number>(1);
    await q.enqueue(0);
    const c = new AbortController();
    const blocked = q.enqueue(1, { signal: c.signal });
    await sleep(5);
    c.abort();
    await expect(blocked).rejects.toThrow(/abort/i);
    // a second, independent handler on the same promise also sees it
    await expect(blocked).rejects.toThrow(/abort/i);
  });

  test('an aborted producer never inserts its item, and close() does not report it', async () => {
    const dropped: number[] = [];
    const q = new AsyncQueue<number>(1, { onDropped: (_e, item) => { dropped.push(item); } });
    await q.enqueue(0);
    const c = new AbortController();
    const cancelled = q.enqueue(1, { signal: c.signal }).catch((e: Error) => e.name);
    const survivor = q.enqueue(2).catch((e: Error) => e.name);
    await sleep(5);
    c.abort();
    await expect(cancelled).resolves.toMatch(/abort/i);

    expect(await q.dequeue()).toBe(0);
    expect(await q.dequeue()).toBe(2);     // 1 was cancelled, never buffered
    await survivor;
    expect(q.close()).toEqual([]);
    expect(dropped).toEqual([]);           // an abort is not a drop
  });
});

/* ------------------------------------------------------------------------- *
 * D11 — the hand-written cursor tracked only ONE in-flight next().
 *
 * D7 replaced the async generator with a hand-written cursor so that return()
 * could cancel the parked waiter synchronously. It kept a single `pending` slot.
 * A second next() overwrote it, orphaning the first waiter: return() could not
 * release it (D7's deadlock, back again) and — worse — it stayed queued and
 * swallowed the next enqueued item.
 * ------------------------------------------------------------------------- */
describe('D11: return() must release EVERY in-flight next()', () => {
  test('two concurrent next() calls are both settled by return()', async () => {
    const q = new AsyncQueue<string>(4);
    const it = q[Symbol.asyncIterator]();
    const p1 = it.next();
    const p2 = it.next();
    await sleep(5);
    expect(q.waitingConsumerCount).toBe(2);

    await it.return!(undefined);

    await expect(Promise.race([p1, sleep(200).then(() => 'HANG')])).resolves.toEqual({ done: true, value: undefined });
    await expect(Promise.race([p2, sleep(200).then(() => 'HANG')])).resolves.toEqual({ done: true, value: undefined });
    expect(q.waitingConsumerCount).toBe(0);
  });

  test('a torn-down iterator cannot swallow an item enqueued afterwards', async () => {
    const q = new AsyncQueue<string>(4);
    const it = q[Symbol.asyncIterator]();
    const p1 = it.next();
    const p2 = it.next();
    await sleep(5);
    await it.return!(undefined);
    await sleep(5);

    await q.enqueue('X');
    await sleep(5);

    expect(q.size).toBe(1);                                   // X stayed in the queue
    await expect(p1).resolves.toEqual({ done: true, value: undefined });
    await expect(p2).resolves.toEqual({ done: true, value: undefined });
    expect(await q.dequeue()).toBe('X');                      // and is still deliverable
  });

  test('poll-with-timeout then return() leaves nothing parked (no concurrency needed)', async () => {
    const q = new AsyncQueue<string>(4);
    const it = q[Symbol.asyncIterator]();

    const first = it.next();
    await Promise.race([first, sleep(10)]);   // abandoned, not cancelled
    const second = it.next();                 // used to overwrite `pending`
    await sleep(5);
    expect(q.waitingConsumerCount).toBe(2);

    await it.return!(undefined);
    expect(q.waitingConsumerCount).toBe(0);

    await q.enqueue('X');
    expect(q.size).toBe(1);
    await expect(first).resolves.toEqual({ done: true, value: undefined });
    await expect(second).resolves.toEqual({ done: true, value: undefined });
  });

  test('toAsyncGenerator() has the same guarantee', async () => {
    const q = new AsyncQueue<number>(4);
    const g = q.toAsyncGenerator();
    const p1 = g.next();
    const p2 = g.next();
    await sleep(5);

    await expect(Promise.race([g.return(undefined), sleep(200).then(() => 'HANG')])).resolves.not.toBe('HANG');
    await expect(Promise.race([p1, sleep(200).then(() => 'HANG')])).resolves.toEqual({ done: true, value: undefined });
    await expect(Promise.race([p2, sleep(200).then(() => 'HANG')])).resolves.toEqual({ done: true, value: undefined });
    expect(q.waitingConsumerCount).toBe(0);
  });

  test('throw() also releases every in-flight next()', async () => {
    const q = new AsyncQueue<number>(4);
    const it = q[Symbol.asyncIterator]();
    const p1 = it.next();
    const p2 = it.next();
    await sleep(5);

    await expect(it.throw!(new Error('boom'))).rejects.toThrow('boom');
    await expect(Promise.race([p1, sleep(200).then(() => 'HANG')])).resolves.toEqual({ done: true, value: undefined });
    await expect(Promise.race([p2, sleep(200).then(() => 'HANG')])).resolves.toEqual({ done: true, value: undefined });
    expect(q.waitingConsumerCount).toBe(0);
  });

  test('many in-flight next() calls are all released, and nothing is left in the queue', async () => {
    const q = new AsyncQueue<number>(4);
    const it = q[Symbol.asyncIterator]();
    const pending = Array.from({ length: 50 }, () => it.next());
    await sleep(5);
    expect(q.waitingConsumerCount).toBe(50);

    await it.return!(undefined);
    expect(q.waitingConsumerCount).toBe(0);

    const settled = await Promise.race([Promise.all(pending), sleep(500).then(() => 'HANG')]);
    expect(settled).not.toBe('HANG');
    expect((settled as IteratorResult<number>[]).every(r => r.done === true)).toBe(true);
  });

  test('sequential for-await is unaffected — the ordinary path still drains in order', async () => {
    const q = new AsyncQueue<number>(2);
    const out: number[] = [];
    const consumer = (async () => { for await (const v of q) out.push(v); })();
    for (let i = 0; i < 200; i++) await q.enqueue(i);
    q.close();
    await consumer;
    expect(out).toEqual(Array.from({ length: 200 }, (_, i) => i));
    expect(q.waitingConsumerCount).toBe(0);
  });
});

/* ------------------------------------------------------------------------- *
 * Re-attack that found nothing. Kept as regression pins.
 * ------------------------------------------------------------------------- */
describe('cancellation interacting with close()', () => {
  test('close() after every producer aborted returns an empty drop list', async () => {
    const q = new AsyncQueue<number>(1);
    await q.enqueue(0);
    const controllers = Array.from({ length: 10 }, () => new AbortController());
    const ps = controllers.map((c, i) => q.enqueue(i + 1, { signal: c.signal }).catch(() => 'cancelled'));
    await sleep(5);
    for (const c of controllers) c.abort();
    await Promise.all(ps);
    expect(q.waitingProducerCount).toBe(0);
    expect(q.close()).toEqual([]);
  });

  test('close() reports only the producers that were still live', async () => {
    const q = new AsyncQueue<number>(1);
    await q.enqueue(0);
    const c1 = new AbortController();
    const c2 = new AbortController();
    const ps = [
      q.enqueue(1, { signal: c1.signal }).catch(() => {}),
      q.enqueue(2).catch(() => {}),
      q.enqueue(3, { signal: c2.signal }).catch(() => {}),
      q.enqueue(4).catch(() => {})
    ];
    await sleep(5);
    c1.abort();
    c2.abort();
    expect(q.close()).toEqual([2, 4]);   // FIFO, cancelled ones excluded
    await Promise.all(ps);
  });

  test('aborting AFTER close() settled the waiter is a no-op', async () => {
    const q = new AsyncQueue<number>(1);
    await q.enqueue(0);
    const c = new AbortController();
    const blocked = q.enqueue(1, { signal: c.signal }).catch((e: Error) => e.name);
    await sleep(5);
    expect(q.close()).toEqual([1]);
    c.abort();                                    // too late; must not double-settle
    await expect(blocked).resolves.toBe('QueueClosedError');
    expect(q.waitingProducerCount).toBe(0);
  });

  test('aborting a consumer AFTER close() released it is a no-op', async () => {
    const q = new AsyncQueue<number>(1);
    const c = new AbortController();
    const blocked = q.dequeue({ signal: c.signal });
    await sleep(5);
    q.close();
    c.abort();
    await expect(blocked).resolves.toBeUndefined();
    expect(q.waitingConsumerCount).toBe(0);
  });

  test('a consumer aborted before close() does not consume the end-of-stream signal', async () => {
    const q = new AsyncQueue<number>(4);
    const c = new AbortController();
    const cancelled = q.dequeue({ signal: c.signal }).catch((e: Error) => e.name);
    const live = q.dequeue();
    await sleep(5);
    c.abort();
    await expect(cancelled).resolves.toMatch(/abort/i);
    expect(q.waitingConsumerCount).toBe(1);
    q.close();
    await expect(live).resolves.toBeUndefined();
  });

  test('onDropped may abort another producer mid-close without corrupting the queue', async () => {
    let victim: AbortController | undefined;
    const q = new AsyncQueue<number>(1, { onDropped: () => { victim?.abort(); } });
    await q.enqueue(0);
    const first = q.enqueue(1).catch((e: Error) => e.name);
    victim = new AbortController();
    const second = q.enqueue(2, { signal: victim.signal }).catch((e: Error) => e.name);
    await sleep(5);

    const dropped = q.close();
    expect(dropped).toEqual([1]);                       // 2 left via abort, not via close
    await expect(first).resolves.toBe('QueueClosedError');
    await expect(second).resolves.toMatch(/abort/i);
    expect(q.waitingProducerCount).toBe(0);
  });
});

describe('FIFO wake order under mixed producer/consumer cancellation', () => {
  test('cancelled producers are skipped, survivors keep call order', async () => {
    const q = new AsyncQueue<string>(1);
    await q.enqueue('seed');
    const controllers = Array.from({ length: 6 }, () => new AbortController());
    const ps = controllers.map((c, i) => q.enqueue('P' + i, { signal: c.signal }).catch(() => {}));
    await sleep(5);
    controllers[1]!.abort();
    controllers[3]!.abort();
    controllers[4]!.abort();
    await sleep(5);
    expect(q.waitingProducerCount).toBe(3);

    const out: (string | undefined)[] = [];
    for (let i = 0; i < 4; i++) out.push(await q.dequeue());
    expect(out).toEqual(['seed', 'P0', 'P2', 'P5']);
    q.close();
    await Promise.all(ps);
  });

  test('cancelled consumers are skipped, survivors keep arrival order', async () => {
    const q = new AsyncQueue<string>(4);
    const controllers: AbortController[] = [];
    const got: (string | undefined)[] = new Array(6).fill(null);
    for (let i = 0; i < 6; i++) {
      const c = new AbortController();
      controllers.push(c);
      void q.dequeue({ signal: c.signal }).then(
        v => { got[i] = v; },
        () => { got[i] = 'CANCELLED'; }
      );
      await sleep(1);
    }
    controllers[0]!.abort();
    controllers[2]!.abort();
    controllers[5]!.abort();
    await sleep(5);
    expect(q.waitingConsumerCount).toBe(3);

    for (const v of ['a', 'b', 'c']) await q.enqueue(v);
    await sleep(20);
    expect(got).toEqual(['CANCELLED', 'a', 'CANCELLED', 'b', 'c', 'CANCELLED']);
    expect(q.size).toBe(0);
    q.close();
  });

  test('cancelling the HEAD of the producer queue does not stall the rest', async () => {
    const q = new AsyncQueue<string>(1);
    await q.enqueue('seed');
    const head = new AbortController();
    const ps = [
      q.enqueue('HEAD', { signal: head.signal }).catch(() => 'cancelled'),
      q.enqueue('A').catch(() => {}),
      q.enqueue('B').catch(() => {})
    ];
    await sleep(5);
    head.abort();
    expect(await q.dequeue()).toBe('seed');
    expect(await q.dequeue()).toBe('A');
    expect(await q.dequeue()).toBe('B');
    await Promise.all(ps);
    q.close();
  });

  test('cancelling the TAIL of the consumer queue does not disturb the head', async () => {
    const q = new AsyncQueue<string>(4);
    const results: string[] = [];
    const tail = new AbortController();
    const head = q.dequeueResult().then(r => { results.push('head:' + String(r.value)); });
    await sleep(1);
    const t = q.dequeueResult({ signal: tail.signal }).catch(() => { results.push('tail:cancelled'); });
    await sleep(1);
    tail.abort();
    await t;
    await q.enqueue('X');
    await head;
    expect(results).toEqual(['tail:cancelled', 'head:X']);
  });
});

describe('the DequeueResult type cannot collide with a user value', () => {
  test('a payload shaped exactly like the end-of-stream sentinel is delivered as a payload', async () => {
    const q = new AsyncQueue<{ done: boolean; value: undefined }>(4);
    const lookalike = { done: true as const, value: undefined };
    await q.enqueue(lookalike);
    q.close();

    const r1 = await q.dequeueResult();
    expect(r1.done).toBe(false);
    expect(r1.done === false && r1.value).toBe(lookalike);   // identity, not a copy

    const r2 = await q.dequeueResult();
    expect(r2.done).toBe(true);
  });

  test('the FROZEN sentinel object itself round-trips as a payload', async () => {
    const frozen = Object.freeze({ done: true as const, value: undefined });
    const q = new AsyncQueue<typeof frozen>(4);
    await q.enqueue(frozen);
    await q.enqueue(frozen);
    q.close();
    const all = await q.drain();
    expect(all).toHaveLength(2);
    expect(all[0]).toBe(frozen);
  });

  test('for-await yields sentinel-shaped payloads instead of terminating', async () => {
    const q = new AsyncQueue<{ done: boolean; value: undefined }>(4);
    await q.enqueue({ done: true, value: undefined });
    await q.enqueue({ done: true, value: undefined });
    q.close();
    const out: unknown[] = [];
    for await (const v of q) out.push(v);
    expect(out).toHaveLength(2);
  });

  test('the shared end-of-stream result cannot be mutated by a caller', async () => {
    const q = new AsyncQueue<number>(1);
    q.close();
    const r = await q.dequeueResult() as DequeueResult<number> & { done: boolean };
    expect(r.done).toBe(true);
    expect(() => { (r as { done: boolean }).done = false; }).toThrow();  // frozen
    const again = await q.dequeueResult();
    expect(again.done).toBe(true);                                       // not corrupted
  });

  test('a handed-off item is never confused with end-of-stream, even when undefined', async () => {
    const q = new AsyncQueue<undefined>(4);
    const waiting = q.dequeueResult();
    await sleep(1);
    await q.enqueue(undefined);
    const r = await waiting;
    expect(r.done).toBe(false);
    expect(r.value).toBeUndefined();
  });
});

describe('constructor validation boundaries', () => {
  test('exactly 1 is the smallest accepted capacity', () => {
    const q = new AsyncQueue<number>(1);
    expect(q.capacity).toBe(1);
    expect(q.isFull).toBe(false);
    expect(q.isEmpty).toBe(true);
  });

  test('just below 1 is rejected', () => {
    expect(() => new AsyncQueue(0.999999)).toThrow(/at least 1/);
    expect(() => new AsyncQueue(Number.MIN_VALUE)).toThrow(/at least 1/);
    expect(() => new AsyncQueue(0)).toThrow(/at least 1/);
    expect(() => new AsyncQueue(-1)).toThrow(/at least 1/);
    expect(() => new AsyncQueue(-0)).toThrow(/at least 1/);
  });

  test('just above 1 rounds up rather than truncating below the request', () => {
    expect(new AsyncQueue(1.0000001).capacity).toBe(2);
    expect(new AsyncQueue(1.5).capacity).toBe(2);
  });

  test('exactly 2^30 is accepted and is MAX_CAPACITY', () => {
    expect(AsyncQueue.MAX_CAPACITY).toBe(2 ** 30);
    const q = new AsyncQueue<number>(2 ** 30);
    expect(q.capacity).toBe(2 ** 30);
  });

  test('2^30 + 1 clamps to 2^30 instead of throwing or corrupting the buffer', () => {
    const q = new AsyncQueue<number>(2 ** 30 + 1);
    expect(q.capacity).toBe(2 ** 30);
  });

  test('2^30 - 1 keeps its exact capacity', () => {
    expect(new AsyncQueue(2 ** 30 - 1).capacity).toBe(2 ** 30 - 1);
  });

  test('a 2^30 queue is still functionally a queue', async () => {
    const q = new AsyncQueue<string>(2 ** 30);
    await q.enqueue('a');
    await q.enqueue('b');
    expect(q.size).toBe(2);
    expect(await q.dequeue()).toBe('a');
    expect(await q.dequeue()).toBe('b');
    q.close();
  });

  test('NaN and non-numbers are rejected with a TypeError', () => {
    expect(() => new AsyncQueue(NaN)).toThrow(TypeError);
    expect(() => new AsyncQueue('4' as unknown as number)).toThrow(TypeError);
    expect(() => new AsyncQueue(null as unknown as number)).toThrow(TypeError);
    expect(() => new AsyncQueue(true as unknown as number)).toThrow(TypeError);
    expect(() => new AsyncQueue({} as unknown as number)).toThrow(TypeError);
  });

  test('undefined falls back to the documented default of 1', () => {
    expect(new AsyncQueue(undefined).capacity).toBe(1);
    expect(new AsyncQueue().capacity).toBe(1);
  });

  test('a capacity-1 queue enforces backpressure at exactly one item', async () => {
    const q = new AsyncQueue<number>(1);
    await q.enqueue(1);
    expect(q.isFull).toBe(true);
    let settled = false;
    const blocked = q.enqueue(2).then(() => { settled = true; });
    await sleep(5);
    expect(settled).toBe(false);
    expect(await q.dequeue()).toBe(1);
    await blocked;
    expect(settled).toBe(true);
    expect(await q.dequeue()).toBe(2);
    q.close();
  });
});

describe('QueueClosedError identity survives the seams the packaging fix introduced', () => {
  test('a subclass keeps exact instanceof semantics in both directions', () => {
    class AppError extends QueueClosedError<number> {}
    const sub = new AppError(7);
    expect(sub instanceof AppError).toBe(true);
    expect(sub instanceof QueueClosedError).toBe(true);
    expect(sub.item).toBe(7);
    expect(new QueueClosedError(1) instanceof AppError).toBe(false);
  });

  test('unrelated errors and plain objects are not mistaken for it', () => {
    expect(new Error('x') instanceof QueueClosedError).toBe(false);
    expect(({} as unknown) instanceof QueueClosedError).toBe(false);
    expect((null as unknown) instanceof QueueClosedError).toBe(false);
    expect(('Queue is closed' as unknown) instanceof QueueClosedError).toBe(false);
  });

  test('the branded check recognises an error from a separately-loaded copy', () => {
    // Simulates the dual-package hazard without a second module instance: the
    // brand is a registry symbol, so any object carrying it must be accepted.
    const brand = Symbol.for('@alexanderfedin/async-queue:QueueClosedError:v2');
    const foreign = Object.assign(new Error('Queue is closed'), { [brand]: true });
    expect(foreign instanceof QueueClosedError).toBe(true);
  });
});

describe('previously-correct behaviour has not regressed', () => {
  test('single-slot ping-pong stays ordered and complete over 20k items', async () => {
    const q = new AsyncQueue<number>(1);
    const N = 20000;
    const out: number[] = [];
    const consumer = (async () => {
      for (;;) {
        const r = await q.dequeueResult();
        if (r.done) return;
        out.push(r.value);
      }
    })();
    for (let i = 0; i < N; i++) await q.enqueue(i);
    q.close();
    await consumer;
    expect(out).toHaveLength(N);
    expect(out.every((v, i) => v === i)).toBe(true);
  }, 30000);

  test('close()-race storm: no hang, no duplicate, no phantom drop', async () => {
    let hangs = 0;
    let duplicates = 0;
    let phantomDrops = 0;

    for (let round = 0; round < 150; round++) {
      const q = new AsyncQueue<number>(1 + (round % 3));
      const seen: number[] = [];
      const consumers = Array.from({ length: 3 }, () => (async () => {
        for (;;) {
          const r = await q.dequeueResult();
          if (r.done) return;
          seen.push(r.value);
        }
      })());
      const producers = Array.from({ length: 3 }, (_, p) => (async () => {
        for (let i = 0; i < 10; i++) {
          try { await q.enqueue(p * 100 + i); } catch { return; }
        }
      })());

      await sleep(Math.random() * 3);
      const dropped = q.close();

      const settled = await Promise.race([
        Promise.all([...consumers, ...producers]).then(() => 'ok'),
        sleep(3000).then(() => 'HANG')
      ]);
      if (settled === 'HANG') { hangs++; continue; }
      if (new Set(seen).size !== seen.length) duplicates++;
      // an item close() reported as dropped must never also have been delivered
      if (dropped.some(d => seen.includes(d))) phantomDrops++;
    }

    expect({ hangs, duplicates, phantomDrops }).toEqual({ hangs: 0, duplicates: 0, phantomDrops: 0 });
  }, 60000);

  test('randomised producer/consumer rounds lose nothing and duplicate nothing', async () => {
    const jitter = async (): Promise<void> => {
      const k = Math.floor(Math.random() * 4);
      for (let i = 0; i < k; i++) await Promise.resolve();
      if (Math.random() < 0.1) await sleep(0);
    };

    let hangs = 0;
    let lost = 0;
    let duplicated = 0;

    for (let round = 0; round < 200; round++) {
      const cap = 1 + (round % 7);
      const nProducers = 1 + (round % 5);
      const nConsumers = 1 + ((round * 3) % 5);
      const per = 20;
      const q = new AsyncQueue<number>(cap);
      const seen: number[] = [];
      const useIterator = round % 2 === 0;

      const consumers = Array.from({ length: nConsumers }, () => (async () => {
        if (useIterator) {
          for await (const v of q) { seen.push(v); await jitter(); }
        } else {
          for (;;) {
            const r = await q.dequeueResult();
            if (r.done) return;
            seen.push(r.value);
            await jitter();
          }
        }
      })());
      const producers = Array.from({ length: nProducers }, (_, p) => (async () => {
        for (let i = 0; i < per; i++) { await q.enqueue(p * 100000 + i); await jitter(); }
      })());

      await Promise.all(producers);
      q.close();
      const settled = await Promise.race([
        Promise.all(consumers).then(() => 'ok'),
        sleep(4000).then(() => 'HANG')
      ]);
      if (settled === 'HANG') { hangs++; continue; }
      if (seen.length !== nProducers * per) lost++;
      if (new Set(seen).size !== seen.length) duplicated++;
    }

    expect({ hangs, lost, duplicated }).toEqual({ hangs: 0, lost: 0, duplicated: 0 });
  }, 120000);

  test('waiter lists do not retain a high-water mark after a burst', async () => {
    const q = new AsyncQueue<number>(1);
    await q.enqueue(0);
    const ps: Promise<unknown>[] = [];
    for (let i = 0; i < 20000; i++) ps.push(q.enqueue(i, undefined).catch(() => {}));
    await sleep(10);
    expect(q.waitingProducerCount).toBe(20000);
    while (q.waitingProducerCount > 0 || q.size > 0) await q.dequeue();
    await Promise.all(ps);
    expect(q.waitingProducerCount).toBe(0);
    expect(q.waitingConsumerCount).toBe(0);
  }, 30000);
});
