/** `Record<String, V>`: a plain object used as a dictionary; `Record<'a' | 'b', V>` is a shape. */
import { afterAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Window } from "happy-dom";
import { compileProject } from "../src/compiler.ts";
import { typeCheck } from "./tsemit.ts";

const errors = (r: ReturnType<typeof compileProject>) => r.diagnostics.items.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.labels.find((l) => l.primary)!.message}`);

const code = `typedef Point = { x:Int, y:Int }

public class Main {
  public function Main() {}

  public static function ages():Array<String> {
    var ages:Record<String, Int> = { ann: 31, bob: 40 }
    ages['carl'] = 22
    ages.dora = 5
    var out:Array<String> = []
    for (var [name, age] of Object.entries(ages)) out.push($'{name}={age + 1}')
    var missing:Int = ages['nobody'] ?? -1
    var bob:Int = ages.bob ?? 0
    out.push($'{missing},{bob},{Object.values(ages).length}')
    return out
  }

  /** A shape whose members are all \`Int\`s is a \`Record<String, Int>\`; \`Object.values\` of it is typed. */
  public static function sum(p:Point):Int {
    var r:Record<String, Int> = p
    var total:Int = 0
    for (var v:Int of Object.values(p)) total += v
    return total + (r['x'] ?? 0)
  }

  /** Literal keys: the shape \`{ id:String, name:String }\`. */
  public static function fixed():String {
    var f:Record<'id' | 'name', String> = { id: '1', name: 'one' }
    return f.id + f.name
  }

  /** \`dataset\` is a \`DOMStringMap\` = \`Record<String, String>\`. */
  public static function data(el:HTMLElement):String {
    el.dataset.userId = '7'
    return (el.dataset['userId'] ?? '-') + (el.dataset.nothing ?? '-')
  }
}
`;

test("a Record reads V?, writes V, takes any keys in a literal, and runs as a plain object", async () => {
  const result = compileProject([{ path: "Main.xn", text: code }], { main: "Main" });
  expect(errors(result)).toEqual([]);
  const js = result.outputs.find((o) => o.path === "Main.js")!.text;
  const Main = new Function(`${js.replace(/^export /m, "").replace(/\/\/# sourceMappingURL.*$/m, "")}; return Main;`)();
  expect(Main.ages()).toEqual(["ann=32", "bob=41", "carl=23", "dora=6", "-1,40,4"]);
  expect(Main.sum({ x: 2, y: 3 })).toBe(7);
  expect(Main.fixed()).toBe("1one");
  const window = new Window();
  try {
    const el = window.document.createElement("div");
    expect(Main.data(el)).toBe("7-");
    expect(el.getAttribute("data-user-id")).toBe("7");
  } finally {
    await window.happyDOM.close();
  }
});

test("Record misuse is reported", () => {
  const bad = `public class Main {
  public function Main() {
    var ages:Record<String, Int> = { ann: 31, bob: 'forty' }
    ages['x'] = 'no'
    var n:Int = ages['ann']
    var k:Record<Int, String>
    var wrong = ages[1]
    var f:Record<'id', String> = { id: '1', other: '2' }
    var one:Record<String>
    trace(n, k, wrong, f, one)
  }
}
`;
  expect(errors(compileProject([{ path: "Main.xn", text: bad }], { main: "Main" }))).toEqual([
    "X0308 expected `Int`, found `String`",
    "X0308 expected `Int`, found `String`",
    "X0308 expected `Int`, found `Int?`",
    "X0882 a key is `String` or string literals",
    "X0308 a `Record` key is a `String`, found `Int`",
    "X0791 unknown member",
    "X0422 1 given",
  ]);
});

test("the TypeScript output of records type-checks", () => {
  const result = compileProject([{ path: "Main.xn", text: code }], { main: "Main", target: "ts" });
  expect(errors(result)).toEqual([]);
  expect(result.outputs.find((o) => o.path === "Main.ts")!.text).toContain("Record<string, number>");
  expect(typeCheck(result.outputs, join(import.meta.dir, ".record-ts"))).toEqual([]);
});

afterAll(() => rm(join(import.meta.dir, ".record-ts"), { recursive: true, force: true }));

test("Object.entries of a shape without members (a `.d.ts` type of only an index signature) gives `*` values", () => {
  const text = `typedef Sheet = { }
public class Main {
  public function Main() {}
  public static function cells(sheet:Sheet):Int {
    var n:Int = 0
    for (var [address, cell]:Tuple<String, Int> of Object.entries(sheet)) n += cell + address.length
    return n
  }
}
`;
  expect(errors(compileProject([{ path: "Main.xn", text }], { main: "Main" }))).toEqual([]);
});
