/**
 * Pins the README's FIFO claim to executable evidence.
 *
 * The claim reads: "Strict first-in, first-out, for items *and* for blocked
 * callers — the longest-waiting producer or consumer is always the next one
 * served, so no caller can be starved."
 *
 * It was false before the fairness fix (waiters were served LIFO, so a
 * contended producer could be starved indefinitely) and the documentation kept
 * asserting it anyway. These tests exist so that if it ever stops being true,
 * a test fails rather than a paragraph quietly becoming wrong again. They are
 * deliberately harder than the existing fairness suite: producers and consumers
 * are interleaved by a seeded pseudo-random schedule rather than in lockstep.
 */

import { AsyncQueue } from '../src/index';

/**
 * Deterministic PRNG (mulberry32). A randomised schedule is the point — a fixed
 * seed means a failure is reproducible.
 */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('README claim: strict FIFO ordering', () => {
  test('items come out in the order enqueue() was CALLED, across contended producers', async () => {
    const CAPACITY = 4;
    const PRODUCERS = 40;
    const PER_PRODUCER = 25;
    const TOTAL = PRODUCERS * PER_PRODUCER;

    const queue = new AsyncQueue<number>(CAPACITY);

    // Every enqueue() call is issued here, in a known order, and each carries a
    // sequence number equal to its call index. Most of them block: capacity is
    // 4 and there are 1,000 items with no consumer running yet.
    const callOrder: number[] = [];
    const pending: Array<Promise<void>> = [];
    let sequence = 0;
    for (let round = 0; round < PER_PRODUCER; round++) {
      for (let producer = 0; producer < PRODUCERS; producer++) {
        const item = sequence++;
        callOrder.push(item);
        pending.push(queue.enqueue(item));
      }
    }
    expect(queue.waitingProducerCount).toBe(TOTAL - CAPACITY);

    // Drain with a randomised number of dequeues per turn, yielding between
    // turns, so producers wake in whatever interleaving the event loop gives.
    const random = seededRandom(0xc0ffee);
    const received: number[] = [];
    while (received.length < TOTAL) {
      const burst = 1 + Math.floor(random() * 7);
      for (let i = 0; i < burst && received.length < TOTAL; i++) {
        const result = await queue.dequeueResult();
        expect(result.done).toBe(false);
        if (!result.done) received.push(result.value);
      }
      await new Promise(resolve => setImmediate(resolve));
    }

    await Promise.all(pending);

    expect(received).toEqual(callOrder);
    expect(queue.waitingProducerCount).toBe(0);
    expect(queue.size).toBe(0);
  });

  test('blocked consumers are served in arrival order, under a randomised producer schedule', async () => {
    const CONSUMERS = 200;
    const queue = new AsyncQueue<number>(1);

    // Park every consumer, in a known order. Each records its arrival index
    // when it is finally served.
    const servedOrder: number[] = [];
    const consumers: Array<Promise<void>> = [];
    for (let i = 0; i < CONSUMERS; i++) {
      const arrival = i;
      consumers.push(
        queue.dequeueResult().then(result => {
          expect(result.done).toBe(false);
          servedOrder.push(arrival);
        })
      );
      // Yield so each consumer is genuinely parked before the next is created.
      await Promise.resolve();
    }
    expect(queue.waitingConsumerCount).toBe(CONSUMERS);

    const random = seededRandom(0x5eed);
    let produced = 0;
    while (produced < CONSUMERS) {
      const burst = Math.min(1 + Math.floor(random() * 5), CONSUMERS - produced);
      for (let i = 0; i < burst; i++) await queue.enqueue(produced++);
      await new Promise(resolve => setImmediate(resolve));
    }

    await Promise.all(consumers);

    expect(servedOrder).toEqual(Array.from({ length: CONSUMERS }, (_, i) => i));
    expect(queue.waitingConsumerCount).toBe(0);
  });

  test('no producer is starved: the longest-waiting one is always next', async () => {
    const queue = new AsyncQueue<number>(1);
    await queue.enqueue(0); // fill it

    // The first blocked producer. Under the LIFO wake order this used to have,
    // sustained arrivals behind it meant it was never woken at all.
    let firstCompleted = false;
    const first = queue.enqueue(1).then(() => {
      firstCompleted = true;
    });

    // A steady stream of later producers piling in behind it.
    const later: Array<Promise<void>> = [];
    for (let i = 2; i < 500; i++) later.push(queue.enqueue(i));

    // One dequeue frees exactly one slot. It must go to the FIRST blocked
    // producer, not the most recent.
    await queue.dequeue();
    await first;
    expect(firstCompleted).toBe(true);

    // Drain the rest so nothing is left pending.
    while (queue.waitingProducerCount > 0 || queue.size > 0) {
      await queue.dequeue();
    }
    await Promise.all(later);
  });
});
