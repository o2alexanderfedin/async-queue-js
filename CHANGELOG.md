# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] — unreleased

Correctness, fairness, and packaging. The headline is that **an ESM project can
now depend on this package**: v1 shipped a single CommonJS build with no
`exports` map, so `import` handed ESM consumers a namespace object where the
types promised a class.

### Breaking

- **Files inside the package moved.** `dist/index.js` → `dist/cjs/index.js`,
  `dist/index.d.ts` → `dist/cjs/index.d.ts`. Anything reaching past the package
  entry point (`require('@alexanderfedin/async-queue/dist/index.js')`) must stop.
  The `exports` map now blocks deep imports outright; `.` and `./package.json`
  are the only public subpaths. Import from the package root instead — both
  `AsyncQueue` and `QueueClosedError` are exported there and always were.

- **`engines.node` is now `>=16.0.0`** (was `>=12.0.0`). The old floor was never
  real for this shape of package: `exports` maps are only honoured from Node
  12.17, and Node 12 is seven years past end-of-life. 16 is the lowest version
  CI actually proves.

- **`.npmignore` was deleted.** The `files` field in `package.json` is now the
  single source of truth for what gets published. Having both is what let
  `dist/index.d.ts.map` ship while the `src/` it pointed at was excluded.

- **`close()` returns `T[]`** instead of `void` — the payloads of producers that
  were blocked when the queue closed. Additive for callers that ignore the
  return value; breaking for anyone who had typed it as `void`.

### Added

- **Dual ESM + CommonJS builds behind an `exports` map.** `import` resolves to
  `dist/esm` (real ES modules), `require` resolves to `dist/cjs`. Each half
  carries its own `package.json` module-format marker, so its format does not
  depend on the root `type` field. `types` is the first key in both conditions,
  which is what makes TypeScript pick up the matching declarations.

- **`module`, `sideEffects`, and an explicit `type` field.** `sideEffects: false`
  lets bundlers tree-shake the package; it is accurate, as the module has no
  top-level side effects.

- **Sources are published.** `src/index.ts` ships alongside `dist/`, so the
  declaration maps resolve and "go to definition" lands on real TypeScript
  instead of a generated `.d.ts`. It also makes the artifact auditable: a
  consumer can rebuild `dist/` from the shipped `src/` and compare.

- **`npm run verify:provenance`** — recompiles `src/` into a scratch directory
  and byte-compares (SHA-256) against `dist/`, proving every shipped `.js`,
  `.d.ts`, and `.d.ts.map` is exactly what `tsc` produced with no manual edits.

- **`npm run verify:packaging`** — packs the real tarball, installs it into
  throwaway ESM and CommonJS consumer packages, then type-checks under **both**
  `moduleResolution: "bundler"` and `"nodenext"` and runs the result. 14 checks.

- **CI covers Node 16, 18, 20, 22, and 24** across Linux, Windows, and macOS
  (was 16/18/20). A new `packaging` job runs both verification scripts on the
  engines floor and on current LTS, and `publish` now depends on it.

- **`QueueClosedError` carries `.item`**, the payload the queue refused, and
  `AsyncQueueOptions.onDropped` observes every rejected enqueue.

- **Cancellation** via `AbortSignal` on the blocking operations.

### Fixed

- **`import AsyncQueue from '@alexanderfedin/async-queue'; new AsyncQueue()`
  threw `TypeError: AsyncQueue is not a constructor`** — and type-checked clean
  under `moduleResolution: "bundler"` while correctly reporting `TS2351` under
  `"nodenext"`, so the failure only appeared at runtime. There was no ESM build,
  so the default import resolved to the CommonJS namespace object. The default
  export is kept and is now a real constructor in both builds; the types were
  right all along and the runtime has been made to match.

  The default export is **not** removed, deliberately. TypeScript CommonJS
  consumers compiling with `esModuleInterop` already resolve
  `import AsyncQueue from '...'` to the class today, and that path works — so
  removing it would have broken working code to fix broken code. Prefer the
  named export; the default is a compatibility surface.

- **`dist/index.d.ts.map` pointed at a `src/` that was never published**, so
  every editor "go to definition" dead-ended. Sources now ship.

- **`instanceof QueueClosedError` across the ESM/CommonJS boundary.** Shipping
  two builds means a graph can load both — an ESM app importing the package
  while a CommonJS dependency requires it — giving two classes with two
  prototypes. A prototype-chain `instanceof` tests against whichever copy the
  checking code imported, so an error from the other copy fell through to
  `else { throw err }`. Since `err.item` is the only handle on a refused
  payload, that was silent data loss. `QueueClosedError` now brands itself with
  a `Symbol.for`-keyed marker and matches on the brand. A plain `Error` is still
  rejected, and subclasses keep exact prototype-chain semantics.

- **Subclassing `QueueClosedError` was broken.** The constructor's ES5-downlevel
  prototype repair called `Object.setPrototypeOf(this, QueueClosedError.prototype)`
  unconditionally, flattening subclass instances onto the base prototype, so for
  `class AppError extends QueueClosedError {}`, `new AppError(x) instanceof AppError`
  answered `false`. It now uses `new.target.prototype`.

- **`close()` could kill the host process** with unhandled promise rejections
  from blocked producers.

- **`undefined` was treated as an end-of-stream sentinel**, so a queue of
  `T | undefined` silently truncated.

- **Waiters were woken LIFO**, so under sustained contention the *first* blocked
  producer could be starved indefinitely — measured: never woken across 200
  dequeue rounds. Waiters are now served FIFO in O(1).

