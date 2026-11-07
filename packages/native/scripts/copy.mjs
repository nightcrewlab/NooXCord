// Copies the cargo cdylib to a loadable .node file next to index.js.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "target", "release", process.platform === "win32" ? "nooxcord_native.dll" : "libnooxcord_native.so");
const dest = path.join(root, `nooxcord-native.${process.platform}-${process.arch}.node`);
fs.copyFileSync(src, dest);
console.log("native ->", path.relative(process.cwd(), dest));
