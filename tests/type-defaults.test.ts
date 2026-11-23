/** Type parameter defaults: `class Box<T = String>`, `Event` for `Event<EventTarget>`. */
import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { compileProject } from "../src/compiler.ts";
import { renderAll } from "../src/diagnostics.ts";
import { typeCheck } from "./tsemit.ts";

const errors = (r: ReturnType<typeof compileProject>) => r.diagnostics.items.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.message}`);

const code = `class Box<T = String, U = Int> {
  public var value:T;
  public var extra:U?;
  public function Box(value:T) { this.value = value; }
}

public class Main {
  public function Main() {}
  public static function run():String {
    var a:Box = new Box('x');                  // Box<String, Int>
    var b:Box<Float> = new Box(1.5);           // Box<Float, Int>: T from the argument
    var c:Box<Bool, String> = new Box(true);
    var d = new Box('y');                      // inferred: Box<String, Int>
    return a.value.toUpperCase() + b.value.toFixed(1) + c.value + d.value
  }
  public static function over(box:Box):Int => box.value.length
}
`;

test("a type parameter default: left-out arguments take it, `new` still infers", () => {
  const result = compileProject([{ path: "Main.xn", text: code }], { main: "Main" });
  expect(errors(result)).toEqual([]);
});

test("a default is used where nothing decides the type argument, and a use must match it", () => {
  const bad = `class Box<T = String> {
  public var value:T?;
  public function Box() {}
}
public class Main {
  public function Main() {}
  public static function f():Int {
    var box = new Box();
    var n:Int = box.value;
    return n
  }
}
`;
  const result = compileProject([{ path: "Main.xn", text: bad }], { main: "Main" });
  const messages = result.diagnostics.items.filter((d) => d.severity === "error");
  expect(messages.map((d) => d.code)).toEqual(["X0308"]);
  // `new Box()` has no argument to infer from: `T` is `String`.
  expect(renderAll(messages, { color: false })).toContain("expected `Int`, found `String?`");
});

test("TypeScript output declares the defaults and type-checks", () => {
  const result = compileProject([{ path: "Main.xn", text: code }], { main: "Main", target: "ts" });
  expect(errors(result)).toEqual([]);
  expect(result.outputs.find((o) => o.path === "Main.ts")!.text).toContain("class Box<T = string, U = number>");
  expect(typeCheck(result.outputs, join(import.meta.dir, ".defaults-ts"))).toEqual([]);
});

afterAll(async () => {
  const { rm } = await import("node:fs/promises");
  await rm(join(import.meta.dir, ".defaults-ts"), { recursive: true, force: true });
});