- **`toAsyncGenerator()` deadlocked on early termination.** It delegated with
  `yield* this`, so calling `.return()` on it parked forever. It now returns the
  same hand-written cursor as `[Symbol.asyncIterator]()`, and supports
  `await using` via `Symbol.asyncDispose`.

- **Waiter queues retained their concurrency high-water mark forever** — 50,000
  transient producers left ~512 KiB of pointers retained after a full drain.
  They are now intrusive linked lists: nothing is retained once a waiter leaves,
  and cancelled waiters are unlinked rather than tombstoned.

- **`NaN` and fractional/huge `maxSize`** corrupted the circular buffer. `NaN` is
  rejected; out-of-range values are clamped to `AsyncQueue.MAX_CAPACITY`.

### Documentation and benchmarks

No runtime behaviour changed here. The published performance claims did not
describe this code, and in several cases described the opposite of what it does.
Everything is now measured by a script in the repository, on a recorded machine,
with the run committed to `benchmark-results/`.

- **The benchmark harness was rebuilt** (`benchmark/src/harness.ts`). Three
  defects made its output unusable as measurement, all of which moved the
  published numbers:
  - it constructed a fresh queue *inside* the timed region, so the headline
    figure was substantially the cost of `new Array(128)`;
  - it reported `1000 / mean` per `fn()` call as "ops/sec" regardless of how many
    queue operations `fn()` performed, so cases were not comparable to each other
    (and the repo's own `npm run benchmark` printed 2.5M for what is really 26.7M);
  - its "rme" was `stdDev / mean`, the coefficient of variation, which does not
    shrink as samples accumulate — hence published values of 143%, 197%, 396%.
    RME is now the 95% margin of error of the mean, and any case above 5% is
    printed as `UNSTABLE` and excluded from the docs.

  Timing is `performance.now()`; setup is untimed; p50/p90/p99 are reported
  alongside ops/sec; and every run records CPU, cores, RAM, OS, Node and V8.

- **`npm run benchmark:compare` works again.** It imported `rxjs`, which is not a
  dependency, so it died on `MODULE_NOT_FOUND` before measuring anything. RxJS is
  removed rather than left broken, and the "10x faster than RxJS" claim is gone
  with it.

- **`npm run benchmark:memory` is new.** Measures empty-queue footprint by
  capacity, retention across a million messages, garbage produced per message
  (via `v8.GCProfiler`), and heap behaviour across repeated 50,000-producer
  bursts.

- **`benchmark:native` and `benchmark/src/compare-native.ts` were removed** — a
  near-duplicate of `benchmark:compare` with no sampling and no statistics at
  all. `benchmark:compare` covers everything it did.

- **The reports no longer publish invented numbers.**
  `scripts/generate-benchmark-report.js` carried a hard-coded `sampleResults`
  block — the origin of the README's "647K ops/sec" badge, a figure nothing had
  ever measured, sitting four lines below a headline claiming 10,000,000. It now
  reads `benchmark-results/throughput.json` and errors if there is no run to
  report. `scripts/generate-reports.js` likewise reads live coverage, test and
  version data instead of hard-coded "91.3% / 57 tests / 647K / v1.1.0".

- **Corrected claims**, measured on an Apple M1 Pro / Node v23.11.0:
  | Claim | Reality |
  |---|---|
  | "Direct Handoff… 2x faster… 200ns → 100ns" | Reversed. The handoff path is 81.0ns/op against 41.8ns/op for the buffered path. The mechanism is real but it buys atomic, in-order transfer — not speed. |
  | "O(1) memory" | O(maxSize), allocated up front, 8 bytes/slot rounded to a power of two. The true O(1) property is in *messages passed through*: 1,000,000 messages move the retained heap by 168.7 KiB. |
  | "Zero allocations in steady state" | 444.5 bytes of collectable garbage per message. Retention is flat — "bounded steady-state heap" is the accurate claim. |
  | "10,000,000 ops/sec" / badge "647K" / `npm run benchmark` printing 2.5M | One measured set: 26.7M ops/sec, p50 37.4ns, on the recorded machine. |
  | "5x faster than EventEmitter" | ~2x (2.15x sequential, 1.79x concurrent; 1.93x-2.19x across runs). The old script printed the *opposite* because it timed constructors. |
  | "3.3x faster than Promise-based", "2.5x faster than Callback-based" | 1.71x and 1.49x. |
  | "20x faster than naive array.shift()" | Reversed: a native array is 2.08x faster. It also cannot block, wait, or apply backpressure. |
  | "~80 KB for maxSize=10,000" | 128.2 KiB. |
  | "Circular buffer: 27-54% improvement", "Power-of-2 sizing: 15-20%" | Nothing measures either; removed. The measurable consequence — per-operation cost flat from `maxSize=1` to `maxSize=10,000` — is reported instead. |

- **The FIFO claim was verified, not just kept.** `test/fifo-claim.test.ts` pins
  it directly: 1,000 items through a capacity-4 queue from 40 interleaved
  producers come out in `enqueue()` call order under a seeded random drain
  schedule; 200 parked consumers are served in arrival order; the first blocked
  producer is released by the first free slot with 498 producers queued behind
  it.

## [1.1.0]

- Machine specifications added to benchmark reports.

[2.0.0]: https://github.com/o2alexanderfedin/async-queue-js/releases/tag/v2.0.0
[1.1.0]: https://github.com/o2alexanderfedin/async-queue-js/releases/tag/v1.1.0
