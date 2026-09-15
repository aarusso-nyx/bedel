// Standalone durable event adapter; replaces DEVAI's campaign-bound checkpoints.
import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { relative, join } from "node:path";
import { declareClassPlugin, PluginKind } from "@stryker-mutator/api/plugin";
import { atomic, put, get, digest } from "./store.mjs";
import { identity, terminal } from "./results.mjs";
export class DurableReporter {
  constructor() {
    const path =
      process.env.BEDEL_STORE &&
      join(
        process.env.BEDEL_STORE,
        "checkpoints",
        process.env.BEDEL_UNIT + ".json",
      );
    this.snapshot =
      path && existsSync(path) && process.env.BEDEL_FORCE !== "1"
        ? get(process.env.BEDEL_STORE, JSON.parse(readFileSync(path)).hash)
            .snapshot
        : { schemaVersion: "1.0", files: {}, testFiles: {} };
  }
  onDryRunCompleted({ result }) {
    this.snapshot.testFiles = {};
    for (const t of result.tests) {
      const file = relative(process.cwd(), t.fileName ?? "");
      const entry = (this.snapshot.testFiles[file] ??= {
        source:
          t.fileName && existsSync(t.fileName)
            ? readFileSync(t.fileName, "utf8")
            : "",
        tests: [],
      });
      entry.tests.push({
        id: t.id,
        name: t.name,
        ...(t.startPosition
          ? {
              location: {
                start: {
                  line: t.startPosition.line + 1,
                  column: t.startPosition.column + 1,
                },
              },
            }
          : {}),
      });
    }
  }
  onMutationTestingPlanReady({ mutantPlans }) {
    if (!process.env.BEDEL_CENSUS) return;
    const ids = mutantPlans
      .map((p) => p.mutant)
      .filter(
        (m) =>
          m.location.start.line + 1 >= Number(process.env.BEDEL_START) &&
          m.location.start.line + 1 <= Number(process.env.BEDEL_END),
      )
      .map((m) =>
        identity(relative(process.cwd(), m.fileName), {
          ...m,
          location: {
            start: {
              line: m.location.start.line + 1,
              column: m.location.start.column + 1,
            },
            end: {
              line: m.location.end.line + 1,
              column: m.location.end.column + 1,
            },
          },
        }),
      );
    this.census = { unit: process.env.BEDEL_JOB, ids };
    atomic(process.env.BEDEL_CENSUS, this.census);
  }
  onMutantTested(mutant) {
    if (
      mutant.statusReason === "bedel-other-batch" ||
      !terminal.has(mutant.status)
    )
      return;
    const path = process.env.BEDEL_JOURNAL;
    if (!path) return;
    appendFileSync(path, JSON.stringify(mutant) + "\n");
    const { fileName, ...value } = mutant;
    const file = relative(process.cwd(), fileName);
    const entry = (this.snapshot.files[file] ??= {
      language: file.endsWith(".ts") ? "typescript" : "javascript",
      source: readFileSync(fileName, "utf8"),
      mutants: [],
    });
    entry.mutants = entry.mutants.filter(
      (m) =>
        JSON.stringify([m.location, m.mutatorName, m.replacement]) !==
        JSON.stringify([value.location, value.mutatorName, value.replacement]),
    );
    entry.mutants.push(value);
    atomic(process.env.BEDEL_INCREMENTAL, this.snapshot);
    if (process.env.BEDEL_STORE) {
      put(process.env.BEDEL_STORE, {
        kind: "mutant",
        unit: process.env.BEDEL_UNIT,
        file,
        mutant: value,
      });
      atomic(
        join(
          process.env.BEDEL_STORE,
          "checkpoints",
          process.env.BEDEL_UNIT + ".json",
        ),
        {
          hash: put(process.env.BEDEL_STORE, {
            kind: "checkpoint",
            unit: process.env.BEDEL_UNIT,
            snapshot: this.snapshot,
          }),
        },
      );
    }
  }
  onMutationTestReportReady(report) {
    if (process.env.BEDEL_FINAL) {
      atomic(process.env.BEDEL_FINAL, report);
      atomic(process.env.BEDEL_REPORT_READY, {
        unit: process.env.BEDEL_JOB,
        reportDigest: digest(report),
        censusDigest: digest(this.census),
      });
    }
  }
}
export const strykerPlugins = [
  declareClassPlugin(PluginKind.Reporter, "bedel-checkpoint", DurableReporter),
];
