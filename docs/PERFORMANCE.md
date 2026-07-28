# AsyncQueue Performance

**Developed by AI Hive® at [O2.services](https://o2.services)**

[← Back to README](../README.md) | [View Examples](../examples/) | [NPM Package](https://www.npmjs.com/package/@alexanderfedin/async-queue)

Every number on this page came from a script in this repository, on the machine
recorded below, and can be reproduced with one command. Nothing here is
extrapolated, rounded up, or carried over from an earlier version of the code.

```bash
npm run benchmark          # throughput and latency  -> benchmark-results/throughput.json
npm run benchmark:compare  # versus alternatives     -> benchmark-results/comparison.json
npm run benchmark:memory   # memory                  -> benchmark-results/memory.json
npm run benchmark:all      # all three
```

Those three JSON files are **committed**, and they are the exact runs the tables
below were written from — machine, timestamp, every sample statistic. If a
number on this page and a number in that directory disagree, the directory is
right and this page is stale.

## The machine these numbers are from

| | |
|---|---|
| CPU | Apple M1 Pro, 8 cores |
| RAM | 32 GiB |
| OS | Darwin 25.5.0 (macOS 26.5.2), arm64 |
| Node | v23.11.0 |
| V8 | 12.9.202.28-node.14 |

**Absolute throughput figures do not transfer to other hardware.** The ratios
and the shapes — cost per operation being flat in buffer size, the suspended
path costing about twice the buffered path — are the parts that should hold
elsewhere. Re-run the benchmarks on your own hardware before quoting a number.

## Method

- **Timing** is `performance.now()`, which is monotonic, sub-microsecond, and
  behaves the same in Node and in a browser.
- **Setup is not timed.** Each queue is constructed before the clock starts.
- **Every figure is per queue operation.** One enqueue is one operation and one
  dequeue is one operation, so an enqueue+dequeue cycle counts as two. This is
  what makes cases with different iteration counts comparable.
- **Percentiles, not a bare mean.** The distributions have a right tail (V8
  scavenges land inside some samples and not others), which is exactly the
  situation where a mean misleads.
- **100 samples per case**, each sample spanning 100,000-500,000 operations, and
  20 untimed warm-up iterations before sampling starts.
- **RME is the 95% relative margin of error of the mean**, `t(0.975, n-1) · s /
  (x̄ · √n)`. A case whose RME exceeds **5%** is printed as `UNSTABLE` and is not
  a measurement. The previous harness reported `stdDev / mean` under the same
  name — a quantity that does not shrink with more samples — and published
  values as high as 396%.

Forcing a full GC between samples was tried and rejected on measurement: at
250,000 cycles per sample it produced mean 46.7ns / RME 4.08% against 41.1ns /
RME 2.52% for leaving V8 alone. Both slower and noisier.

## Throughput

`npm run benchmark`, 100 samples per case. ops/sec is derived from the median
sample; p50/p90/p99 are per-operation latency.

### Non-blocking paths — nothing suspends

| Case | ops/sec | p50 | p90 | p99 | RME |
|------|--------:|----:|----:|----:|----:|
| enqueue+dequeue cycle, buffer=1024 | 26,713,207 | 37.4ns | 38.4ns | 40.2ns | 1.53% |
| enqueue only, filling the buffer | 26,720,344 | 37.4ns | 38.3ns | 42.5ns | 0.60% |
| dequeue only, pre-filled | 25,034,525 | 39.9ns | 41.6ns | 73.6ns | 2.77% |

### Concurrent producers and consumers

| Case | ops/sec | p50 | p90 | p99 | RME |
|------|--------:|----:|----:|----:|----:|
| 1 producer / 1 consumer, buffer=1024 | 24,303,182 | 41.1ns | 43.0ns | 46.9ns | 0.72% |
| 1 producer / 1 consumer, buffer=1 | 24,356,828 | 41.1ns | 43.1ns | 63.1ns | 3.17% |
| 4 producers / 1 consumer, buffer=16 | 16,795,079 | 59.5ns | 67.8ns | 100.4ns | 3.04% |
| 1 producer / 4 consumers, buffer=16 | 12,697,607 | 78.8ns | 81.1ns | 94.9ns | 0.84% |
| burst, 1024 in then 1024 out | 20,692,077 | 48.3ns | 51.0ns | 81.7ns | 2.39% |

Contention costs something, and it is visible: the four-consumer shape runs at
about half the rate of the single-consumer shape, because every item goes
through a parked consumer rather than through the buffer. See the next section.

### Cost per operation is flat in buffer size

This is the O(1) claim, measured. The same enqueue+dequeue cycle across five
capacities spanning four orders of magnitude:

| Buffer size | ops/sec | p50 | RME |
|-------------|--------:|----:|----:|
| 1 | 22,563,134 | 44.3ns | 1.84% |
| 10 | 22,432,213 | 44.6ns | 1.38% |
| 100 | 22,138,016 | 45.2ns | 2.39% |
| 1,000 | 22,337,966 | 44.8ns | 2.49% |
| 10,000 | 22,134,749 | 45.2ns | 1.88% |

44.3ns to 45.2ns across a 10,000x change in capacity — a 2% spread, inside the
margin of error of the individual cases. Time per operation does not depend on
how much is buffered.

### Direct handoff: what it is, and what it is not

When a consumer is already parked, `enqueue()` hands the item straight to it and
never touches the buffer. That code path is real — `settleConsumer(consumer,
item)` in `src/index.ts`, reached before the buffer is consulted.

It is **not** a throughput optimisation, and the documentation used to claim it
was one ("2x faster… reduces latency from 200ns to 100ns"). Measured as a
matched pair — same queue, same one-item-through-an-empty-queue shape, one await
on each side, differing only in whether a consumer was parked when the producer
arrived:

| Path | ops/sec | p50 | p90 | p99 | RME |
|------|--------:|----:|----:|----:|----:|
| consumer parked first (handoff) | 12,346,251 | 81.0ns | 85.8ns | 144.1ns | 2.82% |
| no consumer waiting (via buffer) | 23,923,803 | 41.8ns | 43.6ns | 63.7ns | 2.10% |

The handoff path costs **1.94x more per operation**, not half as much. That is
not a defect: parking a consumer allocates a promise and a waiter record, and
those costs belong to the suspension, not to the buffer write it avoids. The
buffered path allocates neither.

What the handoff actually buys is correctness. The item moves into the parked
consumer in the same synchronous step that removes it from the waiter list, so
there is no window in which another consumer could take it first, and the
longest-waiting consumer is guaranteed to be the one served. The old claim
priced a fairness mechanism as a speed-up.

*Could it be made faster?* The suspension cost is the promise, not the buffer
hop, so there is nothing to win by skipping the buffer more aggressively. A
genuine saving would have to avoid allocating the promise at all — a
synchronous, callback-shaped `tryDequeue`/`onItem` API alongside the async one.
That is a new API, not an optimisation of this one, and it is not built.

## Comparison with alternatives

`npm run benchmark:compare`, 250 samples per case. Every implementation is
constructed outside the timed region and measured by the same harness.

### Sequential — enqueue then dequeue, buffer=100, never blocks

| Implementation | ops/sec | p50 | p90 | p99 | RME | vs AsyncQueue |
|----------------|--------:|----:|----:|----:|----:|---------------|
| **AsyncQueue** | **26,966,593** | **37.1ns** | 40.0ns | 58.7ns | 1.74% | — |
| Callback queue | 18,133,599 | 55.1ns | 58.4ns | 74.2ns | 0.91% | AsyncQueue 1.49x faster |
| Promise queue | 15,785,008 | 63.4ns | 66.4ns | 96.6ns | 1.08% | AsyncQueue 1.71x faster |
| EventEmitter queue | 12,565,510 | 79.6ns | 84.6ns | 119.8ns | 1.25% | AsyncQueue 2.15x faster |
| Native array (no async) | 56,084,889 | 17.8ns | 18.7ns | 22.2ns | 0.62% | native 2.08x faster |

### Concurrent — one producer, one consumer, buffer=10

| Implementation | ops/sec | p50 | p90 | p99 | RME | vs AsyncQueue |
|----------------|--------:|----:|----:|----:|----:|---------------|
| **AsyncQueue** | **26,208,026** | **38.2ns** | 40.8ns | 46.3ns | 1.01% | — |
| Promise queue | 16,801,428 | 59.5ns | 64.2ns | 104.2ns | 1.75% | AsyncQueue 1.56x faster |
| EventEmitter queue | 14,671,275 | 68.2ns | 72.7ns | 100.6ns | 1.10% | AsyncQueue 1.79x faster |

**AsyncQueue is about 2x faster than an EventEmitter-based queue, not 5x.**
Across three runs the sequential ratio came out 1.93x, 2.15x and 2.19x; the
EventEmitter implementation is the noisiest thing in the table, so treat it as
"about two", not as three significant figures.

The native array is a floor, not a competitor: it has no async interface, no
backpressure, and no way for a consumer to wait. It is in the table to show what
the async machinery costs — roughly 19ns per operation on this machine.

RxJS is absent. The old comparison script imported it, `rxjs` is not a
dependency of this package, and the script therefore died on `MODULE_NOT_FOUND`
before measuring anything — which did not stop the docs from publishing an
"AsyncQueue is 10x faster than RxJS" figure. Pulling in a 30-package tree to
produce one table row was not worth it; the claim is gone rather than guessed.

## Memory

`npm run benchmark:memory` (needs `--expose-gc`, which the script passes).

### The buffer is allocated up front, in full

The circular buffer is `new Array(nextPowerOfTwo(maxSize))`, allocated by the
constructor. An **empty** queue therefore costs O(maxSize), not O(1):

| maxSize | buffer slots | empty queue | bytes/slot |
|--------:|-------------:|------------:|-----------:|
| 1 | 1 | 250 B | 250.0 |
| 10 | 16 | 369 B | 23.1 |
| 100 | 128 | 1.2 KiB | 9.9 |
| 1,000 | 1,024 | 8.2 KiB | 8.2 |
| 10,000 | 16,384 | **128.2 KiB** | 8.0 |
| 100,000 | 131,072 | 1.00 MiB | 8.0 |
| 1,000,000 | 1,048,576 | 8.00 MiB | 8.0 |
| 10,000,000 | 16,777,216 | **128.00 MiB** | 8.0 |

Eight bytes per slot — one pointer — once the fixed ~240 bytes of instance
overhead stops dominating. Two consequences worth planning around:

- **`maxSize` is rounded up to a power of two.** `new AsyncQueue(10_000)`
  allocates 16,384 slots and costs 128.2 KiB, not the ~80 KB this document used
  to claim. Asking for 10,001 costs twice as much as asking for 10,000.
- **A large `maxSize` is paid immediately**, on construction, whether or not a
  single item is ever enqueued. `new AsyncQueue(10_000_000)` is a 128 MiB
  allocation before any work happens.

### What is O(1): messages passed through

This is the property the "O(1) memory" claim was reaching for, and it is true:

```
1,000,000 messages through AsyncQueue(1024)
  heapUsed before:  26.23 MiB
  heapUsed after:   26.39 MiB
  retained delta:   168.7 KiB
```

A million messages move through the queue and the retained heap does not move
with them. **Memory is bounded by `maxSize`, not by traffic.** Ten million
messages through the same queue would end in the same place.

### Steady state is bounded, but it is not allocation-free

The same run, instrumented with `v8.GCProfiler`:

```
collections during the run: 53 (4.5ms total pause)
garbage produced:           423.92 MiB  (444.5 bytes per message)
```

**"Zero allocations in steady state" was false.** `enqueue()` and `dequeue()` are
async: every call returns a promise, `await` allocates another, and the blocking
path additionally allocates a waiter record and an abort closure. 444 bytes of
garbage per message is what that costs on this runtime. It is *collectable*
garbage — that is why the retained heap is flat — but the collector is doing
work, and a latency-sensitive caller should know that.

The honest claim is **bounded steady-state heap**: retention does not grow with
the number of messages. That is a genuinely useful property. It is not the same
as allocating nothing.

> The first attempt at this measurement used a `PerformanceObserver` on `'gc'`
> entries. It reported **zero collections** — while `--trace-gc` showed 759 real
> scavenges over the same workload. That entry type is silently dead on Node 23.
> Had it been trusted, it would have "confirmed" the zero-allocation claim by
> measuring nothing at all.

### Blocked callers cost while they are blocked, and nothing afterwards

Waiters are nodes in an intrusive doubly-linked list. There is no backing array
to hold a high-water mark, so an unlinked waiter is immediately collectable.

Five rounds of 50,000 simultaneously-blocked producers through one queue:

| Round | peak above baseline | bytes per blocked producer | settled above baseline |
|------:|--------------------:|---------------------------:|-----------------------:|
| 1 | 14.52 MiB | 304 | 420.3 KiB |
| 2 | 14.55 MiB | 305 | 434.6 KiB |
| 3 | 14.54 MiB | 305 | 437.0 KiB |
| 4 | 14.55 MiB | 305 | 455.9 KiB |
| 5 | 14.56 MiB | 305 | 444.9 KiB |

**~305 bytes per blocked producer** while it is blocked — promise, waiter record,
and the async frame that owns them. The settled figure is a constant offset that
does not grow from round to round: 250,000 producers block and are released over
the five rounds, and the fifth round settles where the first did. The
concurrency high-water mark costs nothing once it has passed.

## FIFO ordering

**Strict FIFO holds, for items and for blocked callers**, and it is pinned by
tests rather than asserted in prose — see `test/fifo-claim.test.ts` and
`test/fairness.test.ts`:

- 1,000 items enqueued through a capacity-4 queue by 40 interleaved producers,
  drained on a seeded pseudo-random schedule, come out in exactly the order
  `enqueue()` was called.
- 200 consumers parked in a known order are served in exactly that order.
- The first blocked producer is released by the *first* free slot, even with 498
  later producers queued behind it.

This was not always true. The waiter queues were LIFO, so under sustained
contention the longest-waiting caller could be starved indefinitely while later
arrivals were served. The claim is kept in the documentation now because there
are tests that fail if it stops being true.

## Choosing a buffer size

Throughput barely moves with capacity (see above), so size the buffer for
coupling and memory, not for speed:

| Buffer size | Effect |
|-------------|--------|
| 1 | Tightest coupling. Producer and consumer advance in lockstep; every item goes through a parked waiter. ~250 B. |
| 10-100 | Absorbs small bursts. ~370 B - 1.2 KiB. |
| 1,000-10,000 | Absorbs real traffic spikes. 8.2 KiB - 128.2 KiB. |
| > 100,000 | 8 bytes per slot, allocated up front, rounded up to a power of two. Budget it deliberately. |

Monitor `waitingProducerCount` to detect sustained backpressure, and remember
each blocked producer holds ~305 bytes until it is served.

## What this page no longer claims

Removed, with the reason:

| Old claim | Status |
|-----------|--------|
| 10,000,000 ops/sec sequential | Not reproducible as stated. Measured 26.7M ops/sec per operation on this machine — the old harness reported *iterations of a function that allocated a queue*, not operations. |
| 6,666,667 ops/sec concurrent | Measured 24.3M ops/sec (1P/1C, buffer=1024). |
| Direct handoff is 2x faster, 200ns → 100ns | **Reversed.** The handoff path measures 81.0ns/op against 41.8ns/op for the buffered path. |
| O(1) memory | **False for construction.** O(maxSize), 8 bytes per slot, allocated up front. True for messages passed through, which is what is now claimed. |
| Zero allocations in steady state | **False.** 444.5 bytes of garbage per message. Retention is flat, which is the real property. |
| ~80 KB for maxSize=10,000 | Measured 128.2 KiB. |
| 5x faster than EventEmitter | Measured ~2x (1.93x-2.19x across runs). |
| 10x faster than RxJS | Never measured; the script that would have measured it could not run. |
| 3.3x faster than Promise-based | Measured 1.71x. |
| 2.5x faster than Callback-based | Measured 1.49x. |
| 20x faster than naive array.shift() | **Reversed.** A native array is 2.08x faster; it simply cannot block, wait, or apply backpressure. |
| Circular buffer worth 27-54%, power-of-2 sizing worth 15-20% | No benchmark measures either. The measurable consequence is that per-operation cost is flat in buffer size, which is reported above. |
| Waiting arrays: 8 bytes x 16 initial, grows 2x | Describes an implementation that no longer exists. Waiters are linked-list nodes with no backing store. |

---

## Related Documentation

- [Main README](../README.md) - installation and usage
- [Benchmark Libraries Analysis](./BENCHMARK-LIBRARIES.md) - JavaScript benchmarking tools
- [Publishing Guide](../PUBLISHING.md)
- [Source](../src/index.ts) | [Harness](../benchmark/src/harness.ts)

---

*Performance work by AI Hive® - [O2.services](https://o2.services)*
