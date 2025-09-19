/**
 * AsyncQueue - A TypeScript implementation of an async producer-consumer queue with backpressure control
 * Circular Buffer Version - Optimized for performance using circular buffer instead of array shift
 */

/**
 * Promise resolver function type
 */
type PromiseResolver = () => void;

/**
 * AsyncQueue provides a thread-safe producer-consumer queue with backpressure control,
 * similar to .NET's Channel<T> or Go channels.
 * This version uses a circular buffer for O(1) enqueue/dequeue operations.
 *
 * @template T The type of items in the queue
 */
export class AsyncQueue<T = any> {
  private readonly maxSize: number;
  private readonly buffer: (T | undefined)[];
  private head = 0;  // Index where we dequeue from
  private tail = 0;  // Index where we enqueue to
  private count = 0; // Number of items in queue
  private readonly waitingConsumers: PromiseResolver[] = [];
  private readonly waitingProducers: PromiseResolver[] = [];
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
      await new Promise<void>(resolve => this.waitingProducers.push(resolve));

      // Check again after waking - queue might have been closed while waiting
      if (this.closed) {
        throw new Error('Queue is closed');
      }
    }

    // Add item to circular buffer (we now have space)
    this.addToBuffer(item);

    // WAKE MECHANISM: If any consumer is waiting for an item, wake ONE
    // This ensures FIFO ordering - first waiting consumer gets the item
    if (this.waitingConsumers.length > 0) {
      const consumer = this.waitingConsumers.shift();
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
      await new Promise<void>(resolve => this.waitingConsumers.push(resolve));
    }

    // After waking/looping, check if we exited due to close (not an item)
    // Return undefined to signal "end of stream" to consumers
    if (this.count === 0 && this.closed) {
      return undefined;
    }

    // Remove and get the oldest item from circular buffer (FIFO order)
    const item = this.removeFromBuffer();

    // WAKE MECHANISM: If any producer is waiting for space, wake ONE
    // This allows the blocked producer to add its item
    if (this.waitingProducers.length > 0) {
      const producer = this.waitingProducers.shift();
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
    this.waitingConsumers.forEach(resolve => resolve());
    this.waitingConsumers.length = 0;

    // Wake ALL waiting producers - they'll throw an error
    // This prevents deadlock where producers wait forever
    this.waitingProducers.forEach(resolve => resolve());
    this.waitingProducers.length = 0;
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
    return this.waitingConsumers.length;
  }

  /**
   * Gets the number of waiting producers
   * @returns The number of producers waiting for space
   */
  get waitingProducerCount(): number {
    return this.waitingProducers.length;
  }
}

// Default export for CommonJS compatibility
export default AsyncQueue;