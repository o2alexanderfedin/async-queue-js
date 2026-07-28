// Measures resident heap cost of an *empty* AsyncQueue as a function of maxSize,
// and heap cost as a function of the number of messages passed through.
// Run with: node --expose-gc repro-memory.js
const { AsyncQueue } = require('../dist/cjs/index.js');

function heap() {
  global.gc(); global.gc(); global.gc();
  return process.memoryUsage().heapUsed;
}

console.log('--- A: memory vs maxSize (queue is EMPTY the whole time) ---');
const sizes = [1, 1e3, 1e4, 1e5, 1e6, 1e7];
for (const n of sizes) {
  const before = heap();
  const qs = [];
  for (let i = 0; i < 4; i++) qs.push(new AsyncQueue(n));
  const after = heap();
  const perQueue = (after - before) / 4;
  console.log(
    `maxSize=${String(n).padStart(9)}  bufferSlots=${String(qs[0].buffer.length).padStart(9)}` +
    `  heap/queue=${(perQueue / 1024).toFixed(1).padStart(10)} KiB` +
    `  bytes/slot=${(perQueue / qs[0].buffer.length).toFixed(2)}`
  );
  qs.length = 0;
}

console.log('\n--- B: memory vs number of MESSAGES through a fixed maxSize=16 queue ---');
(async () => {
  const q = new AsyncQueue(16);
  const consume = (async () => { while (true) { const v = await q.dequeue(); if (v === undefined) return; } })();
  const marks = [];
  for (let n = 1; n <= 1e6; n++) {
    await q.enqueue({ n });
    if (n === 1e4 || n === 1e5 || n === 1e6) marks.push([n, heap()]);
  }
  q.close(); await consume;
  const base = marks[0][1];
  for (const [n, h] of marks) {
    console.log(`messages=${String(n).padStart(8)}  heapUsed=${(h / 1024 / 1024).toFixed(2)} MiB  delta-vs-10k=${((h - base) / 1024).toFixed(1)} KiB`);
  }

  console.log('\n--- C: waiting-array high-water mark is retained forever ---');
  const q2 = new AsyncQueue(1);
  await q2.enqueue(0);
  const ps = [];
  for (let i = 0; i < 50000; i++) ps.push(q2.enqueue(i).catch(() => {}));
  console.log('waitingProducers array length at peak :', q2.waitingProducers.length);
  while (q2.waitingProducerCount > 0 || q2.size > 0) await q2.dequeue();
  await new Promise(r => setTimeout(r, 50));
  console.log('waitingProducerCount after full drain :', q2.waitingProducerCount);
  console.log('waitingProducers array length after   :', q2.waitingProducers.length, '<- never shrinks');
  await Promise.all(ps);
})();
