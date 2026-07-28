# AsyncQueue - High-Performance TypeScript Producer-Consumer Queue

**Developed by AI Hive® at [O2.services](https://o2.services)**

A TypeScript async producer-consumer queue with backpressure control. Similar to
Go channels and .NET `Channel<T>`, but built for JavaScript's event loop:
strict FIFO for items *and* for blocked callers, a bounded circular buffer, and
cancellation via `AbortSignal`.

Measured at **26.7 million queue operations per second** — 37.4ns per operation
at the median — on the machine recorded in
[docs/PERFORMANCE.md](./docs/PERFORMANCE.md). Absolute numbers do not transfer
between machines; run `npm run benchmark` on yours.

📊 [Performance Metrics](./docs/PERFORMANCE.md) | 📚 [API Documentation](#api) | 🧪 [Examples](./examples/) | 📦 [NPM Package](https://www.npmjs.com/package/@alexanderfedin/async-queue)

[![npm version](https://badge.fury.io/js/%40alexanderfedin%2Fasync-queue.svg)](https://www.npmjs.com/package/@alexanderfedin/async-queue)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)
[![Test Report](https://img.shields.io/badge/Tests-192%20passing-brightgreen)](https://o2alexanderfedin.github.io/async-queue-js/test-report.html)
[![Coverage](https://img.shields.io/badge/Coverage-96.2%25-brightgreen)](https://o2alexanderfedin.github.io/async-queue-js/coverage/)
[![Benchmark](https://img.shields.io/badge/Performance-26.7M%20ops%2Fsec-blue)](https://o2alexanderfedin.github.io/async-queue-js/benchmark-report.html)

## 📊 Live Reports

View our comprehensive test, coverage, and performance reports:

- 🧪 **[Test Report](https://o2alexanderfedin.github.io/async-queue-js/test-report.html)** - 192 tests passing (182 without the stress suite)
- 📈 **[Coverage Report](https://o2alexanderfedin.github.io/async-queue-js/coverage/)** - 96.2% of statements, 91.2% of branches
- ⚡ **[Benchmark Report](https://o2alexanderfedin.github.io/async-queue-js/benchmark-report.html)** - Performance metrics and comparisons
- 📝 **[All Reports Dashboard](https://o2alexanderfedin.github.io/async-queue-js/)** - Central hub for all project metrics

## ⚡ Performance

Measured on an Apple M1 Pro (8 cores, 32 GiB, macOS 26.5.2, Node v23.11.0),
100 samples per case, figures per queue operation:

| | ops/sec | p50 | p99 |
|---|--------:|----:|----:|
| enqueue+dequeue cycle, buffer=1024 | 26,713,207 | 37.4ns | 40.2ns |
| 1 producer / 1 consumer, buffer=1024 | 24,303,182 | 41.1ns | 46.9ns |
| 4 producers / 1 consumer, buffer=16 | 16,795,079 | 59.5ns | 100.4ns |
| item handed to a parked consumer | 12,346,251 | 81.0ns | 144.1ns |

- **O(1) per operation** — cost is flat from `maxSize=1` to `maxSize=10,000`
  (44.3ns → 45.2ns, a 2% spread across four orders of magnitude)
- **Bounded steady-state heap** — 1,000,000 messages through an `AsyncQueue(1024)`
  move the retained heap by 168.7 KiB. Retention is bounded by `maxSize`, not by
  traffic. It is *not* allocation-free: the async interface costs ~444 bytes of
  collectable garbage per message
- **Memory is O(maxSize) at construction** — the circular buffer is allocated up
  front at 8 bytes per slot, rounded up to a power of two. An empty
  `AsyncQueue(10_000)` is 128.2 KiB; an empty `AsyncQueue(10_000_000)` is 128 MiB

Run them yourself: `npm run benchmark:all`. Absolute figures are hardware- and
runtime-specific and will not match on your machine.

→ 📈 [Full analysis, method, and what these numbers replaced](./docs/PERFORMANCE.md)

## Features

- **🚀 Fast**: 26.7M operations/sec measured, circular buffer with power-of-2 sizing
- **🔒 Backpressure Control**: Automatically slows down producers when full
- **💾 Bounded Memory**: the buffer is fixed at construction, and waiter storage is released as waiters leave — a burst of blocked callers costs ~305 bytes each while blocked and nothing once it is over
- **⚙️ Configurable Buffer**: Control memory usage and coupling
- **🔄 Non-blocking Async/Await**: Event loop friendly, no busy waiting
- **🛑 Graceful Shutdown**: Close and drain remaining items
- **📦 FIFO Ordering**: Strict first-in, first-out, for items *and* for blocked callers — the longest-waiting producer or consumer is always the next one served, so no caller can be starved. Pinned by `test/fifo-claim.test.ts`, not just asserted here
- **👥 Multiple Producers/Consumers**: Safe concurrent access

## Installation

```bash
npm install @alexanderfedin/async-queue
```

```typescript
import { AsyncQueue } from '@alexanderfedin/async-queue';
```

### Module formats

The package ships **both** an ES module and a CommonJS build behind an `exports`
map, so it works from either side without a bundler shim. Requires Node 16+.

```typescript
// ESM — resolves to dist/esm
import { AsyncQueue, QueueClosedError } from '@alexanderfedin/async-queue';

// CommonJS — resolves to dist/cjs
const { AsyncQueue, QueueClosedError } = require('@alexanderfedin/async-queue');
```

Prefer the **named** export. There is also a default export (`import AsyncQueue
from '@alexanderfedin/async-queue'`) kept for compatibility; before v2 it
type-checked but threw `TypeError: AsyncQueue is not a constructor` at runtime in
ESM, because the package had no ESM build. It is a real constructor now.

`.` and `./package.json` are the only public subpaths — reaching into `dist/`
directly is not supported. TypeScript declarations resolve under every
`moduleResolution` setting, including `nodenext`, and `src/index.ts` is published
so declaration maps resolve and "go to definition" lands on real source.

## Usage

### Basic Example

```typescript
import { AsyncQueue } from '@alexanderfedin/async-queue';

const queue = new AsyncQueue<string>() // Default buffer size of 1

// Producer
async function producer() {
  for (let i = 0; i < 5; i++) {
    await queue.enqueue(`item-${i}`);
    console.log(`Produced: item-${i}`);
  }
  queue.close();
}

// Consumer
async function consumer() {
  while (!queue.isClosed) {
    const item = await queue.dequeue();
    if (item !== undefined) {
      console.log(`Consumed: ${item}`);
    }
  }
}

// Run both concurrently
Promise.all([producer(), consumer()]);
```

### Backpressure Example

```typescript
const queue = new AsyncQueue<number>(2); // Buffer only 2 items

// Fast producer
async function fastProducer() {
  for (let i = 0; i < 1000; i++) {
    await queue.enqueue(i); // Will block when queue is full
    // Producer automatically slows to match consumer speed
  }
}

// Slow consumer
async function slowConsumer() {
  while (true) {
    const item = await queue.dequeue();
    if (item === undefined) break;

    await processSlowly(item); // Takes 100ms
    // Producer won't overflow memory
  }
}
```

### Multiple Producers/Consumers

```typescript
const queue = new AsyncQueue<Data>(5);

// Launch multiple producers
for (let i = 0; i < 3; i++) {
  produceData(queue, `P${i}`);
}

// Launch multiple consumers
for (let i = 0; i < 2; i++) {
  consumeData(queue, `C${i}`);
}
```

#### Detached producers must catch

`close()` rejects every producer that is blocked at that moment. The queue suppresses that rejection on the promise **it** returns, so `void queue.enqueue(x)` can never crash your process. But it cannot reach a promise it did not create — if you detach an `async` wrapper, the rejection lands on *your* promise:

```typescript
// SAFE — the queue owns and guards this promise
void queue.enqueue(item);

// UNSAFE — the rejection surfaces on produceData()'s own promise
produceData(queue, 'P0');

// SAFE — you own it, so you handle it
void produceData(queue, 'P0').catch(err => {
  if (!(err instanceof QueueClosedError)) throw err;
  console.warn('undelivered:', err.item);   // the exact payload that was refused
});
```

### Async Iterator Pattern

```typescript
const queue = new AsyncQueue<string>();

// Producer
setTimeout(async () => {
  for (const item of ['hello', 'async', 'world']) {
    await queue.enqueue(item);
  }
  queue.close();
}, 0);

// Consumer using for-await-of
for await (const item of queue) {
  console.log(item); // hello, async, world
}
```

### Stream Processing Pipeline

```typescript
const queue = new AsyncQueue<number>();

// Transform pipeline
async function* double(source: AsyncIterable<number>) {
  for await (const item of source) {
    yield item * 2;
  }
}

// Process items through pipeline
for await (const result of double(queue)) {
  console.log(result);
}
```

## API

### `new AsyncQueue<T>(maxSize = 1, options?)`
Create a new type-safe queue with specified buffer size.
- `T`: Type of items in the queue
- `maxSize`: Maximum items before producers block (default: 1)
- `options.onDropped?: (error: QueueClosedError<T>, item: T) => void`: notified whenever an `enqueue()` is rejected, i.e. whenever an item is dropped because the queue was or became closed

`maxSize` is validated and normalised:

| Input | Result |
|-------|--------|
| `NaN`, non-number | `TypeError` |
| `< 1` | `Error('maxSize must be at least 1')` |
| non-integer (`2.5`) | rounded **up** (`3`) |
| `> 2^30`, `Infinity` | clamped to `AsyncQueue.MAX_CAPACITY` (`2^30`) |

`capacity` reports the normalised value, not the request. The queue is bounded by construction — there is no unbounded mode.

### `enqueue(item: T, options?): Promise<void>`
Add an item to the queue. Blocks if queue is full.
- `options.signal?: AbortSignal`: cancels the call **if it has to block**. Rejects with `signal.reason` (or an `AbortError`), and the item is guaranteed never to enter the queue.
- Returns: Promise that resolves when item is added
- Rejects with a [`QueueClosedError`](#queueclosederrort) if the queue is or becomes closed. **The error carries the item that was refused**, as `err.item`, so a producer can retry it elsewhere.

**This promise is never reported as an unhandled rejection.** `close()` rejects every blocked producer, and a fire-and-forget producer (`void queue.enqueue(x)`) has no handler attached — on Node ≥ 15 that would terminate the process, once per blocked producer. The queue marks its own rejections as handled when it creates them. Awaiting or `.catch()`ing still observes the error exactly as before; the consequence is that an unobserved dropped item is now *silent* rather than *fatal*. Use `onDropped` to observe drops globally.

### `dequeue(options?): Promise<T | undefined>`
Remove and return the oldest item. Blocks if queue is empty.
- `options.signal?: AbortSignal`: cancels the call if it has to block. A cancelled consumer is removed from the queue and can never absorb an item.
- Returns: The item, or `undefined` if queue is closed and empty

⚠️ **`undefined` is ambiguous here** — it means either "end of stream" or "the next item genuinely is `undefined`". If `T` can be `undefined`, use `dequeueResult()`.

### `dequeueResult(options?): Promise<DequeueResult<T>>`
Same as `dequeue()`, but tells the two cases apart.

```typescript
type DequeueResult<T> =
  | { done: true;  value: undefined }   // closed and drained
  | { done: false; value: T };          // a payload — may itself be undefined

const result = await queue.dequeueResult();
if (result.done) return;      // stream really ended
handle(result.value);         // may legitimately be undefined
```

`for await`, `drain()` and `take()` all use this internally, so they round-trip `undefined` payloads correctly.

### Cancelling a blocked call

`Promise.race([queue.dequeue(), timeout])` does **not** cancel anything — the queue is never told you walked away, so the waiter stays in line. Pass a signal instead:

```typescript
const controller = new AbortController();
setTimeout(() => controller.abort(), 1000);

try {
  const item = await queue.dequeue({ signal: controller.signal });
} catch (err) {
  if ((err as Error).name === 'AbortError') { /* timed out, no item was consumed */ }
}
```

### `close(): T[]`
Signal that no more items will be added. Releases all waiting consumers with end-of-stream, and rejects all blocked producers. Idempotent.

**Returns the items of every producer that was blocked at that moment, in FIFO order.** Those items never entered the queue and never will, so returning them is what makes the loss recoverable rather than merely observable — without it, at-least-once delivery cannot be built on top of the queue. Buffered items are *not* returned: they are not lost, and a consumer can still drain them after `close()`.

```typescript
const undelivered = queue.close();
for (const item of undelivered) {
  await backupQueue.enqueue(item);   // nothing is silently lost
}
```

A repeat `close()` returns `[]`. A producer cancelled by its own `AbortSignal` is *not* included — its caller already received `AbortError` and knows what it lost.

### `QueueClosedError<T>`
The rejection reason for any `enqueue()` the queue refuses, whether the caller enqueued after `close()` or was blocked when `close()` arrived.

```typescript
try {
  await queue.enqueue(job);
} catch (err) {
  if (err instanceof QueueClosedError) {
    await deadLetterQueue.enqueue(err.item);   // the exact payload that was refused
  } else {
    throw err;
  }
}
```

It extends `Error`, `message` is still exactly `'Queue is closed'`, and `name` is `'QueueClosedError'` — existing `err.message === 'Queue is closed'` checks keep working unchanged.

The same loss is reachable three ways — `err.item`, the `onDropped` hook, and `close()`'s return value. They always report the same items; pick whichever the shutdown path can actually see. The producer's own `catch` is the only one that knows the surrounding context; `close()`'s return value is the only one available to code that owns the queue rather than the producers.

### `get isClosed(): boolean`
Check if queue is closed AND empty.
- Returns: `true` if no more items will ever be available

### `get size(): number`
Get current number of items in the queue.

### `get waitingProducerCount(): number`
Get number of producers waiting to enqueue.

### `get waitingConsumerCount(): number`
Get number of consumers waiting to dequeue.

### `[Symbol.asyncIterator](): AsyncIterableIterator<T>`
Returns an async iterator for use with `for-await-of` loops. Calling `return()` on it — which `break` does automatically — releases a suspended `next()` immediately, without waiting for `close()`.

### `iterate(): AsyncIterable<T>`
Creates an async iterable for consuming queue items.

### `toAsyncGenerator(): AsyncGenerator<T>`
Converts the queue to an async generator for pipeline transformations. Returns the same hand-written cursor as `for await`, so `return()` releases a suspended `next()` immediately here too — see below.

### Tearing down a consumer without closing the queue

Every iteration entry point (`for await`, `iterate()`, `toAsyncGenerator()`) returns a cursor that owns its waiter directly rather than being an `async function*`. That matters for shutdown: a real async generator services `return()` from an internal request queue and cannot reach it while suspended at an `await`, so a generator parked on an empty queue would stay parked until something *else* released it — in practice, only `close()`. Tearing down a pool of workers over a shared queue therefore deadlocked.

```typescript
const workers = Array.from({ length: 8 }, () => queue.toAsyncGenerator());
// ...
await Promise.all(workers.map(w => w.return(undefined)));   // settles immediately
// the queue is untouched and still usable by a fresh pool
```

`break` out of a `for await` does this automatically. On runtimes with `Symbol.asyncDispose` (Node ≥ 20), `await using` works too.

### `async drain(): Promise<T[]>`
Drains all items from the queue into an array.

### `async take(n: number): Promise<T[]>`
Takes up to n items from the queue

## 🎯 Key Optimizations

1. **Circular Buffer**: O(1) operations vs O(n) array.shift()
2. **Power-of-2 Sizing**: Bitwise AND for modulo operations
3. **FIFO Waiter Lists**: intrusive doubly-linked lists, O(1) push, pop *and* removal-from-the-middle — no `shift()`, and unlike a stack they cannot starve the longest-waiting caller
4. **No Waiter Backing Store**: the list pointers live on the waiter record that has to exist anyway, so being queued costs no allocation and a burst of blocked callers is fully released once it passes
5. **Direct Handoff**: when a consumer is already parked, `enqueue()` hands it the item without touching the buffer. This is a **correctness** mechanism, not a speed-up: the transfer and the unlinking happen in one synchronous step, so the longest-waiting consumer cannot be overtaken. Measured, it is *slower* per operation than the buffered path (81.0ns vs 41.8ns), because the cost is the suspension, not the buffer write. Earlier versions of this document claimed it was 2x faster; [that was wrong](./docs/PERFORMANCE.md#direct-handoff-what-it-is-and-what-it-is-not)

## How It Works

The AsyncQueue uses TypeScript Promises with performance optimizations:

1. **Circular Buffer**: Uses head/tail pointers instead of array shifts
2. **Blocking Behavior**: Producers/consumers await on Promises when full/empty
3. **Wake Mechanism**: the item travels *with* the waiter, so a woken caller never re-reads shared state and never loses a race to a later arrival
4. **Memory Management**: the item buffer is bounded and allocated at construction; waiter storage is per-waiter and released on departure, so nothing is retained at the concurrency high-water mark

Measured p50 latency is 37-46ns per operation on the non-blocking paths and
79-81ns when a caller has to suspend. See [docs/PERFORMANCE.md](./docs/PERFORMANCE.md).

## Buffer Size Trade-offs

Throughput barely moves with capacity — 44.3ns/op at `maxSize=1` against
45.2ns/op at `maxSize=10,000` — so size the buffer for coupling and memory, not
for speed.

- **Small buffer (1)**: tight coupling, immediate backpressure, ~250 bytes
- **Large buffer**: loose coupling, absorbs bursts, **8 bytes per slot allocated
  up front** and rounded up to a power of two — `new AsyncQueue(10_000)` reserves
  16,384 slots and costs 128.2 KiB before a single item is enqueued
- **Unbounded**: not supported. The queue is bounded by construction; anything
  above `2^30` is clamped

## Use Cases

- **Stream Processing**: Process data chunks with controlled memory usage
- **Rate Limiting**: Naturally limit processing speed to sustainable levels
- **Work Distribution**: Distribute tasks among worker pools
- **Event Handling**: Serialize concurrent events with overflow protection
- **Pipeline Stages**: Connect processing stages with automatic flow control

## Testing

```bash
npm test              # Run unit tests
npm run test:stress   # Run stress tests
npm run test:coverage # Generate coverage report
```

### Benchmarks

```bash
npm run benchmark          # throughput and latency, by queue shape and buffer size
npm run benchmark:compare  # against EventEmitter-, Promise- and callback-based queues
npm run benchmark:memory   # empty-queue footprint, retention, garbage per message
npm run benchmark:all      # all three
```

Each writes JSON to `benchmark-results/`, records the machine it ran on, reports
p50/p90/p99 rather than a bare mean, and refuses to publish any case whose 95%
relative margin of error exceeds 5% — it prints `UNSTABLE` instead.

192 tests covering:
- Basic enqueue/dequeue operations
- Blocking behavior and backpressure
- Multiple producers/consumers
- Graceful shutdown, and recovering the items a `close()` refused
- Cancellation via `AbortSignal`, including cancelling from the middle of a waiter queue
- Strict FIFO under contention, and starvation-freedom (`test/fifo-claim.test.ts`, `test/fairness.test.ts`)
- The published package itself — `test/packaging.test.ts` plus `npm run verify:packaging`
- Edge cases and error conditions
- Stress tests with 100+ concurrent producers/consumers

## License

MIT

## Contributing

Pull requests welcome! Please include tests for any new features.

## 📊 Performance Comparison

`npm run benchmark:compare`, 250 samples per case, all implementations
constructed outside the timed region and measured by the same harness. Sequential
enqueue+dequeue, buffer=100:

| Implementation | ops/sec | p50 | Memory | Backpressure |
|----------------|--------:|----:|--------|--------------|
| **AsyncQueue** | **26,966,593** | **37.1ns** | Bounded by `maxSize` | ✅ Built-in |
| Callback queue | 18,133,599 | 55.1ns | Unbounded | ❌ None |
| Promise queue | 15,785,008 | 63.4ns | Unbounded | ❌ None |
| EventEmitter queue | 12,565,510 | 79.6ns | Unbounded | ⚠️ Manual |
| Native array | 56,084,889 | 17.8ns | Unbounded | ❌ None |

The native array is a floor, not a competitor — it cannot block, wait, or apply
backpressure. The gap to it (~19ns/op) is what the async interface costs.

RxJS is not in the table. The script that was supposed to measure it imported a
package that is not a dependency, so it never ran; the "10x faster than RxJS"
figure the docs used to carry was never measured.

## 🎆 Why AsyncQueue?

- **~2x faster** than an EventEmitter-based queue (2.15x sequential, 1.79x
  concurrent; 1.93x-2.19x across runs — the EventEmitter implementation is the
  noisiest thing in the comparison)
- **1.7x faster** than a promise-array queue, **1.5x** than a callback queue
- **Bounded memory**: retention is fixed by `maxSize` and does not grow with
  traffic — 1,000,000 messages move the retained heap by 168.7 KiB
- **Strict FIFO** for items *and* for blocked callers, pinned by tests
  (`test/fifo-claim.test.ts`), so no producer or consumer can be starved
- **Cancellable**: `AbortSignal` on both `enqueue()` and `dequeue()`
- **Type-safe** with full TypeScript support, ESM and CommonJS builds
- **192 tests**, 96.2% statement coverage

## 📖 Documentation

- [Performance Analysis](./docs/PERFORMANCE.md) - Detailed benchmarks and metrics
- [Benchmark Libraries](./docs/BENCHMARK-LIBRARIES.md) - Comparison of JS benchmark tools
- [Publishing Guide](./PUBLISHING.md) - How to publish updates to NPM
- [Examples](./examples/) - Working code examples
  - [Basic Usage](./examples/basic.ts)
  - [Backpressure Demo](./examples/backpressure.ts)
  - [Multiple Workers](./examples/multiple-workers.ts)
  - [Async Iterator Patterns](./examples/async-iterator.ts)

## 👥 Credits

**Developed by [AI Hive®](https://o2.services)** at O2.services

AI Hive® is an advanced AI development team specializing in high-performance, production-ready code generation and optimization.

## 📄 License

MIT License - see [LICENSE](./LICENSE) file

---

*Built with ❤️ by AI Hive® at [O2.services](https://o2.services)*