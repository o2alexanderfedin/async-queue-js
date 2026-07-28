// D9 — waiter-storage retention and health-metric accuracy.
//
// Run: npm run build && node --expose-gc repro/repro-waiters.js
// Optionally against another build:  node --expose-gc repro/repro-waiters.js /path/to/dist/index.js
//
// Reference numbers from the ORIGINAL implementation (commit 9bc7022), whose
// waiter queues were grow-only arrays ("reserved capacity - never shrink"):
//
//   idle heap per empty AsyncQueue(1)             : 0.42 KiB
//   waitingProducers.length at 50k concurrency    : 65536
//   waitingProducers.length after a FULL drain    : 65536   <- retained forever
//   retained pointers after drain                 : ~512 KiB
//   500 aborted producers still in the structure  : 500 records, unreachable
//                                                   to GC until a pop walked
//                                                   past them
const { AsyncQueue } = require(process.argv[2] || '../dist/index.js');

if (typeof global.gc !== 'function') {
  console.error('run with --expose-gc');
  process.exit(2);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const heap = () => { global.gc(); global.gc(); global.gc(); return process.memoryUsage().heapUsed; };
const store = q => {
  const w = q.waitingProducers;
  return Array.isArray(w)
    ? { kind: 'array', capacity: w.length }
    : { kind: 'list', capacity: null, live: w.size };
};
const describeCapacity = s =>
  s.kind === 'array'
    ? `${s.capacity} array slots (~${(s.capacity * 8 / 1024).toFixed(1)} KiB of pointers)`
    : 'no backing store (linked list)';

(async () => {
  // --- A: idle cost of an empty queue --------------------------------------
  {
    const COUNT = 2000;
    const before = heap();
    const qs = [];
    for (let i = 0; i < COUNT; i++) qs.push(new AsyncQueue(1));
    const after = heap();
    console.log(`A idle heap per empty AsyncQueue(1)        : ${((after - before) / COUNT / 1024).toFixed(3)} KiB`);
    qs.length = 0;
  }

  // --- B: retention after a burst of 50k transient producers ---------------
  {
    const N = 50000;
    let q = new AsyncQueue(1);
    await q.enqueue('seed');
    let producers = [];
    for (let i = 0; i < N; i++) producers.push(q.enqueue(i).catch(() => {}));
    await sleep(50);
    console.log(`B waiter storage at ${N} concurrency    : ${describeCapacity(store(q))}`);
    console.log(`B waitingProducerCount at peak            : ${q.waitingProducerCount}`);

    while (q.waitingProducerCount > 0 || q.size > 0) await q.dequeue();
    await Promise.allSettled(producers);
    producers = null;                       // drop every promise reference
    await sleep(50);

    console.log(`B waiter storage after a FULL drain       : ${describeCapacity(store(q))}`);
    console.log(`B waitingProducerCount after drain        : ${q.waitingProducerCount}`);

    // Heap held by the drained queue ALONE: measure with it reachable, then
    // drop the only reference and measure again. The difference is what the
    // burst left behind.
    q.close();
    const withQueue = heap();
    q = null;
    const withoutQueue = heap();
    console.log(`B heap retained by the drained queue      : ${((withQueue - withoutQueue) / 1024).toFixed(1)} KiB`);
  }

  // --- C: cancelled waiters and metric accuracy ----------------------------
  // Needs the AbortSignal support added in 80750d3. Against the original build
  // this section never completes (nothing can cancel a blocked producer there),
  // which is itself the point: there was no way to leave the waiter queue early
  // at all, so there was nothing to unlink.
  {
    const q = new AsyncQueue(1);
    await q.enqueue('seed');
    const controllers = Array.from({ length: 500 }, () => new AbortController());
    const cancelled = controllers.map((c, i) => q.enqueue(i, { signal: c.signal }).catch(() => {}));
    const survivor = q.enqueue('SURVIVOR').catch(() => {});
    await sleep(20);
    console.log(`C waitingProducerCount, 501 blocked       : ${q.waitingProducerCount}`);

    for (const c of controllers) c.abort();
    await Promise.all(cancelled);
    const s = store(q);
    console.log(`C waitingProducerCount, 500 aborted       : ${q.waitingProducerCount} (live)`);
    console.log(`C records still held by the structure     : ${s.kind === 'array' ? 'up to ' + s.capacity + ' slots, corpses included' : '1 (corpses unlinked on abort)'}`);
    console.log(`C next item out of the queue              : ${await q.dequeue()}, then ${await q.dequeue()}`);
    await survivor;
    q.close();
  }

  process.exit(0);
})();
