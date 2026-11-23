// One-file server bundle for Render.com (ADR 0003) and the desktop voice self-test:
//   node build.mjs  ->  dist/server.mjs   (run: node dist/server.mjs, settings from env, see src/dev.ts)
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

await build({
  absWorkingDir: fileURLToPath(new URL(".", import.meta.url)),
  entryPoints: ["src/dev.ts"],
  outfile: "dist/server.mjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  legalComments: "external",
  logLevel: "warning",
  // CommonJS dependencies (fastify, ws) call require() for Node built-ins.
  banner: { js: 'import { createRequire as __nxRequire } from "node:module"; const require = __nxRequire(import.meta.url);' },
});
console.log("server bundle built: dist/server.mjs");
