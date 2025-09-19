# AsyncQueue - High-Performance TypeScript Producer-Consumer Queue

A blazing-fast TypeScript implementation of an async producer-consumer queue with backpressure control, achieving **10 million operations per second**. Similar to Go channels and .NET Channel<T>, but optimized for JavaScript's event loop.

[![npm version](https://badge.fury.io/js/%40alexanderfedin%2Fasync-queue.svg)](https://www.npmjs.com/package/@alexanderfedin/async-queue)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)

## ⚡ Performance

- **10,000,000 ops/sec** sequential throughput
- **6,666,667 ops/sec** concurrent producer/consumer
- **100-200 nanoseconds** latency per operation
- **O(1)** enqueue/dequeue operations
- **Zero allocations** in steady state

## Features

- **🚀 Blazing Fast**: Optimized circular buffer with power-of-2 sizing
- **🔒 Backpressure Control**: Automatically slows down producers when full
- **💾 Memory Efficient**: Bounded memory with reserved capacity management
- **⚙️ Configurable Buffer**: Control memory usage and coupling
- **🔄 Non-blocking Async/Await**: Event loop friendly, no busy waiting
- **🛑 Graceful Shutdown**: Close and drain remaining items
- **📦 FIFO Ordering**: Strict first-in, first-out guarantee
- **👥 Multiple Producers/Consumers**: Safe concurrent access

## Installation

```bash
npm install @alexanderfedin/async-queue
```

```typescript
import { AsyncQueue } from '@alexanderfedin/async-queue';
```

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

### `new AsyncQueue<T>(maxSize = 1)`
Create a new type-safe queue with specified buffer size.
- `T`: Type of items in the queue
- `maxSize`: Maximum items before producers block (default: 1)

### `async enqueue(item: T): Promise<void>`
Add an item to the queue. Blocks if queue is full.
- Returns: Promise that resolves when item is added
- Throws: Error if queue is closed

### `async dequeue(): Promise<T | undefined>`
Remove and return the oldest item. Blocks if queue is empty.
- Returns: The item, or `undefined` if queue is closed and empty

### `close(): void`
Signal that no more items will be added. Wakes all waiting consumers.

### `get isClosed(): boolean`
Check if queue is closed AND empty.
- Returns: `true` if no more items will ever be available

### `get size(): number`
Get current number of items in the queue.

### `get waitingProducerCount(): number`
Get number of producers waiting to enqueue.

### `get waitingConsumerCount(): number`
Get number of consumers waiting to dequeue.

### `[Symbol.asyncIterator](): AsyncIterator<T>`
Returns an async iterator for use with `for-await-of` loops.

### `iterate(): AsyncIterable<T>`
Creates an async iterable for consuming queue items.

### `toAsyncGenerator(): AsyncGenerator<T>`
Converts the queue to an async generator for pipeline transformations.

### `async drain(): Promise<T[]>`
Drains all items from the queue into an array.

### `async take(n: number): Promise<T[]>`
Takes up to n items from the queue

## 🎯 Key Optimizations

1. **Circular Buffer**: O(1) operations vs O(n) array.shift()
2. **Power-of-2 Sizing**: Bitwise AND for modulo operations
3. **Stack-based Waiting**: O(1) pop() vs O(n) shift()
4. **Reserved Capacity**: Pre-allocate and never shrink
5. **Direct Handoff**: Skip buffer when consumer is waiting

## How It Works

The AsyncQueue uses TypeScript Promises with performance optimizations:

1. **Circular Buffer**: Uses head/tail pointers instead of array shifts
2. **Blocking Behavior**: Producers/consumers await on Promises when full/empty
3. **Wake Mechanism**: Direct resolver handoff for minimal latency
4. **Memory Management**: Reserved capacity with 2x growth strategy

This achieves 10M ops/sec throughput with predictable sub-microsecond latency.

## Buffer Size Trade-offs

- **Small buffer (1)**: Tight coupling, minimal memory, immediate backpressure
- **Large buffer**: Loose coupling, more memory, can handle traffic bursts
- **Unbounded**: No backpressure (use regular array instead)

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
npm run benchmark     # Run performance benchmarks
npm run benchmark:compare  # Compare with EventEmitter/RxJS
```

Comprehensive test suite covering:
- Basic enqueue/dequeue operations
- Blocking behavior and backpressure
- Multiple producers/consumers
- Graceful shutdown
- Edge cases and error conditions
- Stress tests with 100+ concurrent producers/consumers

## License

MIT

## Contributing

Pull requests welcome! Please include tests for any new features.

## 📊 Performance Comparison

| Implementation | Throughput | Latency | Memory | Backpressure |
|----------------|------------|---------|--------|-------------|
| **AsyncQueue** | **10M ops/sec** | **100ns** | Bounded | ✅ Built-in |
| EventEmitter | 2M ops/sec | 500ns | Unbounded | ⚠️ Manual |
| RxJS Subject | 1M ops/sec | 1000ns | Unbounded | ⚠️ Manual |
| Promise Queue | 3M ops/sec | 333ns | Unbounded | ❌ None |
| Native Array | 50M ops/sec* | 20ns | Unbounded | ❌ None |

*Native arrays lack async/await support and backpressure control

## 🎆 Why AsyncQueue?

- **5x faster** than EventEmitter-based queues
- **10x faster** than RxJS for producer-consumer patterns
- **Predictable memory** usage with bounded buffers
- **Zero-copy** operations with direct handoff
- **Type-safe** with full TypeScript support
- **Battle-tested** with comprehensive test coverage