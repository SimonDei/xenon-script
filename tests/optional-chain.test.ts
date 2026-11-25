/** `?.` stops the whole chain, as in JavaScript: `a?.b.c` is `null` when `a` is, without `?.` on every link. */
import { afterAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { compileProject } from "../src/compiler.ts";
import { typeCheck } from "./tsemit.ts";

const errors = (r: ReturnType<typeof compileProject>) => r.diagnostics.items.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.labels.find((l) => l.primary)!.message}`);

const code = `typedef Inner = { list:Array<Int>, name:String, ?note:String }
typedef Outer = { inner:Inner }

public class Main {
  public function Main() {}

  public static function run(o:Outer?):String {
    var a:Int? = o?.inner.list[0]
    var b:Int? = o?.inner.name.length
    var c:String? = o?.inner.name.toUpperCase()
    var d:Int? = o?.inner.list.at(1)
    var e:Int? = o?.inner.note?.length
    return $'{a},{b},{c},{d},{e}'
  }
}
`;

test("a chain after `?.` is skipped when the value is null, and typed as if it went on", async () => {
  const result = compileProject([{ path: "Main.xn", text: code }], { main: "Main" });
  expect(errors(result)).toEqual([]);
  const out = join(import.meta.dir, ".optional-chain-out");
  await rm(out, { recursive: true, force: true });
  try {
    for (const o of result.outputs) await Bun.write(join(out, o.path), o.text);
    const { Main } = await import(join(out, "Main.js"));
    // A null object stops before the checked index `[0]` (it would throw on `undefined`).
    expect(Main.run(null)).toBe("undefined,undefined,undefined,undefined,undefined"); // JavaScript's `undefined`, which Xenon treats as `null`
    expect(Main.run({ inner: { list: [7, 8], name: "ann" } })).toBe("7,3,ANN,8,undefined");
    expect(Main.run({ inner: { list: [1], name: "", note: "hi" } }).split(",")[4]).toBe("2");
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test("only the null that `?.` adds is skipped: a member that may be null itself still needs a check", () => {
  const bad = `typedef Inner = { name:String, ?note:String }
typedef Outer = { inner:Inner }
public class Main {
  public function Main() {}
  public static function f(o:Outer?, xs:Array<Int>?):Void {
    var a = o?.inner.note.length
    var b = xs[0]
    var c:Int = o?.inner.name.length
    trace(a, b, c)
  }
}
`;
  expect(errors(compileProject([{ path: "Main.xn", text: bad }], { main: "Main" }))).toEqual([
    "X0398 `String?`",
    "X0398 `Array<Int>?`",
    "X0308 expected `Int`, found `Int?`",
  ]);
});

test("an optional chain can't be assigned to (JavaScript has no optional assignment)", () => {
  const bad = `class Box { public var n:Int = 0; public var inner:Box? = null }
public class Main {
  public function Main() {}
  public static function f(b:Box?, list:Array<Int>?):Void {
    b?.n = 1
    b?.inner.n = 2
    b?.n++
    list?.[0] = 3
    if (var box:Box = b) box.n = 4
  }
}
`;
  expect(errors(compileProject([{ path: "Main.xn", text: bad }], { main: "Main" }))).toEqual([
    "X0105 contains `?.`",
    "X0398 `Box?`", // `inner` may be null itself
    "X0105 contains `?.`",
    "X0105 contains `?.`",
    "X0105 contains `?.`",
  ]);
});

test("the TypeScript output of chains type-checks", () => {
  const result = compileProject([{ path: "Main.xn", text: code }], { main: "Main", target: "ts" });
  expect(errors(result)).toEqual([]);
  expect(typeCheck(result.outputs, join(import.meta.dir, ".optional-chain-ts"))).toEqual([]);
});

afterAll(() => rm(join(import.meta.dir, ".optional-chain-ts"), { recursive: true, force: true }));
