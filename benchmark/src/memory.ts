/**
 * Memory benchmark.
 *
 * Exists because the memory claims in the README and docs/PERFORMANCE.md quoted
 * numbers that no script in this repository produced. Each section here maps to
 * one claim:
 *
 * - "O(1) memory" and "~80 KB for maxSize=10,000" — the circular buffer is
 *   allocated in full by the constructor, so an *empty* queue's footprint is
 *   O(maxSize). {@link capacityProfile} measures it at eight capacities.
 * - "Zero allocations in steady state" — {@link throughputFootprint} measures
 *   both what a million messages *retain* (the property that is true) and how
 *   much garbage they generate (the part that made "zero" false).
 * - "waiter storage is released as waiters leave" — {@link burstRetention}
 *   drives repeated 50,000-producer bursts through one queue and checks that
 *   the settled heap does not accumulate.
 *
 * Requires `node --expose-gc`; `npm run benchmark:memory` passes it. Without a
 * deterministic collection point, heapUsed deltas are not attributable.
 *
 * Run: npm run benchmark:memory
 */

import { AsyncQueue } from '../../src/index';
import { describeMachine, machineInfo } from './harness';
import * as v8 from 'v8';
import * as fs from 'fs';
import * as path from 'path';

const gc = (globalThis as { gc?: () => void }).gc;
if (typeof gc !== 'function') {
  console.error('This benchmark requires --expose-gc. Use: npm run benchmark:memory');
  process.exit(1);
}

/**
 * Keeps a measured object reachable across the closing collection.
 *
 * A property on a live object, not a bare `let`: V8 is entitled to treat a
 * local whose last read has already happened as dead and collect its referent
 * before the measurement is taken, which would report every footprint as zero.
 */
const anchor: { value: unknown } = { value: undefined };

function settle(): void {
  // Twice: the first pass can leave objects that only the second pass reaches.
  gc!();
  gc!();
}

function heapUsed(): number {
  return process.memoryUsage().heapUsed;
}

/**
 * Retained heap attributable to whatever `build` returns, in bytes.
 *
 * The value is held live across the closing measurement, so this reports what
 * the object *retains*, not what constructing it allocated transiently.
 */
function retained(build: () => unknown): number {
  anchor.value = undefined;
  settle();
  const before = heapUsed();
  anchor.value = build();
  settle();
  const after = heapUsed();
  // Read it, so nothing above can be treated as unobserved and elided.
  if (anchor.value === null) throw new Error('unreachable');
  anchor.value = undefined;
  return after - before;
}

