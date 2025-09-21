# cw.api.core.queue.local

Local, process-bound queue primitives tailored for cw API services. `LocalQueue`
provides message fan-out, manual acknowledgements, configurable retries, and
lightweight dead-letter support without requiring an external broker.

## Highlights
- **Named queues** – declare as many queues as you need and publish messages to
  them independently.
- **Deterministic delivery** – explicit `ack()`/`nack()` flow with optional
  acknowledgement deadlines that requeue timed-out messages.
- **Parallel consumers** – spin up multiple handler instances per queue; each
  instance processes one message at a time for predictable back pressure.
- **Retry + DLQ** – cap delivery attempts per queue/consumer/message and divert
  exhausted payloads to a dead-letter queue.
- **Diagnostics** – `getQueueStats()` exposes enqueue/pending/ack/nack counters
  so services can monitor throughput and saturation.
- **DI friendly** – ship with a `queueModule` and `useQueue()` helper for
  `cw.api.core.di` containers.

## Installation

```bash
npm install cw.api.core.queue.local
```

Target runtime: Node.js 18+ (pure ESM).

## Quick Start

```ts
import { LocalQueue } from 'cw.api.core.queue.local';

const queue = new LocalQueue({
    defaultQueue: {
        ackTimeout: 5_000,
        maxDeliveries: 5,
        deadLetterQueue: 'jobs.dead'
    }
});

queue.registerConsumer('jobs.dead', ({ payload, ack }) => {
    reportFailure(payload);
    ack();
});

queue.registerConsumer(
    'jobs',
    async ({ payload, ack, nack, redelivered }) => {
        try {
            await processWork(payload);
            ack();
        } catch (error) {
            if (redelivered) {
                nack({ requeue: false, reason: 'permanent-failure' });
            } else {
                nack();
            }
        }
    },
    { instances: 3 }
);

queue.publish('jobs', { id: '123', task: 'resize-image' });
```

## Consumers & Delivery Options

- `instances` – number of handler workers to spawn. Each worker handles a single
  message concurrently; use multiple instances to scale throughput.
- `autoAck` – automatically acknowledge the message when the handler resolves.
  Keep the default (`false`) when you need explicit success/failure control.
- `ackTimeout` – override the queue default for the consumer. Messages are
  requeued when the timeout elapses without `ack()`.
- `maxDeliveries` / `deadLetterQueue` – per-consumer overrides for retry limits
  and dead-letter destinations.

Each delivery receives a `MessageContext`:

```ts
queue.registerConsumer('jobs', (ctx) => {
    ctx.queue;        // => 'jobs'
    ctx.messageId;    // unique message identifier
    ctx.payload;      // original value from publish()
    ctx.metadata;     // frozen metadata object
    ctx.attempts;     // delivery count, including the current attempt
    ctx.redelivered;  // true once attempts > 1

    ctx.ack();
    ctx.nack({ requeue: true, reason: 'retry-later' });
});
```

## Retry Behaviour & Dead Letters

Delivery attempts are limited by the first defined value among:

1. `PublishOptions.maxDeliveries`
2. `ConsumerOptions.maxDeliveries`
3. Queue-level `maxDeliveries`

When the limit is reached, the message moves to the resolved dead-letter queue
(`publishOptions.deadLetterQueue` → consumer → queue). If no destination is
configured, the payload is dropped and counted under `stats.dropped`.

`ackTimeout` follows the same override order and requeues (or dead-letters)
messages that were not acknowledged in time.

## Monitoring

Call `getQueueStats(queueName)` to inspect activity:

```ts
const stats = queue.getQueueStats('jobs');
// => {
//      messages: ready-to-deliver count,
//      pending: in-flight deliveries,
//      enqueued, delivered, acked, nacked,
//      requeued, deadLettered, expired, dropped
//    }
```

`purgeQueue(name)` clears queued (but not in-flight) messages, while
`deleteQueue(name)` removes the queue after requeueing or dropping deliveries.

## Dependency Injection

```ts
import { registerModules, getContainer } from 'cw.api.core.di';
import { LocalQueue, queueModule, useQueue } from 'cw.api.core.queue.local';

// Manual module registration
const container = getContainer();
registerModules(container, queueModule);
const queue = container.resolve(LocalQueue);

// Shortcut helper with one-time defaults
useQueue({
    defaultQueue: {
        ackTimeout: 2_000
    }
});
```

The helper applies `defaultQueue` settings only on the first call; subsequent
invocations reuse the singleton `LocalQueue` instance.

## API Surface

- `LocalQueue.publish(queueName, payload, options?)`
- `LocalQueue.registerConsumer(queueName, handler, options?)`
- `LocalQueue.getQueueStats(queueName)`
- `LocalQueue.purgeQueue(queueName)` / `deleteQueue(queueName)`
- `LocalQueue.configure({ defaultQueue })`
- `LocalQueue.listQueues()`
- `ConsumerHandle.stop({ drain?, requeueInFlight? })`

Full type definitions are available through the package exports.

## Development

```bash
npm install
npm run lint
npm run test:coverage
npm run build
```

Use `npm run release -- <type>` to bump the version, update tags, and trigger
publishing workflows.

## License

MIT © 2025 Mert Kurak
