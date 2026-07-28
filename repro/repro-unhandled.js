// Standalone, no test framework. Proves close() produces process-level
// unhandled rejections for every blocked producer.
const { AsyncQueue } = require('../dist/index.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const unhandled = [];
process.on('unhandledRejection', (reason) => unhandled.push(String(reason && reason.message)));

(async () => {
  const q = new AsyncQueue(1);
  await q.enqueue(0);
  // Fire-and-forget producers - exactly the shape of README's
  // "Multiple Producers/Consumers" example (produceData(queue, `P${i}`) is not awaited).
  for (let i = 1; i <= 5; i++) void q.enqueue(i);
  await sleep(10);
  console.log('blocked producers before close():', q.waitingProducerCount);
  q.close();
  await sleep(100);
  console.log('unhandledRejection events:', unhandled.length, unhandled);
  console.log(unhandled.length === 0 ? 'PASS' : 'FAIL: close() emitted unhandled rejections');
  process.exit(unhandled.length === 0 ? 0 : 1);
})();
