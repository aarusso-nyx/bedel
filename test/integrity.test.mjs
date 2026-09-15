import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { atomic, digest, put, rebuild } from "../src/store.mjs";
import { identity, validateCompletion } from "../src/results.mjs";
import { plan } from "../src/planner.mjs";
import { run } from "../src/runner.mjs";
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "bedel-integrity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "source.js"), "export const a=1;");
  writeFileSync(join(root, "test.js"), "test");
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ version: "1.0.0", type: "module" }),
  );
  writeFileSync(
    join(root, "bedel.config.json"),
    JSON.stringify({
      units: [{ source: "source.js", tests: ["test.js"], dependencies: [] }],
    }),
  );
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
function data(unit, status = "Killed") {
  const mutant = {
    id: "0",
    location: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
    mutatorName: "BooleanLiteral",
    replacement: "false",
    status,
  };
  const report = {
    schemaVersion: "1.0",
    files: {
      [unit.source]: {
        language: "javascript",
        source: "export const a=1;",
        mutants: [mutant],
      },
    },
    testFiles: {
      "test.js": { source: "test", tests: [{ id: "0", name: "test" }] },
    },
  };
  const census = { unit: unit.key, ids: [identity(unit.source, mutant)] };
  const receipt = {
    unit: unit.key,
    code: 0,
    reportDigest: digest(report),
    censusDigest: digest(census),
  };
  return { report, census, receipt };
}
test("reject incomplete, nonterminal, duplicate populations and missing exit receipt", () => {
  const unit = { source: "source.js", key: "key", start: 1, end: 1 };
  const d = data(unit);
  assert.doesNotThrow(() =>
    validateCompletion(unit, d.report, d.census, d.receipt),
  );
  for (const status of ["Pending", "RuntimeError"]) {
    const x = data(unit, status);
    assert.throws(
      () => validateCompletion(unit, x.report, x.census, x.receipt),
      /Nonterminal/,
    );
  }
  assert.throws(
    () =>
      validateCompletion(unit, d.report, { ...d.census, ids: [] }, d.receipt),
    /population/,
  );
  assert.throws(
    () =>
      validateCompletion(unit, d.report, d.census, { ...d.receipt, code: 1 }),
    /receipt/,
  );
  d.report.files["source.js"].mutants.push(
    d.report.files["source.js"].mutants[0],
  );
  assert.throws(
    () => validateCompletion(unit, d.report, d.census, d.receipt),
    /duplicate/,
  );
});
test("wrong unit cache reference rejected; contradictory objects never pick favorable score", async (t) => {
  const root = fixture(t),
    p = plan(root, { all: true }),
    store = join(root, ".bedel"),
    unit = p.units[0];
  const d = data(unit);
  const bad = put(store, { kind: "unit", unit: "another", report: d.report });
  atomic(join(store, "index.json"), { [unit.key]: bad });
  await assert.rejects(run(root, p), /identity mismatch/);
  put(store, { kind: "unit", unit: unit.key, report: d.report });
  put(store, {
    kind: "unit",
    unit: unit.key,
    report: data(unit, "Survived").report,
  });
  assert.throws(() => rebuild(store), /Conflicting/);
});
test("source drift during execution and attractive orphan report cannot be cached", async (t) => {
  const root = fixture(t),
    p = plan(root, { all: true }),
    unit = p.units[0];
  let executions = 0;
  const executor = async (_command, _args, { env }) => {
    executions++;
    const d = data(unit);
    atomic(env.BEDEL_FINAL, d.report);
    atomic(env.BEDEL_CENSUS, d.census);
    atomic(env.BEDEL_REPORT_READY, {
      unit: unit.key,
      reportDigest: digest(d.report),
      censusDigest: digest(d.census),
    });
    const hash = put(env.BEDEL_STORE, {
      kind: "checkpoint",
      unit: env.BEDEL_UNIT,
      snapshot: d.report,
    });
    atomic(join(env.BEDEL_STORE, "checkpoints", env.BEDEL_UNIT + ".json"), {
      hash,
    });
    writeFileSync(join(root, "source.js"), "changed");
    return { code: 0, kind: "complete" };
  };
  const result = await run(root, p, { executor });
  assert.equal(result.status, "incomplete-result");
  assert.equal(result.complete, 0);
  assert.equal(executions, 1);
  assert.equal(
    existsSync(join(root, ".bedel", "checkpoints", unit.sourceKey + ".json")),
    false,
  );
  assert.equal(Object.keys(rebuild(join(root, ".bedel"))).length, 0);
});
test("untracked additions fail classification; removed source is retired; version/group metadata reuse", (t) => {
  const root = fixture(t),
    before = plan(root, { all: true });
  writeFileSync(join(root, "new.js"), "new");
  assert.throws(() => plan(root, { base: "HEAD" }), /Unclassified/);
  rmSync(join(root, "new.js"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ version: "2.0.0", type: "module" }),
  );
  const c = JSON.parse(readFileSync(join(root, "bedel.config.json")));
  c.units[0].group = "renamed";
  writeFileSync(join(root, "bedel.config.json"), JSON.stringify(c));
  assert.equal(plan(root, { all: true }).units[0].key, before.units[0].key);
  rmSync(join(root, "source.js"));
  const retired = plan(root, { base: "HEAD" });
  assert.deepEqual(retired.removedSources, ["source.js"]);
  assert.equal(retired.units.length, 0);
});

