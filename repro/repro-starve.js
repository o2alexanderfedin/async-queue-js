const { AsyncQueue } = require('../dist/index.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const q = new AsyncQueue(1);
  await q.enqueue('seed');
  const t0 = Date.now();
  let firstMs = null;
  const first = q.enqueue('FIRST').then(() => { firstMs = Date.now() - t0; }, () => {});
  let stop = false, laterCompleted = 0;
  const churn = (async () => {
    const inflight = [];
    while (!stop) { inflight.push(q.enqueue('later').then(() => laterCompleted++, () => {})); await sleep(0); }
    await Promise.allSettled(inflight);
  })();
  const drainer = (async () => { while (!stop) { await q.dequeue(); await sleep(0); } })();
  await sleep(2000);
  stop = true; await sleep(20); q.close();
  await Promise.allSettled([first, churn, drainer]);
  console.log('later producers completed in 2s :', laterCompleted);
  console.log('FIRST producer completed at     :', firstMs === null ? 'NEVER (starved 2000ms+)' : firstMs + 'ms');
  process.exit(0);
})();
