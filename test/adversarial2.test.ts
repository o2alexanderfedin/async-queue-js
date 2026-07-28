import { AsyncQueue } from '../src/index';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const raceTimeout = <T>(p: Promise<T>, ms: number, tag = 'HUNG') =>
  Promise.race([p, sleep(ms).then(() => tag as any)]);

describe('DEFECT: abandoned PRODUCER waiter still delivers its item later', () => {
  // REWRITTEN. The original body was:
  //
  //   const outcome = await Promise.race([
  //     q.enqueue('GHOST').then(() => 'enqueued', () => 'rejected'),
  //     sleep(20).then(() => 'TIMEOUT')
  //   ]);
  //   expect(outcome).toBe('TIMEOUT');
  //   expect(await q.dequeue()).toBe('A');
  //   await sleep(10);
  //   expect(q.size).toBe(0);          // nothing should have been inserted
  //
  // That is unsatisfiable, and not because of a missing feature. Promise.race
  // does not cancel anything: the enqueue('GHOST') promise is still live, still
  // has handlers attached, and the queue has received no signal whatsoever that
  // the caller lost interest. For q.size to stay 0 there, a blocked enqueue
  // would have to DISCARD its item on wakeup — i.e. `await queue.enqueue(x)` on
  // a full queue would silently lose x. That is the opposite of backpressure and
  // it directly contradicts the existing test 'should block enqueue when queue is
  // full', which requires the blocked item to be inserted after one dequeue.
  //
  // The defect underneath (no cancellation) is real and is fixed. The test now
  // uses the mechanism that actually conveys "I gave up" — an AbortSignal — and
  // pins the uncancelled case to the only behaviour backpressure permits.
  test('an aborted enqueue never inserts its item', async () => {
    const q = new AsyncQueue<string>(1);
    await q.enqueue('A');                       // full

    const controller = new AbortController();
    const outcome = await Promise.race([
      q.enqueue('GHOST', { signal: controller.signal }).then(() => 'enqueued', (e: Error) => `rejected:${e.name}`),
      sleep(20).then(() => { controller.abort(); return 'TIMEOUT'; })
    ]);
    expect(outcome).toBe('TIMEOUT');
    expect(q.waitingProducerCount).toBe(0);     // the waiter is gone, not merely ignored

    // Consumer drains. The aborted producer must NOT insert 'GHOST'.
    expect(await q.dequeue()).toBe('A');
    await sleep(10);
    expect(q.size).toBe(0);
    expect(q.waitingProducerCount).toBe(0);
  });

  test('an aborted enqueue rejects with AbortError and does not consume a slot', async () => {
    const q = new AsyncQueue<string>(1);
    await q.enqueue('A');

    const controller = new AbortController();
    const aborted = q.enqueue('GHOST', { signal: controller.signal });
    const after = q.enqueue('REAL');            // queued behind GHOST
    await sleep(5);
    expect(q.waitingProducerCount).toBe(2);

    controller.abort();
    await expect(aborted).rejects.toThrow(/aborted/i);
    expect(q.waitingProducerCount).toBe(1);     // only REAL is still waiting

    // The freed slot goes to REAL, skipping the cancelled waiter entirely.
    expect(await q.dequeue()).toBe('A');
    await after;
    expect(await q.dequeue()).toBe('REAL');
    expect(q.size).toBe(0);
  });

  test('WITHOUT a signal, a blocked enqueue still inserts — that is backpressure, not a bug', async () => {
    const q = new AsyncQueue<string>(1);
    await q.enqueue('A');

    const outcome = await Promise.race([
      q.enqueue('LATER').then(() => 'enqueued', () => 'rejected'),
      sleep(20).then(() => 'TIMEOUT')
    ]);
    expect(outcome).toBe('TIMEOUT');            // Promise.race did not cancel it

    expect(await q.dequeue()).toBe('A');
    await sleep(10);
    expect(q.size).toBe(1);                     // 'LATER' was inserted, as it must be
    expect(await q.dequeue()).toBe('LATER');
  });
});

