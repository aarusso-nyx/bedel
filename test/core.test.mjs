import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { plan } from "../src/planner.mjs";
import { put, get, atomic } from "../src/store.mjs";
import { failureKind, run, report } from "../src/runner.mjs";
import { main } from "../src/cli.mjs";
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "bedel espaço-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [p, value] of Object.entries({
    "a.js": "export const a=1;\n",
    "b.js": "export const b=2;\n",
    "a.test.js": "a test",
    "b.test.js": "b test",
    "shared.json": "{}",
    "bedel.config.json": JSON.stringify({
      units: [
        { source: "a.js", tests: ["a.test.js"], dependencies: ["shared.json"] },
        { source: "b.js", tests: ["b.test.js"], dependencies: [] },
      ],
      inputs: [],
    }),
  }))
    writeFileSync(join(root, p), value);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-qm",
      "fixture",
    ],
    { cwd: root },
  );
  return root;
}
test("no implicit full campaign; source/test/dependency changes select only affected units", (t) => {
  const root = fixture(t);
  assert.throws(() => plan(root), /selection/);
  for (const file of ["a.js", "a.test.js", "shared.json"]) {
    const p = plan(root, { files: [file] });
    assert.equal(p.units.length, 1);
    assert.equal(p.units[0].source, "a.js");
  }
  assert.throws(() => plan(root, { files: ["unknown.js"] }), /Unclassified/);
  writeFileSync(join(root, "b.test.js"), "changed");
  assert.equal(plan(root, { base: "HEAD" }).units[0].source, "b.js");
});
test("content keys ignore commit/threshold changes, distinguish environment and dependencies", (t) => {
  const root = fixture(t),
    first = plan(root, { all: true });
  const configPath = join(root, "bedel.config.json"),
    c = JSON.parse(readFileSync(configPath));
  c.engine = { thresholds: { break: 99 } };
  writeFileSync(configPath, JSON.stringify(c));
  assert.equal(plan(root, { all: true }).units[0].key, first.units[0].key);
  writeFileSync(join(root, "shared.json"), "changed");
  const next = plan(root, { all: true });
  assert.notEqual(next.units[0].key, first.units[0].key);
  assert.equal(next.units[1].key, first.units[1].key);
  assert.notEqual(
    plan(root, { all: true }, { arch: "arm64" }).units[1].key,
    next.units[1].key,
  );
});
test("immutable object corruption rejected and report rebuilt without execution", async (t) => {
  const root = fixture(t),
    store = join(root, ".bedel"),
    p = plan(root, { files: ["a.js"] }),
    key = p.units[0].key;
  const hash = put(store, { kind: "unit", unit: key, report: { files: {} } });
  assert.deepEqual(get(store, hash).report, { files: {} });
  atomic(join(store, "index.json"), { [key]: hash });
  const result = await run(root, p);
  assert.equal(result.status, "complete");
  assert.equal(report(store, result.id).complete, 1);
  writeFileSync(join(store, "objects", hash + ".json"), "{}");
  assert.throws(() => get(store, hash), /Corrupt/);
});
test("expired budget preserves queue; changed inputs prevent resume", async (t) => {
  const root = fixture(t),
    p = plan(root, { all: true });
  const result = await run(root, p, { deadline: Date.now() - 1 });
  assert.equal(result.pending, 2);
  assert.equal(result.status, "budget-exhausted");
  writeFileSync(join(root, "a.js"), "changed");
  await assert.rejects(run(root, p, { id: result.id }), /Input changed/);
});
test("worker memory and native crash classified independently of Docker OOM flag", () => {
  assert.equal(
    failureKind("Worker exited with exit code 137"),
    "worker-memory-or-killed",
  );
  assert.equal(failureKind("SIGSEGV native fault"), "native-crash");
});
test("CI refuses mutation execution but permits help", async () => {
  const old = process.env.CI;
  process.env.CI = "true";
  try {
    await assert.rejects(main(["run", "--all"]), /disabled in CI/);
    assert.match(await main(["--help"]), /bedel/);
  } finally {
    if (old === undefined) delete process.env.CI;
    else process.env.CI = old;
  }
});

test("execution CPU and memory limits affect keys; daemon capacity does not", (t) => {
  const root = fixture(t),
    configPath = join(root, "bedel.config.json");
  const c = JSON.parse(readFileSync(configPath));
  const environment = {
    platform: "linux",
    arch: "arm64",
    image: "sha256:" + "a".repeat(64),
    cpus: 4,
    memoryMiB: 4096,
  };
  const initial = plan(root, { all: true }, environment).units[0].key;
  assert.equal(
    plan(root, { all: true }, { ...environment, cpus: 8, memoryMiB: 16384 })
      .units[0].key,
    initial,
  );
  c.cpus = 1;
  writeFileSync(configPath, JSON.stringify(c));
  const limited = plan(root, { all: true }, environment).units[0].key;
  assert.notEqual(limited, initial);
  c.memoryMiB = 1024;
  writeFileSync(configPath, JSON.stringify(c));
  assert.notEqual(plan(root, { all: true }, environment).units[0].key, limited);
});

test("installed symlink entrypoint executes CLI instead of returning silently", (t) => {
  const root = fixture(t),
    bin = join(root, "bedel");
  symlinkSync(fileURLToPath(new URL("../src/cli.mjs", import.meta.url)), bin);
  const result = JSON.parse(
    execFileSync(process.execPath, [bin, "--version"], { encoding: "utf8" }),
  );
  assert.equal(
    result.version,
    JSON.parse(readFileSync(new URL("../package.json", import.meta.url)))
      .version,
  );
});
