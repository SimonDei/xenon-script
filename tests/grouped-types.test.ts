/** A type in parentheses without `->` is grouped: `(A | B)?`, `((Int) -> Void)?`. */
import { afterAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { compileProject } from "../src/compiler.ts";
import { typeCheck } from "./tsemit.ts";

const errors = (r: ReturnType<typeof compileProject>) => r.diagnostics.items.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.message}`);

const code = `public class Main {
  public function Main() {}
  public static function run():Array<String> {
    var u:(Int | String)? = 'text'
    var cb:((Int) -> String)? = null
    var plain:(String) = 'x'
    var f:(Int) -> String = n => $'{n}'
    var out = [$'{u}', $'{cb?.(1)}', plain, f(2)]
    u = null
    cb = n => $'cb{n}'
    out.push($'{u}', cb?.(3) ?? '-')
    return out
  }
}
`;

test("a grouped type can be made nullable, and runs as written", () => {
  const result = compileProject([{ path: "Main.xn", text: code }], { main: "Main" });
  expect(errors(result)).toEqual([]);
  const js = result.outputs.find((o) => o.path === "Main.js")!.text;
  const Main = new Function(`${js.replace(/^export /m, "").replace(/\/\/# sourceMappingURL.*$/m, "")}; return Main;`)();
  expect(Main.run()).toEqual(["text", "undefined", "x", "2", "null", "cb3"]); // `?.` on null gives JavaScript's `undefined`
});

test("parentheses with several types, a trailing comma or nothing still need `->`", () => {
  const text = `public class Main {
  public function Main() {
    var a:(Int, String) = 1
  }
}
`;
  for (const type of ["(Int, String)", "(Int,)", "()"]) {
    expect(errors(compileProject([{ path: "Main.xn", text: text.replace("(Int, String)", type) }], { main: "Main" })))
      .toEqual(["X0100 expected `->` and a return type, found `=`"]);
  }
});

test("the TypeScript output of grouped nullable types type-checks", () => {
  const result = compileProject([{ path: "Main.xn", text: code }], { main: "Main", target: "ts" });
  expect(errors(result)).toEqual([]);
  expect(typeCheck(result.outputs, join(import.meta.dir, ".grouped-types-ts"))).toEqual([]);
});

afterAll(() => rm(join(import.meta.dir, ".grouped-types-ts"), { recursive: true, force: true }));
