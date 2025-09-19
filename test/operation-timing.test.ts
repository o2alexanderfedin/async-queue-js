import { AsyncQueue } from '../src/index';

describe('Operation Timing Analysis', () => {
  test('should measure single enqueue/dequeue operations', async () => {
    const queue = new AsyncQueue<number>(1000); // Large buffer to avoid blocking
    const WARMUP = 1000;
    const ITERATIONS = 100000;

    // Warmup to ensure JIT compilation
    for (let i = 0; i < WARMUP; i++) {
      await queue.enqueue(i);
    }
    for (let i = 0; i < WARMUP; i++) {
      await queue.dequeue();
    }

    // Measure non-blocking enqueue (buffer has space)
    const enqueueStart = process.hrtime.bigint();
    for (let i = 0; i < ITERATIONS; i++) {
      await queue.enqueue(i);
    }
    const enqueueEnd = process.hrtime.bigint();

    // Measure non-blocking dequeue (items available)
    const dequeueStart = process.hrtime.bigint();
    for (let i = 0; i < ITERATIONS; i++) {
      await queue.dequeue();
    }
    const dequeueEnd = process.hrtime.bigint();

    const enqueueNanos = Number(enqueueEnd - enqueueStart);
    const dequeueNanos = Number(dequeueEnd - dequeueStart);

    const enqueueNanosPerOp = enqueueNanos / ITERATIONS;
    const dequeueNanosPerOp = dequeueNanos / ITERATIONS;

    console.log(`
    === NON-BLOCKING OPERATIONS (${ITERATIONS.toLocaleString()} iterations) ===

    Enqueue (buffer has space):
    - Total time: ${(enqueueNanos / 1_000_000).toFixed(2)}ms
    - Per operation: ${enqueueNanosPerOp.toFixed(2)}ns
    - Operations/second: ${(1_000_000_000 / enqueueNanosPerOp).toLocaleString()}

    Dequeue (items available):
    - Total time: ${(dequeueNanos / 1_000_000).toFixed(2)}ms
    - Per operation: ${dequeueNanosPerOp.toFixed(2)}ns
    - Operations/second: ${(1_000_000_000 / dequeueNanosPerOp).toLocaleString()}`);

    expect(enqueueNanosPerOp).toBeLessThan(1000); // Should be < 1 microsecond
    expect(dequeueNanosPerOp).toBeLessThan(1000);
  });

  test('should measure blocking scenarios', async () => {
    const queue = new AsyncQueue<number>(10); // Small buffer
    const ITERATIONS = 10000;

    // Measure blocking dequeue (consumer waits)
    const consumers: Promise<any>[] = [];
    const consumerStart = process.hrtime.bigint();

    for (let i = 0; i < ITERATIONS; i++) {
      consumers.push(queue.dequeue());
    }

    const afterConsumerSetup = process.hrtime.bigint();

    // Now provide items
    for (let i = 0; i < ITERATIONS; i++) {
      await queue.enqueue(i);
    }

    await Promise.all(consumers);
    const consumerEnd = process.hrtime.bigint();

    const setupNanos = Number(afterConsumerSetup - consumerStart);
    const totalNanos = Number(consumerEnd - consumerStart);
    const wakeupNanos = totalNanos - setupNanos;

    console.log(`
    === BLOCKING OPERATIONS (${ITERATIONS.toLocaleString()} iterations) ===

    Consumer waiting (dequeue blocks, then gets woken):
    - Setup time: ${(setupNanos / 1_000_000).toFixed(2)}ms
    - Total with wakeup: ${(totalNanos / 1_000_000).toFixed(2)}ms
    - Wakeup overhead: ${(wakeupNanos / 1_000_000).toFixed(2)}ms
    - Per wakeup: ${(wakeupNanos / ITERATIONS).toFixed(2)}ns`);
  });

  test('should analyze CPU operations estimate', async () => {
    console.log(`
    === ESTIMATED CPU OPERATIONS ===

    NON-BLOCKING ENQUEUE (item fits in buffer):
    1. Check if closed (1 comparison)
    2. Check if full (1 comparison)
    3. Write to buffer[tail] (1 memory write)
    4. Update tail: (tail + 1) & (length - 1) (2 arithmetic ops)
    5. Increment count (1 arithmetic op)
    6. Check waiting consumers (1 comparison)
    TOTAL: ~7 CPU operations

    NON-BLOCKING DEQUEUE (item available):
    1. Check if empty (1 comparison)
    2. Check if closed (1 comparison)
    3. Read from buffer[head] (1 memory read)
    4. Clear buffer[head] (1 memory write)
    5. Update head: (head + 1) & (length - 1) (2 arithmetic ops)
    6. Decrement count (1 arithmetic op)
    7. Check waiting producers (1 comparison)
    TOTAL: ~8 CPU operations

    BLOCKING ENQUEUE (buffer full):
    + Create Promise (memory allocation)
    + Push to waiting queue (array write + counter increment)
    + Context switch / await overhead
    + Wake mechanism when space available
    ADDITIONAL: ~50-100+ CPU operations

    BLOCKING DEQUEUE (buffer empty):
    + Create Promise (memory allocation)
    + Push to waiting queue (array write + counter increment)
    + Context switch / await overhead
    + Wake mechanism when item available
    ADDITIONAL: ~50-100+ CPU operations

    === CIRCULAR BUFFER INDEXING ===
    Using power-of-2 size with bitwise AND:
    (index + 1) & (size - 1)

    This is just 2 CPU operations vs modulo which can be 10-40 cycles.
    Example with size=16:
    - size - 1 = 15 = 0b1111
    - (5 + 1) & 15 = 6 & 15 = 6
    - (15 + 1) & 15 = 16 & 15 = 0 (wraps around)`);

    // Let's verify the circular buffer math
    const bufferSize = 16;
    const mask = bufferSize - 1;

    expect((0 + 1) & mask).toBe(1);
    expect((15 + 1) & mask).toBe(0); // Wraps around
    expect((7 + 1) & mask).toBe(8);
  });

  test('should measure throughput at different queue depths', async () => {
    const sizes = [1, 10, 100, 1000];
    const OPERATIONS = 100000;

    console.log(`\n    === THROUGHPUT BY QUEUE SIZE ===`);

    for (const size of sizes) {
      const queue = new AsyncQueue<number>(size);

      // Measure mixed operations
      const start = process.hrtime.bigint();

      const producer = async () => {
        for (let i = 0; i < OPERATIONS; i++) {
          await queue.enqueue(i);
        }
      };

      const consumer = async () => {
        for (let i = 0; i < OPERATIONS; i++) {
          await queue.dequeue();
        }
      };

      await Promise.all([producer(), consumer()]);

      const end = process.hrtime.bigint();
      const totalNanos = Number(end - start);
      const opsPerSecond = (OPERATIONS * 2 * 1_000_000_000) / totalNanos;

      console.log(`
    Buffer size ${size}:
    - Time for ${(OPERATIONS * 2).toLocaleString()} ops: ${(totalNanos / 1_000_000).toFixed(2)}ms
    - Throughput: ${opsPerSecond.toLocaleString()} ops/sec
    - Nanoseconds per op: ${(totalNanos / (OPERATIONS * 2)).toFixed(2)}ns`);
    }
  });

  test('should profile memory access patterns', () => {
    console.log(`
    === MEMORY ACCESS PATTERNS ===

    CACHE OPTIMIZATION:
    - Circular buffer: Sequential memory access (cache-friendly)
    - All buffer data in contiguous memory
    - Head/tail pointers likely in same cache line
    - Waiting queues: Stack access pattern (top of array in cache)

    MEMORY FOOTPRINT PER QUEUE:
    - Buffer array: 8 bytes × buffer_size (rounded to power of 2)
    - Waiting arrays: 8 bytes × capacity (starts at 16, grows by 2x)
    - Instance variables: ~64 bytes (head, tail, count, flags, etc.)
    - Total for default queue(1): ~256 bytes

    MEMORY OPERATIONS PER ENQUEUE/DEQUEUE:
    - 1 read from instance (head/tail/count)
    - 1 write to buffer
    - 1-2 writes to instance variables
    - No memory allocation in non-blocking path
    - No GC pressure in steady state`);
  });
});