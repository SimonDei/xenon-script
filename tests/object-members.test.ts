/** Methods and accessors in object literals: `function name() {}`, `function get x():T {}`, `function set x(v:T):Void {}`. */
import { afterAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { compileProject } from "../src/compiler.ts";
import { typeCheck } from "./tsemit.ts";

const errors = (r: ReturnType<typeof compileProject>) => r.diagnostics.items.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.message}`);

const code = `typedef Box = { width:Int, final area:Int, name:String }

public class Main {
  public function Main() {}

  /** A component like Alpine's: \`this\` is the object inside its getters, setters and methods. */
  public static function component():* {
    return {
      rows: ['b', 'a', 'c'],
      search: '',
      count: 0,
      function get total():Int { return this.rows.length; },
      function get visible():Array<String> { return this.rows.filter(r => r.includes(this.search)); },
      function set query(value:String):Void { this.search = value.trim(); },
      function get query():String { return this.search; },
      function init():Void { this.count = this.count + 1; },
      function bump(by:Int):Int { this.count = this.count + by; return this.count; },
      async function load(id:String):Promise<String> { return id + this.rows.length; },
      function get():Int { return 7; },
      function: 'a key',
      async: 'another key'
    }
  }

  /** A literal checked against a shape: the getter computes \`area\`. */
  public static function box(w:Int):Box {
    return {
      width: w,
      function get area():Int { return w * 2; },
      name: 'box'
    }
  }
}
`;

test("methods and accessors in an object literal compile to JavaScript methods and run with the object as \`this\`", async () => {
  const result = compileProject([{ path: "Main.xn", text: code }], { main: "Main" });
  expect(errors(result)).toEqual([]);
  const js = result.outputs.find((o) => o.path === "Main.js")!.text;
  expect(js).toContain("get total() {");
  expect(js).toContain("set query(value) {");
  expect(js).toContain("async load(id) {");
  expect(js).toContain("bump(by) {");
  const Main = new Function(`${js.replace(/^export /m, "").replace(/\/\/# sourceMappingURL.*$/m, "")}; return Main;`)();
  const c = Main.component();
  c.init();
  expect(c.count).toBe(1);
  expect(c.bump(2)).toBe(3);
  expect(c.total).toBe(3);
  c.query = "  a ";
  expect(c.query).toBe("a");
  expect(c.visible).toEqual(["a"]);
  expect(await c.load("x")).toBe("x3");
  expect(c.function).toBe("a key");
  expect(c.async).toBe("another key");
  expect(c.get()).toBe(7); // a method named \`get\` (the word only starts an accessor before another name)
  const b = Main.box(4);
  expect(b.area).toBe(8);
  expect({ ...b }).toEqual({ width: 4, area: 8, name: "box" }); // a spread copies the getter's value
});

test("the TypeScript output of methods and accessors type-checks", () => {
  const result = compileProject([{ path: "Main.xn", text: code }], { main: "Main", target: "ts" });
  expect(errors(result)).toEqual([]);
  const ts = result.outputs.find((o) => o.path === "Main.ts")!.text;
  expect(ts).toContain("get total(): number {");
  expect(ts).toContain("set query(value: string) {"); // no return type on a setter
  expect(typeCheck(result.outputs, join(import.meta.dir, ".members-ts"))).toEqual([]);
});

test("an accessor of a literal is typed against the shape it is checked against", () => {
  const bad = `typedef Box = { final area:Int, name:String }
public class Main {
  public function Main() {}
  public static function f():Box {
    return { function get area():String { return 'x'; }, name: 'n' }
  }
}
`;
  const messages = compileProject([{ path: "Main.xn", text: bad }], { main: "Main" }).diagnostics.items.filter((d) => d.severity === "error");
  expect(messages.map((d) => d.code)).toEqual(["X0308"]);
});

afterAll(() => rm(join(import.meta.dir, ".members-ts"), { recursive: true, force: true }));
