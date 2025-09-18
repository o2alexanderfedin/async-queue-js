const AsyncQueue = require('../lib/index')

async function main() {
  console.log('Backpressure Demonstration\n')
  console.log('Fast producer (10ms) vs Slow consumer (100ms)')
  console.log('Queue size: 3 items max\n')

  const queue = new AsyncQueue(3) // Buffer only 3 items
  let producerBlocked = false

  // Fast producer - tries to produce every 10ms
  async function fastProducer() {
    for (let i = 1; i <= 20; i++) {
      const startTime = Date.now()

      await queue.enqueue(i)

      const elapsed = Date.now() - startTime

      if (elapsed > 15) { // If it took more than 15ms, we were blocked
        if (!producerBlocked) {
          console.log(`[Producer] BLOCKED at item ${i} (queue full)`)
          producerBlocked = true
        }
      } else {
        if (producerBlocked) {
          console.log(`[Producer] UNBLOCKED, resuming production`)
          producerBlocked = false
        }
        console.log(`[Producer] Enqueued item ${i}`)
      }

      // Try to produce quickly
      await new Promise(resolve => setTimeout(resolve, 10))
    }

    queue.close()
    console.log('[Producer] Finished producing 20 items')
  }

  // Slow consumer - processes every 100ms
  async function slowConsumer() {
    while (true) {
      const item = await queue.dequeue()

      if (item === undefined) {
        break
      }

      console.log(`[Consumer] Processing item ${item}...`)

      // Simulate slow processing
      await new Promise(resolve => setTimeout(resolve, 100))
    }

    console.log('[Consumer] Finished consuming')
  }

  // Track queue size
  async function monitor() {
    const interval = setInterval(() => {
      if (!queue.isClosed) {
        console.log(`[Monitor] Queue size: ${queue.queue.length}/${queue.maxSize}`)
      } else {
        clearInterval(interval)
      }
    }, 50)
  }

  // Run all concurrently
  await Promise.all([
    fastProducer(),
    slowConsumer(),
    monitor()
  ])

  console.log('\nBackpressure prevented memory overflow!')
  console.log('Producer automatically slowed to match consumer speed')
}

main().catch(console.error)