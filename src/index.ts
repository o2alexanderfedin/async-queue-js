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
 * State shared by every suspended caller, producer or consumer.
 *
 * `cancelled` waiters keep their slot in the FIFO ring until the next scan
 * reaches them — removing them eagerly would be O(n). They are skipped, so a
 * cancelled waiter never consumes a wakeup.
 */
interface Waiter {
  cancelled: boolean;
  settled: boolean;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/** A consumer suspended inside dequeue()/dequeueResult()/the async iterator. */
interface ConsumerWaiter<T> extends Waiter {
  readonly promise: Promise<DequeueResult<T>>;
  readonly resolve: (result: DequeueResult<T>) => void;
  readonly reject: (reason: unknown) => void;
}

/**
 * A producer suspended inside enqueue().
 *
 * The item travels WITH the waiter rather than being inserted by the producer
 * after it wakes. Whoever frees a slot moves the item into the buffer and then
 * settles the producer, so the transfer is atomic: a cancelled producer is
 * skipped before its item can ever reach the buffer.
 */
interface ProducerWaiter<T> extends Waiter {
  item: T;
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
}

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

/** Shared end-of-iteration result for the async iterator. */
const ITERATOR_DONE = Object.freeze({ done: true, value: undefined }) as IteratorReturnResult<undefined>;

/**
 * `Symbol.asyncDispose`, with the same fallback TypeScript's own `using`
 * downlevel helper uses. The symbol only exists on Node >= 20, and this package
 * declares `engines.node >= 12`, so it cannot be referenced directly — a
 * computed key of `undefined` would define a property literally named
 * `"undefined"`.
 */
const ASYNC_DISPOSE: typeof Symbol.asyncDispose =
  (Symbol as { asyncDispose?: typeof Symbol.asyncDispose }).asyncDispose ??
  (Symbol.for('Symbol.asyncDispose') as typeof Symbol.asyncDispose);

/**
 * Options accepted by {@link AsyncQueue.enqueue}, {@link AsyncQueue.dequeue} and
 * {@link AsyncQueue.dequeueResult}.
 */
export interface AbortOptions {
  /**
   * Cancels the call if it has to suspend.
   *
   * Aborting removes the waiter from the queue *before* it can take part in any
   * handoff, so a cancelled consumer never absorbs an item and a cancelled
   * producer never inserts one. The returned promise rejects with
   * `signal.reason`, or with an `Error` whose `name` is `'AbortError'` when the
   * runtime does not populate `reason`.
   *
   * Without a signal there is no way for the queue to learn that a caller walked
   * away: `Promise.race([queue.dequeue(), timeout])` leaves a live waiter that
   * still occupies its place in line. Pass a signal whenever a dequeue or
   * enqueue may be abandoned.
   */
  signal?: AbortSignal;
}

/**
 * Builds the rejection reason for an aborted operation.
 * `AbortSignal.reason` only exists on newer runtimes, so fall back to a
 * conventional `AbortError`.
 */
function abortReason(signal: AbortSignal): unknown {
  const reason = (signal as { reason?: unknown }).reason;
  if (reason !== undefined) return reason;
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

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

  // Waiting queues with reserved capacity - never shrink, only grow.
  // FIFO: `*Head` is the index of the oldest entry, `*Slots` the number of
  // physical entries from it (cancelled ones included), `waiting*Count` the
  // number of LIVE entries, which is what the public getters report.
  private readonly waitingConsumers: (ConsumerWaiter<T> | undefined)[] = [];
  private consumersHead = 0;
  private consumersSlots = 0;
  private waitingConsumersCount = 0;
  private readonly waitingProducers: (ProducerWaiter<T> | undefined)[] = [];
  private producersHead = 0;
  private producersSlots = 0;
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

    // PROMOTION: a slot just opened, so move the longest-waiting producer's item
    // into it and release that producer. Doing the insert here (rather than
    // letting the producer re-enter enqueue() after waking) is what makes the
    // transfer atomic - there is no window in which a woken producer could
    // insert out of order, and a cancelled producer is skipped entirely.
    // Tested against `producersSlots`, not the live count, so cancelled records
    // are reaped here too instead of lingering in the ring.
    if (this.producersSlots > 0) {
      const producer = this.popProducer();
      if (producer !== undefined) {
        this.addToBuffer(producer.item);
        producer.item = undefined as T; // Help GC
        this.settleProducer(producer);
      }
    }

    return item;
  }

