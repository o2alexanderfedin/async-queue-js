/**
 * Optimized TypeScript port of C# AsyncQueue implementation
 * Fixes the O(n) array.shift() bottleneck with a circular buffer approach
 */

/**
 * TypeScript equivalent of C#'s TaskCompletionSource<T>
 */
class TaskCompletionSource<T> {
  private _promise: Promise<T>;
  private _resolve!: (value: T) => void;
  private _reject!: (error: Error) => void;
  private _completed = false;

  constructor() {
    this._promise = new Promise<T>((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
    });
  }

  get task(): Promise<T> {
    return this._promise;
  }

  trySetResult(value: T): boolean {
    if (this._completed) return false;
    this._completed = true;
    this._resolve(value);
    return true;
  }

  trySetCanceled(): boolean {
    if (this._completed) return false;
    this._completed = true;
    this._reject(new Error('Operation canceled'));
    return true;
  }
}

/**
 * Optimized Queue with O(1) dequeue operation
 * Uses circular buffer internally instead of array.shift()
 */
class OptimizedQueue<T> {
  private buffer: (T | undefined)[] = [];
  private head = 0;
  private tail = 0;
  private _count = 0;
  private capacity = 16; // Initial capacity

  enqueue(item: T): void {
    // Grow if needed
    if (this._count >= this.capacity) {
      this.grow();
    }

    this.buffer[this.tail] = item;
    this.tail = (this.tail + 1) % this.capacity;
    this._count++;
  }

  tryDequeue(): { success: boolean; item?: T } {
    if (this._count === 0) {
      return { success: false };
    }

    const item = this.buffer[this.head];
    this.buffer[this.head] = undefined; // Help GC
    this.head = (this.head + 1) % this.capacity;
    this._count--;

    // Shrink if queue is mostly empty (optional optimization)
    if (this.capacity > 64 && this._count < this.capacity / 4) {
      this.shrink();
    }

    return { success: true, item: item as T };
  }

  private grow(): void {
    const newCapacity = this.capacity * 2;
    const newBuffer: (T | undefined)[] = new Array(newCapacity);

    // Copy existing items to new buffer
    for (let i = 0; i < this._count; i++) {
      newBuffer[i] = this.buffer[(this.head + i) % this.capacity];
    }

    this.buffer = newBuffer;
    this.head = 0;
    this.tail = this._count;
    this.capacity = newCapacity;
  }

  private shrink(): void {
    const newCapacity = Math.max(16, this.capacity / 2);
    const newBuffer: (T | undefined)[] = new Array(newCapacity);

    // Copy existing items to new buffer
    for (let i = 0; i < this._count; i++) {
      newBuffer[i] = this.buffer[(this.head + i) % this.capacity];
    }

    this.buffer = newBuffer;
    this.head = 0;
    this.tail = this._count;
    this.capacity = newCapacity;
  }

  get count(): number {
    return this._count;
  }

  // Clear the queue (useful for cleanup)
  clear(): void {
    this.buffer = new Array(16);
    this.head = 0;
    this.tail = 0;
    this._count = 0;
    this.capacity = 16;
  }
}

/**
 * Further optimized: Use stack for promises queue
 * Since order doesn't matter for waiting consumers, use LIFO for O(1) pop
 */
class PromiseStack<T> {
  private items: T[] = [];
  private _count = 0;

  push(item: T): void {
    this.items[this._count++] = item;
  }

  tryPop(): { success: boolean; item?: T } {
    if (this._count === 0) {
      return { success: false };
    }

    const item = this.items[--this._count];
    this.items[this._count] = undefined as any; // Help GC
    return { success: true, item };
  }

  get count(): number {
    return this._count;
  }
}

/**
 * Optimized C#-style AsyncQueue implementation
 * Fixes bottlenecks from the original:
 * 1. O(1) dequeue with circular buffer instead of array.shift()
 * 2. Stack-based promise queue for O(1) operations
 * 3. Reduced allocations with pooling potential
 */
export class AsyncQueueCSharpOptimized<T> {
  private readonly _items: OptimizedQueue<T>;
  private readonly _promises: PromiseStack<TaskCompletionSource<T>>;

  constructor() {
    this._items = new OptimizedQueue<T>();
    this._promises = new PromiseStack<TaskCompletionSource<T>>();
  }

  /**
   * Dequeue without cancellation support
   */
  async dequeueAsync(): Promise<T> {
    return this.dequeueAsyncWithCancel();
  }

  /**
   * Dequeue with cancellation support (mimics C# CancellationToken)
   * Optimized to reduce promise allocations when item is immediately available
   */
  async dequeueAsyncWithCancel(signal?: AbortSignal): Promise<T> {
    // Fast path: try to get an item immediately without creating promise
    const { success: itemFound, item } = this._items.tryDequeue();

    if (itemFound) {
      // Item available immediately - no promise allocation needed!
      return item!;
    }

    // Slow path: need to wait for an item
    const promise = new TaskCompletionSource<T>();

    // Register cancellation if provided
    if (signal) {
      const onAbort = () => {
        promise.trySetCanceled();
      };

      if (signal.aborted) {
        promise.trySetCanceled();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    // Queue the promise to be resolved when an item arrives
    this._promises.push(promise);

    return promise.task;
  }

  /**
   * Enqueue an item
   * Optimized to use stack operations
   */
  enqueue(item: T): void {
    // Try to find a waiting promise (LIFO for better cache locality)
    const { success: promiseFound, item: promise } = this._promises.tryPop();

    if (!promiseFound) {
      // No waiting promises, store the item
      this._items.enqueue(item);
      return;
    }

    // Try to fulfill the promise
    const promiseSet = promise!.trySetResult(item);
    if (!promiseSet) {
      // Promise was already completed (e.g., canceled)
      // Retry with the same item
      this.enqueue(item);
    }
  }

  /**
   * Batch enqueue for better performance
   */
  enqueueMany(items: T[]): void {
    for (const item of items) {
      this.enqueue(item);
    }
  }

  /**
   * Get current number of queued items
   */
  get size(): number {
    return this._items.count;
  }

  /**
   * Get number of waiting consumers
   */
  get waitingConsumerCount(): number {
    return this._promises.count;
  }

  /**
   * Check if queue is empty
   */
  get isEmpty(): boolean {
    return this._items.count === 0;
  }

  /**
   * Clear all items (useful for cleanup)
   */
  clear(): void {
    this._items.clear();
    // Note: we don't clear promises as they should be resolved/rejected
  }
}

// Default export for convenience
export default AsyncQueueCSharpOptimized;