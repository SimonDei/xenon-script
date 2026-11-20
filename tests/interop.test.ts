/** Plain JavaScript can import, use and subclass compiled Xenon classes. */
import { expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { compileProject } from "../src/compiler.ts";

test("JS consumes compiled Xenon classes", async () => {
  const srcRoot = join(import.meta.dir, "..", "examples", "zoo", "src");
  const paths = await Array.fromAsync(new Bun.Glob("**/*.xn").scan({ cwd: srcRoot }));
  const sources = await Promise.all(paths.map(async (p) => ({ path: p, text: await Bun.file(join(srcRoot, p)).text() })));
  const result = compileProject(sources, { main: "Main" });
  expect(result.diagnostics.hasErrors).toBe(false);

  const out = join(import.meta.dir, "..", "examples", "zoo", ".test-out-js");
  await rm(out, { recursive: true, force: true });
  try {
    for (const o of result.outputs) {
      await mkdir(dirname(join(out, o.path)), { recursive: true });
      await Bun.write(join(out, o.path), o.text);
    }
    await Bun.write(
      join(out, "consumer.mjs"),
      `import { Animal } from './com/zoo/Animal.js';
import { Food } from './com/zoo/food/Food.js';

class Parrot extends Animal {
  speak() { return this.name + ' says hello'; }
}

const p = new Parrot('Polly');
p.feed(new Food('seeds', 40));
console.log(p.speak(), p.calories, p instanceof Animal, Animal.population);
`,
    );
    const proc = Bun.spawn(["bun", join(out, "consumer.mjs")], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect(stderr).toBe("");
    expect(stdout).toBe("Polly says hello 40 true 1\n");
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test("fields as JavaScript sees them: private ones are #private, final/const ones read-only", async () => {
  const sources = [
    { path: "Account.xn", text: `public class Account {
  public var balance:Float = 0
  private var pin:int = 1234
  public final id:int
  public const CURRENCY:String = 'EUR'
  public static final START:int
  private static var opened:int = 0
  static { START = 100 }

  public function Account(id:int) {
    this.id = id
    Account.opened++
    pin += id
  }
  public function check(other:Account):Boolean { return other.pin == pin }
  public static function count():int { return Account.opened }
}
` },
    { path: "Savings.xn", text: "public class Savings extends Account {\n  public function Savings() { super(7) }\n}\n" },
    { path: "Main.xn", text: "public class Main {\n  public function Main() {}\n}\n" },
  ];
  const result = compileProject(sources, { main: "Main" });
  expect(result.diagnostics.hasErrors).toBe(false);
  const account = result.outputs.find((o) => o.path === "Account.js")!.text;
  expect(account).toContain("#pin = 1234;");
  expect(account).toContain("#id = 0;\n  get id() { return this.#id; }");
  expect(account).toContain("static get START() { return Account.#START; }");

  const out = join(import.meta.dir, ".fields-out");
  await rm(out, { recursive: true, force: true });
  try {
    for (const o of result.outputs) {
      await mkdir(dirname(join(out, o.path)), { recursive: true });
      await Bun.write(join(out, o.path), o.text);
    }
    await Bun.write(join(out, "consumer.mjs"), `import { Account } from './Account.js';
import { Savings } from './Savings.js';
const a = new Account(1), s = new Savings();
const tryAssign = (f) => { try { f(); return 'assigned'; } catch (e) { return e.constructor.name; } };
console.log(a.id, s.id, a.CURRENCY, a.pin, Savings.START, JSON.stringify(s), Object.keys(a).join());
console.log(tryAssign(() => { a.id = 5; }), tryAssign(() => { Account.START = 1; }), a.id);
a.balance = 10;
console.log(a.balance, a.check(new Account(1)), Account.opened === undefined, Account.count());
`);
    const proc = Bun.spawn(["bun", join(out, "consumer.mjs")], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect(stderr).toBe("");
    expect(stdout).toBe("1 7 EUR undefined 100 {\"balance\":0} balance\nTypeError TypeError 1\n10 true true 3\n");
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test("private methods and fully private properties are #private: JavaScript can't call them", async () => {
  const sources = [
    { path: "Counter.xn", text: `public class Counter {
  private var n:int = 0
  public function bump():int { step(); return n }
  public function twice():int { var f:() -> Void = step; f(); f(); return n }
  public function sameAs(other:Counter):Boolean { return other.value == value }
  public function later():int {
    var g:() -> int = function():int { step(); return value }
    return g()
  }
  public static function make():Counter { return Counter.fresh() }
  private function step():void { n++ }
  private function get value():int { return n }
  private static function fresh():Counter { return new Counter() }
}
` },
    { path: "Main.xn", text: "public class Main {\n  public function Main() {}\n}\n" },
  ];
  const result = compileProject(sources, { main: "Main" });
  expect(result.diagnostics.hasErrors).toBe(false);
  const js = result.outputs.find((o) => o.path === "Counter.js")!.text;
  expect(js).toContain("#step() {");
  expect(js).toContain("get #value() {");
  expect(js).toContain("static #fresh() {");

  const out = join(import.meta.dir, ".private-methods-out");
  await rm(out, { recursive: true, force: true });
  try {
    for (const o of result.outputs) {
      await mkdir(dirname(join(out, o.path)), { recursive: true });
      await Bun.write(join(out, o.path), o.text);
    }
    await Bun.write(join(out, "consumer.mjs"), `import { Counter } from './Counter.js';
const c = Counter.make();
console.log(c.bump(), c.twice(), c.later(), c.sameAs(c), typeof c.step, c.value, typeof Counter.fresh, Object.getOwnPropertyNames(Counter.prototype).sort().join());
`);
    const proc = Bun.spawn(["bun", join(out, "consumer.mjs")], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect(stderr).toBe("");
    expect(stdout).toBe("1 3 4 true undefined undefined undefined bump,constructor,later,sameAs,twice\n");
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
