const { AsyncQueue } = require('../dist/index.js');
const cases = [
  1, 2, 3, 4, 1023, 1024, 1025,
  2**29, 2**29+1, 2**30-1, 2**30, 2**30+1, 2**31-1, 2**31, 2**31+1,
  2**32, 2**32+1, 2**40, Number.MAX_SAFE_INTEGER, Infinity, NaN, 2.5, 1.5, -0
];
for (const n of cases) {
  let r;
  try {
    const q = new AsyncQueue(n);
    const slots = q.buffer.length;
    r = slots >= n ? `OK  slots=${slots}` : `*** BROKEN: slots=${slots} < maxSize=${n}`;
  } catch (e) { r = `*** THROWS: ${e.constructor.name}: ${e.message}`; }
  console.log(String(n).padStart(20), r);
}