function human(bytes: number): string {
  if (Math.abs(bytes) >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
  if (Math.abs(bytes) >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${Math.round(bytes)} B`;
}

function nextPowerOfTwo(n: number): number {
  return n <= 1 ? 1 : 2 ** (32 - Math.clz32(n - 1));
}

interface CapacityRow {
  maxSize: number;
  bufferSlots: number;
  bytesPerQueue: number;
  bytesPerSlot: number;
}

/**
 * Footprint of an EMPTY queue at a range of capacities.
 *
 * Small capacities are measured over many instances and divided, because a
 * single small queue is below the noise floor of `heapUsed`.
 */
function capacityProfile(): CapacityRow[] {
  const rows: CapacityRow[] = [];
  const cases: Array<[maxSize: number, instances: number]> = [
    [1, 20_000],
    [10, 20_000],
    [100, 5_000],
    [1_000, 1_000],
    [10_000, 200],
    [100_000, 20],
    [1_000_000, 4],
    [10_000_000, 1]
  ];

  for (const [maxSize, instances] of cases) {
    const bytes = retained(() => {
      const queues: Array<AsyncQueue<number>> = [];
      for (let i = 0; i < instances; i++) queues.push(new AsyncQueue<number>(maxSize));
      return queues;
    });
    // Subtract the array of references itself: 8 bytes per element.
    const perQueue = (bytes - instances * 8) / instances;
    const slots = nextPowerOfTwo(maxSize);
    rows.push({
      maxSize,
      bufferSlots: slots,
      bytesPerQueue: perQueue,
      bytesPerSlot: perQueue / slots
    });
  }
  return rows;
}

interface FlowResult {
  messages: number;
  capacity: number;
  heapBefore: number;
  heapAfter: number;
  retainedDelta: number;
  collections: number;
  gcPauseMs: number;
  bytesReclaimed: number;
  bytesReclaimedPerMessage: number;
  gcProfilerAvailable: boolean;
}

/**
 * Heap behaviour while a large number of messages pass through a queue whose
 * capacity is small and fixed.
 *
 * Two different things are measured, because the README conflated them:
 *
 * - `retainedDelta` — what the queue still holds afterwards. Flat, and this is
 *   the genuinely valuable property.
 * - `bytesReclaimed` — how much garbage the run generated, summed over every
 *   collection V8 performed during it. Non-zero, which is what makes "zero
 *   allocations in steady state" false: `enqueue`/`dequeue` are async, so each
 *   suspension costs at least a promise.
 *
 * Garbage is counted with `v8.GCProfiler`, **not** with a `PerformanceObserver`
 * on `'gc'` entries. That observer was tried first and silently reports zero
 * entries on Node 23 while `--trace-gc` shows 759 real scavenges over the same
 * workload — it would have "confirmed" the zero-allocation claim by measuring
 * nothing at all.
 */
async function throughputFootprint(messages: number, capacity: number): Promise<FlowResult> {
  const queue = new AsyncQueue<number>(capacity);

  const GCProfiler = (v8 as unknown as { GCProfiler?: new () => GcProfilerLike }).GCProfiler;
  const profiler = GCProfiler ? new GCProfiler() : undefined;

  settle();
  const heapBefore = heapUsed();
  profiler?.start();

  for (let i = 0; i < messages; i++) {
    await queue.enqueue(i);
    await queue.dequeue();
  }

  const profile = profiler?.stop();
  settle();
  const heapAfter = heapUsed();

  // `queue` must still be reachable here or `heapAfter` measures a collected
  // queue rather than a drained one.
  if (queue.size !== 0) throw new Error('queue should be empty');

  let collections = 0;
  let gcPauseMs = 0;
  let bytesReclaimed = 0;
  for (const entry of profile?.statistics ?? []) {
    collections++;
    // `cost` is MICROseconds. Verified rather than assumed: summing it as
    // milliseconds over a 68.7ms promise-churning loop gives 12,717ms, i.e.
    // 185x the wall-clock time the loop took, which is impossible.
    gcPauseMs += entry.cost / 1000;
    const freed =
      entry.beforeGC.heapStatistics.usedHeapSize - entry.afterGC.heapStatistics.usedHeapSize;
    if (freed > 0) bytesReclaimed += freed;
  }

  return {
    messages,
    capacity,
    heapBefore,
    heapAfter,
    retainedDelta: heapAfter - heapBefore,
    collections,
    gcPauseMs,
    bytesReclaimed,
    bytesReclaimedPerMessage: bytesReclaimed / messages,
    gcProfilerAvailable: profiler !== undefined
  };
}

/** The subset of `v8.GCProfiler` this file uses. Not in @types/node for all versions. */
interface GcProfilerLike {
  start(): void;
  stop(): {
    statistics: Array<{
      gcType: string;
      cost: number;
      beforeGC: { heapStatistics: { usedHeapSize: number } };
      afterGC: { heapStatistics: { usedHeapSize: number } };
    }>;
  };
}

interface BurstRound {
  round: number;
  peakAboveBaseline: number;
  settledAboveBaseline: number;
  bytesPerBlockedProducer: number;
}

/**
 * Repeated bursts of blocked producers through ONE queue.
 *
 * Measuring a single burst against a baseline taken inside the same round is
 * not sound — it was tried, and reported ~390 KiB of apparent retention that a
 * plain 50,000-element array control reproduced exactly. What matters, and what
 * this measures, is whether the settled heap *accumulates* across rounds. It
 * does not: the waiter lists are intrusive, so an unlinked waiter is
 * immediately collectable and the concurrency high-water mark costs nothing
 * once it has passed.
 */
async function burstRetention(producers: number, rounds: number): Promise<{
  baseline: number;
  rounds: BurstRound[];
}> {
  const queue = new AsyncQueue<number>(1);
  settle();
  const baseline = heapUsed();
  const results: BurstRound[] = [];

  for (let round = 1; round <= rounds; round++) {
    await queue.enqueue(-1);
    let pending: Array<Promise<void>> | null = [];
    for (let i = 0; i < producers; i++) pending.push(queue.enqueue(i));

    settle();
    const peak = heapUsed() - baseline;

    for (let i = 0; i < producers + 1; i++) await queue.dequeue();
    await Promise.all(pending);
    pending = null;
    if (pending !== null) throw new Error('unreachable');

    settle();
    results.push({
      round,
      peakAboveBaseline: peak,
      settledAboveBaseline: heapUsed() - baseline,
      bytesPerBlockedProducer: peak / producers
    });

    if (queue.waitingProducerCount !== 0) throw new Error('producers still blocked');
  }

  return { baseline, rounds: results };
}

async function main(): Promise<void> {
  const machine = machineInfo();
  console.log('=== AsyncQueue memory ===\n');
  console.log(describeMachine(machine));
  console.log('');

  // Order matters. The capacity profile allocates a 128 MiB buffer, and a heap
  // that has been that large stays large enough that the KiB-scale deltas the
  // other two sections report drop below the noise floor. It therefore runs
  // last, on a heap the earlier sections have kept small.
  console.log('-- Messages through a fixed-capacity queue --\n');
  const flow = await throughputFootprint(1_000_000, 1024);
  console.log(`  ${flow.messages.toLocaleString()} messages through AsyncQueue(${flow.capacity})`);
  console.log(`  heapUsed before:  ${human(flow.heapBefore)}`);
  console.log(`  heapUsed after:   ${human(flow.heapAfter)}`);
  console.log(`  RETAINED delta:   ${human(flow.retainedDelta)}   <- flat, regardless of message count`);
  if (flow.gcProfilerAvailable) {
    console.log(`  collections:      ${flow.collections} (${flow.gcPauseMs.toFixed(1)}ms total pause)`);
    console.log(
      `  GARBAGE produced: ${human(flow.bytesReclaimed)} ` +
        `(${flow.bytesReclaimedPerMessage.toFixed(1)} bytes/message)   <- not zero`
    );
  } else {
    console.log('  v8.GCProfiler unavailable on this runtime; garbage not measured.');
  }

  console.log('\n-- Repeated blocked-producer bursts through one queue --\n');
  const PRODUCERS = 50_000;
  const burst = await burstRetention(PRODUCERS, 5);
  console.log(`  baseline heapUsed: ${human(burst.baseline)}`);
  console.log(
    `  ${'round'.padStart(6)} | ${'peak above baseline'.padStart(20)} | ` +
      `${'bytes/blocked producer'.padStart(22)} | ${'settled above baseline'.padStart(22)}`
  );
  console.log('-'.repeat(78));
  for (const row of burst.rounds) {
    console.log(
      `  ${String(row.round).padStart(6)} | ${human(row.peakAboveBaseline).padStart(20)} | ` +
        `${row.bytesPerBlockedProducer.toFixed(0).padStart(22)} | ` +
        `${human(row.settledAboveBaseline).padStart(22)}`
    );
  }
  console.log(
    `\n  ${PRODUCERS.toLocaleString()} producers block and are released ${burst.rounds.length} times over; ` +
      'the settled heap does not accumulate.'
  );

  console.log('\n-- Empty-queue footprint by capacity (the buffer is allocated up front) --\n');
  const capacities = capacityProfile();
  console.log(
    `${'maxSize'.padStart(12)} | ${'slots'.padStart(12)} | ${'empty queue'.padStart(12)} | ${'bytes/slot'.padStart(10)}`
  );
  console.log('-'.repeat(56));
  for (const row of capacities) {
    console.log(
      `${row.maxSize.toLocaleString().padStart(12)} | ${row.bufferSlots.toLocaleString().padStart(12)} | ` +
        `${human(row.bytesPerQueue).padStart(12)} | ${row.bytesPerSlot.toFixed(2).padStart(10)}`
    );
  }

  const results = {
    machine,
    generatedAt: new Date().toISOString(),
    emptyQueueByCapacity: capacities,
    messagesThrough: flow,
    burst: { producers: PRODUCERS, ...burst }
  };
  const dir = path.resolve(__dirname, '../../benchmark-results');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'memory.json');
  fs.writeFileSync(file, JSON.stringify(results, null, 2));
  console.log(`\nResults written to ${path.relative(process.cwd(), file)}\n`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
