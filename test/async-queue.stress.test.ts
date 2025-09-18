import { AsyncQueue } from '../src/index';

interface ProducerStats {
  bursts: number;
  totalItems: number;
}

interface Metrics {
  produced: number;
  consumed: number;
  producerBlocked: number;
  consumerBlocked: number;
}

interface ThroughputResult {
  bufferSize: number;
  duration: number;
  throughput: number;
}

// Utility function to add random delays simulating real-world variance
async function randomDelay(probability: number = 0.9, maxDelayMs: number = 5): Promise<void> {
  if (Math.random() > probability) {
    await new Promise(r => setTimeout(r, Math.random() * maxDelayMs));
  }
}

describe('AsyncQueue Stress Tests', () => {
  jest.setTimeout(30000); // Increase timeout for stress tests

  describe('High Volume Operations', () => {
    test('should handle 1,000 items with single producer/consumer', async () => {
      const queue = new AsyncQueue<number>(100);
      const ITEM_COUNT = 1000;
      const produced: number[] = [];
      const consumed: number[] = [];

      async function producer(): Promise<void> {
        for (let i = 0; i < ITEM_COUNT; i++) {
          await queue.enqueue(i);
          produced.push(i);
          await randomDelay(0.9, 5);
        }
        queue.close();
      }

      async function consumer(): Promise<void> {
        while (!queue.isClosed || queue.size > 0) {
          const item = await queue.dequeue();
          if (item !== undefined) {
            consumed.push(item);
            await randomDelay(0.8, 3);
          }
        }
      }

      const startTime = Date.now();
      await Promise.all([producer(), consumer()]);
      const duration = Date.now() - startTime;

      expect(produced).toHaveLength(ITEM_COUNT);
      expect(consumed).toHaveLength(ITEM_COUNT);
      expect(consumed).toEqual(produced);
      expect(duration).toBeLessThan(5000); // Should complete within 5 seconds

      console.log(`      Processed ${ITEM_COUNT} items in ${duration}ms (${Math.round(ITEM_COUNT / (duration / 1000))} items/sec)`);
    });

    test('should handle extreme concurrency with 20 producers and 10 consumers', async () => {
      const queue = new AsyncQueue<string>(50);
      const PRODUCERS = 20;
      const CONSUMERS = 10;
      const ITEMS_PER_PRODUCER = 50;
      const TOTAL_ITEMS = PRODUCERS * ITEMS_PER_PRODUCER;

      const produced = new Set<string>();
      const consumed: string[] = [];
      const producerStats = new Map<number, number>();
      const consumerStats = new Map<number, number>();

      async function producer(id: number): Promise<void> {
        const items: string[] = [];
        for (let i = 0; i < ITEMS_PER_PRODUCER; i++) {
          const item = `P${id}-Item${i}`;
          await queue.enqueue(item);
          items.push(item);
          produced.add(item);

          // Simulate varying production rates
          await randomDelay(0.8, 2);
        }
        producerStats.set(id, items.length);
      }

      async function consumer(id: number): Promise<void> {
        let count = 0;
        while (true) {
          const item = await queue.dequeue();
          if (item === undefined) break;

          consumed.push(item);
          count++;

          // Simulate varying consumption rates
          await randomDelay(0.9, 3);
        }
        consumerStats.set(id, count);
      }

      const startTime = Date.now();

      // Start all producers
      const producers: Promise<void>[] = [];
      for (let i = 0; i < PRODUCERS; i++) {
        producers.push(producer(i));
      }

      // Start all consumers
      const consumers: Promise<void>[] = [];
      for (let i = 0; i < CONSUMERS; i++) {
        consumers.push(consumer(i));
      }

      // Wait for all producers to finish
      await Promise.all(producers);
      queue.close();

      // Wait for all consumers to finish
      await Promise.all(consumers);

      const duration = Date.now() - startTime;

      // Verify correctness
      expect(produced.size).toBe(TOTAL_ITEMS);
      expect(consumed).toHaveLength(TOTAL_ITEMS);
      expect(new Set(consumed).size).toBe(TOTAL_ITEMS); // All unique items

      // Check distribution
      const totalProduced = Array.from(producerStats.values()).reduce((a, b) => a + b, 0);
      const totalConsumed = Array.from(consumerStats.values()).reduce((a, b) => a + b, 0);
      expect(totalProduced).toBe(TOTAL_ITEMS);
      expect(totalConsumed).toBe(TOTAL_ITEMS);

      console.log(`      ${PRODUCERS} producers, ${CONSUMERS} consumers`);
      console.log(`      Processed ${TOTAL_ITEMS} items in ${duration}ms (${Math.round(TOTAL_ITEMS / (duration / 1000))} items/sec)`);
      console.log(`      Average per consumer: ${Math.round(totalConsumed / CONSUMERS)} items`);
    });

    test('should maintain order under extreme backpressure', async () => {
      const queue = new AsyncQueue<number>(3); // Very small buffer
      const ITEM_COUNT = 200;
      const produced: number[] = [];
      const consumed: number[] = [];
      let maxBackpressureTime = 0;
      let backpressureCount = 0;

      async function fastProducer(): Promise<void> {
        for (let i = 0; i < ITEM_COUNT; i++) {
          const start = Date.now();
          await queue.enqueue(i);
          const elapsed = Date.now() - start;

          produced.push(i);

          if (elapsed > 1) {
            backpressureCount++;
            maxBackpressureTime = Math.max(maxBackpressureTime, elapsed);
          }
        }
        queue.close();
      }

      async function slowConsumer(): Promise<void> {
        while (true) {
          const item = await queue.dequeue();
          if (item === undefined) break;

          consumed.push(item);

          // Simulate slow processing
          await new Promise(r => setTimeout(r, 1));
        }
      }

      await Promise.all([fastProducer(), slowConsumer()]);

      expect(consumed).toEqual(produced);
      expect(consumed).toEqual(Array.from({ length: ITEM_COUNT }, (_, i) => i));
      expect(backpressureCount).toBeGreaterThan(ITEM_COUNT * 0.1); // Some enqueues should block

      console.log(`      Backpressure events: ${backpressureCount}/${ITEM_COUNT}`);
      console.log(`      Max backpressure delay: ${maxBackpressureTime}ms`);
    });
  });

  describe('Real-World Scenarios', () => {
    test('should handle bursty traffic patterns', async () => {
      const queue = new AsyncQueue<string>(50);
      const consumed: string[] = [];
      const producerMetrics: ProducerStats = {
        bursts: 0,
        totalItems: 0
      };

      async function burstyProducer(): Promise<void> {
        for (let burst = 0; burst < 20; burst++) {
          producerMetrics.bursts++;

          // Generate burst of items
          const burstSize = Math.floor(Math.random() * 100) + 50;
          for (let i = 0; i < burstSize; i++) {
            await queue.enqueue(`Burst${burst}-Item${i}`);
            producerMetrics.totalItems++;
          }

          // Idle period between bursts
          await new Promise(r => setTimeout(r, Math.random() * 50));
        }
        queue.close();
      }

      async function steadyConsumer(): Promise<void> {
        while (true) {
          const item = await queue.dequeue();
          if (item === undefined) break;

          consumed.push(item);
          // Steady processing rate
          await new Promise(r => setTimeout(r, 2));
        }
      }

      const startTime = Date.now();
      await Promise.all([burstyProducer(), steadyConsumer()]);
      const duration = Date.now() - startTime;

      expect(consumed).toHaveLength(producerMetrics.totalItems);
      console.log(`      Handled ${producerMetrics.bursts} bursts, ${producerMetrics.totalItems} total items in ${duration}ms`);
    });

    test('should handle producer/consumer rate mismatches gracefully', async () => {
      const queue = new AsyncQueue<string>(10);
      const metrics: Metrics = {
        produced: 0,
        consumed: 0,
        producerBlocked: 0,
        consumerBlocked: 0
      };

      // Producers with varying speeds
      async function variableProducer(id: number, rate: number): Promise<void> {
        for (let i = 0; i < 100; i++) {
          const start = Date.now();
          await queue.enqueue(`P${id}-${i}`);
          const elapsed = Date.now() - start;

          if (elapsed > 1) metrics.producerBlocked++;
          metrics.produced++;

          await new Promise(r => setTimeout(r, rate));
        }
      }

      // Consumers with varying speeds
      async function variableConsumer(_id: number, rate: number): Promise<void> {
        while (true) {
          const start = Date.now();
          const item = await queue.dequeue();
          const elapsed = Date.now() - start;

          if (item === undefined) break;

          if (elapsed > 1) metrics.consumerBlocked++;
          metrics.consumed++;

          await new Promise(r => setTimeout(r, rate));
        }
      }

      // Start producers with different rates
      const producers = [
        variableProducer(1, 1),  // Fast
        variableProducer(2, 5),  // Medium
        variableProducer(3, 10), // Slow
      ];

      // Start consumers with different rates
      const consumers = [
        variableConsumer(1, 2),  // Fast
        variableConsumer(2, 8),  // Slow
      ];

      await Promise.all(producers);
      queue.close();
      await Promise.all(consumers);

      expect(metrics.consumed).toBe(metrics.produced);
      expect(metrics.consumed).toBe(300);

      console.log(`      Producer blocks: ${metrics.producerBlocked}, Consumer blocks: ${metrics.consumerBlocked}`);
    });

    test('should handle memory efficiently with large objects', async () => {
      const queue = new AsyncQueue<Record<string, string>>(5); // Small buffer to test memory pressure
      const ITEM_COUNT = 100;
      const OBJECT_SIZE = 10000; // Properties per object

      // Create large objects
      function createLargeObject(id: number): Record<string, string> {
        const obj: Record<string, string> = { id: String(id) };
        for (let i = 0; i < OBJECT_SIZE; i++) {
          obj[`prop${i}`] = `value${i}`;
        }
        return obj;
      }

      const produced: number[] = [];
      const consumed: number[] = [];

      async function producer(): Promise<void> {
        for (let i = 0; i < ITEM_COUNT; i++) {
          const item = createLargeObject(i);
          await queue.enqueue(item);
          produced.push(i);
        }
        queue.close();
      }

      async function consumer(): Promise<void> {
        while (true) {
          const item = await queue.dequeue();
          if (item === undefined) break;

          consumed.push(Number(item['id']));

          // Simulate processing
          await new Promise(r => setTimeout(r, 10));
        }
      }

      // Monitor memory usage
      const initialMemory = process.memoryUsage().heapUsed;

      await Promise.all([producer(), consumer()]);

      const finalMemory = process.memoryUsage().heapUsed;
      const memoryDelta = (finalMemory - initialMemory) / 1024 / 1024;

      expect(consumed).toEqual(produced);
      expect(consumed).toHaveLength(ITEM_COUNT);

      // Memory should not grow excessively due to bounded queue
      expect(Math.abs(memoryDelta)).toBeLessThan(100); // Less than 100MB delta

      console.log(`      Memory delta: ${memoryDelta.toFixed(2)}MB for ${ITEM_COUNT} large objects`);
    });

    test('should handle rapid producer/consumer churn', async () => {
      const queue = new AsyncQueue<string>(20);
      let totalProduced = 0;
      let totalConsumed = 0;
      const DURATION_MS = 2000;

      // Producers that start and stop
      async function ephemeralProducer(id: number): Promise<void> {
        const items = Math.floor(Math.random() * 50) + 10;
        for (let i = 0; i < items; i++) {
          try {
            await queue.enqueue(`P${id}-${i}`);
            totalProduced++;
          } catch (err) {
            // Queue was closed, stop producing
            if (err instanceof Error && err.message === 'Queue is closed') break;
            throw err;
          }
        }
      }

      // Consumers that start and stop
      async function ephemeralConsumer(_id: number): Promise<void> {
        const maxItems = Math.floor(Math.random() * 30) + 10;
        for (let i = 0; i < maxItems; i++) {
          const item = await Promise.race([
            queue.dequeue(),
            new Promise<null>(r => setTimeout(() => r(null), 100))
          ]);

          if (item === null || item === undefined) break;
          totalConsumed++;
        }
      }

      const startTime = Date.now();
      const operations: Promise<void>[] = [];
      let producerId = 0;
      let consumerId = 0;

      // Continuously spawn producers and consumers
      const spawnInterval = setInterval(() => {
        if (Date.now() - startTime > DURATION_MS - 500) {
          clearInterval(spawnInterval);
          return;
        }

        // Randomly spawn producers (only if not closing)
        if (Math.random() > 0.3 && Date.now() - startTime < DURATION_MS - 600) {
          operations.push(ephemeralProducer(producerId++));
        }

        // Randomly spawn consumers
        if (Math.random() > 0.2) {
          operations.push(ephemeralConsumer(consumerId++));
        }
      }, 50);

      // Wait for duration
      await new Promise(r => setTimeout(r, DURATION_MS));
      clearInterval(spawnInterval);

      queue.close();

      // Drain remaining items
      while (true) {
        const item = await queue.dequeue();
        if (item === undefined) break;
        totalConsumed++;
      }

      await Promise.all(operations);

      // Due to timing, some items might still be in the queue - that's okay
      expect(totalConsumed).toBeLessThanOrEqual(totalProduced);
      expect(totalConsumed).toBeGreaterThan(0);

      console.log(`      Spawned ${producerId} producers and ${consumerId} consumers`);
      console.log(`      Processed ${totalProduced} items with high churn`);
    });
  });

  describe('Performance Benchmarks', () => {
    jest.setTimeout(60000); // Increase timeout for benchmarks

    test('should measure throughput at different buffer sizes', async () => {
      const ITEM_COUNT = 500;
      const bufferSizes = [1, 10, 50, 100];
      const results: ThroughputResult[] = [];

      for (const bufferSize of bufferSizes) {
        const queue = new AsyncQueue<number>(bufferSize);

        async function producer(): Promise<void> {
          for (let i = 0; i < ITEM_COUNT; i++) {
            await queue.enqueue(i);
            // Small random delay for more realistic testing
            await randomDelay(0.95, 1);
          }
          queue.close();
        }

        async function consumer(): Promise<void> {
          while (true) {
            const item = await queue.dequeue();
            if (item === undefined) break;
            // Small random delay for more realistic testing
            await randomDelay(0.95, 1);
          }
        }

        const startTime = Date.now();
        await Promise.all([producer(), consumer()]);
        const duration = Date.now() - startTime;
        const throughput = Math.round(ITEM_COUNT / (duration / 1000));

        results.push({ bufferSize, duration, throughput });
      }

      // Larger buffers should generally have better throughput (allow some variance)
      const sortedByBuffer = [...results].sort((a, b) => a.bufferSize - b.bufferSize);
      const smallBufferThroughput = sortedByBuffer[0]!.throughput;
      const largeBufferThroughput = sortedByBuffer[sortedByBuffer.length - 1]!.throughput;

      // Allow for some variance in performance measurements
      expect(largeBufferThroughput).toBeGreaterThan(smallBufferThroughput * 0.8);

      console.log('      Buffer Size | Duration | Throughput');
      console.log('      ------------|----------|------------');
      results.forEach(r => {
        console.log(`      ${String(r.bufferSize).padEnd(11)} | ${String(r.duration + 'ms').padEnd(8)} | ${r.throughput} items/sec`);
      });
    });

    test('should handle concurrent access patterns efficiently', async () => {
      const queue = new AsyncQueue<number>(50);
      const TOTAL_ITEMS = 250;
      const producedItems: number[] = [];
      const consumedItems: number[] = [];

      // Producer that adds items
      async function producer(): Promise<void> {
        for (let i = 0; i < TOTAL_ITEMS; i++) {
          await queue.enqueue(i);
          producedItems.push(i);
          // Random delays
          await randomDelay(0.9, 2);
        }
        queue.close();
      }

      // Multiple consumers working concurrently
      async function consumer(_id: number): Promise<void> {
        while (true) {
          const item = await queue.dequeue();
          if (item === undefined) break;
          consumedItems.push(item);
          // Random delays
          await randomDelay(0.9, 2);
        }
      }

      const startTime = Date.now();

      // Run producer and multiple consumers concurrently
      await Promise.all([
        producer(),
        consumer(1),
        consumer(2),
        consumer(3)
      ]);

      const duration = Date.now() - startTime;

      expect(producedItems.length).toBe(TOTAL_ITEMS);
      expect(consumedItems.length).toBe(TOTAL_ITEMS);

      console.log(`      Processed ${TOTAL_ITEMS} items with 3 concurrent consumers in ${duration}ms`);
      console.log(`      Throughput: ${Math.round(TOTAL_ITEMS / (duration / 1000))} items/sec`);
    });
  });
});