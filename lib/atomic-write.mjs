import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function writeFileAtomic(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, contents, "utf8");
  renameSync(tmp, path);
}
