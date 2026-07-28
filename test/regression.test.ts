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
