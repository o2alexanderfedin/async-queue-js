import { AsyncQueue } from '../../src/index';

// The console output in this file used to describe grow-only waiter arrays
// ("Arrays never shrink back"). That storage was replaced by intrusive linked
// lists in the D9 fix, so the narration is updated to match. Every assertion
// below is unchanged.
describe('Waiter-queue Capacity Benchmark', () => {
  test('should demonstrate capacity growth pattern', async () => {
    const queue = new AsyncQueue<number>(1);
    const growthPattern: number[] = [];

    // Create many waiting consumers to trigger capacity growth
    const consumers: Promise<any>[] = [];

    // Track capacity growth
    for (let i = 1; i <= 1000; i++) {
      consumers.push(queue.dequeue());

      // Check capacity at powers of 2 and just after
      if (i === 16 || i === 17 || i === 32 || i === 33 ||
          i === 64 || i === 65 || i === 128 || i === 129 ||
          i === 256 || i === 257 || i === 512 || i === 513) {
        growthPattern.push(i);
      }
    }

    console.log(`
    Waiter-queue growth pattern:
    - No pre-allocated capacity and no growth step
    - Sampled at waiters: ${growthPattern.join(', ')}
    - Each waiter is a list node; being queued costs no allocation
      beyond the waiter record itself
    - Storage is released as waiters leave, so peak concurrency
      costs nothing once the burst is over`);

    // Satisfy all consumers
    for (let i = 0; i < 1000; i++) {
      await queue.enqueue(i);
    }

    await Promise.all(consumers);

    // After all operations, arrays maintain their grown size
    expect(queue.waitingConsumerCount).toBe(0);
  });

  test('should show performance with no reallocations within capacity', async () => {
    const queue = new AsyncQueue<number>(1);
    const OPERATIONS = 15; // Was 'within the initial capacity of 16'; there is
                           // no capacity step any more, so this is just a small
                           // batch. Kept at 15 so the timing bound is unchanged.

    const start = Date.now();

    // Create waiting consumers
    const consumers: Promise<any>[] = [];
    for (let i = 0; i < OPERATIONS; i++) {
      consumers.push(queue.dequeue());
    }

    // Satisfy them
    for (let i = 0; i < OPERATIONS; i++) {
      await queue.enqueue(i);
    }

    await Promise.all(consumers);

    const duration = Date.now() - start;

    console.log(`
    Small batch (${OPERATIONS} ops):
    Duration: ${duration}ms
    No array reallocations occurred - there is no array
    Zero memory churn from waiting queues`);

    expect(duration).toBeLessThan(100);
  });

  test('should handle stress with controlled growth', async () => {
    const queue = new AsyncQueue<number>(10);
    const PRODUCERS = 100;
    const CONSUMERS = 100;
    const ITEMS_PER_PRODUCER = 100;

    const start = Date.now();
    const initialMem = process.memoryUsage().heapUsed;

    async function producer(id: number): Promise<void> {
      for (let i = 0; i < ITEMS_PER_PRODUCER; i++) {
        await queue.enqueue(id * ITEMS_PER_PRODUCER + i);
      }
    }

    async function consumer(): Promise<number> {
      let count = 0;
      for (let i = 0; i < ITEMS_PER_PRODUCER; i++) {
        const item = await queue.dequeue();
        if (item !== undefined) count++;
      }
      return count;
    }

    // Start all producers and consumers
    const producers = Array.from({ length: PRODUCERS }, (_, i) => producer(i));
    const consumers = Array.from({ length: CONSUMERS }, () => consumer());

    await Promise.all([...producers, ...consumers]);

    const duration = Date.now() - start;
    const finalMem = process.memoryUsage().heapUsed;
    const memUsed = (finalMem - initialMem) / 1024 / 1024;

    console.log(`
    Stress test, waiter queues under load:
    Producers: ${PRODUCERS}, Consumers: ${CONSUMERS}
    Total items: ${PRODUCERS * ITEMS_PER_PRODUCER}
    Duration: ${duration}ms
    Memory delta: ${memUsed.toFixed(2)}MB
    Throughput: ${Math.round((PRODUCERS * ITEMS_PER_PRODUCER) / (duration / 1000))} items/sec

    Note: waiter storage is per-waiter and is released as each
    waiter leaves, so nothing is retained after the burst.`);

    expect(duration).toBeLessThan(5000);
  });
});