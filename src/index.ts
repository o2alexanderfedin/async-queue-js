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
 * Largest capacity an AsyncQueue can be created with.
 *
 * The circular buffer is rounded up to a power of two, so the backing array for
 * `MAX_CAPACITY` is exactly 2^30 slots. `2^31` would overflow the signed 32-bit
 * shift used for the rounding, and array lengths above 2^32-1 are not
 * representable at all, so this is the largest value that can be honoured.
 */
const MAX_CAPACITY = 2 ** 30;

/**
 * Rounds `n` up to the nearest power of two.
 *
 * Uses `2 ** k` rather than `1 << k`: the shift operator coerces to *signed*
 * 32-bit, so `1 << 31` is negative (RangeError from `new Array`) and `1 << 32`
 * silently wraps to 1 (a one-slot buffer that then overwrites itself).
 *
 * @param n A positive integer no greater than {@link MAX_CAPACITY}
 */
function nextPowerOfTwo(n: number): number {
  return n <= 1 ? 1 : 2 ** (32 - Math.clz32(n - 1));
}

/** Shared no-op, used to mark a rejected promise as handled. */
const NOOP = (): void => {};

/** Shared already-resolved promise for the non-blocking enqueue path. */
const RESOLVED: Promise<void> = Promise.resolve();

/**
 * The outcome of a {@link AsyncQueue.dequeueResult} call.
 *
 * `done: true` means the queue is closed and drained — end of stream. Any other
 * result carries a real payload in `value`, **including `undefined`**. This is
 * the type to reach for whenever `T` can itself be `undefined`; `dequeue()`
 * cannot tell those two cases apart.
 *
 * @template T The type of items in the queue
 */
export type DequeueResult<T> =
  | { readonly done: true; readonly value: undefined }
  | { readonly done: false; readonly value: T };

/** Shared end-of-stream result. Frozen so callers cannot corrupt it. */
const DONE: DequeueResult<never> = Object.freeze({ done: true as const, value: undefined });

/**
 * Options accepted by the {@link AsyncQueue} constructor.
 *
 * @template T The type of items in the queue
 */
