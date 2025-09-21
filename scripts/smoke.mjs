#!/usr/bin/env node
import { LocalQueue } from '../dist/index.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeout = 1000) {
  const start = Date.now();
  while (true) {
    if (predicate()) {
      return;
    }
    if (Date.now() - start > timeout) {
      throw new Error('timeout');
    }
    await sleep(10);
  }
}

function fail(message, error) {
  console.error('[cw.api.core.queue.local] Smoke test failed:', message);
  if (error) {
    console.error(error);
  }
  process.exit(1);
}

try {
  const queue = new LocalQueue();
  let consumed = 0;

  const consumer = queue.registerConsumer(
    'smoke-queue',
    async (ctx) => {
      if (ctx.payload !== 'payload') {
        throw new Error('unexpected payload');
      }
      consumed += 1;
      ctx.ack();
    },
    { autoAck: false }
  );

  queue.publish('smoke-queue', 'payload');
  await waitFor(() => consumed === 1, 1000);
  await consumer.stop({ drain: true });

  const stats = queue.getQueueStats('smoke-queue');
  if (stats.messages !== 0 || stats.pending !== 0 || stats.acked !== 1) {
    fail('unexpected queue stats after consumption');
  }

  queue.deleteQueue('smoke-queue');
  console.log('[cw.api.core.queue.local] OK: smoke test passed');
} catch (error) {
  fail('unexpected error', error);
}
