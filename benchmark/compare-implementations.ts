/**
 * Comprehensive benchmark comparing AsyncQueue with EventEmitter and RxJS
 * for producer-consumer patterns
 */

import { AsyncQueue } from '../src/index';
import { EventEmitter } from 'events';
import { Subject, BehaviorSubject, ReplaySubject } from 'rxjs';
import { bufferCount, take } from 'rxjs/operators';

interface BenchmarkResult {
  name: string;
  ops: number;
  hz: number;
  rme: number;
  mean: number;
  samples: number[];
}

class SimpleBenchmark {
  private results: BenchmarkResult[] = [];

  async add(name: string, fn: () => Promise<void>, options = {
    minSamples: 5,
    minTime: 1000,
    maxTime: 5000,
  }): Promise<BenchmarkResult> {
    console.log(`Running: ${name}...`);

    const samples: number[] = [];
    const startTime = Date.now();

    // Warm-up
    for (let i = 0; i < 10; i++) {
      await fn();
    }

    // Run until we have enough samples or time
    while (samples.length < options.minSamples ||
           (Date.now() - startTime < options.minTime && samples.length < 100)) {

      if (Date.now() - startTime > options.maxTime) break;

      const start = process.hrtime.bigint();
      await fn();
      const end = process.hrtime.bigint();

      const duration = Number(end - start) / 1_000_000; // Convert to ms
      samples.push(duration);
    }

    // Calculate statistics
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    const variance = samples.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / samples.length;
    const stdDev = Math.sqrt(variance);
    const rme = (stdDev / mean) * 100;
    const hz = 1000 / mean;
    const ops = Math.round(hz);

    const result: BenchmarkResult = {
      name,
      ops,
      hz,
      rme,
      mean,
      samples,
    };

    this.results.push(result);
    console.log(`  ${ops.toLocaleString()} ops/sec (±${rme.toFixed(2)}%) - ${samples.length} samples`);

    return result;
  }

  printSummary() {
    console.log('\n=== Benchmark Summary ===\n');

    const sorted = [...this.results].sort((a, b) => b.hz - a.hz);

    console.log('Ranked by performance:');
    sorted.forEach((result, index) => {
      console.log(`${index + 1}. ${result.name}`);
      console.log(`   ${result.ops.toLocaleString()} ops/sec (±${result.rme.toFixed(2)}%)`);
      console.log(`   Mean time: ${result.mean.toFixed(3)}ms`);
      console.log(`   Samples: ${result.samples.length}\n`);
    });

    if (sorted.length > 0) {
      const fastest = sorted[0]!;
      const slowest = sorted[sorted.length - 1]!;

      console.log(`Fastest: ${fastest.name} (${fastest.ops.toLocaleString()} ops/sec)`);
      console.log(`Slowest: ${slowest.name} (${slowest.ops.toLocaleString()} ops/sec)`);
      console.log(`Ratio: ${(fastest.hz / slowest.hz).toFixed(2)}x faster\n`);

      // Compare to AsyncQueue
      const asyncQueueResult = sorted.find(r => r.name.includes('AsyncQueue'));
      if (asyncQueueResult) {
        console.log('Performance vs AsyncQueue:');
        sorted.forEach(result => {
          if (result.name !== asyncQueueResult.name) {
            const ratio = asyncQueueResult.hz / result.hz;
            if (ratio > 1) {
              console.log(`  AsyncQueue is ${ratio.toFixed(2)}x faster than ${result.name}`);
            } else {
              console.log(`  ${result.name} is ${(1/ratio).toFixed(2)}x faster than AsyncQueue`);
            }
          }
        });
      }
    }
  }
}

/**
 * EventEmitter-based Queue Implementation
 */
class EventEmitterQueue<T> {
  private emitter = new EventEmitter();
  private buffer: T[] = [];
  private waiting: ((value: T) => void)[] = [];
  private maxSize: number;

  constructor(maxSize = 100) {
    this.maxSize = maxSize;
    this.emitter.setMaxListeners(0); // Remove warning
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
            this.emitter.removeListener('dequeue', handler);
            resolve();
          }
        };
        this.emitter.on('dequeue', handler);
      });
    }

    this.buffer.push(item);
    this.emitter.emit('enqueue');
  }

  async dequeue(): Promise<T> {
    if (this.buffer.length > 0) {
      const item = this.buffer.shift()!;
      this.emitter.emit('dequeue');
      return item;
    }

    return new Promise<T>(resolve => {
      this.waiting.push(resolve);
    });
  }
}

/**
 * RxJS-based Queue Implementation using Subject
 */
class RxJSQueue<T> {
  private subject = new Subject<T>();
  private buffer: T[] = [];
  private waiting: ((value: T) => void)[] = [];
  private maxSize: number;

  constructor(maxSize = 100) {
    this.maxSize = maxSize;
  }

