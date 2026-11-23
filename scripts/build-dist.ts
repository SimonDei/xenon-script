/**
 * Builds a portable XenonScript compiler directory:
 *
 *   dist/
 *     xenon.js
 *     runtime/stacktrace.ts
 *     lib.*.d.ts
 *
 * The Xenon prelude and standard library are embedded by Bun's preludeFiles build macro.
 */
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

const root = join(import.meta.dir, "..");
const out = join(root, "dist");

await rm(out, { recursive: true, force: true });
await mkdir(join(out, "runtime"), { recursive: true });

const compiler = await Bun.build({
  entrypoints: [join(root, "src", "cli.ts")],
  target: "bun",
  format: "esm",
  outdir: out,
  naming: "xenon.js",
});
if (!compiler.success) throw new AggregateError(compiler.logs, "bundling the XenonScript compiler failed");

const runtime = await Bun.build({
  entrypoints: [join(root, "src", "runtime", "stacktrace.ts")],
  target: "bun",
  format: "esm",
  outdir: join(out, "runtime"),
  naming: "stacktrace.ts",
});
if (!runtime.success) throw new AggregateError(runtime.logs, "bundling the stacktrace preload failed");

const typescriptLib = dirname(Bun.resolveSync("typescript", root));
for (const file of await readdir(typescriptLib)) {
  if (/^lib\..*\.d\.ts$/.test(file)) {
    await cp(join(typescriptLib, file), join(out, file));
  }
}

console.log(`built portable compiler at ${out}`);
