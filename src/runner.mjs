import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { atomic, put, get, digest, rebuild } from "./store.mjs";
import { validateCompletion } from "./results.mjs";
import { inputDigest, plan as makePlan } from "./planner.mjs";
const here = dirname(fileURLToPath(import.meta.url));
export function failureKind(log) {
  if (/heap out of memory|allocation failed|exit code 137|OOM/i.test(log))
    return "worker-memory-or-killed";
  if (/SIGSEGV|SIGABRT|segmentation fault|core dumped/i.test(log))
    return "native-crash";
  if (/SIGKILL/i.test(log)) return "worker-memory-or-killed";
  return "engine-failed";
}
export function execute(command, args, { cwd, env, deadline, log }) {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "",
      expired = false;
    const consume = (chunk) => {
      const text = chunk.toString();
      output = (output + text).slice(-100000);
      if (log) writeFileSync(log, text, { flag: "a" });
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    const kill = () => {
      expired = true;
      try {
        if (process.platform === "win32") child.kill("SIGTERM");
        else process.kill(-child.pid, "SIGTERM");
      } catch {}
      setTimeout(() => {
        try {
          if (process.platform === "win32") child.kill("SIGKILL");
          else process.kill(-child.pid, "SIGKILL");
        } catch {}
      }, 1000).unref();
    };
    const timer = setTimeout(kill, Math.max(1, deadline - Date.now()));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolveResult({ code: -1, kind: "launch-failed", output: error.message });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolveResult({
        code,
        signal,
        kind: expired
          ? "budget-exhausted"
          : code === 0
            ? "complete"
            : failureKind(output),
        output,
      });
    });
  });
}
function verifyInputs(root, plan) {
  for (const u of plan.units)
    for (const [p, hash] of [...u.inputs, ...u.common])
      if (inputDigest(root, p) !== hash)
        throw Error(`Input changed; make a new plan: ${p}`);
}
export function validatePlan(root, plan) {
  verifyInputs(root, plan);
  const currentSources = new Map(
    makePlan(root, { all: true }, plan.environment).units.map((u) => [
      u.source,
      u.sourceKey,
    ]),
  );
  if (
    plan.units.some(
      (u) => u.sourceKey && currentSources.get(u.source) !== u.sourceKey,
    )
  )
    throw Error("Execution inputs or Bedel toolchain changed; make a new plan");
}
export function report(store, id, { threshold } = {}) {
  if (!/^[a-zA-Z0-9-]+$/.test(id)) throw Error("Invalid run ID");
  const run = JSON.parse(readFileSync(join(store, "runs", id, "run.json")));
  const units = run.plan.units.map((u) => {
    const result = run.completed[u.key]
      ? get(store, run.completed[u.key])
      : null;
    if (result && result.unit !== u.key)
      throw Error("Cached result belongs to another unit");
    return { source: u.source, start: u.start, end: u.end, key: u.key, result };
  });
  const counts = {};
  for (const u of units)
    for (const file of Object.values(u.result?.report.files ?? {}))
      for (const m of file.mutants)
        counts[m.status] = (counts[m.status] ?? 0) + 1;
  const detected = (counts.Killed ?? 0) + (counts.Timeout ?? 0),
    total = detected + (counts.Survived ?? 0) + (counts.NoCoverage ?? 0);
  const score = total ? (100 * detected) / total : null;
  const target = threshold ?? run.plan.config.engine?.thresholds?.break ?? 0;
  return {
    id,
    score,
    counts,
    threshold: target,
    thresholdMet: score === null ? null : score >= target,
    status: run.status,
    failure: run.failure,
    complete: units.filter((u) => u.result).length,
    pending: units.filter((u) => !u.result).length,
    units,
  };
}
export async function run(
  root,
  plan,
  {
    id = randomUUID(),
    force = false,
    store = join(root, ".bedel"),
    deadline = Date.now() + plan.config.budgetSeconds * 1000,
    executor = execute,
  } = {},
) {
  const originalRoot = root;
  root = realpathSync(root);
  store = resolve(root, relative(originalRoot, store));
  if (!/^[a-zA-Z0-9-]+$/.test(id)) throw Error("Invalid run ID");
  const normalizedArch = process.arch === "x64" ? "amd64" : process.arch;
  const expectedArch =
    plan.environment.arch === "x64" ? "amd64" : plan.environment.arch;
  if (
    plan.environment.platform !== process.platform ||
    expectedArch !== normalizedArch ||
    (plan.environment.node && plan.environment.node !== process.version)
  )
    throw Error("Incompatible execution environment; create a new plan");
  validatePlan(root, plan);
  const dir = join(store, "runs", id);
  mkdirSync(dir, { recursive: true });
  const runPath = join(dir, "run.json");
  let state = existsSync(runPath)
    ? JSON.parse(readFileSync(runPath))
    : { id, plan, completed: {}, status: "running" };
  if (digest(state.plan) !== digest(plan)) throw Error("Resume plan differs");
  const indexPath = join(store, "index.json");
  let index = {
    ...rebuild(store),
    ...(existsSync(indexPath) ? JSON.parse(readFileSync(indexPath)) : {}),
  };
  if (state.failure) {
    state.previousFailures = [...(state.previousFailures ?? []), state.failure];
    delete state.failure;
  }
  state.status = "running";
  atomic(runPath, state);
  const reserve = 2000;
  for (const unit of plan.units) {
    verifyInputs(root, plan);
    if (state.completed[unit.key]) continue;
    if (!force && index[unit.key]) {
      const cached = get(store, index[unit.key]);
      if (cached.kind !== "unit" || cached.unit !== unit.key)
        throw Error("Cache unit identity mismatch");
      state.completed[unit.key] = index[unit.key];
      atomic(runPath, state);
      continue;
    }
    if (Date.now() + reserve >= deadline) {
      state.status = "budget-exhausted";
      break;
    }
    const journal = join(dir, unit.key + ".jsonl"),
      output = join(dir, unit.key + ".json"),
      configPath = join(dir, unit.key + ".config.json");
    const checkpoint = join(
      store,
      "checkpoints",
      (unit.sourceKey ?? unit.key) + ".json",
    );
    const incremental = join(dir, unit.key + ".incremental.json");
    if (!force && existsSync(checkpoint))
      atomic(
        incremental,
        get(store, JSON.parse(readFileSync(checkpoint)).hash).snapshot,
      );
    else rmSync(incremental, { force: true });
    const c = {
      ...plan.config.engine,
      mutate: [unit.source],
      concurrency: plan.config.workers,
      thresholds: { high: 80, low: 60, break: 0 },
      incremental: true,
      incrementalFile: join(dir, unit.key + ".incremental.json"),
      reporters: ["json", "bedel-checkpoint"],
      jsonReporter: { fileName: output },
      plugins: [
        join(here, "vitest-plugin.mjs"),
        join(here, "reporter.mjs"),
        join(here, "batch-ignorer.mjs"),
      ],
      ignorers: ["bedel-batch"],
      ignorePatterns: [
        ...(plan.config.engine?.ignorePatterns ?? []),
        ".bedel/**",
      ],
      testRunner: "bedel-vitest",
      disableTypeChecks: false,
      dryRunOnly: false,
      inPlace: false,
      allowEmpty: false,
      testFiles: unit.tests,
      vitest: { ...plan.config.engine?.vitest },
      tempDirName: join(dir, "sandbox-" + unit.key),
    };
    atomic(configPath, c);
    const cli = join(
      dirname(
        createRequire(import.meta.url).resolve(
          "@stryker-mutator/core/package.json",
        ),
      ),
      "bin/stryker.js",
    );
    if (force) {
      c.force = true;
      atomic(configPath, c);
    }
    const censusPath = join(dir, unit.key + ".census.json"),
      readyPath = join(dir, unit.key + ".ready.json"),
      receiptPath = join(dir, unit.key + ".receipt.json");
    if (!force && existsSync(receiptPath)) {
      const reportValue = JSON.parse(readFileSync(output)),
        census = JSON.parse(readFileSync(censusPath)),
        receipt = JSON.parse(readFileSync(receiptPath));
      const value = validateCompletion(unit, reportValue, census, receipt);
      const hash = put(store, { kind: "unit", unit: unit.key, report: value });
      state.completed[unit.key] = hash;
      index[unit.key] = hash;
      atomic(indexPath, index);
      atomic(runPath, state);
      continue;
    }
    if (process.env.CI && executor === execute)
      throw Error("Mutation execution is disabled in CI");
    const result = await executor(process.execPath, [cli, "run", configPath], {
      cwd: root,
      env: {
        BEDEL_STORE: store,
        BEDEL_FORCE: force ? "1" : "0",
        BEDEL_UNIT: unit.sourceKey ?? unit.key,
        BEDEL_JOB: unit.key,
        BEDEL_START: String(unit.start),
        BEDEL_END: String(unit.end),
        BEDEL_JOURNAL: journal,
        BEDEL_INCREMENTAL: c.incrementalFile,
        BEDEL_FINAL: output,
        BEDEL_CENSUS: censusPath,
        BEDEL_REPORT_READY: readyPath,
      },
      deadline: deadline - reserve,
      log: join(dir, unit.key + ".log"),
    });
    try {
      try {
        validatePlan(root, plan);
      } catch (error) {
        // Preserve immutable observations for diagnosis but detach any snapshot
        // collected while sources were changing from reusable checkpoints.
        rmSync(checkpoint, { force: true });
        rmSync(incremental, { force: true });
        throw error;
      }
      if (result.code !== 0) throw Error(result.kind);
      const reportValue = JSON.parse(readFileSync(output)),
        census = JSON.parse(readFileSync(censusPath)),
        ready = JSON.parse(readFileSync(readyPath));
      if (
        ready.unit !== unit.key ||
        ready.reportDigest !== digest(reportValue) ||
        ready.censusDigest !== digest(census)
      )
        throw Error("Invalid reporter completion");
      const receipt = { ...ready, code: 0 };
      const value = validateCompletion(unit, reportValue, census, receipt);
      atomic(receiptPath, receipt);
      const hash = put(store, { kind: "unit", unit: unit.key, report: value });
      const existing = rebuild(store); // Reject incompatible terminal observations, never choose a favorable result.
      state.completed[unit.key] = hash;
      index = { ...existing, [unit.key]: hash };
      atomic(indexPath, index);
    } catch (error) {
      state.status = result.code === 0 ? "incomplete-result" : result.kind;
      state.failure = {
        unit: unit.key,
        kind: state.status,
        detail: error.message,
      };
      atomic(runPath, state);
      break;
    }
    atomic(runPath, state);
  }
  if (Object.keys(state.completed).length === plan.units.length)
    state.status = "complete";
  atomic(runPath, state);
  const selectionPath = join(store, "selection.json"),
    previous = existsSync(selectionPath)
      ? JSON.parse(readFileSync(selectionPath))
      : null;
  const selected = new Set(plan.units.map((u) => u.source));
  const sources = previous ? { ...previous.sources } : { ...plan.baseline };
  for (const unit of plan.units) sources[unit.source] = unit.sourceKey;
  for (const source of plan.removedSources ?? []) delete sources[source];
  const pending = [
    ...new Set([
      ...(previous?.pending ?? []).filter((s) => !selected.has(s)),
      ...plan.units.filter((u) => !state.completed[u.key]).map((u) => u.source),
    ]),
  ];
  atomic(selectionPath, {
    sources,
    pending,
    base: previous?.base ?? plan.gitBase,
  });
  return report(store, id);
}
