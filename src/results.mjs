import { digest, canonical } from "./store.mjs";
export const terminal = new Set([
  "Killed",
  "Survived",
  "NoCoverage",
  "Timeout",
  "CompileError",
  "Ignored",
]);
export const identity = (file, m) =>
  digest({
    file,
    location: m.location,
    mutatorName: m.mutatorName,
    replacement: m.replacement,
  });
export function scoped(report, unit) {
  if (report?.schemaVersion !== "1.0" || !report.files || !report.testFiles)
    throw Error("Malformed engine report");
  const files = {};
  for (const [file, value] of Object.entries(report.files)) {
    if (file !== unit.source)
      throw Error("Report source outside selected unit");
    files[file] = {
      ...value,
      mutants: value.mutants.filter(
        (m) =>
          m.location.start.line >= unit.start &&
          m.location.start.line <= unit.end,
      ),
    };
  }
  return {
    schemaVersion: report.schemaVersion,
    files,
    testFiles: report.testFiles,
  };
}
export function validateCompletion(unit, report, census, receipt) {
  const value = scoped(report, unit);
  const mutants = Object.entries(value.files).flatMap(([file, v]) =>
    v.mutants.map((m) => ({ file, m })),
  );
  if (mutants.some(({ m }) => !terminal.has(m.status)))
    throw Error("Nonterminal mutation result");
  const ids = mutants.map(({ file, m }) => identity(file, m)).sort();
  if (
    new Set(ids).size !== ids.length ||
    canonical(ids) !== canonical([...census.ids].sort())
  )
    throw Error("Incomplete or duplicate mutant population");
  if (
    census.unit !== unit.key ||
    receipt.unit !== unit.key ||
    receipt.code !== 0 ||
    receipt.reportDigest !== digest(report) ||
    receipt.censusDigest !== digest(census)
  )
    throw Error("Invalid execution completion receipt");
  return value;
}
export function resultSignature(object) {
  return digest(
    Object.entries(object.report.files)
      .flatMap(([file, v]) =>
        v.mutants.map((m) => ({
          identity: identity(file, m),
          status: m.status,
        })),
      )
      .sort((a, b) => a.identity.localeCompare(b.identity)),
  );
}
