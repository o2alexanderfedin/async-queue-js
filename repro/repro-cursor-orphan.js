// D11 - the async-iterator cursor tracked only ONE in-flight next().
//
// Run: npm run build && node repro/repro-cursor-orphan.js
//
// The hand-written cursor that replaced the async generator (the D7 fix) kept a
// single `pending` waiter slot. A second next() overwrote it and orphaned the
// first waiter, which then could not be released by return()/throw()/dispose -
// the D7 teardown deadlock, reinstated - and, being still queued as a live
// consumer, absorbed the next enqueued item.
//
// Reference output from the build BEFORE the fix:
//
//   FAIL p1 settled after return()                : false
//   FAIL waiters parked after return()            : 1        <- deadlock
//   FAIL q.size after enqueue post-teardown       : 0        <- item stolen
//        p1 resolved to: {"done":false,"value":"X"}          <- through a
//                                                               torn-down iterator
const { AsyncQueue } = require('../dist/cjs/index.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let failures = 0;
  const check = (label, actual, expected) => {
    const ok = Object.is(actual, expected);
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(46)}: ${String(actual)}${ok ? '' : ` (expected ${String(expected)})`}`);
  };

  console.log('--- A: two in-flight next(), then return() ---');
  {
    const q = new AsyncQueue(4);
    const it = q[Symbol.asyncIterator]();
    let p1done = false, p2done = false;
    const p1 = it.next().then(r => { p1done = true; return r; });
    const p2 = it.next().then(r => { p2done = true; return r; });
    await sleep(5);
    check('waitingConsumerCount after 2 next()', q.waitingConsumerCount, 2);

    await it.return(undefined);
    await sleep(5);
    check('p1 settled after return()', p1done, true);
    check('p2 settled after return()', p2done, true);
    check('waiters parked after return()', q.waitingConsumerCount, 0);
    check('p1 reports done', (await p1).done, true);
  }

  console.log('--- B: a torn-down iterator must not steal a later item ---');
  {
    const q = new AsyncQueue(4);
    const it = q[Symbol.asyncIterator]();
    const p1 = it.next();
    const p2 = it.next();
    await sleep(5);
    await it.return(undefined);
    await sleep(5);

    await q.enqueue('X');
    await sleep(5);
    check('q.size after enqueue post-teardown', q.size, 1);
    const r1 = await Promise.race([p1, sleep(200).then(() => 'HANG')]);
    console.log('     p1 resolved to:', JSON.stringify(r1));
    check('p1 did not swallow X', r1 !== 'HANG' && r1.done === true, true);
    check('X is still deliverable', await q.dequeue(), 'X');
    await p2;
  }

  console.log('--- C: poll-with-timeout reaches the same state, no concurrency ---');
  {
    const q = new AsyncQueue(4);
    const it = q[Symbol.asyncIterator]();
    const first = it.next();
    await Promise.race([first, sleep(10)]);   // abandoned, not cancelled
    const second = it.next();                 // used to overwrite `pending`
    await sleep(5);
    await it.return(undefined);
    check('waiters parked after return()', q.waitingConsumerCount, 0);
    await q.enqueue('X');
    check('item survives teardown', q.size, 1);
    await first; await second;
  }

  console.log('--- D: toAsyncGenerator() and throw() have the same guarantee ---');
  {
    const q = new AsyncQueue(4);
    const g = q.toAsyncGenerator();
    const p1 = g.next(); const p2 = g.next();
    await sleep(5);
    const returned = await Promise.race([g.return(undefined).then(() => 'returned'), sleep(300).then(() => 'HANG')]);
    check('generator.return() settled', returned, 'returned');
    const r1 = await Promise.race([p1, sleep(300).then(() => 'HANG')]);
    check('first pending next() settled', r1 !== 'HANG', true);
    await p2;

    const q2 = new AsyncQueue(4);
    const it2 = q2[Symbol.asyncIterator]();
    const a = it2.next(); const b = it2.next();
    await sleep(5);
    await it2.throw(new Error('boom')).catch(() => {});
    check('throw() released every waiter', q2.waitingConsumerCount, 0);
    await a; await b;
  }

  console.log('--- E: sequential for-await is unaffected ---');
  {
    const q = new AsyncQueue(2);
    const out = [];
    const consumer = (async () => { for await (const v of q) out.push(v); })();
    for (let i = 0; i < 100; i++) await q.enqueue(i);
    q.close();
    await consumer;
    check('for-await drained everything in order', out.length === 100 && out.every((v, i) => v === i), true);
  }

  console.log(failures === 0 ? '\nPASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
