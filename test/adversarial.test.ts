/**
 * Adversarial review suite. Goal: find defects, not confirm behaviour.
 * Every test here is written to FAIL if the defect is real.
 */
import { AsyncQueue } from '../src/index';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const raceTimeout = <T>(p: Promise<T>, ms: number, tag = 'HUNG') =>
  Promise.race([p, sleep(ms).then(() => tag as any)]);

// Reach into privates for structural claims.
const priv = (q: any) => q as {
  buffer: unknown[];
  waitingConsumers: unknown[];
  waitingProducers: unknown[];
  maxSize: number;
};

describe('CLAIM: backpressure genuinely suspends the producer', () => {
  test('enqueue on a full queue does not settle until a dequeue frees space', async () => {
    const q = new AsyncQueue<number>(2);
    await q.enqueue(1);
    await q.enqueue(2);
    expect(q.size).toBe(2);

    let settled = false;
    const blocked = q.enqueue(3).then(() => { settled = true; });

    // Drain the microtask queue AND a macrotask turn.
    await sleep(20);
    expect(settled).toBe(false);          // producer really is suspended
    expect(q.size).toBe(2);               // nothing buffered beyond maxSize
    expect(q.waitingProducerCount).toBe(1);

    expect(await q.dequeue()).toBe(1);
    await blocked;
    expect(settled).toBe(true);
    expect(q.size).toBe(2);
  });

  test('queue never buffers more than maxSize even with a burst of producers', async () => {
    const q = new AsyncQueue<number>(3);
    const producers = Array.from({ length: 50 }, (_, i) => q.enqueue(i));
    await sleep(10);
    expect(q.size).toBeLessThanOrEqual(3);
    expect(q.waitingProducerCount).toBe(47);
    // drain so we do not leave 47 pending promises around
    for (let i = 0; i < 50; i++) await q.dequeue();
    await Promise.all(producers);
  });
});

describe('CLAIM: O(1) memory', () => {
  test('buffer allocation is O(maxSize), not O(1)', () => {
    const small = priv(new AsyncQueue<number>(1));
    const big = priv(new AsyncQueue<number>(1_000_000));
    expect(small.buffer.length).toBe(1);
    // If memory were O(1) in maxSize this would also be a small constant.
    expect(big.buffer.length).toBe(1_048_576);
  });

  test('buffer is rounded UP to a power of two, so capacity can cost ~2x maxSize slots', () => {
    expect(priv(new AsyncQueue(65_537)).buffer.length).toBe(131_072);
    expect(priv(new AsyncQueue(1_000)).buffer.length).toBe(1_024);
  });

  test('waiting arrays grow to the concurrency high-water mark and never shrink', async () => {
    const q = new AsyncQueue<number>(1);
    await q.enqueue(0);
    const producers = Array.from({ length: 1000 }, (_, i) => q.enqueue(i).catch(() => {}));
    await sleep(10);
    const peak = priv(q).waitingProducers.length;
    expect(peak).toBeGreaterThanOrEqual(1000);

    // Fully drain: no producers waiting any more.
    while (q.waitingProducerCount > 0 || q.size > 0) await q.dequeue();
    await sleep(10);
    expect(q.waitingProducerCount).toBe(0);

    // Retained capacity is unchanged -> memory is O(peak waiters), retained forever.
    expect(priv(q).waitingProducers.length).toBe(peak);
    await Promise.all(producers);
  });
});

describe('DEFECT: undefined is used as the end-of-stream sentinel', () => {
  test('enqueue(undefined) silently truncates for-await-of', async () => {
    const q = new AsyncQueue<number | undefined>(10);
    await q.enqueue(1);
    await q.enqueue(undefined);
    await q.enqueue(3);
    q.close();

    const got: (number | undefined)[] = [];
    for await (const v of q) got.push(v);

    expect(got).toEqual([1, undefined, 3]);
  });

  test('drain() loses everything after the first undefined', async () => {
    const q = new AsyncQueue<number | undefined>(10);
    await q.enqueue(1);
    await q.enqueue(undefined);
    await q.enqueue(3);
    q.close();
    expect(await q.drain()).toEqual([1, undefined, 3]);
  });

  test('take(n) stops early on an undefined payload even though the queue is open', async () => {
    const q = new AsyncQueue<number | undefined>(10);
    await q.enqueue(1);
    await q.enqueue(undefined);
    await q.enqueue(3);
    expect(await q.take(3)).toEqual([1, undefined, 3]);
  });

  test('sparse arrays / optional fields produce undefined naturally', async () => {
    // A realistic payload: Map.get() miss, JSON field absence, array hole.
    const q = new AsyncQueue<string | undefined>(10);
    const m = new Map<string, string>([['a', 'A'], ['c', 'C']]);
    for (const k of ['a', 'b', 'c']) await q.enqueue(m.get(k));
    q.close();
    expect(await q.drain()).toHaveLength(3);
  });
});

