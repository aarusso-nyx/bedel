// Ported from DEVAI tests/contract/mutation-workspace-aliases.test.ts at 18fc6cf0.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sandboxWorkspaceAliases } from "../src/workspace-aliases.mjs";
function fixture(t, exports) {
  const root = mkdtempSync(join(tmpdir(), "bedel-alias-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "packages/example");
  mkdirSync(join(directory, "src"), { recursive: true });
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ name: "@example/pkg", exports }),
  );
  for (const name of ["index", "registry"])
    writeFileSync(
      join(directory, "src", name + ".ts"),
      "export const value=1;",
    );
  return { root, directory };
}
test("exact workspace development root and subpath aliases", (t) => {
  const { root, directory } = fixture(t, {
    ".": { development: "./src/index.ts" },
    "./registry": { development: "./src/registry.ts" },
    "./installed": { import: "./dist/index.js" },
  });
  const aliases = sandboxWorkspaceAliases(root);
  for (const [name, file] of [
    ["@example/pkg", "index"],
    ["@example/pkg/registry", "registry"],
  ])
    assert.deepEqual(
      aliases.filter((a) => a.find.test(name)).map((a) => a.replacement),
      [join(directory, "src", file + ".ts")],
    );
  for (const name of [
    "@example/pkg/registry/other",
    "@example/pkg/installed",
    "@example/pkg-extra",
  ])
    assert.equal(aliases.filter((a) => a.find.test(name)).length, 0);
});
for (const target of ["../outside.ts", "./src/missing.ts"])
  test("reject unavailable/escaped " + target, (t) => {
    const { root } = fixture(t, { ".": { development: target } });
    assert.throws(() => sandboxWorkspaceAliases(root), /entry-invalid/);
  });
test("reject entrypoint symlink escaping instrumented package", (t) => {
  const { root, directory } = fixture(t, {
    ".": { development: "./src/index.ts" },
  });
  writeFileSync(join(root, "original.ts"), "export const value=3;");
  rmSync(join(directory, "src/index.ts"));
  symlinkSync(join(root, "original.ts"), join(directory, "src/index.ts"));
  assert.throws(() => sandboxWorkspaceAliases(root), /entry-invalid/);
});
