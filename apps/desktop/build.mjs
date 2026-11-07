import { build } from "esbuild";

// mediasoup (worker binary) and the native module are loaded from node_modules at runtime.
const common = { bundle: true, platform: "node", target: "node22", format: "cjs", external: ["electron", "mediasoup", "@nooxcord/native"], sourcemap: true, logLevel: "warning" };
await Promise.all([
  build({ ...common, entryPoints: ["src/main/main.ts"], outfile: "out/main.cjs" }),
  build({ ...common, entryPoints: ["src/preload/preload.ts"], outfile: "out/preload.cjs" }),
  build({ ...common, entryPoints: ["src/preload/overlay-preload.ts"], outfile: "out/overlay-preload.cjs" }),
  // Host server (fastify, ws, node:sqlite) bundled for the utility process.
  build({ ...common, entryPoints: ["src/host/host.ts"], outfile: "out/host.cjs" }),
]);
console.log("desktop bundles built");
