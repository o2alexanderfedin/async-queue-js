/**
 * AsyncQueue - A TypeScript implementation of an async producer-consumer queue with backpressure control
 */

/**
 * Promise resolver function type
 */
type PromiseResolver = () => void;

/**
 * AsyncQueue provides a thread-safe producer-consumer queue with backpressure control,
 * similar to .NET's Channel<T> or Go channels.
 *
 * @template T The type of items in the queue
 */
export class AsyncQueue<T = any> {
  private readonly maxSize: number;
  private readonly queue: T[] = [];
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
    // Maximum items the queue can hold before producers block
    // Small buffers (1) = tight coupling, low memory, immediate backpressure
    // Large buffers = loose coupling, more memory, delayed backpressure
    this.maxSize = maxSize;
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
    while (this.queue.length >= this.maxSize && !this.closed) {
      // Create unresolved Promise, store only the resolve function
      // This suspends the producer until a consumer makes space
      await new Promise<void>(resolve => this.waitingProducers.push(resolve));

      // Check again after waking - queue might have been closed while waiting
      if (this.closed) {
        throw new Error('Queue is closed');
      }
    }

    // Add item to queue (we now have space)
    this.queue.push(item);

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
    while (this.queue.length === 0 && !this.closed) {
      // Create unresolved Promise, store only the resolve function
      // This suspends the consumer until a producer adds an item
      await new Promise<void>(resolve => this.waitingConsumers.push(resolve));
    }

    // After waking/looping, check if we exited due to close (not an item)
    // Return undefined to signal "end of stream" to consumers
    if (this.queue.length === 0 && this.closed) {
      return undefined;
    }

    // Remove and get the oldest item (FIFO order)
    const item = this.queue.shift();

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
    return this.closed && this.queue.length === 0;
  }

  /**
   * Gets the current number of items in the queue
   * @returns The number of items currently in the queue
   */
  get size(): number {
    return this.queue.length;
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
    return this.queue.length >= this.maxSize;
  }

  /**
   * Checks if the queue is empty
   * @returns true if the queue has no items
   */
  get isEmpty(): boolean {
    return this.queue.length === 0;
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