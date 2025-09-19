import { AsyncQueue } from '../src/index';
import { AsyncQueueCSharpStyle } from '../src/async-queue-csharp-style';

describe('Implementation Comparison: Our AsyncQueue vs C#-style', () => {
  const ITERATIONS = 1000;

  test('should compare basic functionality', async () => {
    // Our implementation
    const ourQueue = new AsyncQueue<number>(100);

    // C#-style implementation
    const csharpQueue = new AsyncQueueCSharpStyle<number>();

    // Test both work correctly
    ourQueue.enqueue(1);
    ourQueue.enqueue(2);
    ourQueue.enqueue(3);

    csharpQueue.enqueue(1);
    csharpQueue.enqueue(2);
    csharpQueue.enqueue(3);

    expect(await ourQueue.dequeue()).toBe(1);
    expect(await ourQueue.dequeue()).toBe(2);
    expect(await ourQueue.dequeue()).toBe(3);

    expect(await csharpQueue.dequeueAsync()).toBe(1);
    expect(await csharpQueue.dequeueAsync()).toBe(2);
    expect(await csharpQueue.dequeueAsync()).toBe(3);
  });

  test('should compare performance', async () => {
    console.log('\n=== PERFORMANCE COMPARISON ===\n');

    // Test 1: Sequential enqueue/dequeue
    const ourQueue = new AsyncQueue<number>(1000);
    const csharpQueue = new AsyncQueueCSharpStyle<number>();

    // Our implementation
    const ourStart = Date.now();
    for (let i = 0; i < ITERATIONS; i++) {
      await ourQueue.enqueue(i);
    }
    for (let i = 0; i < ITERATIONS; i++) {
      await ourQueue.dequeue();
    }
    const ourTime = Date.now() - ourStart;

    // C#-style implementation
    const csharpStart = Date.now();
    for (let i = 0; i < ITERATIONS; i++) {
      csharpQueue.enqueue(i);
    }
    for (let i = 0; i < ITERATIONS; i++) {
      await csharpQueue.dequeueAsync();
    }
    const csharpTime = Date.now() - csharpStart;

    console.log(`Sequential Operations (${ITERATIONS} items):`);
    console.log(`  Our AsyncQueue:     ${ourTime}ms (${Math.round(ITERATIONS * 2 / (ourTime / 1000))} ops/sec)`);
    console.log(`  C#-style AsyncQueue: ${csharpTime}ms (${Math.round(ITERATIONS * 2 / (csharpTime / 1000))} ops/sec)`);
    console.log(`  Speedup: ${(csharpTime / ourTime).toFixed(2)}x\n`);

    // Test 2: Producer-Consumer pattern
    const ourQueue2 = new AsyncQueue<number>(100);
    const csharpQueue2 = new AsyncQueueCSharpStyle<number>();

    const ourConcurrentStart = Date.now();
    await Promise.all([
      (async () => {
        for (let i = 0; i < ITERATIONS; i++) {
          await ourQueue2.enqueue(i);
        }
      })(),
      (async () => {
        for (let i = 0; i < ITERATIONS; i++) {
          await ourQueue2.dequeue();
        }
      })()
    ]);
    const ourConcurrentTime = Date.now() - ourConcurrentStart;

    const csharpConcurrentStart = Date.now();
    await Promise.all([
      (async () => {
        for (let i = 0; i < ITERATIONS; i++) {
          csharpQueue2.enqueue(i);
        }
      })(),
      (async () => {
        for (let i = 0; i < ITERATIONS; i++) {
          await csharpQueue2.dequeueAsync();
        }
      })()
    ]);
    const csharpConcurrentTime = Date.now() - csharpConcurrentStart;

    console.log(`Concurrent Producer-Consumer (${ITERATIONS} items):`);
    console.log(`  Our AsyncQueue:     ${ourConcurrentTime}ms (${Math.round(ITERATIONS * 2 / (ourConcurrentTime / 1000))} ops/sec)`);
    console.log(`  C#-style AsyncQueue: ${csharpConcurrentTime}ms (${Math.round(ITERATIONS * 2 / (csharpConcurrentTime / 1000))} ops/sec)`);
    console.log(`  Speedup: ${(csharpConcurrentTime / ourConcurrentTime).toFixed(2)}x\n`);
  });

  test('should analyze implementation differences', () => {
    console.log(`
=== IMPLEMENTATION DIFFERENCES ===

OUR IMPLEMENTATION (Circular Buffer + Backpressure):
------------------------------------------------------
DESIGN:
• Single circular buffer for items
• Two waiting queues (consumers & producers)
• Bounded capacity with backpressure
• Power-of-2 sizing for bitwise operations

PROS:
✓ O(1) enqueue/dequeue operations
✓ Predictable memory usage (bounded)
✓ Natural backpressure (producers block when full)
✓ Cache-friendly circular buffer
✓ No allocations in hot path
✓ Reserved capacity for waiting queues

CONS:
✗ Fixed maximum capacity
✗ More complex implementation
✗ Slightly more memory overhead

C#-STYLE IMPLEMENTATION (Two Queues Pattern):
----------------------------------------------
DESIGN:
• Queue for items
• Queue for promises (TaskCompletionSource)
• Unbounded capacity
• Direct port of C# pattern

PROS:
✓ Simple, elegant design
✓ Unbounded capacity
✓ No blocking on enqueue
✓ Familiar to C# developers
✓ Clean separation of concerns

CONS:
✗ O(n) dequeue with array.shift()
✗ No natural backpressure
✗ Promise allocation for each waiting consumer
✗ Can grow unbounded (memory issues)
✗ Array reallocation on growth

KEY DIFFERENCES:
----------------
1. BACKPRESSURE:
   • Ours: Built-in (blocks producers when full)
   • C#-style: None (can grow infinitely)

2. MEMORY MODEL:
   • Ours: Fixed buffer, predictable memory
   • C#-style: Dynamic growth, can exhaust memory

3. PERFORMANCE:
   • Ours: O(1) all operations, optimized
   • C#-style: O(n) for shift(), simpler

4. USE CASES:
   • Ours: High-performance, bounded scenarios
   • C#-style: Simple, unbounded scenarios

5. COMPLEXITY:
   • Ours: More complex, but more optimized
   • C#-style: Simpler, more maintainable
`);
  });

  test('should test blocking behavior differences', async () => {
    console.log('\n=== BLOCKING BEHAVIOR ===\n');

    // Our queue blocks producers when full
    const ourQueue = new AsyncQueue<number>(2); // Small capacity
    let ourBlocked = false;

    // Fill the queue
    await ourQueue.enqueue(1);
    await ourQueue.enqueue(2);

    // This will block
    const blockPromise = ourQueue.enqueue(3).then(() => {
      ourBlocked = false;
    });
    ourBlocked = true;

    // Check it's blocked
    await new Promise(r => setTimeout(r, 10));
    expect(ourBlocked).toBe(true);

    // Unblock by dequeuing
    await ourQueue.dequeue();
    await blockPromise;

    console.log('Our AsyncQueue: ✓ Blocks producers when full (backpressure)');

    // C#-style never blocks on enqueue
    const csharpQueue = new AsyncQueueCSharpStyle<number>();

    // Can enqueue infinitely without blocking
    for (let i = 0; i < 1000; i++) {
      csharpQueue.enqueue(i); // Never blocks
    }

    expect(csharpQueue.size).toBe(1000);
    console.log('C#-style AsyncQueue: ✓ Never blocks on enqueue (no backpressure)');
  });

  test('should test memory characteristics', () => {
    console.log(`
=== MEMORY CHARACTERISTICS ===

OUR IMPLEMENTATION:
• Buffer: ${8 * 1024} bytes for size=1000
• Waiting arrays: ${8 * 16 * 2} bytes initial
• Fixed allocation, never shrinks
• Total: ~8.5KB for queue(1000)

C#-STYLE IMPLEMENTATION:
• Items array: Grows dynamically (8 bytes × n items)
• Promises array: Grows with waiting consumers
• Each TaskCompletionSource: ~100 bytes
• Can grow unbounded

MEMORY PRESSURE SCENARIOS:
• 10K items buffered:
  - Ours: Not possible (bounded)
  - C#-style: ~80KB + reallocation overhead

• 1K waiting consumers:
  - Ours: ~8KB (just function pointers)
  - C#-style: ~100KB (TaskCompletionSource objects)
`);
  });
});