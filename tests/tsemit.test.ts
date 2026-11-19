/** The `ts` target: typed TypeScript that TypeScript accepts, with token mappings back to the Xenon source. */
import { afterAll, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { generatedOffsetAt, sourceOffsetAt } from "../src/codegen.ts";
import { compileProject } from "../src/compiler.ts";
import { compileExampleToTs, tsDiagnostics, typeCheck } from "./tsemit.ts";

const examples = join(import.meta.dir, "..", "examples");
const names = (await Array.fromAsync(new Bun.Glob("*/expected.txt").scan({ cwd: examples }))).map((p) => p.split("/")[0]!).sort();

test.each(names)("TypeScript accepts the output of examples/%s", async (name) => {
  const outputs = await compileExampleToTs(join(examples, name));
  expect(typeCheck(outputs, join(examples, name, "out-ts"))).toEqual([]);
});

test("token mappings cover the same text on both sides", async () => {
  let names = 0;
  for (const name of ["zoo", "generics", "interfaces", "typedefs"]) {
    for (const o of await compileExampleToTs(join(examples, name))) {
      for (const m of o.mappings ?? []) {
        const src = o.source!.text.slice(m.source, m.source + m.sourceLength);
        const gen = o.text.slice(m.generated, m.generated + m.generatedLength);
        // Names are copied; types, `trace` and constructors are spelled differently in TypeScript.
        const renamed = ["trace", "int", "uint", "Float", "String", "Boolean", "Array", "Object", "Iterator", "Void", "Int"];
        if (/^[A-Za-z_$][\w$]*$/.test(src) && !renamed.includes(src) && gen !== "constructor") {
          expect(gen).toBe(src);
          names++;
        }
      }
    }
  }
  expect(names).toBeGreaterThan(500);
});

const SHAPES = `package geo {
  public interface IShape {
    function area():Float
    function get name():String
  }
}
`;
const BOX = `package geo {
  public class Box<T> implements IShape {
    private var items:Array<T> = []
    protected static var count:int
    public var label:String?
    public function Box(first:T) { items.push(first) }
    public function area():Float { return items.length }
    public function get name():String { return 'box' }
    public function map<U>(f:(item:T) -> U):Box<U> { return new Box<U>(f(items[0])) }
  }
}
`;
const MAIN = `import geo.Box
import geo.IShape
import { readFileSync } from 'node:fs'

public class Main {
  public function Main() {
    var b:Box<int> = new Box<int>(1)
    var s:IShape = b
    var n:Int? = null
    var c:Color = Color.Green
    var p:Pair = { a: 1, b: 'x' }
    var size:int = readFileSync('Main.xn', 'utf8')
    trace(b.map((x:int):String => 'n' + x).name, s.area(), n, c, p, size)
  }
}

enum Color { Red, Green }
typedef Pair = { a:int, ?b:String }
`;

test("declarations carry their types", () => {
  const result = compileProject([{ path: "geo/IShape.xn", text: SHAPES }, { path: "geo/Box.xn", text: BOX }, { path: "Main.xn", text: MAIN }], { main: "Main", target: "ts" });
  expect(result.diagnostics.items.filter((d) => d.severity === "error")).toEqual([]);
  const files = new Map(result.outputs.map((o) => [o.path, o.text]));
  expect([...files.keys()].sort()).toEqual(["Main.ts", "geo/Box.ts", "geo/IShape.ts", "xenon-main.ts", "xenon/Prelude.ts"]);
  expect(files.get("geo/IShape.ts")).toBe(`export interface IShape {
  area(): number;
  get name(): string;
}
export const IShape = Symbol('geo.IShape');
`);
  const box = files.get("geo/Box.ts")!;
  expect(box).toContain("export class Box<T> implements IShape {");
  expect(box).toContain("#items: Array<T> = [];"); // private: a JavaScript private field
  expect(box).toContain("protected static count: number = 0;");
  expect(box).toContain("label: string = null;");
  expect(box).toContain("constructor(first: T) {");
  expect(box).toContain("map<U>(f: (item: T) => U): Box<U> {");
  expect(box).toContain("return new Box<U>(f(this.#items[0]));");
  const main = files.get("Main.ts")!;
  expect(main).toContain("let n: number | null = null;");
  expect(main).toContain("let c: Color = Color.Green;");
  expect(main).toContain("const Color = Object.freeze({ Red: 0, Green: 1 });");
  expect(main).toContain("type Color = (typeof Color)[keyof typeof Color];");
  expect(main).toContain("type Pair = { a: number; b?: string };");
  expect(result.outputs.some((o) => o.path.endsWith(".map") || o.text.includes("sourceMappingURL"))).toBe(false);
});

test("TypeScript's errors map back to the Xenon source", () => {
  // Xenon types JS imports as `*`; TypeScript knows `readFileSync` returns a string.
  const result = compileProject([{ path: "geo/IShape.xn", text: SHAPES }, { path: "geo/Box.xn", text: BOX }, { path: "Main.xn", text: MAIN }], { main: "Main", target: "ts" });
  const diags = tsDiagnostics(result.outputs, "/virtual");
  expect(diags.map((d) => `${d.file?.fileName}: TS${d.code}`)).toEqual(["/virtual/Main.ts: TS2322"]);
  const main = result.outputs.find((o) => o.path === "Main.ts")!;
  const at = sourceOffsetAt(main.mappings!, diags[0]!.start!)!;
  const { line, col } = main.source!.position(at);
  expect([line, col]).toEqual([12, 9]);
  expect(MAIN.slice(at, at + 4)).toBe("size");
  expect(generatedOffsetAt(main.mappings!, at)).toBe(diags[0]!.start!);
});

const dir = join(import.meta.dir, ".tsemit-project");
afterAll(() => rm(dir, { recursive: true, force: true }));

test("`xenon run --target ts` writes TypeScript and runs it", async () => {
  await rm(dir, { recursive: true, force: true });
  await mkdir(join(dir, "src", "geo"), { recursive: true });
  await Bun.write(join(dir, "src", "geo", "IShape.xn"), SHAPES);
  await Bun.write(join(dir, "src", "geo", "Box.xn"), BOX);
  await Bun.write(join(dir, "src", "Main.xn"), MAIN.replace("readFileSync('Main.xn', 'utf8')", "42").replace("import { readFileSync } from 'node:fs'\n", ""));
  const cli = join(import.meta.dir, "..", "src", "cli.ts");
  const proc = Bun.spawn(["bun", cli, "run", "--quiet", "--target", "ts", "--color", "never"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  expect(await new Response(proc.stderr).text()).toBe("");
  expect(await proc.exited).toBe(0);
  expect(stdout).toBe("box 1 null 1 {\n  a: 1,\n  b: \"x\",\n} 42\n");
  expect(await Bun.file(join(dir, "out", "geo", "Box.ts")).exists()).toBe(true);
  expect(await Bun.file(join(dir, "out", "geo", "Box.js")).exists()).toBe(false);
  expect(await Bun.file(join(dir, "out", "Main.js.map")).exists()).toBe(false);
});
