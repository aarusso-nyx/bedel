import { readFileSync } from "node:fs";
import { run } from "./runner.mjs";
const [id, deadline] = process.argv.slice(2);
const plan = JSON.parse(readFileSync("/capsule/plan.json"));
const result = await run("/capsule/project", plan, {
  id,
  deadline: Number(deadline),
  ...JSON.parse(readFileSync("/capsule/options.json")),
});

if (result.status !== "complete") process.exitCode = 2;
