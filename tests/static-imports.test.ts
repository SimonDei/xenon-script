/** `import static pkg.Class.member` / `import static pkg.Class.*`: a class's static members by their own names. */
import { afterAll, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { compileProject } from "../src/compiler.ts";
import { XenonProject } from "../src/service.ts";

const diagnostics = (r: ReturnType<typeof compileProject>) =>
  r.diagnostics.items.map((d) => `${d.severity} ${d.code} ${d.message}`);

const fmt = { path: "util/Fmt.xn", text: `package util {
  public class Fmt {
    public static final PI:Float = 3.14
    public static var calls:Int = 0
    public static function twice(s:String):String {
      calls++
      return s + s
    }
    public static function slot(name:String):String => $'<{name}>'
    public static function hello(n:Int):String => 'imported'
    private static function hidden():Int => 1
    public static function viaHidden():Int => hidden()
    public function inst():Void {}
  }
}
` };
const other = { path: "util/Other.xn", text: `package util {
  public class Other {
    public static function twice(n:Int):Int => n * 2
  }
}
` };

const run = async (files: { path: string; text: string }[], dir: string) => {
  const result = compileProject(files, { main: "Main" });
  const out = join(import.meta.dir, dir);
  await rm(out, { recursive: true, force: true });
  for (const o of result.outputs) await Bun.write(join(out, o.path), o.text);
  return { result, out, Main: (await import(join(out, "Main.js"))).Main };
};

test("imported static members are used by their own names and compile to `Class.member`", async () => {
  const main = { path: "Main.xn", text: `import static util.Fmt.*
import static util.Other.twice

public class Main {
  public function Main() {}
  public static function run():Array<String> {
    var f = twice
    calls = 10
    return [String(PI), f('a'), String(calls), twice('b')]
  }
}
` };
  // \`twice\` offered by two imports is an error where it's used (a single-name import doesn't win).
  const ambiguous = compileProject([fmt, other, main], { main: "Main" });
  expect(diagnostics(ambiguous).filter((d) => d.startsWith("error"))).toEqual(["error X0433 `twice` is ambiguous", "error X0433 `twice` is ambiguous"]);

  main.text = main.text.replace("import static util.Other.twice\n", "");
  const { result, out, Main } = await run([fmt, other, main], ".static-imports-out");
  try {
    expect(diagnostics(result)).toEqual([]);
    const js = result.outputs.find((o) => o.path === "Main.js")!.text;
    expect(js).toContain("import { Fmt } from './util/Fmt.js';");
    expect(js).toContain("Fmt.calls = 10;");
    expect(Main.run()).toEqual(["3.14", "aa", "11", "bb"]);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test("an inherited member wins, unless it's called and can't be: `slot(…)` with a `String` field `slot`", async () => {
  const main = { path: "Main.xn", text: `import static util.Fmt.*

class Base {
  public var slot:String = 'field'
  public function hello():String => 'base'
}

public class Main extends Base {
  public function Main() { super() }
  public static function run():Array<String> {
    var m = new Main()
    return m.both()
  }
  public function both():Array<String> => [slot('x'), slot, hello()]
}
` };
  const { result, out, Main } = await run([fmt, main], ".static-imports-slot");
  try {
    expect(diagnostics(result)).toEqual([]);
    expect(Main.run()).toEqual(["<x>", "field", "base"]);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
  // A method that can be called hides the import even when the call doesn't fit it (as in Java).
  const wrong = compileProject([fmt, { path: "Main.xn", text: main.text.replace("hello()]", "hello(1)]") }], { main: "Main" });
  expect(diagnostics(wrong).filter((d) => d.startsWith("error"))).toEqual(["error X0601 this call takes 0 arguments but 1 was given"]);
});

test("static imports are checked: missing classes and members, instance and private members, `final` fields, unused imports", () => {
  const main = { path: "Main.xn", text: `import static util.Fmt.inst
import static util.Fmt.nope
import static util.Fmt.hidden
import static util.Nope.*
import static util.Fmt.PI
import static util.Fmt.twice

public class Main {
  public function Main() {
    PI = 2
  }
}
` };
  expect(diagnostics(compileProject([fmt, main], { main: "Main" }))).toEqual([
    "error X0436 `inst` is not a static member of `Fmt`",
    "error X0436 `Fmt` has no member `nope`",
    "error X0603 `hidden` is private to `Fmt`",
    "error X0431 cannot find class `util.Nope`",
    "error X0502 `PI` is `final` and can only be assigned in a `static { }` block of its class",
    "warning X0870 unused import `static util.Fmt.twice`",
  ]);
});

test("an unknown name that is a public static member somewhere suggests the import", () => {
  const main = { path: "Main.xn", text: `public class Main {
  public function Main() {
    trace(twice('a'))
  }
}
` };
  const d = compileProject([fmt, main], { main: "Main" }).diagnostics.items.find((x) => x.code === "X0425")!;
  expect(d.help.map((h) => h.message)).toEqual(["`Fmt` has a static `twice`; add `import static util.Fmt.twice;` or `import static util.Fmt.*;`"]);
});

const projectDir = join(import.meta.dir, ".static-imports-project");

test("the editor completes, describes and finds imported static members", async () => {
  const src = join(projectDir, "src");
  await mkdir(join(src, "util"), { recursive: true });
  const text = `import static util.Fmt.*

public class Main {
  public function Main() {
    trace(twice('a'))
  }
}
`;
  await Bun.write(join(src, "util/Fmt.xn"), fmt.text);
  await Bun.write(join(src, "Main.xn"), text);
  const p = new XenonProject(src);
  await p.load();
  const at = text.indexOf("twice(") + 2;
  expect(p.completions("Main.xn", text.indexOf("twice(")).some((i) => i.label === "twice")).toBe(true);
  expect(p.hover("Main.xn", at)?.contents).toContain("static function Fmt.twice(s:String):String");
  expect(p.definition("Main.xn", at)[0]?.path).toBe(join(src, "util/Fmt.xn"));
});

afterAll(() => rm(projectDir, { recursive: true, force: true }));
