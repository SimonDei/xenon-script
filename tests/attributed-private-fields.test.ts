/** A private field with a run-time attribute is a plain property (so attribute readers reach it); other private fields stay `#private`. */
import { afterAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { compileProject } from "../src/compiler.ts";
import { typeCheck } from "./tsemit.ts";

const errors = (r: ReturnType<typeof compileProject>) => r.diagnostics.items.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.message}`);

const code = `class Tag implements IAttribute { public function Tag() {} }

class Box {
  [Tag] private var marked:Int = 1
  [Deprecated('use marked')] private var old:Int = 2
  private var hidden:Int = 3
  [Tag] private final fixed:Int = 4
  public function sum():Int => marked + old + hidden + fixed
}

public class Main {
  public function Main() {}
  public static function run():Array<*> {
    var box:* = new Box()
    return [new Box().sum(), box.marked, box.old, box.hidden, box.fixed, Attributes.members(Box).join(',')]
  }
}
`;

test("only private fields with run-time attributes become plain properties", async () => {
  const result = compileProject([{ path: "Main.xn", text: code }], { main: "Main" });
  expect(errors(result)).toEqual([]);
  const js = result.outputs.find((o) => o.path === "Main.js")!.text;
  expect(js).toContain("  marked = 1;");
  expect(js).toContain("  #old = 2;"); // `[Deprecated]` exists only at compile time
  expect(js).toContain("  #hidden = 3;");
  const out = join(import.meta.dir, ".attributed-private-out");
  await rm(out, { recursive: true, force: true });
  try {
    for (const o of result.outputs) await Bun.write(join(out, o.path), o.text);
    const { Main } = await import(join(out, "Main.js"));
    // A private `final` field with an attribute is read through a getter, like a protected one.
    expect(Main.run()).toEqual([10, 1, undefined, undefined, 4, "marked,fixed"]);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test("the TypeScript output marks them `private` and type-checks", () => {
  const result = compileProject([{ path: "Main.xn", text: code }], { main: "Main", target: "ts" });
  expect(errors(result)).toEqual([]);
  expect(result.outputs.find((o) => o.path === "Main.ts")!.text).toContain("private marked: number = 1;");
  expect(typeCheck(result.outputs, join(import.meta.dir, ".attributed-private-ts"))).toEqual([]);
});

afterAll(() => rm(join(import.meta.dir, ".attributed-private-ts"), { recursive: true, force: true }));
