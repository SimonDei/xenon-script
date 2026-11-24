/** The language service: diagnostics, hover, go-to-definition and completion on an in-memory project. */
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compileProject } from "../src/compiler.ts";
import { XenonProject, isTypePosition } from "../src/service.ts";

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
    var n:String = readFileSync(true, 'utf8')
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

test("comprehension bindings are completed only after their source", () => {
  const text = `public class Main {
  public function Main() {}
  public static function f(xs:Array<Int>):Void {
    var values = [for (outer of xs) for (inner of [outer]) inner + outer]
    trace(values)
  }
}`;
  const p = project({ "Main.xn": text });
  const inSource = p.completions("Main.xn", text.indexOf("[outer]") + 2);
  expect(inSource.some((item) => item.label === "outer" && item.detail === "outer:Int")).toBe(true);
  expect(inSource.some((item) => item.label === "inner")).toBe(false);
  const inValue = p.completions("Main.xn", text.indexOf("inner + outer") + 2);
  expect(inValue.some((item) => item.label === "outer" && item.detail === "outer:Int")).toBe(true);
  expect(inValue.some((item) => item.label === "inner" && item.detail === "inner:Int")).toBe(true);
  const after = p.completions("Main.xn", text.indexOf("trace(values)") + 1);
  expect(after.some((item) => item.label === "outer" || item.label === "inner")).toBe(false);
});

const offset = (text: string, needle: string, delta = 0) => {
  const i = text.indexOf(needle);
  if (i < 0) throw new Error(`not found: ${needle}`);
  return i + delta;
};

test("diagnostics: Xenon's (JavaScript imports typed from their `.d.ts`), plus TypeScript's where Xenon only knows `*`", () => {
  const p = project({ "zoo/Animal.xn": ANIMAL, "Main.xn": MAIN });
  const diags = p.diagnostics();
  expect(diags.get("zoo/Animal.xn")).toEqual([]);
  const main = diags.get("Main.xn")!;
  // `readFileSync`'s `path` is a union (`Float | PathLike`): Xenon itself finds no overload taking `true`.
  expect(main.map((d) => [d.source, d.code, d.range.start.character])).toEqual([["xenon", "X0604", 19]]);

  // Where Xenon only knows `*` (`once`'s `eventName` is a `string | symbol`; symbols have no Xenon type), TypeScript's error.
  p.set("Main.xn", `import { once, EventEmitter } from 'node:events'\n${MAIN}`.replace("var n:String = readFileSync(true, 'utf8')", "var n:* = once(new EventEmitter(), true)"));
  expect(p.diagnostics().get("Main.xn")!.filter((d) => d.source === "typescript").map((d) => d.code)).toEqual(["TS2769"]);

  // Typed from the `.d.ts`, Xenon itself sees that the result is a `String`; TypeScript stays quiet on that line.
  p.set("Main.xn", MAIN.replace("var n:String = readFileSync(true, 'utf8')", "var n:Int = readFileSync('Main.xn', 'utf8')"));
  expect(p.diagnostics().get("Main.xn")!.map((d) => [d.source, d.code, d.range.start.character])).toEqual([["xenon", "X0308", 16]]);

  // A Xenon error: reported once, with its notes and help, and TypeScript stays quiet about the same spot.
  p.set("Main.xn", MAIN.replace("a.speak(2)", "a.speak('2')"));
  const broken = p.diagnostics().get("Main.xn")!;
  expect(broken.map((d) => [d.source, d.code])).toEqual([["xenon", "X0604"], ["xenon", "X0308"]]);
  expect(broken[1]!.range.start).toEqual({ line: 9, character: 18 }); // the argument `'2'`
});

