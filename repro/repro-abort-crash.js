// D10 - the cancellation support re-opened the D1 process kill.
//
// Run: npm run build && node repro/repro-abort-crash.js
//
// D1 suppressed the rejection close() delivers to a blocked producer. Adding
// AbortSignal support introduced a SECOND way to reject that same promise, and
// it was not suppressed. `void queue.enqueue(x, { signal })` is the natural
// fire-and-forget shape for a cancellable producer; aborting it raised one
// unhandled rejection per blocked producer.
//
// Against the build BEFORE the fix, part B does not print at all - the process
// is dead:
//
//   node:internal/per_context/domexception:53
//   DOMException [AbortError]: This operation was aborted
//       at AbortController.abort (node:internal/abort_controller:467:18)
const { AsyncQueue } = require('../dist/cjs/index.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const unhandled = [];
process.on('unhandledRejection', reason => unhandled.push(String(reason && reason.name)));

(async () => {
  let failures = 0;
  const check = (label, actual, expected) => {
    const ok = Object.is(actual, expected);
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(46)}: ${String(actual)}${ok ? '' : ` (expected ${String(expected)})`}`);
  };

  console.log('--- A: abort blocked fire-and-forget producers ---');
  {
    const q = new AsyncQueue(1);
    await q.enqueue(0);
    const controllers = [];
    for (let i = 1; i <= 5; i++) {
      const c = new AbortController();
      controllers.push(c);
      void q.enqueue(i, { signal: c.signal });   // no handler attached anywhere
    }
    await sleep(10);
    check('blocked producers before abort', q.waitingProducerCount, 5);
    for (const c of controllers) c.abort();
    await sleep(100);
    check('waiters released', q.waitingProducerCount, 0);
    check('unhandledRejection events', unhandled.length, 0);
  }

  console.log('--- B: already-aborted signal on a full queue ---');
  {
    const q = new AsyncQueue(1);
    await q.enqueue(0);
    const c = new AbortController();
    c.abort();
    void q.enqueue(1, { signal: c.signal });     // rejects synchronously
    await sleep(100);
    check('unhandledRejection events, cumulative', unhandled.length, 0);
  }

  console.log('--- C: suppression must not consume the rejection ---');
  {
    const q = new AsyncQueue(1);
    await q.enqueue(0);
    const c = new AbortController();
    const blocked = q.enqueue(1, { signal: c.signal });
    await sleep(5);
    c.abort();
    const name = await blocked.then(() => 'RESOLVED', e => e.name);
    check('awaiting caller still sees the abort', name, 'AbortError');
    const again = await blocked.then(() => 'RESOLVED', e => e.name);
    check('a second handler sees it too', again, 'AbortError');
  }

  console.log(failures === 0 ? '\nPASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
