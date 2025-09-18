const AsyncQueue = require('../lib/index')

describe('AsyncQueue', () => {
  describe('Basic Operations', () => {
    test('should enqueue and dequeue items in FIFO order', async () => {
      const queue = new AsyncQueue(2)

      await queue.enqueue('item1')
      await queue.enqueue('item2')

      expect(await queue.dequeue()).toBe('item1')
      expect(await queue.dequeue()).toBe('item2')
    })

    test('should work with default maxSize of 1', async () => {
      const queue = new AsyncQueue()

      await queue.enqueue('A')
      const a = await queue.dequeue()

      await queue.enqueue('B')
      const b = await queue.dequeue()

      expect(a).toBe('A')
      expect(b).toBe('B')
    })

    test('should handle concurrent enqueue with maxSize=1', async () => {
      const queue = new AsyncQueue()

      await queue.enqueue('item1')
      const enqueue2Promise = queue.enqueue('item2')

      const item1 = await queue.dequeue()
      await enqueue2Promise
      const item2 = await queue.dequeue()

      expect(item1).toBe('item1')
      expect(item2).toBe('item2')
    })
  })

  describe('Blocking Behavior', () => {
    test('should block dequeue when queue is empty', async () => {
      const queue = new AsyncQueue()
      const results = []

      const dequeuePromise = queue.dequeue().then(item => {
        results.push(item)
        return item
      })

      await new Promise(resolve => setTimeout(resolve, 10))
      expect(results).toHaveLength(0)

      await queue.enqueue('delayed-item')
      const item = await dequeuePromise

      expect(item).toBe('delayed-item')
      expect(results).toEqual(['delayed-item'])
    })

    test('should block enqueue when queue is full', async () => {
      const queue = new AsyncQueue(2)

      await queue.enqueue('item1')
      await queue.enqueue('item2')

      let blocked = true
      const enqueuePromise = queue.enqueue('item3').then(() => {
        blocked = false
      })

      await new Promise(resolve => setTimeout(resolve, 10))
      expect(blocked).toBe(true)

      await queue.dequeue()
      await enqueuePromise

      expect(blocked).toBe(false)
    })
  })

  describe('Queue Closing', () => {
    test('should return undefined after close', async () => {
      const queue = new AsyncQueue()

      await queue.enqueue('item1')
      queue.close()

      const item1 = await queue.dequeue()
      const item2 = await queue.dequeue()

      expect(item1).toBe('item1')
      expect(item2).toBeUndefined()
      expect(queue.isClosed).toBe(true)
    })

    test('should throw error when enqueue after close', async () => {
      const queue = new AsyncQueue()
      queue.close()

      await expect(queue.enqueue('item')).rejects.toThrow('Queue is closed')
    })

    test('should throw error when producer is waiting and queue is closed', async () => {
      const queue = new AsyncQueue(1)

      await queue.enqueue('item1')

      const enqueuePromise = queue.enqueue('item2')

      queue.close()

      await expect(enqueuePromise).rejects.toThrow('Queue is closed')
    })

    test('should release waiting consumers on close', async () => {
      const queue = new AsyncQueue()
      const results = []

      const consumers = [
        queue.dequeue().then(item => results.push(item)),
        queue.dequeue().then(item => results.push(item)),
        queue.dequeue().then(item => results.push(item))
      ]

      await new Promise(resolve => setTimeout(resolve, 10))
      queue.close()

      await Promise.all(consumers)

      expect(results).toHaveLength(3)
      expect(results.every(item => item === undefined)).toBe(true)
    })

    test('should correctly report closed state', async () => {
      const queue = new AsyncQueue()

      expect(queue.isClosed).toBe(false)

      await queue.enqueue('item')
      queue.close()

      expect(queue.isClosed).toBe(false)

      await queue.dequeue()

      expect(queue.isClosed).toBe(true)
    })
  })

  describe('Producer-Consumer Pattern', () => {
    test('should handle single producer and consumer', async () => {
      const queue = new AsyncQueue(3)
      const produced = []
      const consumed = []

      async function producer() {
        for (let i = 0; i < 10; i++) {
          await queue.enqueue(i)
          produced.push(i)
        }
        queue.close()
      }

      async function consumer() {
        while (true) {
          const item = await queue.dequeue()
          if (item === undefined) break
          consumed.push(item)
        }
      }

      await Promise.all([producer(), consumer()])

      expect(produced).toHaveLength(10)
      expect(consumed).toHaveLength(10)
      expect(produced).toEqual(consumed)
    })

    test('should handle multiple consumers', async () => {
      const queue = new AsyncQueue()
      const results = []

      const consumer1 = queue.dequeue().then(item => {
        results.push({ consumer: 1, item })
        return item
      })
      const consumer2 = queue.dequeue().then(item => {
        results.push({ consumer: 2, item })
        return item
      })

      await new Promise(resolve => setTimeout(resolve, 10))

      await queue.enqueue('A')
      await queue.enqueue('B')

      await Promise.all([consumer1, consumer2])

      expect(results).toHaveLength(2)
      const items = results.map(r => r.item).sort()
      expect(items).toEqual(['A', 'B'])
    })

    test('should handle multiple producers', async () => {
      const queue = new AsyncQueue(1)
      const producerStates = { p1: false, p2: false }

      await queue.enqueue('initial')

      const producer1 = queue.enqueue('P1').then(() => {
        producerStates.p1 = true
      })

      const producer2 = queue.enqueue('P2').then(() => {
        producerStates.p2 = true
      })

      await new Promise(resolve => setTimeout(resolve, 10))
      expect(producerStates.p1).toBe(false)
      expect(producerStates.p2).toBe(false)

      const items = []
      items.push(await queue.dequeue())
      items.push(await queue.dequeue())
      items.push(await queue.dequeue())

      await Promise.all([producer1, producer2])

      expect(producerStates.p1).toBe(true)
      expect(producerStates.p2).toBe(true)
      expect(items).toContain('initial')
      expect(items).toContain('P1')
      expect(items).toContain('P2')
    })
  })

  describe('Edge Cases', () => {
    test('should handle rapid enqueue/dequeue cycles', async () => {
      const queue = new AsyncQueue(1)
      const results = []

      for (let i = 0; i < 100; i++) {
        await queue.enqueue(i)
        results.push(await queue.dequeue())
      }

      expect(results).toHaveLength(100)
      expect(results).toEqual(Array.from({ length: 100 }, (_, i) => i))
    })

    test('should handle zero items after close', async () => {
      const queue = new AsyncQueue()
      queue.close()

      const item = await queue.dequeue()
      expect(item).toBeUndefined()
      expect(queue.isClosed).toBe(true)
    })

    test('should maintain order with concurrent operations', async () => {
      const queue = new AsyncQueue(5)
      const operations = []

      for (let i = 0; i < 20; i++) {
        operations.push(queue.enqueue(i))
      }

      const results = []
      for (let i = 0; i < 20; i++) {
        operations.push(
          queue.dequeue().then(item => results.push(item))
        )
      }

      await Promise.all(operations)

      expect(results).toEqual(Array.from({ length: 20 }, (_, i) => i))
    })
  })

  describe('Type Safety', () => {
    test('should handle different data types', async () => {
      const queue = new AsyncQueue(5)

      await queue.enqueue('string')
      await queue.enqueue(123)
      await queue.enqueue({ key: 'value' })
      await queue.enqueue([1, 2, 3])
      await queue.enqueue(null)

      expect(await queue.dequeue()).toBe('string')
      expect(await queue.dequeue()).toBe(123)
      expect(await queue.dequeue()).toEqual({ key: 'value' })
      expect(await queue.dequeue()).toEqual([1, 2, 3])
      expect(await queue.dequeue()).toBe(null)
    })
  })
})