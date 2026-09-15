import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execute } from "./runner.mjs";
export function packageManager(manifest, hasPnpmLock) {
  if (!hasPnpmLock) return { name: "npm" };
  const match =
    /^pnpm@(\d+\.\d+\.\d+)(?:\+(sha224|sha256|sha384|sha512)\.([a-f0-9]+))?$/.exec(
      manifest.packageManager ?? "",
    );
  if (!match || (match[2] && match[3].length !== Number(match[2].slice(3)) / 4))
    throw Error(
      "Pin packageManager to pnpm@major.minor.patch with optional valid Corepack integrity",
    );
  return {
    name: "pnpm",
    version: match[1],
    algorithm: match[2],
    integrity: match[3],
  };
}
export function verifyArchive(bytes, manager) {
  if (
    manager.integrity &&
    createHash(manager.algorithm).update(bytes).digest("hex") !==
      manager.integrity
  )
    throw Error("Pinned pnpm archive integrity mismatch");
}
export async function installProject(root, deadline) {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"))),
    manager = packageManager(
      manifest,
      existsSync(join(root, "pnpm-lock.yaml")),
    );
  const launch = async (command, args, cwd = root) => {
    const result = await execute(command, args, { cwd, deadline });
    if (result.code !== 0)
      throw Error(
        `Dependency preparation failed: ${result.kind}\n${result.output}`,
      );
    return result.output;
  };
  if (manager.name === "npm") return launch("npm", ["ci", "--ignore-scripts"]);
  const directory = "/capsule/manager";
  mkdirSync(directory, { recursive: true });
  await launch("npm", [
    "pack",
    `pnpm@${manager.version}`,
    "--silent",
    "--pack-destination",
    directory,
  ]);
  const archive = join(directory, `pnpm-${manager.version}.tgz`);
  verifyArchive(readFileSync(archive), manager);
  await launch("npm", [
    "install",
    "--prefix",
    directory,
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    archive,
  ]);
  return launch(process.execPath, [
    join(directory, "node_modules/pnpm/bin/pnpm.cjs"),
    "install",
    "--frozen-lockfile",
    "--ignore-scripts",
  ]);
}
if (process.argv[1]?.endsWith("/prepare.mjs"))
  await installProject("/capsule/project", Number(process.argv[2]));
