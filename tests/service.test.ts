/** The language service: diagnostics, hover, go-to-definition and completion on an in-memory project. */
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { XenonProject } from "../src/service.ts";

const ANIMAL = `package zoo {
  /** Something that lives in the zoo. */
  public class Animal {
    /** How the animal is called. */
    public var name:String
    private var secret:int = 1
    protected var age:int = 0
    public static var count:int = 0
    public function Animal(name:String) { this.name = name }
    /** Makes a sound, \`times\` times. */
    public function speak(times:int = 1):String { return name + secret }
    public static function create():Animal { return new Animal('x') }
  }
}
`;
const MAIN = `import zoo.Animal
import { readFileSync } from 'node:fs'
import * as path from 'node:path'

public class Main {
  public function Main() {
    var a:Animal = new Animal('rex')
    var scores:Map<String, int> = new Map()
    var n:int = readFileSync('Main.xn', 'utf8')
    trace(a.speak(2), scores.get('a'), n, path.basename('x/y'))
  }
}
`;

/** A project in memory; its root is inside the repository, so TypeScript finds `node_modules`. */
function project(files: Record<string, string>): XenonProject {
  const p = new XenonProject(join(import.meta.dir, ".service-project", "src"));
  for (const [path, text] of Object.entries(files)) p.set(path, text);
  return p;
}

const offset = (text: string, needle: string, delta = 0) => {
  const i = text.indexOf(needle);
  if (i < 0) throw new Error(`not found: ${needle}`);
  return i + delta;
};

test("diagnostics: Xenon's, plus TypeScript's where Xenon only knows `*`", () => {
  const p = project({ "zoo/Animal.xn": ANIMAL, "Main.xn": MAIN });
  const diags = p.diagnostics();
  expect(diags.get("zoo/Animal.xn")).toEqual([]);
  const main = diags.get("Main.xn")!;
  expect(main.map((d) => [d.source, d.code])).toEqual([["typescript", "TS2322"]]);
  // `var n:int = readFileSync(…)`: the error sits on `n`.
  expect(main[0]!.range).toEqual({ start: { line: 8, character: 8 }, end: { line: 8, character: 9 } });
  expect(main[0]!.message).toContain("not assignable to type 'number'");

  // A Xenon error: reported once, with its notes and help, and TypeScript stays quiet about the same spot.
  p.set("Main.xn", MAIN.replace("a.speak(2)", "a.speak('2')"));
  const broken = p.diagnostics().get("Main.xn")!;
  expect(broken.map((d) => [d.source, d.code])).toEqual([["xenon", "X0308"], ["typescript", "TS2322"]]);
  expect(broken[0]!.range.start).toEqual({ line: 9, character: 18 }); // the argument `'2'`
});

test("hover shows Xenon types and documentation; TypeScript's for JavaScript imports", () => {
  const p = project({ "zoo/Animal.xn": ANIMAL, "Main.xn": MAIN });
  const hover = (needle: string, delta = 0) => p.hover("Main.xn", offset(MAIN, needle, delta))?.contents;
  expect(hover("a.speak", 3)).toBe("```xenon\nfunction Animal.speak(times?:int):String\n```\n\nMakes a sound, `times` times.");
  expect(hover("a.speak", 0)).toBe("```xenon\na:Animal\n```");
  expect(hover("scores.get", 7)).toBe("```xenon\nfunction Map.get(key:String):int?\n```\n\nThe value for `key`, or `null` if there is none.");
  expect(hover("new Animal", 5)).toBe("```xenon\nclass zoo.Animal\n```\n\nSomething that lives in the zoo.");
  expect(hover("var a:Animal", 7)).toBe("```xenon\nclass zoo.Animal\n```\n\nSomething that lives in the zoo.");
  expect(hover("path.basename", 6)).toStartWith("```typescript\nfunction path.basename(path: string, suffix?: string): string\n```");
  expect(p.hover("zoo/Animal.xn", offset(ANIMAL, "var name", 5))?.contents).toBe("```xenon\nvar Animal.name:String\n```\n\nHow the animal is called.");
});

test("hover still works while another file has errors", () => {
  const p = project({ "zoo/Animal.xn": ANIMAL.replace("return name + secret }", "return nme + secret }"), "Main.xn": MAIN });
  expect(p.diagnostics().get("zoo/Animal.xn")!.map((d) => d.code)).toEqual(["X0425"]);
  expect(p.hover("Main.xn", offset(MAIN, "a.speak", 3))?.contents).toContain("function Animal.speak");
});

test("go to definition: Xenon declarations, the standard library and `.d.ts` files", () => {
  const p = project({ "zoo/Animal.xn": ANIMAL, "Main.xn": MAIN });
  const def = (needle: string, delta = 0) => p.definition("Main.xn", offset(MAIN, needle, delta));
  const [speak] = def("a.speak", 3);
  expect(speak!.path).toEndWith("/.service-project/src/zoo/Animal.xn");
  expect(speak!.range.start).toEqual({ line: 10, character: 20 });
  const [local] = def("a.speak", 0);
  expect(local!.path).toEndWith("/.service-project/src/Main.xn");
  expect(local!.range.start).toEqual({ line: 6, character: 8 });
  // The standard library's source is written out so the editor can open it.
  const [get] = def("scores.get", 7);
  expect(existsSync(get!.path)).toBe(true);
  expect(readFileSync(get!.path, "utf8").split("\n")[get!.range.start.line]).toContain("function get(key:K):V?");
  const [basename] = def("path.basename", 6);
  expect(basename!.path).toEndWith("node_modules/@types/node/path.d.ts");
});

test("completion: members after a dot, scope names elsewhere", () => {
  const p = project({ "zoo/Animal.xn": ANIMAL, "Main.xn": MAIN });
  const complete = (text: string, at: number) => {
    p.set("Main.xn", text);
    return p.completions("Main.xn", at);
  };
  const insert = (code: string) => {
    const i = offset(MAIN, "    trace(");
    return complete(MAIN.slice(0, i) + `    ${code}\n` + MAIN.slice(i), i + 4 + code.length);
  };
  const labels = (items: { label: string }[]) => items.map((i) => i.label);

  // An instance: public members only (and Object's), with Xenon signatures.
  const animal = insert("a.");
  expect(labels(animal)).toEqual(["name", "speak", "toString", "toLocaleString", "valueOf", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable"]);
  expect(animal.find((i) => i.label === "speak")!.detail).toBe("function Animal.speak(times?:int):String");
  expect(labels(insert("Animal."))).toEqual(["count", "create"]);
  expect(labels(insert("scores.ge"))).toContain("get");
  // `*` to Xenon: TypeScript's members.
  expect(labels(insert("path."))).toContain("basename");

  const scope = labels(insert(""));
  expect(scope.slice(0, 3)).toEqual(["a", "scores", "n"]); // locals declared before the cursor
  expect(scope).toEqual(expect.arrayContaining(["Animal", "Main", "Exception", "Map", "setTimeout", "readFileSync", "path", "trace", "while"]));
});
