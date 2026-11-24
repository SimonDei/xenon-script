/** Properties with accessors: `var label:String = '' { get => …; set => … }`. */
import { afterAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { compileProject } from "../src/compiler.ts";
import { typeCheck } from "./tsemit.ts";

const out = join(import.meta.dir, ".properties-out");
afterAll(() => Promise.all([rm(out, { recursive: true, force: true }), rm(join(import.meta.dir, ".properties-ts"), { recursive: true, force: true })]));
const errors = (r: ReturnType<typeof compileProject>) => r.diagnostics.items.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.message}`);

const code = `interface INamed {
  function get name():String
}

class Person implements INamed {
  public var first:String = ''
  public var last:String = ''

  /** \\\`value\\\` is the new value; inside its accessors \\\`label\\\` is the storage. */
  public var label:String = '' {
    set => label = value.trim()
  }

  public var age:Int = 0 {
    set => {
      if (value < 0) throw new ArgumentException(nameof(value))
      age = value
    }
  }

  /** Both accessors, computed from other fields: no storage. */
  public var fullName:String {
    get => $'{first} {last}'
    set => {
      var parts = value.split(' ')
      first = parts[0]
      last = parts.slice(1).join(' ')
    }
  }

  /** Only a getter: assignments write the storage. */
  public var shout:String = 'hi' {
    get => shout.toUpperCase()
  }

  /** Implements the interface's getter. */
  public var name:String = 'anon' { set => name = value.toLowerCase() }

  public static var created:Int = 0 { set => created = value < 0 ? 0 : value }

  public function Person() { created = created + 1 }
}

public class Main {
  public function Main() {}

  public static function run():Array<String> {
    var p:Person = new Person()
    p.label = '  Ann  '
    p.age = 31
    p.fullName = 'Ann Lee Smith'
    p.shout = 'hey'
    p.name = 'ANN'
    var failed:String = '-'
    try { p.age = -1 } catch (e) { failed = e.message }
    Person.created = -5
    var named:INamed = p
    return [$'[{p.label}] {p.age} {failed}', $'{p.first}/{p.last} {p.fullName} {p.shout}', $'{named.name} {Person.created}']
  }
}
`;

test("accessors with `value` and the property's name as its storage; a missing half uses the storage", async () => {
  const result = compileProject([{ path: "Main.xn", text: code }], { main: "Main" });
  expect(errors(result)).toEqual([]);
  const js = result.outputs.find((o) => o.path === "Main.js")!.text;
  expect(js).toContain("#$label = '';");
  expect(js).not.toContain("#$fullName"); // both accessors, no storage used: none generated
  for (const o of result.outputs) await Bun.write(join(out, o.path), o.text);
  const { Main } = await import(join(out, "Main.js"));
  expect(Main.run()).toEqual(["[Ann] 31 value", "Ann/Lee Smith Ann Lee Smith HEY", "ann 0"]);
});

test("property mistakes are reported", () => {
  const bad = `class Bad {
  public var a:String = 'x' {
    get => 'a'
    set => trace(value)
  }
  public var b = 1 { set => b = value }
  public final c:Int = 1 { get => c }
  public var d:String {
    set => d = value
  }
  public var e:Int = 0 { get => 1; get => 2 }
  public function Bad() {}
}
public class Main { public function Main() {} }
`;
  expect(errors(compileProject([{ path: "Main.xn", text: bad }], { main: "Main" }))).toEqual([
    "X0886 `a` has no storage, so its initial value is never used",
    "X0886 the property `b` needs a type",
    "X0886 a property with `get`/`set` is declared with `var`",
    "X0201 `e` has two `get`s",
    "X0819 property `d` needs a value: `String` can't be null",
  ]);
});

test("the TypeScript output of properties type-checks", () => {
  const result = compileProject([{ path: "Main.xn", text: code }], { main: "Main", target: "ts" });
  expect(errors(result)).toEqual([]);
  expect(typeCheck(result.outputs, join(import.meta.dir, ".properties-ts"))).toEqual([]);
});
