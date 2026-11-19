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

test("String methods and regex literals fold at compile time, in constexpr functions too", () => {
  const js = compile(`public class Main {
  public static inline final KEY:String = placeholderKey(' Straße & Nr. ')
  public static inline final WIDTH:int = 'abc'.padStart(6, '-').length
  public static inline final CODE:int? = ''.codePointAt(0)
  public static inline final HI:String = String.fromCharCode(72, 105)

  public static constexpr function placeholderKey(header:String):String {
    return header.replace(~/\\s+/g, '').trim().replace(~/[^0-9A-Za-zÄÖÜäöüß_]/g, '')
  }

  public function Main() {
    trace(KEY, WIDTH, CODE, HI, placeholderKey(String([1])))
  }
}
`);
  expect(js).toContain("console.log('StraßeNr', 6, null, 'Hi', Main.placeholderKey(String([1])));");
});

test("String methods that aren't constants are still rejected in constexpr functions (X0526)", () => {
  const result = compileProject([{ path: "Main.xn", text: `public class Main {
  public static constexpr function parts(s:String):int => s.split(',').length
  public static constexpr function upper(s:String):String => s.toLocaleUpperCase()
  public static constexpr function fn(s:String):String => s.replace('a', (m:String):String => m)
  public function Main() { trace(parts('a'), upper('a'), fn('a')) }
}
` }], { main: "Main" });
  const errors = result.diagnostics.items.filter((d) => d.code === "X0526").map((d) => spanOf(d));
  expect(errors).toEqual(["s.split(',').length", "s.toLocaleUpperCase()", "(m:String):String => m"]);
});

const spanOf = (d: { labels: { primary: boolean; span: { file: { text: string }; start: number; end: number } }[] }) => {
  const l = d.labels.find((x) => x.primary)!;
  return l.span.file.text.slice(l.span.start, l.span.end).replace(/^calling `|`$/g, "");
};
