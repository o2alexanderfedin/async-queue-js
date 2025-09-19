/**
 * Benchmark.js-style performance testing for AsyncQueue
 * JavaScript version - compiled from TypeScript
 */

const { AsyncQueue } = require('../dist/index');

class SimpleBenchmark {
  constructor() {
    this.results = [];
  }

  async add(name, fn, options = {
    minSamples: 5,
    minTime: 1000,
    maxTime: 5000,
  }) {
    console.log(`Running: ${name}...`);

    const samples = [];
    const startTime = Date.now();

    // Warm-up
    for (let i = 0; i < 10; i++) {
      await fn();
    }

    // Run until we have enough samples or time
    while (samples.length < options.minSamples ||
           (Date.now() - startTime < options.minTime && samples.length < 100)) {

      if (Date.now() - startTime > options.maxTime) break;

      const start = process.hrtime.bigint();
      await fn();
      const end = process.hrtime.bigint();

      const duration = Number(end - start) / 1_000_000; // Convert to ms
      samples.push(duration);
    }

    // Calculate statistics
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    const variance = samples.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / samples.length;
    const stdDev = Math.sqrt(variance);
    const rme = (stdDev / mean) * 100;
    const hz = 1000 / mean;
    const ops = Math.round(hz);

    const result = {
      name,
      ops,
      hz,
      rme,
      mean,
      samples,
    };

    this.results.push(result);

    console.log(`  ${ops.toLocaleString()} ops/sec (±${rme.toFixed(2)}%) - ${samples.length} samples`);

    return result;
  }

  printSummary() {
    console.log('\n=== Benchmark Summary ===\n');

    const sorted = [...this.results].sort((a, b) => b.hz - a.hz);

    console.log('Ranked by performance:');
    sorted.forEach((result, index) => {
      console.log(`${index + 1}. ${result.name}`);
      console.log(`   ${result.ops.toLocaleString()} ops/sec (±${result.rme.toFixed(2)}%)`);
      console.log(`   Mean time: ${result.mean.toFixed(3)}ms`);
      console.log(`   Samples: ${result.samples.length}\n`);
    });

    const fastest = sorted[0];
    const slowest = sorted[sorted.length - 1];

    console.log(`Fastest: ${fastest.name} (${fastest.ops.toLocaleString()} ops/sec)`);
    console.log(`Slowest: ${slowest.name} (${slowest.ops.toLocaleString()} ops/sec)`);
    console.log(`Ratio: ${(fastest.hz / slowest.hz).toFixed(2)}x faster\n`);
  }
}

async function runBenchmarks() {
  console.log('=== AsyncQueue Performance Benchmark ===\n');
  console.log('Using Benchmark.js-style methodology');
  console.log('Each test includes warm-up and statistical analysis\n');

  const bench = new SimpleBenchmark();

  // Test 1: Simple enqueue
  await bench.add('Enqueue (empty queue)', async () => {
    const queue = new AsyncQueue(100);
    await queue.enqueue(42);
  });

  // Test 2: Simple dequeue
  await bench.add('Dequeue (pre-filled)', async () => {
    const queue = new AsyncQueue(100);
    for (let i = 0; i < 100; i++) {
      await queue.enqueue(i);
    }
    await queue.dequeue();
  });

  // Test 3: Enqueue-Dequeue cycle
  const cycleQueue = new AsyncQueue(100);
  await bench.add('Enqueue+Dequeue cycle', async () => {
    await cycleQueue.enqueue(42);
    await cycleQueue.dequeue();
  });

  // Test 4: Concurrent operations
  await bench.add('Concurrent (2P/2C)', async () => {
    const queue = new AsyncQueue(10);
    const promises = [];

    // 2 Producers
    for (let p = 0; p < 2; p++) {
      promises.push((async () => {
        for (let i = 0; i < 5; i++) {
          await queue.enqueue(i);
        }
      })());
    }

    // 2 Consumers
    for (let c = 0; c < 2; c++) {
      promises.push((async () => {
        for (let i = 0; i < 5; i++) {
          await queue.dequeue();
        }
      })());
    }

    await Promise.all(promises);
  });

  // Test 5: High contention
  await bench.add('High contention (buffer=2)', async () => {
    const queue = new AsyncQueue(2);

    await Promise.all([
      (async () => {
        for (let i = 0; i < 10; i++) {
          await queue.enqueue(i);
        }
      })(),
      (async () => {
        for (let i = 0; i < 10; i++) {
          await queue.dequeue();
        }
      })()
    ]);
  });

  // Test 6: Burst pattern
  await bench.add('Burst pattern', async () => {
    const queue = new AsyncQueue(50);

    // Enqueue burst
    const enqueuePromises = [];
    for (let i = 0; i < 20; i++) {
      enqueuePromises.push(queue.enqueue(i));
    }
    await Promise.all(enqueuePromises);

    // Dequeue burst
    const dequeuePromises = [];
    for (let i = 0; i < 20; i++) {
      dequeuePromises.push(queue.dequeue());
    }
    await Promise.all(dequeuePromises);
  });

  // Test 7: Single producer, multiple consumers
  await bench.add('1P/4C pattern', async () => {
    const queue = new AsyncQueue(10);

    await Promise.all([
      // 1 Producer
      (async () => {
        for (let i = 0; i < 20; i++) {
          await queue.enqueue(i);
        }
      })(),
      // 4 Consumers
      ...[1, 2, 3, 4].map(() => (async () => {
        for (let i = 0; i < 5; i++) {
          await queue.dequeue();
        }
      })())
    ]);
  });

  // Test 8: Multiple producers, single consumer
  await bench.add('4P/1C pattern', async () => {
    const queue = new AsyncQueue(10);

    await Promise.all([
      // 4 Producers
      ...[1, 2, 3, 4].map(() => (async () => {
        for (let i = 0; i < 5; i++) {
          await queue.enqueue(i);
        }
      })()),
      // 1 Consumer
      (async () => {
        for (let i = 0; i < 20; i++) {
          await queue.dequeue();
        }
      })()
    ]);
  });

  bench.printSummary();
}

// Run the benchmarks
runBenchmarks().catch(console.error);