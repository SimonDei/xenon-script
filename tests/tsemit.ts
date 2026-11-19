/** Compiles an example to TypeScript in memory and type-checks the result with the TypeScript API. */
import ts from "typescript";
import { join } from "node:path";
import { readSources } from "../src/build.ts";
import { compileProject } from "../src/compiler.ts";
import type { OutputFile } from "../src/codegen.ts";

/** Compiler options of the virtual TypeScript project (Xenon references may be `null`, so no strict null checks). */
export const TS_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ["lib.esnext.d.ts"],
  types: ["bun"],
  strict: false,
  noEmit: true,
  skipLibCheck: true,
  esModuleInterop: true,
};

export async function compileExampleToTs(dir: string): Promise<OutputFile[]> {
  const result = compileProject(await readSources(join(dir, "src")), { main: "Main", target: "ts" });
  const errors = result.diagnostics.items.filter((d) => d.severity === "error");
  if (errors.length > 0) throw new Error(`${dir}: ${errors.map((d) => d.message).join("; ")}`);
  return result.outputs;
}

/** Library declarations (`lib.esnext.d.ts`, Bun's and Node's types), parsed once for all programs. */
const libCache = new Map<string, ts.SourceFile | undefined>();

/** Type-checks the outputs (placed below `root`) with TypeScript. */
export function tsDiagnostics(outputs: OutputFile[], root: string): readonly ts.Diagnostic[] {
  const files = new Map(outputs.map((o) => [join(root, o.path), o.text]));
  const host = ts.createCompilerHost(TS_OPTIONS);
  const { fileExists, readFile, getSourceFile, directoryExists } = host;
  host.fileExists = (f) => files.has(f) || fileExists.call(host, f);
  host.directoryExists = (d) => [...files.keys()].some((f) => f.startsWith(d + "/")) || !!directoryExists?.call(host, d);
  host.readFile = (f) => files.get(f) ?? readFile.call(host, f);
  host.getSourceFile = (f, lang, ...rest) => {
    const text = files.get(f);
    if (text !== undefined) return ts.createSourceFile(f, text, lang);
    if (!libCache.has(f)) libCache.set(f, getSourceFile.call(host, f, lang, ...rest));
    return libCache.get(f);
  };
  return ts.getPreEmitDiagnostics(ts.createProgram([...files.keys()], TS_OPTIONS, host));
}

/** TypeScript's diagnostics for the outputs, as `path:line:col: message` lines. */
export function typeCheck(outputs: OutputFile[], root: string): string[] {
  return tsDiagnostics(outputs, root).map((d) => {
    const message = ts.flattenDiagnosticMessageText(d.messageText, "\n");
    if (!d.file || d.start === undefined) return message;
    const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
    const text = d.file.text.split("\n")[line]?.trim();
    return `${d.file.fileName.slice(root.length + 1)}:${line + 1}:${character + 1}: TS${d.code} ${message}\n    ${text}`;
  });
}

if (import.meta.main) {
  const examples = join(import.meta.dir, "..", "examples");
  const names = process.argv.slice(2);
  for (const name of names.length ? names : (await Array.fromAsync(new Bun.Glob("*").scan({ cwd: examples, onlyFiles: false }))).sort()) {
    const outputs = await compileExampleToTs(join(examples, name));
    const diags = typeCheck(outputs, join(examples, name, "out-ts"));
    console.log(`== ${name}: ${diags.length} error(s)`);
    for (const d of diags) console.log(d);
  }
}
