/**
 * D7 — aborting an async-iterator consumer must not hang.
 *
 * The failure mode is structural, not a missing null check. An `async function*`
 * services `return()` and `throw()` from an internal request queue, and a
 * generator suspended at an `await` cannot reach that queue until the await
 * settles. A cursor parked inside an empty AsyncQueue is suspended exactly
 * there, so `return()` could only settle once something resolved the parked
 * dequeue — i.e. only `close()`. Worker-pool teardown on a shared queue
 * deadlocked.
 *
 * `for await ... break` was never affected and must stay unaffected: `break`
 * only runs after a `next()` has already resolved, so the cursor is not parked
 * at that moment.
 *
 * Measured before the fix:
 *   queue[Symbol.asyncIterator]().return()  -> settled (fixed in 80750d3)
 *   queue.toAsyncGenerator().return()       -> HUNG (300ms timeout), waiter still parked
 */
import { AsyncQueue } from '../src/index';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const raceTimeout = <T>(p: Promise<T>, ms: number, tag = 'HUNG') =>
  Promise.race([p, sleep(ms).then(() => tag as any)]);

// Every iteration entry point on the class, so none of them can regress
// independently of the others.
const cursors: Array<[string, (q: AsyncQueue<number>) => AsyncGenerator<number>]> = [
  ['[Symbol.asyncIterator]()', q => q[Symbol.asyncIterator]() as AsyncGenerator<number>],
  ['iterate()', q => q.iterate()[Symbol.asyncIterator]() as AsyncGenerator<number>],
  ['toAsyncGenerator()', q => q.toAsyncGenerator()]
];

describe.each(cursors)('D7: %s releases a parked consumer', (_name, make) => {
  test('return() settles immediately and leaves no waiter behind', async () => {
    const q = new AsyncQueue<number>(4);
    const cursor = make(q);

    const parked = cursor.next();
    parked.catch(() => {});                       // may be abandoned
    await sleep(5);
    expect(q.waitingConsumerCount).toBe(1);

    const settled = await raceTimeout(cursor.return(undefined).then(() => 'settled'), 200);
    expect(settled).toBe('settled');

    await sleep(5);
    expect(q.waitingConsumerCount).toBe(0);
    // The queue itself must survive: return() tears down ONE cursor, not the queue.
    expect(q.isClosed).toBe(false);
    await q.enqueue(7);
    expect(await q.dequeue()).toBe(7);
  });

  test('the abandoned next() resolves as end-of-iteration rather than rejecting', async () => {
    const q = new AsyncQueue<number>(4);
    const cursor = make(q);
    const parked = cursor.next();
    await sleep(5);

    await cursor.return(undefined);
    expect(await raceTimeout(parked, 200)).toEqual({ done: true, value: undefined });
  });

  test('return() reports the value it was given, and next() afterwards is done', async () => {
    const q = new AsyncQueue<number>(4);
    const cursor = make(q);
    const parked = cursor.next();
    parked.catch(() => {});
    await sleep(5);

    expect(await cursor.return('bye' as any)).toEqual({ done: true, value: 'bye' });
    expect(await cursor.next()).toEqual({ done: true, value: undefined });
  });

  test('throw() settles (as a rejection) instead of hanging, and releases the waiter', async () => {
    const q = new AsyncQueue<number>(4);
    const cursor = make(q);
    const parked = cursor.next();
    parked.catch(() => {});
    await sleep(5);

    const boom = new Error('boom');
    const outcome = await raceTimeout(
      cursor.throw(boom).then(() => 'settled', (e: Error) => `rejected:${e.message}`),
      200
    );
    expect(outcome).toBe('rejected:boom');
    await sleep(5);
    expect(q.waitingConsumerCount).toBe(0);
    expect(q.isClosed).toBe(false);
  });

  test('plain break out of for-await still works and still leaves no waiter', async () => {
    const q = new AsyncQueue<number>(4);
    await q.enqueue(1);
    await q.enqueue(2);

    const seen: number[] = [];
    const loop = (async () => {
      for await (const v of { [Symbol.asyncIterator]: () => make(q) }) {
        seen.push(v);
        if (v === 1) break;
      }
      return 'ok';
    })();

    expect(await raceTimeout(loop, 500)).toBe('ok');
    await sleep(5);
    expect(seen).toEqual([1]);
    expect(q.waitingConsumerCount).toBe(0);
    expect(q.size).toBe(1);                       // item 2 is still queued
    expect(q.isClosed).toBe(false);
  });
});

