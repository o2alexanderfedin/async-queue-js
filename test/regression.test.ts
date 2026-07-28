/**
 * Regression tests for the defects fixed in this branch, plus the new API
 * surface those fixes introduced. Each block names the defect it pins down.
 */
import { AsyncQueue } from '../src/index';

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
