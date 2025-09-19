import { AsyncQueue } from '../src/index';
import { AsyncQueueCSharpStyle } from '../src/async-queue-csharp-style';
import { AsyncQueueCSharpOptimized } from '../src/async-queue-csharp-optimized';

describe('Performance Optimization Benchmark', () => {
  const OPERATIONS = 1000;

  test('should compare all three implementations', async () => {
    console.log('\n' + '='.repeat(70));
    console.log('           ASYNCQUEUE IMPLEMENTATION BENCHMARK');
    console.log('='.repeat(70));

    // Prepare queues
    const ourQueue = new AsyncQueue<number>(1000);
    const csharpQueue = new AsyncQueueCSharpStyle<number>();
    const optimizedQueue = new AsyncQueueCSharpOptimized<number>();

    // Test 1: Sequential Operations
    console.log('\n1. SEQUENTIAL OPERATIONS (Enqueue then Dequeue)');
    console.log('   Operations: ' + OPERATIONS.toLocaleString());
    console.log('   ' + '-'.repeat(45));

    // Our implementation
    let start = process.hrtime.bigint();
    for (let i = 0; i < OPERATIONS; i++) {
      await ourQueue.enqueue(i);
    }
    for (let i = 0; i < OPERATIONS; i++) {
      await ourQueue.dequeue();
    }
    let end = process.hrtime.bigint();
    const ourTime = Number(end - start) / 1_000_000; // Convert to ms

    // Original C# style
    start = process.hrtime.bigint();
    for (let i = 0; i < OPERATIONS; i++) {
      csharpQueue.enqueue(i);
    }
    for (let i = 0; i < OPERATIONS; i++) {
      await csharpQueue.dequeueAsync();
    }
    end = process.hrtime.bigint();
    const csharpTime = Number(end - start) / 1_000_000;

    // Optimized C# style
    start = process.hrtime.bigint();
    for (let i = 0; i < OPERATIONS; i++) {
      optimizedQueue.enqueue(i);
    }
    for (let i = 0; i < OPERATIONS; i++) {
      await optimizedQueue.dequeueAsync();
    }
    end = process.hrtime.bigint();
    const optimizedTime = Number(end - start) / 1_000_000;

    console.log(`   Our AsyncQueue:        ${ourTime.toFixed(2)}ms (${Math.round(OPERATIONS * 2 / (ourTime / 1000)).toLocaleString()} ops/sec)`);
    console.log(`   C# Style (Original):   ${csharpTime.toFixed(2)}ms (${Math.round(OPERATIONS * 2 / (csharpTime / 1000)).toLocaleString()} ops/sec)`);
    console.log(`   C# Style (Optimized):  ${optimizedTime.toFixed(2)}ms (${Math.round(OPERATIONS * 2 / (optimizedTime / 1000)).toLocaleString()} ops/sec)`);
    console.log(`\n   Optimization Impact:`);
    console.log(`   • vs Original: ${(csharpTime / optimizedTime).toFixed(2)}x faster`);
    console.log(`   • vs Our impl: ${(ourTime / optimizedTime).toFixed(2)}x ${optimizedTime < ourTime ? 'faster' : 'slower'}`);

    // Test 2: Concurrent Producer-Consumer
    console.log('\n2. CONCURRENT PRODUCER-CONSUMER');
    console.log('   Operations: ' + OPERATIONS.toLocaleString() + ' × 2');
    console.log('   ' + '-'.repeat(45));

    const ourQueue2 = new AsyncQueue<number>(100);
    const csharpQueue2 = new AsyncQueueCSharpStyle<number>();
    const optimizedQueue2 = new AsyncQueueCSharpOptimized<number>();

    // Our implementation
    start = process.hrtime.bigint();
    await Promise.all([
      (async () => {
        for (let i = 0; i < OPERATIONS; i++) {
          await ourQueue2.enqueue(i);
        }
      })(),
      (async () => {
        for (let i = 0; i < OPERATIONS; i++) {
          await ourQueue2.dequeue();
        }
      })()
    ]);
    end = process.hrtime.bigint();
    const ourConcurrent = Number(end - start) / 1_000_000;

    // Original C# style
    start = process.hrtime.bigint();
    await Promise.all([
      (async () => {
        for (let i = 0; i < OPERATIONS; i++) {
          csharpQueue2.enqueue(i);
        }
      })(),
      (async () => {
        for (let i = 0; i < OPERATIONS; i++) {
          await csharpQueue2.dequeueAsync();
        }
      })()
    ]);
    end = process.hrtime.bigint();
    const csharpConcurrent = Number(end - start) / 1_000_000;

    // Optimized C# style
    start = process.hrtime.bigint();
    await Promise.all([
      (async () => {
        for (let i = 0; i < OPERATIONS; i++) {
          optimizedQueue2.enqueue(i);
        }
      })(),
      (async () => {
        for (let i = 0; i < OPERATIONS; i++) {
          await optimizedQueue2.dequeueAsync();
        }
      })()
    ]);
    end = process.hrtime.bigint();
    const optimizedConcurrent = Number(end - start) / 1_000_000;

    console.log(`   Our AsyncQueue:        ${ourConcurrent.toFixed(2)}ms (${Math.round(OPERATIONS * 2 / (ourConcurrent / 1000)).toLocaleString()} ops/sec)`);
    console.log(`   C# Style (Original):   ${csharpConcurrent.toFixed(2)}ms (${Math.round(OPERATIONS * 2 / (csharpConcurrent / 1000)).toLocaleString()} ops/sec)`);
    console.log(`   C# Style (Optimized):  ${optimizedConcurrent.toFixed(2)}ms (${Math.round(OPERATIONS * 2 / (optimizedConcurrent / 1000)).toLocaleString()} ops/sec)`);
    console.log(`\n   Optimization Impact:`);
    console.log(`   • vs Original: ${(csharpConcurrent / optimizedConcurrent).toFixed(2)}x faster`);
    console.log(`   • vs Our impl: ${(ourConcurrent / optimizedConcurrent).toFixed(2)}x ${optimizedConcurrent < ourConcurrent ? 'faster' : 'slower'}`);
  });

  test('should analyze bottlenecks and optimizations', () => {
    console.log('\n' + '='.repeat(70));
    console.log('              BOTTLENECK ANALYSIS');
    console.log('='.repeat(70));

    console.log(`
ORIGINAL C# STYLE BOTTLENECKS:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. array.shift() - O(n) operation
   • Moves all remaining elements
   • Gets worse as queue grows
   • Major bottleneck for dequeue

2. Promise allocation on fast path
   • Creates TaskCompletionSource even when item available
   • Unnecessary allocation and GC pressure

3. Queue operations with array.shift()
   • Both item and promise queues use shift()
   • Double O(n) penalty

OPTIMIZATIONS APPLIED:
━━━━━━━━━━━━━━━━━━━━━
1. Circular Buffer for Items Queue
   • O(1) dequeue instead of O(n)
   • No element shifting
   • Dynamic growth/shrink

2. Stack for Promises Queue
   • O(1) pop() instead of O(n) shift()
   • Better cache locality (LIFO)
   • Simpler implementation

3. Fast Path Optimization
   • Direct return when item available
   • No promise allocation on fast path
   • Reduces GC pressure

4. Memory Management
   • Explicit undefined assignment for GC
   • Controlled growth (2x)
   • Optional shrinking

PERFORMANCE IMPROVEMENTS:
━━━━━━━━━━━━━━━━━━━━━━━━
• Dequeue: O(n) → O(1)
• Promise ops: O(n) → O(1)
• Memory: Fewer allocations
• Cache: Better locality

REMAINING DIFFERENCES FROM OUR IMPL:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Still unbounded (no backpressure)
• Still uses TaskCompletionSource pattern
• Not power-of-2 optimized
• More complex promise management`);
  });

  test('should measure specific operation costs', async () => {
    console.log('\n' + '='.repeat(70));
    console.log('           OPERATION COST BREAKDOWN');
    console.log('='.repeat(70));

    const MICRO_OPS = 1000;

    // Measure enqueue cost when no waiters
    const csharpQueue = new AsyncQueueCSharpStyle<number>();
    const optimizedQueue = new AsyncQueueCSharpOptimized<number>();

    let start = process.hrtime.bigint();
    for (let i = 0; i < MICRO_OPS; i++) {
      csharpQueue.enqueue(i);
    }
    let end = process.hrtime.bigint();
    const csharpEnqueueNanos = Number(end - start) / MICRO_OPS;

    start = process.hrtime.bigint();
    for (let i = 0; i < MICRO_OPS; i++) {
      optimizedQueue.enqueue(i);
    }
    end = process.hrtime.bigint();
    const optimizedEnqueueNanos = Number(end - start) / MICRO_OPS;

    console.log('\nENQUEUE (no waiting consumers):');
    console.log(`  Original:  ${csharpEnqueueNanos.toFixed(1)}ns per operation`);
    console.log(`  Optimized: ${optimizedEnqueueNanos.toFixed(1)}ns per operation`);
    console.log(`  Speedup:   ${(csharpEnqueueNanos / optimizedEnqueueNanos).toFixed(2)}x`);

    // Measure dequeue cost with items available
    start = process.hrtime.bigint();
    for (let i = 0; i < MICRO_OPS; i++) {
      await csharpQueue.dequeueAsync();
    }
    end = process.hrtime.bigint();
    const csharpDequeueNanos = Number(end - start) / MICRO_OPS;

    start = process.hrtime.bigint();
    for (let i = 0; i < MICRO_OPS; i++) {
      await optimizedQueue.dequeueAsync();
    }
    end = process.hrtime.bigint();
    const optimizedDequeueNanos = Number(end - start) / MICRO_OPS;

    console.log('\nDEQUEUE (items available):');
    console.log(`  Original:  ${csharpDequeueNanos.toFixed(1)}ns per operation`);
    console.log(`  Optimized: ${optimizedDequeueNanos.toFixed(1)}ns per operation`);
    console.log(`  Speedup:   ${(csharpDequeueNanos / optimizedDequeueNanos).toFixed(2)}x`);

    // The shift() bottleneck cost
    const shiftCost = csharpDequeueNanos - optimizedDequeueNanos;
    console.log('\nARRAY.SHIFT() OVERHEAD:');
    console.log(`  Cost per operation: ${shiftCost.toFixed(1)}ns`);
    console.log(`  At 1M ops/sec: ${(shiftCost * 1000).toFixed(0)}μs overhead`);
    console.log(`  At 10M ops/sec: ${(shiftCost * 10000 / 1000).toFixed(0)}ms overhead`);
  });
});