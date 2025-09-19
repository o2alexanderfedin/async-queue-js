import * as Benchmark from 'benchmark';
import { AsyncQueue } from '../src/index';

// Create a new benchmark suite
const suite = new Benchmark.Suite('AsyncQueue Performance');

// Setup shared variables
let queue: AsyncQueue<number>;
let filledQueue: AsyncQueue<number>;
let results: any[] = [];

// Setup function to prepare queues
async function setup() {
  queue = new AsyncQueue<number>(100);
  filledQueue = new AsyncQueue<number>(100);

  // Pre-fill the filled queue
  for (let i = 0; i < 50; i++) {
    await filledQueue.enqueue(i);
  }
}

// Main benchmark function
export async function runBenchmarks() {
  await setup();

  console.log('=== AsyncQueue Benchmark.js Performance Test ===\n');

  return new Promise((resolve) => {
    suite
      // Basic operations
      .add('Enqueue (empty queue)', {
        defer: true,
        fn: async function(deferred: any) {
          const q = new AsyncQueue<number>(100);
          await q.enqueue(42);
          deferred.resolve();
        }
      })

      .add('Enqueue (partially filled)', {
        defer: true,
        setup: async function() {
          this.queue = new AsyncQueue<number>(100);
          for (let i = 0; i < 50; i++) {
            await this.queue.enqueue(i);
          }
        },
        fn: async function(deferred: any) {
          await this.queue.enqueue(42);
          await this.queue.dequeue();
          deferred.resolve();
        }
      })

      .add('Dequeue (pre-filled)', {
        defer: true,
        setup: async function() {
          this.queue = new AsyncQueue<number>(100);
          for (let i = 0; i < 100; i++) {
            await this.queue.enqueue(i);
          }
        },
        fn: async function(deferred: any) {
          await this.queue.dequeue();
          await this.queue.enqueue(42);
          deferred.resolve();
        }
      })

      .add('Enqueue + Dequeue cycle', {
        defer: true,
        setup: function() {
          this.queue = new AsyncQueue<number>(100);
        },
        fn: async function(deferred: any) {
          await this.queue.enqueue(42);
          await this.queue.dequeue();
          deferred.resolve();
        }
      })

      .add('Concurrent operations (2 producers, 2 consumers)', {
        defer: true,
        setup: function() {
          this.queue = new AsyncQueue<number>(10);
        },
        fn: async function(deferred: any) {
          const promises = [];

          // Producers
          for (let p = 0; p < 2; p++) {
            promises.push((async () => {
              for (let i = 0; i < 5; i++) {
                await this.queue.enqueue(i);
              }
            })());
          }

          // Consumers
          for (let c = 0; c < 2; c++) {
            promises.push((async () => {
              for (let i = 0; i < 5; i++) {
                await this.queue.dequeue();
              }
            })());
          }

          await Promise.all(promises);
          deferred.resolve();
        }
      })

      .add('High contention (small buffer)', {
        defer: true,
        setup: function() {
          this.queue = new AsyncQueue<number>(2);
        },
        fn: async function(deferred: any) {
          const promises = [];

          promises.push((async () => {
            for (let i = 0; i < 10; i++) {
              await this.queue.enqueue(i);
            }
          })());

          promises.push((async () => {
            for (let i = 0; i < 10; i++) {
              await this.queue.dequeue();
            }
          })());

          await Promise.all(promises);
          deferred.resolve();
        }
      })

      // Event handlers
      .on('cycle', function(event: any) {
        const bench = event.target;
        console.log(String(bench));

        results.push({
          name: bench.name,
          hz: bench.hz,
          rme: bench.stats.rme,
          samples: bench.stats.sample.length,
          mean: bench.stats.mean * 1000, // Convert to ms
        });
      })

      .on('complete', function() {
        console.log('\n=== Summary ===\n');

        // Sort by ops/sec
        results.sort((a, b) => b.hz - a.hz);

        console.log('Ranked by performance:');
        results.forEach((result, index) => {
          console.log(`${index + 1}. ${result.name}`);
          console.log(`   ${Math.round(result.hz).toLocaleString()} ops/sec (±${result.rme.toFixed(2)}%)`);
          console.log(`   Mean time: ${result.mean.toFixed(3)}ms`);
          console.log(`   Samples: ${result.samples}\n`);
        });

        console.log('Fastest is ' + this.filter('fastest').map('name'));
        console.log('Slowest is ' + this.filter('slowest').map('name'));

        resolve(results);
      })

      .on('error', function(event: any) {
        console.error('Benchmark error:', event.target.error);
      })

      // Run the suite
      .run({ 'async': true });
  });
}

// Run if called directly
if (require.main === module) {
  runBenchmarks().catch(console.error);
}