describe('DEFECT: FIFO is not preserved across blocked producers (LIFO wake)', () => {
  test('README claims "strict FIFO"; blocked producers are woken LIFO', async () => {
    const q = new AsyncQueue<number>(1);
    await q.enqueue(0);                 // queue now full

    const order: number[] = [];
    // Three producers block, in call order 1, 2, 3.
    const p1 = q.enqueue(1).then(() => order.push(1));
    await sleep(1);
    const p2 = q.enqueue(2).then(() => order.push(2));
    await sleep(1);
    const p3 = q.enqueue(3).then(() => order.push(3));
    await sleep(1);
    expect(q.waitingProducerCount).toBe(3);

    const out: number[] = [];
    for (let i = 0; i < 4; i++) {
      out.push((await q.dequeue())!);
      await sleep(1);
    }
    await Promise.all([p1, p2, p3]);

    expect(out).toEqual([0, 1, 2, 3]);   // FIFO across producers
  });
});

describe('DEFECT: LIFO wake starves the earliest blocked producer', () => {
  test('the first blocked producer never completes under sustained contention', async () => {
    const q = new AsyncQueue<string>(1);
    await q.enqueue('seed');

    let firstDone = false;
    const first = q.enqueue('FIRST').then(() => { firstDone = true; });

    // A steady stream of later producers keeps landing on top of the stack.
    let stop = false;
    const churn = (async () => {
      const inflight: Promise<void>[] = [];
      while (!stop) {
        inflight.push(q.enqueue('later').catch(() => {}));
        await sleep(0);
      }
      await Promise.allSettled(inflight);
    })();

    // A consumer that keeps making exactly one slot at a time.
    const drainer = (async () => {
      while (!stop) { await q.dequeue(); await sleep(0); }
    })();

    await sleep(300);
    const starved = !firstDone;
    stop = true;
    await sleep(20);
    // release whatever is left so the test can exit
    q.close();
    await Promise.allSettled([first, churn, drainer]);

    expect(starved).toBe(false);   // fails if FIRST was starved
  });
});

describe('DEFECT: constructor validation and large maxSize', () => {
  test('maxSize = 0 is rejected', () => {
    expect(() => new AsyncQueue(0)).toThrow('maxSize must be at least 1');
  });

  test('maxSize just above 2^30 must not throw RangeError', () => {
    expect(() => new AsyncQueue(2 ** 30 + 1)).not.toThrow();
  });

  test('very large maxSize must not silently collapse the buffer to 1 slot', () => {
    const q = new AsyncQueue<number>(2 ** 31 + 1);
    expect(priv(q).buffer.length).toBeGreaterThan(1);
  });

  test('huge maxSize corrupts data: items overwrite each other in a 1-slot buffer', async () => {
    const q = new AsyncQueue<number>(2 ** 31 + 1);
    await q.enqueue(1);
    await q.enqueue(2);
    await q.enqueue(3);
    expect(q.size).toBe(3);
    const out = [await q.dequeue(), await q.dequeue(), await q.dequeue()];
    expect(out).toEqual([1, 2, 3]);
  });

  test('maxSize = Infinity is accepted and collapses the buffer to 1 slot', async () => {
    const q = new AsyncQueue<number>(Infinity);
    expect(priv(q).buffer.length).toBeGreaterThan(1);
  });

  test('maxSize = NaN passes validation (NaN < 1 is false)', () => {
    expect(() => new AsyncQueue(NaN)).toThrow();
  });

  test('NaN maxSize disables backpressure and corrupts data', async () => {
    const q = new AsyncQueue<number>(NaN);
    for (let i = 0; i < 5; i++) await q.enqueue(i);   // never blocks
    expect(q.size).toBe(5);
    const out: (number | undefined)[] = [];
    for (let i = 0; i < 5; i++) out.push(await q.dequeue());
    expect(out).toEqual([0, 1, 2, 3, 4]);
  });

  test('non-integer maxSize overflows the buffer', async () => {
    const q = new AsyncQueue<number>(2.5);   // buffer length 2, maxSize 2.5
    await q.enqueue(1);
    await q.enqueue(2);
    expect(q.isFull).toBe(false);            // 2 >= 2.5 is false
    await q.enqueue(3);                      // does not block; overwrites slot 0
    expect(q.size).toBe(3);
    const out = [await q.dequeue(), await q.dequeue(), await q.dequeue()];
    expect(out).toEqual([1, 2, 3]);
  });
});