test("threshold-only report evaluation changes verdict without execution or new keys", async (t) => {
  const root = fixture(t),
    p = plan(root, { all: true }),
    unit = p.units[0],
    store = join(root, ".bedel");
  const d = data(unit);
  const killed = d.report.files[unit.source].mutants[0];
  d.report.files[unit.source].mutants.push({
    ...killed,
    id: "1",
    replacement: "true",
    status: "Survived",
  });
  const hash = put(store, { kind: "unit", unit: unit.key, report: d.report });
  atomic(join(store, "index.json"), { [unit.key]: hash });
  const finished = await run(root, p);
  const { main } = await import("../src/cli.mjs");
  const configPath = join(root, "bedel.config.json"),
    c = JSON.parse(readFileSync(configPath));
  c.engine = { thresholds: { break: 40 } };
  writeFileSync(configPath, JSON.stringify(c));
  const low = await main(["report", finished.id], root);
  assert.equal(low.score, 50);
  assert.equal(low.thresholdMet, true);
  c.engine.thresholds.break = 80;
  writeFileSync(configPath, JSON.stringify(c));
  const high = await main(["report", finished.id], root);
  assert.equal(high.thresholdMet, false);
  assert.equal(high.status, "complete");
  assert.equal(plan(root, { all: true }).units[0].key, unit.key);
});

test("resume uses validated local checkpoint when the old Docker host is offline", async (t) => {
  const root = fixture(t),
    p = plan(root, { all: true });
  atomic(join(root, ".bedel", "runs", "offline", "run.json"), {
    id: "offline",
    plan: p,
    completed: {},
    status: "budget-exhausted",
  });
  const { recoverRemote } = await import("../src/docker.mjs");
  const result = recoverRemote(
    root,
    {
      id: "offline",
      name: "bedel-offline-abcdef12",
      context: "old-host",
      deadline: 123,
    },
    "new-host",
    Date.now() + 1000,
    {
      call: () => {
        throw Error("Host unreachable");
      },
      copy: () => {
        throw Error("Must not copy inaccessible daemon");
      },
    },
  );
  assert.equal(result.prior.plan.units.length, 1);
  assert.equal(result.migration.previousHostUnavailable, true);
  assert.equal(result.migration.unsynchronizedProgressMayBeMissing, true);
});

test("Corepack-style pnpm pin validates archive integrity instead of dropping it", async () => {
  const { packageManager, verifyArchive } = await import("../src/prepare.mjs");
  const bytes = Buffer.from("test archive"),
    { createHash } = await import("node:crypto");
  const hex = createHash("sha512").update(bytes).digest("hex");
  const manager = packageManager(
    { packageManager: "pnpm@9.15.0+sha512." + hex },
    true,
  );
  assert.equal(manager.version, "9.15.0");
  assert.doesNotThrow(() => verifyArchive(bytes, manager));
  assert.throws(
    () => verifyArchive(Buffer.from("changed"), manager),
    /integrity mismatch/,
  );
  assert.throws(
    () => packageManager({ packageManager: "pnpm@9.15.0+sha512.bad" }, true),
    /valid Corepack/,
  );
});

