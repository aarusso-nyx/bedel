import { readFileSync, existsSync, lstatSync, realpathSync } from "node:fs";
import { resolve, relative, isAbsolute, join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { digest } from "./store.mjs";
export function safe(root, path) {
  if (
    typeof path !== "string" ||
    !path ||
    isAbsolute(path) ||
    path.includes(":") ||
    path.includes("\0")
  )
    throw Error("Invalid relative path");
  const full = resolve(root, path),
    rel = relative(root, full);
  if (
    rel.startsWith("..") ||
    isAbsolute(rel) ||
    !existsSync(full) ||
    !lstatSync(full).isFile() ||
    realpathSync(full) !== resolve(realpathSync(root), path)
  )
    throw Error(`Missing or unsafe input: ${path}`);
  return full;
}
export function config(root) {
  const c = JSON.parse(readFileSync(join(root, "bedel.config.json"), "utf8"));
  if (!Array.isArray(c.units) || !c.units.length)
    throw Error("Declare source units");
  const sources = new Set();
  for (const u of c.units) {
    if (
      sources.has(u.source) ||
      !Array.isArray(u.tests) ||
      !u.tests.length ||
      !Array.isArray(u.dependencies)
    )
      throw Error("Each unique source needs explicit tests and dependencies");
    sources.add(u.source);
    for (const p of [
      ...(existsSync(join(root, u.source)) ? [u.source] : []),
      ...u.tests,
      ...u.dependencies,
    ])
      safe(root, p);
  }
  const bySource = new Map(c.units.map((u) => [u.source, [...u.dependencies]]));
  for (const unit of c.units) {
    const seen = new Set([unit.source]),
      dependencies = [];
    const visit = (path) => {
      if (seen.has(path)) return;
      seen.add(path);
      dependencies.push(path);
      for (const nested of bySource.get(path) ?? []) visit(nested);
    };
    for (const path of unit.dependencies) visit(path);
    unit.dependencies = dependencies.sort();
  }
  c.inputs = [
    ...new Set([
      ...(c.inputs ?? []),
      ...[
        "package.json",
        "package-lock.json",
        "npm-shrinkwrap.json",
        "pnpm-lock.yaml",
        "yarn.lock",
      ].filter((p) => existsSync(join(root, p))),
    ]),
  ];
  for (const p of c.inputs) safe(root, p);
  for (const name of [
    "workers",
    "cpus",
    "memoryMiB",
    "budgetSeconds",
    "batchLines",
  ])
    if (c[name] !== undefined && (!Number.isInteger(c[name]) || c[name] < 1))
      throw Error(`Invalid ${name}`);
  return {
    workers: 2,
    cpus: 2,
    memoryMiB: 8192,
    budgetSeconds: 1800,
    batchLines: 100,
    ...c,
  };
}
export function changed(root, base) {
  if (!base || base.startsWith("-"))
    throw Error("An explicit base or scope is required");
  execFileSync("git", ["rev-parse", "--verify", `${base}^{commit}`], {
    cwd: root,
    stdio: "pipe",
  });
  const tracked = execFileSync(
    "git",
    ["diff", "--name-only", "-z", base, "--"],
    {
      cwd: root,
    },
  )
    .toString()
    .split("\0")
    .filter(Boolean);
  const untracked = execFileSync(
    "git",
    [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      ".",
      ":!node_modules",
      ":!.bedel",
    ],
    { cwd: root },
  )
    .toString()
    .split("\0")
    .filter(Boolean);
  return [...new Set([...tracked, ...untracked])];
}
export function inputDigest(root, path) {
  const bytes = readFileSync(safe(root, path));
  if (path.endsWith("package.json")) {
    const m = JSON.parse(bytes);
    for (const key of [
      "version",
      "description",
      "license",
      "author",
      "contributors",
      "repository",
      "homepage",
      "keywords",
      "bugs",
      "funding",
      "maintainers",
    ])
      delete m[key];
    return digest(m);
  }
  if (
    path.endsWith("package-lock.json") ||
    path.endsWith("npm-shrinkwrap.json")
  ) {
    const m = JSON.parse(bytes);
    delete m.name;
    delete m.version;
    if (m.packages?.[""]) {
      delete m.packages[""].name;
      delete m.packages[""].version;
      delete m.packages[""].license;
    }
    return digest(m);
  }
  return digest(bytes);
}
export function plan(
  root,
  options = {},
  environment = {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
  },
) {
  const c = config(root);
  const automatic = !options.all && !options.files && !options.base;
  const selectionPath = join(root, ".bedel", "selection.json");
  const previous =
    automatic && existsSync(selectionPath)
      ? JSON.parse(readFileSync(selectionPath))
      : null;
  if (automatic && !previous)
    throw Error("Use --base, --files or --all; no previous selection exists");
  const base = options.base ?? previous?.base;
  const modifications = options.all
    ? c.units.map((u) => u.source)
    : (options.files ??
      (base
        ? changed(root, base)
        : [
            ...c.units.map((u) => u.source),
            ...Object.keys(previous?.sources ?? {}),
          ]));
  let previousSources = Object.keys(previous?.sources ?? {});
  if (options.base) {
    try {
      const prefix = execFileSync("git", ["rev-parse", "--show-prefix"], {
        cwd: root,
        encoding: "utf8",
      }).trim();
      previousSources = JSON.parse(
        execFileSync(
          "git",
          ["show", `${options.base}:${prefix}bedel.config.json`],
          { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
        ),
      ).units.map((u) => u.source);
    } catch {}
  }
  const removedSources = [
    ...new Set([...previousSources, ...c.units.map((u) => u.source)]),
  ].filter((p) => !existsSync(join(root, p)) && modifications.includes(p));
  const declared = new Set([
    ...removedSources,
    "bedel.config.json",
    ...(c.inputs ?? []),
    ...c.units.flatMap((u) => [u.source, ...u.tests, ...u.dependencies]),
    ...(c.ignoredChanges ?? []),
  ]);
  const unknown = modifications.filter((p) => !declared.has(p));
  if (unknown.length)
    throw Error(
      `Unclassified changes: ${unknown.join(", ")}; declare dependencies or ignoredChanges`,
    );
  const common = (c.inputs ?? []).map((p) => [p, inputDigest(root, p)]);
  const execution = {
    engine: { ...c.engine },
    environment: {
      platform: environment.platform,
      arch: environment.arch,
      node: environment.node,
      image: environment.image,
    },
    workers: c.workers,
    cpus: c.cpus,
    memoryMiB: c.memoryMiB,
    toolchain: digest(
      readFileSync(
        fileURLToPath(new URL("../toolchain-lock.json", import.meta.url)),
      ),
    ),
    runner: digest(
      [
        "runner.mjs",
        "reporter.mjs",
        "vitest-plugin.mjs",
        "batch-ignorer.mjs",
        "workspace-aliases.mjs",
        "results.mjs",
        "store.mjs",
        "prepare.mjs",
        "docker.mjs",
        "image-identity.mjs",
        "worker.mjs",
      ].map((p) =>
        readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8"),
      ),
    ),
  };
  delete execution.engine.thresholds;
  const allUnits = c.units
    .filter((u) => !removedSources.includes(u.source))
    .flatMap((u) => {
      const inputs = [u.source, ...u.tests, ...u.dependencies].map((p) => [
        p,
        inputDigest(root, p),
      ]);
      const lines = readFileSync(safe(root, u.source), "utf8").split(
        "\n",
      ).length;
      const result = [];
      for (let start = 1; start <= lines; start += c.batchLines) {
        const end = Math.min(lines, start + c.batchLines - 1);
        const unit = {
          source: u.source,
          group: u.group ?? "default",
          tests: u.tests,
          start,
          end,
          inputs,
          common,
          execution,
        };
        const identity = { ...unit };
        delete identity.group;
        delete identity.start;
        delete identity.end;
        const sourceKey = digest(identity);
        result.push({
          ...unit,
          sourceKey,
          key: digest({ sourceKey, start, end }),
        });
      }
      return result;
    });
  const pending = new Set(previous?.pending ?? []);
  const units = allUnits.filter((u) =>
    automatic
      ? previous.sources[u.source] !== u.sourceKey || pending.has(u.source)
      : options.all ||
        modifications.includes("bedel.config.json") ||
        (c.inputs ?? []).some((p) => modifications.includes(p)) ||
        u.inputs.some(([p]) => modifications.includes(p)),
  );
  let gitBase = base ?? null;
  try {
    gitBase ??= execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {}
  return {
    version: 1,
    units,
    config: c,
    environment,
    selection: modifications,
    removedSources,
    baseline: Object.fromEntries(allUnits.map((u) => [u.source, u.sourceKey])),
    gitBase,
  };
}
