// Rasterises assets/brand/*.svg into the app icon (.ico), web favicons and PWA icons.
// Usage: node scripts/build-brand.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import pngToIco from "png-to-ico";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const brand = path.join(root, "assets/brand");
const desktopRes = path.join(root, "apps/desktop/resources");
const clientPublic = path.join(root, "packages/client/public");
fs.mkdirSync(desktopRes, { recursive: true });
fs.mkdirSync(clientPublic, { recursive: true });

const full = fs.readFileSync(path.join(brand, "logo.svg"), "utf8");
const small = fs.readFileSync(path.join(brand, "logo-16.svg"), "utf8");

const render = (svg, size) => new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng();

// .ico: the simplified mark below 32px so it stays legible
const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = sizes.map((s) => render(s < 32 ? small : full, s));
fs.writeFileSync(path.join(desktopRes, "icon.ico"), await pngToIco(pngs));
fs.writeFileSync(path.join(desktopRes, "icon.png"), render(full, 512));

fs.writeFileSync(path.join(clientPublic, "favicon.svg"), small);
fs.writeFileSync(path.join(clientPublic, "icon-192.png"), render(full, 192));
fs.writeFileSync(path.join(clientPublic, "icon-512.png"), render(full, 512));
fs.writeFileSync(path.join(clientPublic, "logo.svg"), full);
fs.writeFileSync(path.join(root, "packages/client/src/assets/logo.svg"), full);

console.log("brand assets written:", sizes.join(","), "+ favicon, pwa icons");
