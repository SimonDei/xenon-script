import { expect, test } from "bun:test";
import { DiagnosticBag } from "../src/diagnostics.ts";
import { lex, type Token } from "../src/lexer.ts";
import { SourceFile } from "../src/source.ts";

function tokens(text: string) {
  const diags = new DiagnosticBag();
  const toks = lex(new SourceFile("t.xn", text), diags);
  return { toks: toks.slice(0, -1), diags };
}

const kv = (ts: Token[]) => ts.map((t) => `${t.kind}:${t.value}`);

test("keywords, identifiers and contextual keywords", () => {
  const { toks } = tokens("public final class Foo nameof get set from of step operator");
  expect(kv(toks)).toEqual([
    "keyword:public", "keyword:final", "keyword:class", "ident:Foo",
    "keyword:nameof", "ident:get", "ident:set", "ident:from", "ident:of", "ident:step", "ident:operator",
  ]);
});

test("numbers and ranges", () => {
  expect(kv(tokens("0..10 0..=n 1.5 0xFF 1_000 1e3 2..").toks)).toEqual([
    "number:0", "punct:..", "number:10", "number:0", "punct:..=", "ident:n",
    "number:1.5", "number:0xFF", "number:1_000", "number:1e3", "number:2", "punct:..",
  ]);
});

test("property reference operator", () => {
  expect(kv(tokens("User::name Array::map").toks)).toEqual([
    "ident:User", "punct:::", "ident:name", "ident:Array", "punct:::", "ident:map",
  ]);
});

test("generic variance annotations", () => {
  expect(kv(tokens("<in T, out U>").toks)).toEqual([
    "punct:<", "keyword:in", "ident:T", "punct:,", "ident:out", "ident:U", "punct:>",
  ]);
});

test("spread vs range", () => {
  expect(kv(tokens("...xs a..b").toks)).toEqual(["punct:...", "ident:xs", "ident:a", "punct:..", "ident:b"]);
});

test("single-quoted strings with escapes", () => {
  const { toks, diags } = tokens(String.raw`'It\'s\n\u{1F600}\{'`);
  expect(diags.items).toEqual([]);
  expect(toks[0]!.value).toBe("It's\n😀{");
});

test("template strings with nested expressions and strings", () => {
  const { toks, diags } = tokens("$'Hi {user?.name ?? 'guest'}, {a + {b: 1}.b}!'");
  expect(diags.items).toEqual([]);
  const parts = toks[0]!.parts!;
  expect(parts.map((p) => p.kind)).toEqual(["text", "expr", "text", "expr", "text"]);
  expect(parts[1]!.kind === "expr" && kv(parts[1]!.tokens.slice(0, -1))).toEqual([
    "ident:user", "punct:?.", "ident:name", "punct:??", "string:guest",
  ]);
});

test("regex literals need ~, plain / is division", () => {
  const { toks } = tokens("a / b / c ~/a\\/b[/]/gi");
  expect(kv(toks)).toEqual(["ident:a", "punct:/", "ident:b", "punct:/", "ident:c", "regex:/a\\/b[/]/gi"]);
});

test("regex flag and pattern validation", () => {
  expect(tokens("~/a/gq").diags.items.map((d) => d.code)).toEqual(["X0350"]);
  expect(tokens("~/a/gg").diags.items.map((d) => d.code)).toEqual(["X0350"]);
  expect(tokens("~/(a/").diags.items.map((d) => d.code)).toEqual(["X0351"]);
});

test("double quotes and backticks are rejected with fix-its", () => {
  const { diags } = tokens('"hi" `n=${n}`');
  expect(diags.items.map((d) => d.code)).toEqual(["X0360", "X0360"]);
  expect(diags.items[0]!.help[0]!.edits![0]!.text).toBe("'hi'");
  expect(diags.items[1]!.help[0]!.edits![0]!.text).toBe("$'n={n}'");
});

test("newline flags for ASI", () => {
  const { toks } = tokens("a\nb c");
  expect(toks.map((t) => t.nl)).toEqual([false, true, false]);
});

test("?. followed by a digit is a ternary", () => {
  expect(kv(tokens("a?.5:1").toks)).toEqual(["ident:a", "punct:?", "number:.5", "punct::", "number:1"]);
});

test("unterminated string reports at the opening quote", () => {
  const { diags } = tokens("x = 'abc\ny");
  expect(diags.items[0]!.code).toBe("X0362");
  expect(diags.items[0]!.labels[0]!.span.start).toBe(4);
});
