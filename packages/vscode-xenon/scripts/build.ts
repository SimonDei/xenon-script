/**
 * Builds the extension into `dist/`: the client (`extension.js`, CommonJS for VS Code) and the
 * language server (`server.js`, for Bun, compiler and TypeScript included). TypeScript looks for
 * its library declarations (`lib.esnext.d.ts`, …) next to the running script, so they are copied
 * into `dist/` too.
 */
import { cp, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

const root = join(import.meta.dir, "..");

/** Bundles the language server into `dir/server.js`, with TypeScript's library declarations beside it. */
export async function buildServer(dir: string) {
  await bundle({ entrypoints: [join(root, "src", "server.ts")], target: "bun", format: "esm", external: [], outdir: dir, naming: "server.js" });
  const tsLib = dirname(Bun.resolveSync("typescript", join(root, "..", "..")));
  for (const f of await readdir(tsLib)) {
    if (/^lib\..*\.d\.ts$/.test(f)) await cp(join(tsLib, f), join(dir, f));
  }
}

/** Bundles the VS Code client into `dir/extension.js`. */
export async function buildClient(dir: string) {
  await bundle({ entrypoints: [join(root, "src", "extension.ts")], target: "node", format: "cjs", external: ["vscode"], outdir: dir, naming: "extension.js" });
}

async function bundle(config: Parameters<typeof Bun.build>[0]) {
  const result = await Bun.build(config);
  if (!result.success) throw new AggregateError(result.logs, `bundling ${config.entrypoints.join(", ")} failed`);
}

if (import.meta.main) {
  const dist = join(root, "dist");
  await rm(dist, { recursive: true, force: true });
  await buildClient(dist);
  await buildServer(dist);
  await cp(join(root, "..", "..", "LICENSE"), join(root, "LICENSE")); // packaged with the extension
  console.log(`built ${dist}`);
}
