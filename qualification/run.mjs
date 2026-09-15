// Explicit, bounded real-engine qualification. Never called by ordinary CI.
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  symlinkSync,
  existsSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { plan } from "../src/planner.mjs";
import { run, report } from "../src/runner.mjs";
import { get } from "../src/store.mjs";
if (process.env.CI)
  throw Error("Real mutation qualification is forbidden in CI");
const tool = join(dirname(fileURLToPath(import.meta.url)), ".."),
  root = mkdtempSync(join(tmpdir(), "bedel qualificação espaço-"));
const started = Date.now();
let ok = false;
function configure(extra = {}) {
  writeFileSync(
    join(root, "bedel.config.json"),
    JSON.stringify({
      units: [
        { source: "source.js", tests: ["source.test.js"], dependencies: [] },
      ],
      workers: 1,
      budgetSeconds: 40,
      engine: { coverageAnalysis: "perTest" },
      ...extra,
    }),
  );
}
function mutants(result) {
  return result.units
    .flatMap((u) =>
      Object.entries(u.result?.report.files ?? {}).flatMap(([file, v]) =>
        v.mutants.map((m) => ({
          file,
          location: m.location,
          mutatorName: m.mutatorName,
          replacement: m.replacement,
          status: m.status,
        })),
      ),
    )
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
try {
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  symlinkSync(join(tool, "node_modules"), join(root, "node_modules"));
  writeFileSync(
    join(root, "source.js"),
    "export function compare(a,b) {\n if(a > b) {\n  return a + 1;\n }\n return b - 1;\n}\n",
  );
  writeFileSync(
    join(root, "source.test.js"),
    `import {test,expect} from 'vitest';import {compare} from './source.js';test('values',()=>{expect(compare(2,1)).toBe(3);expect(compare(1,2)).toBe(1);expect(compare(1,1)).toBe(0)});`,
  );
  configure();
  const full = await run(root, plan(root, { all: true }));
  assert.equal(full.status, "complete");
  const initial = mutants(full);
  assert.ok(initial.length > 0);
  const reused = await run(root, plan(root, { all: true }));
  assert.deepEqual(mutants(reused), initial);
  assert.equal(
    readdirSync(join(root, ".bedel", "runs", reused.id)).filter((p) =>
      p.endsWith(".log"),
    ).length,
    0,
  );
  configure({ batchLines: 2 });
  const split = await run(root, plan(root, { all: true }));
  assert.equal(split.status, "complete");
  assert.deepEqual(
    mutants(split),
    initial,
    "Spanning mutants must remain in exactly one batch",
  );
  // Rebuild object index and final reports without executing the engine.
  rmSync(join(root, ".bedel", "index.json"));
  const rebuilt = await run(root, plan(root, { all: true }));
  assert.deepEqual(mutants(rebuilt), initial);
  assert.equal(
    readdirSync(join(root, ".bedel", "runs", rebuilt.id)).filter((p) =>
      p.endsWith(".log"),
    ).length,
    0,
  );
  // Incomplete snapshot holds durable objects; new invocation reuses them.
  writeFileSync(
    join(root, "source.test.js"),
    `import {test,expect} from 'vitest';import {compare} from './source.js';test('values',async()=>{await new Promise(r=>setTimeout(r,300));expect(compare(2,1)).toBe(3);expect(compare(1,2)).toBe(1);expect(compare(1,1)).toBe(0)});`,
  );
  configure({ budgetSeconds: 6 });
  const partialPlan = plan(root, { all: true });
  const partial = await run(root, partialPlan);
  assert.equal(partial.status, "budget-exhausted");
  const checkpoint = join(
    root,
    ".bedel",
    "checkpoints",
    partialPlan.units[0].sourceKey + ".json",
  );
  assert.ok(existsSync(checkpoint));
  const observed = get(
    join(root, ".bedel"),
    JSON.parse(readFileSync(checkpoint)).hash,
  ).snapshot;
  assert.ok(Object.values(observed.files).some((f) => f.mutants.length));
  const resumed = await run(root, partialPlan, {
    id: partial.id,
    deadline: Date.now() + 40000,
  });
  assert.equal(resumed.status, "complete");
  assert.deepEqual(mutants(resumed), initial);
  const log = readFileSync(
    join(root, ".bedel", "runs", resumed.id, partialPlan.units[0].key + ".log"),
    "utf8",
  );
  assert.match(log, /reus/i);
  // Report assembly is a pure operation and can be repeated after deleting view output.
  assert.equal(report(join(root, ".bedel"), resumed.id).status, "complete");
  const summary = {
    passed: true,
    durationMs: Date.now() - started,
    mutants: initial.length,
    splitUnits: split.units.length,
    partialObservations: Object.values(observed.files).reduce(
      (n, f) => n + f.mutants.length,
      0,
    ),
    scenarios: [
      "whole-vs-batches",
      "reuse",
      "index-rebuild",
      "interruption-resume",
      "report-rebuild",
      "space-and-unicode-path",
    ],
  };
  mkdirSync(join(tool, "docs"), { recursive: true });
  writeFileSync(
    join(tool, "docs", "local-qualification.json"),
    JSON.stringify(summary, null, 2) + "\n",
  );
  console.log(JSON.stringify(summary, null, 2));
  ok = true;
} finally {
  if (ok) rmSync(root, { recursive: true, force: true });
  else console.error("Failed qualification retained at " + root);
}
