import type { DiagnosticBag } from "./diagnostics.ts";
import { type SourceFile, type Span, span } from "./source.ts";

export type TokenKind = "ident" | "keyword" | "number" | "string" | "template" | "regex" | "punct" | "eof";

export type TemplatePart = { kind: "text"; value: string; span: Span } | { kind: "expr"; tokens: Token[]; span: Span };

export interface Token {
  kind: TokenKind;
  /** Identifier/keyword name, punctuator text, cooked string value, or raw number text. */
  value: string;
  span: Span;
  /** A line break occurs between the previous token and this one (for ASI). */
  nl: boolean;
  /** Template string parts. */
  parts?: TemplatePart[];
  /** Regex pattern and flags. */
  pattern?: string;
  flags?: string;
}

/** Reserved keywords (A0). */
export const KEYWORDS = new Set([
  // structure
  "package", "import", "class", "interface", "enum", "typedef", "extends", "implements",
  // declarations
  "function", "var", "const", "final", "using",
  // modifiers
  "public", "private", "protected", "internal", "static", "inline", "constexpr", "consteval", "abstract", "override", "dynamic", "async", "native",
  // control flow
  "if", "else", "switch", "case", "default", "while", "do", "for", "in", "break", "continue", "return",
  // exceptions
  "throw", "try", "catch", "finally",
  // expressions
  "new", "this", "super", "is", "as", "typeof", "delete", "await", "nameof", "unconst",
  // literals
  "true", "false", "null", "undefined",
  // types
  "void",
  // reserved for future use
  "namespace", "use", "with", "yield", "let", "goto",
]);

/** Words with syntax meaning only in particular positions, while remaining usable as identifiers. */
export const CONTEXTUAL_KEYWORDS = new Set([
  "get", "set", "operator", "from", "of", "step", "defer", "out",
]);

/** Punctuators, longest first so the greedy match is correct. */
const PUNCTUATORS = [
  ">>>=",
  "...", "..=", "===", "!==", "**=", "<<=", ">>=", ">>>", "&&=", "||=", "??=",
  "=>", "->", "..", "?.", "??", "==", "!=", "<=", ">=", "&&", "||", "++", "--", "::",
  "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "**", "<<", ">>",
  "{", "}", "(", ")", "[", "]", ";", ",", "<", ">", "+", "-", "*", "/", "%",
  "&", "|", "^", "!", "~", "?", ":", "=", ".", "@",
];

const REGEX_FLAGS = new Set("dgimsuvy");

const isDigit = (c: string) => c >= "0" && c <= "9";
const isHex = (c: string) => /[0-9a-fA-F]/.test(c);
const isIdentStart = (c: string) => /[\p{L}_$]/u.test(c);
const isIdentPart = (c: string) => /[\p{L}\p{N}_$]/u.test(c);

export function lex(file: SourceFile, diags: DiagnosticBag): Token[] {
  return new Lexer(file, diags).run();
}

class Lexer {
  private pos = 0;
  private readonly text: string;

  constructor(
    private file: SourceFile,
    private diags: DiagnosticBag,
  ) {
    this.text = file.text;
  }

  run(): Token[] {
    const tokens: Token[] = [];
    for (;;) {
      const t = this.next();
      tokens.push(t);
      if (t.kind === "eof") return tokens;
    }
  }

  private sp(start: number, end = this.pos): Span {
    return span(this.file, start, end);
  }

  private peek(offset = 0): string {
    return this.text[this.pos + offset] ?? "";
  }

