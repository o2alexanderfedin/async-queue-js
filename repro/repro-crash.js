// No unhandledRejection handler at all -> Node's default mode is `throw` (>=15).
const { AsyncQueue } = require('../dist/index.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const q = new AsyncQueue(1);
  await q.enqueue(0);
  for (let i = 1; i <= 3; i++) void q.enqueue(i);   // fire-and-forget producers
  await sleep(10);
  q.close();
  await sleep(200);
  console.log('SURVIVED close()');
})();
