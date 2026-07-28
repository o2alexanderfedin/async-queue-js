/**
 * Benchmark harness.
 *
 * Replaces a harness whose numbers could not be used as measurements. Three
 * defects, all of which changed the published figures:
 *
 * 1. **Setup ran inside the timed region.** Every case allocated a fresh queue
 *    (`new AsyncQueue(100)` — a 128-slot array) *inside* the function being
 *    timed, so the reported figure was dominated by construction rather than by
 *    the operation named in the label. Here `setup()` runs outside the timed
 *    region and only `run()` is timed.
 *
 * 2. **One `fn()` call was one sample, and `hz = 1000 / mean` was reported as
 *    "ops/sec".** For a case whose body performed 1,000 operations that
 *    understated throughput by 1000x; for a case whose body performed one
 *    operation it was accidentally right. Numbers from different cases were
 *    therefore not comparable with each other. Every case here declares
 *    `opsPerIteration`, and all figures are per **queue operation**.
 *
 * 3. **`rme` was the coefficient of variation, not a margin of error.** It was
 *    `stdDev / mean`, which does not shrink as samples accumulate, so it could
 *    never converge — hence published values of 143%, 197%, 396%. The relative
 *    margin of error is the half-width of the 95% confidence interval *of the
 *    mean*, `t(0.975, n-1) * stdDev / sqrt(n)`, which does shrink as 1/sqrt(n).
 *    A run whose RME exceeds {@link RME_LIMIT} is marked UNSTABLE and must not
 *    be published as a measurement.
 *
 * Timing uses `performance.now()` (monotonic, sub-microsecond, and identical in
 * Node and the browser) rather than `Date.now()`.
 */

import { performance } from 'perf_hooks';
import * as os from 'os';

/** RME above this is reported as UNSTABLE and is not a measurement. */
export const RME_LIMIT = 5;

/**
 * Critical values of Student's t at 95% two-sided, indexed by degrees of
 * freedom. Same table Benchmark.js uses. Anything past the end is effectively
 * normal, so the z value is used.
 */
const T_TABLE: Record<number, number> = {
  1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365,
  8: 2.306, 9: 2.262, 10: 2.228, 11: 2.201, 12: 2.179, 13: 2.16, 14: 2.145,
  15: 2.131, 16: 2.12, 17: 2.11, 18: 2.101, 19: 2.093, 20: 2.086, 21: 2.08,
  22: 2.074, 23: 2.069, 24: 2.064, 25: 2.06, 26: 2.056, 27: 2.052, 28: 2.048,
  29: 2.045, 30: 2.042
};
const T_INFINITY = 1.96;

function tCritical(degreesOfFreedom: number): number {
  return T_TABLE[degreesOfFreedom] ?? T_INFINITY;
}

/** Nearest-rank percentile of an already-sorted ascending array. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1]!;
}

/** Hardware and runtime the numbers were produced on. Published with them. */
export interface MachineInfo {
  node: string;
  v8: string;
  os: string;
  arch: string;
  cpu: string;
  cores: number;
  memoryGiB: number;
}

export function machineInfo(): MachineInfo {
  const cpus = os.cpus();
  return {
    node: process.version,
    v8: process.versions.v8,
    os: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    cpu: cpus[0]?.model?.trim() ?? 'unknown',
    cores: cpus.length,
    memoryGiB: Number((os.totalmem() / 1024 ** 3).toFixed(1))
  };
}

export function describeMachine(info: MachineInfo = machineInfo()): string {
  return [
    `CPU:    ${info.cpu} (${info.cores} cores)`,
    `RAM:    ${info.memoryGiB} GiB`,
    `OS:     ${info.os} (${info.arch})`,
    `Node:   ${info.node} (V8 ${info.v8})`
  ].join('\n');
}

/**
 * One benchmark case.
 *
 * `run` is the only thing timed. Anything that allocates fixtures — the queue
 * included — belongs in `setup`, which runs fresh before every sample and is
 * never timed.
 *
 * @template C The context type `setup` produces and `run` consumes
 */