test("hover shows Xenon types and documentation, also for JavaScript imports (from their `.d.ts`)", () => {
  const p = project({ "zoo/Animal.xn": ANIMAL, "Main.xn": MAIN });
  const hover = (needle: string, delta = 0) => p.hover("Main.xn", offset(MAIN, needle, delta))?.contents;
  expect(hover("a.speak", 3)).toBe("```xenon\nfunction Animal.speak(times?:Int):String\n```\n\nMakes a sound, `times` times.");
  expect(hover("a.speak", 0)).toBe("```xenon\na:Animal\n```");
  expect(hover("scores.get", 7)).toBe("```xenon\nfunction Map.get(key:String):Int?\n```\n\nThe value for `key`, or `null` if there is none.");
  expect(hover("new Animal", 5)).toBe("```xenon\nclass zoo.Animal\n```\n\nSomething that lives in the zoo.");
  expect(hover("var a:Animal", 7)).toBe("```xenon\nclass zoo.Animal\n```\n\nSomething that lives in the zoo.");
  expect(hover("path.basename", 6)).toStartWith("```xenon\nfunction path.basename(path:String, suffix?:String):String\n```\n\nReturn the last portion of a path.");
  // Imported by name: TypeScript's view (with its overloads).
  expect(hover("readFileSync(true", 3)).toStartWith("```typescript\n(alias) readFileSync");
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
  expect(animal.find((i) => i.label === "speak")!.detail).toBe("function Animal.speak(times?:Int):String");
  expect(labels(insert("Animal."))).toEqual(["count", "create"]);
  expect(labels(insert("Animal::"))).toEqual(expect.arrayContaining(["name", "speak"]));
  expect(labels(insert("Animal::"))).not.toContain("create");
  expect(labels(insert("scores.ge"))).toContain("get");
  // `*` to Xenon: TypeScript's members.
  expect(labels(insert("path."))).toContain("basename");

  const scope = labels(insert(""));
  expect(scope.slice(0, 3)).toEqual(["a", "scores", "n"]); // locals declared before the cursor
  expect(scope).toEqual(expect.arrayContaining(["Animal", "Main", "Exception", "Map", "setTimeout", "readFileSync", "path", "document", "trace", "while", "defer", "operator", "nameof", "consteval"]));
});

test("Symbol creates typed primitive values and exposes well-known symbols", () => {
  const result = compileProject([{ path: "Main.xn", text: `public class Main {
  public function Main() {
    var token:Symbol = Symbol('token')
    trace(token.description, token.toString(), Symbol.for('key') is Symbol)
    trace(Symbol.iterator, Symbol.dispose, Symbol.keyFor(Symbol.for('key')))
  }
}
` }], { main: "Main", target: "js" });
  expect(result.diagnostics.items.filter((d) => d.severity === "error").map((d) => [d.code, d.message])).toEqual([]);
  const js = result.outputs.find((o) => o.path === "Main.js")!.text;
  expect(js).toContain("typeof Symbol");
});

test("new Symbol is rejected", () => {
  const result = compileProject([{ path: "Main.xn", text: "public class Main { public function Main() { var value:* = new Symbol() } }\n" }], { main: "Main" });
  expect(result.diagnostics.items.filter((d) => d.severity === "error").map((d) => [d.code, d.message])).toEqual([
    ["X0415", "`Symbol` can't be instantiated with `new`"],
  ]);
});

test("a static class cannot be instantiated", () => {
  const result = compileProject([
    { path: "State.xn", text: "public static final class State {}\n" },
    { path: "Main.xn", text: `public class Main {
  public function Main() {
    var state = new State()
  }
}
` },
  ], { main: "Main" });
  expect(result.diagnostics.items.filter((d) => d.severity === "error").map((d) => [d.code, d.message])).toEqual([
    ["X0415", "static class `State` can't be instantiated"],
  ]);
});

