/** `IComparable<T>`: a natural order through `compareTo()`, usable for sorting and as a generic constraint. */
import { afterAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { compileProject } from "../src/compiler.ts";
import { typeCheck } from "./tsemit.ts";

const out = join(import.meta.dir, ".comparable-out");
afterAll(() => Promise.all([rm(out, { recursive: true, force: true }), rm(join(import.meta.dir, ".comparable-ts"), { recursive: true, force: true })]));

const code = `class Version implements IComparable<Version>, IEquatable<Version> {
  public final major:Int
  public final minor:Int
  public function Version(major:Int, minor:Int) {
    this.major = major
    this.minor = minor
  }
  public function compareTo(other:Version):Int => major != other.major ? major - other.major : minor - other.minor
  public function equals(other:Version):Bool => compareTo(other) == 0
  public override function toString():String => $'{major}.{minor}'
}

public class Main {
  public function Main() {}

  public static function run():Array<String> {
    var versions:Array<Version> = [new Version(2, 0), new Version(1, 10), new Version(1, 2)]
    var sorted:Array<Version> = versions.toSorted((a, b) => a.compareTo(b))
    var top:Version? = Main.max(versions)
    var x:* = versions[0]
    var none:Array<Version> = []
    return [sorted.join(' '), top?.toString() ?? '-', $'{Main.max(none) == null} {x is IComparable}', $'{new Version(1, 2).equals(new Version(1, 2))}']
  }

  /** Generic code may call \`compareTo\` on a \`T\` constrained to \`IComparable<T>\`. */
  public static function max<T extends IComparable<T>>(items:Array<T>):T? {
    var best:T? = null
    for (var item:T of items) if (best == null || item.compareTo(best) > 0) best = item
    return best
  }
}
`;

test("compareTo() orders values: sorting with it, and a constraint that lets generic code call it", async () => {
  const result = compileProject([{ path: "Main.xn", text: code }], { main: "Main" });
  expect(result.diagnostics.items.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
  for (const o of result.outputs) await Bun.write(join(out, o.path), o.text);
  const { Main } = await import(join(out, "Main.js"));
  expect(Main.run()).toEqual(["1.2 1.10 2.0", "2.0", "true true", "true"]);
});

test("a class that implements IComparable needs compareTo(); a constrained type argument must implement it", () => {
  const bad = `class Bad implements IComparable<Bad> {
  public function Bad() {}
}
class Plain {
  public function Plain() {}
}
public class Main {
  public function Main() { trace(Main.first(new Plain(), new Plain())) }
  public static function first<T extends IComparable<T>>(a:T, b:T):T => a.compareTo(b) <= 0 ? a : b
}
`;
  const errors = compileProject([{ path: "Main.xn", text: bad }], { main: "Main" }).diagnostics.items.filter((d) => d.severity === "error");
  expect(errors.map((d) => d.code)).toEqual(expect.arrayContaining(["X0787", "X0880"]));
});

test("the TypeScript output of IComparable type-checks", () => {
  const result = compileProject([{ path: "Main.xn", text: code }], { main: "Main", target: "ts" });
  expect(result.diagnostics.items.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
  expect(typeCheck(result.outputs, join(import.meta.dir, ".comparable-ts"))).toEqual([]);
});