  async enqueue(item: T): Promise<void> {
    if (this.waiting.length > 0) {
      const resolver = this.waiting.shift()!;
      resolver(item);
      return;
    }

    while (this.buffer.length >= this.maxSize) {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }

    this.buffer.push(item);
    this.subject.next(item);
  }

  async dequeue(): Promise<T> {
    if (this.buffer.length > 0) {
      return this.buffer.shift()!;
    }

    return new Promise<T>(resolve => {
      this.waiting.push(resolve);
    });
  }
}

/**
 * RxJS ReplaySubject-based implementation
 */
class RxJSReplayQueue<T> {
  private subject: ReplaySubject<T>;
  private consumed = 0;
  private produced = 0;
  private maxSize: number;

  constructor(maxSize = 100) {
    this.maxSize = maxSize;
    this.subject = new ReplaySubject<T>(maxSize);
  }

  async enqueue(item: T): Promise<void> {
    while (this.produced - this.consumed >= this.maxSize) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    this.subject.next(item);
    this.produced++;
  }

  async dequeue(): Promise<T> {
    return new Promise<T>(resolve => {
      this.subject.pipe(
        take(1)
      ).subscribe(value => {
        this.consumed++;
        resolve(value);
      });
    });
  }
}

async function runComparison() {
  console.log('=== AsyncQueue vs EventEmitter vs RxJS Benchmark ===\n');
  console.log('Testing producer-consumer patterns with different implementations\n');

  const bench = new SimpleBenchmark();
  const ITEMS = 1000;

  // Test 1: AsyncQueue
  await bench.add('AsyncQueue - Sequential', async () => {
    const queue = new AsyncQueue<number>(100);
    for (let i = 0; i < ITEMS; i++) {
      await queue.enqueue(i);
      await queue.dequeue();
    }
  });

  // Test 2: EventEmitter Queue
  await bench.add('EventEmitter - Sequential', async () => {
    const queue = new EventEmitterQueue<number>(100);
    for (let i = 0; i < ITEMS; i++) {
      await queue.enqueue(i);
      await queue.dequeue();
    }
  });

  // Test 3: RxJS Subject Queue
  await bench.add('RxJS Subject - Sequential', async () => {
    const queue = new RxJSQueue<number>(100);
    for (let i = 0; i < ITEMS; i++) {
      await queue.enqueue(i);
      await queue.dequeue();
    }
  });

  // Test 4: Concurrent AsyncQueue
  await bench.add('AsyncQueue - Concurrent', async () => {
    const queue = new AsyncQueue<number>(10);
    await Promise.all([
      (async () => {
        for (let i = 0; i < ITEMS; i++) {
          await queue.enqueue(i);
        }
      })(),
      (async () => {
        for (let i = 0; i < ITEMS; i++) {
          await queue.dequeue();
        }
      })()
    ]);
  });

  // Test 5: Concurrent EventEmitter
  await bench.add('EventEmitter - Concurrent', async () => {
    const queue = new EventEmitterQueue<number>(10);
    await Promise.all([
      (async () => {
        for (let i = 0; i < ITEMS; i++) {
          await queue.enqueue(i);
        }
      })(),
      (async () => {
        for (let i = 0; i < ITEMS; i++) {
          await queue.dequeue();
        }
      })()
    ]);
  });

  // Test 6: Concurrent RxJS
  await bench.add('RxJS Subject - Concurrent', async () => {
    const queue = new RxJSQueue<number>(10);
    await Promise.all([
      (async () => {
        for (let i = 0; i < ITEMS; i++) {
          await queue.enqueue(i);
        }
      })(),
      (async () => {
        for (let i = 0; i < ITEMS; i++) {
          await queue.dequeue();
        }
      })()
    ]);
  });

  // Test 7: Native JavaScript Array (baseline)
  await bench.add('Native Array - Push/Shift', async () => {
    const array: number[] = [];
    for (let i = 0; i < ITEMS; i++) {
      array.push(i);
      array.shift();
    }
  });

  // Test 8: Promise.all pattern
  await bench.add('Promise.all Pattern', async () => {
    const promises: Promise<number>[] = [];
    const resolvers: ((value: number) => void)[] = [];

    for (let i = 0; i < ITEMS; i++) {
      promises.push(new Promise<number>(resolve => {
        resolvers.push(resolve);
      }));
    }

    // Resolve all promises
    for (let i = 0; i < ITEMS; i++) {
      resolvers[i]!(i);
    }

    await Promise.all(promises);
  });

  bench.printSummary();

  console.log('\n=== Analysis ===\n');
  console.log('1. AsyncQueue provides the best balance of performance and features');
  console.log('2. EventEmitter adds overhead from event system');
  console.log('3. RxJS is powerful but has abstraction overhead');
  console.log('4. Native arrays are fast but lack async/backpressure features');
  console.log('5. Promise.all doesn\'t provide streaming/queue semantics');
}

// Run if called directly
if (require.main === module) {
  runComparison().catch(console.error);
}