test("an iterable can implement the JavaScript Symbol.iterator protocol directly", () => {
  const result = compileProject([
    { path: "Numbers.xn", text: `public class Numbers implements Iterable<int> {
  public function [Symbol.iterator]():Iterator<int> => [1, 2].values()
}
` },
    { path: "Main.xn", text: `public class Main {
  public function Main() {
    for (var number:int of new Numbers()) trace(number)
  }
}
` },
  ], { main: "Main" });
  expect(result.diagnostics.items.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
  const js = result.outputs.find((o) => o.path === "Numbers.js" || o.path === "Main.js")?.text ?? result.outputs.map((o) => o.text).join("\n");
  expect(js).toContain("[Symbol.iterator]()");
  expect(js).toContain("return [1, 2].values()");
});

test("class hover shows declaration modifiers", () => {
  const main = "public class Main {\n  public function Main() { trace(State) }\n}\n";
  const p = project({
    "State.xn": "public static final class State {}\n",
    "Main.xn": main,
  });
  expect(p.hover("Main.xn", offset(main, "State", 1))!.contents)
    .toContain("static final class State");
});

test("class hover says when a class is scoped (a destructor without IDisposable)", () => {
  const main = `public class Main {
  public function Main() { trace(Res, Kept) }
}
class Res {
  public function ~Res() {}
}
class Kept implements IDisposable {
  public function dispose():void {}
}
`;
  const p = project({ "Main.xn": main });
  expect(p.hover("Main.xn", offset(main, "Res", 1))!.contents).toContain("scoped class Res");
  expect(p.hover("Main.xn", offset(main, "Kept", 1))!.contents).toContain("\nclass Kept implements IDisposable");
});

test("hovers find doc comments above attributes and show deprecation", () => {
  const main = `public class Main {
  public function Main() { new Page().old() }
}
class Page {
  /** The old way. */
  [Deprecated('use list()')]
  public function old():void {}
}
`;
  const p = project({ "Main.xn": main });
  const hover = p.hover("Main.xn", offset(main, "old()", 1))!.contents;
  expect(hover).toContain("**Deprecated**: use list()");
  expect(hover).toContain("The old way.");
  expect(p.diagnostics().get("Main.xn")!.map((d) => d.code)).toEqual(["X0873"]);
});

test("nameof: references and hover see the name inside (renaming the member updates it)", () => {
  const main = `public class Main {
  public function Main() {
    var user = new User('a')
    trace(nameof(user.email), nameof(User.email), user.email, nameof(User::email), User::email)
  }
}
class User {
  public final email:String
  public function User(email:String) { this.email = email }
}
`;
  const p = project({ "Main.xn": main });
  const lines = p.references("Main.xn", offset(main, "email:String", 1)).map((l) => `${l.range.start.line}:${l.range.start.character}`);
  expect(lines).toEqual(["3:22", "3:42", "3:55", "3:75", "3:89", "7:15", "8:44"]);
  expect(p.hover("Main.xn", offset(main, "User.email", 6))!.contents).toContain("User.email:String");
  expect(p.hover("Main.xn", offset(main, "User::email", 6))!.contents).toContain("User.email:String");
});

test("method hover shows static final and abstract modifiers", () => {
  const main = `public abstract class Base {
  public static final function version():int => 1
  public abstract function load():void
}
`;
  const p = project({ "Main.xn": main });
  expect(p.hover("Main.xn", offset(main, "version", 1))!.contents).toContain("static final function Base.version():Int");
  expect(p.hover("Main.xn", offset(main, "load", 1))!.contents).toContain("abstract function Base.load():Void");
});

test("a static class cannot be used as a field type", () => {
  const result = compileProject([
    { path: "State.xn", text: "public static final class State {}\n" },
    { path: "Main.xn", text: `public class Main {
  private final state:State;
}
` },
  ], { main: "Main" });
  expect(result.diagnostics.items.filter((d) => d.severity === "error").map((d) => [d.code, d.message])).toEqual([
    ["X0415", "static class `State` can't be used as a value type"],
    ["X0515", "final field `state` is never assigned"],
  ]);
});

test("a static class requires only static members", () => {
  const result = compileProject([{ path: "State.xn", text: `public static class State {
  public var count:int = 0
  public function getNumber():int => 10
  public function State() {}
}
` }], { main: "State" });
  expect(result.diagnostics.items.filter((d) => d.severity === "error").map((d) => [d.code, d.message])).toEqual([
    ["X0415", "field `count` in static class `State` must be `static`"],
    ["X0415", "method `getNumber` in static class `State` must be `static`"],
    ["X0415", "static class `State` can't declare a constructor"],
  ]);
});

const DOG = `package zoo {
  public class Dog extends Animal {
    public function Dog() { super('dog') }
    override public function speak(times:int = 1):String { return 'woof' }
  }
}
`;
const ZOO = `import zoo.Animal
import zoo.Dog

public class Main {
  public function Main() {
    var pets:Array<Animal> = [new Dog(), Animal.create()]
    var label:String = 'pets'
    var info:{ label:String } = { label }
    for (var pet:Animal of pets) trace(pet.speak(2), info.label)
    trace(Math.max(1, 2), new Dog().speak())
  }
}
`;

/** The text each location covers. */
function texts(p: XenonProject, files: Record<string, string>, locations: { path: string; range: { start: { line: number; character: number }; end: { line: number; character: number } } }[]) {
  return locations.map((l) => {
    const rel = l.path.slice(l.path.indexOf("/src/") + 5);
    const lines = files[rel]!.split("\n");
    return `${rel}:${l.range.start.line + 1}:${lines[l.range.start.line]!.slice(l.range.start.character, l.range.end.character)}`;
  });
}

const zooFiles = { "zoo/Animal.xn": ANIMAL, "zoo/Dog.xn": DOG, "Main.xn": ZOO };

test("references: overrides are one symbol; classes in imports, types and `new`", () => {
  const p = project(zooFiles);
  // From the call on an `Animal`: Animal's declaration, Dog's override and both calls.
  const speak = p.references("Main.xn", offset(ZOO, "pet.speak", 5));
  expect(texts(p, zooFiles, speak).sort()).toEqual(["Main.xn:10:speak", "Main.xn:9:speak", "zoo/Animal.xn:11:speak", "zoo/Dog.xn:4:speak"]);
  // From the override: the same set.
  expect(p.references("zoo/Dog.xn", offset(DOG, "speak")).length).toBe(4);
  expect(p.references("Main.xn", offset(ZOO, "pet.speak", 5), false).length).toBe(3);

  const animal = texts(p, zooFiles, p.references("Main.xn", offset(ZOO, "Array<Animal>", 7)));
  expect(animal.sort()).toEqual([
    "Main.xn:1:Animal", "Main.xn:6:Animal", "Main.xn:6:Animal", "Main.xn:9:Animal",
    "zoo/Animal.xn:3:Animal", "zoo/Animal.xn:12:Animal", "zoo/Animal.xn:12:Animal", "zoo/Animal.xn:9:Animal", "zoo/Dog.xn:2:Animal",
  ].sort());
});

test("rename: locals (shorthand properties keep their key), members, classes with their file", () => {
  const p = project(zooFiles);
  const edits = (r: ReturnType<XenonProject["rename"]>) => {
    if ("error" in r) throw new Error(r.error);
    return [...r.changes].flatMap(([path, es]) => es.map((e) => `${path.slice(path.indexOf("/src/") + 5)}:${e.range.start.line + 1}:${e.newText}`)).sort();
  };
  expect(edits(p.rename("Main.xn", offset(ZOO, "var label", 4), "title"))).toEqual(["Main.xn:7:title", "Main.xn:8:label: title"]);
  expect(edits(p.rename("zoo/Animal.xn", offset(ANIMAL, "function speak", 9), "talk"))).toEqual(["Main.xn:10:talk", "Main.xn:9:talk", "zoo/Animal.xn:11:talk", "zoo/Dog.xn:4:talk"]);

  const cls = p.rename("Main.xn", offset(ZOO, "new Dog", 4), "Puppy");
  expect(edits(cls)).toEqual(["Main.xn:10:Puppy", "Main.xn:2:Puppy", "Main.xn:6:Puppy", "zoo/Dog.xn:2:Puppy", "zoo/Dog.xn:3:Puppy"]);
  expect("renames" in cls && cls.renames.map((r) => [r.from.slice(r.from.indexOf("/src/")), r.to.slice(r.to.indexOf("/src/"))])).toEqual([["/src/zoo/Dog.xn", "/src/zoo/Puppy.xn"]]);

  // The standard library and invalid names are refused.
  expect(p.prepareRename("Main.xn", offset(ZOO, "Math.max", 6))).toEqual({ error: "`max` is part of the standard library." });
  expect(p.prepareRename("zoo/Animal.xn", offset(ANIMAL, "name:String", 1))).toMatchObject({ placeholder: "name" });
  expect(p.rename("Main.xn", offset(ZOO, "var label", 4), "class")).toEqual({ error: "`class` isn't a valid name." });
});

test("signature help: parameters, the active argument, overloads", () => {
  const p = project(zooFiles);
  const help = (text: string, at: number) => {
    p.set("Main.xn", text);
    return p.signatureHelp("Main.xn", at);
  };
  const speak = help(ZOO, offset(ZOO, "pet.speak(", 10));
  expect(speak).toEqual({
    signatures: [{ label: "speak(times?:Int):String", documentation: "Makes a sound, `times` times.", parameters: [{ label: [6, 16] }] }],
    activeSignature: 0,
    activeParameter: 0,
  });
  // The second argument of `Math.max(1, 2)` (a rest parameter).
  const max = help(ZOO, offset(ZOO, "Math.max(1, ", 12))!;
  expect(max.signatures[0]!.label).toBe("max(...values:Array<Float>):Float");
  expect(max.activeParameter).toBe(0);
  // `new Dog(` and, right after a comma with nothing typed yet, still the call.
  expect(help(ZOO, offset(ZOO, "new Dog()", 8))!.signatures[0]!.label).toBe("new Dog():Void");
  const typing = ZOO.replace("Math.max(1, 2)", "scores(1, )").replace("public function Main() {", "public function Main() {\n    var scores:(a:Int, b:String) -> Void = (a:Int, b:String):Void => {}");
  const second = help(typing, offset(typing, "scores(1, ", 10))!;
  expect([second.signatures[0]!.label, second.activeParameter]).toEqual(["scores(a:Int, b:String):Void", 1]);
});

test("document symbols: classes with their members", () => {
  const p = project(zooFiles);
  const outline = p.documentSymbols("zoo/Animal.xn");
  expect(outline.map((s) => [s.name, s.kind])).toEqual([["Animal", "class"]]);
  expect(outline[0]!.children.map((c) => `${c.kind} ${c.name}${c.detail ? " " + c.detail : ""}`)).toEqual([
    "field name String", "field secret Int", "field age Int", "field count Int",
    "constructor constructor", "method speak (times?:Int):String", "method create ():Animal",
  ]);
  expect(outline[0]!.selectionRange.start).toEqual({ line: 2, character: 15 });
});

test("quick fixes come from the checker's suggestions", () => {
  const p = project({ ...zooFiles, "Main.xn": ZOO.replace("trace(Math.max(1, 2)", "trace(1 === 1, Math.max(1, 2)") });
  const d = p.diagnostics().get("Main.xn")!.find((x) => x.code === "X0841")!;
  expect(d.fixes.map((f) => [f.title, f.edits.flatMap((e) => e.edits.map((x) => x.newText))])).toEqual([["use ==", ["=="]]]);
});

test("shapes: completion, hover and definition of a typedef's members", () => {
  const text = `typedef Mail = {
  /** Who receives it. */
  to:String,
  ?subject:String,
  final id:int
}

public class Main {
  public function Main() {}
  public function send(mail:Mail, maybe:Mail?):void {
    trace(mail.to, maybe?.subject)
  }
}
`;
  const p = project({ "Main.xn": text });
  // After the dot, also inside an unfinished call (`f(mail.)`).
  const at = offset(text, "trace(mail.") + "trace(mail.".length;
  const unfinished = text.replace("trace(mail.to, maybe?.subject)", "trace(mail.)");
  p.set("Main.xn", unfinished);
  const items = p.completions("Main.xn", offset(unfinished, "trace(mail.") + "trace(mail.".length);
  expect(items.map((i) => [i.label, i.detail, i.documentation])).toEqual([
    ["to", "to:String", "Who receives it."],
    ["subject", "?subject:String", undefined],
    ["id", "final id:Int", undefined],
  ]);
  p.set("Main.xn", text);
  expect(p.completions("Main.xn", offset(text, "maybe?.") + "maybe?.".length).map((i) => i.label)).toEqual(["to", "subject", "id"]);
  expect(p.hover("Main.xn", at)).toMatchObject({ contents: "```xenon\nMail.to:String\n```\n\nWho receives it." });
  const [def] = p.definition("Main.xn", at);
  expect(def).toMatchObject({ range: { start: { line: 2, character: 2 } } });
});

test("hover and definition on a call of an overloaded method: the overload it chose", () => {
  const text = `public class Main {
  public function Main() {
    var form:FormData = new FormData()
    form.append('a', 'text')
    form.append('b', new File([], 'x'), 'name.txt')
    Promise.resolve(1).then(n => 'x' + n)
  }
}
`;
  const p = project({ "Main.xn": text });
  // The cursor on the method name: 7 characters into `form.append…`, 2 into `.then`.
  const hover = (needle: string) => (p.hover("Main.xn", offset(text, needle, needle.startsWith(".") ? 2 : 7))?.contents as string).split("\n");
  expect(hover("form.append('a")[1]).toBe("function FormData.append(name:String, value:String):Void");
  // The 3-parameter overload, documented by the comment above the overload group it belongs to.
  const file = hover("form.append('b");
  expect(file[1]).toBe("function FormData.append(name:String, value:Blob, fileName:String):Void");
  expect(file.at(-1)).toStartWith("Adds a file under `name`");
  // Generic overloads as called.
  expect(hover(".then")[1]).toBe("function Promise.then(onFulfilled:(value:Int) -> String):Promise<String>");
  const [a] = p.definition("Main.xn", offset(text, "form.append('a", 7));
  const [b] = p.definition("Main.xn", offset(text, "form.append('b", 7));
  expect(a!.range.start.line).toBeLessThan(b!.range.start.line);
});

test("while typing: completion and signature help in a statement that doesn't parse yet; overloaded functions", () => {
  const at = (text: string, needle: string) => offset(text, needle, needle.length);
  const body = (code: string) => `public class Main {\n  public async function run():Promise<void> {\n    var res:Response = await fetch('x')\n    ${code}\n  }\n}\n`;
  const p = project({});
  // `if (!res.)` has no body yet: the parser drops the statement, so `res.` is completed on its own.
  for (const code of ["if (!res.)", "if (!res.", "trace(res?.)"]) {
    const text = body(code);
    p.set("Main.xn", text);
    expect(p.completions("Main.xn", at(text, code.includes("?.") ? "res?." : "res.")).map((i) => i.label).slice(0, 3)).toEqual(["ok", "status", "statusText"]);
  }
  // `fetch` is an overloaded function: both signatures, the one with options active after the comma.
  for (const code of ["fetch('x', )", "if (fetch('x', ))"]) {
    const text = body(code);
    p.set("Main.xn", text);
    const help = p.signatureHelp("Main.xn", at(text, "fetch('x', "))!;
    expect(help.signatures.map((s) => s.label)).toEqual(["fetch(url:String):Promise<Response>", "fetch(url:String, options:RequestInit):Promise<Response>"]);
    expect([help.activeSignature, help.activeParameter]).toEqual([1, 1]);
  }
  const text = body("fetch('y', { method: 'POST' })");
  p.set("Main.xn", text);
  expect((p.hover("Main.xn", offset(text, "fetch('y'", 2))?.contents as string).split("\n")[1]).toBe("function fetch(url:String, options:RequestInit):Promise<Response>");
});

test("completion after a namespace import's `.` in a type lists its exported types; in code, its values", () => {
  const text = "import * as path from 'node:path'\n\npublic class Main {\n  public function Main() {\n    var p:path.Par\n    trace(path.)\n  }\n}\n";
  const p = project({ "Main.xn": text });
  const types = p.completions("Main.xn", offset(text, "path.Par", 8));
  expect(types.map((i) => i.label).sort()).toEqual(["FormatInputPathObject", "ParsedPath"]);
  expect(types.find((i) => i.label === "ParsedPath")!.detail).toBe("typedef path.ParsedPath");
  // As a value, `path.` has the functions (`join`), not the types.
  const values = p.completions("Main.xn", offset(text, "trace(path.", 11)).map((i) => i.label);
  expect(values).toContain("join");
  expect(values).not.toContain("ParsedPath");
});

test("completion of an object literal's keys offers the expected shape's members not given yet", () => {
  const text = `typedef Pos = { x:int, y:int }
typedef Row = { ?note:String, excelRow:int, pos:Pos }

public class Main {
  public function Main() {
    var rows:Array<Row> = []
    rows.push({  })
    rows.push({ excelRow: 1,  })
    rows.push({ ex })
    var r:Row? = { excelRow: 2, pos: {  }, note: f(1,  ) }
    trace(rows, r)
  }
  private function f(a:int, b:int):String => ''
}
`;
  const p = project({ "Main.xn": text });
  const at = (needle: string, delta: number) => p.completions("Main.xn", offset(text, needle, delta));
  const sorted = (items: { label: string; sortText?: string }[]) => [...items].sort((x, y) => (x.sortText ?? x.label).localeCompare(y.sortText ?? y.label)).map((i) => i.label);
  // Required members first, then optional ones.
  expect(sorted(at("push({  })", 7))).toEqual(["excelRow", "pos", "note"]);
  expect(sorted(at("excelRow: 1,  ", 13))).toEqual(["pos", "note"]);
  expect(sorted(at("{ ex }", 4))).toEqual(["excelRow", "pos", "note"]);
  // A nested literal has its member's shape; a value position (a call's argument) is ordinary code.
  expect(sorted(at("pos: {  }", 7))).toEqual(["x", "y"]);
  expect(at("f(1,  )", 5).map((i) => i.label)).toContain("rows");
  expect(at("{ excelRow: 2", 2)[0]!.detail).toBe("excelRow:Int");
});

test("in a type annotation, completion lists types only: typedefs too, type parameters and namespace imports", () => {
  const text = `import * as path from 'node:path'

typedef Column = { key:String, index:int }

public class Main {
  public function Main() {
    var columns:Array<Column> = []
    for (var c:Co) {
    }
  }
  private function first<T>(items:Array<T>, fallback:T):T => items[0] ?? fallback
}
`;
  const p = project({ "Main.xn": text });
  const labels = p.completions("Main.xn", offset(text, "var c:Co", 8)).map((i) => i.label);
  expect(labels).toContain("Column");
  expect(labels).toContain("PromiseSettledResult"); // the prelude's typedefs
  expect(labels).toContain("path");                 // for `path.ParsedPath`
  expect(labels).not.toContain("columns");          // a local: a value, not a type
  expect(labels).not.toContain("trace");
  const column = p.completions("Main.xn", offset(text, "var c:Co", 8)).find((i) => i.label === "Column")!;
  expect([column.kind, column.detail]).toEqual(["typedef", "typedef Column = { key:String, index:int }"]);
  // A method's type parameters, in its parameter list.
  expect(p.completions("Main.xn", offset(text, "fallback:T", 10)).map((i) => i.label)).toContain("T");
});

test("type positions: annotations, parameters, return types; not object literal values or `? :`", () => {
  const at = (code: string) => isTypePosition(code, code.length);
  expect([at("var c:"), at("const N:"), at("function f(a:Int, b:"), at("function f(...rest:"), at("function f():"), at("x as "), at("x is "), at("new "), at("Array<"), at("(a:Int) -> "), at("class A extends ")])
    .toEqual([true, true, true, true, true, true, true, true, true, true, true]);
  // Shapes: in a typedef (members on their own lines, optional, final, nested) and in an annotation.
  expect([at("typedef Sheet = {\n  columns:"), at("typedef P<T> = { ?x:"), at("typedef A = { final id:Int, b:"), at("typedef A = { b:{ c:"), at("var p:{ x:"), at("f(a:Array<{ x:")])
    .toEqual([true, true, true, true, true, true]);
  expect([at("var o = { a: 1, b: "), at("f({ key: "), at("var x = ok ? a : "), at("f(a, b"), at("var o:P = { a: "), at("typedef A = { b:Int }\nvar o = { c: ")])
    .toEqual([false, false, false, false, false, false]);
  // Further type arguments: `Tuple<String, |`, also nested and in a pattern's annotation; not a comparison.
  expect([at("for (var [a, c]:Tuple<String, "), at("var m:Map<String, Array<Int>, "), at("var m:Map<Tuple<Int, Int>, ")]).toEqual([true, true, true]);
  expect([at("f(a < b, "), at("if (x < 3, ")]).toEqual([false, false]);
});

test("hover shows the standard library's constexpr members and inline constants as declared", () => {
  const text = "public class Main {\n  public function Main() {\n    var s:String = String(1)\n    trace(s.trim(), Math.floor(1.5), s.length, Math.PI, s.split(','), s.replace('a', 'b'))\n  }\n}\n";
  const p = project({ "Main.xn": text });
  const first = (needle: string) => (p.hover("Main.xn", offset(text, needle, 1))!.contents as string).split("\n")[1];
  expect(first("trim")).toBe("constexpr function String.trim():String");
  expect(first("floor")).toBe("static constexpr function Math.floor(x:Float):Float");
  expect(first("length")).toBe("constexpr function get String.length():Int");
  expect(first("PI")).toBe("static inline const Math.PI:Float");
  expect(first("split")).toBe("function String.split(separator:String):Array<String>");
  expect(first("replace")).toBe("constexpr function String.replace(pattern:String, replacement:String):String");
});

test("hover on an object literal's key shows the expected shape's member; go to definition reaches it", () => {
  const text = `typedef Row = {
  /** The row in the sheet, from 1. */
  excelRow:int,
  data:*
}

public class Main {
  public function Main() {
    var rows:Array<Row> = []
    var data:* = {}
    rows.push({ excelRow: 2, data })
    var loose:* = { excelRow: 1 }
    trace(rows, loose)
  }
}
`;
  const p = project({ "Main.xn": text });
  const hover = (needle: string, from = 0) => p.hover("Main.xn", text.indexOf(needle, from) + 1)?.contents;
  const push = offset(text, "rows.push");
  expect(hover("excelRow", push)).toBe("```xenon\nRow.excelRow:Int\n```\n\nThe row in the sheet, from 1.");
  expect(hover("data }", push)).toBe("```xenon\nRow.data:*\n```");
  expect(p.definition("Main.xn", text.indexOf("excelRow", push) + 1)[0]!.range.start.line).toBe(2);
  // A literal without a shape to check against: the member of the shape inferred from it.
  expect(hover("excelRow: 1")).toBe("```xenon\nexcelRow:Int\n```");
});

test("hover on destructured names shows their types (tuple positions); completion offers Tuple", () => {
  const text = `public class Main {
  public function Main() {
    for (var [key, value] of Object.entries({ a: 1 })) trace(key, value)
    var [name, age] = pair()
    var t:Tu
    trace(name, age)
  }
  private function pair():Tuple<String, int> => ['ann', 31]
}
`;
  const p = project({ "Main.xn": text });
  const hover = (needle: string) => (p.hover("Main.xn", offset(text, needle, 1))!.contents as string).split("\n")[1];
  expect([hover("key,"), hover("value]"), hover("name,"), hover("age]")]).toEqual(["key:String", "value:Int", "name:String", "age:Int"]);
  expect(p.completions("Main.xn", offset(text, "var t:Tu", 8)).map((i) => i.label)).toContain("Tuple");
});

test("completion offers destructured loop bindings while typing inside the loop", () => {
  const text = `public class Main {
  public function Main() {
    var boxesByPage:Map<String, Array<int>> = new Map()
    for (var [page, boxes] of boxesByPage) {
      box
    }
  }
}
`;
  const p = project({ "Main.xn": text });
  const items = p.completions("Main.xn", offset(text, "      box", 10));
  expect(items.filter((i) => ["page", "boxes"].includes(i.label)).map((i) => [i.label, i.detail])).toEqual([
    ["page", "page:String"],
    ["boxes", "boxes:Array<Int>"],
  ]);
});

test("go to definition on built-in types opens the standard library's declaration (Tuple, Int, Array)", () => {
  const text = "public class Main {\n  public function Main() {\n    var a:Array<Int> = []\n    var n:String = ''\n    var t:Tuple<String, Int> = ['a', 1]\n    trace(a, n, t)\n  }\n}\n";
  const p = project({ "Main.xn": text });
  const target = (needle: string) => p.definition("Main.xn", offset(text, needle, 1)).map((l) => l.path.split("/").at(-1));
  expect([target("Array<Int>"), target("Int>"), target("String = ''"), target("Tuple<")]).toEqual([["Array.xn"], ["Int.xn"], ["String.xn"], ["Tuple.xn"]]);
  expect(p.hover("Main.xn", offset(text, "Tuple<", 1))!.contents).toContain("An array with one type per position");
});

test("null safety by default: hover shows T?, and the editor reports null errors; `nullSafety: false` turns it off", () => {
  const p = new XenonProject(join(import.meta.dir, ".service-project", "src"), "Main");
  const text = "public class Main {\n  public function Main() {\n    var maybe:String? = null\n    trace(maybe.length)\n  }\n}\n";
  p.set("Main.xn", text);
  expect((p.hover("Main.xn", offset(text, "maybe:", 1))!.contents as string).split("\n")[1]).toBe("maybe:String?");
  expect([...p.diagnostics()].flatMap(([, d]) => d.map((x) => x.code))).toContain("X0398");
  // With `"nullSafety": false`, `String?` is just `String`.
  const legacy = new XenonProject(join(import.meta.dir, ".service-project", "src"), "Main", undefined, { nullSafety: false });
  legacy.set("Main.xn", text);
  expect([...legacy.diagnostics()].flatMap(([, d]) => d.map((x) => x.code))).not.toContain("X0398");
});

test("hover on an unannotated callback parameter shows the type it takes from context", () => {
  const text = "public class Main {\n  public function Main() {\n    var words:Array<String> = ['a', 'bb']\n    var n:Array<Int> = words.map(s => s.length)\n    trace(n)\n  }\n}\n";
  const p = project({ "Main.xn": text });
  expect((p.hover("Main.xn", offset(text, "s =>"))!.contents as string).split("\n")[1]).toBe("s:String");
});

test("type completion offers classes imported from JavaScript (import { EventEmitter } …)", () => {
  const text = "import { EventEmitter } from 'node:events'\n\npublic class Main {\n  public function Main() {\n    var e:Even\n  }\n}\n";
  const p = project({ "Main.xn": text });
  const items = p.completions("Main.xn", offset(text, "var e:Even", 10));
  expect(items.map((i) => i.label)).toContain("EventEmitter");
});

test("completion after a spread's receiver in a statement that doesn't parse yet (for (… of [...doc.)", () => {
  const text = "public class Main {\n  public function Main() {\n    var words:Array<String> = []\n    for (var w of [...words.\n  }\n}\n";
  const p = project({ "Main.xn": text });
  expect(p.completions("Main.xn", offset(text, "[...words.", 10)).map((i) => i.label)).toContain("concat");
});

test("hover and completion work for methods and accessors in object literals", () => {
  const text = `typedef Box = { width:int, final area:int, name:String, ?note:String }

public class Main {
  public function Main() {
    var b:Box = {
      width: 1,
      function get area():int { return 2; },
      name: 'x',

    };
    var c = { function init():Void { }, function get total():int { return 1; } };
    trace(b, c.total)
  }
}
`;
  const p = project({ "Main.xn": text });
  // Hovering a getter's name shows the shape member it implements.
  expect(p.hover("Main.xn", offset(text, "get area", 6))?.contents).toContain("Box.final area:Int");
  // Completion of keys leaves out what a method or accessor already gave.
  const keys = p.completions("Main.xn", offset(text, "name: 'x',\n", 12)).map((i) => i.label);
  expect(keys).toContain("note");
  expect(keys).not.toContain("area");
  expect(keys).not.toContain("width");
  // `c.total` resolves through the literal without errors.
  expect(p.diagnostics().get("Main.xn")!.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
});

test("completion after `state.` inside an object literal's getter, also while the literal has syntax errors", () => {
  const member = (getter: string) => `public class State {
  public function nameOf(r:String):String { return r }
}

public class Main {
  private final state:State = new State()
  public function Main() {
    var o = {
      search: '',
${getter}
      function label(row:String):String { return '' }
    }
    trace(o)
  }
}
`;
  for (const getter of [
    "      function get rows():String {\n        return state.\n      },", // fine
    "      function get rows():String {\n        return state.\n      }", // no comma before the next member
    "      get rows():String {\n        return state.\n      }", // JavaScript's way round: reported, still parsed
    "      get function rows():String {\n        return state.\n      },",
  ]) {
    const text = member(getter);
    const p = project({ "Main.xn": text });
    expect(p.completions("Main.xn", offset(text, "state.\n", 6)).map((i) => i.label)).toContain("nameOf");
  }
});

test("semantic tokens paint plain keys as properties, not methods and accessors of a literal (the grammar colours those as functions)", () => {
  const text = `public class Main {
  public function Main() {
    var o = {
      rows: 1,
      function get total():int { return 1 },
      function init():Void { },
      handler: function():Void { }
    }
    trace(o)
  }
}
`;
  const p = project({ "Main.xn": text });
  const lines = text.split("\n");
  const painted = p.semanticTokens("Main.xn").map((t) => lines[t.line]!.slice(t.character, t.character + t.length));
  expect(painted).toEqual(["rows", "handler"]);
});
