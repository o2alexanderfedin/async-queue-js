const { AsyncQueue } = require('./dist/index.js');

async function runBenchmark() {
  console.log('=== AsyncQueue Performance Benchmark ===\n');

  const iterations = 100000;
  const queue = new AsyncQueue(100);

  // Test 1: Enqueue speed
  const start1 = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) {
    await queue.enqueue(i);
    await queue.dequeue();
  }
  const end1 = process.hrtime.bigint();
  const ms1 = Number(end1 - start1) / 1_000_000;
  const ops1 = Math.round((iterations * 2) / (ms1 / 1000));

  console.log(`Sequential enqueue/dequeue (${iterations} cycles):`);
  console.log(`  Time: ${ms1.toFixed(2)}ms`);
  console.log(`  Throughput: ${ops1.toLocaleString()} ops/sec\n`);

  // Test 2: Concurrent
  const start2 = process.hrtime.bigint();
  await Promise.all([
    (async () => {
      for (let i = 0; i < iterations; i++) {
        await queue.enqueue(i);
      }
    })(),
    (async () => {
      for (let i = 0; i < iterations; i++) {
        await queue.dequeue();
      }
    })()
  ]);
  const end2 = process.hrtime.bigint();
  const ms2 = Number(end2 - start2) / 1_000_000;
  const ops2 = Math.round((iterations * 2) / (ms2 / 1000));

  console.log(`Concurrent producer/consumer (${iterations} items):`);
  console.log(`  Time: ${ms2.toFixed(2)}ms`);
  console.log(`  Throughput: ${ops2.toLocaleString()} ops/sec\n`);

  // Test 3: High contention
  const queue2 = new AsyncQueue(10);
  const start3 = process.hrtime.bigint();
  await Promise.all([
    (async () => {
      for (let i = 0; i < 10000; i++) {
        await queue2.enqueue(i);
      }
    })(),
    (async () => {
      for (let i = 0; i < 10000; i++) {
        await queue2.dequeue();
      }
    })()
  ]);
  const end3 = process.hrtime.bigint();
  const ms3 = Number(end3 - start3) / 1_000_000;
  const ops3 = Math.round(20000 / (ms3 / 1000));

  console.log(`High contention (10K items, buffer=10):`);
  console.log(`  Time: ${ms3.toFixed(2)}ms`);
  console.log(`  Throughput: ${ops3.toLocaleString()} ops/sec\n`);

  console.log('=== Summary ===');
  console.log(`Peak throughput: ${Math.max(ops1, ops2, ops3).toLocaleString()} ops/sec`);
  console.log(`Average: ${Math.round((ops1 + ops2 + ops3) / 3).toLocaleString()} ops/sec`);
}

runBenchmark().catch(console.error);