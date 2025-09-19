import { AsyncQueue } from '../src/index';

async function runPerformanceAnalysis() {
  console.log(`
═══════════════════════════════════════════════════════════════
           ASYNCQUEUE PERFORMANCE ANALYSIS
═══════════════════════════════════════════════════════════════`);

  // Test 1: Raw throughput
  const queue1 = new AsyncQueue<number>(1000);
  const OPS = 10000;

  // Pre-fill for dequeue test
  for (let i = 0; i < OPS; i++) {
    await queue1.enqueue(i);
  }

  // Measure dequeue
  const dequeueStart = Date.now();
  for (let i = 0; i < OPS; i++) {
    await queue1.dequeue();
  }
  const dequeueTime = Date.now() - dequeueStart;

  // Measure enqueue
  const enqueueStart = Date.now();
  for (let i = 0; i < OPS; i++) {
    await queue1.enqueue(i);
  }
  const enqueueTime = Date.now() - enqueueStart;

  console.log(`
1. SINGLE OPERATION TIMING (Non-blocking)
   ----------------------------------------
   Operations tested: ${OPS.toLocaleString()}

   ENQUEUE (buffer has space):
   • Total time: ${enqueueTime}ms
   • Per operation: ${((enqueueTime * 1000) / OPS).toFixed(2)}μs (microseconds)
   • Throughput: ${Math.round(OPS / (enqueueTime / 1000)).toLocaleString()} ops/sec

   DEQUEUE (items available):
   • Total time: ${dequeueTime}ms
   • Per operation: ${((dequeueTime * 1000) / OPS).toFixed(2)}μs (microseconds)
   • Throughput: ${Math.round(OPS / (dequeueTime / 1000)).toLocaleString()} ops/sec`);

  // Test 2: Concurrent producer/consumer
  const queue2 = new AsyncQueue<number>(100);
  const CONCURRENT_OPS = 50000;

  const concurrentStart = Date.now();
  await Promise.all([
    // Producer
    (async () => {
      for (let i = 0; i < CONCURRENT_OPS; i++) {
        await queue2.enqueue(i);
      }
    })(),
    // Consumer
    (async () => {
      for (let i = 0; i < CONCURRENT_OPS; i++) {
        await queue2.dequeue();
      }
    })()
  ]);
  const concurrentTime = Date.now() - concurrentStart;

  console.log(`
2. CONCURRENT PRODUCER-CONSUMER
   ----------------------------------------
   Total operations: ${(CONCURRENT_OPS * 2).toLocaleString()}
   Buffer size: 100

   • Total time: ${concurrentTime}ms
   • Combined throughput: ${Math.round((CONCURRENT_OPS * 2) / (concurrentTime / 1000)).toLocaleString()} ops/sec
   • Per operation: ${((concurrentTime * 1000) / (CONCURRENT_OPS * 2)).toFixed(2)}μs`);

  console.log(`
3. CPU OPERATIONS BREAKDOWN (Estimated)
   ----------------------------------------

   NON-BLOCKING ENQUEUE:
   1. if (this.closed)                    → 1 comparison
   2. while (this.count >= this.maxSize)  → 1 comparison
   3. this.buffer[this.tail] = item       → 1 memory write
   4. this.tail = (this.tail + 1) & mask  → 2 ops (add + AND)
   5. this.count++                        → 1 increment
   6. if (this.waitingConsumersCount > 0) → 1 comparison
   ─────────────────────────────────────────────────────
   TOTAL: ~7 CPU operations

   NON-BLOCKING DEQUEUE:
   1. while (this.count === 0)            → 1 comparison
   2. if (this.count === 0 && closed)     → 2 comparisons
   3. const item = this.buffer[this.head] → 1 memory read
   4. this.buffer[this.head] = undefined  → 1 memory write
   5. this.head = (this.head + 1) & mask  → 2 ops (add + AND)
   6. this.count--                        → 1 decrement
   7. if (this.waitingProducersCount > 0) → 1 comparison
   ─────────────────────────────────────────────────────
   TOTAL: ~9 CPU operations`);

  console.log(`
4. MEMORY CHARACTERISTICS
   ----------------------------------------

   PER QUEUE INSTANCE:
   • Circular buffer: ${8 * 1024} bytes (for size=1000)
   • Waiting arrays: ${8 * 16 * 2} bytes (initial capacity)
   • Instance vars: ~64 bytes
   • Total: ~${8 * 1024 + 8 * 16 * 2 + 64} bytes

   CACHE BEHAVIOR:
   • Circular buffer: Sequential access (L1 cache friendly)
   • Waiting queues: Stack access (top elements in cache)
   • No allocations in hot path (no GC pressure)

5. OPTIMIZATIONS APPLIED
   ----------------------------------------

   ✓ Circular buffer → O(1) instead of O(n) array.shift()
   ✓ Power-of-2 sizing → Bitwise AND instead of modulo
   ✓ Stack-based waiting → O(1) pop() instead of O(n) shift()
   ✓ Reserved capacity → No reallocation for typical usage
   ✓ Explicit undefined → Helps garbage collector

═══════════════════════════════════════════════════════════════`);

  // Modern CPU reference
  console.log(`
PERFORMANCE IN CONTEXT:
----------------------------------------
Modern CPU (3 GHz) = 3 billion cycles/sec
• 1 cycle ≈ 0.33 nanoseconds
• Our operation: ~${((enqueueTime * 1000000) / OPS).toFixed(0)} nanoseconds
• Estimated cycles: ~${((enqueueTime * 1000000 * 3) / OPS).toFixed(0)} cycles per operation

This includes:
- JavaScript engine overhead
- async/await promise machinery
- Event loop scheduling
- Actual queue operations (~7-9 CPU ops)

Raw queue ops probably take <10 cycles.
Most time is JavaScript/async overhead.`);
}

runPerformanceAnalysis().catch(console.error);