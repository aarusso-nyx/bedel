# Extraction inventory

Origin: aarusso-nyx/devai commit `18fc6cf01645648dfe3b6d5c256a926c3c75ef47`, tree `3f61e156fae024b8828e6c2cb151577485e935d0`.

## Exclusive mutation machinery

- `scripts/release-host/mutation-{production,diagnostic,vitest-plugin,typescript-plugin,workspace-aliases}.mjs`: runner adapters, transport, diagnostics. Workspace alias helper imported directly; host-bound adapters replaced with standalone execution.
- `scripts/process/mutation-checkpoints.mjs`: persistence concepts retained, campaign/commit/seal binding replaced by content-addressed execution inputs.
- `packages/cli/src/services/release-mutation-*.ts`, `mutation-reuse.ts`, `mutation-evidence-v21.ts`, `mutation-assurance-v2.ts`, `release-unit-mutation-evidence.ts`: DEVAI-bound orchestration is reimplemented independently, not imported as a runtime dependency.
- `packages/cli/src/commands/mutation/`: replaced by Bedel's standalone CLI.

## Shared and historical components (remain at origin)

- Generic Docker, subprocess, release transport, digest, authority and signature utilities may serve other checks; do not delete them solely by association.
- `release-export-mutation-*`, authority boundary, vendored evidence verifiers and historical schemas are compatibility readers, not Bedel execution prerequisites.
- Constitution, policies, action registry and release readiness are DEVAI product contracts; Bedel does not import them.

## Tests

- `tests/contract/mutation-workspace-aliases.test.ts`: ported to Node's built-in test runner, preserving exact alias and rejection cases.
- CLI `release-mutation-*`, `mutation-reuse`, checkpoints, provenance and static-activation tests are machinery-exclusive. Their portable behaviors receive standalone regression coverage; DEVAI-specific seals, roles and release assertions are not Bedel contracts.
- `mutation-wave*` tests in loop/sensors and ordinary crash regressions exercise product behavior and MUST remain DEVAI tests.

No campaign artifacts, volumes, host credentials or private configuration are imported. The original source remains immutable and recoverable from the origin commit. New files are Apache-2.0; original NOTICE is retained.
