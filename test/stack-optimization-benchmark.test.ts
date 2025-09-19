import { AsyncQueue } from '../src/index';

describe('Stack Optimization Benchmark', () => {
  test('should show performance with many waiting consumers/producers', async () => {
    const OPERATIONS = 10000;
    const queue = new AsyncQueue<number>(1); // Small buffer to force waiting

    // Measure with many waiters
    const start = Date.now();

    // Create many waiting consumers
    const consumers: Promise<any>[] = [];
    for (let i = 0; i < OPERATIONS; i++) {
      consumers.push(queue.dequeue());
    }

    // Now satisfy them all
    for (let i = 0; i < OPERATIONS; i++) {
      await queue.enqueue(i);
    }

    await Promise.all(consumers);

    const duration = Date.now() - start;
    const throughput = Math.round(OPERATIONS / (duration / 1000));

    console.log(`
    Stack-based waiting queues (O(1) pop):
    Operations: ${OPERATIONS}
    Duration: ${duration}ms
    Throughput: ${throughput} ops/sec

    Note: Old array.shift() version would be O(n) for each wake operation,
    resulting in O(n²) complexity for n waiting consumers.
    With stack (pop), it's O(n) total complexity.`);

    expect(duration).toBeLessThan(1000); // Should complete in under 1 second
  });

  test('should handle mixed producer/consumer waiting', async () => {
    const queue = new AsyncQueue<number>(10);
    const ITERATIONS = 1000;

    async function producer(id: number): Promise<void> {
      for (let i = 0; i < ITERATIONS; i++) {
        await queue.enqueue(id * ITERATIONS + i);
      }
    }

    async function consumer(): Promise<number[]> {
      const items: number[] = [];
      for (let i = 0; i < ITERATIONS; i++) {
        const item = await queue.dequeue();
        if (item !== undefined) items.push(item);
      }
      return items;
    }

    const start = Date.now();

    // Start 10 producers and 10 consumers concurrently
    const producers = Array.from({ length: 10 }, (_, i) => producer(i));
    const consumers = Array.from({ length: 10 }, () => consumer());

    await Promise.all([...producers, ...consumers]);

    const duration = Date.now() - start;
    const totalOps = ITERATIONS * 20; // 10 producers + 10 consumers
    const throughput = Math.round(totalOps / (duration / 1000));

    console.log(`
    Mixed waiting (10 producers, 10 consumers):
    Total operations: ${totalOps}
    Duration: ${duration}ms
    Throughput: ${throughput} ops/sec`);

    expect(duration).toBeLessThan(2000);
  });
});