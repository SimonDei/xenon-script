/**
 * Preloaded by `xenon run` and `xenon watch --run` (`bun --preload`): Bun ignores the source maps of
 * plain `.js` files, so stack traces are mapped back to the Xenon sources here. `err.stack` goes
 * through `Error.prepareStackTrace`; uncaught errors are reported with a code frame from the `.xn`
 * file. Frames without a map (JavaScript libraries, Bun itself) are left as they are.
 * The compiled program itself never depends on this: under Node, `--enable-source-maps` does the same.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeMappings, type SourceMap } from "../sourcemap.ts";

interface Loaded {
  source: string;
  text: string | null;
  lines: [number, number, number, number][][];
}

interface CallSite {
  getFileName(): string | null | undefined;
  getLineNumber(): number | null;
  getColumnNumber(): number | null;
  getFunctionName(): string | null;
  isConstructor?(): boolean;
}

interface Location {
  file: string;
  line: number;
  col: number;
  text: string | null;
}

const maps = new Map<string, Loaded | null>();

function load(file: string): Loaded | null {
  let loaded = maps.get(file);
  if (loaded !== undefined) return loaded;
  loaded = null;
  try {
    const path = file.startsWith("file:") ? fileURLToPath(file) : file;
    if (existsSync(path + ".map")) {
      const map = JSON.parse(readFileSync(path + ".map", "utf8")) as SourceMap;
      loaded = { source: resolve(dirname(path), map.sources[0]!), text: map.sourcesContent[0] ?? null, lines: decodeMappings(map.mappings) };
    }
  } catch {
    loaded = null; // a broken map: show the JavaScript position
  }
  maps.set(file, loaded);
  return loaded;
}

/** The Xenon position of a generated line (1-based in and out). */
function locate(file: string | null | undefined, line: number | null): Location | undefined {
  if (!file || !line) return undefined;
  const map = load(file);
  const seg = map?.lines[line - 1]?.[0];
  if (!map || !seg) return undefined;
  return { file: map.source, line: seg[2] + 1, col: seg[3] + 1, text: map.text };
}

function display(path: string): string {
  const rel = relative(process.cwd(), path);
  return rel.startsWith("..") ? path : rel;
}

function frame(site: CallSite): string {
  const name = site.getFunctionName();
  const fn = `${site.isConstructor?.() ? "new " : ""}${name || "<anonymous>"}`;
  const at = locate(site.getFileName(), site.getLineNumber());
  if (at) return `    at ${fn} (${display(at.file)}:${at.line}:${at.col})`;
  const file = site.getFileName();
  if (!file || file === "[unknown]" || file === "[native code]") return `    at ${fn} (native)`;
  // JavaScript without a map: Bun counts these columns from 0.
  const path = file.startsWith("file:") ? fileURLToPath(file) : file;
  return `    at ${fn} (${display(path)}:${site.getLineNumber()}:${(site.getColumnNumber() ?? 0) + 1})`;
}

/** Where each error was thrown in the Xenon source (for the code frame of an uncaught error). */
const firstLocation = new WeakMap<object, Location>();

Error.prepareStackTrace = (error: Error, sites: CallSite[]) => {
  const first = sites.map((s) => locate(s.getFileName(), s.getLineNumber())).find((l) => l);
  if (first && typeof error === "object") firstLocation.set(error, first);
  return `${error}\n${sites.map(frame).join("\n")}`;
};

function codeFrame(at: Location): string {
  const source = at.text?.split(/\r?\n/)[at.line - 1];
  if (source === undefined) return "";
  const gutter = String(at.line);
  return `${gutter} | ${source}\n${" ".repeat(gutter.length)} | ${" ".repeat(at.col - 1)}^\n`;
}

function report(value: unknown, kind: string) {
  if (value instanceof Error) {
    const stack = value.stack ?? String(value); // runs prepareStackTrace
    const at = firstLocation.get(value);
    process.stderr.write(`${at ? codeFrame(at) : ""}${stack}\n`);
  } else {
    process.stderr.write(`${kind}: ${String(value)}\n`);
  }
  process.exit(1);
}

process.on("uncaughtException", (e) => report(e, "uncaught"));
process.on("unhandledRejection", (e) => report(e, "unhandled rejection"));
