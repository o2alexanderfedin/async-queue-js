/**
 * Example demonstrating AsyncQueue as an async iterator/enumerator
 * Shows various patterns for consuming queue items with async iteration
 */

import { AsyncQueue } from '../src/index';

/**
 * Example 1: Basic for-await-of iteration
 */
async function basicIteration() {
  console.log('\n=== Basic Async Iteration ===\n');

  const queue = new AsyncQueue<string>(3);

  // Producer task
  const producer = async () => {
    const messages = ['Hello', 'Async', 'Iterator', 'World'];
    for (const msg of messages) {
      await queue.enqueue(msg);
      console.log(`Produced: ${msg}`);
    }
    queue.close();
    console.log('Queue closed');
  };

  // Start producer
  producer();

  // Consumer using for-await-of
  console.log('Starting iteration...');
  for await (const item of queue) {
    console.log(`Consumed: ${item}`);
  }
  console.log('Iteration complete\n');
}

/**
 * Example 2: Stream processing pipeline
 */
async function streamProcessing() {
  console.log('\n=== Stream Processing Pipeline ===\n');

  const queue = new AsyncQueue<number>(5);

  // Simulate data stream
  const dataStream = async () => {
    for (let i = 1; i <= 10; i++) {
      await queue.enqueue(i);
      await new Promise(resolve => setTimeout(resolve, 100)); // Simulate delay
    }
    queue.close();
  };

  // Transform functions
  async function* square(source: AsyncIterable<number>) {
    for await (const item of source) {
      yield item * item;
    }
  }

  async function* filter(source: AsyncIterable<number>, predicate: (n: number) => boolean) {
    for await (const item of source) {
      if (predicate(item)) {
        yield item;
      }
    }
  }

  // Start data stream
  dataStream();

  // Process pipeline: square then filter even numbers
  const pipeline = filter(square(queue), n => n % 2 === 0);

  console.log('Processing stream...');
  for await (const result of pipeline) {
    console.log(`Result: ${result}`);
  }
  console.log('Stream processing complete\n');
}

/**
 * Example 3: Parallel consumers with async iterators
 */
