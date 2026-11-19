/** JavaScript imports typed from their `.d.ts` files (src/dts.ts). */
import { expect, test } from "bun:test";
import { join } from "node:path";
import { compileProject } from "../src/compiler.ts";

/** Resolved from inside the repository, so `node_modules/@types/node` and Bun's types are found. */
const typeRoot = join(import.meta.dir, ".dts-project", "src");

function compile(text: string, typed = true) {
  const result = compileProject([{ path: "Main.xn", text }], { main: "Main", ...(typed ? { typeRoot } : {}) });
  const diags = result.diagnostics.sorted().map((d) => {
    const l = d.labels.find((x) => x.primary)!;
    return `${d.code} ${l.span.file.position(l.span.start).line}:${l.span.file.position(l.span.start).col} ${d.message}`;
  });
  return { result, diags, errors: diags.filter((d) => !/^X08[5-7]/.test(d)) };
}

const main = (imports: string, body: string, extra = "") => `${imports}

public class Main {
  public function Main() {
${body}
  }
}
${extra}`;

test("misuse of a typed import is a compile error; results have their types", () => {
  const { errors, result } = compile(main(
    "import { readFileSync } from 'node:fs'\nimport * as path from 'node:path'",
    `    var n:int = readFileSync('x', 'utf8')
    var s:String = readFileSync('x', 'utf8')
    trace(n, s, path.join('a', 1), path.nope, path.sep.length)`,
  ));
  expect(errors).toEqual([
    "X0308 6:17 mismatched types",
    "X0308 8:32 mismatched types",
    "X0426 8:41 no static member `nope` on `path`",
  ]);
  // The argument's error points at the user's code only (not into the generated declaration).
  const join = result.diagnostics.items.find((d) => d.code === "X0308" && d.labels.some((l) => l.span.start > 100))!;
  expect(join.labels.every((l) => !l.span.file.generated)).toBe(true);
  expect(result.declarationErrors).toEqual([]);
});

test("without a type root, or without types for a package, imports stay `*`", () => {
  const code = main("import { readFileSync } from 'node:fs'\nimport _ from 'lodash'", "    var n:int = readFileSync('x', 'utf8')\n    trace(n, _.anything(1, 2))");
  expect(compile(code, false).errors).toEqual([]);
  // `lodash` has no `@types` here: `_` is untyped, `readFileSync` typed.
  expect(compile(code).errors).toEqual(["X0308 6:17 mismatched types"]);
});

test("typed classes: `new`, members, subclasses (no `override` needed against a `.d.ts`)", () => {
  const { errors } = compile(main(
    "import { EventEmitter } from 'node:events'\nimport { URL } from 'node:url'",
    `    var u:URL = new URL('https://x.dev/a')
    var host:String = u.hostname
    var bad:int = u.port
    var e:EventEmitter = new Bell()
    e.on('ring', (x:*):void => trace(x, host, bad))
    trace(e.nope)`,
    "class Bell extends EventEmitter {\n  public function emit(name:*, ...args:Array<*>):Boolean { return true }\n}\n",
  ));
  expect(errors).toEqual(["X0308 8:19 mismatched types", "X0426 11:13 no member `nope` on `EventEmitter`"]);
});

test("generated declarations are never emitted, and the program is unchanged", () => {
  const code = main("import * as path from 'node:path'", "    trace(path.join('a', 'b'))");
  const typed = compile(code).result.outputs;
  const plain = compile(code, false).result.outputs;
  expect(typed.map((o) => o.path)).toEqual(plain.map((o) => o.path));
  expect(typed.map((o) => o.text)).toEqual(plain.map((o) => o.text));
});

test("fix-its never name a type only the declarations know", () => {
  const { result } = compile(main("import { readFileSync } from 'node:fs'", "    var buf = readFileSync('x')\n    trace(buf)"));
  const untyped = result.diagnostics.items.find((d) => d.code === "X0850")!;
  // Only the generic suggestion (`:*`), not `:Buffer` (a name this file can't write).
  expect(untyped.help.flatMap((h) => h.edits?.map((e) => e.text) ?? [])).toEqual([":*"]);
});

test("the declarations of many modules compile cleanly", () => {
  const modules = ["node:fs", "node:fs/promises", "node:path", "node:os", "node:util", "node:crypto", "node:http", "node:https", "node:url",
    "node:child_process", "node:events", "node:stream", "node:zlib", "node:readline", "node:net", "node:assert", "node:buffer",
    "node:worker_threads", "node:timers/promises", "node:process", "bun:sqlite", "bun:test", "bun"];
  const imports = modules.map((m, i) => `import * as m${i} from '${m}'`).join("\n");
  const { result } = compile(main(imports, `    trace(${modules.map((_, i) => `m${i}`).join(", ")})`));
  expect(result.declarationErrors.map((d) => `${d.code} ${d.message}`)).toEqual([]);
  expect(result.diagnostics.items.filter((d) => d.severity === "error")).toEqual([]);
}, 30_000);

/** A JavaScript library with its `.d.ts` in the source folder (like `xlsx.js` + `xlsx.d.ts`). */
const LIB_DTS = `export interface Book { names: string[] }
export declare function book(): Book;
export declare class Cell { constructor(value: number); readonly value: number; }
`;

