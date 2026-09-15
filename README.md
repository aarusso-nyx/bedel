# Bedel

Independent, portable mutation hardening. **Never a CI or release gate.** Bedel 0.1.0 runs Stryker 9.6.1 with Vitest, schedules source-related work, preserves observations and resumes interrupted runs.

## Install

Install the release tarball, using Node 22 or later:

```sh
npm install -g ./bedel-0.1.1.tgz
bedel --help
```

No DEVAI installation, agent session, registry account or signing ceremony is required.

## Configure

Build the included runtime image on the Docker daemon once, then record its immutable image ID in configuration. The image includes `ps`, which Stryker needs to manage worker processes. To transfer the same runtime between hosts, use Docker save/load. Bedel records ordered content-addressed layers and execution configuration; on resume it verifies equivalent bytes and selects the target daemon’s immutable image ID, even when classic Docker and containerd expose different IDs.

```sh
docker --context my-remote-host build -t bedel-runtime:0.1.0 "$(npm root -g)/bedel"
docker --context my-remote-host image inspect bedel-runtime:0.1.0 --format '{{.Id}}'
```

Create `bedel.config.json` in the project root. Use exact relative files, not globs. Every source declares its test files and execution dependencies (helpers, fixtures, generated inputs). References to other configured source units expand transitively, with cycles visited once. Dependency test files are not automatically added to the caller’s test selection. Bedel uses this declared dependency graph rather than trying to infer JavaScript's dynamic imports.

```json
{
  "dockerContext": "my-remote-host",
  "image": "sha256:REPLACE_WITH_BUILT_IMAGE_ID",
  "inputs": ["vitest.config.ts", "tsconfig.json"],
  "ignoredChanges": ["README.md", "LICENSE"],
  "units": [
    {
      "source": "src/commands/check.ts",
      "group": "checks",
      "tests": ["tests/check.test.ts"],
      "dependencies": ["src/schema.ts", "tests/setup.ts"]
    }
  ],
  "engine": {
    "coverageAnalysis": "perTest",
    "vitest": { "configFile": "vitest.config.ts", "related": false }
  }
}
```

Provide an npm lockfile, or `pnpm-lock.yaml` and an exact `packageManager`, for example `pnpm@9.15.9`. Lockfiles/manifests are automatically execution inputs. Dependency install scripts are disabled; projects requiring generated artifacts must provide them in the capsule inputs. `inputs` invalidates all configured sources; per-source `dependencies` invalidates only their source. Unknown changed files stop planning with a classification diagnostic, never expand silently to all sources.

`group` is display metadata and does not invalidate results. Package release version and descriptive metadata do not invalidate execution; changes to dependencies, scripts, runtime settings, sources and tests do. Scores do not belong to execution identities.

## Run

```sh
bedel plan --base HEAD~1
bedel run --base HEAD~1
bedel run --files src/commands/check.ts
bedel run --files src/commands/check.ts --files tests/check.test.ts
bedel run --base HEAD~1 --docker-context another-host
bedel resume <run-id> --docker-context another-host
bedel report <run-id>
bedel run --all
bedel run --all --force
```

`--base` includes tracked working-tree changes and untracked additions. Removed sources are reported as retired; dependent sources still need a valid dependency declaration. An explicit base or file scope is required without a previous selection. After that, bare `bedel plan` and `bedel run` compare the saved source ledger and include unfinished queues; unchanged complete sources are not scheduled. `--all` expands selection; `--force` bypasses reuse only within the selected scope.

All CLI execution uses Docker, including when the context points at the local machine. The context comes from the flag, then configuration, then Docker's current context. Linux `amd64` and `arm64` identities are separate; an image digest or immutable image ID is mandatory. Defaults: **2 workers, 2 CPUs, 8 GiB, 30 minutes per invocation**, including preparation, transfer, dependency installation, baseline and checkpoint time. Override `workers`, `cpus`, `memoryMiB`, `budgetSeconds` and `batchLines` in configuration. Insufficient daemon CPU/memory capacity fails before execution. The internal native executor is used only for bounded developer qualification and does not provide OS resource isolation.

Containers use daemon-owned volumes and `docker cp`; client and host need no shared filesystem paths. The worker has its own deadline and continues after a client disconnect. Resume attaches to an active worker; switching contexts stops only that Bedel-owned worker, collects its checkpoints and transfers them to the new daemon. If the old daemon is unreachable, a validated local checkpoint can seed the new host; the report explicitly identifies potentially missing unsynchronized progress and the previous worker’s deadline. Compatible image/architecture is required for execution reuse. Containers and volumes are retained for recovery; cleanup is an explicit operator action using the names returned in the report.

## Durable results

Keep `.bedel/` outside Git and copy it with the project when moving computers. Its content-addressed objects preserve individual terminal observations, source checkpoints, complete unit results, queues and completion receipts. The index is reconstructible. Both survivors and killed mutants are useful observations; incomplete runs retain completed observations. Conflicting terminal results are preserved and reported instead of selecting the more favorable score.

Units are grouped by source and split using deterministic line windows. Stryker's own AST locates mutants. Nodes spanning windows are retained, and source checkpoints reuse their observations across batches. A census verifies each unit's full population before completion. Runtime errors, pending mutants, failed worker processes, changed inputs and incomplete reports cannot be promoted to a complete result.

Change `engine.thresholds.break` and run `bedel report` to recompute the score without executing mutations. Low scores do not block CI or releases. `report` only reads stored objects and can be repeated after report presentation fails. A successful engine exit, complete census and matching report digest are required before a report can be reconstructed as complete.

No automatic engine retry is performed. Resume is explicit; native crashes and worker-memory failures remain diagnosable. A timeout preserves the queue and exits with status 2. CLI status 0 means execution completed, not that a mutation score met a release requirement.

## Development

```sh
npm ci
npm run lint
npm run format:check
npm test
# Explicit and bounded, outside CI:
npm run qualify
```

Ordinary CI runs deterministic orchestration tests, formatting, lint and packaging only. The CLI refuses `run` and `resume` when `CI` is set. Real-engine qualification is a separate command and also refuses CI.

See [extraction and provenance](docs/EXTRACTION.md) and [qualification evidence](docs/QUALIFICATION.md). Historical DEVAI tests and adapters are preserved in `docs/provenance/` for continued porting; they are not executable Bedel tests and are excluded from the installable package.
