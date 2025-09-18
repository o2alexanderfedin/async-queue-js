# AsyncQueue - JavaScript Push-Pull Pattern

A JavaScript implementation of an async producer-consumer queue with backpressure control, similar to .NET's Channel<T> or Go channels.

## Features

- **Backpressure Control**: Automatically slows down producers when the queue is full
- **Configurable Buffer Size**: Control memory usage and coupling between producers/consumers
- **Non-blocking Async/Await**: Suspends coroutines without blocking the event loop
- **Graceful Shutdown**: Close the queue and drain remaining items
- **FIFO Ordering**: First-in, first-out guarantee
- **Multiple Producers/Consumers**: Safe concurrent access

## Installation

```bash
npm install
# or just copy async-queue.js to your project
```

## Usage

### Basic Example

```javascript
const AsyncQueue = require('./async-queue')

const queue = new AsyncQueue() // Default buffer size of 1

// Producer
async function producer() {
  for (let i = 0; i < 5; i++) {
    await queue.enqueue(`item-${i}`)
    console.log(`Produced: item-${i}`)
  }
  queue.close()
}

// Consumer
async function consumer() {
  while (!queue.isClosed) {
    const item = await queue.dequeue()
    if (item !== undefined) {
      console.log(`Consumed: ${item}`)
    }
  }
}

// Run both concurrently
Promise.all([producer(), consumer()])
```

### Backpressure Example

```javascript
const queue = new AsyncQueue(2) // Buffer only 2 items

// Fast producer
async function fastProducer() {
  for (let i = 0; i < 1000; i++) {
    await queue.enqueue(i) // Will block when queue is full
    // Producer automatically slows to match consumer speed
  }
}

// Slow consumer
async function slowConsumer() {
  while (true) {
    const item = await queue.dequeue()
    if (item === undefined) break

    await processSlowly(item) // Takes 100ms
    // Producer won't overflow memory
  }
}
```

### Multiple Producers/Consumers

```javascript
const queue = new AsyncQueue(5)

// Launch multiple producers
for (let i = 0; i < 3; i++) {
  produceData(queue, `P${i}`)
}

// Launch multiple consumers
for (let i = 0; i < 2; i++) {
  consumeData(queue, `C${i}`)
}
```

## API

### `new AsyncQueue(maxSize = 1)`
Create a new queue with specified buffer size.
- `maxSize`: Maximum items before producers block (default: 1)

### `async enqueue(item)`
Add an item to the queue. Blocks if queue is full.
- Returns: Promise that resolves when item is added
- Throws: Error if queue is closed

### `async dequeue()`
Remove and return the oldest item. Blocks if queue is empty.
- Returns: The item, or `undefined` if queue is closed and empty

### `close()`
Signal that no more items will be added. Wakes all waiting consumers.

### `get isClosed()`
Check if queue is closed AND empty.
- Returns: `true` if no more items will ever be available

## How It Works

The AsyncQueue uses JavaScript Promises to implement blocking behavior:

1. **When queue is full**: Producers await on an unresolved Promise
2. **When queue is empty**: Consumers await on an unresolved Promise
3. **Wake mechanism**: When space/items become available, waiting Promises are resolved

This creates synchronous-style blocking semantics in async code without blocking the event loop.

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
node async-queue.test.js
```

Comprehensive test suite covering:
- Basic enqueue/dequeue operations
- Blocking behavior and backpressure
- Multiple producers/consumers
- Graceful shutdown
- Edge cases and error conditions

## License

MIT

## Contributing

Pull requests welcome! Please include tests for any new features.

## Comparison with Other Patterns

| Pattern | Backpressure | Blocking | Use Case |
|---------|--------------|----------|----------|
| AsyncQueue | ✓ | ✓ | Flow control, memory safety |
| EventEmitter | ✗ | ✗ | Simple notifications |
| Streams | ✓ | ✗ | Large data processing |
| Regular Array | ✗ | ✗ | Simple buffering |

## Performance

- O(1) enqueue and dequeue operations
- Minimal memory overhead (only stores queue items + waiting Promise resolvers)
- No polling or busy-waiting
- Event loop friendly - never blocks