describe('DEFECT: an abandoned dequeue waiter swallows a future item', () => {
  test('timing out a dequeue destroys the next enqueued item and hangs a live consumer', async () => {
    const q = new AsyncQueue<string>(4);

    // A genuine consumer registers first.
    const real = q.dequeue();
    await sleep(1);

    // A second consumer with a timeout (a very common pattern) registers second.
    const timedOut = await Promise.race([q.dequeue(), sleep(20).then(() => 'TIMEOUT')]);
    expect(timedOut).toBe('TIMEOUT');
    expect(q.waitingConsumerCount).toBe(2);   // the abandoned waiter is still queued

    await q.enqueue('X');

    // 'X' should reach the only consumer that is still listening.
    expect(await raceTimeout(real, 100)).toBe('X');
    expect(q.size).toBe(0);
  });
});

describe('close() races', () => {
  test('close() while consumers wait: all consumers resolve to undefined', async () => {
    const q = new AsyncQueue<number>(4);
    const cs = [q.dequeue(), q.dequeue(), q.dequeue()];
    await sleep(5);
    expect(q.waitingConsumerCount).toBe(3);
    q.close();
    expect(await raceTimeout(Promise.all(cs), 100)).toEqual([undefined, undefined, undefined]);
  });

  test('close() while producers are blocked: their items are silently discarded', async () => {
    const q = new AsyncQueue<number>(1);
    await q.enqueue(1);
    const p2 = q.enqueue(2).then(() => 'ok', (e: Error) => e.message);
    const p3 = q.enqueue(3).then(() => 'ok', (e: Error) => e.message);
    await sleep(5);
    q.close();
    expect(await raceTimeout(Promise.all([p2, p3]), 100))
      .toEqual(['Queue is closed', 'Queue is closed']);
    // Item 1 survives; 2 and 3 are gone with no way to recover them.
    expect(await q.drain()).toEqual([1]);
  });

  test('enqueue after close rejects', async () => {
    const q = new AsyncQueue<number>(4);
    q.close();
    await expect(q.enqueue(1)).rejects.toThrow('Queue is closed');
  });

  test('dequeue after close on a non-empty queue drains, then returns undefined', async () => {
    const q = new AsyncQueue<number>(4);
    await q.enqueue(1);
    await q.enqueue(2);
    q.close();
    expect(await q.dequeue()).toBe(1);
    expect(await q.dequeue()).toBe(2);
    expect(await q.dequeue()).toBeUndefined();
    expect(await q.dequeue()).toBeUndefined();
  });

  test('close() is idempotent', async () => {
    const q = new AsyncQueue<number>(4);
    const c = q.dequeue();
    await sleep(1);
    q.close(); q.close(); q.close();
    expect(await raceTimeout(c, 100)).toBeUndefined();
  });

  test('close() during a concurrent producer/consumer storm never hangs', async () => {
    for (let round = 0; round < 40; round++) {
      const q = new AsyncQueue<number>(1 + (round % 4));
      const errs: string[] = [];
      const producers = Array.from({ length: 8 }, (_, p) => (async () => {
        for (let i = 0; i < 50; i++) {
          try { await q.enqueue(p * 1000 + i); } catch (e: any) { errs.push(e.message); return; }
        }
      })());
      const consumers = Array.from({ length: 8 }, () => (async () => {
        while (true) { const v = await q.dequeue(); if (v === undefined) return; }
      })());
      setTimeout(() => q.close(), round % 5);
      const done = await raceTimeout(Promise.all([...producers, ...consumers]), 2000, 'HUNG');
      expect(done).not.toBe('HUNG');
    }
  }, 30000);
});

