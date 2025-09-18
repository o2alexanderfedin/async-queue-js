const AsyncQueue = require('../lib/index')

describe('AsyncQueue Stress Tests', () => {
  jest.setTimeout(30000) // Increase timeout for stress tests

  describe('High Volume Operations', () => {
    test('should handle 10,000 items with single producer/consumer', async () => {
      const queue = new AsyncQueue(100)
      const ITEM_COUNT = 10000
      const produced = []
      const consumed = []

      async function producer() {
        for (let i = 0; i < ITEM_COUNT; i++) {
          await queue.enqueue(i)
          produced.push(i)
        }
        queue.close()
      }

      async function consumer() {
        while (!queue.isClosed || queue.queue.length > 0) {
          const item = await queue.dequeue()
          if (item !== undefined) {
            consumed.push(item)
          }
        }
      }

      const startTime = Date.now()
      await Promise.all([producer(), consumer()])
      const duration = Date.now() - startTime

      expect(produced).toHaveLength(ITEM_COUNT)
      expect(consumed).toHaveLength(ITEM_COUNT)
      expect(consumed).toEqual(produced)
      expect(duration).toBeLessThan(5000) // Should complete within 5 seconds

      console.log(`      Processed ${ITEM_COUNT} items in ${duration}ms (${Math.round(ITEM_COUNT / (duration / 1000))} items/sec)`)
    })

    test('should handle extreme concurrency with 100 producers and 50 consumers', async () => {
      const queue = new AsyncQueue(500)
      const PRODUCERS = 100
      const CONSUMERS = 50
      const ITEMS_PER_PRODUCER = 100
      const TOTAL_ITEMS = PRODUCERS * ITEMS_PER_PRODUCER

      const produced = new Set()
      const consumed = []
      const producerStats = new Map()
      const consumerStats = new Map()

      async function producer(id) {
        const items = []
        for (let i = 0; i < ITEMS_PER_PRODUCER; i++) {
          const item = `P${id}-Item${i}`
          await queue.enqueue(item)
          items.push(item)
          produced.add(item)

          // Simulate varying production rates
          if (Math.random() > 0.8) {
            await new Promise(r => setTimeout(r, Math.random() * 2))
          }
        }
        producerStats.set(id, items.length)
      }

      async function consumer(id) {
        let count = 0
        while (true) {
          const item = await queue.dequeue()
          if (item === undefined) break

          consumed.push(item)
          count++

          // Simulate varying consumption rates
          if (Math.random() > 0.9) {
            await new Promise(r => setTimeout(r, Math.random() * 3))
          }
        }
        consumerStats.set(id, count)
      }

      const startTime = Date.now()

      // Start all producers
      const producers = []
      for (let i = 0; i < PRODUCERS; i++) {
        producers.push(producer(i))
      }

      // Start all consumers
      const consumers = []
      for (let i = 0; i < CONSUMERS; i++) {
        consumers.push(consumer(i))
      }

      // Wait for all producers to finish
      await Promise.all(producers)
      queue.close()

      // Wait for all consumers to finish
      await Promise.all(consumers)

      const duration = Date.now() - startTime

      // Verify correctness
      expect(produced.size).toBe(TOTAL_ITEMS)
      expect(consumed).toHaveLength(TOTAL_ITEMS)
      expect(new Set(consumed).size).toBe(TOTAL_ITEMS) // All unique items

      // Check distribution
      const totalProduced = Array.from(producerStats.values()).reduce((a, b) => a + b, 0)
      const totalConsumed = Array.from(consumerStats.values()).reduce((a, b) => a + b, 0)
      expect(totalProduced).toBe(TOTAL_ITEMS)
      expect(totalConsumed).toBe(TOTAL_ITEMS)

      console.log(`      ${PRODUCERS} producers, ${CONSUMERS} consumers`)
      console.log(`      Processed ${TOTAL_ITEMS} items in ${duration}ms (${Math.round(TOTAL_ITEMS / (duration / 1000))} items/sec)`)
      console.log(`      Average per consumer: ${Math.round(totalConsumed / CONSUMERS)} items`)
    })

    test('should maintain order under extreme backpressure', async () => {
      const queue = new AsyncQueue(3) // Very small buffer
      const ITEM_COUNT = 1000
      const produced = []
      const consumed = []
      let maxBackpressureTime = 0
      let backpressureCount = 0

      async function fastProducer() {
        for (let i = 0; i < ITEM_COUNT; i++) {
          const start = Date.now()
          await queue.enqueue(i)
          const elapsed = Date.now() - start

          produced.push(i)

          if (elapsed > 1) {
            backpressureCount++
            maxBackpressureTime = Math.max(maxBackpressureTime, elapsed)
          }
        }
        queue.close()
      }

      async function slowConsumer() {
        while (true) {
          const item = await queue.dequeue()
          if (item === undefined) break

          consumed.push(item)

          // Simulate slow processing
          await new Promise(r => setTimeout(r, 1))
        }
      }

      await Promise.all([fastProducer(), slowConsumer()])

      expect(consumed).toEqual(produced)
      expect(consumed).toEqual(Array.from({ length: ITEM_COUNT }, (_, i) => i))
      expect(backpressureCount).toBeGreaterThan(ITEM_COUNT * 0.1) // Some enqueues should block

      console.log(`      Backpressure events: ${backpressureCount}/${ITEM_COUNT}`)
      console.log(`      Max backpressure delay: ${maxBackpressureTime}ms`)
    })
  })

  describe('Real-World Scenarios', () => {
    test('should handle bursty traffic patterns', async () => {
      const queue = new AsyncQueue(50)
      const consumed = []
      const producerMetrics = {
        bursts: 0,
        totalItems: 0
      }

      async function burstyProducer() {
        for (let burst = 0; burst < 20; burst++) {
          producerMetrics.bursts++

          // Generate burst of items
          const burstSize = Math.floor(Math.random() * 100) + 50
          for (let i = 0; i < burstSize; i++) {
            await queue.enqueue(`Burst${burst}-Item${i}`)
            producerMetrics.totalItems++
          }

          // Idle period between bursts
          await new Promise(r => setTimeout(r, Math.random() * 50))
        }
        queue.close()
      }

      async function steadyConsumer() {
        while (true) {
          const item = await queue.dequeue()
          if (item === undefined) break

          consumed.push(item)
          // Steady processing rate
          await new Promise(r => setTimeout(r, 2))
        }
      }

      const startTime = Date.now()
      await Promise.all([burstyProducer(), steadyConsumer()])
      const duration = Date.now() - startTime

      expect(consumed).toHaveLength(producerMetrics.totalItems)
      console.log(`      Handled ${producerMetrics.bursts} bursts, ${producerMetrics.totalItems} total items in ${duration}ms`)
    })

    test('should handle producer/consumer rate mismatches gracefully', async () => {
      const queue = new AsyncQueue(10)
      const metrics = {
        produced: 0,
        consumed: 0,
        producerBlocked: 0,
        consumerBlocked: 0
      }

      // Producers with varying speeds
      async function variableProducer(id, rate) {
        for (let i = 0; i < 100; i++) {
          const start = Date.now()
          await queue.enqueue(`P${id}-${i}`)
          const elapsed = Date.now() - start

          if (elapsed > 1) metrics.producerBlocked++
          metrics.produced++

          await new Promise(r => setTimeout(r, rate))
        }
      }

      // Consumers with varying speeds
      async function variableConsumer(id, rate) {
        while (true) {
          const start = Date.now()
          const item = await queue.dequeue()
          const elapsed = Date.now() - start

          if (item === undefined) break

          if (elapsed > 1) metrics.consumerBlocked++
          metrics.consumed++

          await new Promise(r => setTimeout(r, rate))
        }
      }

      // Start producers with different rates
      const producers = [
        variableProducer(1, 1),  // Fast
        variableProducer(2, 5),  // Medium
        variableProducer(3, 10), // Slow
      ]

      // Start consumers with different rates
      const consumers = [
        variableConsumer(1, 2),  // Fast
        variableConsumer(2, 8),  // Slow
      ]

      await Promise.all(producers)
      queue.close()
      await Promise.all(consumers)

      expect(metrics.consumed).toBe(metrics.produced)
      expect(metrics.consumed).toBe(300)

      console.log(`      Producer blocks: ${metrics.producerBlocked}, Consumer blocks: ${metrics.consumerBlocked}`)
    })

    test('should handle memory efficiently with large objects', async () => {
      const queue = new AsyncQueue(5) // Small buffer to test memory pressure
      const ITEM_COUNT = 100
      const OBJECT_SIZE = 10000 // Properties per object

      // Create large objects
      function createLargeObject(id) {
        const obj = { id }
        for (let i = 0; i < OBJECT_SIZE; i++) {
          obj[`prop${i}`] = `value${i}`
        }
        return obj
      }

      const produced = []
      const consumed = []

      async function producer() {
        for (let i = 0; i < ITEM_COUNT; i++) {
          const item = createLargeObject(i)
          await queue.enqueue(item)
          produced.push(item.id)
        }
        queue.close()
      }

      async function consumer() {
        while (true) {
          const item = await queue.dequeue()
          if (item === undefined) break

          consumed.push(item.id)

          // Simulate processing
          await new Promise(r => setTimeout(r, 10))
        }
      }

      // Monitor memory usage
      const initialMemory = process.memoryUsage().heapUsed

      await Promise.all([producer(), consumer()])

      const finalMemory = process.memoryUsage().heapUsed
      const memoryDelta = (finalMemory - initialMemory) / 1024 / 1024

      expect(consumed).toEqual(produced)
      expect(consumed).toHaveLength(ITEM_COUNT)

      // Memory should not grow excessively due to bounded queue
      expect(Math.abs(memoryDelta)).toBeLessThan(100) // Less than 100MB delta

      console.log(`      Memory delta: ${memoryDelta.toFixed(2)}MB for ${ITEM_COUNT} large objects`)
    })

    test('should handle rapid producer/consumer churn', async () => {
      const queue = new AsyncQueue(20)
      let totalProduced = 0
      let totalConsumed = 0
      const DURATION_MS = 2000

      // Producers that start and stop
      async function ephemeralProducer(id) {
        const items = Math.floor(Math.random() * 50) + 10
        for (let i = 0; i < items; i++) {
          try {
            await queue.enqueue(`P${id}-${i}`)
            totalProduced++
          } catch (err) {
            // Queue was closed, stop producing
            if (err.message === 'Queue is closed') break
            throw err
          }
        }
      }

      // Consumers that start and stop
      async function ephemeralConsumer(id) {
        const maxItems = Math.floor(Math.random() * 30) + 10
        for (let i = 0; i < maxItems; i++) {
          const item = await Promise.race([
            queue.dequeue(),
            new Promise(r => setTimeout(() => r(null), 100))
          ])

          if (item === null || item === undefined) break
          totalConsumed++
        }
      }

      const startTime = Date.now()
      const operations = []
      let producerId = 0
      let consumerId = 0

      // Continuously spawn producers and consumers
      const spawnInterval = setInterval(() => {
        if (Date.now() - startTime > DURATION_MS - 500) {
          clearInterval(spawnInterval)
          return
        }

        // Randomly spawn producers (only if not closing)
        if (Math.random() > 0.3 && Date.now() - startTime < DURATION_MS - 600) {
          operations.push(ephemeralProducer(producerId++))
        }

        // Randomly spawn consumers
        if (Math.random() > 0.2) {
          operations.push(ephemeralConsumer(consumerId++))
        }
      }, 50)

      // Wait for duration
      await new Promise(r => setTimeout(r, DURATION_MS))
      clearInterval(spawnInterval)

      queue.close()

      // Drain remaining items
      while (true) {
        const item = await queue.dequeue()
        if (item === undefined) break
        totalConsumed++
      }

      await Promise.all(operations)

      // Due to timing, some items might still be in the queue - that's okay
      expect(totalConsumed).toBeLessThanOrEqual(totalProduced)
      expect(totalConsumed).toBeGreaterThan(0)

      console.log(`      Spawned ${producerId} producers and ${consumerId} consumers`)
      console.log(`      Processed ${totalProduced} items with high churn`)
    })
  })

  describe('Performance Benchmarks', () => {
    jest.setTimeout(60000) // Increase timeout for benchmarks
    test('should measure throughput at different buffer sizes', async () => {
      const ITEM_COUNT = 5000
      const bufferSizes = [1, 10, 100, 1000]
      const results = []

      for (const bufferSize of bufferSizes) {
        const queue = new AsyncQueue(bufferSize)

        async function producer() {
          for (let i = 0; i < ITEM_COUNT; i++) {
            await queue.enqueue(i)
          }
          queue.close()
        }

        async function consumer() {
          while (true) {
            const item = await queue.dequeue()
            if (item === undefined) break
          }
        }

        const startTime = Date.now()
        await Promise.all([producer(), consumer()])
        const duration = Date.now() - startTime
        const throughput = Math.round(ITEM_COUNT / (duration / 1000))

        results.push({ bufferSize, duration, throughput })
      }

      // Larger buffers should generally have better throughput (allow some variance)
      const sortedByBuffer = [...results].sort((a, b) => a.bufferSize - b.bufferSize)
      const smallBufferThroughput = sortedByBuffer[0].throughput
      const largeBufferThroughput = sortedByBuffer[sortedByBuffer.length - 1].throughput

      // Allow for some variance in performance measurements
      expect(largeBufferThroughput).toBeGreaterThan(smallBufferThroughput * 0.8)

      console.log('      Buffer Size | Duration | Throughput')
      console.log('      ------------|----------|------------')
      results.forEach(r => {
        console.log(`      ${String(r.bufferSize).padEnd(11)} | ${String(r.duration + 'ms').padEnd(8)} | ${r.throughput} items/sec`)
      })
    })

    test('should handle concurrent access patterns efficiently', async () => {
      const queue = new AsyncQueue(100)
      const OPERATIONS = 10000
      const operations = []
      const results = []

      // Mix of enqueue and dequeue operations
      for (let i = 0; i < OPERATIONS; i++) {
        if (Math.random() > 0.5) {
          operations.push(
            queue.enqueue(i).then(() => {
              results.push({ op: 'enqueue', value: i })
            })
          )
        } else {
          operations.push(
            queue.dequeue().then(value => {
              if (value !== undefined) {
                results.push({ op: 'dequeue', value })
              }
            })
          )
        }

        // Add some delay to simulate real-world timing
        if (i % 100 === 0) {
          await new Promise(r => setTimeout(r, 1))
        }
      }

      const startTime = Date.now()
      await Promise.all(operations)
      queue.close()

      // Drain any remaining items
      while (true) {
        const item = await queue.dequeue()
        if (item === undefined) break
      }

      const duration = Date.now() - startTime

      const enqueues = results.filter(r => r.op === 'enqueue').length
      const dequeues = results.filter(r => r.op === 'dequeue').length

      expect(results.length).toBeGreaterThan(0)
      console.log(`      ${OPERATIONS} concurrent operations in ${duration}ms`)
      console.log(`      Enqueues: ${enqueues}, Dequeues: ${dequeues}`)
    })
  })
})