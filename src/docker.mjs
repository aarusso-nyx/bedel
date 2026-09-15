import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { atomic, get, rebuild } from "./store.mjs";
import { execute, report, validatePlan } from "./runner.mjs";
import { packageManager } from "./prepare.mjs";
import { safe } from "./planner.mjs";
import { imageIdentity, equivalentImage } from "./image-identity.mjs";
const tool = join(dirname(fileURLToPath(import.meta.url)), "..");
export function docker(
  context,
  args,
  { deadline = Date.now() + 30000, ...options } = {},
) {
  return execFileSync(
    "docker",
    [...(context ? ["--context", context] : []), ...args],
    {
      encoding: "utf8",
      timeout: Math.max(1, deadline - Date.now()),
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    },
  ).trim();
}
export function environment(context, image, deadline, expectedIdentity) {
  if (!/^(?:.+@)?sha256:[a-f0-9]{64}$/.test(image ?? ""))
    throw Error("Docker image must be pinned with @sha256 digest");
  const info = JSON.parse(
    docker(context, ["info", "--format", "{{json .}}"], { deadline }),
  );
  if (info.OSType !== "linux") throw Error("Linux Docker daemon required");
  const arch =
    info.Architecture === "x86_64"
      ? "amd64"
      : info.Architecture === "aarch64"
        ? "arm64"
        : info.Architecture;
  if (!["amd64", "arm64"].includes(arch))
    throw Error("Unsupported Docker architecture");
  let runtime;
  try {
    runtime = JSON.parse(
      docker(context, ["image", "inspect", "--format", "{{json .}}", image], {
        deadline,
      }),
    );
  } catch {
    if (!expectedIdentity)
      throw Error(
        "Pinned runtime image unavailable; build or load it on the selected Docker daemon first",
      );
    const ids = [
      ...new Set(
        docker(context, ["image", "ls", "--quiet", "--no-trunc"], { deadline })
          .split("\n")
          .filter(Boolean),
      ),
    ];
    if (!ids.length)
      throw Error("No equivalent pinned runtime on selected daemon");
    runtime = equivalentImage(
      JSON.parse(docker(context, ["image", "inspect", ...ids], { deadline })),
      expectedIdentity,
    );
  }
  const identity = imageIdentity(runtime);
  if (expectedIdentity && identity !== expectedIdentity)
    throw Error("Pinned image execution identity mismatch");
  if (runtime.Os !== "linux" || runtime.Architecture !== arch)
    throw Error(
      "Runtime image architecture does not match the selected Linux daemon",
    );
  return {
    platform: "linux",
    arch,
    image,
    imageIdentity: identity,
    imageReference: runtime.Id,
    cpus: info.NCPU,
    memoryMiB: Math.floor(info.MemTotal / 1048576),
  };
}
export function collect(root, meta, deadline, { call = docker } = {}) {
  const store = join(root, ".bedel");
  mkdirSync(store, { recursive: true });
  call(meta.context, ["cp", meta.name + ":/capsule/project/.bedel/.", store], {
    deadline,
  });
  // The copied capsule contains the previous host locator. The client owns the
  // current locator, so a checkpoint must never roll transport metadata back.
  atomic(join(store, "remote", meta.id + ".json"), meta);
}
export function recoverRemote(
  root,
  meta,
  context,
  deadline,
  { call = docker, copy = collect } = {},
) {
  if (!meta.name.startsWith("bedel-" + meta.id + "-"))
    throw Error("Invalid Bedel container identity");
  let migration;
  try {
    const state = JSON.parse(
      call(
        meta.context,
        ["inspect", "--format", "{{json .State}}", meta.name],
        { deadline: Math.min(deadline, Date.now() + 5000) },
      ),
    );
    if (state.Running && meta.context === context) return { active: true };
    if (state.Running) {
      const label = call(
        meta.context,
        [
          "inspect",
          "--format",
          '{{index .Config.Labels "org.bedel.run"}}',
          meta.name,
        ],
        { deadline },
      );
      if (label !== meta.id) throw Error("Wrong remote container owner");
      call(meta.context, ["stop", "--time", "3", meta.name], { deadline });
    }
    copy(root, meta, deadline);
  } catch (error) {
    if (meta.context === context || /identity|owner/.test(error.message))
      throw error;
    migration = {
      checkpoint: "local",
      previousHostUnavailable: true,
      unsynchronizedProgressMayBeMissing: true,
      previousWorkerDeadline: meta.deadline,
    };
  }
  const store = join(root, ".bedel"),
    prior = JSON.parse(readFileSync(join(store, "runs", meta.id, "run.json")));
  rebuild(store);
  for (const [unit, hash] of Object.entries(prior.completed)) {
    const object = get(store, hash);
    if (object.kind !== "unit" || object.unit !== unit)
      throw Error("Local checkpoint unit identity mismatch");
  }
  for (const unit of prior.plan.units) {
    const key = unit.sourceKey ?? unit.key,
      path = join(store, "checkpoints", key + ".json");
    if (existsSync(path)) {
      const object = get(store, JSON.parse(readFileSync(path)).hash);
      if (object.kind !== "checkpoint" || object.unit !== key)
        throw Error("Local source checkpoint identity mismatch");
    }
  }
  return { prior, migration };
}
export async function remote(
  root,
  plan,
  { context, deadline, id = randomUUID(), resume = false, force = false },
) {
  if (!/^[a-zA-Z0-9-]+$/.test(id)) throw Error("Invalid run ID");
  const store = join(root, ".bedel"),
    metaPath = join(store, "remote", id + ".json"),
    runPath = join(store, "runs", id, "run.json");
  let meta, migration;
  if (resume && existsSync(metaPath)) {
    meta = JSON.parse(readFileSync(metaPath));
    const recovered = recoverRemote(root, meta, context, deadline);
    if (recovered.active) return attach(root, meta, deadline);
    migration = recovered.migration;
    if (recovered.prior.status === "complete")
      return { ...report(store, id), migration };
    plan = recovered.prior.plan;
  }
  if (!plan) plan = JSON.parse(readFileSync(runPath)).plan;
  validatePlan(root, plan);
  const env = environment(
    context,
    plan.config.image,
    deadline,
    plan.environment.imageIdentity,
  );
  if (
    plan.environment.image !== env.image ||
    plan.environment.arch !== env.arch ||
    plan.environment.platform !== "linux"
  )
    throw Error(
      "Resume needs compatible Linux architecture and pinned image; create a new run for another environment",
    );
  if (plan.config.cpus > env.cpus || plan.config.memoryMiB > env.memoryMiB)
    throw Error("Docker host capacity below configured limits");
  const manifest = JSON.parse(readFileSync(join(root, "package.json")));
  packageManager(manifest, existsSync(join(root, "pnpm-lock.yaml")));
  if (
    !existsSync(join(root, "pnpm-lock.yaml")) &&
    !existsSync(join(root, "package-lock.json")) &&
    !existsSync(join(root, "npm-shrinkwrap.json"))
  )
    throw Error(
      "Provide an npm lock or pnpm-lock.yaml with a pinned packageManager",
    );
  const capsule = mkdtempSync(join(tmpdir(), "bedel-capsule-"));
  try {
    mkdirSync(join(capsule, "project"));
    mkdirSync(join(capsule, "tool"));
    const tracked = execFileSync("git", ["ls-files", "-z"], {
      cwd: root,
      timeout: Math.max(1, deadline - Date.now()),
    })
      .toString()
      .split("\0")
      .filter(Boolean);
    const files = [
      ...new Set([
        ...tracked,
        "bedel.config.json",
        ...(plan.config.inputs ?? []),
        ...plan.units.flatMap((u) => [
          u.source,
          ...u.tests,
          ...u.inputs.map(([p]) => p),
        ]),
      ]),
    ];
    for (const path of files) {
      if (Date.now() >= deadline)
        throw Error("Budget exhausted during capsule preparation");
      if (
        path.startsWith(".bedel/") ||
        path.startsWith(".git/") ||
        !existsSync(join(root, path))
      )
        continue;
      const source = safe(root, path);
      mkdirSync(dirname(join(capsule, "project", path)), { recursive: true });
      cpSync(source, join(capsule, "project", path));
    }
    for (const path of ["src", "package.json", "toolchain-lock.json"])
      cpSync(join(tool, path), join(capsule, "tool", path), {
        recursive: true,
      });
    cpSync(
      join(tool, "toolchain-lock.json"),
      join(capsule, "tool", "npm-shrinkwrap.json"),
    );
    if (existsSync(store))
      cpSync(store, join(capsule, "project", ".bedel"), { recursive: true });
    atomic(join(capsule, "plan.json"), plan);
    atomic(join(capsule, "options.json"), { force });
    if (!existsSync(runPath))
      atomic(runPath, { id, plan, completed: {}, status: "preparing" });
    // Persist pending queue inside capsule before dependency installation begins.
    atomic(join(capsule, "project", ".bedel", "runs", id, "run.json"), {
      ...JSON.parse(readFileSync(runPath)),
      status: "preparing",
    });
    writeFileSync(
      join(capsule, "start.sh"),
      `#!/bin/sh\nset -eu\nnode /capsule/tool/src/preflight.mjs ${id}\ncd /capsule/tool\nnpm ci --ignore-scripts --omit=dev\ncd /capsule/project\nnode /capsule/tool/src/prepare.mjs ${deadline - 2000}\nnode /capsule/tool/src/worker.mjs ${id} ${deadline - 1000}\n`,
    );
    const name = "bedel-" + id + "-" + randomUUID().slice(0, 8),
      volume = docker(context, ["volume", "create", name], { deadline });
    docker(
      context,
      [
        "create",
        "--name",
        name,
        "--label",
        "org.bedel.run=" + id,
        "--cpus",
        String(plan.config.cpus),
        "--memory",
        `${plan.config.memoryMiB}m`,
        "--mount",
        `type=volume,source=${volume},target=/capsule`,
        env.imageReference,
        "node",
        "-e",
        `const c=require('child_process').spawn('/bin/sh',['/capsule/start.sh'],{stdio:'inherit',detached:true});setTimeout(()=>{try{process.kill(-c.pid,'SIGTERM')}catch{}setTimeout(()=>process.exit(124),1000)},Math.max(1,${deadline - 1000}-Date.now()));c.on('exit',code=>process.exit(code??1));`,
      ],
      { deadline },
    );
    meta = { id, context, name, volume, deadline };
    atomic(metaPath, meta);
    docker(context, ["cp", capsule + "/.", name + ":/capsule"], { deadline });
    docker(context, ["start", name], { deadline });
  } finally {
    rmSync(capsule, { recursive: true, force: true });
  }
  return { ...(await attach(root, meta, deadline)), migration };
}
async function attach(root, meta, deadline) {
  const result = await execute(
    "docker",
    ["--context", meta.context, "wait", meta.name],
    { cwd: root, deadline: deadline - 1000 },
  );
  let state;
  try {
    state = JSON.parse(
      docker(
        meta.context,
        ["inspect", "--format", "{{json .State}}", meta.name],
        { deadline },
      ),
    );
    collect(root, meta, deadline);
  } catch {
    return {
      id: meta.id,
      status: "remote-pending",
      remote: meta,
      transport: result.kind,
    };
  }
  const r = report(join(root, ".bedel"), meta.id);
  if (r.status === "preparing") {
    r.status = state.Running
      ? "remote-pending"
      : state.ExitCode === 124
        ? "budget-exhausted"
        : "dependency-preparation-failed";
    if (!state.Running) {
      const path = join(root, ".bedel", "runs", meta.id, "run.json"),
        saved = JSON.parse(readFileSync(path));
      saved.status = r.status;
      saved.failure = { kind: r.status, containerExitCode: state.ExitCode };
      atomic(path, saved);
    }
  }
  return { ...r, remote: meta, containerState: state, transport: result.kind };
}
