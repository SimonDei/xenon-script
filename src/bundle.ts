/**
 * `--bundle`: the compiled modules (the program's `.xn` files and the prelude classes it uses) as
 * one file, `xenon-main.js`, built with Bun's bundler from memory. Vendor code stays outside: npm
 * packages and `node:`/`bun:` modules remain imports, and JavaScript files of the source folder
 * (copied to the output as usual) are imported from the bundle by their path in the output folder.
 * With source maps, the bundle's map is composed with the per-module maps, so it points at the
 * `.xn` files.
 */
import { dirname, join, relative, resolve, sep } from "node:path";
import { ENTRY_FILE, type OutputFile } from "./codegen.ts";
import { decodeMappings, encodeMappings, type SourceMap } from "./sourcemap.ts";

const posix = (p: string) => p.split(sep).join("/");

/** Replaces the compiled modules in `outputs` by one bundle (copied JavaScript files are kept). `outDir` must exist. */
export async function bundleOutputs(outputs: OutputFile[], outDir: string, sourceMaps: boolean): Promise<OutputFile[]> {
  const isModule = (o: OutputFile) => !o.asset && !o.path.endsWith(".map");
  const modules = new Map(outputs.filter(isModule).map((o) => [join(outDir, o.path), o.text]));
  const maps = new Map(outputs.filter((o) => !o.asset && o.path.endsWith(".map")).map((o) => [join(outDir, o.path.slice(0, -4)), JSON.parse(o.text) as SourceMap]));

  const result = await Bun.build({
    entrypoints: [join(outDir, ENTRY_FILE)],
    files: Object.fromEntries(modules),
    root: outDir,
    // Plain ESM (runs on Bun and Node); `"bun"` would add a `// @bun` header, with which Bun
    // no longer reports uncaught errors through our stack-trace mapping.
    target: "node",
    format: "esm",
    packages: "external", // npm packages (and `node:`/`bun:` modules) stay imports
    sourcemap: sourceMaps ? "external" : "none",
    plugins: [{
      name: "xenon-vendor-files",
      setup(build) {
        // A relative import that isn't a compiled module: a JavaScript file copied to the output.
        build.onResolve({ filter: /^\.\.?\// }, (args) => {
          const target = resolve(dirname(args.importer), args.path);
          if (modules.has(target)) return undefined;
          return { path: "./" + posix(relative(outDir, target)), external: true };
        });
      },
    }],
  });
  if (!result.success) throw new AggregateError(result.logs, "bundling failed");
  const entry = result.outputs.find((o) => o.kind === "entry-point")!;
  // Bun marks each module with a comment holding its absolute path: show it relative to the output.
  let text = (await entry.text()).replace(/^\/\/ (.+\.js)$/gm, (line, path: string) => {
    const abs = resolve(process.cwd(), path);
    return modules.has(abs) ? `// ${posix(relative(outDir, abs))}` : line;
  });
  // No blank lines (Bun separates modules and statements with them); `kept` maps the remaining
  // lines to the bundle's original lines, for the source map.
  const kept = text.split("\n").flatMap((line, i) => (line.trim() === "" ? [] : [i]));
  const allLines = text.split("\n");
  text = kept.map((i) => allLines[i]).join("\n") + "\n";

  const out: OutputFile[] = outputs.filter((o) => o.asset);
  if (sourceMaps) {
    const map = result.outputs.find((o) => o.kind === "sourcemap");
    if (map) {
      out.push({ path: `${ENTRY_FILE}.map`, text: JSON.stringify(composeMap(JSON.parse(await map.text()) as SourceMap, maps, outDir, text, kept)) + "\n" });
      text = text.replace(/\n?$/, `\n//# sourceMappingURL=${ENTRY_FILE}.map\n`);
    }
  }
  out.unshift({ path: ENTRY_FILE, text });
  return out;
}

/**
 * The bundle's map points at the compiled modules; each module's map points at its `.xn` file.
 * Their composition points from the bundle straight at the `.xn` files (per segment: the module's
 * last segment at or before that column on that line). `kept` lists the bundle's lines left in
 * `code` (blank lines are removed), by their line in the bundle Bun wrote.
 */
function composeMap(bundle: SourceMap, moduleMaps: Map<string, SourceMap>, outDir: string, code: string, kept: number[]): SourceMap {
  const sources: string[] = [];
  const contents: (string | null)[] = [];
  const index = new Map<string, number>();
  const modules = bundle.sources.map((s) => {
    const path = resolve(process.cwd(), s);
    const map = moduleMaps.get(path);
    if (!map) return undefined;
    const xn = posix(relative(outDir, resolve(dirname(path), map.sources[0]!)));
    if (!index.has(xn)) {
      index.set(xn, sources.length);
      sources.push(xn);
      contents.push(map.sourcesContent[0] ?? null);
    }
    return { source: index.get(xn)!, lines: decodeMappings(map.mappings) };
  });
  const codeLines = code.split("\n");
  const bundleLines = decodeMappings(bundle.mappings);
  const lines = kept.map((k) => bundleLines[k] ?? []).map((segs, i) => segs.flatMap(([genCol, src, line, col]): [number, number, number, number][] => {
    // Bun maps a line's indentation to the end of the previous token (the line before): drop it,
    // so a line's first segment is its first token, as in the modules' maps.
    const text = codeLines[i] ?? "";
    if (genCol < text.length - text.trimStart().length) return [];
    const m = modules[src];
    const row = m?.lines[line];
    if (!m || !row?.length) return [];
    const at = row.findLast((s) => s[0] <= col) ?? row[0]!;
    return [[genCol, m.source, at[2], at[3]]];
  }));
  return { version: 3, file: ENTRY_FILE, sources, sourcesContent: contents, names: [], mappings: encodeMappings(lines) };
}
