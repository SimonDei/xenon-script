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
  const code = main("import { readFileSync } from 'node:fs'\nimport _ from 'lodash'", "    var n:Int = readFileSync('x', 'utf8')\n    trace(n, _.anything(1, 2))");
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
    "class Bell extends EventEmitter {\n  public function emit(name:*, ...args:Array<*>):Bool { return true }\n}\n",
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

test("a local without a type takes a type only the declarations know (no annotation needed)", () => {
  const { result, errors } = compile(main("import { readFileSync } from 'node:fs'", "    var buf = readFileSync('x')\n    var n:Int = buf\n    trace(buf.length, n)"));
  expect(result.diagnostics.items.some((d) => d.code === "X0850")).toBe(false);
  // Typed from the declarations: assigning it to an `Int` is a mismatch, `buf.length` is fine.
  expect(errors).toEqual(["X0308 6:17 mismatched types"]);
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

test("a shape's index signature and keys that aren't identifiers are explained in its doc comment", async () => {
  const { mkdir, rm } = await import("node:fs/promises");
  const project = join(import.meta.dir, ".dts-index");
  const pkg = join(project, "node_modules", "sheets");
  await rm(project, { recursive: true, force: true });
  await mkdir(pkg, { recursive: true });
  await Bun.write(join(pkg, "package.json"), JSON.stringify({ name: "sheets", types: "index.d.ts" }));
  await Bun.write(join(pkg, "index.d.ts"), "/** One sheet */\nexport interface Sheet { [cell: string]: any; '!ref'?: string; name: string }\nexport declare function open(): Sheet;\n");
  try {
    const text = "import * as sheets from 'sheets'\n\npublic class Main {\n  public function Main() {\n    var s:sheets.Sheet = sheets.open()\n    trace(s.name, s['A1'], s['!ref'])\n  }\n}\n";
    const result = compileProject([{ path: "Main.xn", text }], { main: "Main", typeRoot: join(project, "src") });
    expect(result.diagnostics.sorted().filter((d) => d.severity === "error")).toEqual([]);
    const decls = result.asts.filter((f) => f.file.generated).map((f) => f.file.text).join("\n");
    expect(decls).toContain([
      "/** One sheet",
      " * ",
      " * Indexed by any `String` key (`value[key]`, untyped `*`); in TypeScript `any`.",
      " * Also has `'!ref'`, read by index: `value['!ref']` (untyped `*`). */",
      "typedef Sheet = { name:String }",
    ].join("\n"));
  } finally {
    await rm(project, { recursive: true, force: true });
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

test("TypeScript tuples are Tuple<…> (fixed length) or Array<*> (optional or rest elements)", async () => {
  const { mkdir, rm } = await import("node:fs/promises");
  const project = join(import.meta.dir, ".dts-tuples");
  const pkg = join(project, "node_modules", "pairs");
  await rm(project, { recursive: true, force: true });
  await mkdir(pkg, { recursive: true });
  await Bun.write(join(pkg, "package.json"), JSON.stringify({ name: "pairs", types: "index.d.ts" }));
  await Bun.write(join(pkg, "index.d.ts"), "export declare function pair(): [string, number];\nexport declare function loose(): [string, number?];\n");
  try {
    const text = "import * as pairs from 'pairs'\n\npublic class Main {\n  public function Main() {\n    var p:Tuple<String, Float> = pairs.pair()\n    var [name, n] = pairs.pair()\n    var l:Array<*> = pairs.loose()\n    trace(p, name.length, n * 2, l, pairs.pair()[2])\n  }\n}\n";
    const result = compileProject([{ path: "Main.xn", text }], { main: "Main", typeRoot: join(project, "src") });
    expect(result.diagnostics.sorted().filter((d) => d.severity === "error").map((d) => d.code)).toEqual(["X0324"]);
    expect(result.declarationErrors).toEqual([]);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("interfaces are shapes (object literals fit them, callbacks included) unless a method is overloaded or generic", async () => {
  const { mkdir, rm } = await import("node:fs/promises");
  const project = join(import.meta.dir, ".dts-shapes");
  const pkg = join(project, "node_modules", "templ");
  await rm(project, { recursive: true, force: true });
  await mkdir(pkg, { recursive: true });
  await Bun.write(join(pkg, "package.json"), JSON.stringify({ name: "templ", types: "index.d.ts" }));
  await Bun.write(join(pkg, "index.d.ts"), `export interface Parser { get(scope: any): any; }
export interface Options { linebreaks?: boolean; parser?(tag: string): Parser; nullGetter?(part: { module: string }): any; }
export interface Buf { write(s: string): void; write(n: number): void; }
export declare class Doc { constructor(zip: any, options?: Options); render(): string; }
export declare function makeBuf(): Buf;
`);
  try {
    const text = `import { Doc, makeBuf } from 'templ'

public class Main {
  public function Main() {
    var doc:Doc = new Doc(null, {
      linebreaks: true,
      nullGetter: part => part.module != '' ? '' : '-',
      parser: tag => ({ get: scope => tag == '.' ? scope : null })
    })
    var b = makeBuf()
    trace(doc.render(), b)
  }
}
`;
    const result = compileProject([{ path: "Main.xn", text }], { main: "Main", typeRoot: join(project, "src") });
    expect(result.diagnostics.sorted().filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
    const decls = result.asts.filter((f) => f.file.generated).map((f) => f.file.text).join("\n");
    expect(decls).toContain("typedef Parser = { get:(scope:*) -> * }");
    expect(decls).toMatch(/class Buf\b/); // overloaded `write`: a native class
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("global web types in a .d.ts (Node's Blob, the DOM's Element) are the standard library's classes, not copies", async () => {
  const { mkdir, rm } = await import("node:fs/promises");
  const project = join(import.meta.dir, ".dts-web");
  await rm(project, { recursive: true, force: true });
  const write = async (name: string, dts: string) => {
    const pkg = join(project, "node_modules", name);
    await mkdir(pkg, { recursive: true });
    await Bun.write(join(pkg, "package.json"), JSON.stringify({ name, types: "index.d.ts" }));
    await Bun.write(join(pkg, "index.d.ts"), dts);
  };
  // Node's global `Blob` (from @types/node, as pizzip's `generate(): Blob` sees it), and the DOM's types.
  await write("zipper", "export declare function generate(): Blob;\n");
  await write("domlib", `/// <reference lib="dom" />\nexport declare function first(root: Document): Element | null;\nexport declare function all(root: Element): NodeListOf<Element>;\n`);
  try {
    const text = `import { generate } from 'zipper'
import { first, all } from 'domlib'

public class Main {
  public function Main() {
    var b:Blob = generate()
    var wrong:String = generate()
    var e:Element? = first(new Document())
    var list:NodeList<Element> = all(new Document().createElement('x'))
    var notList:String = all(new Document().createElement('x'))
    trace(b.size, wrong, e, list.length, notList)
  }
}
`;
    const result = compileProject([{ path: "Main.xn", text }], { main: "Main", typeRoot: join(project, "src") });
    const errors = result.diagnostics.sorted().filter((d) => d.severity === "error").map((d) => d.labels.find((l) => l.primary)!.message);
    // Typed as the standard classes (not `*`, which fits anything, nor a generated `Blob2`).
    expect(errors).toEqual(["expected `String`, found `Blob`", "expected `String`, found `NodeList<Element>`"]);
    const decls = result.asts.filter((f) => f.file.generated).map((f) => f.file.text).join("\n");
    expect(decls).not.toMatch(/class (Blob|Element|NodeList)/);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("a constructor value of its own instance type (JSZip): instance members work through the class name too", async () => {
  const { mkdir, rm } = await import("node:fs/promises");
  const project = join(import.meta.dir, ".dts-selfinstance");
  const pkg = join(project, "node_modules", "zipish");
  await rm(project, { recursive: true, force: true });
  await mkdir(pkg, { recursive: true });
  await Bun.write(join(pkg, "package.json"), JSON.stringify({ name: "zipish", types: "index.d.ts" }));
  await Bun.write(join(pkg, "index.d.ts"), `interface Zipish {
  files: { [key: string]: unknown };
  file(path: string): string | null;
  loadAsync(data: ArrayBuffer): Promise<Zipish>;
  new(): this;
  version: string;
}
declare var Zipish: Zipish;
export = Zipish;
`);
  try {
    const text = "import Zipish from 'zipish'\n\npublic class Main {\n  public function Main() {}\n  public static async function open(data:ArrayBuffer):Promise<Zipish> {\n    var zip:Zipish = await Zipish.loadAsync(data)\n    var fresh:Zipish = new Zipish()\n    trace(zip.file('a'), Zipish.version, fresh.version)\n    return zip\n  }\n}\n";
    const result = compileProject([{ path: "Main.xn", text }], { main: "Main", typeRoot: join(project, "src") });
    expect(result.diagnostics.sorted().filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("a namespace merged with a class import (JSZip.JSZipObject): its types are Ns.Type, also in messages", async () => {
  const { mkdir, rm } = await import("node:fs/promises");
  const project = join(import.meta.dir, ".dts-merged");
  const pkg = join(project, "node_modules", "zipish");
  await rm(project, { recursive: true, force: true });
  await mkdir(pkg, { recursive: true });
  await Bun.write(join(pkg, "package.json"), JSON.stringify({ name: "zipish", types: "index.d.ts" }));
  await Bun.write(join(pkg, "index.d.ts"), `declare namespace Zipish {
  interface Entry { name: string; async(type: "string"): Promise<string>; }
}
interface Zipish {
  file(path: string): Zipish.Entry | null;
  new(): this;
}
declare var Zipish: Zipish;
export = Zipish;
`);
  try {
    const text = "import Zipish from 'zipish'\n\npublic class Main {\n  public function Main() {\n    var zip:Zipish = new Zipish()\n    var ok:Zipish.Entry = zip.file('a')\n    var plain:Entry = zip.file('a')\n    var wrong:Int = zip.file('a')\n    trace(ok.name, plain, wrong)\n  }\n}\n";
    const result = compileProject([{ path: "Main.xn", text }], { main: "Main", typeRoot: join(project, "src") });
    const errors = result.diagnostics.sorted().filter((d) => d.severity === "error");
    expect(errors.map((d) => [d.code, d.labels.find((l) => l.primary)!.message, d.help.map((h) => h.message)])).toEqual([
      ["X0420", "not found", ["it belongs to the import `Zipish`: `Zipish.Entry`"]],
      ["X0308", "expected `Int`, found `Zipish.Entry`", []],
    ]);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("members named like keywords are declared (entry.async(…)); a constrained type parameter is its constraint", async () => {
  const { mkdir, rm } = await import("node:fs/promises");
  const project = join(import.meta.dir, ".dts-keywords");
  const pkg = join(project, "node_modules", "entries");
  await rm(project, { recursive: true, force: true });
  await mkdir(pkg, { recursive: true });
  await Bun.write(join(pkg, "package.json"), JSON.stringify({ name: "entries", types: "index.d.ts" }));
  await Bun.write(join(pkg, "index.d.ts"), `type OutputType = "string" | "blob";
export interface Entry {
  async<T extends OutputType>(type: T): Promise<unknown>;
  default: string;
  readonly delete: boolean;
}
export declare function entry(): Entry;
`);
  try {
    const text = "import { entry } from 'entries'\n\npublic class Main {\n  public function Main() {}\n  public static async function read():Promise<String> {\n    entry().default = 'x'\n    trace(entry().delete, await entry().async('blob'))\n    var bad:* = await entry().async('json')\n    return await entry().async('string')\n  }\n}\n";
    const result = compileProject([{ path: "Main.xn", text }], { main: "Main", typeRoot: join(project, "src") });
    const errors = result.diagnostics.sorted().filter((d) => d.severity === "error");
    // Only the wrong output type: the members exist, and `type` takes the constraint's values.
    expect(errors.map((d) => d.labels.find((l) => l.primary)!.message)).toEqual(["expected `OutputType`, found `'json'`"]);
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

test("an imported interface or type alias names its type (`import { ChildProcessWithoutNullStreams }`)", () => {
  const { errors, result } = compile(main(
    "import { spawn, ChildProcessWithoutNullStreams, SpawnOptions } from 'node:child_process'",
    `    var p:ChildProcessWithoutNullStreams = spawn('ls', ['-l'])
    var o:SpawnOptions = { cwd: '/', detached: true }
    var n:int = p
    var m:int = o.detached
    trace(p.pid, p.nope, n, m)`,
  ));
  expect(errors).toEqual([
    "X0308 7:17 mismatched types",
    "X0308 8:17 mismatched types",
    "X0426 9:20 no member `nope` on `ChildProcessWithoutNullStreams`",
  ]);
  // Named as imported, not `ChildProcessWithoutNullStreams2` (which `spawn` would otherwise declare).
  const found = result.diagnostics.items.filter((d) => d.code === "X0308").map((d) => d.labels.find((l) => l.primary)!.message);
  expect(found).toEqual(["expected `Int`, found `ChildProcessWithoutNullStreams`", "expected `Int`, found `Bool?`"]);
});

test("imported interfaces and type aliases are erased from the JavaScript (they have no value at run time)", () => {
  const { errors, result } = compile(main(
    `import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process'
import { SpawnOptions } from 'node:child_process'`,
    `    var o:SpawnOptions = { cwd: '/' }
    var p:ChildProcessWithoutNullStreams = spawn('ls', ['-l'])
    trace(p.pid, o.cwd)`,
  ));
  expect(errors).toEqual([]);
  const js = result.outputs.find((o) => o.path === "Main.js")!.text;
  expect(js).toContain("import { spawn } from 'node:child_process';");
  expect(js).not.toContain("ChildProcessWithoutNullStreams");
  expect(js).not.toContain("SpawnOptions");
});

test("a callback with parameters fits a rest-parameter function type (`stream.on('data', (chunk:String) => …)`)", () => {
  const { errors } = compile(main(
    "import { spawn } from 'node:child_process'",
    `    var out:String = ''
    spawn('ls').stdout.on('data', (chunk:String) => { out += chunk })
    var f:(...args:Array<int>) -> void = (a:int, b:int) => trace(a + b)
    var g:(...args:Array<int>) -> void = (s:String) => trace(s)
    var h:(...args:Array<int>) -> void = (...xs:Array<int>) => trace(xs)
    trace(out, f, g, h)`,
  ));
  expect(errors).toEqual(["X0308 8:42 mismatched types"]);
});

test("an imported class is the one other signatures return (`import { opendirSync, Dirent }`: one `Dirent`)", () => {
  const { errors, result } = compile(main(
    "import { opendirSync, Dirent } from 'node:fs'",
    `    var d:Dirent = opendirSync('.').readSync()
    var n:int = d
    trace(d.name, n)`,
  ));
  expect(errors).toEqual(["X0308 6:17 mismatched types"]);
  const found = result.diagnostics.items.find((d) => d.code === "X0308")!.labels.find((l) => l.primary)!.message;
  expect(found).toBe("expected `Int`, found `Dirent`");
});

test("overloads are chosen by literal types, as TypeScript chooses them (`readdir(dir, { withFileTypes: true })`)", () => {
  const { errors, result } = compile(main(
    "import fs from 'node:fs/promises'\nimport { Dirent } from 'node:fs'",
    `    fs.readdir('.', { withFileTypes: true }).then((entries:Array<Dirent>) => trace(entries[0].isFile()))
    fs.readdir('.').then((names:Array<String>) => trace(names))
    fs.readdir('.', { encoding: 'utf8' }).then((names:Array<String>) => trace(names))
    var n:int = fs.readdir('.', { withFileTypes: true })`,
  ));
  expect(errors).toEqual(["X0308 9:17 mismatched types"]);
  const found = result.diagnostics.items.find((d) => d.code === "X0308")!.labels.find((l) => l.primary)!.message;
  expect(found).toBe("expected `Int`, found `Promise<Array<Dirent>>`");
});

test("number literal types from a `.d.ts` choose overloads (`{ version: 2 }`); enums and unions of numbers stay `Float`", async () => {
  const { mkdir, rm } = await import("node:fs/promises");
  const src = join(import.meta.dir, ".dts-numbers", "src");
  await rm(join(src, ".."), { recursive: true, force: true });
  await mkdir(join(src, "lib"), { recursive: true });
  await Bun.write(join(src, "lib", "proto.d.ts"), `export declare enum Level { Low, High }
export declare function open(options: { version: 1 }): string;
export declare function open(options: { version: 2; level?: 0 | 1 | Level }): number;
export declare function scale(factor?: 0.5): number;
`);
  await Bun.write(join(src, "lib", "proto.js"), "export const open = (o) => o.version === 1 ? 'v1' : 2; export const scale = (f) => f;\n");
  try {
    const text = main("import { open, scale } from './lib/proto.js'", `    var a:String = open({ version: 1 })
    var b:Float = open({ version: 2, level: 7 })
    var c:String = open({ version: 2 })
    var d:Float = scale(0.5) + scale()
    trace(a, b, c, d, scale(2))`);
    const result = compileProject([{ path: "Main.xn", text }], { main: "Main", typeRoot: src, assets: [{ path: "lib/proto.js", text: "// js" }] });
    const errors = result.diagnostics.sorted().filter((d) => d.severity === "error").map((d) => `${d.code} ${d.labels.find((l) => l.primary)!.message}`);
    expect(errors).toEqual([
      "X0308 expected `String`, found `Float`",
      "X0308 expected `0.5`, found `2`",
    ]);
    expect(result.declarationErrors).toEqual([]);
  } finally {
    await rm(join(src, ".."), { recursive: true, force: true });
  }
});

test("TypeScript unions are Xenon unions: named ones are typedefs (`BufferEncoding`), literals choose overloads (`readdir(dir, 'buffer')`)", () => {
  const { result } = compile(main(
    "import fs from 'node:fs/promises'\nimport { readFileSync } from 'node:fs'",
    `    fs.readdir('.', 'buffer').then((raw:Array<String>) => trace(raw))
    fs.readdir('.', 'utf8').then((names:Array<String>) => trace(names))
    var text:String = readFileSync('x', 'latin1')
    var bad:String = readFileSync('x', 'latin2')
    var n:int = readFileSync(true)`,
  ));
  const errors = result.diagnostics.items.filter((d) => d.severity === "error");
  expect(errors.map((d) => `${d.code} ${d.message}`)).toEqual([
    "X0308 mismatched types",
    "X0604 no overload of `readFileSync` accepts (String, String)",
    "X0604 no overload of `readFileSync` accepts (Bool)",
  ]);
  // `'buffer'` chose the overload resolving to buffers (`'utf8'` the one with strings).
  expect(errors[0]!.labels.find((l) => l.primary)!.message).toContain("Buffer");
  const notes = errors[1]!.notes.join("\n");
  expect(notes).toContain("options:BufferEncoding | ReadFileSyncOptionsWithStringEncoding");
  expect(notes).toContain("path:Float | PathLike");
});

test("samePath: Windows paths match however TypeScript spells them", async () => {
  const { samePath } = await import("../src/dts.ts");
  // TypeScript reports `C:/proj/x.ts` where `path.join` gave `c:\proj\x.ts`.
  expect(samePath("C:/Users/me/proj/__xenon_imports__.ts", "c:\\Users\\me\\proj\\__xenon_imports__.ts", "win32")).toBe(true);
  expect(samePath("C:/a/x.ts", "C:/a/y.ts", "win32")).toBe(false);
  // Elsewhere paths are case-sensitive.
  expect(samePath("/home/me/proj/x.ts", "/home/me/proj/x.ts", "linux")).toBe(true);
  expect(samePath("/home/me/Proj/x.ts", "/home/me/proj/x.ts", "linux")).toBe(false);
});

test("an object type of only `[key: string]: T` (and `Record<string, T>`) is a `Record<String, T>`", async () => {
  const { mkdir, rm } = await import("node:fs/promises");
  const src = join(import.meta.dir, ".dts-record", "src");
  await rm(join(src, ".."), { recursive: true, force: true });
  await mkdir(join(src, "lib"), { recursive: true });
  await Bun.write(join(src, "lib", "dict.d.ts"), `export interface Headers { [name: string]: string }
export declare function headers(): Headers;
export declare function counts(): Record<string, number>;
export declare function labels(): { [key: string]: string | undefined };
`);
  await Bun.write(join(src, "lib", "dict.js"), "export const headers = () => ({}); export const counts = () => ({}); export const labels = () => ({});\n");
  try {
    const text = main("import { headers, counts, labels } from './lib/dict.js'", `    var h:Record<String, String> = headers()
    var n:Float = counts()['a'] ?? 0
    var l:String? = labels().title
    var bad:Int = counts()['b']
    trace(h, n, l, bad)`);
    const result = compileProject([{ path: "Main.xn", text }], { main: "Main", typeRoot: src, assets: [{ path: "lib/dict.js", text: "// js" }] });
    const errors = result.diagnostics.sorted().filter((d) => d.severity === "error").map((d) => `${d.code} ${d.labels.find((l) => l.primary)!.message}`);
    expect(errors).toEqual(["X0308 expected `Int`, found `Float?`"]);
    expect(result.declarationErrors).toEqual([]);
  } finally {
    await rm(join(src, ".."), { recursive: true, force: true });
  }
});

test("TypeScript's read-only types become `const`: `ReadonlyArray`, `readonly` tuples, `ReadonlyMap`, `ReadonlySet`", async () => {
  const { mkdir, rm } = await import("node:fs/promises");
  const project = join(import.meta.dir, ".dts-readonly");
  const pkg = join(project, "node_modules", "frozen");
  await rm(project, { recursive: true, force: true });
  await mkdir(pkg, { recursive: true });
  await Bun.write(join(pkg, "package.json"), JSON.stringify({ name: "frozen", types: "index.d.ts" }));
  await Bun.write(join(pkg, "index.d.ts"), [
    "export declare function names(): ReadonlyArray<string>;",
    "export declare function pair(): readonly [string, number];",
    "export declare function ages(): ReadonlyMap<string, number>;",
    "export declare function tags(): ReadonlySet<string>;",
    "export declare function count(items: readonly string[]): number;",
    "",
  ].join("\n"));
  try {
    const text = `import * as frozen from 'frozen'

public class Main {
  public function Main() {
    var names = frozen.names()
    trace(names.length, names.join(','), frozen.count(['a']), frozen.count(names), frozen.ages().get('a'), frozen.tags().has('x'), frozen.pair()[0])
    names.push('x')
    frozen.pair()[0] = 'y'
    frozen.ages().set('b', 1)
    frozen.tags().add('y')
  }
}
`;
    const result = compileProject([{ path: "Main.xn", text }], { main: "Main", typeRoot: join(project, "src") });
    expect(result.declarationErrors).toEqual([]);
    expect(result.diagnostics.sorted().filter((d) => d.severity === "error").map((d) => `${d.code} ${d.message}`)).toEqual([
      "X0905 cannot use non-const method `push` through a `const Array<String>`",
      "X0904 cannot change an element through a `const Tuple<String, Float>`",
      "X0905 cannot use non-const method `set` through a `const Map<String, Float>`",
      "X0905 cannot use non-const method `add` through a `const Set<String>`",
    ]);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
