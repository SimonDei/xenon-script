/** `constexpr` calls in the output: folded to their value when that is safe, ordinary calls otherwise. */
import { expect, test } from "bun:test";
import { compileProject } from "../src/compiler.ts";

const compile = (text: string) => {
  const result = compileProject([{ path: "Main.xn", text }], { main: "Main" });
  expect(result.diagnostics.items.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
  return result.outputs.find((o) => o.path === "Main.js")!.text;
};

test("a constexpr method of the own object is folded (constexpr methods are implicitly final)", () => {
  const js = compile(`public class Main {
  private constexpr function fact(n:int):int {
    if (n <= 1) return 1
    return n * fact(n - 1)
  }
  public final constexpr function twice(n:int):int => n * 2
  public constexpr function open(n:int):int => n + 1
  private var base:int = 5
  private constexpr function usesThis(n:int):int => n + base

  public function Main() {
    trace(fact(10), this.fact(3), twice(21), open(1), usesThis(1))
  }
}
`);
  // folded whatever the visibility; one reading a field of the runtime object stays a call.
  expect(js).toContain("console.log(3628800, 6, 42, 2, this.usesThis(1));");
});
