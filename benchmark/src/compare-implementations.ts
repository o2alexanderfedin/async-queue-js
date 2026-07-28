/**
 * AsyncQueue against the alternatives it is usually compared to.
 *
 * This is the script behind the README's "5x faster than EventEmitter" claim.
 * It did not support that claim — it printed the opposite — and it could not
 * have supported anything, because it constructed a fresh queue inside every
 * timed iteration, so what it actually compared was five constructors. It also
 * imported `rxjs`, which is not a dependency of this package, so it exited on
 * `MODULE_NOT_FOUND` before reaching a single measurement.
 *
 * What changed:
 * - every implementation is constructed in `setup`, outside the timed region;
 * - all figures are per queue operation, so cases with different iteration
 *   counts stay comparable (the native array needs far more iterations than the
 *   async implementations to produce a sample worth timing);
 * - RxJS is gone rather than left broken. Adding `rxjs` purely to benchmark
 *   against it would put a 30-package tree in devDependencies to produce one
 *   table row.
 * - the EventEmitter queue's blocking wait is a one-shot `once()` listener.
 *   The previous version re-registered a listener on every pass of its `while`
 *   loop and only ever removed the one that happened to fire, so its measured
 *   cost grew with every blocked enqueue. Comparing against that is comparing
 *   against a leak, not against EventEmitter.
 *
 * Run: npm run benchmark:compare
 */

import { AsyncQueue } from '../../src/index';
import { EventEmitter } from 'events';
import { Bench, printReport, type CaseResult, type Report } from './harness';
import * as fs from 'fs';
import * as path from 'path';

/** Cycles per sample for the async implementations. */
const CYCLES = 50_000;
/** The synchronous array baseline needs more work per sample to be timeable. */
const ARRAY_CYCLES = 2_000_000;
/** Cycles per sample for the concurrent producer/consumer shapes. */
const CONCURRENT_CYCLES = 20_000;

/** A queue built the way people build them with EventEmitter. */
class EventEmitterQueue<T> {
  private readonly emitter = new EventEmitter();
  private readonly buffer: T[] = [];
  private readonly waiting: Array<(value: T) => void> = [];

  constructor(private readonly maxSize = 100) {
    this.emitter.setMaxListeners(0);
  }

