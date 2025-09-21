# Changelog

## [0.2.0] - 2025-09-20
- Implement `LocalQueue` with named queues, manual acks, retry limits, and
  dead-letter routing.
- Introduce consumer orchestration (multi-instance workers, `stop()` back
  pressure controls) and queue statistics.
- Add DI integration via `queueModule` / `useQueue` plus a comprehensive Jest
  suite covering behaviour.

## [0.1.0] - 2025-09-20
- Initial scaffolding generated with `cw.helper.package.generator`.
