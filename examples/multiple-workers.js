const AsyncQueue = require('../lib/index')

async function main() {
  console.log('Multiple Producers and Consumers Example\n')

  const queue = new AsyncQueue(5) // Buffer size of 5
  const ITEMS_PER_PRODUCER = 10
  const NUM_PRODUCERS = 3
  const NUM_CONSUMERS = 2

  let totalProduced = 0
  let totalConsumed = 0

  // Producer factory
  async function producer(id) {
    for (let i = 0; i < ITEMS_PER_PRODUCER; i++) {
      const item = `P${id}-Item${i}`
      await queue.enqueue(item)
      totalProduced++
      console.log(`[Producer ${id}] Created: ${item}`)

      // Random production delay
      await new Promise(resolve =>
        setTimeout(resolve, Math.random() * 50)
      )
    }
    console.log(`[Producer ${id}] Finished`)
  }

  // Consumer factory
  async function consumer(id) {
    while (true) {
      const item = await queue.dequeue()

      if (item === undefined) {
        console.log(`[Consumer ${id}] No more items, exiting`)
        break
      }

      totalConsumed++
      console.log(`[Consumer ${id}] Processing: ${item}`)

      // Random processing time
      await new Promise(resolve =>
        setTimeout(resolve, Math.random() * 100)
      )
    }
    console.log(`[Consumer ${id}] Finished`)
  }

  // Start all producers
  const producers = []
  for (let i = 1; i <= NUM_PRODUCERS; i++) {
    producers.push(producer(i))
  }

  // Start all consumers
  const consumers = []
  for (let i = 1; i <= NUM_CONSUMERS; i++) {
    consumers.push(consumer(i))
  }

  // Wait for all producers to finish
  await Promise.all(producers)
  console.log('\nAll producers finished')

  // Close queue to signal consumers
  queue.close()

  // Wait for all consumers to finish
  await Promise.all(consumers)

  console.log('\n' + '='.repeat(50))
  console.log(`Total items produced: ${totalProduced}`)
  console.log(`Total items consumed: ${totalConsumed}`)
  console.log(`Items match: ${totalProduced === totalConsumed ? 'YES ✓' : 'NO ✗'}`)
  console.log('='.repeat(50))
}

main().catch(console.error)