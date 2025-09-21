# Changelog

## [0.2.2] - 2025-09-21
### Added
- Added a smoke test that publishes to a queue, consumes, and validates metrics to guard against regressions.
### Changed
- Release documentation now points to `npm version <type>` + `git push --follow-tags`.

## [0.2.1] - 2025-09-21
### Changed
- Removed the `release` npm script and refreshed docs to direct maintainers to `npm version <type>` plus `git push --follow-tags`.

## [0.2.0] - 2025-09-20
- Implement `LocalQueue` with named queues, manual acks, retry limits, and
  dead-letter routing.
- Introduce consumer orchestration (multi-instance workers, `stop()` back
  pressure controls) and queue statistics.
- Add DI integration via `queueModule` / `useQueue` plus a comprehensive Jest
  suite covering behaviour.

## [0.1.0] - 2025-09-20
- Initial scaffolding generated with `cw.helper.package.generator`.
