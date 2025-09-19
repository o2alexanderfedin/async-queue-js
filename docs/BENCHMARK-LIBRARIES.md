# Popular NPM Benchmark Libraries

## 1. **Benchmark.js**
The most established and widely-used benchmarking library.

```bash
npm install --save-dev benchmark
```

```javascript
const Benchmark = require('benchmark');
const suite = new Benchmark.Suite;

suite
  .add('AsyncQueue#enqueue', function() {
    queue.enqueue(42);
  })
  .add('AsyncQueue#dequeue', function() {
    queue.dequeue();
  })
  .on('cycle', function(event) {
    console.log(String(event.target));
  })
  .on('complete', function() {
    console.log('Fastest is ' + this.filter('fastest').map('name'));
  })
  .run({ 'async': true });
```

**Pros:**
- Statistical analysis with margin of error
- Automatic warm-up and iteration count
- Detailed results with ops/sec
- Battle-tested and reliable

**Cons:**
- Older API style
- Large dependency (lodash)

## 2. **Tinybench**
Modern, lightweight alternative to Benchmark.js.

```bash
npm install --save-dev tinybench
```

```javascript
import { Bench } from 'tinybench';

const bench = new Bench({ time: 100 });

bench
  .add('enqueue', () => {
    queue.enqueue(42);
  })
  .add('dequeue', () => {
    queue.dequeue();
  });

await bench.run();
console.table(bench.table());
```

**Pros:**
- No dependencies
- Modern async/await API
- TypeScript support
- Smaller bundle size

## 3. **Benny**
Pretty benchmarks with automatic chart generation.

```bash
npm install --save-dev benny
```

```javascript
const benny = require('benny');

benny.suite(
  'AsyncQueue Operations',

  benny.add('enqueue', () => {
    queue.enqueue(42);
  }),

  benny.add('dequeue', () => {
    queue.dequeue();
  }),

  benny.cycle(),
  benny.complete(),
  benny.save({ file: 'results', format: 'json' }),
  benny.save({ file: 'results', format: 'chart.html' }),
);
```

**Pros:**
- Beautiful HTML charts
- Multiple output formats
- Easy to use API

## 4. **Vitest Bench**
Integrated with Vitest testing framework.

```bash
npm install --save-dev vitest
```

```javascript
import { bench, describe } from 'vitest';

describe('AsyncQueue', () => {
  bench('enqueue', () => {
    queue.enqueue(42);
  });

  bench('dequeue', () => {
    queue.dequeue();
  });
});
```

**Pros:**
- Integrated with tests
- Same config as Vitest
- Modern tooling

## 5. **Node.js Built-in Performance API**
No dependencies required!

```javascript
import { performance } from 'perf_hooks';

const start = performance.now();
// ... operation ...
const end = performance.now();
console.log(`Operation took ${end - start}ms`);

// Or use marks
performance.mark('start');
// ... operation ...
performance.mark('end');
performance.measure('operation', 'start', 'end');

const measure = performance.getEntriesByName('operation')[0];
console.log(`Duration: ${measure.duration}ms`);
```

**Pros:**
- No dependencies
- Built into Node.js
- Fine-grained control

**Cons:**
- Manual statistics
- No automatic warm-up

## 6. **Benchmarkify**
Simple and straightforward benchmarking.

```bash
npm install --save-dev benchmarkify
```

```javascript
const Benchmarkify = require('benchmarkify');

const benchmark = new Benchmarkify('AsyncQueue').printHeader();

const bench = benchmark.createSuite('Operations');

bench.add('enqueue', () => {
  queue.enqueue(42);
});

bench.run();
```

## Recommendation

For our AsyncQueue project:

1. **Quick benchmarks**: Use Node.js built-in `performance` API
2. **Detailed analysis**: Use **Tinybench** (modern, no deps)
3. **Statistical rigor**: Use **Benchmark.js** (battle-tested)
4. **Pretty reports**: Use **Benny** (charts and graphs)
5. **With tests**: Use **Vitest bench** if using Vitest

Our current approach using `process.hrtime.bigint()` is actually quite good for simple benchmarking, but these libraries add:
- Statistical significance
- Warm-up periods
- Automatic iteration counts
- Pretty output formats
- Comparison tools