/**
 * D9 — waiter storage retention, and the accuracy of the two health metrics
 * built on it.
 *
 * The waiter queues used to be grow-only arrays, documented as "reserved
 * capacity — never shrink, only grow". Measured on the original implementation:
 * 50,000 transient producers pushed `waitingProducers.length` to 65,536, and it
 * was still 65,536 after a full drain — ~512 KiB of pointers retained for the
 * lifetime of the queue, sized by a burst that was over.
 *
 * They are now intrusive doubly-linked lists. There is no backing store, so a
 * waiter that leaves is unreachable immediately, and `size` is exactly the
 * number of live waiters at every instant — there is no tombstone that could
 * inflate it, which is the property `waitingConsumerCount` /
 * `waitingProducerCount` need to be usable as health metrics.
 */
import { AsyncQueue } from '../src/index';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

interface Node { next: Node | null; prev: Node | null }
interface ListShape { head: Node | null; tail: Node | null; size: number }
const lists = (q: unknown) => q as { waitingConsumers: ListShape; waitingProducers: ListShape };

/** Walks the list forwards; returns -1 if it is not a well-formed chain. */
const forwardCount = (list: ListShape): number => {
  let n = 0;
  let prev: Node | null = null;
  for (let node = list.head; node !== null; node = node.next) {
    if (node.prev !== prev) return -1;              // back-pointer must agree
    prev = node;
    n++;
    if (n > 1e6) return -1;                          // cycle guard
  }
  return list.tail === prev ? n : -1;
};

describe('D9: nothing is retained after a burst of waiters', () => {
  test('10k transient producers leave no residue', async () => {
    const q = new AsyncQueue<number>(1);
    await q.enqueue(-1);

    const producers = Array.from({ length: 10_000 }, (_, i) => q.enqueue(i).catch(() => {}));
    await sleep(20);
    expect(q.waitingProducerCount).toBe(10_000);
    expect(forwardCount(lists(q).waitingProducers)).toBe(10_000);

    for (let i = 0; i < 10_001; i++) await q.dequeue();
    await Promise.all(producers);

    expect(q.waitingProducerCount).toBe(0);
    expect(forwardCount(lists(q).waitingProducers)).toBe(0);
    expect(lists(q).waitingProducers.head).toBeNull();
    expect(lists(q).waitingProducers.tail).toBeNull();
  }, 60000);

  test('10k transient consumers leave no residue', async () => {
    const q = new AsyncQueue<number>(1);

    const consumers = Array.from({ length: 10_000 }, () => q.dequeue());
    await sleep(20);
    expect(q.waitingConsumerCount).toBe(10_000);
    expect(forwardCount(lists(q).waitingConsumers)).toBe(10_000);

    for (let i = 0; i < 10_000; i++) await q.enqueue(i);
    await Promise.all(consumers);

    expect(q.waitingConsumerCount).toBe(0);
    expect(forwardCount(lists(q).waitingConsumers)).toBe(0);
    expect(lists(q).waitingConsumers.head).toBeNull();
    expect(lists(q).waitingConsumers.tail).toBeNull();
  }, 60000);

  test('a second, smaller burst is not charged for the first one', async () => {
    const q = new AsyncQueue<number>(1);
    await q.enqueue(-1);

    // Burst of 5000...
    const big = Array.from({ length: 5000 }, (_, i) => q.enqueue(i).catch(() => {}));
    await sleep(20);
    expect(q.waitingProducerCount).toBe(5000);
    for (let i = 0; i < 5001; i++) await q.dequeue();
    await Promise.all(big);
    expect(forwardCount(lists(q).waitingProducers)).toBe(0);

    // ...then a burst of 3. The structure holds 3 nodes, not 5000 slots.
    await q.enqueue(-1);
    const small = [1, 2, 3].map(n => q.enqueue(n).catch(() => {}));
    await sleep(10);
    expect(q.waitingProducerCount).toBe(3);
    expect(forwardCount(lists(q).waitingProducers)).toBe(3);

    for (let i = 0; i < 4; i++) await q.dequeue();
    await Promise.all(small);
    expect(forwardCount(lists(q).waitingProducers)).toBe(0);
  }, 60000);

  test('close() empties both lists', async () => {
    const q = new AsyncQueue<number>(1);
    await q.enqueue(0);
    const producers = Array.from({ length: 100 }, (_, i) => q.enqueue(i).catch(() => {}));
    await sleep(10);
    expect(q.waitingProducerCount).toBe(100);

    q.close();
    await Promise.all(producers);

    expect(q.waitingProducerCount).toBe(0);
    expect(forwardCount(lists(q).waitingProducers)).toBe(0);
    expect(forwardCount(lists(q).waitingConsumers)).toBe(0);
  });
});

