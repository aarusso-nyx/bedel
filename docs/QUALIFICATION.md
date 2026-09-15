# Qualification

Real Stryker qualification is invoked explicitly, outside CI. The ordinary `npm test` command never dispatches Stryker.

- Local bounded engine sample: whole-source and four-batch populations agree (8 mutants); complete cache reuse, immutable-index reconstruction, partial interruption, resume and report reconstruction pass. A temporary path containing spaces and non-ASCII characters is used.
- Ported DEVAI static activation and byte-preservation regressions: 5 tests passed using the real Bedel Vitest adapter and Stryker internals.
- Ordinary negative cases cover incomplete/Pending/RuntimeError populations, missing exit receipts, object corruption, wrong-unit cache references, conflicting results, source drift, offline source hosts and incompatible execution environments.
- Linux arm64 Docker Desktop execution completed a seven-mutant npm fixture: seven killed, score 100, one CPU and 1 GiB, including cold dependency installation.
- A pnpm fixture with the DEVAI integrity-pinned package manager preserved six completed observations when its 55-second invocation budget expired. The budget includes preparation and baseline.
- Kernel OOM, V8 heap OOM with `OOMKilled=false`, and native SIGSEGV with `OOMKilled=false` were exercised in bounded containers. See `worker-failure-qualification.json`.
- Completed immutable results were transferred between Docker Desktop and Colima and the same seven-mutant report was assembled without running the engine.
- Cross-daemon image resolution passed against actual classic Docker and containerd stores: ordered layer digests and execution configuration agree despite different exposed image IDs.
- Pending queue migration to Colima exposed filesystem inode exhaustion despite 4 GiB free bytes. The final sample failed before installation with the new inode preflight, then resumed the same queue from Colima on Docker Desktop and completed all seven mutants in 64.5 seconds. A repeat resume assembled the complete report without the engine. Host locator preservation was verified after transfer; see `pending-transfer-qualification.json`.
- Installed tarball smoke validates planning, the packaged toolchain lock, the runtime Dockerfile and hoisted engine resolution without executing mutants.

Client qualification used macOS arm64, with Linux arm64 containers on two Docker daemons. Linux amd64 and Windows clients are supported by the implementation but have not been exercised in this environment.

These samples verify the stated mechanics; they are not a complete mutation campaign for Bedel or DEVAI. Cross-host queue execution, partial-result preservation and complete-result transfer were demonstrated in separate bounded samples; no claim is made that the six-observation interrupted sample itself completed on the other host.

## Corrective release 0.1.1

Version 0.1.0 was published before the installed symlink startup defect was detected. Version 0.1.1 corrects that defect and preserves the original release history. The real engine samples above preceded the final metadata bookkeeping and startup fixes; these fixes were checked with ordinary regressions and installed CLI commands. No repeat mutation campaign on the corrective package is claimed.