async function parallelConsumers() {
  console.log('\n=== Parallel Consumers ===\n');

  const queue = new AsyncQueue<number>(10);

  // Producer
  const producer = async () => {
    for (let i = 0; i < 20; i++) {
      await queue.enqueue(i);
    }
    queue.close();
  };

  // Consumer function
  const consumer = async (id: string) => {
    const items: number[] = [];
    for await (const item of queue) {
      items.push(item);
      console.log(`Consumer ${id} got: ${item}`);
      // Simulate processing time
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return items;
  };

  // Start producer
  producer();

  // Run multiple consumers in parallel
  const [items1, items2, items3] = await Promise.all([
    consumer('A'),
    consumer('B'),
    consumer('C')
  ]);

  console.log(`\nConsumer A processed: ${items1.join(', ')}`);
  console.log(`Consumer B processed: ${items2.join(', ')}`);
  console.log(`Consumer C processed: ${items3.join(', ')}`);
  console.log(`Total items: ${items1.length + items2.length + items3.length}\n`);
}

/**
 * Example 4: Using drain() and take() methods
 */
async function drainAndTake() {
  console.log('\n=== Drain and Take Methods ===\n');

  // Example with drain()
  const queue1 = new AsyncQueue<string>(5);

  const fillQueue1 = async () => {
    const fruits = ['apple', 'banana', 'orange', 'grape', 'mango'];
    for (const fruit of fruits) {
      await queue1.enqueue(fruit);
    }
    queue1.close();
  };

  fillQueue1();
  const allFruits = await queue1.drain();
  console.log(`Drained all fruits: ${allFruits.join(', ')}`);

  // Example with take()
  const queue2 = new AsyncQueue<number>(10);

  // Continuous producer
  const continuousProducer = async () => {
    let counter = 1;
    while (counter <= 100) {
      await queue2.enqueue(counter++);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };

  continuousProducer(); // Don't await, let it run

  console.log('\nTaking first 5 items...');
  const firstFive = await queue2.take(5);
  console.log(`Got: ${firstFive.join(', ')}`);

  console.log('\nTaking next 3 items...');
  const nextThree = await queue2.take(3);
  console.log(`Got: ${nextThree.join(', ')}`);

  queue2.close(); // Stop the producer
  console.log('\nQueue closed\n');
}

/**
 * Example 5: Error handling with async iteration
 */
async function errorHandling() {
  console.log('\n=== Error Handling with Iteration ===\n');

  const queue = new AsyncQueue<string>(3);

  // Producer that might have errors
  const riskyProducer = async () => {
    const items = ['safe1', 'safe2', 'risky', 'safe3'];
    for (const item of items) {
      if (item === 'risky') {
        console.log('Producer encountered an issue, but continues...');
        // In real scenario, you might handle errors here
      }
      await queue.enqueue(item);
    }
    queue.close();
  };

  riskyProducer();

  // Consumer with error handling
  try {
    for await (const item of queue) {
      console.log(`Processing: ${item}`);
      if (item === 'risky') {
        console.log('  -> Special handling for risky item');
      }
    }
    console.log('All items processed successfully\n');
  } catch (error) {
    console.error('Error during iteration:', error);
  }
}

/**
 * Example 6: Real-world use case - Log aggregator
 */
async function logAggregator() {
  console.log('\n=== Log Aggregator Example ===\n');

  interface LogEntry {
    timestamp: Date;
    level: 'INFO' | 'WARN' | 'ERROR';
    message: string;
    source: string;
  }

  const logQueue = new AsyncQueue<LogEntry>(100);

  // Multiple log sources
  const webServerLogs = async () => {
    for (let i = 0; i < 5; i++) {
      await logQueue.enqueue({
        timestamp: new Date(),
        level: 'INFO',
        message: `Web request ${i}`,
        source: 'web-server'
      });
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  };

  const databaseLogs = async () => {
    for (let i = 0; i < 3; i++) {
      await logQueue.enqueue({
        timestamp: new Date(),
        level: i === 1 ? 'WARN' : 'INFO',
        message: `Query execution ${i}`,
        source: 'database'
      });
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  };

  const apiLogs = async () => {
    for (let i = 0; i < 4; i++) {
      await logQueue.enqueue({
        timestamp: new Date(),
        level: i === 3 ? 'ERROR' : 'INFO',
        message: `API call ${i}`,
        source: 'api'
      });
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  };

  // Log processor
  const processLogs = async () => {
    const errorLogs: LogEntry[] = [];
    const warnLogs: LogEntry[] = [];

    for await (const log of logQueue) {
      const timePart = log.timestamp.toISOString().split('T')[1];
      const time = timePart ? timePart.substring(0, 8) : '00:00:00';
      console.log(`[${time}] ${log.level.padEnd(5)} [${log.source}] ${log.message}`);

      // Collect important logs
      if (log.level === 'ERROR') errorLogs.push(log);
      if (log.level === 'WARN') warnLogs.push(log);
    }

    console.log(`\nSummary: ${errorLogs.length} errors, ${warnLogs.length} warnings`);
    if (errorLogs.length > 0) {
      console.log('Errors need attention:', errorLogs.map(l => l.message).join(', '));
    }
  };

  // Start all log sources
  Promise.all([
    webServerLogs(),
    databaseLogs(),
    apiLogs()
  ]).then(() => {
    logQueue.close();
  });

  // Process logs
  await processLogs();
  console.log('Log processing complete\n');
}

/**
 * Main function to run all examples
 */
async function main() {
  console.log('='.repeat(60));
  console.log('AsyncQueue Iterator Examples');
  console.log('='.repeat(60));

  await basicIteration();
  await streamProcessing();
  await parallelConsumers();
  await drainAndTake();
  await errorHandling();
  await logAggregator();

  console.log('='.repeat(60));
  console.log('All examples completed!');
  console.log('='.repeat(60));
}

// Run the examples
if (require.main === module) {
  main().catch(console.error);
}