import { AsyncQueue } from '../src/index';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const raceTimeout = <T>(p: Promise<T>, ms: number, tag = 'HUNG') =>
  Promise.race([p, sleep(ms).then(() => tag as any)]);

describe('DEFECT: abandoned PRODUCER waiter still delivers its item later', () => {
  test('an enqueue that the caller timed out still lands in the queue afterwards', async () => {
    const q = new AsyncQueue<string>(1);
    await q.enqueue('A');                       // full

    // Caller gives up on this enqueue after 20ms.
    const outcome = await Promise.race([
      q.enqueue('GHOST').then(() => 'enqueued', () => 'rejected'),
      sleep(20).then(() => 'TIMEOUT')
    ]);
    expect(outcome).toBe('TIMEOUT');

    // Consumer drains. The abandoned producer wakes up and inserts 'GHOST'
    // even though its caller has long since moved on.
    expect(await q.dequeue()).toBe('A');
    await sleep(10);
    expect(q.size).toBe(0);                     // nothing should have been inserted
  });
});

describe('DEFECT: no cancellation — an abandoned async iterator cannot be released', () => {
  test('generator.return() while suspended in dequeue() hangs until close()', async () => {
    const q = new AsyncQueue<number>(4);
    const it = q.iterate()[Symbol.asyncIterator]() as AsyncGenerator<number>;
    const pending = it.next();
    await sleep(5);

    const ret = it.return(undefined as any);
    expect(await raceTimeout(ret.then(() => 'returned'), 60)).toBe('HUNG');

    // Proof that close() is the ONLY thing that can release it:
    q.close();
    expect(await raceTimeout(ret.then(() => 'returned'), 100)).toBe('returned');
    await pending;
  });
});

describe('unhandled rejections left behind by close()', () => {
  test('close() rejects every blocked producer; unattached ones become unhandled rejections', async () => {
    const seen: any[] = [];
    const onUnhandled = (r: any) => seen.push(r);
    process.on('unhandledRejection', onUnhandled);
    try {
      const q = new AsyncQueue<number>(1);
      await q.enqueue(1);
      // Fire-and-forget producers, the shape used in every README multi-producer example.
      void q.enqueue(2);
      void q.enqueue(3);
      await sleep(5);
      expect(q.waitingProducerCount).toBe(2);
      q.close();
      await sleep(50);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(seen.map(e => e?.message)).toEqual([]);
  });
});

describe('harder lost-wakeup / close-race hunt', () => {
  test('close() racing blocked producers and waiting consumers: no hang, no double delivery', async () => {
    for (let round = 0; round < 60; round++) {
      const q = new AsyncQueue<number>(1 + (round % 3));
      const delivered: number[] = [];
      const producers = Array.from({ length: 6 }, (_, p) => (async () => {
        for (let i = 0; i < 30; i++) {
          try { await q.enqueue(p * 1000 + i); } catch { return; }
        }
      })());
      const consumers = Array.from({ length: 6 }, () => (async () => {
        while (true) {
          const v = await q.dequeue();
          if (v === undefined) return;
          delivered.push(v);
        }
      })());
      await sleep(round % 4);
      q.close();
      const r = await raceTimeout(Promise.all([...producers, ...consumers]), 3000, 'HUNG');
      expect(r).not.toBe('HUNG');
      expect(new Set(delivered).size).toBe(delivered.length);   // no duplicates
    }
  }, 60000);

  test('single-slot ping-pong with interleaved close never loses a wakeup', async () => {
    for (let round = 0; round < 200; round++) {
      const q = new AsyncQueue<number>(1);
      let got = 0;
      const consumer = (async () => {
        while (true) { const v = await q.dequeue(); if (v === undefined) return; got++; }
      })();
      const producer = (async () => {
        for (let i = 0; i < 20; i++) { try { await q.enqueue(i); } catch { return; } }
        q.close();
      })();
      const r = await raceTimeout(Promise.all([producer, consumer]), 2000, 'HUNG');
      expect(r).not.toBe('HUNG');
      expect(got).toBe(20);
    }
  }, 60000);
});

describe('misc API edges', () => {
  test('take(n) with a negative n', async () => {
    const q = new AsyncQueue<number>(4);
    await q.enqueue(1);
    expect(await q.take(-5)).toEqual([]);
  });

  test('isFull/isEmpty/size stay consistent with the buffer under wraparound', async () => {
    const q = new AsyncQueue<number>(3);   // buffer length 4, maxSize 3
    for (let cycle = 0; cycle < 10; cycle++) {
      await q.enqueue(cycle * 3 + 1);
      await q.enqueue(cycle * 3 + 2);
      await q.enqueue(cycle * 3 + 3);
      expect(q.isFull).toBe(true);
      expect(await q.dequeue()).toBe(cycle * 3 + 1);
      expect(await q.dequeue()).toBe(cycle * 3 + 2);
      expect(await q.dequeue()).toBe(cycle * 3 + 3);
      expect(q.isEmpty).toBe(true);
    }
  });

  test('capacity reports maxSize but the queue silently reserves the next power of two', () => {
    const q: any = new AsyncQueue<number>(1000);
    expect(q.capacity).toBe(1000);
    expect(q.buffer.length).toBe(1024);   // 24 slots the user never asked for
  });
});
