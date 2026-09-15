import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  renameSync,
  existsSync,
  openSync,
  fsyncSync,
  closeSync,
  readdirSync,
} from "node:fs";
import { resultSignature } from "./results.mjs";
import { join } from "node:path";
export const canonical = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
export const digest = (value) =>
  createHash("sha256")
    .update(
      typeof value === "string" || Buffer.isBuffer(value)
        ? value
        : canonical(value),
    )
    .digest("hex");
export function atomic(path, value) {
  mkdirSync(join(path, ".."), { recursive: true });
  const temp = path + "." + randomUUID();
  writeFileSync(temp, canonical(value));
  const fd = openSync(temp, "r");
  fsyncSync(fd);
  closeSync(fd);
  renameSync(temp, path);
}
export function put(root, value) {
  const hash = digest(value),
    path = join(root, "objects", hash + ".json");
  if (!existsSync(path)) atomic(path, value);
  return hash;
}
export function get(root, hash) {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw Error("Invalid object identity");
  const value = JSON.parse(
    readFileSync(join(root, "objects", hash + ".json"), "utf8"),
  );
  if (digest(value) !== hash) throw Error("Corrupt object");
  return value;
}

export function rebuild(root) {
  const index = {};
  if (!existsSync(join(root, "objects"))) return index;
  for (const file of readdirSync(join(root, "objects"))) {
    if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
    const hash = file.slice(0, -5),
      object = get(root, hash);
    if (object.kind === "unit" && object.unit && object.report) {
      if (index[object.unit]) {
        const previous = get(root, index[object.unit]);
        if (resultSignature(previous) !== resultSignature(object))
          throw Error("Conflicting terminal results for unit " + object.unit);
        index[object.unit] = [hash, index[object.unit]].sort()[0];
      } else index[object.unit] = hash;
    }
  }
  return index;
}
