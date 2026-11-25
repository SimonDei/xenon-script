/** `...?x` spreads nothing when `x` is null; a plain `...` of a `T?` is X0398 (spreading `null` throws in JavaScript). */
import { afterAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { compileProject } from "../src/compiler.ts";
import { typeCheck } from "./tsemit.ts";

const errors = (r: ReturnType<typeof compileProject>) => r.diagnostics.items.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.labels.find((l) => l.primary)!.message}`);

const code = `public class Main {
  public function Main() {}

  public static function joined(a:Array<Int>?, b:Array<Int>?):Array<Int> {
    return [...?a, 0, ...?b];
  }

  public static function inferred(a:Array<String>?):Int {
    var all = [...?a];
    return all.length;
  }

  public static function largest(a:Array<Int>?, b:Array<Int>?):Float {
    return Math.max(-1, ...?(a ?? b), ...?(b != null && a != null ? a : null));
  }
}
`;

test("`...?` spreads nothing for null and the elements otherwise, in arrays and calls", async () => {
  const result = compileProject([{ path: "Main.xn", text: code }], { main: "Main" });
  expect(errors(result)).toEqual([]);
  const out = join(import.meta.dir, ".null-aware-spread-out");
  await rm(out, { recursive: true, force: true });
  try {
    for (const o of result.outputs) await Bun.write(join(out, o.path), o.text);
    const { Main } = await import(join(out, "Main.js"));
    expect(Main.joined(null, null)).toEqual([0]);
    expect(Main.joined([1, 2], null)).toEqual([1, 2, 0]);
    expect(Main.joined(null, [3])).toEqual([0, 3]);
    expect(Main.inferred(null)).toBe(0);
    expect(Main.inferred(["x", "y"])).toBe(2);
    expect(Main.largest(null, null)).toBe(-1);
    expect(Main.largest([4], [9])).toBe(4); // both spreads are `a`
    expect(Main.largest(null, [9])).toBe(9);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test("a plain spread of a nullable is X0398, with a fix that adds the `?`", () => {
  const text = `public class Main {
  public function Main() {}
  public static function f(xs:Array<Int>?):Void {
    var a:Array<Int> = [...xs];
    var b = [...xs];
    trace(a, b, ...xs);
  }
}
`;
  const result = compileProject([{ path: "Main.xn", text }], { main: "Main" });
  expect(errors(result)).toEqual(["X0398 `Array<Int>?`", "X0398 `Array<Int>?`", "X0398 `Array<Int>?`"]);
  const [d] = result.diagnostics.items;
  const edit = d!.help[0]!.edits![0]!;
  expect(edit.text).toBe("?");
  expect(text.slice(edit.span.start - 3, edit.span.start)).toBe("...");
});

test("the TypeScript output of `...?` type-checks", () => {
  const result = compileProject([{ path: "Main.xn", text: code }], { main: "Main", target: "ts" });
  expect(errors(result)).toEqual([]);
  expect(typeCheck(result.outputs, join(import.meta.dir, ".null-aware-spread-ts"))).toEqual([]);
});

afterAll(() => rm(join(import.meta.dir, ".null-aware-spread-ts"), { recursive: true, force: true }));
