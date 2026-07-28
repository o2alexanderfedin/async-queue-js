const { AsyncQueue } = require('../dist/cjs/index.js');
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
    // The invariant is buffer slots >= EFFECTIVE capacity. Requests above
    // AsyncQueue.MAX_CAPACITY (2^30) are documented to clamp, so compare against
    // q.capacity, not against the raw request.
    const clamped = q.capacity !== n ? ` (clamped from ${n})` : '';
    r = slots >= q.capacity
      ? `OK  slots=${slots} capacity=${q.capacity}${clamped}`
      : `*** BROKEN: slots=${slots} < capacity=${q.capacity}`;
  } catch (e) { r = `*** THROWS: ${e.constructor.name}: ${e.message}`; }
  console.log(String(n).padStart(20), r);
}
