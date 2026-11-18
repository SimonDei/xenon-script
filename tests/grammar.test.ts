/** The VS Code TextMate grammar (packages/vscode-klass), run with VS Code's own tokenizer. */
import { expect, test } from "bun:test";
import { join, relative } from "node:path";
import * as oniguruma from "vscode-oniguruma";
import { INITIAL, parseRawGrammar, Registry, type StateStack } from "vscode-textmate";

const root = join(import.meta.dir, "..");
const grammarPath = join(root, "packages", "vscode-klass", "syntaxes", "klass.tmLanguage.json");
const wasm = await Bun.file(join(root, "node_modules", "vscode-oniguruma", "release", "onig.wasm")).arrayBuffer();
await oniguruma.loadWASM(wasm);
const registry = new Registry({
  onigLib: Promise.resolve({ createOnigScanner: (p: string[]) => new oniguruma.OnigScanner(p), createOnigString: (s: string) => new oniguruma.OnigString(s) }),
  loadGrammar: async () => parseRawGrammar(await Bun.file(grammarPath).text(), grammarPath),
});
const grammar = (await registry.loadGrammar("source.klass"))!;

interface Tok { text: string; scopes: string[] }

function tokenize(source: string): { lines: Tok[][]; end: StateStack } {
  let stack = INITIAL;
  const lines = source.split("\n").map((line) => {
    const r = grammar.tokenizeLine(line, stack);
    stack = r.ruleStack;
    return r.tokens.map((t) => ({ text: line.slice(t.startIndex, t.endIndex), scopes: t.scopes }));
  });
  return { lines, end: stack };
}

/** Innermost scope of the `nth` token whose text is exactly `text`. */
function scopeOf(source: string, text: string, nth = 0): string {
  const all = tokenize(source).lines.flat().filter((t) => t.text.trim() === text);
  const tok = all[nth];
  if (!tok) throw new Error(`no token \`${text}\` in: ${source}\n${JSON.stringify(tokenize(source).lines.flat().map((t) => t.text))}`);
  return tok.scopes.at(-1)!;
}

