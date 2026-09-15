import { execFileSync } from "node:child_process";
import { statfsSync, readFileSync } from "node:fs";
import { atomic } from "./store.mjs";
const [id] = process.argv.slice(2);
try {
  for (const executable of ["npm", "ps"])
    try {
      execFileSync(executable, ["--version"], { stdio: "pipe", timeout: 5000 });
    } catch {
      throw Error(
        `Runtime lacks ${executable}; use the supplied Bedel Dockerfile`,
      );
    }
  const disk = statfsSync("/capsule");
  if (Number(disk.files) > 0 && Number(disk.ffree) < 20000)
    throw Error(
      "Less than 20,000 free filesystem inodes for dependency preparation",
    );
  if (Number(disk.bavail) * Number(disk.bsize) < 536870912)
    throw Error("Less than 512 MiB available for dependency preparation");
} catch (error) {
  const path = `/capsule/project/.bedel/runs/${id}/run.json`,
    state = JSON.parse(readFileSync(path));
  state.status = "preparation-failed";
  state.failure = { kind: "runtime-preflight", detail: error.message };
  atomic(path, state);
  console.error("bedel: " + error.message);
  process.exitCode = 1;
}
