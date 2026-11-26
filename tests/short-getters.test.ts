/** Accessors without `function` (`get total():Float => …`), and getters that take their expression's type. */
import { afterAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { compileProject } from "../src/compiler.ts";
import { typeCheck } from "./tsemit.ts";

const errors = (r: ReturnType<typeof compileProject>) => r.diagnostics.items.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.message}`);
const warnings = (r: ReturnType<typeof compileProject>) => r.diagnostics.items.filter((d) => d.severity === "warning").map((d) => d.code);

const cart = `public class Cart {
  private final items:Array<Float> = [1.5, 2.5]
  private var _owner:String = 'ada'

  public get total() => items.reduce((sum, i) => sum + i, 0.0)
  public get label() => $'{count} items: {total}'
  public get count() => items.length
  public get first():Float? => items.at(0)
  public static get none() => new Cart().count == 0

  public get owner() => _owner
  public set owner(name:String) { _owner = name.trim() }

  public function function_get():Int => 1
}
`;
const main = `public class Main {
  public function Main() {}
  public static function run():Array<*> {
    var c = new Cart()
    c.owner = '  grace '
    var o = {
      rows: [1, 2],
      get size() => this.rows.length,
      get title():String => 'rows',
      set title(v:String) {},
    }
    var n:Int = c.count + o.size
    var t:Float = c.total
    return [c.label, n, t, c.owner, Cart.none, c.first, o.title]
  }
}
`;
const compile = (target?: "ts") => compileProject([{ path: "Cart.xn", text: cart }, { path: "Main.xn", text: main }], { main: "Main", ...(target ? { target } : {}) });

test("`get` and `set` without `function`; a getter written `=> expr` takes its type, in classes and object literals", () => {
  const result = compile();
  expect(errors(result)).toEqual([]);
  expect(warnings(result)).not.toContain("X0850");
  const js = result.outputs.filter((o) => o.path === "Cart.js" || o.path === "Main.js").map((o) => o.text.replace(/^(export |import .*$)/gm, "").replace(/\/\/# sourceMappingURL.*$/m, "")).join("\n");
  const Main = new Function(`${js}; return Main;`)();
  expect(Main.run()).toEqual(["2 items: 4", 4, 4, "grace", false, 1.5, "rows"]);
});

test("an inferred type is checked like a declared one", () => {
  const text = `public class Main {
  public get total() => 1.5
  public get size() => { n: 1 }.n
  public function Main() {
    var s:String = total
    var i:Int = size
    var b:Bool = { get flag() => 'no' }.flag
  }
}
`;
  expect(errors(compileProject([{ path: "Main.xn", text }], { main: "Main" }))).toEqual([
    "X0308 mismatched types",
    "X0308 mismatched types",
  ]);
});

test("getters whose types depend on each other are an error; a block body still needs a type", () => {
  const text = `public class Main {
  public get a() => b + 1
  public get b() => a * 2
  public get c() { return 1 }
  public function Main() {}
}
`;
  const result = compileProject([{ path: "Main.xn", text }], { main: "Main" });
  expect(errors(result)).toEqual(["X0908 the type of `a` depends on itself"]);
  expect(result.diagnostics.items.find((d) => d.code === "X0850")?.message).toContain("getter");
});

test("an inferred getter of another class, declared further down, is known by its uses", () => {
  const a = "public class A {\n  public function A() {}\n  public static get size() => B.items.length + 1\n}\n";
  const b = "public class B {\n  public static final items:Array<String> = ['x']\n}\n";
  const use = "public class Main {\n  public function Main() {\n    var s:String = A.size\n  }\n}\n";
  const result = compileProject([{ path: "Main.xn", text: use }, { path: "A.xn", text: a }, { path: "B.xn", text: b }], { main: "Main" });
  expect(result.diagnostics.items.filter((d) => d.severity === "error").map((d) => d.labels.find((l) => l.primary)?.message)).toEqual(["expected `String`, found `Int`"]);
});

test("`get function` in an object literal is reported with a fix", () => {
  const text = "public class Main {\n  public function Main() {\n    trace({ get function n():Int => 1 })\n  }\n}\n";
  expect(errors(compileProject([{ path: "Main.xn", text }], { main: "Main" }))).toEqual(["X0100 `get` and `function` together"]);
});

test("the TypeScript output of inferred getters type-checks", () => {
  const result = compile("ts");
  expect(errors(result)).toEqual([]);
  expect(typeCheck(result.outputs, join(import.meta.dir, ".short-getters-ts"))).toEqual([]);
});

afterAll(() => rm(join(import.meta.dir, ".short-getters-ts"), { recursive: true, force: true }));
