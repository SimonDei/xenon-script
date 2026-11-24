import { afterAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { compileProject } from "../src/compiler.ts";
import { typeCheck } from "./tsemit.ts";

const out = join(import.meta.dir, ".comprehension-out");
afterAll(() => rm(out, { recursive: true, force: true }));

const code = `
typedef Item = { value:Int }
public class Main {
  private var offset:Int = 10
  public function Main() {}
  public function run():Array<Int> {
    var xs = [1, 2, 3]
    return [for (x of xs) if (x > 1) for (y of [x, x + 1]) y + offset]
  }
  public static function shadow():Array<Int> {
    var x = [2, 4]
    return [for (x of x) x]
  }
  public static function names():Array<Int> {
    var $comprehension = 7
    var $comprehensionSource = [1, 2]
    return [for (x of $comprehensionSource) x + $comprehension]
  }
  public static function ranges():Array<Int> {
    return [for (var i:Int of 0..10) if (i % 2 == 0) i]
  }
  public static function nestedRanges():Array<Int> {
    return [for (x of 1..=3) for (y of 0..x step 2) x * 10 + y]
  }
  public static function rangeShadow():Array<Int> {
    var i = 3
    return [for (i of 0..i) i]
  }
  public static function rangeClosures():Array<() -> Int> {
    return [for (i of 1..=3) () => i]
  }
  public static function fractional():Array<Float> {
    return [for (i:Float of 0..=2 step 0.5) i]
  }
  public static function rangeOrder():String {
    var n = 0
    var result = [for (i of (n += 1)..(n += 3)) (n += i)]
    return String(n) + ':' + result.join(',')
  }
  public static function pairs():Array<Int> {
    var pairs:Array<Tuple<Int, Int>> = [[1, 2], [3, 4]]
    return [for (final [a, b] of pairs) a + b]
  }
  public static function objects():Array<Item> {
    return [for (x:Int of [1, 2]) { value: x }]
  }
  public static function closures():Array<() -> Int> {
    return [for (x of [1, 2, 3]) () => x]
  }
  public static function order():String {
    var log = ''
    var a = [for (x of [1, 2]) if ((log += String(x)) != '1') for (y of [x, x + 1]) (log += String(y))]
    return log + ':' + a.join(',')
  }
  public static function characters():Array<String> {
    return [for (ch of 'ab') ch.toUpperCase()]
  }
  public static function narrow(xs:Array<String?>):Array<Int> {
    return [for (x of xs) if (x != null) x.length]
  }
  public static function nestedAsync():Array<() -> Promise<Int>> {
    return [for (x of [1, 2]) async () => await Promise.resolve(x)]
  }
  public static async function later():Promise<Array<Int>> {
    return [for (x of await Promise.resolve([1, 2, 3])) if (await Promise.resolve(x > 1)) await Promise.resolve(x * 2)]
  }
  public static async function asyncRange():Promise<Array<Int>> {
    return [for (i of await Promise.resolve(1)..await Promise.resolve(3)) i]
  }
}
`;

const errors = (result: ReturnType<typeof compileProject>) =>
  result.diagnostics.items.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.message}`);

test("comprehensions iterate, filter, scope bindings and preserve async evaluation", async () => {
  const result = compileProject([{ path: "Main.xn", text: code }], { main: "Main" });
  expect(errors(result)).toEqual([]);
  for (const file of result.outputs) await Bun.write(join(out, file.path), file.text);
  const { Main } = await import(join(out, "Main.js"));
  expect(new Main().run()).toEqual([12, 13, 13, 14]);
  expect(Main.shadow()).toEqual([2, 4]);
  expect(Main.names()).toEqual([8, 9]);
  expect(Main.ranges()).toEqual([0, 2, 4, 6, 8]);
  expect(Main.nestedRanges()).toEqual([10, 20, 30, 32]);
  expect(Main.rangeShadow()).toEqual([0, 1, 2]);
  expect(Main.rangeClosures().map((f: () => number) => f())).toEqual([1, 2, 3]);
  expect(Main.fractional()).toEqual([0, 0.5, 1, 1.5, 2]);
  expect(Main.rangeOrder()).toBe("10:5,7,10");
  expect(Main.pairs()).toEqual([3, 7]);
  expect(Main.objects()).toEqual([{ value: 1 }, { value: 2 }]);
  expect(Main.closures().map((f: () => number) => f())).toEqual([1, 2, 3]);
  expect(Main.order()).toBe("1223:122,1223");
  expect(Main.characters()).toEqual(["A", "B"]);
  expect(Main.narrow(["a", null, "xyz"])).toEqual([1, 3]);
  expect(await Promise.all(Main.nestedAsync().map((f: () => Promise<number>) => f()))).toEqual([1, 2]);
  expect(await Main.later()).toEqual([4, 6]);
  expect(await Main.asyncRange()).toEqual([1, 2]);
});

test("comprehension ranges use the normal range validation", () => {
  const source = `public class Main {
    public function Main() {}
    public static function f():Void {
      var a = [for (i of 0..10 step 0) i]
      var b = [for (i of 0..=) i]
      var c = [for (i of 'a'..3) i]
      var d:Int = [for (var i:Int of 0..10) i]
      trace(a, b, c, d)
    }
  }`;
  const messages = errors(compileProject([{ path: "Main.xn", text: source }], { main: "Main" }));
  expect(messages.some((m) => m.startsWith("X0330 "))).toBe(true);
  expect(messages.some((m) => m.includes("inclusive range"))).toBe(true);
  expect(messages.some((m) => m.startsWith("X0334 "))).toBe(true);
  expect(messages.some((m) => m.startsWith("X0308 "))).toBe(true);
});

test("comprehension errors use iterable, condition, element and scope checking", () => {
  const bad = `public class Main {
    public function Main() {}
    public static function f():Void {
      var a = [for (x of 1) x]
      var b = [for (x of [1]) if (x) x]
      var c:Array<String> = [for (x of [1]) x]
      var d = [for (x of [1]) x]
      trace(x)
      final z:Int
      var e = [for (x of [1]) (z = x)]
      trace(z)
    }
  }`;
  const messages = errors(compileProject([{ path: "Main.xn", text: bad }], { main: "Main" }));
  expect(messages.some((m) => m.startsWith("X0391 "))).toBe(true);
  expect(messages.some((m) => m.startsWith("X0310 "))).toBe(true);
  expect(messages.some((m) => m.startsWith("X0308 "))).toBe(true);
  expect(messages.some((m) => m.startsWith("X0425 "))).toBe(true);
  expect(messages.some((m) => m.startsWith("X0513 "))).toBe(true);
  expect(messages.some((m) => m.startsWith("X0511 "))).toBe(true);
});

test("scoped values cannot escape or become undestroyed loop temporaries", () => {
  const source = `class Res {
    public function Res() {}
    public function ~Res() {}
    public function read():Int { return 1 }
  }
  public class Main {
    public function Main() {}
    public static function f(r:Res):Void {
      var a = [for (x of [1]) r]
      var b = [for (x of [1]) new Res().read()]
      trace(a, b)
    }
  }`;
  const messages = errors(compileProject([{ path: "Main.xn", text: source }], { main: "Main" }));
  expect(messages.some((m) => m.startsWith("X0822 "))).toBe(true);
  expect(messages.some((m) => m.startsWith("X0829 "))).toBe(true);
});

test("TypeScript output type-checks", () => {
  const result = compileProject([{ path: "Main.xn", text: code }], { main: "Main", target: "ts" });
  expect(errors(result)).toEqual([]);
  expect(typeCheck(result.outputs, out)).toEqual([]);
});
