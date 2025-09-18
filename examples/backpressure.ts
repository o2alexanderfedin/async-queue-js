import { AsyncQueue } from '../src/index';

interface QueueStats {
  length: number;
  maxSize: number;
}

async function main(): Promise<void> {
  console.log('Backpressure Demonstration\n');
  console.log('Fast producer (10ms) vs Slow consumer (100ms)');
  console.log('Queue size: 3 items max\n');

  const queue = new AsyncQueue<number>(3); // Buffer only 3 items
  let producerBlocked = false;

  // Fast producer - tries to produce every 10ms
  async function fastProducer(): Promise<void> {
    for (let i = 1; i <= 20; i++) {
      const startTime = Date.now();

      await queue.enqueue(i);

      const elapsed = Date.now() - startTime;

      if (elapsed > 15) { // If it took more than 15ms, we were blocked
        if (!producerBlocked) {
          console.log(`[Producer] BLOCKED at item ${i} (queue full)`);
          producerBlocked = true;
        }
      } else {
        if (producerBlocked) {
          console.log(`[Producer] UNBLOCKED, resuming production`);
          producerBlocked = false;
        }
        console.log(`[Producer] Enqueued item ${i}`);
      }

      // Try to produce quickly
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    queue.close();
    console.log('[Producer] Finished producing 20 items');
  }

  // Slow consumer - processes every 100ms
  async function slowConsumer(): Promise<void> {
    while (true) {
      const item = await queue.dequeue();

      if (item === undefined) {
        break;
      }

      console.log(`[Consumer] Processing item ${item}...`);

      // Simulate slow processing
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    console.log('[Consumer] Finished consuming');
  }

  // Track queue size
  async function monitor(): Promise<void> {
    const interval = setInterval(() => {
      if (!queue.isClosed) {
        const stats: QueueStats = {
          length: queue.size,
          maxSize: queue.capacity
        };
        console.log(`[Monitor] Queue size: ${stats.length}/${stats.maxSize}`);
      } else {
        clearInterval(interval);
      }
    }, 50);
  }

  // Run all concurrently
  await Promise.all([
    fastProducer(),
    slowConsumer(),
    monitor()
  ]);

  console.log('\nBackpressure prevented memory overflow!');
  console.log('Producer automatically slowed to match consumer speed');
}

main().catch(console.error);