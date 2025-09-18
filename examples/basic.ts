import { AsyncQueue } from '../src/index';

async function main(): Promise<void> {
  console.log('Basic AsyncQueue Example\n');

  const queue = new AsyncQueue<string>(); // Default buffer size of 1

  // Producer
  async function producer(): Promise<void> {
    const items: string[] = ['Apple', 'Banana', 'Cherry', 'Date', 'Elderberry'];

    for (const item of items) {
      await queue.enqueue(item);
      console.log(`[Producer] Enqueued: ${item}`);
    }

    queue.close();
    console.log('[Producer] Closed queue');
  }

  // Consumer
  async function consumer(): Promise<void> {
    while (true) {
      const item = await queue.dequeue();

      if (item === undefined) {
        console.log('[Consumer] Queue closed, exiting');
        break;
      }

      console.log(`[Consumer] Dequeued: ${item}`);

      // Simulate processing time
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  // Run both concurrently
  console.log('Starting producer and consumer...\n');
  await Promise.all([producer(), consumer()]);

  console.log('\nExample completed!');
}

main().catch(console.error);