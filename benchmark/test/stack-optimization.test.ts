import { AsyncQueue } from '../../src/index';
import { performance } from 'perf_hooks';

/**
 * These assert an upper bound on wall-clock time for a large number of waiters
 * — i.e. that waking a waiter is O(1) and not O(n). They are NOT measurements:
 * one timed run, no samples, no percentiles. The throughput they print is a
 * coarse smoke-test figure and must not be quoted anywhere. For numbers that
 * can be published, use `npm run benchmark` (see benchmark/src/harness.ts).
 */
describe('Waiter-wake cost', () => {
  test('should show performance with many waiting consumers/producers', async () => {
    const OPERATIONS = 10000;
    const queue = new AsyncQueue<number>(1); // Small buffer to force waiting

    // Measure with many waiters
    const start = performance.now();

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

    const duration = performance.now() - start;
    const throughput = Math.round(OPERATIONS / (duration / 1000));

    console.log(`
    FIFO waiter list, O(1) push/pop/remove:
    Operations: ${OPERATIONS}
    Duration: ${duration.toFixed(1)}ms
    Throughput: ~${throughput} ops/sec  (smoke-test figure, not a measurement)

    Waiters are nodes in an intrusive doubly-linked list, so waking one is
    O(1) from any position and n waiters cost O(n) in total. An array-backed
    queue using shift() would be O(n) per wake, i.e. O(n^2) overall.

    This is a FIFO queue, not a stack: the longest-waiting caller is served
    first. A stack is equally O(1) but starves the oldest waiter under
    sustained contention — see test/fairness.test.ts.`);

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

    const start = performance.now();

    // Start 10 producers and 10 consumers concurrently
    const producers = Array.from({ length: 10 }, (_, i) => producer(i));
    const consumers = Array.from({ length: 10 }, () => consumer());

    await Promise.all([...producers, ...consumers]);

    const duration = performance.now() - start;
    const totalOps = ITERATIONS * 20; // 10 producers + 10 consumers
    const throughput = Math.round(totalOps / (duration / 1000));

    console.log(`
    Mixed waiting (10 producers, 10 consumers):
    Total operations: ${totalOps}
    Duration: ${duration.toFixed(1)}ms
    Throughput: ~${throughput} ops/sec  (smoke-test figure, not a measurement)`);

    expect(duration).toBeLessThan(2000);
  });
});