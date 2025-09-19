/**
 * AsyncQueue - A TypeScript implementation of an async producer-consumer queue with backpressure control
 * Uses circular buffer for O(1) enqueue/dequeue operations
 *
 * Developed by AI Hive® at O2.services
 * https://o2.services
 *
 * Copyright (c) 2024 AI Hive® at O2.services
 * Licensed under the MIT License
 */

/**
 * Promise resolver function type
 */
type PromiseResolver = () => void;

/**
 * AsyncQueue provides a thread-safe producer-consumer queue with backpressure control,
 * similar to .NET's Channel<T> or Go channels.
 * Uses a circular buffer for optimal performance.
 *
 * @template T The type of items in the queue
 */
export class AsyncQueue<T = any> {
  private readonly maxSize: number;
  private readonly buffer: (T | undefined)[];
  private head = 0;  // Index where we dequeue from
  private tail = 0;  // Index where we enqueue to
  private count = 0; // Number of items in queue

  // Waiting queues with reserved capacity - never shrink, only grow
  private waitingConsumers: (PromiseResolver | undefined)[] = [];
  private waitingConsumersCount = 0;
  private waitingProducers: (PromiseResolver | undefined)[] = [];
  private waitingProducersCount = 0;
  private readonly INITIAL_WAITING_CAPACITY = 16;

  private closed = false;

  /**
   * Creates a new AsyncQueue instance
   * @param maxSize Maximum number of items the queue can hold before producers block (default: 1)
   */
  constructor(maxSize = 1) {
    if (maxSize < 1) {
      throw new Error('maxSize must be at least 1');
    }
    // Use power of 2 for faster modulo operation with bitwise AND
    // Round up to nearest power of 2
    this.maxSize = maxSize;
    const bufferSize = 1 << (32 - Math.clz32(maxSize - 1));
    this.buffer = new Array(bufferSize);

    // Pre-allocate initial capacity for waiting queues
    this.waitingConsumers.length = this.INITIAL_WAITING_CAPACITY;
    this.waitingProducers.length = this.INITIAL_WAITING_CAPACITY;
  }

  /**
   * Adds an item to the circular buffer
   */
  private addToBuffer(item: T): void {
    this.buffer[this.tail] = item;
    this.tail = (this.tail + 1) & (this.buffer.length - 1);
    this.count++;
  }

  /**
   * Removes an item from the circular buffer
   */
  private removeFromBuffer(): T | undefined {
    if (this.count === 0) return undefined;

    const item = this.buffer[this.head];
    this.buffer[this.head] = undefined; // Help GC
    this.head = (this.head + 1) & (this.buffer.length - 1);
    this.count--;
    return item;
  }

  /**
   * Pushes a resolver onto a waiting queue with capacity management
   */
  private pushWaiter(queue: (PromiseResolver | undefined)[], count: number, resolver: PromiseResolver): number {
    // Grow capacity if needed (double the size)
    if (count >= queue.length) {
      queue.length = queue.length * 2;
    }
    queue[count] = resolver;
    return count + 1;
  }

  /**
   * Pops a resolver from a waiting queue (LIFO)
   */
  private popWaiter(queue: (PromiseResolver | undefined)[], count: number): PromiseResolver | undefined {
    if (count === 0) return undefined;
    const resolver = queue[count - 1];
    queue[count - 1] = undefined; // Help GC
    return resolver;
  }

