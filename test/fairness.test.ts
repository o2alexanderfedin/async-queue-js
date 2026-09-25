/**
 * D5 / D6 — wake ordering and liveness.
 *
 * The README promises a "Strict first-in, first-out guarantee". The original
 * implementation stored waiters in a stack (`arr[--count]`) and therefore woke
 * them LIFO, which broke ordering AND liveness: under sustained contention the
 * earliest blocked producer sat under a stack that never emptied and was never
 * woken at all.
 *
 * Measured on the original implementation (commit 9bc7022):
 *   wake order, maxSize=1, producers 1,2,3   -> [0, 3, 2, 1]
 *   consumer order, 8 consumers, items 0..7  -> [7, 6, 5, 4, 3, 2, 1, 0]
 *   2s sustained contention                  -> 1531 later producers completed,
 *                                               FIRST producer NEVER woken
 *   200 dequeue rounds at maxSize=1          -> FIRST NEVER woken
 *
 * These tests pin the FIFO discipline that replaced it. They are ordering and
 * liveness tests, not timing tests — the one timing assertion below only has to
 * separate "linear" from "quadratic" and is bounded very loosely on purpose.
 */
import { AsyncQueue } from '../src/index';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const raceTimeout = <T>(p: Promise<T>, ms: number, tag = 'HUNG') =>
  Promise.race([p, sleep(ms).then(() => tag as any)]);

describe('D5: waiters are woken FIFO', () => {
  test('blocked producers deliver their items in call order', async () => {
    const q = new AsyncQueue<number>(1);
    await q.enqueue(0);                       // full

    const blocked: Promise<void>[] = [];
    for (const v of [1, 2, 3]) {
      blocked.push(q.enqueue(v));
      await sleep(1);                          // strict call order, no ambiguity
    }
    expect(q.waitingProducerCount).toBe(3);

    const out: (number | undefined)[] = [];
    for (let i = 0; i < 4; i++) {
      out.push(await q.dequeue());
      await sleep(1);
    }
    await Promise.all(blocked);

    expect(out).toEqual([0, 1, 2, 3]);         // was [0, 3, 2, 1] under LIFO
  });

  test('100 blocked producers deliver in strict call order', async () => {
    const N = 100;
    const q = new AsyncQueue<number>(1);
    await q.enqueue(-1);

    const blocked = Array.from({ length: N }, (_, i) => q.enqueue(i));
    await sleep(10);
    expect(q.waitingProducerCount).toBe(N);

    const out: (number | undefined)[] = [];
    for (let i = 0; i < N + 1; i++) out.push(await q.dequeue());
    await Promise.all(blocked);

    expect(out).toEqual([-1, ...Array.from({ length: N }, (_, i) => i)]);
  });

  test('100 blocked consumers are served in strict arrival order', async () => {
    const N = 100;
    const q = new AsyncQueue<number>(1);

    const got: (number | undefined)[] = new Array(N).fill(null);
    const consumers = Array.from({ length: N }, (_, i) =>
      q.dequeue().then(v => { got[i] = v; })
    );
    await sleep(10);
    expect(q.waitingConsumerCount).toBe(N);

    for (let i = 0; i < N; i++) await q.enqueue(i);
    await Promise.all(consumers);

    // Consumer i must receive item i. Under LIFO it received item N-1-i.
    expect(got).toEqual(Array.from({ length: N }, (_, i) => i));
  });

  test('producers that block after a partial drain still keep global item order', async () => {
    const q = new AsyncQueue<number>(3);
    const inflight: Promise<void>[] = [];
    for (let i = 0; i < 30; i++) {
      inflight.push(q.enqueue(i));
      if (i % 7 === 6) await sleep(1);        // let some block, some go straight in
    }
    const out: (number | undefined)[] = [];
    for (let i = 0; i < 30; i++) out.push(await q.dequeue());
    await Promise.all(inflight);

    expect(out).toEqual(Array.from({ length: 30 }, (_, i) => i));
  });
});