describe('D7: worker-pool teardown', () => {
  test('a pool of parked workers tears down without closing the shared queue', async () => {
    const WORKERS = 8;
    const q = new AsyncQueue<number>(2);

    const cursors = Array.from({ length: WORKERS }, () => q.toAsyncGenerator());
    const workers = cursors.map(cursor => (async () => {
      const handled: number[] = [];
      for (;;) {
        const r = await cursor.next();
        if (r.done) return handled;
        handled.push(r.value);
      }
    })());

    await sleep(20);
    expect(q.waitingConsumerCount).toBe(WORKERS);

    // Cooperative shutdown: every worker is released, the queue stays open.
    const done = await raceTimeout(
      Promise.all(cursors.map(c => c.return(undefined)))
        .then(() => Promise.all(workers))
        .then(() => 'torn down'),
      1000
    );

    expect(done).toBe('torn down');
    expect(q.waitingConsumerCount).toBe(0);
    expect(q.isClosed).toBe(false);

    // The queue is reusable by a fresh pool.
    await q.enqueue(1);
    expect(await q.dequeue()).toBe(1);
  }, 30000);

  test('tearing down half a pool leaves the other half working, in order', async () => {
    const q = new AsyncQueue<number>(1);
    const cursors = Array.from({ length: 6 }, () => q.toAsyncGenerator());
    const got: number[][] = cursors.map(() => []);
    const workers = cursors.map((cursor, i) => (async () => {
      for (;;) {
        const r = await cursor.next();
        if (r.done) return;
        got[i]!.push(r.value);
      }
    })());

    await sleep(20);
    expect(q.waitingConsumerCount).toBe(6);

    // Retire cursors 0,1,2 — they are the three at the FRONT of the wake queue.
    await Promise.all([cursors[0]!.return(undefined), cursors[1]!.return(undefined), cursors[2]!.return(undefined)]);
    await sleep(5);
    expect(q.waitingConsumerCount).toBe(3);

    // Items must now go to 3,4,5 in that order — a retired cursor must not
    // absorb one.
    for (let i = 0; i < 3; i++) await q.enqueue(i);
    q.close();
    expect(await raceTimeout(Promise.all(workers), 1000)).not.toBe('HUNG');

    expect(got[0]).toEqual([]);
    expect(got[1]).toEqual([]);
    expect(got[2]).toEqual([]);
    expect(got[3]).toEqual([0]);
    expect(got[4]).toEqual([1]);
    expect(got[5]).toEqual([2]);
  }, 30000);
});

describe('D7: toAsyncGenerator() keeps generator semantics', () => {
  test('still drives a transformation pipeline', async () => {
    const q = new AsyncQueue<number>(4);
    await q.enqueue(1);
    await q.enqueue(2);
    await q.enqueue(3);
    q.close();

    async function* double(source: AsyncGenerator<number>): AsyncGenerator<number> {
      for await (const v of source) yield v * 2;
    }

    const out: number[] = [];
    for await (const v of double(q.toAsyncGenerator())) out.push(v);
    expect(out).toEqual([2, 4, 6]);
  });

  test('return() awaits a thenable argument, as a real generator does', async () => {
    const q = new AsyncQueue<number>(4);
    const cursor = q.toAsyncGenerator();
    const r = await cursor.return(Promise.resolve('later') as any);
    expect(r).toEqual({ done: true, value: 'later' });
  });

  test('breaking out of a pipeline built on toAsyncGenerator() releases the waiter', async () => {
    const q = new AsyncQueue<number>(4);
    await q.enqueue(1);
    await q.enqueue(2);

    async function* double(source: AsyncGenerator<number>): AsyncGenerator<number> {
      for await (const v of source) yield v * 2;
    }

    const seen: number[] = [];
    const loop = (async () => {
      for await (const v of double(q.toAsyncGenerator())) {
        seen.push(v);
        if (v === 2) break;
      }
      return 'ok';
    })();

    expect(await raceTimeout(loop, 500)).toBe('ok');
    await sleep(5);
    expect(seen).toEqual([2]);
    expect(q.waitingConsumerCount).toBe(0);
  });
});