  /**
   * Adds an item to the queue. Blocks if the queue is full.
   * @param item The item to add to the queue
   * @returns A promise that resolves when the item has been added
   * @throws Error if the queue has been closed
   */
  async enqueue(item: T): Promise<void> {
    // Prevent new items after close() to ensure clean shutdown
    if (this.closed) {
      throw new Error('Queue is closed');
    }

    // BLOCKING MECHANISM: Wait if queue is at capacity
    // This implements backpressure - fast producers slow down to match consumers
    while (this.count >= this.maxSize && !this.closed) {
      // Create unresolved Promise, store only the resolve function
      // This suspends the producer until a consumer makes space
      await new Promise<void>(resolve => {
        this.waitingProducersCount = this.pushWaiter(this.waitingProducers, this.waitingProducersCount, resolve);
      });

      // Check again after waking - queue might have been closed while waiting
      if (this.closed) {
        throw new Error('Queue is closed');
      }
    }

    // Add item to circular buffer (we now have space)
    this.addToBuffer(item);

    // WAKE MECHANISM: If any consumer is waiting for an item, wake ONE
    // Uses LIFO (stack) for O(1) performance - order doesn't affect correctness
    if (this.waitingConsumersCount > 0) {
      const consumer = this.popWaiter(this.waitingConsumers, this.waitingConsumersCount);
      this.waitingConsumersCount--;
      consumer?.(); // Calling resolve() wakes the awaiting consumer
    }
  }

  /**
   * Removes and returns the oldest item from the queue. Blocks if the queue is empty.
   * @returns A promise that resolves to the item, or undefined if the queue is closed and empty
   */
  async dequeue(): Promise<T | undefined> {
    // BLOCKING MECHANISM: Wait if queue is empty
    // Consumers block here until producers provide items or queue closes
    while (this.count === 0 && !this.closed) {
      // Create unresolved Promise, store only the resolve function
      // This suspends the consumer until a producer adds an item
      await new Promise<void>(resolve => {
        this.waitingConsumersCount = this.pushWaiter(this.waitingConsumers, this.waitingConsumersCount, resolve);
      });
    }

    // After waking/looping, check if we exited due to close (not an item)
    // Return undefined to signal "end of stream" to consumers
    if (this.count === 0 && this.closed) {
      return undefined;
    }

    // Remove and get the oldest item from circular buffer (FIFO order)
    const item = this.removeFromBuffer();

    // WAKE MECHANISM: If any producer is waiting for space, wake ONE
    // Uses LIFO (stack) for O(1) performance - order doesn't affect correctness
    if (this.waitingProducersCount > 0) {
      const producer = this.popWaiter(this.waitingProducers, this.waitingProducersCount);
      this.waitingProducersCount--;
      producer?.(); // Calling resolve() wakes the awaiting producer
    }

    return item;
  }

  /**
   * Signals that no more items will be added to the queue.
   * Existing items can still be consumed.
   */
  close(): void {
    // Signal that no more items will be added
    // Existing items can still be consumed
    this.closed = true;

    // Wake ALL waiting consumers - they'll return undefined
    // This allows graceful shutdown where all consumers exit cleanly
    for (let i = 0; i < this.waitingConsumersCount; i++) {
      this.waitingConsumers[i]?.();
      this.waitingConsumers[i] = undefined; // Help GC
    }
    this.waitingConsumersCount = 0;

    // Wake ALL waiting producers - they'll throw an error
    // This prevents deadlock where producers wait forever
    for (let i = 0; i < this.waitingProducersCount; i++) {
      this.waitingProducers[i]?.();
      this.waitingProducers[i] = undefined; // Help GC
    }
    this.waitingProducersCount = 0;
  }

  /**
   * Checks if the queue is closed AND empty
   * @returns true if the queue is closed and has no remaining items
   */
  get isClosed(): boolean {
    // Queue is "fully closed" only when closed AND empty
    // This allows consumers to drain remaining items after close()
    return this.closed && this.count === 0;
  }

  /**
   * Gets the current number of items in the queue
   * @returns The number of items currently in the queue
   */
  get size(): number {
    return this.count;
  }

  /**
   * Gets the maximum size of the queue
   * @returns The maximum number of items the queue can hold
   */
  get capacity(): number {
    return this.maxSize;
  }

  /**
   * Checks if the queue is at full capacity
   * @returns true if the queue is full
   */
  get isFull(): boolean {
    return this.count >= this.maxSize;
  }

