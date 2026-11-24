/** Shape intersections `A & B` (one shape with the members of all parts) and `T extends A & B` bounds. */
import { afterAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { compileProject } from "../src/compiler.ts";
import { typeToString } from "../src/types.ts";
import { typeCheck } from "./tsemit.ts";

const out = join(import.meta.dir, ".intersections-out");
afterAll(() => rm(out, { recursive: true, force: true }));

const code = `
typedef Attrs = { id:String, ?title:String }
typedef Obj = { prop:Attrs & { myProp:String } }
typedef WithId<T> = { id:String } & { value:T }
typedef Node = { value:Int } & { ?next:Node }
typedef Both = { id:String, ?note:String } & { id:String, note:String }

public class Main {
  public function Main() {}
  public static function props():String {
    var o:Obj = { prop: { id: 'a', myProp: 'm' } }
    var asAttrs:Attrs = o.prop          // the combined shape fits each part
    return o.prop.id + o.prop.myProp + (o.prop.title ?? '-') + asAttrs.id
  }
  public static function generic():Int {
    var w:WithId<Int> = { id: 'w', value: 41 }
    return w.value + 1
  }
  public static function list():Int {
    var n:Node? = { value: 1, next: { value: 2, next: { value: 3 } } }
    var sum = 0
    while (var cur:Node = n) {
      sum += cur.value
      n = cur.next
    }
    return sum
  }
  public static function merged():String {
    var b:Both = { id: 'b', note: 'required in one part, so required' }
    return b.note
  }
  public static function param(item:Attrs & { final count:Int }):Int => item.count
  public static function bitwise(raw:*):Int => (raw as Int?) ?? 0 & 3
}
`;

const errors = (result: ReturnType<typeof compileProject>) =>
  result.diagnostics.items.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.message}`);

test("shape intersections combine members, nest in shapes, take type arguments and recurse", async () => {
  const result = compileProject([{ path: "Main.xn", text: code }], { main: "Main" });
  expect(errors(result)).toEqual([]);
  for (const file of result.outputs) await Bun.write(join(out, file.path), file.text);
  const { Main } = await import(join(out, "Main.js"));
  expect(Main.props()).toBe("am-a");
  expect(Main.generic()).toBe(42);
  expect(Main.list()).toBe(6);
  expect(Main.merged()).toBe("required in one part, so required");
  expect(Main.param({ id: "p", count: 3 })).toBe(3);
  expect(Main.bitwise(5)).toBe(5); // `as Int?` then `?? (0 & 3)`: `&` after `as` stays bitwise
});

test("an intersection is named as written in messages, and a member in two parts merges", () => {
  const result = compileProject([{ path: "Main.xn", text: code }], { main: "Main" });
  const param = [...result.check!.typeNodeTypes.entries()].find(([n]) => n.kind === "IntersectionType" && n.span.file.text.slice(n.span.start, n.span.end).includes("final count"))!;
  expect(typeToString(param[1])).toBe("Attrs & { final count:Int }");
  const both = [...result.check!.typedefs.values()].find((t) => t.decl.name.name === "Both")!;
  const note = (both.state as { members: Map<string, { optional: boolean }> }).members.get("note")!;
  expect(note.optional).toBe(false);
});

test("shape intersections are TypeScript intersections", () => {
  const result = compileProject([{ path: "Main.xn", text: code }], { main: "Main", target: "ts" });
  expect(errors(result)).toEqual([]);
  const main = result.outputs.find((o) => o.path === "Main.ts")!.text;
  expect(main).toContain("type Obj = { prop: Attrs & { myProp: string } };");
  expect(main).toContain("type WithId<T> = { id: string } & { value: T };");
  expect(main).toContain("static param(item: Attrs & { readonly count: number }): number");
  expect(typeCheck(result.outputs, join(import.meta.dir, ".intersections-ts"))).toEqual([]);
});

afterAll(() => rm(join(import.meta.dir, ".intersections-ts"), { recursive: true, force: true }));