export interface Case<C = void> {
  name: string;
  /**
   * Number of logical queue operations one `run()` performs. An enqueue is one
   * operation and a dequeue is one operation, so an enqueue+dequeue cycle is
   * two. Every published figure is normalised by this, which is what makes
   * cases comparable to each other.
   */
  opsPerIteration: number;
  /** Untimed. Runs before each sample. */
  setup?: () => C | Promise<C>;
  /** Timed. */
  run: (context: C) => Promise<void>;
  /** Untimed. Runs after each sample. */
  teardown?: (context: C) => void | Promise<void>;
}

export interface CaseResult {
  name: string;
  opsPerIteration: number;
  samples: number;
  /** ops/sec computed from the median sample — the headline figure. */
  opsPerSecond: number;
  /** ops/sec computed from the mean sample, for reference. */
  opsPerSecondMean: number;
  /** Per-operation latency in nanoseconds. */
  p50: number;
  p90: number;
  p99: number;
  min: number;
  max: number;
  meanNs: number;
  /** Relative margin of error, %, at 95% confidence. Above RME_LIMIT: unstable. */
  rme: number;
  stable: boolean;
}

export interface Report {
  machine: MachineInfo;
  generatedAt: string;
  /** How garbage collection was handled during the run. */
  gc: string;
  cases: CaseResult[];
}

export interface RunOptions {
  /** Untimed iterations before sampling begins. */
  warmup?: number;
  /** Number of timed samples to collect. */
  samples?: number;
}

/**
 * Forcing a full GC between samples was tried and rejected on measurement.
 *
 * The theory was that it would stop a sample inheriting the previous sample's
 * garbage. Measured on the enqueue/dequeue cycle at 250,000 cycles per sample,
 * `--expose-gc` with `global.gc()` between samples gave mean 46.7ns / RME 4.08%
 * against 41.1ns / RME 2.52% for leaving V8 alone: both slower *and* noisier.
 * A forced full collection is itself a multi-millisecond perturbation of the
 * heap and the caches, and V8's own scavenges are frequent and cheap enough
 * that they average out inside a sample that spans many of them.
 *
 * What actually controls the noise is sample length and sample count. See
 * {@link Bench.add}.
 */
const GC_NOTE = 'V8 GC left to its own schedule; see harness.ts';

/**
 * Runs cases and collects statistics.
 *
 * Each sample is one full `run()`. Cases are written so that a single `run()`
 * performs enough operations (tens of thousands) to take milliseconds, which
 * keeps the timed region far above timer resolution without needing to batch
 * iterations — batching would have forced `setup` back inside the timed region,
 * which is the defect this harness exists to remove.
 */
export class Bench {
  private readonly results: CaseResult[] = [];

  constructor(private readonly options: RunOptions = {}) {}

  async add<C>(testCase: Case<C>): Promise<CaseResult> {
    const warmup = this.options.warmup ?? 20;
    const sampleCount = this.options.samples ?? 100;

    const once = async (): Promise<number> => {
      const context = (await testCase.setup?.()) as C;
      const start = performance.now();
      await testCase.run(context);
      const elapsed = performance.now() - start;
      await testCase.teardown?.(context);
      return elapsed;
    };

    // Warm-up has to be long enough for V8 to tier the hot loop up to its final
    // optimised form; folding those first iterations into the samples costs
    // real RME. Sample *length* is the other half: each `run()` performs enough
    // operations to span many V8 scavenges, so per-sample GC cost averages out
    // instead of showing up as a bimodal distribution.
    for (let i = 0; i < warmup; i++) {
      await once();
    }

    // Per-operation latency in nanoseconds, one entry per sample.
    const perOpNs: number[] = [];
    for (let i = 0; i < sampleCount; i++) {
      const elapsedMs = await once();
      perOpNs.push((elapsedMs * 1e6) / testCase.opsPerIteration);
    }

    const result = summarise(testCase, perOpNs);
    this.results.push(result);
    printCase(result);
    return result;
  }