  /**
   * Makes room for one more entry at `head + slots`, and returns the new head.
   *
   * Reserved capacity is preserved: the array only ever grows. When there is
   * dead space below `head` and the live entries occupy at most half the array,
   * the entries slide back to index 0 instead of doubling. Both branches leave
   * at least half the array free at the tail, so pushes stay O(1) amortised.
   */
  private static ensureRoom(queue: unknown[], head: number, slots: number): number {
    if (head + slots < queue.length) {
      return head;
    }
    if (slots * 2 <= queue.length) {
      for (let i = 0; i < slots; i++) {
        queue[i] = queue[head + i];
      }
      for (let i = slots; i < head + slots; i++) {
        queue[i] = undefined; // Help GC
      }
      return 0;
    }
    queue.length = queue.length * 2;
    return head;
  }

  /**
   * Detaches a waiter's abort listener, if it has one.
   */
  private static detach(waiter: Waiter): void {
    if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
      waiter.signal = undefined;
      waiter.onAbort = undefined;
    }
  }

  /**
   * Suspends a consumer and registers it at the BACK of the FIFO queue.
   */
  private pushConsumer(signal: AbortSignal | undefined): ConsumerWaiter<T> {
    let resolve!: (result: DequeueResult<T>) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<DequeueResult<T>>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const waiter: ConsumerWaiter<T> = { promise, resolve, reject, cancelled: false, settled: false };

    this.consumersHead = AsyncQueue.ensureRoom(this.waitingConsumers, this.consumersHead, this.consumersSlots);
    this.waitingConsumers[this.consumersHead + this.consumersSlots] = waiter;
    this.consumersSlots++;
    this.waitingConsumersCount++;

    if (signal !== undefined) {
      const onAbort = (): void => {
        if (waiter.settled) return;
        waiter.settled = true;
        waiter.cancelled = true;
        this.waitingConsumersCount--;
        AsyncQueue.detach(waiter);
        waiter.reject(abortReason(signal));
      };
      waiter.signal = signal;
      waiter.onAbort = onAbort;
      signal.addEventListener('abort', onAbort, { once: true });
    }

    return waiter;
  }

  /**
   * Suspends a producer, holding its item, at the BACK of the FIFO queue.
   */
  private pushProducer(item: T, signal: AbortSignal | undefined): ProducerWaiter<T> {
    let resolve!: () => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const waiter: ProducerWaiter<T> = { item, promise, resolve, reject, cancelled: false, settled: false };

    this.producersHead = AsyncQueue.ensureRoom(this.waitingProducers, this.producersHead, this.producersSlots);
    this.waitingProducers[this.producersHead + this.producersSlots] = waiter;
    this.producersSlots++;
    this.waitingProducersCount++;

    if (signal !== undefined) {
      const onAbort = (): void => {
        if (waiter.settled) return;
        waiter.settled = true;
        waiter.cancelled = true;
        this.waitingProducersCount--;
        AsyncQueue.detach(waiter);
        // Release the item: a cancelled producer must never insert it later.
        waiter.item = undefined as T;
        waiter.reject(abortReason(signal));
      };
      waiter.signal = signal;
      waiter.onAbort = onAbort;
      signal.addEventListener('abort', onAbort, { once: true });
    }

    return waiter;
  }

  /**
   * Removes and returns the oldest LIVE consumer, discarding cancelled ones on
   * the way. FIFO: the caller who has been waiting longest is served first.
   */
  private popConsumer(): ConsumerWaiter<T> | undefined {
    while (this.consumersSlots > 0) {
      const waiter = this.waitingConsumers[this.consumersHead] as ConsumerWaiter<T>;
      this.waitingConsumers[this.consumersHead] = undefined; // Help GC
      this.consumersHead++;
      this.consumersSlots--;
      if (this.consumersSlots === 0) {
        this.consumersHead = 0;
      }
      if (!waiter.cancelled) {
        this.waitingConsumersCount--;
        return waiter;
      }
    }
    return undefined;
  }

  /**
   * Removes and returns the oldest LIVE producer, discarding cancelled ones on
   * the way. FIFO: items enter the buffer in the order their producers called
   * enqueue(), which is what "strict FIFO" has to mean once producers block.
   */
  private popProducer(): ProducerWaiter<T> | undefined {
    while (this.producersSlots > 0) {
      const waiter = this.waitingProducers[this.producersHead] as ProducerWaiter<T>;
      this.waitingProducers[this.producersHead] = undefined; // Help GC
      this.producersHead++;
      this.producersSlots--;
      if (this.producersSlots === 0) {
        this.producersHead = 0;
      }
      if (!waiter.cancelled) {
        this.waitingProducersCount--;
        return waiter;
      }
    }
    return undefined;
  }

  /**
   * Hands an item to a suspended consumer.
   */
  private settleConsumer(waiter: ConsumerWaiter<T>, item: T): void {
    waiter.settled = true;
    AsyncQueue.detach(waiter);
    waiter.resolve({ done: false, value: item });
  }

  /**
   * Releases a suspended consumer with end-of-stream.
   */
  private settleConsumerDone(waiter: ConsumerWaiter<T>): void {
    waiter.settled = true;
    AsyncQueue.detach(waiter);
    waiter.resolve(DONE);
  }

  /**
   * Cancels a suspended consumer *without* rejecting it.
   *
   * Used by the async iterator's `return()`. The pending `next()` promise is
   * frequently unobserved at that point, so it is resolved with end-of-stream
   * rather than rejected — a rejection there would be exactly the kind of
   * unhandled rejection D1 exists to prevent.
   */
  private cancelConsumer(waiter: ConsumerWaiter<T>): void {
    if (waiter.settled) return;
    waiter.settled = true;
    waiter.cancelled = true;
    this.waitingConsumersCount--;
    AsyncQueue.detach(waiter);
    waiter.resolve(DONE);
  }

  /**
   * Releases a suspended producer whose item has just been buffered.
   */
  private settleProducer(waiter: ProducerWaiter<T>): void {
    waiter.settled = true;
    AsyncQueue.detach(waiter);
    waiter.resolve();
  }

  /**
   * Rejects a suspended producer because the queue closed underneath it.
   * Its item is dropped, and the rejection is pre-marked as handled (see D1).
   */
  private rejectProducerClosed(waiter: ProducerWaiter<T>): void {
    const error = new Error('Queue is closed');
    const item = waiter.item;
    waiter.settled = true;
    waiter.item = undefined as T; // Help GC
    AsyncQueue.detach(waiter);
    waiter.reject(error);
    waiter.promise.catch(NOOP);
    this.reportDropped(error, item);
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
   *
   * @param options Optional `{ signal }` to cancel the call while it is blocked,
   *                see {@link AbortOptions}
   */
  enqueue(item: T, options?: AbortOptions): Promise<void> {
    // Prevent new items after close() to ensure clean shutdown
    if (this.closed) {
      return this.rejectEnqueue(new Error('Queue is closed'), item);
    }

    // DIRECT HANDOFF: a consumer is already waiting, so skip the buffer entirely
    // and give it the item. A consumer can only be waiting while count === 0, so
    // this preserves FIFO. It is also the only way an abandoned-but-live waiter
    // cannot silently stall a queue that is otherwise making progress.
    const consumer = this.popConsumer();
    if (consumer !== undefined) {
      this.settleConsumer(consumer, item);
      return RESOLVED;
    }

    // FAST PATH: space available, no suspension, no extra promise allocation.
    if (this.count < this.maxSize) {
      this.addToBuffer(item);
      return RESOLVED;
    }

    // BLOCKING PATH: backpressure. The item rides along inside the waiter and is
    // inserted by whoever frees a slot; see takeFromBuffer().
    const signal = options?.signal;
    if (signal !== undefined && signal.aborted) {
      return Promise.reject(abortReason(signal));
    }
    return this.pushProducer(item, signal).promise;
  }

  /**
   * Removes and returns the oldest item from the queue. Blocks if the queue is empty.
   *
   * @param options Optional `{ signal }` to cancel the call while it is blocked,
   *                see {@link AbortOptions}
   * @returns A promise that resolves to the item, or `undefined` if the queue is
   *          closed and empty
   *
   * **`undefined` is ambiguous here.** It means either "the stream ended" or "the
   * next item genuinely is `undefined`". If `T` can be `undefined`, use
   * {@link dequeueResult} instead — every other consumer entry point
   * (`for await`, {@link drain}, {@link take}) already does.
   *
   * There is no re-check loop any more: a suspended consumer is handed its item
   * directly, so it cannot wake up to find that another consumer got there first.
   */
  async dequeue(options?: AbortOptions): Promise<T | undefined> {
    // Remove and get the oldest item from circular buffer (FIFO order)
    if (this.count > 0) {
      return this.takeFromBuffer();
    }
    // Nothing buffered and nothing more coming: end of stream.
    if (this.closed) {
      return undefined;
    }

    const signal = options?.signal;
    if (signal !== undefined && signal.aborted) {
      throw abortReason(signal);
    }

    const result = await this.pushConsumer(signal).promise;
    return result.done ? undefined : result.value;
  }

  /**
   * Removes and returns the oldest item, distinguishing "end of stream" from a
   * payload that happens to be `undefined`. Blocks if the queue is empty.
   *
   * @param options Optional `{ signal }` to cancel the call while it is blocked,
   *                see {@link AbortOptions}
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
  async dequeueResult(options?: AbortOptions): Promise<DequeueResult<T>> {
    if (this.count > 0) {
      return { done: false, value: this.takeFromBuffer() };
    }
    if (this.closed) {
      return DONE;
    }

    const signal = options?.signal;
    if (signal !== undefined && signal.aborted) {
      throw abortReason(signal);
    }

    return this.pushConsumer(signal).promise;
  }

  /**
   * Signals that no more items will be added to the queue.
   * Existing items can still be consumed.
   */
  close(): void {
    // Idempotent. After the first call no new waiter can be created: enqueue()
    // and both dequeue paths check `closed` before they suspend, and close() is
    // synchronous, so nothing can interleave.
    if (this.closed) {
      return;
    }

    // Signal that no more items will be added
    // Existing items can still be consumed
    this.closed = true;

    // Release ALL waiting consumers with end-of-stream
    // This allows graceful shutdown where all consumers exit cleanly
    for (;;) {
      const consumer = this.popConsumer();
      if (consumer === undefined) break;
      this.settleConsumerDone(consumer);
    }

    // Reject ALL waiting producers - their items are dropped
    // This prevents deadlock where producers wait forever
    for (;;) {
      const producer = this.popProducer();
      if (producer === undefined) break;
      this.rejectProducerClosed(producer);
    }
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
  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this.createCursor();
  }

  /**
   * Builds one independent cursor over the queue.
   *
   * Hand-written rather than an `async function*`, and deliberately shaped to
   * satisfy `AsyncGenerator<T>` as well as `AsyncIterableIterator<T>` so that
   * *every* iteration entry point on this class shares it. A real async
   * generator queues `return()`/`throw()` requests and cannot process them
   * while suspended at an `await`, so an abandoned generator parked inside
   * dequeue() stays parked until the queue closes — worker-pool teardown
   * deadlocks. Owning the waiter directly lets return()/throw() cancel it
   * synchronously.
   */
  private createCursor(): AsyncGenerator<T> {
    const queue = this;
    let finished = false;
    let pending: ConsumerWaiter<T> | null = null;

    const release = (): void => {
      finished = true;
      if (pending !== null) {
        const waiter = pending;
        pending = null;
        queue.cancelConsumer(waiter);
      }
    };

    const cursor: AsyncGenerator<T> = {
      [Symbol.asyncIterator](): AsyncGenerator<T> {
        return cursor;
      },

      next(): Promise<IteratorResult<T>> {
        if (finished) {
          return Promise.resolve(ITERATOR_DONE);
        }
        // Read `count` directly, not dequeue(): an item whose value is
        // `undefined` must not be mistaken for the end of the stream.
        if (queue.count > 0) {
          return Promise.resolve({ done: false, value: queue.takeFromBuffer() });
        }
        if (queue.closed) {
          finished = true;
          return Promise.resolve(ITERATOR_DONE);
        }

        const waiter = queue.pushConsumer(undefined);
        pending = waiter;
        return waiter.promise.then((result): IteratorResult<T> => {
          if (pending === waiter) {
            pending = null;
          }
          if (result.done) {
            finished = true;
            return ITERATOR_DONE;
          }
          return { done: false, value: result.value };
        });
      },

      // `value` is resolved rather than passed through, because a real
      // generator's return() awaits a thenable argument before completing.
      return(value?: unknown): Promise<IteratorResult<T>> {
        release();
        return Promise.resolve(value).then(
          (resolved): IteratorResult<T> => ({ done: true, value: resolved } as IteratorReturnResult<unknown>)
        );
      },

      throw(error?: unknown): Promise<IteratorResult<T>> {
        release();
        return Promise.reject(error);
      },

      // Explicit resource management: `await using cursor = queue.iterate()...`
      // releases the parked waiter on scope exit, which is the same teardown
      // path as return() and the reason D7 is fixable at all.
      [ASYNC_DISPOSE](): Promise<void> {
        release();
        return Promise.resolve();
      }
    };

    return cursor;
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
   *
   * This is **not** an `async function*`. It used to be, and that alone
   * re-created the deadlock the hand-written iterator exists to avoid: a real
   * async generator services `return()` from a request queue, and a generator
   * suspended at an `await` (here, inside the delegated `yield*`) cannot reach
   * that queue. `generator.return()` on a cursor parked in an empty queue
   * therefore never settled, and only `close()` released it — so tearing down a
   * pool of generator-based workers without closing the shared queue hung
   * forever. It now returns the same hand-written cursor as `for await`.
   *
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
   *
   * // Teardown without closing the queue:
   * await generator.return(undefined);   // settles immediately
   * ```
   */
  toAsyncGenerator(): AsyncGenerator<T> {
    return this.createCursor();
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