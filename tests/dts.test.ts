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