describe('D6: FIFO wake removes producer starvation', () => {
  test('the first blocked producer is woken by the FIRST free slot, not the last', async () => {
    const ROUNDS = 200;
    const q = new AsyncQueue<string>(1);
    await q.enqueue('seed');

    let firstWokenAtRound: number | null = null;
    let firstDone = false;
    const first = q.enqueue('FIRST').then(() => { firstDone = true; });

    const later: Promise<void>[] = [];
    for (let round = 1; round <= ROUNDS; round++) {
      later.push(q.enqueue(`later-${round}`).catch(() => {}));
      await sleep(0);
      await q.dequeue();                      // frees exactly one slot per round
      await sleep(0);
      if (firstWokenAtRound === null && firstDone) firstWokenAtRound = round;
    }

    q.close();
    await Promise.allSettled([first, ...later]);

    // Original implementation: null (never woken across all 200 rounds).
    expect(firstWokenAtRound).toBe(1);
  }, 30000);

  test('sustained contention cannot starve the earliest producer', async () => {
    const q = new AsyncQueue<string>(1);
    await q.enqueue('seed');

    let firstDone = false;
    const first = q.enqueue('FIRST').then(() => { firstDone = true; });

    let stop = false;
    let laterCompleted = 0;
    const churn = (async () => {
      const inflight: Promise<void>[] = [];
      while (!stop) {
        inflight.push(q.enqueue('later').then(() => { laterCompleted++; }, () => {}));
        await sleep(0);
      }
      await Promise.allSettled(inflight);
    })();
    const drainer = (async () => {
      while (!stop) { await q.dequeue(); await sleep(0); }
    })();

    // Wait for a count of later producers, not a fixed time: sleep(0) is one
    // timer tick, ~1ms on Linux/macOS but ~15.6ms on Windows, so 300ms held
    // only ~20 ticks there and the throughput check failed on the timer, not the queue.
    const LATER_TARGET = 50;
    const deadline = Date.now() + 10000;
    while (laterCompleted <= LATER_TARGET && Date.now() < deadline) await sleep(0);
    const starvedWhileBusy = !firstDone;
    const laterAtCheck = laterCompleted;
    stop = true;
    await sleep(20);
    q.close();
    await Promise.allSettled([first, churn, drainer]);

    // The point of the measurement: hundreds of LATER producers got through.
    expect(laterAtCheck).toBeGreaterThan(LATER_TARGET);
    // ...and the earliest one was not left behind while they did.
    expect(starvedWhileBusy).toBe(false);
  }, 30000);

  test('every one of 50 blocked producers eventually completes', async () => {
    const N = 50;
    const q = new AsyncQueue<number>(1);
    await q.enqueue(-1);

    const completed = new Array<boolean>(N).fill(false);
    const blocked = Array.from({ length: N }, (_, i) =>
      q.enqueue(i).then(() => { completed[i] = true; })
    );

    const drained = (async () => {
      for (let i = 0; i < N + 1; i++) await q.dequeue();
    })();

    expect(await raceTimeout(Promise.all([drained, ...blocked]), 5000)).not.toBe('HUNG');
    expect(completed.every(Boolean)).toBe(true);
  }, 30000);
});

describe('D5/D6: the FIFO wake is O(1) per waiter, not O(n)', () => {
  // Guards against "fix FIFO with Array.prototype.shift()", which would make
  // each wake O(n) and the whole drain O(n^2).
  const wakeAll = async (n: number): Promise<number> => {
    const q = new AsyncQueue<number>(1);
    const consumers = Array.from({ length: n }, () => q.dequeue());
    const t0 = performance.now();
    for (let i = 0; i < n; i++) await q.enqueue(i);
    await Promise.all(consumers);
    return (performance.now() - t0) / n;        // microseconds-ish, per waiter
  };
  // Minimum of several runs: on a shared machine the minimum is the only
  // estimator that is not dominated by scheduler noise.
  const bestPerWaiter = async (n: number): Promise<number> => {
    let best = Infinity;
    for (let i = 0; i < 5; i++) best = Math.min(best, await wakeAll(n));
    return best;
  };

  test('per-waiter wake cost is flat from 10k to 80k waiters', async () => {
    await wakeAll(2000);                       // warm up the JIT
    const small = await bestPerWaiter(10_000);
    const large = await bestPerWaiter(80_000);

    // 8x the waiters. O(1) per wake => a flat per-waiter cost.
    //
    // THRESHOLD CALIBRATION. This assertion previously read `toBeLessThan(4.5)`
    // on the stated grounds that an O(n) wake "would be 8x higher", and it
    // failed roughly one full-suite run in six — 4.5 sat inside this
    // measurement's own noise band, not above it. Both numbers were re-measured
    // rather than re-guessed:
    //
    //   this implementation, 20 trials, idle : min 0.35x  p50 2.5x  p90 3.6x
    //   this implementation, under jest load : observed up to 5.5x
    //   Array.prototype.shift() FIFO         : 57.6x  (0.0008ms -> 0.046ms)
    //
    // The "8x" was the asymptotic ratio; the real signal is an order of
    // magnitude larger because V8's shift() is a memmove, making the drain
    // O(n^2) in wall-clock. So the two regimes are separated by ~10x of margin,
    // and the threshold belongs between them — above the noise ceiling, far
    // below the regression it guards against.
    expect(large / small).toBeLessThan(15);
  }, 120000);
});
