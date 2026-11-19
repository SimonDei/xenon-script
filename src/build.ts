import { mkdir, readdir, rm, rmdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { type CompileOptions, compileProject, type CompileResult, type SourceInput } from "./compiler.ts";
import { entryFile } from "./codegen.ts";
import { renderAll, renderSummary } from "./diagnostics.ts";
import type { Span } from "./source.ts";

export interface Config {
  src: string;
  out: string;
  main: string;
  color: boolean;
  format: "pretty" | "json";
  maxErrors: number;
  denyWarnings: boolean;
  quiet: boolean;
  /** Emit `.js.map` files next to the output (on unless `--no-source-maps` / `"sourceMaps": false`). */
  sourceMaps: boolean;
  /** `ts`: write typed TypeScript instead of JavaScript (`--target ts` / `"target": "ts"`); no source maps. */
  target: "js" | "ts";
}

/** The command that runs a built program: with source maps, stack traces are mapped back to the `.xn` files. */
export function runCommand(config: Config, outDir: string, args: string[]): string[] {
  const maps = config.sourceMaps && config.target === "js";
  const preload = maps ? ["--preload", join(import.meta.dir, "runtime", "stacktrace.ts")] : [];
  return ["bun", ...preload, join(outDir, entryFile(config.target)), ...args];
}

/** Compiler options for a project: maps point from the output directory back to the sources. */
export function compileOptions(config: Config, root: string): CompileOptions {
  const sourceRoot = relative(resolve(root, config.out), resolve(root, config.src)).split(sep).join("/");
  const sourceMaps = config.sourceMaps && config.target === "js" ? { sourceRoot } : undefined;
  return { main: config.main, maxErrors: config.maxErrors, sourceMaps, target: config.target };
}

/** Reads every `.xn` file below the source root (paths use `/`). */
export async function readSources(srcRoot: string): Promise<SourceInput[]> {
  const glob = new Bun.Glob("**/*.xn");
  const paths = (await Array.fromAsync(glob.scan({ cwd: srcRoot }))).sort();
  return Promise.all(
    paths.map(async (p) => ({ path: p.split("\\").join("/"), text: await Bun.file(join(srcRoot, p)).text() })),
  );
}

export function report(result: CompileResult, config: Config, srcRoot: string): boolean {
  const diags = result.diagnostics;
  if (config.denyWarnings) for (const d of diags.items) if (d.severity === "warning") d.severity = "error";
  if (config.format === "json") {
    const json = diags.sorted().map((d) => ({
      ...d,
      labels: d.labels.map((l) => ({ ...l, span: spanJson(l.span) })),
      help: d.help.map((h) => ({ ...h, edits: h.edits?.map((e) => ({ ...e, span: spanJson(e.span) })) })),
    }));
    console.log(JSON.stringify(json, null, 2));
  } else if (diags.items.length > 0) {
    const displayPath = (f: { path: string; prelude: boolean }) =>
      f.prelude ? `<xenon prelude>/${f.path}` : relative(process.cwd(), join(srcRoot, f.path)) || f.path;
    process.stderr.write(renderAll(diags.sorted(), { color: config.color, displayPath }) + "\n\n");
    const summary = renderSummary(diags, config.color);
    if (summary) process.stderr.write(summary + "\n");
    const codes = [...new Set(diags.sorted().filter((d) => d.severity === "error" && d.code).map((d) => d.code!))];
    if (codes.length > 0) {
      const which = codes.length === 1 ? `this error, try \`xenon explain ${codes[0]}\`` : `an error, try \`xenon explain ${codes[0]}\``;
      process.stderr.write(`For more information about ${which}.\n`);
    }
  }
  return !diags.hasErrors;
}

function spanJson(s: Span) {
  return { file: s.file.path, start: s.start, end: s.end, ...s.file.position(s.start) };
}

export async function build(config: Config, root: string, emit: boolean): Promise<boolean> {
  const srcRoot = resolve(root, config.src);
  const started = performance.now();
  const sources = await readSources(srcRoot);
  const result = compileProject(sources, compileOptions(config, root));
  const ok = report(result, config, srcRoot);
  if (!ok) return false;
  if (emit) await syncOutputs(result, resolve(root, config.out));
  if (!config.quiet && config.format === "pretty") {
    const ms = Math.round(performance.now() - started);
    const what = emit ? `built ${sources.length} file${sources.length === 1 ? "" : "s"}` : `checked ${sources.length} file${sources.length === 1 ? "" : "s"}`;
    process.stderr.write(`${config.color ? "\x1b[32m✓\x1b[0m" : "✓"} ${what} in ${ms} ms\n`);
  }
  return true;
}


/** Source maps ride along with their module: they aren't counted as outputs of their own. */
export const isMap = (path: string) => path.endsWith(".map");

/** Writes outputs whose content changed; returns how many modules were written (maps not counted). */
export async function writeOutputs(result: CompileResult, outDir: string): Promise<number> {
  let written = 0;
  for (const o of result.outputs) {
    const target = join(outDir, o.path);
    await mkdir(resolve(target, ".."), { recursive: true });
    const existing = Bun.file(target);
    if (!(await existing.exists()) || (await existing.text()) !== o.text) {
      await Bun.write(target, o.text);
      if (!isMap(o.path)) written++;
    }
  }
  return written;
}

/** Name of the file in the output directory listing what the last build wrote. */
export const MANIFEST = ".xenon-outputs";

/**
 * Writes the outputs and removes files the previous build produced but this one doesn't (outputs of
 * deleted/renamed sources, or files the compiler no longer emits). Only files listed in the manifest
 * are ever deleted, so hand-written files in the output directory are left alone.
 */
export async function syncOutputs(result: CompileResult, outDir: string): Promise<{ written: number; removed: number }> {
  const written = await writeOutputs(result, outDir);
  const now = new Set(result.outputs.map((o) => o.path));
  const removed = await removeStale(outDir, await readManifest(outDir), now);
  await Bun.write(join(outDir, MANIFEST), [...now].sort().join("\n") + "\n");
  return { written, removed };
}

async function readManifest(outDir: string): Promise<Set<string>> {
  const file = Bun.file(join(outDir, MANIFEST));
  if (!(await file.exists())) return new Set();
  return new Set((await file.text()).split("\n").filter((l) => l && !l.includes("..")));
}

/** Removes output files that are no longer produced, and directories left empty by that. */
export async function removeStale(outDir: string, before: Set<string>, now: Set<string>): Promise<number> {
  let removed = 0;
  for (const path of before) {
    if (now.has(path)) continue;
    const target = join(outDir, path);
    await rm(target, { force: true });
    if (!isMap(path)) removed++;
    for (let dir = dirname(target); dir.startsWith(outDir + sep); dir = dirname(dir)) {
      if ((await readdir(dir).catch(() => ["?"])).length > 0) break;
      await rmdir(dir).catch(() => {});
    }
  }
  return removed;
}
