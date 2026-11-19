/** The language service: diagnostics, hover, go-to-definition and completion on an in-memory project. */
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
  // `readFileSync`'s `path` is `*` to Xenon (a union in TypeScript): TypeScript's errors on `true`
  // (and on `n`, as TypeScript then falls back to the last overload, returning `string | Buffer`).
  expect(main.map((d) => [d.source, d.code, d.range.start.character])).toEqual([["typescript", "TS2322", 8], ["typescript", "TS2769", 32]]);

  // Typed from the `.d.ts`, Xenon itself sees that the result is a `String`; TypeScript stays quiet on that line.
  p.set("Main.xn", MAIN.replace("var n:String = readFileSync(true, 'utf8')", "var n:int = readFileSync('Main.xn', 'utf8')"));
  expect(p.diagnostics().get("Main.xn")!.map((d) => [d.source, d.code, d.range.start.character])).toEqual([["xenon", "X0308", 16]]);

  // A Xenon error: reported once, with its notes and help, and TypeScript stays quiet about the same spot.
  p.set("Main.xn", MAIN.replace("a.speak(2)", "a.speak('2')"));
  const broken = p.diagnostics().get("Main.xn")!;
  expect(broken.map((d) => [d.source, d.code])).toEqual([["xenon", "X0308"], ["typescript", "TS2322"], ["typescript", "TS2769"]]);
  expect(broken[0]!.range.start).toEqual({ line: 9, character: 18 }); // the argument `'2'`
});

test("hover shows Xenon types and documentation, also for JavaScript imports (from their `.d.ts`)", () => {
  const p = project({ "zoo/Animal.xn": ANIMAL, "Main.xn": MAIN });
  const hover = (needle: string, delta = 0) => p.hover("Main.xn", offset(MAIN, needle, delta))?.contents;
  expect(hover("a.speak", 3)).toBe("```xenon\nfunction Animal.speak(times?:int):String\n```\n\nMakes a sound, `times` times.");
  expect(hover("a.speak", 0)).toBe("```xenon\na:Animal\n```");
  expect(hover("scores.get", 7)).toBe("```xenon\nfunction Map.get(key:String):int?\n```\n\nThe value for `key`, or `null` if there is none.");
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
  expect(animal.find((i) => i.label === "speak")!.detail).toBe("function Animal.speak(times?:int):String");
  expect(labels(insert("Animal."))).toEqual(["count", "create"]);
  expect(labels(insert("scores.ge"))).toContain("get");
  // `*` to Xenon: TypeScript's members.
  expect(labels(insert("path."))).toContain("basename");

  const scope = labels(insert(""));
  expect(scope.slice(0, 3)).toEqual(["a", "scores", "n"]); // locals declared before the cursor
  expect(scope).toEqual(expect.arrayContaining(["Animal", "Main", "Exception", "Map", "setTimeout", "readFileSync", "path", "trace", "while"]));
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
    signatures: [{ label: "speak(times?:int):String", documentation: "Makes a sound, `times` times.", parameters: [{ label: [6, 16] }] }],
    activeSignature: 0,
    activeParameter: 0,
  });
  // The second argument of `Math.max(1, 2)` (a rest parameter).
  const max = help(ZOO, offset(ZOO, "Math.max(1, ", 12))!;
  expect(max.signatures[0]!.label).toBe("max(...values:Array<Float>):Float");
  expect(max.activeParameter).toBe(0);
  // `new Dog(` and, right after a comma with nothing typed yet, still the call.
  expect(help(ZOO, offset(ZOO, "new Dog()", 8))!.signatures[0]!.label).toBe("new Dog():void");
  const typing = ZOO.replace("Math.max(1, 2)", "scores(1, )").replace("public function Main() {", "public function Main() {\n    var scores:(a:int, b:String) -> void = (a:int, b:String):void => {}");
  const second = help(typing, offset(typing, "scores(1, ", 10))!;
  expect([second.signatures[0]!.label, second.activeParameter]).toEqual(["scores(a:int, b:String):void", 1]);
});

test("document symbols: classes with their members", () => {
  const p = project(zooFiles);
  const outline = p.documentSymbols("zoo/Animal.xn");
  expect(outline.map((s) => [s.name, s.kind])).toEqual([["Animal", "class"]]);
  expect(outline[0]!.children.map((c) => `${c.kind} ${c.name}${c.detail ? " " + c.detail : ""}`)).toEqual([
    "field name String", "field secret int", "field age int", "field count int",
    "constructor constructor", "method speak (times?:int):String", "method create ():Animal",
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
    ["id", "final id:int", undefined],
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
  expect(hover("form.append('a")[1]).toBe("function FormData.append(name:String, value:String):void");
  // The 3-parameter overload, documented by the comment above the overload group it belongs to.
  const file = hover("form.append('b");
  expect(file[1]).toBe("function FormData.append(name:String, value:Blob, fileName:String):void");
  expect(file.at(-1)).toStartWith("Adds a file under `name`");
  // Generic overloads as called.
  expect(hover(".then")[1]).toBe("function Promise.then(onFulfilled:(value:int) -> String):Promise<String>");
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
  expect(at("{ excelRow: 2", 2)[0]!.detail).toBe("excelRow:int");
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
  expect([at("var c:"), at("const N:"), at("function f(a:int, b:"), at("function f(...rest:"), at("function f():"), at("x as "), at("x is "), at("new "), at("Array<"), at("(a:int) -> "), at("class A extends ")])
    .toEqual([true, true, true, true, true, true, true, true, true, true, true]);
  // Shapes: in a typedef (members on their own lines, optional, final, nested) and in an annotation.
  expect([at("typedef Sheet = {\n  columns:"), at("typedef P<T> = { ?x:"), at("typedef A = { final id:int, b:"), at("typedef A = { b:{ c:"), at("var p:{ x:"), at("f(a:Array<{ x:")])
    .toEqual([true, true, true, true, true, true]);
  expect([at("var o = { a: 1, b: "), at("f({ key: "), at("var x = ok ? a : "), at("f(a, b"), at("var o:P = { a: "), at("typedef A = { b:int }\nvar o = { c: ")])
    .toEqual([false, false, false, false, false, false]);
});

test("hover shows the standard library's constexpr members and inline constants as declared", () => {
  const text = "public class Main {\n  public function Main() {\n    var s:String = String(1)\n    trace(s.trim(), Math.floor(1.5), s.length, Math.PI, s.split(','), s.replace('a', 'b'))\n  }\n}\n";
  const p = project({ "Main.xn": text });
  const first = (needle: string) => (p.hover("Main.xn", offset(text, needle, 1))!.contents as string).split("\n")[1];
  expect(first("trim")).toBe("constexpr function String.trim():String");
  expect(first("floor")).toBe("static constexpr function Math.floor(x:Float):Float");
  expect(first("length")).toBe("constexpr function get String.length():int");
  expect(first("PI")).toBe("static inline const Math.PI:Float");
  expect(first("split")).toBe("function String.split(separator:String):Array<String>");
  expect(first("replace")).toBe("constexpr function String.replace(pattern:String, replacement:String):String");
});