  async enqueue(item: T): Promise<void> {
    const resolver = this.waiting.shift();
    if (resolver !== undefined) {
      resolver(item);
      return;
    }
    while (this.buffer.length >= this.maxSize) {
      await new Promise<void>(resolve => this.emitter.once('dequeue', () => resolve()));
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

/** Promise-array queue: no events, polls with a macrotask when full. */
class PromiseQueue<T> {
  private readonly resolvers: Array<(value: T) => void> = [];
  private readonly values: T[] = [];

  constructor(private readonly maxSize = 100) {}

  async enqueue(item: T): Promise<void> {
    const resolver = this.resolvers.shift();
    if (resolver !== undefined) {
      resolver(item);
      return;
    }
    while (this.values.length >= this.maxSize) {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
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

/** Callback-style queue, the pre-promise Node idiom. No backpressure. */
class CallbackQueue<T> {
  private readonly buffer: T[] = [];
  private readonly callbacks: Array<(item: T) => void> = [];

  constructor(private readonly maxSize = 100) {}

  enqueue(item: T, done?: () => void): void {
    const callback = this.callbacks.shift();
    if (callback !== undefined) {
      callback(item);
      done?.();
      return;
    }
    if (this.buffer.length < this.maxSize) {
      this.buffer.push(item);
      done?.();
    } else {
      setTimeout(() => this.enqueue(item, done), 0);
    }
  }

  dequeue(callback: (item: T) => void): void {
    const item = this.buffer.shift();
    if (item !== undefined) {
      callback(item);
    } else {
      this.callbacks.push(callback);
    }
  }
}

async function main(): Promise<void> {
  // Many more samples than the throughput benchmark. The alternatives being
  // measured are noisier than AsyncQueue by construction — the Promise queue
  // parks on `setTimeout(0)`, whose macrotask timing is jittery, the callback
  // queue allocates a promise per cycle, and the EventEmitter queue's blocked
  // path runs listener dispatch plus an O(n) `shift()`. At 120 samples the
  // EventEmitter concurrent case crossed the 5% limit on some runs. RME shrinks
  // as 1/sqrt(samples), and a ratio is only as good as the worse of its two
  // operands, so the ratios are worth the extra seconds.
  const bench = new Bench({ warmup: 20, samples: 250 });

  console.log('=== AsyncQueue vs alternatives ===\n');
  console.log('-- Sequential: enqueue then dequeue, buffer=100, never blocks --\n');

  await bench.add({
    name: 'AsyncQueue',
    opsPerIteration: CYCLES * 2,
    setup: () => new AsyncQueue<number>(100),
    run: async queue => {
      for (let i = 0; i < CYCLES; i++) {
        await queue.enqueue(i);
        await queue.dequeue();
      }
    }
  });

  await bench.add({
    name: 'EventEmitter queue',
    opsPerIteration: CYCLES * 2,
    setup: () => new EventEmitterQueue<number>(100),
    run: async queue => {
      for (let i = 0; i < CYCLES; i++) {
        await queue.enqueue(i);
        await queue.dequeue();
      }
    }
  });

  await bench.add({
    name: 'Promise queue',
    opsPerIteration: CYCLES * 2,
    setup: () => new PromiseQueue<number>(100),
    run: async queue => {
      for (let i = 0; i < CYCLES; i++) {
        await queue.enqueue(i);
        await queue.dequeue();
      }
    }
  });

  await bench.add({
    name: 'Callback queue',
    opsPerIteration: CYCLES * 2,
    setup: () => new CallbackQueue<number>(100),
    run: async queue => {
      for (let i = 0; i < CYCLES; i++) {
        await new Promise<void>(resolve => {
          queue.enqueue(i, () => queue.dequeue(() => resolve()));
        });
      }
    }
  });

  await bench.add({
    name: 'Native array (no async)',
    opsPerIteration: ARRAY_CYCLES * 2,
    setup: () => [] as number[],
    run: async array => {
      for (let i = 0; i < ARRAY_CYCLES; i++) {
        array.push(i);
        array.shift();
      }
    }
  });

  console.log('\n-- Concurrent: one producer, one consumer, buffer=10 --\n');

  await bench.add({
    name: 'AsyncQueue concurrent',
    opsPerIteration: CONCURRENT_CYCLES * 2,
    setup: () => new AsyncQueue<number>(10),
    run: async queue => {
      await Promise.all([
        (async () => {
          for (let i = 0; i < CONCURRENT_CYCLES; i++) await queue.enqueue(i);
        })(),
        (async () => {
          for (let i = 0; i < CONCURRENT_CYCLES; i++) await queue.dequeue();
        })()
      ]);
    }
  });

  await bench.add({
    name: 'EventEmitter concurrent',
    opsPerIteration: CONCURRENT_CYCLES * 2,
    setup: () => new EventEmitterQueue<number>(10),
    run: async queue => {
      await Promise.all([
        (async () => {
          for (let i = 0; i < CONCURRENT_CYCLES; i++) await queue.enqueue(i);
        })(),
        (async () => {
          for (let i = 0; i < CONCURRENT_CYCLES; i++) await queue.dequeue();
        })()
      ]);
    }
  });

  await bench.add({
    name: 'Promise queue concurrent',
    opsPerIteration: CONCURRENT_CYCLES * 2,
    setup: () => new PromiseQueue<number>(10),
    run: async queue => {
      await Promise.all([
        (async () => {
          for (let i = 0; i < CONCURRENT_CYCLES; i++) await queue.enqueue(i);
        })(),
        (async () => {
          for (let i = 0; i < CONCURRENT_CYCLES; i++) await queue.dequeue();
        })()
      ]);
    }
  });

  const report = bench.report();
  printReport(report, 'AsyncQueue vs alternatives');
  printRatios(report);
  writeResults(report);
}

/**
 * Ratios against AsyncQueue, computed from the medians, and only for cases whose
 * RME was inside the publication limit. A ratio between two noisy numbers is
 * noisier than either.
 */
function printRatios(report: Report): void {
  const byName = new Map(report.cases.map(c => [c.name, c]));
  const pairs: Array<[baseline: string, contender: string]> = [
    ['AsyncQueue', 'EventEmitter queue'],
    ['AsyncQueue', 'Promise queue'],
    ['AsyncQueue', 'Callback queue'],
    ['AsyncQueue', 'Native array (no async)'],
    ['AsyncQueue concurrent', 'EventEmitter concurrent'],
    ['AsyncQueue concurrent', 'Promise queue concurrent']
  ];

  console.log('Relative to AsyncQueue (from medians):\n');
  for (const [baselineName, contenderName] of pairs) {
    const baseline = byName.get(baselineName);
    const contender = byName.get(contenderName);
    if (baseline === undefined || contender === undefined) continue;
    if (!usable(baseline) || !usable(contender)) {
      console.log(`  ${contenderName}: not reportable (RME above the limit)`);
      continue;
    }
    const ratio = contender.p50 / baseline.p50;
    const verdict =
      ratio >= 1
        ? `AsyncQueue is ${ratio.toFixed(2)}x faster`
        : `${contenderName} is ${(1 / ratio).toFixed(2)}x faster`;
    console.log(`  vs ${contenderName.padEnd(26)} ${verdict}`);
  }
  console.log('');
}

function usable(result: CaseResult): boolean {
  return result.stable;
}

function writeResults(report: Report): void {
  const dir = path.resolve(__dirname, '../../benchmark-results');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'comparison.json');
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`Results written to ${path.relative(process.cwd(), file)}\n`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