test("relative imports are typed from the importing file's folder; namespaces' types are `Ns.Type`", async () => {
  const { mkdir, rm } = await import("node:fs/promises");
  const src = join(import.meta.dir, ".dts-local", "src");
  await rm(join(src, ".."), { recursive: true, force: true });
  await mkdir(join(src, "lib"), { recursive: true });
  await Bun.write(join(src, "lib", "sheet.d.ts"), LIB_DTS);
  await Bun.write(join(src, "lib", "sheet.js"), "export const book = () => ({ names: [] }); export class Cell { constructor(v) { this.value = v; } }\n");
  try {
    const sources = [
      { path: "Main.xn", text: main("import * as Sheet from './lib/sheet.js'\nimport app.Report", "    var b:Sheet.Book = Sheet.book()\n    var c:Sheet.Cell = new Sheet.Cell(1)\n    var n:String = c.value\n    trace(b.names.length, n, Report.count(), Sheet.nope)") },
      { path: "app/Report.xn", text: "package app {\n  import { book } from '../lib/sheet.js'\n  public class Report {\n    public static function count():String { return book().names.length }\n  }\n}\n" },
    ];
    const result = compileProject(sources, { main: "Main", typeRoot: src, assets: [{ path: "lib/sheet.js", text: "// js" }] });
    const errors = result.diagnostics.sorted().filter((d) => d.severity === "error").map((d) => `${d.code} ${d.labels[0]!.span.file.path}:${d.labels[0]!.span.file.position(d.labels[0]!.span.start).line}`);
    // `c.value` is a Float; `Sheet.nope` doesn't exist; in app/Report.xn `'../lib/sheet.js'` is typed too.
    expect(errors).toEqual(["X0308 Main.xn:8", "X0426 Main.xn:9", "X0308 app/Report.xn:4"]);
    expect(result.declarationErrors).toEqual([]);
  } finally {
    await rm(join(src, ".."), { recursive: true, force: true });
  }
});

test("a misspelled namespace type suggests the export and still counts as using the import", async () => {
  const { mkdir, rm } = await import("node:fs/promises");
  const src = join(import.meta.dir, ".dts-typo", "src");
  await rm(join(src, ".."), { recursive: true, force: true });
  await mkdir(join(src, "lib"), { recursive: true });
  await Bun.write(join(src, "lib", "sheet.d.ts"), LIB_DTS);
  await Bun.write(join(src, "lib", "sheet.js"), "export const book = () => ({ names: [] });\n");
  try {
    const text = "import * as Sheet from './lib/sheet.js'\n\npublic class Main {\n  public function Main() {\n    var b:Sheet.book = null\n    trace(b)\n  }\n}\n";
    const result = compileProject([{ path: "Main.xn", text }], { main: "Main", typeRoot: src, assets: [{ path: "lib/sheet.js", text: "// js" }] });
    const shown = result.diagnostics.sorted().filter((d) => !["X0861", "X0862"].includes(d.code ?? ""));
    expect(shown.map((d) => [d.code, d.message, d.help.map((h) => h.message)])).toEqual([
      ["X0420", "cannot find type `Sheet.book`", ["a type with a similar name exists: `Sheet.Book`"]],
    ]);
  } finally {
    await rm(join(src, ".."), { recursive: true, force: true });
  }
});

test("a package installed while the language server runs is typed on the next compile", async () => {
  const { mkdir, rm } = await import("node:fs/promises");
  const project = join(import.meta.dir, ".dts-install");
  await rm(project, { recursive: true, force: true });
  await mkdir(join(project, "src"), { recursive: true });
  const text = "import * as sheets from 'sheets'\n\npublic class Main {\n  public function Main() {\n    var b:sheets.Book = sheets.open()\n    trace(b)\n  }\n}\n";
  const errors = () => compileProject([{ path: "Main.xn", text }], { main: "Main", typeRoot: join(project, "src") })
    .diagnostics.sorted().filter((d) => d.severity === "error").map((d) => d.message);
  try {
    // Not installed yet: `sheets` is `*`, which has no types to name.
    expect(errors()).toEqual(["cannot find type `sheets.Book`"]);
    const pkg = join(project, "node_modules", "sheets");
    await mkdir(pkg, { recursive: true });
    await Bun.write(join(pkg, "package.json"), JSON.stringify({ name: "sheets", types: "index.d.ts" }));
    await Bun.write(join(pkg, "index.d.ts"), "export interface Book { names: string[] }\nexport declare function open(): Book;\n");
    expect(errors()).toEqual([]);
    // The declarations change: the next compile sees that too.
    await Bun.sleep(5);
    await Bun.write(join(pkg, "index.d.ts"), "export interface Book { names: string[] }\nexport declare function open(): number;\n");
    expect(errors()).toEqual(["mismatched types"]);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("JavaScript files of the source folder are copied, unless a module has their path (X0030)", () => {
  const code = main("import { book } from './lib/sheet.js'", "    trace(book())");
  const copied = compileProject([{ path: "Main.xn", text: code }], { main: "Main", assets: [{ path: "lib/sheet.js", text: "export const book = () => 1;\n" }] });
  expect(copied.outputs.find((o) => o.path === "lib/sheet.js")?.text).toBe("export const book = () => 1;\n");
  const clash = compileProject([{ path: "Main.xn", text: code }], { main: "Main", assets: [{ path: "Main.js", text: "// old build output?\n" }] });
  expect(clash.diagnostics.items.map((d) => [d.code, d.message])).toEqual([["X0030", "`Main.js` in the source folder has the path of this file's output"]]);
  expect(clash.outputs).toEqual([]);
});
