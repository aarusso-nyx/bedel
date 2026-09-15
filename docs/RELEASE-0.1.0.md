# Bedel 0.1.0

Bedel is independent mutation hardening extracted from DEVAI. It never executes mutations in CI and has no DEVAI runtime or release dependency.

This first release provides source/dependency selection, deterministic line batches, durable content-addressed observations, resumable queues, threshold-only report evaluation and Docker-context execution with CPU, memory and whole-invocation budgets. Stryker is the initial engine. Docker transport uses managed volumes and capsule copies; shared host paths are unnecessary.

Install the attached tarball with `npm install -g ./bedel-0.1.0.tgz`, then follow the README to build the runtime image and declare project sources/tests/dependencies in `bedel.config.json`. No package registry publication is part of this release.

The immutable DEVAI origin and archived test/source inventory are recorded in `docs/EXTRACTION.md` and `docs/provenance/devai/MANIFEST.json`. Archived governance assertions are historical material, not claimed Bedel coverage.

See `docs/QUALIFICATION.md` for the exact bounded samples and platform coverage. Ordinary GitHub CI runs formatting, lint, deterministic tests and packaging only.
