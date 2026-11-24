/** `Int`/`UInt` arithmetic wraps to 32 bits (as in C, Java and C#) instead of turning into an inexact `Float`. */
import { afterAll, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ENTRY_FILE } from "../src/codegen.ts";
import { compileProject } from "../src/compiler.ts";

const out = join(import.meta.dir, ".integers-out");
afterAll(() => rm(out, { recursive: true, force: true }));

test("+, -, * and negation wrap; compound assignments and ++ too; Float, / and % don't", async () => {
  const text = await Bun.file(join(import.meta.dir, "fixtures", "integers.xn")).text();
  const result = compileProject([{ path: "Main.xn", text }], { main: "Main" });
  expect(result.diagnostics.items.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
  const js = result.outputs.find((o) => o.path === "Main.js")!.text;
  expect(js).toContain("Math.imul(big, big)");
  expect(js).toContain("n = (n + 1) | 0;");
  expect(js).toContain("5 - 8"); // literals whose result fits: as written
  for (const o of result.outputs) {
    await mkdir(dirname(join(out, o.path)), { recursive: true });
    await Bun.write(join(out, o.path), o.text);
  }
  const proc = Bun.spawn(["bun", join(out, ENTRY_FILE)], { stdout: "pipe", stderr: "pipe" });
  const printed = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
  expect(printed.trim().split("\n")).toEqual([
    "-2147483648 -2 2147483647 -2147483648",
    "-1757895751 370370367 -2147483648 -3",
    "-2147483648 2147483647 -2147483648 -2147483647",
    "-2147483648 2147483645",
    "4294967295 0",
    "2147483647.5 2.5 1",
  ]);
});

const small = `public class Main {
  public function Main() {}

  public static function run():Array<String> {
    var b:Byte = 127
    b++                                  // wraps: -128
    var s:Short = Short.MAX_VALUE
    s += 1                               // wraps: -32768
    var r:Byte = 100
    r *= 3                               // 300 wraps to 44
    var m:Byte = -128
    m--                                  // 127
    var sum:Int = b + Byte(200)          // arithmetic is Int: -128 + -56
    var wide:Int = b                     // widening: Byte → Short → Int → Float
    var sh:Short = b
    var f:Float = s
    var x:* = 5
    var y:* = 300
    return [$'{b} {s} {r} {m} {sum}', $'{wide} {sh} {f} {-m}', $'{Byte(200)} {Short(40000)} {Byte(-129)} {Short(1.9)}',
      $'{x is Byte} {y is Byte} {y is Short} {1.5 is Short}', $'{Byte.MIN_VALUE} {Short.MIN_VALUE}']
  }
}
`;

test("Byte and Short: 8- and 16-bit two's complement, wrapping conversions, compound assignments and ++", async () => {
  const result = compileProject([{ path: "Main.xn", text: small }], { main: "Main" });
  expect(result.diagnostics.items.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
  const js = result.outputs.find((o) => o.path === "Main.js")!.text;
  expect(js).toContain("<< 24 >> 24");
  expect(js).toContain("<< 16 >> 16");
  for (const o of result.outputs) {
    await mkdir(dirname(join(out, "small", o.path)), { recursive: true });
    await Bun.write(join(out, "small", o.path), o.text);
  }
  const { Main } = await import(join(out, "small", "Main.js"));
  expect(Main.run()).toEqual(["-128 -32768 44 127 -184", "-128 -128 -32768 -127", "-56 -25536 127 1", "true false true false", "-128 -32768"]);
});

test("Byte and Short: arithmetic gives Int (Byte() converts back), no implicit narrowing, ranges of literals", () => {
  const bad = `public class Main {
  public function Main() {}
  public static function f(b:Byte, s:Short, i:Int, u:UInt):Void {
    var x:Byte = 200
    var y:Byte = b + 1
    var z:Byte = s
    var w:Short = i
    var v:Byte = u
    b /= 2
    b &= 3
    trace(x, y, z, w, v)
  }
}
`;
  const errors = compileProject([{ path: "Main.xn", text: bad }], { main: "Main" }).diagnostics.items.filter((d) => d.severity === "error");
  expect(errors.map((d) => d.labels.find((l) => l.primary)!.message)).toEqual([
    "expected `Byte`, found `Int`",
    "expected `Byte`, found `Int`",
    "expected `Byte`, found `Short`",
    "expected `Short`, found `Int`",
    "expected `Byte`, found `UInt`",
    "`/=` produces `Float`, but the target is `Byte`",
    "`&=` produces `Int`, but the target is `Byte`",
  ]);
  // Only arithmetic explains itself: `b + 1` is an `Int`.
  expect(errors.filter((d) => d.notes.some((n) => n.includes("arithmetic on `Byte`"))).length).toBe(1);
  expect(errors.every((d) => d.help.length > 0 || d.labels[0]?.message?.includes("produces"))).toBe(true);
});

test("Byte and Short in the TypeScript output are numbers", async () => {
  const { typeCheck } = await import("./tsemit.ts");
  const result = compileProject([{ path: "Main.xn", text: small }], { main: "Main", target: "ts" });
  expect(result.diagnostics.items.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
  expect(typeCheck(result.outputs, join(out, "small-ts"))).toEqual([]);
});