  /**
   * Checks if the queue is empty
   * @returns true if the queue has no items
   */
  get isEmpty(): boolean {
    return this.count === 0;
  }

  /**
   * Gets the number of waiting consumers
   * @returns The number of consumers waiting for items
   */
  get waitingConsumerCount(): number {
    return this.waitingConsumersCount;
  }

  /**
   * Gets the number of waiting producers
   * @returns The number of producers waiting for space
   */
  get waitingProducerCount(): number {
    return this.waitingProducersCount;
  }

  /**
   * Returns an async iterator for consuming items from the queue.
   * Allows the queue to be used with for-await-of loops.
   * The iterator will complete when the queue is closed and empty.
   *
   * @example
   * ```typescript
   * const queue = new AsyncQueue<number>();
   *
   * // Producer
   * setTimeout(async () => {
   *   for (let i = 0; i < 5; i++) {
   *     await queue.enqueue(i);
   *   }
   *   queue.close();
   * }, 0);
   *
   * // Consumer using async iterator
   * for await (const item of queue) {
   *   console.log(item); // 0, 1, 2, 3, 4
   * }
   * ```
   */
  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      const item = await this.dequeue();
      if (item === undefined) {
        // dequeue returns undefined only when queue is closed and empty
        break;
      }
      yield item;
    }
  }

  /**
   * Creates an async iterable that consumes items from the queue.
   * This is an alternative way to get an async iterator.
   *
   * @returns An async iterable for consuming queue items
   * @example
   * ```typescript
   * const queue = new AsyncQueue<string>();
   * const iterator = queue.iterate();
   *
   * for await (const item of iterator) {
   *   console.log(item);
   * }
   * ```
   */
  iterate(): AsyncIterable<T> {
    return {
      [Symbol.asyncIterator]: () => this[Symbol.asyncIterator]()
    };
  }

  /**
   * Converts the queue to an async generator.
   * Useful for transformation pipelines.
   *
   * @returns An async generator that yields items from the queue
   * @example
   * ```typescript
   * const queue = new AsyncQueue<number>();
   * const generator = queue.toAsyncGenerator();
   *
   * // Transform items
   * async function* double(source: AsyncGenerator<number>) {
   *   for await (const item of source) {
   *     yield item * 2;
   *   }
   * }
   *
   * for await (const item of double(generator)) {
   *   console.log(item);
   * }
   * ```
   */
  async *toAsyncGenerator(): AsyncGenerator<T> {
    yield* this;
  }

  /**
   * Drains all items from the queue into an array.
   * Waits until the queue is closed and returns all items.
   *
   * @returns A promise that resolves to an array of all items
   * @example
   * ```typescript
   * const queue = new AsyncQueue<number>();
   *
   * // Producer
   * (async () => {
   *   for (let i = 0; i < 5; i++) {
   *     await queue.enqueue(i);
   *   }
   *   queue.close();
   * })();
   *
   * const items = await queue.drain();
   * console.log(items); // [0, 1, 2, 3, 4]
   * ```
   */
  async drain(): Promise<T[]> {
    const items: T[] = [];
    for await (const item of this) {
      items.push(item);
    }
    return items;
  }

  /**
   * Takes up to n items from the queue.
   * Returns early if the queue is closed before n items are received.
   *
   * @param n The maximum number of items to take
   * @returns A promise that resolves to an array of items
   * @example
   * ```typescript
   * const queue = new AsyncQueue<number>();
   *
   * // Take first 3 items
   * const items = await queue.take(3);
   * ```
   */
  async take(n: number): Promise<T[]> {
    const items: T[] = [];
    for (let i = 0; i < n && !this.isClosed; i++) {
      const item = await this.dequeue();
      if (item !== undefined) {
        items.push(item);
      } else {
        break;
      }
    }
    return items;
  }
}

// Default export for CommonJS compatibility
export default AsyncQueue;