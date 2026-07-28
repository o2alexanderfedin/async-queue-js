const { AsyncQueue } = require('../dist/index.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const q = new AsyncQueue(4);
  let realResolved = false, realValue;
  const real = q.dequeue().then(v => { realResolved = true; realValue = v; });  // registers first
  await sleep(1);
  const t = await Promise.race([q.dequeue(), sleep(20).then(() => 'TIMEOUT')]); // registers second, abandoned
  console.log('timed-out consumer got     :', t);
  console.log('waitingConsumerCount        :', q.waitingConsumerCount, '(1 real + 1 ghost)');
  await q.enqueue('X');
  await sleep(100);
  console.log('queue.size after enqueue(X) :', q.size, '<- item is gone');
  console.log('real consumer resolved?     :', realResolved, realValue, '<- still blocked forever');
  console.log('waitingConsumerCount now    :', q.waitingConsumerCount);
  process.exit(0);
})();
