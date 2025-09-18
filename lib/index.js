// AsyncQueue implementation (similar to .NET's Channel<T>)
// Provides a thread-safe producer-consumer queue with backpressure control
class AsyncQueue {
  constructor(maxSize = 1) {  // Buffer only 1 chunk by default
    // Maximum items the queue can hold before producers block
    // Small buffers (1) = tight coupling, low memory, immediate backpressure
    // Large buffers = loose coupling, more memory, delayed backpressure
    this.maxSize = maxSize

    // The actual FIFO queue storing items
    this.queue = []

    // Array of resolve functions from Promises of consumers waiting for items
    // When empty, consumers create a Promise and store its resolve here
    this.waitingConsumers = []

    // Array of resolve functions from Promises of producers waiting for space
    // When full, producers create a Promise and store its resolve here
    this.waitingProducers = []

    // Signals no more items will be enqueued (graceful shutdown)
    this.closed = false
  }

  async enqueue(item) {
    // Prevent new items after close() to ensure clean shutdown
    if (this.closed) {
      throw new Error('Queue is closed')
    }

    // BLOCKING MECHANISM: Wait if queue is at capacity
    // This implements backpressure - fast producers slow down to match consumers
    while (this.queue.length >= this.maxSize && !this.closed) {
      // Create unresolved Promise, store only the resolve function
      // This suspends the producer until a consumer makes space
      await new Promise(resolve => this.waitingProducers.push(resolve))

      // Check again after waking - queue might have been closed while waiting
      if (this.closed) {
        throw new Error('Queue is closed')
      }
    }

    // Add item to queue (we now have space)
    this.queue.push(item)

    // WAKE MECHANISM: If any consumer is waiting for an item, wake ONE
    // This ensures FIFO ordering - first waiting consumer gets the item
    if (this.waitingConsumers.length > 0) {
      const consumer = this.waitingConsumers.shift()
      consumer()  // Calling resolve() wakes the awaiting consumer
    }
  }

  async dequeue() {
    // BLOCKING MECHANISM: Wait if queue is empty
    // Consumers block here until producers provide items or queue closes
    while (this.queue.length === 0 && !this.closed) {
      // Create unresolved Promise, store only the resolve function
      // This suspends the consumer until a producer adds an item
      await new Promise(resolve => this.waitingConsumers.push(resolve))
    }

    // After waking/looping, check if we exited due to close (not an item)
    // Return undefined to signal "end of stream" to consumers
    if (this.queue.length === 0 && this.closed) {
      return undefined
    }

    // Remove and get the oldest item (FIFO order)
    const item = this.queue.shift()

    // WAKE MECHANISM: If any producer is waiting for space, wake ONE
    // This allows the blocked producer to add its item
    if (this.waitingProducers.length > 0) {
      const producer = this.waitingProducers.shift()
      producer()  // Calling resolve() wakes the awaiting producer
    }

    return item
  }

  close() {
    // Signal that no more items will be added
    // Existing items can still be consumed
    this.closed = true

    // Wake ALL waiting consumers - they'll return undefined
    // This allows graceful shutdown where all consumers exit cleanly
    this.waitingConsumers.forEach(resolve => resolve())

    // Wake ALL waiting producers - they'll throw an error
    // This prevents deadlock where producers wait forever
    this.waitingProducers.forEach(resolve => resolve())
  }

  get isClosed() {
    // Queue is "fully closed" only when closed AND empty
    // This allows consumers to drain remaining items after close()
    return this.closed && this.queue.length === 0
  }
}

module.exports = AsyncQueue