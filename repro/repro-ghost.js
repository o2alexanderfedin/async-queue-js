const { AsyncQueue } = require('../dist/index.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// D3: an abandoned dequeue() waiter must not absorb an item that a live
// consumer is still waiting for. Part A reproduces the original scenario
// (Promise.race, no signal); part B shows the supported cancellation path.
(async () => {
  let failures = 0;
  const check = (label, actual, expected) => {
    const ok = Object.is(actual, expected);
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(34)}: ${String(actual)}${ok ? '' : ` (expected ${String(expected)})`}`);
  };

  console.log('--- A: abandoned via Promise.race, no signal ---');
  const q = new AsyncQueue(4);
  let realResolved = false, realValue;
  const real = q.dequeue().then(v => { realResolved = true; realValue = v; });  // registers first
  await sleep(1);
  const t = await Promise.race([q.dequeue(), sleep(20).then(() => 'TIMEOUT')]); // registers second, abandoned
  check('timed-out consumer got', t, 'TIMEOUT');
  check('waitingConsumerCount (real+ghost)', q.waitingConsumerCount, 2);
  await q.enqueue('X');
  await sleep(50);
  check('queue.size after enqueue(X)', q.size, 0);          // handed straight over, never buffered
  check('real consumer resolved', realResolved, true);      // FIFO: the live waiter is served first
  check('real consumer value', realValue, 'X');
  check('waitingConsumerCount now', q.waitingConsumerCount, 1);  // the ghost is still parked
  await real;

  console.log('--- B: abandoned via AbortSignal ---');
  const q2 = new AsyncQueue(4);
  const controller = new AbortController();
  const cancelled = q2.dequeue({ signal: controller.signal }).then(
    () => 'resolved',
    e => `rejected:${e.name}`
  );
  await sleep(1);
  check('waitingConsumerCount', q2.waitingConsumerCount, 1);
  controller.abort();
  check('cancelled dequeue', await cancelled, 'rejected:AbortError');
  check('waiter released', q2.waitingConsumerCount, 0);     // no ghost left at all
  await q2.enqueue('Y');
  check('item stayed in the queue', q2.size, 1);
  check('item is intact', await q2.dequeue(), 'Y');

  console.log(failures === 0 ? 'PASS' : `FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
})();
