const AsyncQueue = require('./async-queue')

// Test utilities
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function runTest(name, testFn) {
  console.log(`\nRunning: ${name}`)
  try {
    await testFn()
    console.log(`✓ ${name} passed`)
  } catch (error) {
    console.error(`✗ ${name} failed:`, error.message)
    process.exitCode = 1
  }
}

// Tests
async function testBasicEnqueueDequeue() {
  const queue = new AsyncQueue()  // Default maxSize=1

  // Enqueue first item
  await queue.enqueue('item1')

  // Start enqueue of second item (will block since queue is full)
  const enqueue2Promise = queue.enqueue('item2')

  // Dequeue first item to make space
  const item1 = await queue.dequeue()

  // Now second enqueue can complete
  await enqueue2Promise

  // Dequeue second item
  const item2 = await queue.dequeue()

  if (item1 !== 'item1') throw new Error(`Expected 'item1', got ${item1}`)
  if (item2 !== 'item2') throw new Error(`Expected 'item2', got ${item2}`)
}

async function testSequentialWithMaxSize1() {
  const queue = new AsyncQueue(1)  // Explicitly maxSize=1

  // Sequential enqueue-dequeue pattern
  await queue.enqueue('A')
  const a = await queue.dequeue()

  await queue.enqueue('B')
  const b = await queue.dequeue()

  await queue.enqueue('C')
  const c = await queue.dequeue()

  if (a !== 'A') throw new Error(`Expected 'A', got ${a}`)
  if (b !== 'B') throw new Error(`Expected 'B', got ${b}`)
  if (c !== 'C') throw new Error(`Expected 'C', got ${c}`)
}

async function testBlockingDequeue() {
  const queue = new AsyncQueue()
  const results = []

  // Start dequeue before enqueue
  const dequeuePromise = queue.dequeue().then(item => results.push(item))

  await sleep(10)
  if (results.length !== 0) throw new Error('Dequeue should block')

  await queue.enqueue('delayed-item')
  await dequeuePromise

  if (results[0] !== 'delayed-item') throw new Error(`Expected 'delayed-item', got ${results[0]}`)
}

async function testMaxSizeBlocking() {
  const queue = new AsyncQueue(2) // Max size of 2

  await queue.enqueue('item1')
  await queue.enqueue('item2')

  let blocked = true
  const enqueuePromise = queue.enqueue('item3').then(() => { blocked = false })

  await sleep(10)
  if (!blocked) throw new Error('Enqueue should block when queue is full')

  await queue.dequeue() // Make space
  await enqueuePromise

  if (blocked) throw new Error('Enqueue should unblock after dequeue')
}

async function testCloseQueue() {
  const queue = new AsyncQueue()

  await queue.enqueue('item1')
  queue.close()

  const item1 = await queue.dequeue()
  const item2 = await queue.dequeue()

  if (item1 !== 'item1') throw new Error(`Expected 'item1', got ${item1}`)
  if (item2 !== undefined) throw new Error(`Expected undefined after close, got ${item2}`)
  if (!queue.isClosed) throw new Error('Queue should be closed')
}

async function testEnqueueAfterClose() {
  const queue = new AsyncQueue()
  queue.close()

  try {
    await queue.enqueue('item')
    throw new Error('Should not allow enqueue after close')
  } catch (error) {
    if (!error.message.includes('closed')) {
      throw new Error('Expected closed error')
    }
  }
}

async function testProducerConsumerPattern() {
  const queue = new AsyncQueue(3)
  const produced = []
  const consumed = []

  // Producer
  const producer = async () => {
    for (let i = 0; i < 10; i++) {
      await queue.enqueue(i)
      produced.push(i)
      await sleep(1)
    }
    queue.close()
  }

  // Consumer
  const consumer = async () => {
    while (true) {
      const item = await queue.dequeue()
      if (item === undefined) break
      consumed.push(item)
    }
  }

  await Promise.all([producer(), consumer()])

  if (produced.length !== 10) throw new Error(`Expected 10 produced, got ${produced.length}`)
  if (consumed.length !== 10) throw new Error(`Expected 10 consumed, got ${consumed.length}`)
  if (JSON.stringify(produced) !== JSON.stringify(consumed)) {
    throw new Error('Produced and consumed items do not match')
  }
}