export interface AsyncQueueOptions<T = any> {
  /**
   * Called whenever the queue rejects an `enqueue()`, i.e. whenever an item is
   * dropped because the queue was (or became) closed.
   *
   * Those rejections are marked as handled internally so that a fire-and-forget
   * producer cannot terminate the process (see {@link AsyncQueue.enqueue}). That
   * makes this hook the only *global* way to observe a dropped item — awaiting
   * the returned promise still works and is unaffected.
   *
   * Fires for every rejected enqueue, whether or not the caller also observes
   * the rejection. The hook should not throw; if it does, the exception is
   * reported via `console.error` and otherwise ignored. It is deliberately not
   * re-thrown: this hook runs during close(), and letting it escape would
   * re-create the very "queue lifecycle kills the host process" failure the
   * suppression above exists to prevent.
   */
  onDropped?: (error: Error, item: T) => void;
}

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

  /** Optional observer for items dropped by a rejected enqueue(). */
  private readonly onDropped: ((error: Error, item: T) => void) | undefined;

  /**
   * Largest capacity a queue can be created with (2^30).
   * Larger requests are clamped to this value; see the constructor.
   */
  static readonly MAX_CAPACITY = MAX_CAPACITY;

  /**
   * Creates a new AsyncQueue instance
   *
   * @param maxSize Maximum number of items the queue can hold before producers block (default: 1)
   *
   * `maxSize` is normalised before use:
   * - `NaN` and non-numbers are rejected (`TypeError`). `NaN < 1` is false, so an
   *   unguarded comparison lets `NaN` through and then disables backpressure
   *   entirely, because `count >= NaN` is also false.
   * - Values below 1 are rejected (`Error`).
   * - Non-integers are rounded **up** to the next integer, so the effective
   *   capacity is never smaller than what the caller asked for.
   * - `Infinity` and anything above {@link AsyncQueue.MAX_CAPACITY} are clamped to
   *   `MAX_CAPACITY` (2^30). This queue is bounded by construction; there is no
   *   unbounded mode. `capacity` reports the clamped value, not the request.
   *
   * @param options Optional queue-wide settings, see {@link AsyncQueueOptions}
   */
  constructor(maxSize = 1, options?: AsyncQueueOptions<T>) {
    this.onDropped = options?.onDropped;
    if (typeof maxSize !== 'number' || Number.isNaN(maxSize)) {
      throw new TypeError(`maxSize must be a number, received ${String(maxSize)}`);
    }
    if (maxSize < 1) {
      throw new Error('maxSize must be at least 1');
    }
    // Round fractional requests up, and clamp anything unrepresentable (including
    // Infinity) down to MAX_CAPACITY, so maxSize is always a usable integer.
    this.maxSize = Math.min(
      maxSize === Infinity ? MAX_CAPACITY : Math.ceil(maxSize),
      MAX_CAPACITY
    );
    // Use power of 2 for faster modulo operation with bitwise AND
    // Round up to nearest power of 2
    const bufferSize = nextPowerOfTwo(this.maxSize);
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
   * Removes the oldest item from the circular buffer and wakes one waiting
   * producer, if any.
   *
   * The caller MUST have established that `count > 0`. The buffer slot is read
   * through a cast because `undefined` is a legitimate payload — emptiness is
   * tracked by `count`, never by inspecting the slot.
   */
  private takeFromBuffer(): T {
    const item = this.buffer[this.head] as T;
    this.buffer[this.head] = undefined; // Help GC
    this.head = (this.head + 1) & (this.buffer.length - 1);
    this.count--;

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
   * Reports a dropped item to the optional `onDropped` hook.
   *
   * A throwing hook is contained: it is logged, not propagated. This runs on the
   * close() path, where an escaping exception would either corrupt the shutdown
   * loop or become the unhandled rejection this whole mechanism exists to avoid.
   */
  private reportDropped(error: Error, item: T): void {
    const handler = this.onDropped;
    if (handler === undefined) return;
    try {
      handler(error, item);
    } catch (hookError) {
      // eslint-disable-next-line no-console
      console.error('AsyncQueue: onDropped handler threw', hookError);
    }
  }

  /**
   * Builds the rejected promise returned by a failed enqueue, pre-marked as
   * handled so it can never reach `process.on('unhandledRejection')`.
   */
  private rejectEnqueue(error: Error, item: T): Promise<void> {
    const rejected = Promise.reject(error);
    // Attaching a handler here does NOT consume the rejection - anyone who
    // awaits or .catch()es `rejected` still sees `error`. It only tells the
    // engine that this rejection is accounted for.
    rejected.catch(NOOP);
    this.reportDropped(error, item);
    return rejected;
  }

  /**
   * Adds an item to the queue. Blocks if the queue is full.
   *
   * @param item The item to add to the queue
   * @returns A promise that resolves when the item has been added, and rejects
   *          with `Error('Queue is closed')` if the queue is or becomes closed
   *
   * The returned promise is *never* reported as an unhandled rejection. `close()`
   * rejects every blocked producer, and a producer started fire-and-forget
   * (`void queue.enqueue(x)`, the shape used in this library's own README
   * examples) has no handler attached, so on Node >= 15 that rejection would
   * terminate the host process — one fatal event per blocked producer. The queue
   * therefore marks its own rejections as handled at the moment it creates them.
   *
   * Consequence: if you neither await nor `.catch()` the returned promise, a
   * dropped item is now silent rather than fatal. Pass `onDropped` to the
   * constructor to observe drops globally.
   */
  enqueue(item: T): Promise<void> {
    // Prevent new items after close() to ensure clean shutdown
    if (this.closed) {
      return this.rejectEnqueue(new Error('Queue is closed'), item);
    }

    // FAST PATH: space available, no suspension, no extra promise allocation.
    if (this.count < this.maxSize) {
      this.deliver(item);
      return RESOLVED;
    }

    // SLOW PATH: the producer must block, which means this promise can reject
    // later (from close()). Guard it now, while we still hold the reference.
    const pending = this.enqueueBlocking(item);
    pending.catch((error: Error) => this.reportDropped(error, item));
    return pending;
  }

  /**
   * The suspending half of {@link enqueue}. Only entered when the queue is full.
   */
  private async enqueueBlocking(item: T): Promise<void> {
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

    this.deliver(item);
  }

  /**
   * Places an item in the buffer and wakes one waiting consumer, if any.
   * Callers must have already established that there is room.
   */
  private deliver(item: T): void {
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
   * BLOCKING MECHANISM: returns a promise that settles when a producer adds an
   * item or the queue closes.
   *
   * Deliberately NOT an `async` helper that loops internally. An extra async
   * frame costs an extra microtask hop between "a wakeup arrived" and "the item
   * is taken", and another consumer can drain the buffer inside that gap. The
   * caller must therefore re-check `count` in its own frame — see the `while`
   * loops in {@link dequeue} and {@link dequeueResult}.
   */
  private parkConsumer(): Promise<void> {
    // Create unresolved Promise, store only the resolve function
    // This suspends the consumer until a producer adds an item
    return new Promise<void>(resolve => {
      this.waitingConsumersCount = this.pushWaiter(this.waitingConsumers, this.waitingConsumersCount, resolve);
    });
  }

  /**
   * Removes and returns the oldest item from the queue. Blocks if the queue is empty.
   *
   * @returns A promise that resolves to the item, or `undefined` if the queue is
   *          closed and empty
   *
   * **`undefined` is ambiguous here.** It means either "the stream ended" or "the
   * next item genuinely is `undefined`". If `T` can be `undefined`, use
   * {@link dequeueResult} instead — every other consumer entry point
   * (`for await`, {@link drain}, {@link take}) already does.
   */
  async dequeue(): Promise<T | undefined> {
    while (this.count === 0) {
      // Nothing buffered and nothing more coming: end of stream.
      if (this.closed) {
        return undefined;
      }
      await this.parkConsumer();
    }

    // Remove and get the oldest item from circular buffer (FIFO order)
    return this.takeFromBuffer();
  }

  /**
   * Removes and returns the oldest item, distinguishing "end of stream" from a
   * payload that happens to be `undefined`. Blocks if the queue is empty.
   *
   * @returns `{ done: true }` once the queue is closed and drained, otherwise
   *          `{ done: false, value }` where `value` may be any `T` — `undefined`
   *          included
   *
   * @example
   * ```typescript
   * const result = await queue.dequeueResult();
   * if (result.done) return;        // stream really ended
   * handle(result.value);           // may legitimately be undefined
   * ```
   */
  async dequeueResult(): Promise<DequeueResult<T>> {
    while (this.count === 0) {
      if (this.closed) {
        return DONE;
      }
      await this.parkConsumer();
    }

    return { done: false, value: this.takeFromBuffer() };
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
    for (;;) {
      // dequeueResult(), not dequeue(): an item whose value is `undefined` must
      // not be mistaken for the end of the stream.
      const result = await this.dequeueResult();
      if (result.done) {
        break;
      }
      yield result.value;
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
    for (;;) {
      const result = await this.dequeueResult();
      if (result.done) {
        return items;
      }
      items.push(result.value);
    }
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
      const result = await this.dequeueResult();
      if (result.done) {
        break;
      }
      items.push(result.value);
    }
    return items;
  }
}

// Default export for CommonJS compatibility
export default AsyncQueue;