describe('D9: the waiting counts are live counts, not ghost counts', () => {
  test('an aborted consumer stops being counted the moment it aborts', async () => {
    const q = new AsyncQueue<number>(4);
    const controllers = Array.from({ length: 5 }, () => new AbortController());
    const consumers = controllers.map(c => q.dequeue({ signal: c.signal }).catch(() => 'aborted'));
    await sleep(5);
    expect(q.waitingConsumerCount).toBe(5);

    controllers[2]!.abort();                          // middle of the list
    await consumers[2];
    expect(q.waitingConsumerCount).toBe(4);
    expect(forwardCount(lists(q).waitingConsumers)).toBe(4);

    controllers[0]!.abort();                          // head
    await consumers[0];
    controllers[4]!.abort();                          // tail
    await consumers[4];
    expect(q.waitingConsumerCount).toBe(2);
    expect(forwardCount(lists(q).waitingConsumers)).toBe(2);

    // The two survivors are still first-come-first-served: consumer 1 arrived
    // before consumer 3, so it takes the first item.
    await q.enqueue(10);
    await q.enqueue(20);
    expect(await consumers[1]).toBe(10);
    expect(await consumers[3]).toBe(20);
    expect(q.waitingConsumerCount).toBe(0);
    q.close();
  });

  test('a released iterator stops being counted', async () => {
    const q = new AsyncQueue<number>(4);
    const cursors = Array.from({ length: 4 }, () => q.toAsyncGenerator());
    const parked = cursors.map(c => { const p = c.next(); p.catch(() => {}); return p; });
    await sleep(5);
    expect(q.waitingConsumerCount).toBe(4);

    await cursors[1]!.return(undefined);
    await sleep(5);
    expect(q.waitingConsumerCount).toBe(3);
    expect(forwardCount(lists(q).waitingConsumers)).toBe(3);

    q.close();
    await Promise.all(parked);
    expect(q.waitingConsumerCount).toBe(0);
    expect(forwardCount(lists(q).waitingConsumers)).toBe(0);
  });

  test('the count never over- or under-reports across a randomised workload', async () => {
    for (let round = 0; round < 30; round++) {
      const q = new AsyncQueue<number>(1 + (round % 3));
      const pending: Promise<unknown>[] = [];
      const controllers: AbortController[] = [];

      for (let i = 0; i < 40; i++) {
        if ((i + round) % 3 === 0) {
          const c = new AbortController();
          controllers.push(c);
          pending.push(q.enqueue(i, { signal: c.signal }).catch(() => {}));
        } else {
          pending.push(q.enqueue(i).catch(() => {}));
        }
        if (i % 5 === 4) {
          await sleep(0);
          // The reported count must always equal the reachable node count.
          expect(q.waitingProducerCount).toBe(forwardCount(lists(q).waitingProducers));
        }
      }

      for (const c of controllers) c.abort();
      await sleep(0);
      expect(q.waitingProducerCount).toBe(forwardCount(lists(q).waitingProducers));

      q.close();
      await Promise.all(pending);
      expect(q.waitingProducerCount).toBe(0);
      expect(forwardCount(lists(q).waitingProducers)).toBe(0);
    }
  }, 60000);
});

describe('D9: aborting many waiters is O(1) each, not O(n) at the next pop', () => {
  test('20k cancelled producers do not have to be walked past to reach the survivor', async () => {
    const q = new AsyncQueue<number>(1);
    await q.enqueue(-1);

    const controllers = Array.from({ length: 20_000 }, () => new AbortController());
    const cancelled = controllers.map((c, i) => q.enqueue(i, { signal: c.signal }).catch(() => {}));
    const survivor = q.enqueue(999).catch(() => {});
    await sleep(20);

    for (const c of controllers) c.abort();
    await Promise.all(cancelled);
    expect(q.waitingProducerCount).toBe(1);
    expect(forwardCount(lists(q).waitingProducers)).toBe(1);

    expect(await q.dequeue()).toBe(-1);
    expect(await q.dequeue()).toBe(999);
    await survivor;
  }, 60000);
});