async function testMultipleConsumers() {
  const queue = new AsyncQueue()
  const results = []

  // Start multiple consumers
  const consumer1 = queue.dequeue().then(item => results.push({consumer: 1, item}))
  const consumer2 = queue.dequeue().then(item => results.push({consumer: 2, item}))

  await sleep(10)

  // Enqueue items
  await queue.enqueue('A')
  await queue.enqueue('B')

  await Promise.all([consumer1, consumer2])

  if (results.length !== 2) throw new Error(`Expected 2 results, got ${results.length}`)
  const items = results.map(r => r.item).sort()
  if (JSON.stringify(items) !== JSON.stringify(['A', 'B'])) {
    throw new Error('Items not distributed correctly')
  }
}

async function testMultipleProducers() {
  const queue = new AsyncQueue(1) // Small buffer

  let producer1Blocked = false
  let producer2Blocked = false

  await queue.enqueue('initial')

  const producer1 = queue.enqueue('P1').then(() => {
    producer1Blocked = false
  })
  producer1Blocked = true

  const producer2 = queue.enqueue('P2').then(() => {
    producer2Blocked = false
  })
  producer2Blocked = true

  await sleep(10)
  if (!producer1Blocked || !producer2Blocked) {
    throw new Error('Both producers should be blocked')
  }

  // Consume items to unblock producers
  await queue.dequeue()
  await queue.dequeue()
  await queue.dequeue()

  await Promise.all([producer1, producer2])

  if (producer1Blocked || producer2Blocked) {
    throw new Error('Producers should be unblocked')
  }
}

async function testClosedState() {
  const queue = new AsyncQueue()

  if (queue.isClosed) throw new Error('New queue should not be closed')

  await queue.enqueue('item')
  queue.close()

  if (queue.isClosed) throw new Error('Queue with items should not report as closed')

  await queue.dequeue()

  if (!queue.isClosed) throw new Error('Empty closed queue should report as closed')
}

async function testWaitingConsumersReleasedOnClose() {
  const queue = new AsyncQueue()
  const results = []

  // Start multiple waiting consumers
  const consumers = [
    queue.dequeue().then(item => results.push(item)),
    queue.dequeue().then(item => results.push(item)),
    queue.dequeue().then(item => results.push(item))
  ]

  await sleep(10)
  queue.close()

  await Promise.all(consumers)

  if (results.length !== 3) throw new Error(`Expected 3 results, got ${results.length}`)
  if (!results.every(item => item === undefined)) {
    throw new Error('All waiting consumers should receive undefined on close')
  }
}

// Run all tests
async function runAllTests() {
  console.log('Starting AsyncQueue tests...')

  await runTest('Basic enqueue/dequeue', testBasicEnqueueDequeue)
  await runTest('Sequential with maxSize=1', testSequentialWithMaxSize1)
  await runTest('Blocking dequeue', testBlockingDequeue)
  await runTest('Max size blocking', testMaxSizeBlocking)
  await runTest('Close queue', testCloseQueue)
  await runTest('Enqueue after close', testEnqueueAfterClose)
  await runTest('Producer/consumer pattern', testProducerConsumerPattern)
  await runTest('Multiple consumers', testMultipleConsumers)
  await runTest('Multiple producers', testMultipleProducers)
  await runTest('Closed state', testClosedState)
  await runTest('Waiting consumers released on close', testWaitingConsumersReleasedOnClose)

  console.log('\n' + '='.repeat(50))
  if (process.exitCode === 1) {
    console.log('Some tests failed!')
  } else {
    console.log('All tests passed! ✓')
  }
}

runAllTests().catch(error => {
  console.error('Test runner failed:', error)
  process.exit(1)
})