  report(): Report {
    return {
      machine: machineInfo(),
      generatedAt: new Date().toISOString(),
      gc: GC_NOTE,
      cases: this.results
    };
  }
}

function summarise<C>(testCase: Case<C>, perOpNs: number[]): CaseResult {
  const n = perOpNs.length;
  const mean = perOpNs.reduce((a, b) => a + b, 0) / n;
  // Sample standard deviation (n-1): these are samples of a population, not
  // the population.
  const variance = perOpNs.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (n - 1);
  const stdDev = Math.sqrt(variance);
  const standardError = stdDev / Math.sqrt(n);
  const marginOfError = standardError * tCritical(n - 1);
  const rme = (marginOfError / mean) * 100;

  const sorted = [...perOpNs].sort((a, b) => a - b);
  const p50 = percentile(sorted, 50);

  return {
    name: testCase.name,
    opsPerIteration: testCase.opsPerIteration,
    samples: n,
    opsPerSecond: Math.round(1e9 / p50),
    opsPerSecondMean: Math.round(1e9 / mean),
    p50,
    p90: percentile(sorted, 90),
    p99: percentile(sorted, 99),
    min: sorted[0]!,
    max: sorted[n - 1]!,
    meanNs: mean,
    rme,
    stable: rme <= RME_LIMIT
  };
}

function ns(value: number): string {
  return `${value.toFixed(1)}ns`;
}

function printCase(result: CaseResult): void {
  const flag = result.stable ? '' : '   ** UNSTABLE — not a measurement **';
  console.log(
    `  ${result.name.padEnd(34)} ` +
      `${result.opsPerSecond.toLocaleString().padStart(12)} ops/sec  ` +
      `±${result.rme.toFixed(2)}%${flag}`
  );
  console.log(
    `  ${''.padEnd(34)} ` +
      `p50 ${ns(result.p50)}  p90 ${ns(result.p90)}  p99 ${ns(result.p99)}` +
      `   (${result.samples} samples x ${result.opsPerIteration.toLocaleString()} ops)`
  );
}

/** Prints the per-case table plus the machine the run happened on. */
export function printReport(report: Report, title: string): void {
  console.log(`\n=== ${title} ===\n`);
  console.log(describeMachine(report.machine));
  console.log(`Run:    ${report.generatedAt}`);
  console.log(`GC:     ${report.gc}`);
  console.log(
    '\nAll figures are per queue operation (one enqueue or one dequeue).' +
      '\nops/sec is derived from the median sample; ± is the 95% relative margin of error.\n'
  );

  const width = Math.max(...report.cases.map(c => c.name.length), 20);
  console.log(
    `${'Case'.padEnd(width)} | ${'ops/sec'.padStart(12)} | ${'p50'.padStart(9)} | ` +
      `${'p90'.padStart(9)} | ${'p99'.padStart(9)} | ${'RME'.padStart(7)}`
  );
  console.log('-'.repeat(width + 60));
  for (const c of report.cases) {
    console.log(
      `${c.name.padEnd(width)} | ${c.opsPerSecond.toLocaleString().padStart(12)} | ` +
        `${ns(c.p50).padStart(9)} | ${ns(c.p90).padStart(9)} | ${ns(c.p99).padStart(9)} | ` +
        `${(c.rme.toFixed(2) + '%').padStart(7)}${c.stable ? '' : '  UNSTABLE'}`
    );
  }

  const unstable = report.cases.filter(c => !c.stable);
  if (unstable.length > 0) {
    console.log(
      `\n${unstable.length} case(s) exceeded the ${RME_LIMIT}% RME limit. ` +
        'Those rows are noise, not measurements, and must not be published.'
    );
  }
  console.log('');
}
