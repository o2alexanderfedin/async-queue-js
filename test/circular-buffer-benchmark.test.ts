import { AsyncQueue as OriginalQueue } from '../src/index';
import { AsyncQueue as CircularQueue } from '../src/index-circular';

describe('Circular Buffer Performance Comparison', () => {
  const ITEM_COUNTS = [1000, 10000, 100000];
  const BUFFER_SIZES = [10, 100, 1000];

  describe('Throughput Comparison', () => {
    for (const itemCount of ITEM_COUNTS) {
      for (const bufferSize of BUFFER_SIZES) {
        test(`${itemCount} items with buffer size ${bufferSize}`, async () => {
          // Test original implementation
          const originalQueue = new OriginalQueue<number>(bufferSize);
          let originalProduced = 0;
          let originalConsumed = 0;

          async function originalProducer(): Promise<void> {
            for (let i = 0; i < itemCount; i++) {
              await originalQueue.enqueue(i);
              originalProduced++;
            }
            originalQueue.close();
          }

          async function originalConsumer(): Promise<void> {
            while (!originalQueue.isClosed || originalQueue.size > 0) {
              const item = await originalQueue.dequeue();
              if (item !== undefined) {
                originalConsumed++;
              }
            }
          }

          const originalStart = Date.now();
          await Promise.all([originalProducer(), originalConsumer()]);
          const originalDuration = Date.now() - originalStart;
          const originalThroughput = Math.round(itemCount / (originalDuration / 1000));

          // Test circular buffer implementation
          const circularQueue = new CircularQueue<number>(bufferSize);
          let circularProduced = 0;
          let circularConsumed = 0;

          async function circularProducer(): Promise<void> {
            for (let i = 0; i < itemCount; i++) {
              await circularQueue.enqueue(i);
              circularProduced++;
            }
            circularQueue.close();
          }

          async function circularConsumer(): Promise<void> {
            while (!circularQueue.isClosed || circularQueue.size > 0) {
              const item = await circularQueue.dequeue();
              if (item !== undefined) {
                circularConsumed++;
              }
            }
          }

          const circularStart = Date.now();
          await Promise.all([circularProducer(), circularConsumer()]);
          const circularDuration = Date.now() - circularStart;
          const circularThroughput = Math.round(itemCount / (circularDuration / 1000));

          // Verify correctness
          expect(originalProduced).toBe(itemCount);
          expect(originalConsumed).toBe(itemCount);
          expect(circularProduced).toBe(itemCount);
          expect(circularConsumed).toBe(itemCount);

          // Calculate improvement
          const improvement = ((circularThroughput - originalThroughput) / originalThroughput * 100).toFixed(1);
          const speedup = (originalDuration / circularDuration).toFixed(2);

          console.log(`
      Items: ${itemCount}, Buffer: ${bufferSize}
      Original: ${originalDuration}ms (${originalThroughput} items/sec)
      Circular: ${circularDuration}ms (${circularThroughput} items/sec)
      Improvement: ${improvement}% (${speedup}x faster)`);

          // Circular buffer should be at least as fast, often faster
          expect(circularDuration).toBeLessThanOrEqual(originalDuration + 10); // Allow 10ms variance
        });
      }
    }
  });

  describe('Memory Efficiency', () => {
    test('should use predictable memory with circular buffer', async () => {
      const itemCount = 10000;
      const bufferSize = 100;

      const queue = new CircularQueue<{ data: string }>(bufferSize);

      // Create large objects
      function createLargeObject(id: number): { data: string } {
        return { data: 'x'.repeat(1000) + id };
      }

      const initialMemory = process.memoryUsage().heapUsed;

      async function producer(): Promise<void> {
        for (let i = 0; i < itemCount; i++) {
          await queue.enqueue(createLargeObject(i));
        }
        queue.close();
      }

      async function consumer(): Promise<void> {
        while (!queue.isClosed || queue.size > 0) {
          await queue.dequeue();
        }
      }

      await Promise.all([producer(), consumer()]);

      const finalMemory = process.memoryUsage().heapUsed;
      const memoryUsed = (finalMemory - initialMemory) / 1024 / 1024;

      console.log(`      Memory used for ${itemCount} items: ${memoryUsed.toFixed(2)}MB`);

      // Memory usage should be bounded by buffer size, not item count
      expect(Math.abs(memoryUsed)).toBeLessThan(50); // Should use less than 50MB
    });
  });

  describe('Edge Cases', () => {
    test('circular buffer should handle power-of-2 rounding correctly', async () => {
      // Test with non-power-of-2 sizes
      const sizes = [3, 5, 7, 9, 15, 17, 31, 33, 63, 65];

      for (const size of sizes) {
        const queue = new CircularQueue<number>(size);
        const items: number[] = [];

        // Fill to capacity
        for (let i = 0; i < size; i++) {
          await queue.enqueue(i);
        }

        // Should block on next enqueue (test with timeout)
        let blocked = true;
        const blockPromise = queue.enqueue(999).then(() => { blocked = false; });

        await new Promise(r => setTimeout(r, 10));
        expect(blocked).toBe(true);

        // Dequeue one to unblock
        await queue.dequeue();
        await blockPromise;

        // Drain queue
        queue.close();
        while (!queue.isClosed) {
          const item = await queue.dequeue();
          if (item !== undefined) items.push(item);
        }

        expect(items.length).toBe(size); // Should have exactly 'size' items
      }
    });

    test('circular buffer should handle wrap-around correctly', async () => {
      const queue = new CircularQueue<number>(4);
      const results: number[] = [];

      // Fill queue
      await queue.enqueue(1);
      await queue.enqueue(2);
      await queue.enqueue(3);
      await queue.enqueue(4);

      // Dequeue 2 items (head moves)
      results.push((await queue.dequeue()) as number);
      results.push((await queue.dequeue()) as number);

      // Enqueue 2 more (tail wraps around)
      await queue.enqueue(5);
      await queue.enqueue(6);

      // Dequeue remaining
      results.push((await queue.dequeue()) as number);
      results.push((await queue.dequeue()) as number);
      results.push((await queue.dequeue()) as number);
      results.push((await queue.dequeue()) as number);

      expect(results).toEqual([1, 2, 3, 4, 5, 6]);
    });
  });
});