// D5 / D6 — wake ordering and liveness.
//
// Run: npm run build && node repro/repro-fairness.js
//
// Reference numbers from the ORIGINAL implementation (commit 9bc7022), which
// stored waiters in a stack and woke them LIFO:
//
//   producer wake order (maxSize=1, enqueue 1,2,3) : [0, 3, 2, 1]
//   consumer serve order (8 consumers, items 0..7) : [7, 6, 5, 4, 3, 2, 1, 0]
//   2s sustained contention                        : 1531 later producers done,
//                                                    FIRST producer NEVER woken
//   200 dequeue rounds at maxSize=1                : FIRST NEVER woken
const { AsyncQueue } = require('../dist/index.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let failures = 0;
  const check = (label, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    const ok = a === e;
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(40)}: ${a}${ok ? '' : ` (expected ${e})`}`);
  };

  console.log('--- D5: wake order ---');
  {
    const q = new AsyncQueue(1);
    await q.enqueue(0);
    const ps = [];
    for (const v of [1, 2, 3]) { ps.push(q.enqueue(v)); await sleep(1); }
    const out = [];
    for (let i = 0; i < 4; i++) { out.push(await q.dequeue()); await sleep(1); }
    await Promise.all(ps);
    check('producer wake order', out, [0, 1, 2, 3]);
  }
  {
    const q = new AsyncQueue(1);
    const got = new Array(8).fill(null);
    const cs = [];
    for (let i = 0; i < 8; i++) { cs.push(q.dequeue().then(v => { got[i] = v; })); await sleep(1); }
    for (let i = 0; i < 8; i++) await q.enqueue(i);
    await Promise.all(cs);
    check('consumer serve order', got, [0, 1, 2, 3, 4, 5, 6, 7]);
  }

  console.log('--- D6: liveness under sustained contention ---');
  {
    const q = new AsyncQueue(1);
    await q.enqueue('seed');
    const t0 = Date.now();
    let firstMs = null;
    const first = q.enqueue('FIRST').then(() => { firstMs = Date.now() - t0; }, () => {});
    let stop = false, later = 0;
    const churn = (async () => {
      const inflight = [];
      while (!stop) { inflight.push(q.enqueue('later').then(() => later++, () => {})); await sleep(0); }
      await Promise.allSettled(inflight);
    })();
    const drainer = (async () => { while (!stop) { await q.dequeue(); await sleep(0); } })();
    await sleep(2000);
    stop = true; await sleep(20); q.close();
    await Promise.allSettled([first, churn, drainer]);
    console.log(`     later producers completed in 2s        : ${later}`);
    check('FIRST producer woken', firstMs !== null, true);
    console.log(`     FIRST producer completed at            : ${firstMs === null ? 'NEVER (starved 2000ms+)' : firstMs + 'ms'}`);
  }
  {
    const q = new AsyncQueue(1);
    await q.enqueue('seed');
    let firstRound = null, firstDone = false;
    const first = q.enqueue('FIRST').then(() => { firstDone = true; }, () => {});
    const later = [];
    for (let round = 1; round <= 200; round++) {
      later.push(q.enqueue('later' + round).catch(() => {}));
      await sleep(0);
      await q.dequeue();
      await sleep(0);
      if (firstRound === null && firstDone) firstRound = round;
    }
    q.close();
    await Promise.allSettled([first, ...later]);
    check('FIRST woken at dequeue round', firstRound, 1);
  }

  console.log(failures === 0 ? '\nALL OK' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