describe('async iterator termination and waiter leaks', () => {
  test('iterate() terminates when the queue is closed', async () => {
    const q = new AsyncQueue<number>(4);
    await q.enqueue(1);
    q.close();
    const out: number[] = [];
    const run = (async () => { for await (const v of q.iterate()) out.push(v); })();
    expect(await raceTimeout(run.then(() => 'done'), 200)).toBe('done');
    expect(out).toEqual([1]);
  });

  test('breaking out of for-await-of leaves no waiting consumer behind', async () => {
    const q = new AsyncQueue<number>(4);
    await q.enqueue(1);
    await q.enqueue(2);
    for await (const v of q) { if (v === 1) break; }
    await sleep(5);
    expect(q.waitingConsumerCount).toBe(0);
    expect(q.size).toBe(1);      // item 2 still there
  });

  test('abandoning an in-flight iterator .next() leaves a phantom waiter', async () => {
    const q = new AsyncQueue<number>(4);
    const it = q.iterate()[Symbol.asyncIterator]();
    const pending = it.next();                                  // suspends inside dequeue()
    await sleep(5);
    expect(q.waitingConsumerCount).toBe(1);

    // Caller gives up on the iterator.
    const returned = await raceTimeout(
      (it as AsyncGenerator<number>).return!(undefined as any).then(() => 'returned'),
      100
    );
    expect(returned).toBe('returned');     // .return() should not hang
    await sleep(5);
    expect(q.waitingConsumerCount).toBe(0);
    void pending;
  });

  test('two concurrent for-await-of loops over one queue receive each item exactly once', async () => {
    const q = new AsyncQueue<number>(4);
    const a: number[] = []; const b: number[] = [];
    const la = (async () => { for await (const v of q) a.push(v); })();
    const lb = (async () => { for await (const v of q) b.push(v); })();
    for (let i = 1; i <= 200; i++) await q.enqueue(i);
    q.close();
    expect(await raceTimeout(Promise.all([la, lb]), 2000, 'HUNG')).not.toBe('HUNG');
    expect([...a, ...b].sort((x, y) => x - y)).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
  });
});

describe('lost wakeup hunt (randomised)', () => {
  test('no item is lost or duplicated and nothing hangs across many random schedules', async () => {
    for (let round = 0; round < 25; round++) {
      const cap = 1 + (round % 5);
      const nProducers = 1 + (round % 6);
      const nConsumers = 1 + ((round * 3) % 6);
      const perProducer = 40;
      const q = new AsyncQueue<number>(cap);
      const seen: number[] = [];

      const consumers = Array.from({ length: nConsumers }, () => (async () => {
        while (true) {
          const v = await q.dequeue();
          if (v === undefined) return;
          seen.push(v);
          if (Math.random() < 0.2) await sleep(0);
        }
      })());

      const producers = Array.from({ length: nProducers }, (_, p) => (async () => {
        for (let i = 0; i < perProducer; i++) {
          await q.enqueue(p * 10000 + i);
          if (Math.random() < 0.2) await sleep(0);
        }
      })());

      await Promise.all(producers);
      q.close();
      const done = await raceTimeout(Promise.all(consumers), 5000, 'HUNG');
      expect(done).not.toBe('HUNG');
      expect(seen.length).toBe(nProducers * perProducer);
      expect(new Set(seen).size).toBe(nProducers * perProducer);
    }
  }, 60000);
});

describe('documentation vs implementation', () => {
  test('"Direct Handoff: skip buffer when a consumer is waiting" — does it exist?', async () => {
    const q = new AsyncQueue<number>(4);
    const waiting = q.dequeue();
    await sleep(1);
    expect(q.waitingConsumerCount).toBe(1);
    q.enqueue(42);                        // synchronous path through enqueue
    // If the item were handed directly to the waiting consumer, size would be 0.
    expect(q.size).toBe(0);
    expect(await raceTimeout(waiting, 100)).toBe(42);
  });
});
