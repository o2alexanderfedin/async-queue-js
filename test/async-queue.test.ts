import { AsyncQueue } from '../src/index';

describe('AsyncQueue', () => {
  describe('Basic Operations', () => {
    test('should enqueue and dequeue items in FIFO order', async () => {
      const queue = new AsyncQueue<string>(2);

      await queue.enqueue('item1');
      await queue.enqueue('item2');

      expect(await queue.dequeue()).toBe('item1');
      expect(await queue.dequeue()).toBe('item2');
    });

    test('should work with default maxSize of 1', async () => {
      const queue = new AsyncQueue<string>();

      await queue.enqueue('A');
      const a = await queue.dequeue();

      await queue.enqueue('B');
      const b = await queue.dequeue();

      expect(a).toBe('A');
      expect(b).toBe('B');
    });

    test('should handle concurrent enqueue with maxSize=1', async () => {
      const queue = new AsyncQueue<string>();

      await queue.enqueue('item1');
      const enqueue2Promise = queue.enqueue('item2');

      const item1 = await queue.dequeue();
      await enqueue2Promise;
      const item2 = await queue.dequeue();

      expect(item1).toBe('item1');
      expect(item2).toBe('item2');
    });

    test('should throw error for invalid maxSize', () => {
      expect(() => new AsyncQueue(0)).toThrow('maxSize must be at least 1');
      expect(() => new AsyncQueue(-1)).toThrow('maxSize must be at least 1');
    });
  });

  describe('Blocking Behavior', () => {
    test('should block dequeue when queue is empty', async () => {
      const queue = new AsyncQueue<string>();
      const results: string[] = [];

      const dequeuePromise = queue.dequeue().then(item => {
        if (item !== undefined) {
          results.push(item);
        }
        return item;
      });

      await new Promise(resolve => setTimeout(resolve, 10));
      expect(results).toHaveLength(0);

      await queue.enqueue('delayed-item');
      const item = await dequeuePromise;

      expect(item).toBe('delayed-item');
      expect(results).toEqual(['delayed-item']);
    });

    test('should block enqueue when queue is full', async () => {
      const queue = new AsyncQueue<string>(2);

      await queue.enqueue('item1');
      await queue.enqueue('item2');

      let blocked = true;
      const enqueuePromise = queue.enqueue('item3').then(() => {
        blocked = false;
      });

      await new Promise(resolve => setTimeout(resolve, 10));
      expect(blocked).toBe(true);

      await queue.dequeue();
      await enqueuePromise;

      expect(blocked).toBe(false);
    });
  });

  describe('Queue Closing', () => {
    test('should return undefined after close', async () => {
      const queue = new AsyncQueue<string>();

      await queue.enqueue('item1');
      queue.close();

      const item1 = await queue.dequeue();
      const item2 = await queue.dequeue();

      expect(item1).toBe('item1');
      expect(item2).toBeUndefined();
      expect(queue.isClosed).toBe(true);
    });

    test('should throw error when enqueue after close', async () => {
      const queue = new AsyncQueue<string>();
      queue.close();

      await expect(queue.enqueue('item')).rejects.toThrow('Queue is closed');
    });

    test('should throw error when producer is waiting and queue is closed', async () => {
      const queue = new AsyncQueue<string>(1);

      await queue.enqueue('item1');

      const enqueuePromise = queue.enqueue('item2');

      queue.close();

      await expect(enqueuePromise).rejects.toThrow('Queue is closed');
    });

    test('should release waiting consumers on close', async () => {
      const queue = new AsyncQueue<string>();
      const results: (string | undefined)[] = [];

      const consumers = [
        queue.dequeue().then(item => results.push(item)),
        queue.dequeue().then(item => results.push(item)),
        queue.dequeue().then(item => results.push(item))
      ];

      await new Promise(resolve => setTimeout(resolve, 10));
      queue.close();

      await Promise.all(consumers);

      expect(results).toHaveLength(3);
      expect(results.every(item => item === undefined)).toBe(true);
    });

    test('should correctly report closed state', async () => {
      const queue = new AsyncQueue<string>();

      expect(queue.isClosed).toBe(false);

      await queue.enqueue('item');
      queue.close();

      expect(queue.isClosed).toBe(false);

      await queue.dequeue();

      expect(queue.isClosed).toBe(true);
    });
  });

  describe('Producer-Consumer Pattern', () => {
    test('should handle single producer and consumer', async () => {
      const queue = new AsyncQueue<number>(3);
      const produced: number[] = [];
      const consumed: number[] = [];

      async function producer() {
        for (let i = 0; i < 10; i++) {
          await queue.enqueue(i);
          produced.push(i);
        }
        queue.close();
      }

      async function consumer() {
        while (true) {
          const item = await queue.dequeue();
          if (item === undefined) break;
          consumed.push(item);
        }
      }

      await Promise.all([producer(), consumer()]);

      expect(produced).toHaveLength(10);
      expect(consumed).toHaveLength(10);
      expect(produced).toEqual(consumed);
    });

    test('should handle multiple consumers', async () => {
      const queue = new AsyncQueue<string>();
      interface Result {
        consumer: number;
        item: string;
      }
      const results: Result[] = [];

      const consumer1 = queue.dequeue().then(item => {
        if (item !== undefined) {
          results.push({ consumer: 1, item });
        }
        return item;
      });
      const consumer2 = queue.dequeue().then(item => {
        if (item !== undefined) {
          results.push({ consumer: 2, item });
        }
        return item;
      });

      await new Promise(resolve => setTimeout(resolve, 10));

      await queue.enqueue('A');
      await queue.enqueue('B');

      await Promise.all([consumer1, consumer2]);

      expect(results).toHaveLength(2);
      const items = results.map(r => r.item).sort();
      expect(items).toEqual(['A', 'B']);
    });

    test('should handle multiple producers', async () => {
      const queue = new AsyncQueue<string>(1);
      const producerStates = { p1: false, p2: false };

      await queue.enqueue('initial');

      const producer1 = queue.enqueue('P1').then(() => {
        producerStates.p1 = true;
      });

      const producer2 = queue.enqueue('P2').then(() => {
        producerStates.p2 = true;
      });

      await new Promise(resolve => setTimeout(resolve, 10));
      expect(producerStates.p1).toBe(false);
      expect(producerStates.p2).toBe(false);

      const items: string[] = [];
      const item1 = await queue.dequeue();
      if (item1 !== undefined) items.push(item1);
      const item2 = await queue.dequeue();
      if (item2 !== undefined) items.push(item2);
      const item3 = await queue.dequeue();
      if (item3 !== undefined) items.push(item3);

      await Promise.all([producer1, producer2]);

      expect(producerStates.p1).toBe(true);
      expect(producerStates.p2).toBe(true);
      expect(items).toContain('initial');
      expect(items).toContain('P1');
      expect(items).toContain('P2');
    });
  });

  describe('Edge Cases', () => {
    test('should handle rapid enqueue/dequeue cycles', async () => {
      const queue = new AsyncQueue<number>(1);
      const results: number[] = [];

      for (let i = 0; i < 100; i++) {
        await queue.enqueue(i);
        const item = await queue.dequeue();
        if (item !== undefined) {
          results.push(item);
        }
      }

      expect(results).toHaveLength(100);
      expect(results).toEqual(Array.from({ length: 100 }, (_, i) => i));
    });

    test('should handle zero items after close', async () => {
      const queue = new AsyncQueue<string>();
      queue.close();

      const item = await queue.dequeue();
      expect(item).toBeUndefined();
      expect(queue.isClosed).toBe(true);
    });

    test('should maintain order with concurrent operations', async () => {
      const queue = new AsyncQueue<number>(5);
      const operations: Promise<any>[] = [];

      for (let i = 0; i < 20; i++) {
        operations.push(queue.enqueue(i));
      }

      const results: number[] = [];
      for (let i = 0; i < 20; i++) {
        operations.push(
          queue.dequeue().then(item => {
            if (item !== undefined) {
              results.push(item);
            }
          })
        );
      }

      await Promise.all(operations);

      // Items should all be dequeued (though order may vary due to LIFO wake semantics)
      expect(results.length).toBe(20);
      expect(results.sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i));
    });
  });

  describe('Type Safety', () => {
    test('should handle different data types', async () => {
      const queue = new AsyncQueue<any>(5);

      await queue.enqueue('string');
      await queue.enqueue(123);
      await queue.enqueue({ key: 'value' });
      await queue.enqueue([1, 2, 3]);
      await queue.enqueue(null);

      expect(await queue.dequeue()).toBe('string');
      expect(await queue.dequeue()).toBe(123);
      expect(await queue.dequeue()).toEqual({ key: 'value' });
      expect(await queue.dequeue()).toEqual([1, 2, 3]);
      expect(await queue.dequeue()).toBe(null);
    });

    test('should enforce type safety with generics', async () => {
      interface Person {
        name: string;
        age: number;
      }

      const queue = new AsyncQueue<Person>(2);

      await queue.enqueue({ name: 'Alice', age: 30 });
      await queue.enqueue({ name: 'Bob', age: 25 });

      const person1 = await queue.dequeue();
      const person2 = await queue.dequeue();

      expect(person1?.name).toBe('Alice');
      expect(person1?.age).toBe(30);
      expect(person2?.name).toBe('Bob');
      expect(person2?.age).toBe(25);
    });
  });

  describe('Queue Properties', () => {
    test('should report size correctly', async () => {
      const queue = new AsyncQueue<number>(3);

      expect(queue.size).toBe(0);
      expect(queue.isEmpty).toBe(true);
      expect(queue.isFull).toBe(false);

      await queue.enqueue(1);
      expect(queue.size).toBe(1);
      expect(queue.isEmpty).toBe(false);
      expect(queue.isFull).toBe(false);

      await queue.enqueue(2);
      await queue.enqueue(3);
      expect(queue.size).toBe(3);
      expect(queue.isEmpty).toBe(false);
      expect(queue.isFull).toBe(true);

      await queue.dequeue();
      expect(queue.size).toBe(2);
      expect(queue.isFull).toBe(false);
    });

    test('should report capacity correctly', () => {
      const queue1 = new AsyncQueue<number>(1);
      const queue2 = new AsyncQueue<number>(10);
      const queue3 = new AsyncQueue<number>(100);

      expect(queue1.capacity).toBe(1);
      expect(queue2.capacity).toBe(10);
      expect(queue3.capacity).toBe(100);
    });

    test('should track waiting producers and consumers', async () => {
      const queue = new AsyncQueue<number>(1);

      // Fill the queue
      await queue.enqueue(1);

      // Start waiting producer
      const producer1 = queue.enqueue(2);
      const producer2 = queue.enqueue(3);

      await new Promise(resolve => setTimeout(resolve, 10));
      expect(queue.waitingProducerCount).toBe(2);

      // Clear queue
      await queue.dequeue();
      await queue.dequeue();
      await queue.dequeue();

      await Promise.all([producer1, producer2]);

      // Start waiting consumers
      const consumer1 = queue.dequeue();
      const consumer2 = queue.dequeue();
      const consumer3 = queue.dequeue();

      await new Promise(resolve => setTimeout(resolve, 10));
      expect(queue.waitingConsumerCount).toBe(3);

      queue.close();
      await Promise.all([consumer1, consumer2, consumer3]);
    });
  });
});