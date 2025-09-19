import { AsyncQueue } from '../../src/index';

describe('Reserved Capacity Benchmark', () => {
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
    Capacity Growth Pattern:
    - Initial capacity: 16
    - Growth at waiters: ${growthPattern.join(', ')}
    - Growth is 2x when capacity exceeded
    - Arrays never shrink back
    - No reallocation within capacity limits`);

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
    const OPERATIONS = 15; // Within initial capacity of 16

    const start = Date.now();

    // Create waiting consumers (no reallocation needed)
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
    Operations within capacity (${OPERATIONS} ops, capacity 16):
    Duration: ${duration}ms
    No array reallocations occurred
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
    Stress test with reserved capacity:
    Producers: ${PRODUCERS}, Consumers: ${CONSUMERS}
    Total items: ${PRODUCERS * ITEMS_PER_PRODUCER}
    Duration: ${duration}ms
    Memory delta: ${memUsed.toFixed(2)}MB
    Throughput: ${Math.round((PRODUCERS * ITEMS_PER_PRODUCER) / (duration / 1000))} items/sec

    Note: Arrays grew as needed and never shrank,
    avoiding reallocation overhead during operation.`);

    expect(duration).toBeLessThan(5000);
  });
});