describe('DEFECT: no cancellation — an abandoned async iterator cannot be released', () => {
  // REWRITTEN. The original asserted the HANG as correct:
  //
  //   const ret = it.return(undefined as any);
  //   expect(await raceTimeout(ret.then(() => 'returned'), 60)).toBe('HUNG');
  //   q.close();                                   // "the ONLY thing that can release it"
  //   expect(await raceTimeout(ret.then(() => 'returned'), 100)).toBe('returned');
  //
  // That directly contradicts adversarial.test.ts:352 ('abandoning an in-flight
  // iterator .next() leaves a phantom waiter'), which requires the very same
  // it.return() to resolve within 100ms and to leave waitingConsumerCount at 0.
  // No implementation can satisfy both. Prompt release is the correct half — a
  // consumer that has given up must not pin a slot in the wake queue until
  // close(), which is the whole of D3 — so this test now pins the fix.
  //
  // The hang was structural: `async function*` cannot process a queued return()
  // while suspended at an `await`. The iterator is therefore hand-written and
  // owns its waiter, so return() can cancel it directly.
  test('generator.return() while suspended in dequeue() releases immediately', async () => {
    const q = new AsyncQueue<number>(4);
    const it = q.iterate()[Symbol.asyncIterator]() as AsyncGenerator<number>;
    const pending = it.next();
    await sleep(5);
    expect(q.waitingConsumerCount).toBe(1);

    const ret = it.return(undefined as any);
    expect(await raceTimeout(ret.then(() => 'returned'), 60)).toBe('returned');

    // No close() needed, and no waiter left behind.
    await sleep(5);
    expect(q.waitingConsumerCount).toBe(0);

    // The abandoned next() settles as end-of-iteration rather than rejecting,
    // so an unobserved next() promise cannot become an unhandled rejection.
    expect(await raceTimeout(pending, 100)).toEqual({ done: true, value: undefined });

    // The queue itself is untouched and still usable.
    expect(q.isClosed).toBe(false);
    await q.enqueue(1);
    expect(await q.dequeue()).toBe(1);
  });

  test('breaking out of for-await-of releases the waiter without closing the queue', async () => {
    const q = new AsyncQueue<number>(4);
    const seen: number[] = [];

    const loop = (async () => {
      for await (const v of q) {
        seen.push(v);
        if (v === 2) break;
      }
    })();

    await q.enqueue(1);
    await q.enqueue(2);
    await raceTimeout(loop, 500);

    expect(seen).toEqual([1, 2]);
    expect(q.waitingConsumerCount).toBe(0);
    expect(q.isClosed).toBe(false);
  });
});

describe('unhandled rejections left behind by close()', () => {
  test('close() rejects every blocked producer; unattached ones become unhandled rejections', async () => {
    const seen: any[] = [];
    const onUnhandled = (r: any) => seen.push(r);
    process.on('unhandledRejection', onUnhandled);
    try {
      const q = new AsyncQueue<number>(1);
      await q.enqueue(1);
      // Fire-and-forget producers, the shape used in every README multi-producer example.
      void q.enqueue(2);
      void q.enqueue(3);
      await sleep(5);
      expect(q.waitingProducerCount).toBe(2);
      q.close();
      await sleep(50);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(seen.map(e => e?.message)).toEqual([]);
  });
});

describe('harder lost-wakeup / close-race hunt', () => {
  test('close() racing blocked producers and waiting consumers: no hang, no double delivery', async () => {
    for (let round = 0; round < 60; round++) {
      const q = new AsyncQueue<number>(1 + (round % 3));
      const delivered: number[] = [];
      const producers = Array.from({ length: 6 }, (_, p) => (async () => {
        for (let i = 0; i < 30; i++) {
          try { await q.enqueue(p * 1000 + i); } catch { return; }
        }
      })());
      const consumers = Array.from({ length: 6 }, () => (async () => {
        while (true) {
          const v = await q.dequeue();
          if (v === undefined) return;
          delivered.push(v);
        }
      })());
      await sleep(round % 4);
      q.close();
      const r = await raceTimeout(Promise.all([...producers, ...consumers]), 3000, 'HUNG');
      expect(r).not.toBe('HUNG');
      expect(new Set(delivered).size).toBe(delivered.length);   // no duplicates
    }
  }, 60000);

  test('single-slot ping-pong with interleaved close never loses a wakeup', async () => {
    for (let round = 0; round < 200; round++) {
      const q = new AsyncQueue<number>(1);
      let got = 0;
      const consumer = (async () => {
        while (true) { const v = await q.dequeue(); if (v === undefined) return; got++; }
      })();
      const producer = (async () => {
        for (let i = 0; i < 20; i++) { try { await q.enqueue(i); } catch { return; } }
        q.close();
      })();
      const r = await raceTimeout(Promise.all([producer, consumer]), 2000, 'HUNG');
      expect(r).not.toBe('HUNG');
      expect(got).toBe(20);
    }
  }, 60000);
});

describe('misc API edges', () => {
  test('take(n) with a negative n', async () => {
    const q = new AsyncQueue<number>(4);
    await q.enqueue(1);
    expect(await q.take(-5)).toEqual([]);
  });

  test('isFull/isEmpty/size stay consistent with the buffer under wraparound', async () => {
    const q = new AsyncQueue<number>(3);   // buffer length 4, maxSize 3
    for (let cycle = 0; cycle < 10; cycle++) {
      await q.enqueue(cycle * 3 + 1);
      await q.enqueue(cycle * 3 + 2);
      await q.enqueue(cycle * 3 + 3);
      expect(q.isFull).toBe(true);
      expect(await q.dequeue()).toBe(cycle * 3 + 1);
      expect(await q.dequeue()).toBe(cycle * 3 + 2);
      expect(await q.dequeue()).toBe(cycle * 3 + 3);
      expect(q.isEmpty).toBe(true);
    }
  });

  test('capacity reports maxSize but the queue silently reserves the next power of two', () => {
    const q: any = new AsyncQueue<number>(1000);
    expect(q.capacity).toBe(1000);
    expect(q.buffer.length).toBe(1024);   // 24 slots the user never asked for
  });
});
