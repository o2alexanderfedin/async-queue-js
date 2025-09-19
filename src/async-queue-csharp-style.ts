/**
 * TypeScript port of C# AsyncQueue implementation
 * Uses two queues: one for items and one for promises (TaskCompletionSource equivalent)
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

  trySetException(error: Error): boolean {
    if (this._completed) return false;
    this._completed = true;
    this._reject(error);
    return true;
  }
}

/**
 * Simple queue implementation (TypeScript doesn't have ConcurrentQueue)
 */
class SimpleQueue<T> {
  private items: T[] = [];

  enqueue(item: T): void {
    this.items.push(item);
  }

  tryDequeue(): { success: boolean; item?: T } {
    if (this.items.length === 0) {
      return { success: false };
    }
    return { success: true, item: this.items.shift() };
  }

  get count(): number {
    return this.items.length;
  }
}

/**
 * C#-style AsyncQueue implementation in TypeScript
 * Direct port of the C# version using TaskCompletionSource pattern
 */
export class AsyncQueueCSharpStyle<T> {
  private readonly _items: SimpleQueue<T>;
  private readonly _promises: SimpleQueue<TaskCompletionSource<T>>;

  constructor() {
    this._items = new SimpleQueue<T>();
    this._promises = new SimpleQueue<TaskCompletionSource<T>>();
  }

  /**
   * Dequeue without cancellation support
   */
  async dequeueAsync(): Promise<T> {
    return this.dequeueAsyncWithCancel();
  }

  /**
   * Dequeue with cancellation support (mimics C# CancellationToken)
   */
  async dequeueAsyncWithCancel(signal?: AbortSignal): Promise<T> {
    const promise = new TaskCompletionSource<T>();

    // Try to get an item immediately
    const { success: itemFound, item } = this._items.tryDequeue();

    if (!itemFound) {
      // No item available, register cancellation if provided
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
      this._promises.enqueue(promise);
    } else {
      // Item available immediately
      promise.trySetResult(item!);
    }

    try {
      const result = await promise.task;
      return result;
    } catch (error) {
      throw error;
    }
  }

  /**
   * Enqueue an item
   */
  enqueue(item: T): void {
    while (true) {
      // Try to find a waiting promise
      const { success: promiseFound, item: promise } = this._promises.tryDequeue();

      if (!promiseFound) {
        // No waiting promises, store the item
        this._items.enqueue(item);
        break;
      }

      // Try to fulfill the promise
      const promiseSet = promise!.trySetResult(item);
      if (promiseSet) {
        // Successfully delivered item to waiting consumer
        break;
      }
      // Promise was already completed (e.g., canceled), try next promise
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
}

// Default export for convenience
export default AsyncQueueCSharpStyle;