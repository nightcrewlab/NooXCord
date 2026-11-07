// Writes packages/icons/svg/<name>.svg from the icon table and a contact sheet (sheet.svg).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "packages/icons/svg");
const tmp = path.join(root, "packages/icons/.icons.mjs");
await build({ entryPoints: [path.join(root, "packages/icons/src/icons.ts")], outfile: tmp, format: "esm", bundle: true, logLevel: "silent" });
const { icons } = await import(pathToFileURL(tmp).href);
fs.rmSync(tmp);
fs.mkdirSync(out, { recursive: true });
const wrap = (inner, extra = "") => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"${extra}>${inner}</svg>\n`;
const names = Object.keys(icons);
for (const n of names) fs.writeFileSync(path.join(out, `${n}.svg`), wrap(icons[n]));
const cols = 10, cell = 56;
const rows = Math.ceil(names.length / cols);
const cells = names.map((n, i) => `<g transform="translate(${(i % cols) * cell + 16} ${Math.floor(i / cols) * cell + 12})" stroke="#E8ECF2" fill="none" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" color="#E8ECF2">${icons[n]}</g><text x="${(i % cols) * cell + 28}" y="${Math.floor(i / cols) * cell + 50}" font-size="7" fill="#9AA3B2" text-anchor="middle" font-family="Segoe UI">${n}</text>`).join("");
fs.writeFileSync(path.join(root, "packages/icons/sheet.svg"), `<svg xmlns="http://www.w3.org/2000/svg" width="${cols * cell}" height="${rows * cell}"><rect width="100%" height="100%" fill="#11141A"/>${cells}</svg>\n`);
console.log(`exported ${names.length} icons`);
