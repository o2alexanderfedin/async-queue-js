import { AsyncQueue } from '../src/index';

describe('AsyncQueue Iterator', () => {
  describe('Symbol.asyncIterator', () => {
    test('should iterate through all items with for-await-of', async () => {
      const queue = new AsyncQueue<number>(3);
      const items: number[] = [];

      // Producer
      setTimeout(async () => {
        for (let i = 0; i < 5; i++) {
          await queue.enqueue(i);
        }
        queue.close();
      }, 0);

      // Consumer using for-await-of
      for await (const item of queue) {
        items.push(item);
      }

      expect(items).toEqual([0, 1, 2, 3, 4]);
    });

    test('should handle concurrent producers and iterator consumer', async () => {
      const queue = new AsyncQueue<string>(2);
      const items: string[] = [];

      // Multiple producers
      const producer1 = async () => {
        await queue.enqueue('a');
        await queue.enqueue('b');
      };

      const producer2 = async () => {
        await queue.enqueue('c');
        await queue.enqueue('d');
        queue.close();
      };

      // Start producers
      setTimeout(() => {
        producer1();
        producer2();
      }, 0);

      // Iterator consumer
      for await (const item of queue) {
        items.push(item);
      }

      expect(items).toHaveLength(4);
      expect(items.sort()).toEqual(['a', 'b', 'c', 'd']);
    });

    test('should stop iteration when queue is closed and empty', async () => {
      const queue = new AsyncQueue<number>(5);
      const items: number[] = [];

      await queue.enqueue(1);
      await queue.enqueue(2);
      queue.close();

      for await (const item of queue) {
        items.push(item);
      }

      expect(items).toEqual([1, 2]);
      expect(queue.isClosed).toBe(true);
    });

    test('should handle empty queue that gets closed', async () => {
      const queue = new AsyncQueue<number>();
      const items: number[] = [];

      setTimeout(() => queue.close(), 10);

      for await (const item of queue) {
        items.push(item);
      }

      expect(items).toEqual([]);
    });

    test('should allow multiple iterators on the same queue', async () => {
      const queue = new AsyncQueue<number>(10);
      const items1: number[] = [];
      const items2: number[] = [];

      // Enqueue items
      for (let i = 0; i < 10; i++) {
        await queue.enqueue(i);
      }
      queue.close();

      // Two concurrent iterators
      await Promise.all([
        (async () => {
          for await (const item of queue) {
            items1.push(item);
          }
        })(),
        (async () => {
          for await (const item of queue) {
            items2.push(item);
          }
        })()
      ]);

      // Items should be distributed between iterators
      expect(items1.length + items2.length).toBe(10);
      expect([...items1, ...items2].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });
  });

  describe('iterate()', () => {
    test('should provide an iterable interface', async () => {
      const queue = new AsyncQueue<string>(3);
      const items: string[] = [];

      await queue.enqueue('foo');
      await queue.enqueue('bar');
      await queue.enqueue('baz');
      queue.close();

      const iterable = queue.iterate();
      for await (const item of iterable) {
        items.push(item);
      }

      expect(items).toEqual(['foo', 'bar', 'baz']);
    });

    test('should work with async generator transformations', async () => {
      const queue = new AsyncQueue<number>(5);
      const doubled: number[] = [];

      // Enqueue items
      for (let i = 1; i <= 5; i++) {
        await queue.enqueue(i);
      }
      queue.close();

      // Transform through async generator
      async function* double(source: AsyncIterable<number>) {
        for await (const item of source) {
          yield item * 2;
        }
      }

      for await (const item of double(queue.iterate())) {
        doubled.push(item);
      }

      expect(doubled).toEqual([2, 4, 6, 8, 10]);
    });
  });

  describe('toAsyncGenerator()', () => {
    test('should convert queue to async generator', async () => {
      const queue = new AsyncQueue<number>(3);
      const items: number[] = [];

      await queue.enqueue(10);
      await queue.enqueue(20);
      await queue.enqueue(30);
      queue.close();

      const generator = queue.toAsyncGenerator();
      for await (const item of generator) {
        items.push(item);
      }

      expect(items).toEqual([10, 20, 30]);
    });

    test('should work in generator pipelines', async () => {
      const queue = new AsyncQueue<string>(3);
      const results: string[] = [];

      await queue.enqueue('hello');
      await queue.enqueue('world');
      queue.close();

      async function* uppercase(source: AsyncGenerator<string>) {
        for await (const item of source) {
          yield item.toUpperCase();
        }
      }

      async function* exclaim(source: AsyncGenerator<string>) {
        for await (const item of source) {
          yield `${item}!`;
        }
      }

      const pipeline = exclaim(uppercase(queue.toAsyncGenerator()));
      for await (const item of pipeline) {
        results.push(item);
      }

      expect(results).toEqual(['HELLO!', 'WORLD!']);
    });
  });

  describe('drain()', () => {
    test('should drain all items into an array', async () => {
      const queue = new AsyncQueue<number>(5);

      // Producer
      (async () => {
        for (let i = 0; i < 10; i++) {
          await queue.enqueue(i);
        }
        queue.close();
      })();

      const items = await queue.drain();
      expect(items).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });

    test('should return empty array for closed empty queue', async () => {
      const queue = new AsyncQueue<number>();
      queue.close();

      const items = await queue.drain();
      expect(items).toEqual([]);
    });

    test('should wait for items before draining', async () => {
      const queue = new AsyncQueue<string>(2);

      // Delayed producer
      setTimeout(async () => {
        await queue.enqueue('delayed1');
        await queue.enqueue('delayed2');
        queue.close();
      }, 10);

      const items = await queue.drain();
      expect(items).toEqual(['delayed1', 'delayed2']);
    });
  });

  describe('take()', () => {
    test('should take exactly n items', async () => {
      const queue = new AsyncQueue<number>(10);

      // Enqueue more than needed
      for (let i = 0; i < 10; i++) {
        await queue.enqueue(i);
      }

      const items = await queue.take(5);
      expect(items).toEqual([0, 1, 2, 3, 4]);

      // Queue should still have remaining items
      expect(queue.size).toBe(5);
    });

    test('should return fewer items if queue closes early', async () => {
      const queue = new AsyncQueue<string>(5);

      await queue.enqueue('a');
      await queue.enqueue('b');
      queue.close();

      const items = await queue.take(5);
      expect(items).toEqual(['a', 'b']);
    });

    test('should handle take(0)', async () => {
      const queue = new AsyncQueue<number>(5);
      await queue.enqueue(1);

      const items = await queue.take(0);
      expect(items).toEqual([]);
    });

    test('should work with concurrent producers', async () => {
      const queue = new AsyncQueue<number>(2);

      // Producer that adds items slowly
      (async () => {
        for (let i = 0; i < 10; i++) {
          await queue.enqueue(i);
          await new Promise(resolve => setTimeout(resolve, 5));
        }
      })();

      const items = await queue.take(3);
      expect(items).toEqual([0, 1, 2]);
    });
  });

  describe('Type safety', () => {
    test('should maintain type safety through iteration', async () => {
      interface User {
        id: number;
        name: string;
      }

      const queue = new AsyncQueue<User>(2);
      const users: User[] = [];

      await queue.enqueue({ id: 1, name: 'Alice' });
      await queue.enqueue({ id: 2, name: 'Bob' });
      queue.close();

      for await (const user of queue) {
        users.push(user);
        // TypeScript should know user is of type User
        expect(typeof user.id).toBe('number');
        expect(typeof user.name).toBe('string');
      }

      expect(users).toHaveLength(2);
    });
  });

  describe('Performance', () => {
    test('should efficiently handle large iteration', async () => {
      const queue = new AsyncQueue<number>(100);
      const ITEMS = 10000;

      // Producer
      (async () => {
        for (let i = 0; i < ITEMS; i++) {
          await queue.enqueue(i);
        }
        queue.close();
      })();

      const start = Date.now();
      let count = 0;

      for await (const item of queue) {
        count++;
        expect(item).toBe(count - 1);
      }

      const duration = Date.now() - start;
      expect(count).toBe(ITEMS);

      // Should be very fast (typically < 100ms for 10k items)
      expect(duration).toBeLessThan(1000);
    });
  });
});