test("transitive source graph selects callers and handles cycles without expansion to all", (t) => {
  const root = fixture(t);
  for (const file of ["a.js", "b.js", "c.js", "unrelated.js"])
    writeFileSync(join(root, file), "export const n=1;");
  const units = [
    { source: "a.js", tests: ["test.js"], dependencies: ["b.js"] },
    { source: "b.js", tests: ["test.js"], dependencies: ["c.js"] },
    { source: "c.js", tests: ["test.js"], dependencies: ["a.js"] },
    { source: "unrelated.js", tests: ["test.js"], dependencies: [] },
  ];
  writeFileSync(join(root, "bedel.config.json"), JSON.stringify({ units }));
  const selected = plan(root, { files: ["c.js"] });
  assert.deepEqual(
    selected.units.map((u) => u.source),
    ["a.js", "b.js", "c.js"],
  );
  assert.equal(
    new Set(selected.units[0].inputs.map(([file]) => file)).size,
    selected.units[0].inputs.length,
  );
  assert.throws(() => plan(root, { files: ["unknown.js"] }), /Unclassified/);
});

test("default selection retains unfinished work and skips unchanged complete sources", async (t) => {
  const root = fixture(t),
    p = plan(root, { all: true }),
    unit = p.units[0],
    store = join(root, ".bedel");
  const paused = await run(root, p, { deadline: Date.now() - 1 });
  assert.equal(paused.pending, 1);
  assert.equal(plan(root).units.length, 1);
  const hash = put(store, {
    kind: "unit",
    unit: unit.key,
    report: data(unit).report,
  });
  atomic(join(store, "index.json"), { [unit.key]: hash });
  await run(root, p);
  assert.equal(plan(root).units.length, 0);
  writeFileSync(join(root, "source.js"), "export const a=2;");
  assert.equal(plan(root).units.length, 1);
});

test("package resolution names, entrypoints and pnpm overrides invalidate keys", (t) => {
  const root = fixture(t),
    file = join(root, "package.json"),
    original = JSON.parse(readFileSync(file)),
    key = plan(root, { all: true }).units[0].key;
  for (const change of [
    { name: "self-reference" },
    { main: "other.js" },
    { module: "other.mjs" },
    { browser: "browser.js" },
    { pnpm: { overrides: { vitest: "4.0.0" } } },
  ]) {
    writeFileSync(file, JSON.stringify({ ...original, ...change }));
    assert.notEqual(
      plan(root, { all: true }).units[0].key,
      key,
      JSON.stringify(change),
    );
  }
  writeFileSync(
    file,
    JSON.stringify({
      ...original,
      version: "3.0.0",
      description: "changed prose",
    }),
  );
  assert.equal(plan(root, { all: true }).units[0].key, key);
});

test("packaged toolchain lock matches the repository installation lock", () => {
  const packed = readFileSync(
      new URL("../toolchain-lock.json", import.meta.url),
    ),
    installed = readFileSync(
      new URL("../npm-shrinkwrap.json", import.meta.url),
    );
  assert.equal(digest(packed), digest(installed));
});

test("OCI execution identity matches across image stores and rejects changed layers/config", async () => {
  const { imageIdentity, equivalentImage } =
    await import("../src/image-identity.mjs");
  const a = {
    Id: "sha256:config",
    Os: "linux",
    Architecture: "arm64",
    Variant: "v8",
    RootFS: { Layers: ["sha256:" + "a".repeat(64)] },
    Config: {
      Env: ["A=b"],
      Cmd: ["node"],
      User: "",
      Volumes: null,
      Tty: false,
    },
  };
  const b = {
    ...a,
    Id: "sha256:manifest",
    Config: { Env: ["A=b"], Cmd: ["node"] },
  };
  assert.equal(imageIdentity(a), imageIdentity(b));
  assert.equal(equivalentImage([b], imageIdentity(a)).Id, b.Id);
  assert.throws(
    () =>
      equivalentImage(
        [{ ...b, RootFS: { Layers: ["sha256:" + "b".repeat(64)] } }],
        imageIdentity(a),
      ),
    /No equivalent/,
  );
  assert.throws(
    () =>
      equivalentImage(
        [{ ...b, Config: { ...b.Config, User: "1000" } }],
        imageIdentity(a),
      ),
    /No equivalent/,
  );
});

test("collect preserves the current host locator after capsule metadata is copied", async (t) => {
  const root = fixture(t),
    meta = { id: "run", name: "bedel-run-current", context: "new-host" };
  const { collect } = await import("../src/docker.mjs");
  collect(root, meta, Date.now() + 1000, {
    call: () =>
      atomic(join(root, ".bedel", "remote", "run.json"), {
        ...meta,
        context: "old-host",
      }),
  });
  assert.deepEqual(
    JSON.parse(readFileSync(join(root, ".bedel", "remote", "run.json"))),
    meta,
  );
});
