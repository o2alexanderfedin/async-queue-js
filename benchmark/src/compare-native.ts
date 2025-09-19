/**
 * Benchmark comparing AsyncQueue with native Node.js alternatives
 * No external dependencies required
 */

import { AsyncQueue } from '../../src/index';
import { EventEmitter } from 'events';

interface BenchmarkResult {
  name: string;
  ops: number;
  hz: number;
  mean: number;
  samples: number;
}

class Benchmark {
  private results: BenchmarkResult[] = [];

  async run(name: string, fn: () => Promise<void>, iterations = 10000): Promise<void> {
    console.log(`Testing: ${name}...`);

    // Warm-up
    for (let i = 0; i < 100; i++) {
      await fn();
    }

    // Actual benchmark
    const start = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) {
      await fn();
    }
    const end = process.hrtime.bigint();

    const totalMs = Number(end - start) / 1_000_000;
    const hz = (iterations / totalMs) * 1000;
    const ops = Math.round(hz);

    this.results.push({
      name,
      ops,
      hz,
      mean: totalMs / iterations,
      samples: iterations
    });

    console.log(`  ${ops.toLocaleString()} ops/sec (${totalMs.toFixed(2)}ms total)`);
  }

  printSummary() {
    console.log('\n=== Performance Summary ===\n');

    const sorted = [...this.results].sort((a, b) => b.hz - a.hz);

    sorted.forEach((result, index) => {
      console.log(`${index + 1}. ${result.name}: ${result.ops.toLocaleString()} ops/sec`);
    });

    if (sorted.length > 1) {
      const fastest = sorted[0]!;
      const asyncQueue = sorted.find(r => r.name.includes('AsyncQueue'));

      console.log('\n=== Relative Performance ===\n');
      sorted.forEach(result => {
        if (result !== fastest) {
          const ratio = fastest.hz / result.hz;
          console.log(`${fastest.name} is ${ratio.toFixed(1)}x faster than ${result.name}`);
        }
      });

      if (asyncQueue) {
        console.log('\n=== AsyncQueue Comparison ===\n');
        sorted.forEach(result => {
          if (result !== asyncQueue) {
            const ratio = asyncQueue.hz / result.hz;
            if (ratio > 1) {
              console.log(`AsyncQueue is ${ratio.toFixed(1)}x faster than ${result.name}`);
            } else {
              console.log(`${result.name} is ${(1/ratio).toFixed(1)}x faster than AsyncQueue`);
            }
          }
        });
      }
    }
  }
}

/**
 * EventEmitter-based Queue
 */
class EventEmitterQueue<T> {
  private emitter = new EventEmitter();
  private buffer: T[] = [];
  private waiting: ((value: T) => void)[] = [];
  private maxSize: number;

  constructor(maxSize = 100) {
    this.maxSize = maxSize;
    this.emitter.setMaxListeners(0);
  }

  async enqueue(item: T): Promise<void> {
    if (this.waiting.length > 0) {
      const resolver = this.waiting.shift()!;
      resolver(item);
      return;
    }

    while (this.buffer.length >= this.maxSize) {
      await new Promise<void>(resolve => {
        const handler = () => {
          if (this.buffer.length < this.maxSize) {
            this.emitter.removeListener('space', handler);
            resolve();
          }
        };
        this.emitter.on('space', handler);
      });
    }

    this.buffer.push(item);
  }

  async dequeue(): Promise<T> {
    if (this.buffer.length > 0) {
      const item = this.buffer.shift()!;
      this.emitter.emit('space');
      return item;
    }

    return new Promise<T>(resolve => {
      this.waiting.push(resolve);
    });
  }
}

/**
 * Promise-based Queue (using array of promises)
 */
class PromiseQueue<T> {
  private resolvers: ((value: T) => void)[] = [];
  private values: T[] = [];
  private maxSize: number;

  constructor(maxSize = 100) {
    this.maxSize = maxSize;
  }

  async enqueue(item: T): Promise<void> {
    if (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift()!;
      resolver(item);
      return;
    }

    while (this.values.length >= this.maxSize) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    this.values.push(item);
  }

  async dequeue(): Promise<T> {
    if (this.values.length > 0) {
      return this.values.shift()!;
    }

    return new Promise<T>(resolve => {
      this.resolvers.push(resolve);
    });
  }
}