  /** Skips whitespace and comments; returns true if a newline was crossed. */
  private skipTrivia(): boolean {
    let nl = false;
    while (this.pos < this.text.length) {
      const c = this.peek();
      if (c === "\n") {
        nl = true;
        this.pos++;
      } else if (c === " " || c === "\t" || c === "\r" || c === "\f" || c === "\v" || c === "﻿") {
        this.pos++;
      } else if (c === "/" && this.peek(1) === "/") {
        while (this.pos < this.text.length && this.peek() !== "\n") this.pos++;
      } else if (c === "/" && this.peek(1) === "*") {
        const start = this.pos;
        this.pos += 2;
        while (this.pos < this.text.length && !(this.peek() === "*" && this.peek(1) === "/")) {
          if (this.peek() === "\n") nl = true;
          this.pos++;
        }
        if (this.pos >= this.text.length) {
          this.diags.error("X0363", "unterminated block comment", this.sp(start, start + 2), "comment starts here");
        } else {
          this.pos += 2;
        }
      } else {
        break;
      }
    }
    return nl;
  }

  next(): Token {
    const nl = this.skipTrivia();
    const start = this.pos;
    if (this.pos >= this.text.length) return { kind: "eof", value: "", span: this.sp(start), nl };

    const c = this.peek();

    if (c === "$" && this.text.startsWith("'''", this.pos + 1)) return this.textBlock(start, nl, true);
    if (c === "'" && this.text.startsWith("'''", this.pos)) return this.textBlock(start, nl, false);
    if (c === "$" && this.peek(1) === "'") return this.template(start, nl);
    if (c === "'") return this.string(start, nl);
    if (c === '"' || c === "`") return this.foreignString(start, nl);
    if (c === "~" && this.peek(1) === "/") return this.regex(start, nl);
    if (isDigit(c) || (c === "." && isDigit(this.peek(1)))) return this.number(start, nl);

    if (isIdentStart(c)) {
      while (this.pos < this.text.length && isIdentPart(this.peek())) this.pos++;
      const value = this.text.slice(start, this.pos);
      return { kind: KEYWORDS.has(value) ? "keyword" : "ident", value, span: this.sp(start), nl };
    }

    for (const p of PUNCTUATORS) {
      if (this.text.startsWith(p, this.pos)) {
        // `?.5` is a ternary followed by a number, as in JS.
        if (p === "?." && isDigit(this.peek(2))) continue;
        this.pos += p.length;
        return { kind: "punct", value: p, span: this.sp(start), nl };
      }
    }

    this.pos++;
    this.diags.error("X0364", `unexpected character \`${c}\``, this.sp(start));
    return this.next();
  }

  private number(start: number, nl: boolean): Token {
    if (this.peek() === "0" && /[xXbBoO]/.test(this.peek(1))) {
      const radix = this.peek(1).toLowerCase();
      this.pos += 2;
      const valid = radix === "x" ? isHex : radix === "b" ? (c: string) => c === "0" || c === "1" : (c: string) => c >= "0" && c <= "7";
      const digitsStart = this.pos;
      while (valid(this.peek()) || this.peek() === "_") this.pos++;
      if (this.pos === digitsStart) this.diags.error("X0365", "missing digits after number prefix", this.sp(start));
    } else {
      this.digits();
      // Fraction, but not a range operator: `0..10` is `0` `..` `10`.
      if (this.peek() === "." && this.peek(1) !== "." && isDigit(this.peek(1))) {
        this.pos++;
        this.digits();
      }
      if (/[eE]/.test(this.peek()) && (isDigit(this.peek(1)) || (/[+-]/.test(this.peek(1)) && isDigit(this.peek(2))))) {
        this.pos += /[+-]/.test(this.peek(1)) ? 2 : 1;
        this.digits();
      }
    }
    if (isIdentStart(this.peek())) {
      const badStart = this.pos;
      while (isIdentPart(this.peek())) this.pos++;
      this.diags.error("X0365", "invalid number literal", this.sp(start), "identifier characters directly after a number")
        .secondary(this.sp(badStart));
    }
    return { kind: "number", value: this.text.slice(start, this.pos), span: this.sp(start), nl };
  }

  private digits() {
    while (isDigit(this.peek()) || (this.peek() === "_" && isDigit(this.peek(1)))) this.pos++;
  }

