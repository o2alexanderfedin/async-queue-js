// Aggressive randomised lost-wakeup hunt over the PURE path (no abandoned waiters).
const { AsyncQueue } = require('../dist/index.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const jitter = async () => { const k = Math.floor(Math.random()*4); for (let i=0;i<k;i++) await Promise.resolve(); if (Math.random()<0.1) await sleep(0); };

(async () => {
  let rounds = 0, hangs = 0, lost = 0, dup = 0;
  for (let r = 0; r < 400; r++) {
    const cap = 1 + (r % 7);
    const nP = 1 + (r % 5), nC = 1 + ((r*3) % 5), per = 30;
    const q = new AsyncQueue(cap);
    const seen = [];
    const useIterator = r % 2 === 0;
    const consumers = Array.from({length:nC}, () => (async () => {
      if (useIterator) { for await (const v of q) { seen.push(v); await jitter(); } }
      else { while (true) { const v = await q.dequeue(); if (v === undefined) return; seen.push(v); await jitter(); } }
    })());
    const producers = Array.from({length:nP}, (_,p) => (async () => {
      for (let i=0;i<per;i++) { await q.enqueue(p*100000+i); await jitter(); }
    })());
    await Promise.all(producers);
    q.close();
    const res = await Promise.race([Promise.all(consumers).then(()=> 'ok'), sleep(4000).then(()=>'HANG')]);
    rounds++;
    if (res === 'HANG') { hangs++; continue; }
    if (seen.length !== nP*per) lost++;
    if (new Set(seen).size !== seen.length) dup++;
  }
  console.log(`rounds=${rounds} hangs=${hangs} lostItems=${lost} duplicates=${dup}`);
  console.log(hangs===0 && lost===0 && dup===0 ? 'NO lost wakeup found in the pure path' : 'DEFECT FOUND');
})();
