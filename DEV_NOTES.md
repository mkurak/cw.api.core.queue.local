# Developer Notes — cw.api.core.queue.local

> Reference for queue internals, retry semantics, and release workflow.

## Overview
- `LocalQueue` orchestrates named in-memory queues with ack/nack semantics,
  consumer groups, retry counters, and optional dead-letter routing.
- Message metadata is carried alongside the payload and frozen before delivery
  so handlers cannot mutate upstream state inadvertently.
- Default queue configuration (`ackTimeout`, `maxDeliveries`, `deadLetterQueue`)
  can be set via constructor options or `queue.configure({ defaultQueue })`.
- The DI module (`queueModule`, `useQueue`) exposes a singleton `LocalQueue`
  inside `cw.api.core.di` containers and guards against repeated default option
  application.

## Architecture Details
- **QueueState** – maintains the pending buffer (`MessageBuffer`), consumer
  registry, in-flight deliveries, and aggregated metrics. Buffers use a ring
  index to avoid `Array.shift()` churn.
- **Delivery lifecycle** – when a worker becomes available the queue increments
  `attempts`, schedules an optional ack timeout, and exposes `MessageContext`
  helpers. Settled deliveries always clear timers, mark the worker idle, and
  notify drain waiters.
- **Retry resolution** – the effective `ackTimeout`, `maxDeliveries`, and
  `deadLetterQueue` resolve in the order `publish` → consumer → queue defaults.
  When delivery attempts exceed the limit the message is routed to the resolved
  dead-letter queue (or counted as dropped).
- **Consumer handles** – returned by `registerConsumer`, exposing `pause()`,
  `resume()`, and `stop({ drain?, requeueInFlight? })`. `stop()` optionally
  waits for in-flight deliveries before detaching workers.

## Behavioural Notes
- `ack()`/`nack()` are single-use; subsequent calls throw to prevent conflicting
  outcomes.
- Handlers that throw bubble into `nack({ requeue: true, reason: 'handler-error' })`
  and log via `console.error`.
- Ack timeouts increment the `expired` metric and trigger a requeue (or
  dead-letter) using the resolved retry policy.
- `purgeQueue()` only clears buffered messages; in-flight deliveries remain
  untouched until they settle.

## Testing
- `tests/localQueue.test.ts` exercises ack/nack flows, multi-instance consumers,
  dead-letter routing, and `stop({ drain })` semantics.
- `tests/module.test.ts` verifies DI integration (`queueModule`, `useQueue`) and
  one-time application of shared defaults.
- Helper `waitFor()` polls with short intervals; keep timeouts generous when
  adding timer-driven behaviour to avoid flakiness.

## Tooling
- `npm run lint` – ESLint 9 flat config.
- `npm run test` / `npm run test:coverage` – Jest with `ts-jest` in ESM mode.
- `npm run build` – TypeScript build targeting `dist/` via `tsconfig.build.json`.
- `npm run release -- <type>` – semantic version bump + tag push (requires a
  configured git remote).

## Release Checklist
1. Update README, DEV_NOTES, and CHANGE_LOG with behavioural changes.
2. Run `npm run lint`, `npm run test:coverage`, and `npm run build`.
3. Ensure working tree is clean; commit relevant files only.
4. `npm run release -- <type>` (use `minor` for new features, `patch` for fixes).
5. Publish via GitHub Actions or `npm publish --provenance`.

## Future Ideas
- Priority-aware queues and route filters to mimic RMQ exchanges.
- Visibility timeouts and `extendAck()` for long-running jobs.
- Observable hooks (`onEnqueue`, `onAck`, `onNack`) for metrics without polling.
- Persistence adapter to flush buffer state to disk between restarts.
