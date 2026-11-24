/** An object literal's type is the shape it builds: `{ name: 'test', age: 20 }` is `{ name:String, age:Int }`. */
import { expect, test } from "bun:test";
import { compileProject } from "../src/compiler.ts";
import { renderAll } from "../src/diagnostics.ts";

const found = (body: string) => {
  const text = `public class Main {\n  public function Main() {\n${body}\n  }\n}\n`;
  const errors = compileProject([{ path: "Main.xn", text }], { main: "Main" }).diagnostics.items.filter((d) => d.severity === "error");
  return [...renderAll(errors, { color: false }).matchAll(/found `([^`]+)`|no member `(\w+)` on `([^`]+)`/g)].map((m) => m[1] ?? `${m[2]} on ${m[3]}`);
};

test("an object literal's shape is inferred wherever it is used, also with shorthands, spreads, getters and as a result", () => {
  expect(found(`    var x:Int = 1
    var p = { name: 'test', age: 20 }
    var a:String = p.age
    var b:String = { x }.x
    var c:String = { ...p, extra: true }.extra
    var d:String = [{ n: 1 }, { n: 2 }][0].n
    var make = () => ({ ok: true, nested: { size: 2.5 } })
    var e:String = make().nested.size
    var f:String = { function get total():Int { return 3 } }.total
    var g = p.nope`)).toEqual(["Int", "Int", "Bool", "Int", "Float", "Int", "nope on { name:String, age:Int }"]);
});

test("a spread keeps the later key; `{}` and computed keys stay an open `Object`", () => {
  expect(found(`    var p = { a: 1, b: 'x' }
    var q = { ...p, a: 'now a String' }
    var s:Int = q.a
    var open = {}
    open.anything = 1
    var k = 'key'
    var dyn = { [k]: 1 }
    trace(s, open, dyn.whatever)`)).toEqual(["String"]);
});
