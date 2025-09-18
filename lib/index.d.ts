/**
 * AsyncQueue - A JavaScript implementation of an async producer-consumer queue with backpressure control
 */
declare class AsyncQueue<T = any> {
  /**
   * Creates a new AsyncQueue instance
   * @param maxSize - Maximum number of items the queue can hold before producers block (default: 1)
   */
  constructor(maxSize?: number);

  /**
   * Adds an item to the queue. Blocks if the queue is full.
   * @param item - The item to add to the queue
   * @returns A promise that resolves when the item has been added
   * @throws Error if the queue has been closed
   */
  enqueue(item: T): Promise<void>;

  /**
   * Removes and returns the oldest item from the queue. Blocks if the queue is empty.
   * @returns A promise that resolves to the item, or undefined if the queue is closed and empty
   */
  dequeue(): Promise<T | undefined>;

  /**
   * Signals that no more items will be added to the queue.
   * Existing items can still be consumed.
   */
  close(): void;

  /**
   * Checks if the queue is closed AND empty
   * @returns true if the queue is closed and has no remaining items
   */
  get isClosed(): boolean;
}

export = AsyncQueue;