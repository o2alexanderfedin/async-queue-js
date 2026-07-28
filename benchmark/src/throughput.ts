/**
 * AsyncQueue throughput and latency benchmark.
 *
 * Every queue is constructed in `setup`, outside the timed region — the old
 * harness allocated one inside it, so the headline "ops/sec" was substantially
 * a measure of `new Array(128)`. See ./harness.ts for the rest of what changed.
 *
 * Run: npm run benchmark
 */

import { AsyncQueue } from '../../src/index';
import { Bench, printReport, type Report } from './harness';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Cycles per timed sample.
 *
 * Sized so one sample runs for roughly 10-20ms — long enough to span many V8
 * scavenges, so their cost averages out inside the sample instead of splitting
 * the distribution into "sample with a GC in it" and "sample without". That,
 * plus the sample count, is what holds the relative margin of error inside the
 * 5% publication limit.
 */
const FAST_CYCLES = 250_000;
/** Paths that suspend a caller cost more per op, so fewer cycles per sample. */
const BLOCKING_CYCLES = 100_000;
/** Burst batch size, and the number of whole batches per sample. */
const BURST_BATCH = 1024;
const BURST_BATCHES = Math.floor(BLOCKING_CYCLES / BURST_BATCH);

async function main(): Promise<void> {
  // 100 samples, not 50. At 50 the marginal cases (`concurrent 1P/1C` and
  // `4P/1C`) crossed the 5% RME limit on roughly one run in two depending on
  // what else the machine was doing, which makes the suite's own verdict
  // unreliable. RME shrinks as 1/sqrt(samples), so doubling buys ~1.4x.
  const bench = new Bench({ warmup: 20, samples: 100 });

  console.log('=== AsyncQueue throughput ===\n');

  // ---------------------------------------------------------------- fast path

  // Buffer has room and an item at all times: neither side ever suspends.
  await bench.add({
    name: 'cycle, buffered (no suspend)',
    opsPerIteration: FAST_CYCLES * 2,
    setup: () => new AsyncQueue<number>(1024),
    run: async queue => {
      for (let i = 0; i < FAST_CYCLES; i++) {
        await queue.enqueue(i);
        await queue.dequeue();
      }
    }
  });

  await bench.add({
    name: 'enqueue only (filling buffer)',
    opsPerIteration: FAST_CYCLES,
    setup: () => new AsyncQueue<number>(FAST_CYCLES),
    run: async queue => {
      for (let i = 0; i < FAST_CYCLES; i++) {
        await queue.enqueue(i);
      }
    }
  });

  await bench.add({
    name: 'dequeue only (pre-filled)',
    opsPerIteration: FAST_CYCLES,
    setup: async () => {
      const queue = new AsyncQueue<number>(FAST_CYCLES);
      for (let i = 0; i < FAST_CYCLES; i++) {
        await queue.enqueue(i);
      }
      return queue;
    },
    run: async queue => {
      for (let i = 0; i < FAST_CYCLES; i++) {
        await queue.dequeue();
      }
    }
  });

  // ------------------------------------------------- handoff vs via-the-buffer

  // These two exist as a matched pair. They move one item through an empty
  // queue with one await on each side; the only difference is whether a
  // consumer was already parked when the producer arrived. That is exactly the
  // "Direct Handoff" optimisation, and the only way to put a number on it.

  await bench.add({
    name: 'handoff, consumer parked first',
    opsPerIteration: BLOCKING_CYCLES * 2,
    setup: () => new AsyncQueue<number>(1),
    run: async queue => {
      for (let i = 0; i < BLOCKING_CYCLES; i++) {
        const pending = queue.dequeue(); // parks: queue is empty
        await queue.enqueue(i); // hands straight to the parked consumer
        await pending;
      }
    }
  });

  await bench.add({
    name: 'via buffer, no consumer waiting',
    opsPerIteration: BLOCKING_CYCLES * 2,
    setup: () => new AsyncQueue<number>(1),
    run: async queue => {
      for (let i = 0; i < BLOCKING_CYCLES; i++) {
        await queue.enqueue(i); // into the buffer
        await queue.dequeue(); // straight back out
      }
    }
  });

  // -------------------------------------------------------- concurrent shapes

  await bench.add({
    name: 'concurrent 1P/1C, buffer=1024',
    opsPerIteration: BLOCKING_CYCLES * 2,
    setup: () => new AsyncQueue<number>(1024),
    run: async queue => {
      await Promise.all([produce(queue, BLOCKING_CYCLES), consume(queue, BLOCKING_CYCLES)]);
    }
  });

  await bench.add({
    name: 'concurrent 1P/1C, buffer=1',
    opsPerIteration: BLOCKING_CYCLES * 2,
    setup: () => new AsyncQueue<number>(1),
    run: async queue => {
      await Promise.all([produce(queue, BLOCKING_CYCLES), consume(queue, BLOCKING_CYCLES)]);
    }
  });

  await bench.add({
    name: 'concurrent 4P/1C, buffer=16',
    opsPerIteration: BLOCKING_CYCLES * 2,
    setup: () => new AsyncQueue<number>(16),
    run: async queue => {
      const perProducer = BLOCKING_CYCLES / 4;
      await Promise.all([
        ...Array.from({ length: 4 }, () => produce(queue, perProducer)),
        consume(queue, BLOCKING_CYCLES)
      ]);
    }
  });

  await bench.add({
    name: 'concurrent 1P/4C, buffer=16',
    opsPerIteration: BLOCKING_CYCLES * 2,
    setup: () => new AsyncQueue<number>(16),
    run: async queue => {
      const perConsumer = BLOCKING_CYCLES / 4;
      await Promise.all([
        produce(queue, BLOCKING_CYCLES),
        ...Array.from({ length: 4 }, () => consume(queue, perConsumer))
      ]);
    }
  });

  // A burst: every enqueue is issued before anything is awaited, so the queue
  // takes the whole batch at once and the producers that do not fit suspend.
  await bench.add({
    name: `burst ${BURST_BATCH} in / ${BURST_BATCH} out`,
    opsPerIteration: BURST_BATCHES * BURST_BATCH * 2,
    setup: () => new AsyncQueue<number>(BURST_BATCH),
    run: async queue => {
      for (let batch = 0; batch < BURST_BATCHES; batch++) {
        const enqueued: Promise<void>[] = [];
        for (let i = 0; i < BURST_BATCH; i++) enqueued.push(queue.enqueue(i));
        const dequeued: Promise<number | undefined>[] = [];
        for (let i = 0; i < BURST_BATCH; i++) dequeued.push(queue.dequeue());
        await Promise.all([...enqueued, ...dequeued]);
      }
    }
  });

  // ------------------------------------------------------------ buffer sizes

  // The O(1) claim: cost per operation must not move with capacity.
  for (const capacity of [1, 10, 100, 1_000, 10_000]) {
    await bench.add({
      name: `cycle, buffer=${capacity.toLocaleString()}`,
      opsPerIteration: FAST_CYCLES * 2,
      setup: () => new AsyncQueue<number>(capacity),
      run: async queue => {
        for (let i = 0; i < FAST_CYCLES; i++) {
          await queue.enqueue(i);
          await queue.dequeue();
        }
      }
    });
  }

  const report = bench.report();
  printReport(report, 'AsyncQueue throughput');
  writeResults(report);
}

async function produce(queue: AsyncQueue<number>, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await queue.enqueue(i);
  }
}

async function consume(queue: AsyncQueue<number>, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await queue.dequeue();
  }
}

/**
 * Writes the run to JSON so the published report is generated from measured
 * numbers. The report generator used to carry a hard-coded sample block, which
 * is where the README's "647K ops/sec" badge came from — a figure nothing had
 * ever measured.
 */
function writeResults(report: Report): void {
  const dir = path.resolve(__dirname, '../../benchmark-results');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'throughput.json');
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`Results written to ${path.relative(process.cwd(), file)}\n`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