  /** Reads one escape sequence (after the backslash) and returns the cooked text. */
  private escape(): string {
    const escStart = this.pos - 1;
    const c = this.peek();
    this.pos++;
    switch (c) {
      case "n": return "\n";
      case "r": return "\r";
      case "t": return "\t";
      case "0": return "\0";
      case "b": return "\b";
      case "f": return "\f";
      case "v": return "\v";
      case "'": case "\\": case "{": case "}": case '"': case "`": case "$":
        return c;
      case "x": {
        const hex = this.text.slice(this.pos, this.pos + 2);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          this.pos += 2;
          return String.fromCharCode(parseInt(hex, 16));
        }
        break;
      }
      case "u": {
        if (this.peek() === "{") {
          const close = this.text.indexOf("}", this.pos);
          const hex = close < 0 ? "" : this.text.slice(this.pos + 1, close);
          if (/^[0-9a-fA-F]{1,6}$/.test(hex) && parseInt(hex, 16) <= 0x10ffff) {
            this.pos = close + 1;
            return String.fromCodePoint(parseInt(hex, 16));
          }
        } else {
          const hex = this.text.slice(this.pos, this.pos + 4);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            this.pos += 4;
            return String.fromCharCode(parseInt(hex, 16));
          }
        }
        break;
      }
      case "\n": case "":
        this.pos--;
        return "";
    }
    this.diags.error("X0361", `unknown escape sequence \`\\${c}\``, this.sp(escStart, this.pos));
    return c;
  }

  private unterminated(start: number) {
    this.diags.error("X0362", "unterminated string", this.sp(start, start + 1), "string starts here")
      .note("`'…'` strings can't span lines; use `\\n` for a line break, or a multi-line `'''` string");
  }

  private string(start: number, nl: boolean): Token {
    this.pos++; // opening quote
    let value = "";
    for (;;) {
      const c = this.peek();
      if (c === "" || c === "\n") {
        this.unterminated(start);
        break;
      }
      this.pos++;
      if (c === "'") break;
      value += c === "\\" ? this.escape() : c;
    }
    return { kind: "string", value, span: this.sp(start), nl };
  }

  private template(start: number, nl: boolean): Token {
    this.pos += 2; // $'
    const parts: TemplatePart[] = [];
    let text = "";
    let textStart = this.pos;
    const flushText = () => {
      if (text !== "") parts.push({ kind: "text", value: text, span: this.sp(textStart) });
      text = "";
    };
    for (;;) {
      const c = this.peek();
      if (c === "" || c === "\n") {
        this.unterminated(start);
        break;
      }
      if (c === "'") {
        flushText();
        this.pos++;
        break;
      }
      if (c === "{") {
        flushText();
        this.pos++;
        parts.push(this.interpolation(this.pos - 1));
        textStart = this.pos;
        continue;
      }
      this.pos++;
      text += c === "\\" ? this.escape() : c;
    }
    return { kind: "template", value: "", parts, span: this.sp(start), nl };
  }

  /**
   * A multi-line string, `'''` or `$'''` (with `{expr}`s), as Java's text blocks: the text starts on
   * the line after the opening quotes and ends before the closing ones. Indentation shared by its
   * lines (and the line of the closing quotes) is removed, as is whitespace at line ends; a line
   * break before the closing quotes stays. Escapes and interpolations are never stripped: only
   * whitespace written in the source is.
   */
  private textBlock(start: number, nl: boolean, template: boolean): Token {
    this.pos += template ? 4 : 3;
    // The opening quotes end their line.
    const rest = /^[ \t]*(\r?\n|$)/.exec(this.text.slice(this.pos));
    if (!rest || rest[1] === "") {
      const at = this.sp(start, this.pos);
      const lineStart = this.text.lastIndexOf("\n", start) + 1;
      const indent = /^[ \t]*/.exec(this.text.slice(lineStart))![0];
      this.diags.error("X0368", "a `'''` string starts on the line after its opening quotes", at, "text follows here")
        .help("start a new line after the quotes", [{ span: this.sp(this.pos, this.pos), text: `\n${indent}  ` }]);
    } else {
      this.pos += rest[0].length;
    }
    type Chunk = { kind: "raw" | "esc"; value: string; start: number } | { kind: "expr"; part: TemplatePart & { kind: "expr" } };
    const lines: Chunk[][] = [[]];
    const line = () => lines[lines.length - 1]!;
    const raw = (ch: string) => {
      const last = line().at(-1);
      if (last?.kind === "raw") last.value += ch;
      else line().push({ kind: "raw", value: ch, start: this.pos - 1 });
    };
    let closed = false;
    for (;;) {
      const c = this.peek();
      if (c === "") break;
      if (this.text.startsWith("'''", this.pos)) {
        this.pos += 3;
        closed = true;
        break;
      }
      this.pos++;
      if (c === "\r" && this.peek() === "\n") continue;
      if (c === "\n") {
        lines.push([]);
        continue;
      }
      if (c === "\\") {
        const escStart = this.pos - 1;
        line().push({ kind: "esc", value: this.escape(), start: escStart });
        continue;
      }
      if (template && c === "{") {
        line().push({ kind: "expr", part: this.interpolation(this.pos - 1) });
        continue;
      }
      raw(c);
    }
    if (!closed) {
      this.diags.error("X0362", "unterminated string", this.sp(start, start + (template ? 4 : 3)), "string starts here")
        .note("a `'''` string ends with `'''`");
    }

    // The closing quotes on their own line set the indentation and add no text.
    const blank = (l: Chunk[]) => l.every((ch) => ch.kind === "raw" && ch.value.trim() === "");
    const lead = (l: Chunk[]) => l[0]?.kind === "raw" ? /^[ \t]*/.exec(l[0].value)![0].length : 0;
    const last = lines[lines.length - 1]!;
    const closingAlone = closed && blank(last);
    const measured = lines.filter((l, i) => !blank(l) || (closingAlone && i === lines.length - 1));
    const indent = measured.length === 0 ? 0 : Math.min(...measured.map(lead));
    if (closingAlone) lines.pop();

    const parts: TemplatePart[] = [];
    let text = "";
    let textStart = start;
    const flush = () => {
      if (text !== "") parts.push({ kind: "text", value: text, span: this.sp(textStart, Math.max(textStart, this.pos)) });
      text = "";
    };
    lines.forEach((l, i) => {
      if (i > 0) text += "\n";
      // Whitespace at the end of a line goes, unless an escape or interpolation follows it.
      const tail = l.at(-1);
      if (tail?.kind === "raw") tail.value = tail.value.replace(/[ \t]+$/, "");
      l.forEach((ch, j) => {
        if (ch.kind === "expr") {
          flush();
          parts.push(ch.part);
          textStart = ch.part.span.end;
          return;
        }
        if (text === "") textStart = ch.start;
        text += j === 0 && ch.kind === "raw" ? ch.value.slice(Math.min(indent, lead(l))) : ch.value;
      });
    });
    if (closingAlone && lines.length > 0) text += "\n";
    flush();
    if (template) return { kind: "template", value: "", parts, span: this.sp(start), nl };
    return { kind: "string", value: parts.map((p) => (p.kind === "text" ? p.value : "")).join(""), span: this.sp(start), nl };
  }

  /** `{expr}` in a template string, from its `{` (at `exprStart`, already consumed) to the matching `}`. */
  private interpolation(exprStart: number): TemplatePart & { kind: "expr" } {
    const tokens: Token[] = [];
    let depth = 0;
    for (;;) {
      const t = this.next();
      if (t.kind === "eof") {
        this.diags.error("X0366", "unclosed `{` in template string", this.sp(exprStart, exprStart + 1), "interpolation starts here");
        tokens.push(t);
        break;
      }
      if (t.kind === "punct" && t.value === "{") depth++;
      if (t.kind === "punct" && t.value === "}") {
        if (depth === 0) break;
        depth--;
      }
      tokens.push(t);
    }
    const exprSpan = this.sp(exprStart);
    if (tokens.length === 0) this.diags.error("X0367", "empty interpolation in template string", exprSpan);
    tokens.push({ kind: "eof", value: "", span: this.sp(this.pos - 1, this.pos - 1), nl: false });
    return { kind: "expr", tokens, span: exprSpan };
  }

  /** `"…"` and `` `…` `` are not Xenon strings: report with a fix-it, then recover. */
  private foreignString(start: number, nl: boolean): Token {
    const quote = this.peek();
    this.pos++;
    let raw = "";
    let value = "";
    for (;;) {
      const c = this.peek();
      if (c === "" || (c === "\n" && quote === '"')) break;
      this.pos++;
      if (c === quote) break;
      if (c === "\\") {
        const escStart = this.pos;
        value += this.escape();
        raw += "\\" + this.text.slice(escStart, this.pos);
      } else {
        value += c;
        raw += c;
      }
    }
    const s = this.sp(start);
    if (quote === '"') {
      const fixed = "'" + raw.replace(/(?<!\\)'/g, "\\'").replace(/\\"/g, '"') + "'";
      this.diags.error("X0360", "strings use single quotes in Xenon", s, "double-quoted string")
        .help("use single quotes", [{ span: s, text: fixed }]);
      return { kind: "string", value, span: s, nl };
    }
    const fixed = "$'" + raw.replace(/(?<!\\)'/g, "\\'").replace(/\$\{/g, "{") + "'";
    this.diags.error("X0360", "template strings are written `$'…{expr}…'` in Xenon", s, "backtick string")
      .help("use a `$'…'` template string", [{ span: s, text: fixed }]);
    return { kind: "string", value, span: s, nl };
  }

  private regex(start: number, nl: boolean): Token {
    this.pos += 2; // ~/
    const patternStart = this.pos;
    let inClass = false;
    let closed = false;
    while (this.pos < this.text.length) {
      const c = this.peek();
      if (c === "\n") break;
      if (c === "\\") {
        this.pos += 2;
        continue;
      }
      if (c === "[") inClass = true;
      else if (c === "]") inClass = false;
      else if (c === "/" && !inClass) {
        closed = true;
        break;
      }
      this.pos++;
    }
    const pattern = this.text.slice(patternStart, this.pos);
    if (!closed) {
      this.diags.error("X0352", "unterminated regular expression", this.sp(start, start + 2), "regex starts here");
      return { kind: "regex", value: pattern, pattern, flags: "", span: this.sp(start), nl };
    }
    this.pos++; // closing /
    const flagsStart = this.pos;
    while (/[a-zA-Z]/.test(this.peek())) this.pos++;
    const flags = this.text.slice(flagsStart, this.pos);

    let flagsOk = true;
    const seen = new Set<string>();
    for (let i = 0; i < flags.length; i++) {
      const f = flags[i]!;
      const fs = this.sp(flagsStart + i, flagsStart + i + 1);
      if (!REGEX_FLAGS.has(f)) {
        this.diags.error("X0350", `unknown regular expression flag \`${f}\``, fs).note("valid flags are d g i m s u v y");
        flagsOk = false;
      } else if (seen.has(f)) {
        this.diags.error("X0350", `duplicate regular expression flag \`${f}\``, fs);
        flagsOk = false;
      }
      seen.add(f);
    }
    if (flagsOk) {
      try {
        new RegExp(pattern, flags);
      } catch (e) {
        const msg = e instanceof Error ? e.message.replace(/^Invalid regular expression: /, "") : String(e);
        this.diags.error("X0351", "invalid regular expression", this.sp(patternStart, patternStart + pattern.length), msg);
      }
    }
    return { kind: "regex", value: `/${pattern}/${flags}`, pattern, flags, span: this.sp(start), nl };
  }
}