const cases: [string, string, string, number?][] = [
  // declarations
  ["package com.zoo {", "com.zoo", "entity.name.namespace.klass"],
  ["import com.zoo.Dog;", "Dog", "entity.name.type.klass"],
  ["import _ from 'lodash';", "from", "keyword.control.from.klass"],
  ["import * as path from 'node:path';", "path", "variable.other.readwrite.alias.klass"],
  ["public final class Dog extends Animal implements IPet {", "Dog", "entity.name.type.class.klass"],
  ["public final class Dog extends Animal implements IPet {", "final", "storage.modifier.klass"],
  ["public final class Dog extends Animal implements IPet {", "extends", "storage.modifier.extends.klass"],
  ["public interface IShape {", "IShape", "entity.name.type.interface.klass"],
  ["public enum Direction { Up, Down }", "Direction", "entity.name.type.enum.klass"],
  ["public typedef Point = { x:Float, ?label:String }", "Point", "entity.name.type.alias.klass"],
  ["native('Date') class Moment {", "'Date'", "string.quoted.single.klass"],
  ["public function speak():String {", "speak", "entity.name.function.klass"],
  ["public function get name():String const {", "get", "storage.type.property.klass"],
  ["public function get name():String const {", "name", "entity.name.function.klass"],
  ["public function get name():String const {", "const", "storage.modifier.const.klass"],
  ["public function operator+(o:Vec2):Vec2 {", "operator+", "entity.name.function.klass"],
  ["public ~User() { conn.close() }", "User", "entity.name.function.destructor.klass"],
  ["final id:String = make()", "id", "variable.other.declaration.klass"],
  ["final id:String = make()", "make", "entity.name.function.call.klass"],
  ["var count:int = 0", "count", "variable.other.declaration.klass"],
  ["using u:User = new User('42')", "u", "variable.other.declaration.klass"],
  ["private static inline final MAX_HP:int = 100", "MAX_HP", "variable.other.declaration.klass"],
  // types
  ["var a:Array<Int> = []", "Array", "support.type.builtin.klass"],
  ["var a:Array<Int> = []", "Int", "support.type.primitive.klass"],
  ["var x:* = null", "*", "support.type.dynamic.klass"],
  ["var f:(Int) -> Void = g", "->", "storage.type.function.arrow.klass"],
  ["var f:(Int) -> Void = g", "Void", "support.type.primitive.klass"],
  ["trace(JSON.parse(s), Box.of(1))", "JSON", "entity.name.type.klass"],
  ["trace(hp > MAX_HP)", "MAX_HP", "variable.other.constant.klass"],
  ["throw new StateException('x')", "StateException", "support.class.exception.klass"],
  // strings
  ["var s:String = 'it\\'s'", "\\'", "constant.character.escape.klass"],
  ["var s:String = $'Hi {user?.name ?? 'guest'}!'", "user", "meta.embedded.line.klass"],
  ["var s:String = $'Hi {user?.name ?? 'guest'}!'", "guest", "string.quoted.single.klass"],
  ["var s:String = $'Hi {user?.name ?? 'guest'}!'", "!", "string.template.klass"],
  ["var s:String = $'set: \\{1\\} {n}'", "\\{", "constant.character.escape.klass"],
  ["var s:String = $'{ {a: 1}.a }'", "a", "meta.embedded.line.klass", 1],
  ["var s:String = \"double\"", "\"double\"", "invalid.illegal.string.double.klass"],
  ["var r:RegExp = ~/a\\/b[/]+/gi", "gi", "keyword.other.flag.regexp.klass"],
  ["var r:RegExp = ~/a\\/b[/]+/gi", "[/]", "constant.other.character-class.regexp.klass"],
  ["var q:Float = a / b / c", "/", "keyword.operator.arithmetic.klass", 1],
  // numbers and ranges
  ["for (var i:int of 0..10 step 2) {}", "0", "constant.numeric.decimal.klass"],
  ["for (var i:int of 0..10 step 2) {}", "..", "keyword.operator.range.klass"],
  ["for (var i:int of 0..10 step 2) {}", "of", "keyword.control.loop.klass"],
  ["for (var i:int of 0..10 step 2) {}", "step", "keyword.control.loop.klass"],
  ["for (var i:int of 0..=n) {}", "..=", "keyword.operator.range.klass"],
  ["var step:int = of + 1", "of", "source.klass"],
  ["var n:Float = 1_000.5e-3 + 0xFF + 0b1010 + .5", "1_000.5e-3", "constant.numeric.decimal.klass"],
  ["var n:Float = 1_000.5e-3 + 0xFF + 0b1010 + .5", "0xFF", "constant.numeric.hex.klass"],
  ["var n:Float = 1_000.5e-3 + 0xFF + 0b1010 + .5", ".5", "constant.numeric.decimal.klass"],
  ["trace(3.75.toFixed(1))", "3.75", "constant.numeric.decimal.klass"],
  // keywords, literals, operators
  ["if (var u:User = find(id)) {} else {}", "else", "keyword.control.conditional.klass"],
  ["if (x is Dog && y as Cat != null) {}", "is", "keyword.operator.expression.klass"],
  ["trace(x ?? y, a?.b, ...rest)", "?.", "keyword.operator.optional.klass"],
  ["trace(x ?? y, a?.b, ...rest)", "...", "keyword.operator.spread.klass"],
  ["if (x == undefined) return", "undefined", "constant.language.undefined.klass"],
  ["var let:int = 1", "let", "invalid.illegal.reserved.klass"],
  ["trace(nums.with(0, 99), p.catch(f), x?.default)", "with", "variable.other.property.klass"],
  ["trace(nums.with(0, 99), p.catch(f), x?.default)", "catch", "variable.other.property.klass"],
  ["trace(nums.with(0, 99), p.catch(f), x?.default)", "default", "variable.other.property.klass"],
  ["trace(this.name, super.x)", "trace", "support.function.trace.klass"],
  ["var f:Function = async (u:String):Promise<*> => await load(u)", "await", "keyword.control.flow.klass"],
  // comments
  ["/** Doc with `code` and @param x */", "@param", "storage.type.class.doc.klass"],
  ["trace(undefined /* klass-allow K0840 */)", "K0840", "constant.other.error-code.klass"],
  ["var a:int = 1 // trailing", "trailing", "comment.line.double-slash.klass"],
];

for (const [source, text, scope, nth] of cases) {
  test(`grammar: \`${text}\` in ${source}`, () => {
    expect(scopeOf(source, text, nth)).toBe(scope);
  });
}

test("grammar: every .kl file in the repository ends outside any region, with no illegal tokens", async () => {
  // Cases that are meant to contain illegal syntax.
  const allowIllegal = new Set(["tests/errors/foreign-strings.kl", "tests/errors/reserved.kl", "tests/errors/regex.kl"]);
  // Cases about unclosed delimiters.
  const allowOpen = new Set(["tests/errors/recovery.kl", "tests/errors/unclosed-paren.kl"]);
  const files = [
    ...(await Array.fromAsync(new Bun.Glob("{examples,tests,src}/**/*.kl").scan({ cwd: root }))),
  ].filter((f) => !f.includes("/out/") && !f.includes(".test-out"));
  expect(files.length).toBeGreaterThan(40);
  const problems: string[] = [];
  for (const file of files) {
    const { lines, end } = tokenize(await Bun.file(join(root, file)).text());
    if (!allowOpen.has(file) && end !== INITIAL && (end as unknown as { depth: number }).depth > 1) problems.push(`${file}: region left open at end of file`);
    if (allowIllegal.has(relative(root, join(root, file)))) continue;
    lines.forEach((toks, i) => {
      for (const t of toks) if (t.scopes.some((s) => s.startsWith("invalid.illegal"))) problems.push(`${file}:${i + 1}: illegal \`${t.text}\``);
    });
  }
  expect(problems).toEqual([]);
});
