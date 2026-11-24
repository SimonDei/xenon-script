/** `IEquatable<T>`: value equality through `equals()`, usable as a generic constraint. */
import { afterAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { compileProject } from "../src/compiler.ts";
import { typeCheck } from "./tsemit.ts";

const out = join(import.meta.dir, ".equatable-out");
afterAll(() => Promise.all([rm(out, { recursive: true, force: true }), rm(join(import.meta.dir, ".equatable-ts"), { recursive: true, force: true })]));

const code = `class Money implements IEquatable<Money> {
  public final cents:Int
  public final currency:String
  public function Money(cents:Int, currency:String) {
    this.cents = cents
    this.currency = currency
  }
  public function equals(other:Money):Bool => cents == other.cents && currency == other.currency
}

public class Main {
  public function Main() {}

  public static function run():Array<String> {
    var a:Money = new Money(100, 'EUR')
    var b:Money = new Money(100, 'EUR')
    var list:Array<Money> = [new Money(5, 'EUR'), b]
    var x:* = a
    return [$'{a == b} {a.equals(b)} {a.equals(new Money(100, 'USD'))}', $'{Main.indexOf(list, a)} {Main.indexOf(list, new Money(1, 'EUR'))}', $'{x is IEquatable}']
  }

  /** Generic code may call \`equals\` on a \`T\` constrained to \`IEquatable<T>\`. */
  public static function indexOf<T extends IEquatable<T>>(items:Array<T>, x:T):Int {
    for (var i:Int = 0; i < items.length; i++) if (items[i].equals(x)) return i
    return -1
  }
}
`;

test("equals() compares by value where == compares references; a constraint lets generic code call it", async () => {
  const result = compileProject([{ path: "Main.xn", text: code }], { main: "Main" });
  expect(result.diagnostics.items.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
  for (const o of result.outputs) await Bun.write(join(out, o.path), o.text);
  const { Main } = await import(join(out, "Main.js"));
  expect(Main.run()).toEqual(["false true false", "1 -1", "true"]);
});

test("a class that implements IEquatable needs equals(); a constrained type argument must implement it", () => {
  const bad = `class Bad implements IEquatable<Bad> {
  public function Bad() {}
}
class Plain {
  public function Plain() {}
}
public class Main {
  public function Main() { trace(Main.same(new Plain(), new Plain())) }
  public static function same<T extends IEquatable<T>>(a:T, b:T):Bool => a.equals(b)
}
`;
  const errors = compileProject([{ path: "Main.xn", text: bad }], { main: "Main" }).diagnostics.items.filter((d) => d.severity === "error");
  expect(errors.map((d) => d.code)).toEqual(expect.arrayContaining(["X0787", "X0880"]));
});

test("the TypeScript output of IEquatable type-checks", () => {
  const result = compileProject([{ path: "Main.xn", text: code }], { main: "Main", target: "ts" });
  expect(result.diagnostics.items.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
  expect(typeCheck(result.outputs, join(import.meta.dir, ".equatable-ts"))).toEqual([]);
});
