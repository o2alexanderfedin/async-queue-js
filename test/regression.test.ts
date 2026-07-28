/**
 * Regression tests for the defects fixed in this branch, plus the new API
 * surface those fixes introduced. Each block names the defect it pins down.
 */
import { AsyncQueue, DequeueResult } from '../src/index';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

describe('D1: close() must not produce unhandled rejections', () => {
  test('a fire-and-forget producer rejected by close() is not reported globally', async () => {
    const seen: unknown[] = [];
    const onUnhandled = (r: unknown) => seen.push(r);
    process.on('unhandledRejection', onUnhandled);
    try {
      const q = new AsyncQueue<number>(1);
      await q.enqueue(1);
      for (let i = 0; i < 25; i++) void q.enqueue(i);   // no handler attached anywhere
      await sleep(5);
      expect(q.waitingProducerCount).toBe(25);
      q.close();
      await sleep(50);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(seen).toEqual([]);
  });

  test('a fire-and-forget enqueue on an already-closed queue is not reported globally', async () => {
    const seen: unknown[] = [];
    const onUnhandled = (r: unknown) => seen.push(r);
    process.on('unhandledRejection', onUnhandled);
    try {
      const q = new AsyncQueue<number>(4);
      q.close();
      void q.enqueue(1);
      void q.enqueue(2);
      await sleep(50);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(seen).toEqual([]);
  });

  test('suppression does not consume the rejection: awaiting callers still see it', async () => {
    const q = new AsyncQueue<number>(1);
    await q.enqueue(1);
    const blocked = q.enqueue(2);
    q.close();
    await expect(blocked).rejects.toThrow('Queue is closed');
    // and a second, independent handler on the same promise also sees it
    await expect(blocked).rejects.toThrow('Queue is closed');
  });

  test('onDropped observes every dropped item with its error', async () => {
    const dropped: Array<[string, number]> = [];
    const q = new AsyncQueue<number>(1, {
      onDropped: (error, item) => dropped.push([error.message, item])
    });

    await q.enqueue(1);
    void q.enqueue(2);          // blocks, then dropped by close()
    void q.enqueue(3);          // blocks, then dropped by close()
    await sleep(5);
    expect(dropped).toEqual([]);  // nothing dropped yet

    q.close();
    await sleep(5);
    expect(dropped.map(d => d[1]).sort()).toEqual([2, 3]);
    expect(dropped.every(d => d[0] === 'Queue is closed')).toBe(true);

    void q.enqueue(4);          // rejected synchronously on a closed queue
    await sleep(5);
    expect(dropped.map(d => d[1]).sort()).toEqual([2, 3, 4]);
  });

  test('a throwing onDropped hook is contained, not propagated', async () => {
    const logged: unknown[] = [];
    const spy = jest.spyOn(console, 'error').mockImplementation((...args) => { logged.push(args); });
    try {
      const seen: unknown[] = [];
      const onUnhandled = (r: unknown) => seen.push(r);
      process.on('unhandledRejection', onUnhandled);
      try {
        const q = new AsyncQueue<number>(1, {
          onDropped: () => { throw new Error('hook exploded'); }
        });
        await q.enqueue(1);
        const blocked = q.enqueue(2);
        q.close();
        await expect(blocked).rejects.toThrow('Queue is closed');
        expect(await q.dequeue()).toBe(1);   // surviving item is still drainable
        await sleep(20);
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
      expect(seen).toEqual([]);             // a broken hook still cannot kill the host
      expect(logged).toHaveLength(1);       // but it is not swallowed either
    } finally {
      spy.mockRestore();
    }
  });
});

describe('D2: undefined must not double as the end-of-stream sentinel', () => {
  test('dequeueResult() separates a real undefined payload from end of stream', async () => {
    const q = new AsyncQueue<number | undefined>(4);
    await q.enqueue(undefined);
    q.close();

    const first = await q.dequeueResult();
    expect(first.done).toBe(false);
    expect(first.value).toBeUndefined();      // a payload, not the end

    const second = await q.dequeueResult();
    expect(second.done).toBe(true);           // now it really is the end
    expect(second.value).toBeUndefined();
  });

  test('an all-undefined stream survives every consumer entry point', async () => {
    const holes = [undefined, undefined, undefined];

    const viaIterator = new AsyncQueue<undefined>(4);
    for (const h of holes) await viaIterator.enqueue(h);
    viaIterator.close();
    const collected: undefined[] = [];
    for await (const v of viaIterator) collected.push(v);
    expect(collected).toHaveLength(3);

    const viaDrain = new AsyncQueue<undefined>(4);
    for (const h of holes) await viaDrain.enqueue(h);
    viaDrain.close();
    expect(await viaDrain.drain()).toHaveLength(3);

    const viaTake = new AsyncQueue<undefined>(4);
    for (const h of holes) await viaTake.enqueue(h);
    expect(await viaTake.take(3)).toHaveLength(3);   // still OPEN, must not truncate

    const viaGenerator = new AsyncQueue<undefined>(4);
    for (const h of holes) await viaGenerator.enqueue(h);
    viaGenerator.close();
    const fromGen: undefined[] = [];
    for await (const v of viaGenerator.toAsyncGenerator()) fromGen.push(v);
    expect(fromGen).toHaveLength(3);

    const viaIterate = new AsyncQueue<undefined>(4);
    for (const h of holes) await viaIterate.enqueue(h);
    viaIterate.close();
    const fromIterate: undefined[] = [];
    for await (const v of viaIterate.iterate()) fromIterate.push(v);
    expect(fromIterate).toHaveLength(3);
  });

  test('undefined payloads interleaved with real ones keep their positions', async () => {
    const q = new AsyncQueue<number | undefined>(8);
    const input = [1, undefined, 2, undefined, undefined, 3];
    for (const v of input) await q.enqueue(v);
    q.close();
    expect(await q.drain()).toEqual(input);
  });

  test('dequeueResult() blocks like dequeue() and resolves done on close', async () => {
    const q = new AsyncQueue<number>(4);
    let settled: DequeueResult<number> | null = null;
    const pending = q.dequeueResult().then(r => { settled = r; return r; });
    await sleep(10);
    expect(settled).toBeNull();
    expect(q.waitingConsumerCount).toBe(1);

    q.close();
    const result = await pending;
    expect(result.done).toBe(true);
  });

  test('dequeue() keeps its old ambiguous signature for existing callers', async () => {
    const q = new AsyncQueue<number>(4);
    await q.enqueue(7);
    q.close();
    expect(await q.dequeue()).toBe(7);
    expect(await q.dequeue()).toBeUndefined();   // end of stream, as before
  });
});

describe('D3: cancellation — a cancelled waiter neither consumes a wake nor inserts', () => {
  test('a cancelled consumer does not absorb the next item', async () => {
    const q = new AsyncQueue<string>(4);
    const controller = new AbortController();

    const cancelled = q.dequeue({ signal: controller.signal });
    await sleep(1);
    const live = q.dequeue();                 // registered SECOND, so FIFO would serve it last
    await sleep(1);
    expect(q.waitingConsumerCount).toBe(2);

    controller.abort();
    await expect(cancelled).rejects.toThrow(/aborted/i);
    expect(q.waitingConsumerCount).toBe(1);   // released immediately, not lazily

    await q.enqueue('X');
    expect(await live).toBe('X');             // the wake was not consumed by the corpse
    expect(q.size).toBe(0);
  });

  test('a cancelled consumer in the MIDDLE of the queue is skipped', async () => {
    const q = new AsyncQueue<number>(8);
    const controller = new AbortController();

    const first = q.dequeue();
    await sleep(1);
    const middle = q.dequeue({ signal: controller.signal });
    await sleep(1);
    const last = q.dequeue();
    await sleep(1);
    expect(q.waitingConsumerCount).toBe(3);

    controller.abort();
    await expect(middle).rejects.toThrow(/aborted/i);
    expect(q.waitingConsumerCount).toBe(2);

    await q.enqueue(1);
    await q.enqueue(2);
    expect(await first).toBe(1);
    expect(await last).toBe(2);
    expect(q.waitingConsumerCount).toBe(0);
  });

  test('a cancelled producer never inserts its item', async () => {
    const q = new AsyncQueue<string>(1);
    await q.enqueue('A');
    const controller = new AbortController();

    const cancelled = q.enqueue('GHOST', { signal: controller.signal });
    await sleep(1);
    expect(q.waitingProducerCount).toBe(1);

    controller.abort();
    await expect(cancelled).rejects.toThrow(/aborted/i);
    expect(q.waitingProducerCount).toBe(0);

    expect(await q.dequeue()).toBe('A');
    await sleep(5);
    expect(q.size).toBe(0);                   // GHOST never reached the buffer

    // The queue is still fully usable afterwards.
    await q.enqueue('B');
    expect(await q.dequeue()).toBe('B');
  });

  test('an already-aborted signal rejects without ever registering a waiter', async () => {
    const q = new AsyncQueue<number>(1);
    const controller = new AbortController();
    controller.abort();

    await expect(q.dequeue({ signal: controller.signal })).rejects.toThrow(/aborted/i);
    expect(q.waitingConsumerCount).toBe(0);

    await q.enqueue(1);                       // fill it so the next enqueue must block
    await expect(q.enqueue(2, { signal: controller.signal })).rejects.toThrow(/aborted/i);
    expect(q.waitingProducerCount).toBe(0);
    expect(q.size).toBe(1);
  });

  test('a signal is only consulted when the call actually has to block', async () => {
    const q = new AsyncQueue<number>(4);
    const controller = new AbortController();
    controller.abort();

    // Room available -> never suspends -> the aborted signal is irrelevant.
    await expect(q.enqueue(1, { signal: controller.signal })).resolves.toBeUndefined();
    // Item available -> never suspends -> likewise.
    expect(await q.dequeue({ signal: controller.signal })).toBe(1);
  });

  test('signal.reason is used as the rejection reason when present', async () => {
    const q = new AsyncQueue<number>(4);
    const controller = new AbortController();
    const reason = new Error('caller gave up');

    const pending = q.dequeue({ signal: controller.signal });
    await sleep(1);
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  test('aborting after the call already settled is a no-op', async () => {
    const q = new AsyncQueue<number>(4);
    const controller = new AbortController();

    const pending = q.dequeue({ signal: controller.signal });
    await sleep(1);
    await q.enqueue(42);
    expect(await pending).toBe(42);
    expect(q.waitingConsumerCount).toBe(0);

    controller.abort();                       // listener must already be detached
    await sleep(5);
    expect(q.waitingConsumerCount).toBe(0);
    await q.enqueue(43);
    expect(await q.dequeue()).toBe(43);
  });

  test('dequeueResult() honours the same signal contract', async () => {
    const q = new AsyncQueue<number>(4);
    const controller = new AbortController();
    const pending = q.dequeueResult({ signal: controller.signal });
    await sleep(1);
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/i);
    expect(q.waitingConsumerCount).toBe(0);
  });
});

describe('D5/D6: FIFO across blocked producers and consumers', () => {
  test('blocked producers are woken in call order', async () => {
    const q = new AsyncQueue<number>(1);
    await q.enqueue(0);

    const pending = [1, 2, 3, 4, 5].map(async n => { await q.enqueue(n); return n; });
    await sleep(5);
    expect(q.waitingProducerCount).toBe(5);

    const out: number[] = [];
    for (let i = 0; i < 6; i++) out.push((await q.dequeue())!);
    await Promise.all(pending);
    expect(out).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test('waiting consumers are served in call order', async () => {
    const q = new AsyncQueue<number>(4);
    const order: number[] = [];
    const consumers = [0, 1, 2, 3].map(async id => {
      const v = await q.dequeue();
      order.push(id);
      return v;
    });
    await sleep(5);
    expect(q.waitingConsumerCount).toBe(4);

    for (let i = 10; i < 14; i++) await q.enqueue(i);
    expect(await Promise.all(consumers)).toEqual([10, 11, 12, 13]);
    expect(order).toEqual([0, 1, 2, 3]);
  });

  test('the earliest blocked producer is not starved by later arrivals', async () => {
    const q = new AsyncQueue<string>(1);
    await q.enqueue('seed');

    let firstDone = false;
    const first = q.enqueue('FIRST').then(() => { firstDone = true; });

    let stop = false;
    const inflight: Promise<void>[] = [];
    const churn = (async () => {
      while (!stop) { inflight.push(q.enqueue('later').catch(() => {})); await sleep(0); }
    })();
    const drainer = (async () => {
      while (!stop) { await q.dequeue(); await sleep(0); }
    })();

    await sleep(200);
    expect(firstDone).toBe(true);

    stop = true;
    await sleep(10);
    q.close();
    await Promise.allSettled([first, churn, drainer, ...inflight]);
  });
});

describe('direct handoff', () => {
  test('an item goes straight to a waiting consumer without touching the buffer', async () => {
    const q = new AsyncQueue<number>(4);
    const waiting = q.dequeue();
    await sleep(1);
    expect(q.waitingConsumerCount).toBe(1);

    void q.enqueue(42);
    expect(q.size).toBe(0);                   // never buffered
    expect(await waiting).toBe(42);
  });

  test('handoff still respects capacity for the buffered path', async () => {
    const q = new AsyncQueue<number>(2);
    await q.enqueue(1);
    await q.enqueue(2);
    expect(q.isFull).toBe(true);
    let settled = false;
    const blocked = q.enqueue(3).then(() => { settled = true; });
    await sleep(10);
    expect(settled).toBe(false);
    expect(q.size).toBe(2);
    expect(await q.dequeue()).toBe(1);
    await blocked;
    expect(q.size).toBe(2);
  });
});