/**
 * Callback-based Queue (traditional Node.js style)
 */
class CallbackQueue<T> {
  private buffer: T[] = [];
  private callbacks: ((item: T) => void)[] = [];
  private maxSize: number;

  constructor(maxSize = 100) {
    this.maxSize = maxSize;
  }

  enqueue(item: T, callback?: () => void): void {
    if (this.callbacks.length > 0) {
      const cb = this.callbacks.shift()!;
      cb(item);
      if (callback) callback();
      return;
    }

    if (this.buffer.length < this.maxSize) {
      this.buffer.push(item);
      if (callback) callback();
    } else {
      // In real implementation, would need to queue the enqueue operation
      setTimeout(() => this.enqueue(item, callback), 0);
    }
  }

  dequeue(callback: (item: T | undefined) => void): void {
    if (this.buffer.length > 0) {
      callback(this.buffer.shift());
    } else {
      this.callbacks.push(callback);
    }
  }
}

async function runBenchmarks() {
  console.log('=== AsyncQueue vs Native Node.js Alternatives ===\n');
  console.log('Testing producer-consumer patterns\n');

  const bench = new Benchmark();

  // Test sequential operations
  console.log('--- Sequential Operations (enqueue + dequeue) ---\n');

  await bench.run('AsyncQueue', async () => {
    const queue = new AsyncQueue<number>(100);
    await queue.enqueue(42);
    await queue.dequeue();
  });

  await bench.run('EventEmitter Queue', async () => {
    const queue = new EventEmitterQueue<number>(100);
    await queue.enqueue(42);
    await queue.dequeue();
  });

  await bench.run('Promise Queue', async () => {
    const queue = new PromiseQueue<number>(100);
    await queue.enqueue(42);
    await queue.dequeue();
  });

  await bench.run('Native Array', async () => {
    const array: number[] = [];
    array.push(42);
    array.shift();
  });

  await bench.run('Callback Queue', async () => {
    const queue = new CallbackQueue<number>(100);
    await new Promise<void>(resolve => {
      queue.enqueue(42, () => {
        queue.dequeue(() => resolve());
      });
    });
  });

  // Test concurrent operations
  console.log('\n--- Concurrent Producer/Consumer ---\n');

  await bench.run('AsyncQueue Concurrent', async () => {
    const queue = new AsyncQueue<number>(10);
    await Promise.all([
      (async () => {
        for (let i = 0; i < 10; i++) {
          await queue.enqueue(i);
        }
      })(),
      (async () => {
        for (let i = 0; i < 10; i++) {
          await queue.dequeue();
        }
      })()
    ]);
  }, 100);

  await bench.run('EventEmitter Concurrent', async () => {
    const queue = new EventEmitterQueue<number>(10);
    await Promise.all([
      (async () => {
        for (let i = 0; i < 10; i++) {
          await queue.enqueue(i);
        }
      })(),
      (async () => {
        for (let i = 0; i < 10; i++) {
          await queue.dequeue();
        }
      })()
    ]);
  }, 100);

  await bench.run('Promise Queue Concurrent', async () => {
    const queue = new PromiseQueue<number>(10);
    await Promise.all([
      (async () => {
        for (let i = 0; i < 10; i++) {
          await queue.enqueue(i);
        }
      })(),
      (async () => {
        for (let i = 0; i < 10; i++) {
          await queue.dequeue();
        }
      })()
    ]);
  }, 100);

  bench.printSummary();

  console.log('\n=== Key Insights ===\n');
  console.log('1. AsyncQueue optimizations:');
  console.log('   - Circular buffer (no array shifts)');
  console.log('   - Stack-based waiting queues');
  console.log('   - Direct producer-consumer handoff');
  console.log('   - Power-of-2 sizing for bitwise ops\n');

  console.log('2. EventEmitter overhead:');
  console.log('   - Event system adds indirection');
  console.log('   - Listener management overhead');
  console.log('   - Not designed for queue patterns\n');

  console.log('3. Native arrays are fast but:');
  console.log('   - No async/await support');
  console.log('   - No backpressure control');
  console.log('   - array.shift() is O(n)\n');
}

// Run benchmarks
if (require.main === module) {
  runBenchmarks().catch(console.error);
}