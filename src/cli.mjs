#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { plan, config } from "./planner.mjs";
import { report } from "./runner.mjs";
import { docker, environment, remote } from "./docker.mjs";
export async function main(args = process.argv.slice(2), root = process.cwd()) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      base: { type: "string" },
      files: { type: "string", multiple: true },
      all: { type: "boolean" },
      force: { type: "boolean" },
      "docker-context": { type: "string" },
      help: { type: "boolean" },
      version: { type: "boolean" },
    },
  });
  if (values.version) return { version: "0.1.0" };
  if (values.help || !positionals.length)
    return "bedel plan|run --base <sha> | --files <path> (repeatable) | --all [--force] [--docker-context <context>]\nbedel resume|report <run-id> [--docker-context <context>]\nExecution always uses Docker resource limits. Configure a digest-pinned image and optional dockerContext in bedel.config.json.";
  const [command, id] = positionals;
  if (command === "report") {
    const path = join(root, "bedel.config.json");
    const threshold = existsSync(path)
      ? JSON.parse(readFileSync(path)).engine?.thresholds?.break
      : undefined;
    return report(join(root, ".bedel"), id, { threshold });
  }
  if (process.env.CI && ["run", "resume"].includes(command))
    throw Error(
      "Mutation execution is disabled in CI; use independent hardening",
    );
  const c = config(root),
    deadline = Date.now() + c.budgetSeconds * 1000;
  const context =
    values["docker-context"] ??
    c.dockerContext ??
    docker(null, ["context", "show"], { deadline });
  if (command === "resume") {
    if (!id || !/^[a-zA-Z0-9-]+$/.test(id))
      throw Error("Valid run ID required");
    const saved = JSON.parse(
      readFileSync(join(root, ".bedel", "runs", id, "run.json")),
    );
    return remote(root, saved.plan, { context, id, resume: true, deadline });
  }
  if (!["plan", "run"].includes(command) || positionals.length !== 1)
    throw Error("Unknown command or extra positional arguments");
  const env = environment(context, c.image, deadline),
    p = plan(root, values, env);
  return command === "plan"
    ? p
    : remote(root, p, { context, deadline, force: values.force });
}
if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  main()
    .then((result) => {
      console.log(
        typeof result === "string" ? result : JSON.stringify(result, null, 2),
      );
      if (result?.status && result.status !== "complete") process.exitCode = 2;
    })
    .catch((error) => {
      console.error("bedel: " + error.message);
      process.exitCode = 1;
    });
}
