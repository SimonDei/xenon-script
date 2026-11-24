import type * as A from "./ast.ts";
import type { DiagnosticBag } from "./diagnostics.ts";
import { lex, type Token } from "./lexer.ts";
import { cover, type SourceFile, type Span, span } from "./source.ts";

class ParseError extends Error {}

const MODIFIERS = new Set(["public", "private", "protected", "internal", "static", "final", "override", "inline", "constexpr", "consteval", "abstract", "dynamic", "async", "native"]);
const VISIBILITY = new Set(["public", "private", "protected", "internal"]);

/**
 * The statement an expression body stands for: `return expr` when the method returns a value,
 * the expression alone for `void`, `Void`, `Promise<void>`, setters and constructors.
 */
function exprBodyStatement(expr: A.Expr, returnType: A.TypeNode | undefined, accessor: "get" | "set" | undefined, isConstructor: boolean): A.Stmt {
  const isVoid = (t: A.TypeNode | undefined): boolean =>
    t?.kind === "VoidType" || (t?.kind === "TypeName" && t.name.length === 1 && t.name[0]!.name === "Void");
  const promiseOfVoid = returnType?.kind === "TypeName" && returnType.name.at(-1)?.name === "Promise" && isVoid(returnType.args[0]);
  if (accessor === "set" || isConstructor || isVoid(returnType) || promiseOfVoid) return { kind: "ExprStmt", expr, span: expr.span };
  return { kind: "Return", value: expr, span: expr.span };
}

/**
 * Tokens after which a `?` that follows a type is the nullable suffix (`int?`), not a conditional:
 * they end a type, or can't start an expression (`x as int? ?? 0`, `x as int? == null`).
 */
const TYPE_FOLLOW = new Set(["=", ")", ",", ">", ">>", ">>>", "]", "{", "}", ";", "->", "const", "=>", "??", "==", "!=", "===", "!==", "&&", "||", ":", "|"]);
const ASSIGN_OPS = new Set(["=", "+=", "-=", "*=", "/=", "%=", "**=", "<<=", ">>=", ">>>=", "&=", "|=", "^=", "&&=", "||=", "??="]);

/** Binary operator precedence (higher binds tighter). */
const BINARY_PREC: Record<string, number> = {
  "??": 1,
  "||": 2,
  "&&": 3,
  "|": 4,
  "^": 5,
  "&": 6,
  "==": 7, "!=": 7, "===": 7, "!==": 7,
  "<": 8, ">": 8, "<=": 8, ">=": 8, in: 8, is: 8, as: 8,
  "<<": 9, ">>": 9, ">>>": 9,
  "+": 10, "-": 10,
  "*": 11, "/": 11, "%": 11,
  "**": 12,
};

/**
 * How a project ends statements (`"semicolons"` in xenon.json, `--semicolons`): `always` warns about a
 * statement ended by a line break, `never` about a `;` at the end of a line; `any` (the default)
 * accepts both. A `;` between two statements on one line is always needed.
 */
export type SemicolonStyle = "always" | "never" | "any";

export function parseFile(file: SourceFile, diags: DiagnosticBag, semicolons: SemicolonStyle = "any"): A.XenonFile {
  const tokens = lex(file, diags);
  // The prelude and generated declarations have their own style.
  const style = file.prelude || file.generated ? "any" : semicolons;
  return new Parser(tokens, file, diags, style).parseFile();
}

export class Parser {
  private i = 0;
  /** Nesting depth of `do` bodies (a statement there may end right before `while`). */
  private doBody = 0;

  constructor(
    private tokens: Token[],
    private file: SourceFile,
    private diags: DiagnosticBag,
    private semicolons: SemicolonStyle = "any",
  ) {}

  /* ----------------------------- helpers ----------------------------- */

  private get tok(): Token {
    return this.tokens[this.i]!;
  }

  private peekTok(n = 1): Token {
    return this.tokens[Math.min(this.i + n, this.tokens.length - 1)]!;
  }

  private get prevEnd(): number {
    return this.i > 0 ? this.tokens[this.i - 1]!.span.end : 0;
  }

  private atEof(): boolean {
    return this.tok.kind === "eof";
  }

  private advance(): Token {
    const t = this.tok;
    if (t.kind !== "eof") this.i++;
    return t;
  }

  private is(value: string, t: Token = this.tok): boolean {
    return (t.kind === "punct" || t.kind === "keyword") && t.value === value;
  }

  private isIdent(value?: string, t: Token = this.tok): boolean {
    return t.kind === "ident" && (value === undefined || t.value === value);
  }

  private eat(value: string): Token | undefined {
    if (this.is(value)) return this.advance();
    return undefined;
  }

  private describe(t: Token): string {
    switch (t.kind) {
      case "eof": return "end of file";
      case "string": return "a string";
      case "template": return "a template string";
      case "number": return `number \`${t.value}\``;
      case "regex": return "a regular expression";
      case "keyword": return `keyword \`${t.value}\``;
      default: return `\`${t.value}\``;
    }
  }

  private fail(message: string, at: Span = this.tok.span, label?: string): never {
    this.diags.error("X0100", message, at, label);
    throw new ParseError(message);
  }

  private unexpected(expected: string): never {
    this.fail(`expected ${expected}, found ${this.describe(this.tok)}`, this.tok.span, `expected ${expected}`);
  }

  private expect(value: string): Token {
    if (this.is(value)) return this.advance();
    this.unexpected(`\`${value}\``);
  }

  /** Expects a closing delimiter and points back at its opener when missing. */
  private expectClose(close: string, open: Token): Token {
    if (this.is(close)) return this.advance();
    const found = this.describe(this.tok);
    const d = this.diags.error("X0101", `expected \`${close}\`, found ${found}`, this.tok.span, `expected \`${close}\``);
    d.secondary(open.span, `unclosed \`${open.value}\` opened here`);
    throw new ParseError("unclosed");
  }

  private ident(what = "an identifier"): A.Ident {
    const t = this.tok;
    if (t.kind === "ident") {
      this.advance();
      return { name: t.value, span: t.span };
    }
    if (t.kind === "keyword") {
      this.fail(`\`${t.value}\` is a reserved keyword and can't be used as a name`, t.span, "reserved keyword");
    }
    this.unexpected(what);
  }

  private sp(start: number): Span {
    return span(this.file, start, Math.max(start, this.prevEnd));
  }

  /** Statement terminator: `;`, a line break, `}` or end of file (ASI). */
  private endStatement() {
    const semi = this.tok;
    if (this.eat(";")) {
      // `"semicolons": "never"`: a `;` that a line break, `}` or the end would replace.
      if (this.semicolons === "never" && (this.tok.nl || this.is("}") || this.tok.kind === "eof")) {
        this.diags.error("X0885", "unnecessary `;`", semi.span, "the line break ends the statement")
          .help("remove it (the project's style is `\"semicolons\": \"never\"`)", [{ span: semi.span, text: "" }]);
      }
      return;
    }
    if (this.tok.nl || this.is("}") || this.tok.kind === "eof") {
      // `"semicolons": "always"`: every statement ends with `;`.
      if (this.semicolons === "always") {
        const at = span(this.file, this.prevEnd, this.prevEnd);
        this.diags.error("X0884", "missing `;`", at, "add `;` here")
          .help("end the statement with `;` (the project's style is `\"semicolons\": \"always\"`)", [{ span: at, text: ";" }]);
      }
      return;
    }
    if (this.doBody > 0 && this.is("while")) return;
    const prev = this.tokens[this.i - 1];
    const at = prev ? span(this.file, prev.span.end, prev.span.end) : this.tok.span;
    this.diags.error("X0102", `expected \`;\` or a line break, found ${this.describe(this.tok)}`, this.tok.span, "unexpected token")
      .help("end the statement here", [{ span: at, text: ";" }]);
    throw new ParseError("terminator");
  }

  /* ------------------------------ files ------------------------------ */

  parseFile(): A.XenonFile {
    const result: A.XenonFile = { file: this.file, packageName: [], imports: [], decls: [], privateDecls: [], functions: [] };
    if (!this.is("package")) {
      const dir = this.file.path.includes("/") ? this.file.path.slice(0, this.file.path.lastIndexOf("/")) : "";
      if (dir === "") return this.parseRootFile(result);
      // Files in folders must say their package (only the top-level package may be left out).
      const pkg = dir.split("/").join(".");
      const text = this.file.text;
      this.diags.error("X0010", "expected a `package` block", this.tok.span, `this file is in the folder \`${dir}/\``)
        .note("only files directly in the source root may leave out the package block")
        .help(`wrap the file in its package`, [
          { span: span(this.file, 0, 0), text: `package ${pkg} {\n` },
          { span: span(this.file, text.length, text.length), text: `${text.endsWith("\n") ? "" : "\n"}}\n` },
        ]);
      // Recover: read the file as if it were wrapped in that package, so its classes still exist
      // (no follow-up "cannot find" errors in files that import them).
      result.packageName = dir.split("/").map((name) => ({ name, span: span(this.file, 0, 0) }));
      return this.parseRootFile(result);
    }
    const pkgTok = this.advance();
    try {
      while (this.tok.kind === "ident") {
        result.packageName.push(this.ident());
        if (!this.eat(".")) break;
      }
      result.packageSpan = this.sp(pkgTok.span.start);
      const open = this.expect("{");
      while (!this.is("}") && this.tok.kind !== "eof") {
        const start = this.i;
        try {
          if (this.is("import")) result.imports.push(this.parseImport());
          else this.addDecl(result, this.parseTypeDecl(), result.decls);
        } catch (e) {
          if (!(e instanceof ParseError)) throw e;
          this.syncTopLevel(start);
        }
      }
      this.expectClose("}", open);
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      return result;
    }
    while (this.tok.kind !== "eof") {
      const start = this.i;
      try {
        if (this.is("import")) {
          this.fail("imports must be inside the `package` block", this.tok.span);
        }
        this.addDecl(result, this.parseTypeDecl(), result.privateDecls);
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        this.syncTopLevel(start);
      }
    }
    return result;
  }

  /**
   * A file directly in the source root may leave out `package { … }`: imports and declarations
   * then sit at the top level. The declaration named after the file is the file's (package-level)
   * declaration; any others are file-private, as if they followed a package block.
   */
  private parseRootFile(result: A.XenonFile): A.XenonFile {
    const fileName = this.file.path.replace(/^.*\//, "").replace(/\.xn$/, "");
    while (this.tok.kind !== "eof") {
      const start = this.i;
      try {
        if (this.is("import")) result.imports.push(this.parseImport());
        else if (this.is("package")) this.fail("a file without a package block can't have one later", this.tok.span, "move the declarations above into it, or remove it");
        else {
          const decl = this.parseTypeDecl();
          if (decl.kind === "Method") result.functions.push(decl);
          else if (decl.name.name === fileName && result.decls.length === 0) result.decls.push(decl);
          else result.privateDecls.push(decl);
        }
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        // No package block to close here: a `}` is part of the broken code, keep skipping.
        do this.syncTopLevel(start); while (this.is("}") && this.advance());
      }
    }
    // No declaration named after the file: take the first `public` one as the file's declaration,
    // so the usual file-name check reports it.
    if (result.decls.length === 0) {
      const pub = result.privateDecls.findIndex((d) => d.modifiers.visibility?.value === "public");
      if (pub >= 0) result.decls.push(...result.privateDecls.splice(pub, 1));
    }
    return result;
  }

  /** A package-level function goes to `functions`, anything else to `into`. */
  private addDecl(result: A.XenonFile, decl: A.TypeDecl | A.Method, into: A.TypeDecl[]) {
    if (decl.kind === "Method") result.functions.push(decl);
    else into.push(decl);
  }

  private syncTopLevel(start: number) {
    if (this.i === start) this.advance();
    while (this.tok.kind !== "eof" && !this.is("}")) {
      if (this.is("import") || this.is("class") || (this.tok.nl && MODIFIERS.has(this.tok.value) && this.tok.kind === "keyword")) return;
      this.advance();
    }
  }

  private parseImport(): A.Import {
    const start = this.advance().span.start; // import
    // JS forms: import 'm' | import x from 'm' | import { a as b } from 'm' | import * as ns from 'm'
    if (this.tok.kind === "string") {
      const module = this.advance().value;
      this.endStatement();
      return { kind: "JsImport", named: [], module, span: this.sp(start) };
    }
    if (this.is("{") || this.is("*") || (this.tok.kind === "ident" && (this.isIdent("from", this.peekTok()) || this.is(",", this.peekTok())))) {
      const imp: A.JsImport = { kind: "JsImport", named: [], module: "", span: this.tok.span };
      if (this.tok.kind === "ident") {
        imp.defaultName = this.ident();
        if (!this.eat(",")) return this.finishJsImport(imp, start);
      }
      if (this.eat("*")) {
        this.expect("as");
        imp.namespace = this.ident();
      } else {
        const open = this.expect("{");
        while (!this.is("}")) {
          const name = this.ident();
          let alias: A.Ident | undefined;
          if (this.is("as")) {
            this.advance();
            alias = this.ident();
          }
          imp.named.push({ name, alias });
          if (!this.eat(",")) break;
        }
        this.expectClose("}", open);
      }
      return this.finishJsImport(imp, start);
    }
    // Xenon form: import com.zoo.Dog; / import com.zoo.*;
    const path: A.Ident[] = [this.ident("a package path or a JS module")];
    let wildcard = false;
    while (this.eat(".")) {
      if (this.eat("*")) {
        wildcard = true;
        break;
      }
      path.push(this.ident());
    }
    this.endStatement();
    return { kind: "XenonImport", path, wildcard, span: this.sp(start) };
  }

  private finishJsImport(imp: A.JsImport, start: number): A.JsImport {
    if (!this.isIdent("from")) this.unexpected("`from`");
    this.advance();
    if (this.tok.kind !== "string") this.unexpected("a module name string");
    imp.module = this.advance().value;
    imp.span = this.sp(start);
    this.endStatement();
    return imp;
  }

  private parseModifiers(allowFinalDecl: boolean): A.Modifiers {
    const mods: A.Modifiers = {};
    while (this.tok.kind === "keyword" && MODIFIERS.has(this.tok.value)) {
      // `final name:T` is a declaration, not a modifier.
      if (allowFinalDecl && this.tok.value === "final" && this.peekTok().kind === "ident") break;
      const t = this.advance();
      const v = t.value as keyof A.Modifiers;
      if (t.value === "native" && this.is("(")) {
        // `native('JsName')`: the JS name differs from the Xenon name.
        const open = this.advance();
        const nameTok = this.advance();
        if (nameTok.kind !== "string") {
          this.i--;
          this.unexpected("the JavaScript name as a string");
        }
        mods.nativeName = nameTok.value;
        this.expectClose(")", open);
      }
      if (VISIBILITY.has(t.value)) {
        if (mods.visibility) {
          this.diags.error("X0103", "multiple visibility modifiers", t.span).secondary(mods.visibility.span, "first visibility modifier");
        }
        mods.visibility = { value: t.value as "public", span: t.span };
      } else {
        if (mods[v]) this.diags.error("X0104", `duplicate modifier \`${t.value}\``, t.span);
        (mods as Record<string, Span>)[v] = t.span;
      }
    }
    return mods;
  }

  private parseTypeDecl(): A.TypeDecl | A.Method {
    const attributes = this.parseAttributes();
    const decl = this.parseTypeDeclInner();
    if (attributes.length === 0) return decl;
    // The declaration's span covers its attributes (hover and completion find them inside it).
    decl.span = cover(attributes[0]!.span, decl.span);
    if (decl.kind === "Class" && !decl.isInterface && !decl.isEnum) decl.attributes = attributes;
    else this.misplacedAttributes(attributes, decl.kind === "Method" ? "a package-level function" : decl.kind === "Typedef" ? "a typedef" : decl.isEnum ? "an enum" : "an interface");
    return decl;
  }

  /** X0834 for attributes before a declaration that can't have any. */
  private misplacedAttributes(attributes: A.Attribute[], what: string) {
    const at = cover(attributes[0]!.span, attributes.at(-1)!.span);
    this.diags.error("X0834", `attributes can't be used on ${what}`, at, "not allowed here")
      .note("attributes can be used on classes, methods and fields");
  }

  /**
   * `[Name(args, prop = value), Other]`, possibly several brackets, before a declaration. Only
   * declarations can follow, so a `[` here is never an array literal.
   */
  private parseAttributes(): A.Attribute[] {
    const result: A.Attribute[] = [];
    while (this.is("[")) {
      const open = this.advance();
      do {
        const start = this.tok.span.start;
        const name: A.Ident[] = [this.ident("an attribute name")];
        while (this.eat(".")) name.push(this.ident("a name"));
        const typeName = { kind: "TypeName" as const, name, args: [], span: this.sp(start) };
        const args: A.Expr[] = [];
        const named: A.Attribute["named"] = [];
        if (this.is("(")) {
          const paren = this.advance();
          while (!this.is(")")) {
            // `verb = 'POST'`: a named value (after the positional ones).
            if (this.tok.kind === "ident" && this.is("=", this.peekTok())) {
              const nStart = this.tok.span.start;
              const n = this.ident();
              this.advance();
              named.push({ name: n, value: this.parseAssign(), span: this.sp(nStart) });
            } else {
              const arg = this.parseAssign();
              if (named.length > 0) this.diags.error("X0100", "positional attribute arguments come before named ones", arg.span, "after a named argument");
              args.push(arg);
            }
            if (!this.eat(",")) break;
          }
          this.expectClose(")", paren);
        }
        result.push({ name: typeName, args, named, span: this.sp(start) });
      } while (this.eat(","));
      this.expectClose("]", open);
    }
    return result;
  }

  private parseTypeDeclInner(): A.TypeDecl | A.Method {
    const start = this.tok.span.start;
    const modifiers = this.parseModifiers(false);
    if (this.is("function")) return this.parseMethod(modifiers, start, ""); // package-level: checked in collectClasses (X0029)
    if (this.is("class")) return this.parseClass(modifiers, start);
    if (this.is("interface")) return this.parseInterface(modifiers, start);
    if (this.eat("typedef")) {
      const name = this.ident("a typedef name");
      const typeParams = this.typeParamList(false, true);
      this.expect("=");
      const type = this.parseType();
      this.endStatement();
      return { kind: "Typedef", modifiers, name, typeParams, type, span: this.sp(start) };
    }
    if (this.is("enum")) return this.parseEnum(modifiers, start);
    this.unexpected("a class declaration");
  }

  private parseClass(modifiers: A.Modifiers, start: number): A.ClassDecl {
    this.expect("class");
    const name = this.ident("a class name");
    const typeParams = this.typeParamList(true, true);
    let ext: A.TypeNode | undefined;
    const impls: A.TypeNode[] = [];
    if (this.eat("extends")) ext = this.parseType();
    if (this.eat("implements")) {
      do impls.push(this.parseType());
      while (this.eat(","));
    }
    const open = this.expect("{");
    const members: A.Member[] = [];
    while (!this.is("}") && this.tok.kind !== "eof") {
      const memberStart = this.i;
      try {
        const m = this.parseMember(name.name);
        // Members of a native class describe the JS API: public unless stated, never with code.
        if (modifiers.native && m.kind !== "StaticBlock") {
          if (!m.modifiers.visibility) m.modifiers.visibility = { value: "public", span: m.name.span };
          m.modifiers.native = modifiers.native;
        }
        members.push(m, ...this.extraMembers.splice(0));
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        this.extraMembers = [];
        this.syncMember(memberStart);
      }
    }
    this.expectClose("}", open);
    return { kind: "Class", modifiers, name, typeParams, extends: ext, implements: impls, members, span: this.sp(start) };
  }

  /**
   * `enum Name { A, B = 2, C }` / `enum Level { Low = 'low' }` — stored as a ClassDecl whose
   * members are static `const` fields of the enum type, plus a static `values():Array<Name>`.
   */
  private parseEnum(modifiers: A.Modifiers, start: number): A.ClassDecl {
    this.expect("enum");
    const name = this.ident("an enum name");
    const open = this.expect("{");
    const members: A.Member[] = [];
    const enumType = (span: Span): A.TypeNode => ({ kind: "TypeName", name: [name], args: [], span });
    while (!this.is("}") && !this.atEof()) {
      const mStart = this.tok.span.start;
      const memberName = this.ident("an enum member name");
      const init = this.eat("=") ? this.parseAssign() : undefined;
      members.push({
        kind: "Field",
        modifiers: { visibility: { value: "public", span: memberName.span }, static: memberName.span },
        decl: "const", name: memberName, type: enumType(memberName.span), init, span: this.sp(mStart),
      });
      if (!this.eat(",") && !this.tok.nl && !this.is("}")) this.unexpected("`,` or `}`");
    }
    this.expectClose("}", open);
    const span = this.sp(start);
    // A member named `values` is reported by the checker; don't add a clashing method then.
    if (!members.some((m) => m.kind === "Field" && m.name.name === "values")) members.push({
      kind: "Method",
      modifiers: { visibility: { value: "public", span: name.span }, static: name.span },
      name: { name: "values", span: name.span }, isConstructor: false, params: [],
      returnType: { kind: "TypeName", name: [{ name: "Array", span: name.span }], args: [enumType(name.span)], span: name.span },
      isConst: false, span: name.span,
    });
    return { kind: "Class", isEnum: true, modifiers, name, implements: [], members, span };
  }

  /** `interface Name extends A, B { function f():T; function get x():T }` — stored as a ClassDecl. */
  private parseInterface(modifiers: A.Modifiers, start: number): A.ClassDecl {
    this.expect("interface");
    const name = this.ident("an interface name");
    const typeParams = this.typeParamList(true, true);
    const supers: A.TypeNode[] = [];
    if (this.eat("extends")) {
      do supers.push(this.parseType());
      while (this.eat(","));
    }
    if (this.is("implements")) this.fail("interfaces `extend` other interfaces", this.tok.span, "use `extends`");
    const open = this.expect("{");
    const members: A.Member[] = [];
    while (!this.is("}") && this.tok.kind !== "eof") {
      const memberStart = this.i;
      try {
        const m = this.parseMember("");
        // Interface members are public; an explicit visibility other than `public` is reported by the checker.
        if (m.kind !== "StaticBlock" && !m.modifiers.visibility) m.modifiers.visibility = { value: "public", span: m.name.span };
        if (modifiers.native && m.kind !== "StaticBlock") m.modifiers.native = modifiers.native;
        members.push(m, ...this.extraMembers.splice(0));
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        this.extraMembers = [];
        this.syncMember(memberStart);
      }
    }
    this.expectClose("}", open);
    return { kind: "Class", isInterface: true, modifiers, name, typeParams, implements: supers, members, span: this.sp(start) };
  }

  private syncMember(start: number) {
    if (this.i === start) this.advance();
    let depth = 0;
    while (this.tok.kind !== "eof") {
      if (this.is("{")) depth++;
      if (this.is("}")) {
        if (depth === 0) return;
        depth--;
      }
      if (depth === 0 && this.tok.nl && this.tok.kind === "keyword" && (MODIFIERS.has(this.tok.value) || ["var", "const", "function"].includes(this.tok.value))) return;
      this.advance();
    }
  }

  /** Members a declaration produced besides the one it returned (a property's setter and storage). */
  private extraMembers: A.Member[] = [];

  /**
   * `var label:String = '' { get => …; set => … }`: the accessors, each `=> expr` or `=> { … }`. In
   * `set`, `value` is the new value. Inside the accessors the property's own name is its storage, a
   * private field (`$label`); a missing `get` reads it, a missing `set` writes it. Desugared here into
   * that field and a getter/setter pair, so the rest of the compiler sees ordinary members.
   */
  private parseProperty(modifiers: A.Modifiers, decl: A.Field["decl"], declSpan: Span, name: A.Ident, type: A.TypeNode | undefined, init: A.Expr | undefined, start: number): A.Member {
    const open = this.expect("{");
    type Half = { body: A.Block; expr: boolean };
    const halves: { get?: Half; set?: Half } = {};
    while (!this.is("}") && this.tok.kind !== "eof") {
      if (!this.isIdent("get") && !this.isIdent("set")) this.unexpected("`get =>` or `set =>`");
      const word = this.advance();
      const which = word.value as "get" | "set";
      if (halves[which]) this.diags.error("X0201", `\`${name.name}\` has two \`${which}\`s`, word.span, "declared twice");
      this.expect("=>");
      const bodyStart = this.tok.span.start;
      let body: A.Block;
      let expr = false;
      if (this.is("{")) body = this.parseBlock();
      else {
        const e = this.parseAssign();
        const stmt: A.Stmt = which === "set" ? { kind: "ExprStmt", expr: e, span: e.span } : { kind: "Return", value: e, span: e.span };
        body = { kind: "Block", body: [stmt], span: this.sp(bodyStart) };
        expr = true;
      }
      halves[which] = { body, expr };
      this.eat(";");
    }
    this.expectClose("}", open);
    const span = this.sp(start);
    if (decl !== "var") this.diags.error("X0886", "a property with `get`/`set` is declared with `var`", declSpan, `not \`${decl}\``);
    if (!type) {
      this.diags.error("X0886", `the property \`${name.name}\` needs a type`, name.span, "add `:Type` after the name");
      type = { kind: "AnyType", span: name.span }; // reported once, not again for each accessor
    }

    // Inside its accessors the property's name is its storage: `label = value` writes the field.
    const storage = `$${name.name}`;
    let uses = 0;
    const visit = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        for (const n of node) visit(n);
        return;
      }
      const n = node as Record<string, unknown> & { kind?: string };
      if (n.kind === "Ident" && n.name === name.name) {
        n.name = storage;
        uses++;
      } else if (n.kind === "Member" && (n.object as { kind?: string }).kind === "This" && (n.name as A.Ident).name === name.name) {
        n.name = { ...(n.name as A.Ident), name: storage };
        uses++;
      }
      for (const [k, v] of Object.entries(n)) if (k !== "span") visit(v);
    };
    visit(halves.get?.body);
    visit(halves.set?.body);
    const read = (): A.Expr => ({ kind: "Ident", name: storage, span: name.span });
    const needsStorage = !halves.get || !halves.set || uses > 0;
    if (!needsStorage && init) {
      this.diags.error("X0886", `\`${name.name}\` has no storage, so its initial value is never used`, init.span, "both accessors are given and neither uses the storage")
        .help(`read or write \`${name.name}\` inside an accessor, or remove the value`);
    }
    const getter: A.Method = {
      kind: "Method", modifiers: { ...modifiers }, name, accessor: "get", isConstructor: false, params: [], returnType: type, isConst: false,
      body: halves.get?.body ?? { kind: "Block", body: [{ kind: "Return", value: read(), span: name.span }], span: name.span },
      exprBody: halves.get?.expr ?? true, property: true, span,
    };
    const setter: A.Method = {
      kind: "Method", modifiers: { ...modifiers }, name, accessor: "set", isConstructor: false,
      params: [{ name: { name: "value", span: name.span }, type, rest: false, final: false, span: name.span }], isConst: false,
      body: halves.set?.body ?? {
        kind: "Block",
        body: [{ kind: "ExprStmt", expr: { kind: "Assign", op: "=", target: read(), value: { kind: "Ident", name: "value", span: name.span }, opSpan: name.span, span: name.span }, span: name.span }],
        span: name.span,
      },
      exprBody: halves.set?.expr ?? true, property: true, span,
    };
    this.extraMembers.push(setter);
    if (needsStorage) {
      const visibility = { value: "private" as const, span: name.span };
      this.extraMembers.push({
        kind: "Field", modifiers: { ...(modifiers.static ? { static: modifiers.static } : {}), visibility }, decl: "var",
        name: { name: storage, span: name.span }, type, init, span, storageOf: name.name,
      });
    }
    return getter;
  }

  private parseMember(className: string): A.Member {
    const attributes = this.parseAttributes();
    const member = this.parseMemberInner(className);
    if (attributes.length === 0) return member;
    member.span = cover(attributes[0]!.span, member.span);
    if (member.kind === "StaticBlock") this.misplacedAttributes(attributes, "a `static` block");
    else member.attributes = attributes;
    return member;
  }

  private parseMemberInner(className: string): A.Member {
    const start = this.tok.span.start;
    const modifiers = this.parseModifiers(true);

    if (modifiers.static && this.is("{")) {
      const others = Object.keys(modifiers).filter((k) => k !== "static");
      if (others.length > 0) this.fail("a `static` block can't have other modifiers", span(this.file, start, this.tok.span.start));
      return { kind: "StaticBlock", modifiers, body: this.parseBlock(), span: this.sp(start) };
    }

    if (this.is("var") || this.is("const") || this.is("final")) {
      const declTok = this.advance();
      const decl = declTok.value as A.Field["decl"];
      const name = this.memberName(); // keywords allowed, as in JS (`var default:int`)
      const type = this.eat(":") ? this.parseType() : undefined;
      const init = this.eat("=") ? this.parseExpr() : undefined;
      // `var label:String = '' { set => label = value.trim() }`: a property with accessors.
      if (this.is("{")) return this.parseProperty(modifiers, decl, declTok.span, name, type, init, start);
      this.endStatement();
      return { kind: "Field", modifiers, decl, name, type, init, span: this.sp(start) };
    }

    if (this.is("function")) return this.parseMethod(modifiers, start, className);

    if (this.is("~")) {
      // The old form `public ~Name()`: destructors are declared with `function`, like constructors.
      const tilde = this.tok.span;
      this.diags.error("X0810", "a destructor is declared with `function`", tilde, "expected `function` before `~`")
        .help("add `function`", [{ span: span(this.file, tilde.start, tilde.start), text: "function " }]);
      return this.parseDestructor(modifiers, start);
    }
    // `static constexpr LIMIT:int = 10`: a constant written like a C++ `constexpr` variable.
    const compileTime = modifiers.consteval ?? modifiers.constexpr;
    if (compileTime && this.tok.kind === "ident" && this.is(":", this.peekTok())) {
      this.diags.error("X0526", `\`${modifiers.consteval ? "consteval" : "constexpr"}\` is for functions`, compileTime, "not a function")
        .help(`a compile-time constant is \`inline final\`: \`static inline final ${this.tok.value}:…\``);
      throw new ParseError("constexpr field");
    }
    this.unexpected("a field or method declaration");
  }

  /** `function ~Name() { … }`, from the `~` (after its modifiers and `function`). */
  private parseDestructor(modifiers: A.Modifiers, start: number): A.Method {
    this.expect("~");
    const name = this.ident("the class name after `~`");
    const params = this.parseParams();
    const returnType = this.eat(":") ? this.parseType() : undefined;
    const body = this.parseBlock();
    return { kind: "Method", modifiers, name, isConstructor: false, isDestructor: true, params, returnType, isConst: false, body, span: this.sp(start) };
  }

  /** `function name<T>(…):R { … }` (or without a body), after its modifiers. */
  private parseMethod(modifiers: A.Modifiers, start: number, className: string): A.Method {
    this.advance();
    if (this.is("~")) return this.parseDestructor(modifiers, start);
    let accessor: "get" | "set" | undefined;
    if ((this.isIdent("get") || this.isIdent("set")) && (this.peekTok().kind === "ident" || this.peekTok().kind === "keyword")) {
      accessor = this.advance().value as "get" | "set";
    }
    let name: A.Ident;
    if (!className && !this.is("[") && this.tok.kind === "keyword") this.unexpected("a function name");
    if (this.is("[")) {
      const open = this.advance();
      if (!this.isIdent("Symbol")) this.unexpected("`Symbol`");
      this.advance();
      this.expect(".");
      const key = this.tok;
      if (key.kind !== "ident" && key.kind !== "keyword") this.unexpected("a Symbol property name");
      this.advance();
      const close = this.expect("]");
      name = { name: `[Symbol.${key.value}]`, span: cover(open.span, close.span) };
    } else name = this.memberName(); // keywords allowed, as in JS (`function catch(…)`)
    // `function operator+(…)`: an operator method; the symbol is part of the name.
    if (name.name === "operator" && this.tok.kind === "punct" && !this.is("(") && !this.tok.nl) {
      const sym = this.advance();
      name = { name: "operator" + sym.value, span: cover(name.span, sym.span) };
    }
    const typeParams = this.typeParamList();
    const params = this.parseParams();
    const returnType = this.eat(":") ? this.parseType() : undefined;
    const isConstructor = name.name === className && !accessor;
    // A `constexpr` method only reads its object (as in C++): it is `const` whether written or not.
    const isConst = !!this.eat("const") || (!!(modifiers.constexpr || modifiers.consteval) && !isConstructor && !modifiers.static);
    let body: A.Block | undefined;
    let exprBody = false;
    if (this.is("{")) body = this.parseBlock();
    else if (this.is("=>")) {
      // `function area():Float => w * h`: an expression body, as a block with one statement.
      const arrow = this.advance();
      if (isConstructor) this.diags.error("X0108", "a constructor can't have an expression body", arrow.span).help("use a block: `{ … }`");
      const expr = this.parseExpr();
      body = { kind: "Block", body: [exprBodyStatement(expr, returnType, accessor, isConstructor)], span: expr.span };
      exprBody = true;
      this.endStatement();
    } else this.endStatement();
    return { kind: "Method", modifiers, name, typeParams, accessor, isConstructor, params, returnType, isConst, body, ...(exprBody ? { exprBody } : {}), span: this.sp(start) };
  }

  private parseParams(): A.Param[] {
    const open = this.expect("(");
    const params: A.Param[] = [];
    while (!this.is(")")) {
      const start = this.tok.span.start;
      const final = !!this.eat("final");
      const rest = !!this.eat("...");
      const name = this.ident("a parameter name");
      const type = this.eat(":") ? this.parseType() : undefined;
      const init = this.eat("=") ? this.parseExpr() : undefined;
      params.push({ name, type, init, rest, final, span: this.sp(start) });
      if (!this.eat(",")) break;
    }
    this.expectClose(")", open);
    return params;
  }

  /* ------------------------------ types ------------------------------ */

  /**
   * A type; `A | B | null` is a union unless `union` is false (after `is`/`as` and `new`, where a
   * `|` is the bitwise operator: `x as int | 1`).
   */
  parseType(union = true): A.TypeNode {
    const start = this.tok.span.start;
    const first = this.parseNullableType();
    if (!union || !this.is("|")) return first;
    const types = [first];
    while (this.eat("|")) types.push(this.parseNullableType());
    return { kind: "UnionType", types, span: this.sp(start) };
  }

  private parseNullableType(): A.TypeNode {
    const start = this.tok.span.start;
    const t = this.parseTypeAtom();
    // `int?`: only when the `?` ends the type, so `x is int ? a : b` stays a conditional.
    if (this.is("?") && !this.tok.nl) {
      const next = this.peekTok();
      if (next.kind === "eof" || next.nl || TYPE_FOLLOW.has(next.value)) {
        this.advance();
        return { kind: "NullableType", inner: t, span: this.sp(start) };
      }
    }
    return t;
  }

  private parseTypeAtom(): A.TypeNode {
    const start = this.tok.span.start;
    if (this.eat("*")) return { kind: "AnyType", span: this.sp(start) };
    if (this.is("{")) return this.parseShapeType();
    if (this.is("(")) return this.parseFunctionType();
    if (this.eat("void")) return { kind: "VoidType", span: this.sp(start) };
    if (this.eat("null")) return { kind: "NullType", span: this.sp(start) };
    // Literal types (`withFileTypes:true`, `encoding:'buffer'`): the one value, as in TypeScript.
    if (this.tok.kind === "string") return { kind: "LiteralType", value: this.advance().value, span: this.sp(start) };
    if (this.is("true") || this.is("false")) return { kind: "LiteralType", value: this.advance().value === "true", span: this.sp(start) };
    if (this.tok.kind === "number" || (this.is("-") && this.peekTok().kind === "number" && !this.peekTok().nl)) {
      const negative = !!this.eat("-");
      const raw = this.advance().value;
      const value = Number(raw.replaceAll("_", ""));
      const float = !/^0[xXbBoO]/.test(raw) && /[.eE]/.test(raw);
      return { kind: "LiteralType", value: negative ? -value : value, float, span: this.sp(start) };
    }
    const name: A.Ident[] = [this.ident("a type")];
    while (this.is(".") && this.peekTok().kind === "ident") {
      this.advance();
      name.push(this.ident());
    }
    const args: A.TypeNode[] = [];
    if (this.is("<")) {
      const open = this.advance();
      do args.push(this.parseType());
      while (this.eat(","));
      this.splitClosingAngle();
      this.expectClose(">", open);
    }
    return { kind: "TypeName", name, args, span: this.sp(start) };
  }

  /** `<T extends Base, U = Default>` after a class/interface/typedef/method/function name. */
  private typeParamList(allowDefaults = false, allowVariance = false): A.TypeParam[] | undefined {
    if (!this.is("<")) return undefined;
    const open = this.advance();
    const params: A.TypeParam[] = [];
    do {
      let variance: A.TypeParam["variance"];
      if (allowVariance && (this.is("in") || this.isIdent("out"))) {
        variance = this.advance().value === "in" ? "in" : "out";
      }
      const param: A.TypeParam = this.ident("a type parameter name");
      if (variance) param.variance = variance;
      if (this.eat("extends")) param.constraint = this.parseType();
      if (this.is("=")) {
        if (!allowDefaults) this.fail("only a class or interface type parameter can have a default", this.tok.span, "write just the name");
        this.advance();
        param.default = this.parseType();
      }
      params.push(param);
    } while (this.eat(","));
    this.splitClosingAngle();
    this.expectClose(">", open);
    return params;
  }

  /** `{ x:Float, ?label:String, final id:int }` — members separated by commas or line breaks. */
  private parseShapeType(): A.TypeNode {
    const open = this.expect("{");
    const members: A.ShapeMemberNode[] = [];
    while (!this.is("}") && !this.atEof()) {
      const mStart = this.tok.span.start;
      const readonly = !!this.eat("final");
      const optional = !!this.eat("?");
      const name = this.memberName();
      this.expect(":");
      const type = this.parseType();
      members.push({ name, type, optional, readonly, span: this.sp(mStart) });
      if (!this.eat(",") && !this.tok.nl && !this.is("}")) this.unexpected("`,` or `}`");
    }
    this.expectClose("}", open);
    return { kind: "ShapeType", members, span: this.sp(open.span.start) };
  }

  /** `(a:int, b:int) -> int`, `(Float, Float) -> Float`, `() -> void`. Parameter names are documentation. */
  private parseFunctionType(): A.TypeNode {
    const open = this.expect("(");
    const params: { name?: A.Ident; type: A.TypeNode; rest: boolean; span: Span }[] = [];
    while (!this.is(")")) {
      const pStart = this.tok.span.start;
      const rest = !!this.eat("...");
      let name: A.Ident | undefined;
      if (this.tok.kind === "ident" && this.is(":", this.peekTok())) {
        name = this.ident();
        this.advance();
      }
      params.push({ name, type: this.parseType(), rest, span: this.sp(pStart) });
      if (!this.eat(",")) break;
    }
    this.expectClose(")", open);
    if (!this.is("->")) this.unexpected("`->` and a return type");
    this.advance();
    const ret = this.parseType();
    return { kind: "FunctionType", params, ret, span: this.sp(open.span.start) };
  }

  /** In type position `>>` / `>>>` / `>=` start with a `>` that closes a type argument list. */
  private splitClosingAngle() {
    const t = this.tok;
    if (t.kind === "punct" && t.value.length > 1 && t.value.startsWith(">")) {
      const first: Token = { ...t, value: ">", span: span(this.file, t.span.start, t.span.start + 1) };
      const rest: Token = { ...t, value: t.value.slice(1), span: span(this.file, t.span.start + 1, t.span.end), nl: false };
      this.tokens.splice(this.i, 1, first, rest);
    }
  }

  /* ---------------------------- statements ---------------------------- */

  parseBlock(): A.Block {
    const open = this.expect("{");
    const body: A.Stmt[] = [];
    while (!this.is("}") && this.tok.kind !== "eof") {
      const start = this.i;
      try {
        body.push(this.parseStatement());
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        this.syncStatement(start);
      }
    }
    this.expectClose("}", open);
    return { kind: "Block", body, span: cover(open.span, this.tokens[this.i - 1]!.span) };
  }

  private syncStatement(start: number) {
    if (this.i === start) this.advance();
    let depth = 0;
    while (this.tok.kind !== "eof") {
      if (depth === 0 && this.eat(";")) return;
      if (depth === 0 && this.is("}")) return;
      if (depth === 0 && this.tok.nl) return;
      if (this.is("{") || this.is("(") || this.is("[")) depth++;
      if (this.is("}") || this.is(")") || this.is("]")) depth = Math.max(0, depth - 1);
      this.advance();
    }
  }

  private parseStatement(): A.Stmt {
    const t = this.tok;
    const start = t.span.start;

    if (this.is("{")) return this.parseBlock();
    if (this.eat(";")) return { kind: "Empty", span: t.span };

    const inline = this.is("inline") ? this.advance().span : undefined;
    if ((this.is("var") || this.is("const") || this.is("final")) && (this.is("{", this.peekTok()) || this.is("[", this.peekTok()))) {
      if (inline) this.fail("destructuring can't be `inline`", inline);
      const decl = this.advance().value as "var" | "const" | "final";
      const pattern = this.parsePattern();
      const type = this.eat(":") ? this.parseType() : undefined;
      if (!this.is("=")) this.unexpected("`=` and a value to destructure");
      this.advance();
      const init = this.parseExpr();
      this.endStatement();
      return { kind: "DestructDecl", decl, pattern, type, init, span: this.sp(start) };
    }
    if (this.is("var") || this.is("const") || (this.is("final") && this.peekTok().kind === "ident")) {
      const decl = this.advance().value as A.VarDecl["decl"];
      const name = this.ident("a variable name");
      const type = this.eat(":") ? this.parseType() : undefined;
      const init = this.eat("=") ? this.exprOrError() : undefined;
      if (init?.kind === "Error") return { kind: "VarDecl", decl, name, type, init, inline, span: this.sp(start) };
      this.rangeOutsideLoop();
      this.endStatement();
      return { kind: "VarDecl", decl, name, type, init, inline, span: this.sp(start) };
    }
    if (inline) this.unexpected("`final` or `const` after `inline`");

    if (this.eat("if")) {
      const open = this.expect("(");
      if (this.startsBinding()) {
        const header = this.parseHeader();
        this.expectClose(")", open);
        const then = this.parseStatement();
        const els = this.eat("else") ? this.parseStatement() : undefined;
        return { kind: "IfVar", header, then, else: els, span: this.sp(start) };
      }
      const cond = this.parseExpr();
      this.expectClose(")", open);
      const then = this.parseStatement();
      const els = this.eat("else") ? this.parseStatement() : undefined;
      return { kind: "If", cond, then, else: els, span: this.sp(start) };
    }

    if (this.eat("while")) {
      const open = this.expect("(");
      if (this.startsBinding()) {
        const header = this.parseHeader();
        this.expectClose(")", open);
        const body = this.parseStatement();
        return { kind: "WhileVar", header, body, span: this.sp(start) };
      }
      const cond = this.parseExpr();
      this.expectClose(")", open);
      const body = this.parseStatement();
      return { kind: "While", cond, body, span: this.sp(start) };
    }

    if (this.is("for")) return this.parseFor();
    if (this.is("switch")) return this.parseSwitch();

    if (this.eat("do")) {
      // `do x++ while (c)`: the body may end right before `while`.
      this.doBody++;
      let body: A.Stmt;
      try {
        body = this.parseStatement();
      } finally {
        this.doBody--;
      }
      this.expect("while");
      const open = this.expect("(");
      if (this.startsBinding()) {
        this.fail("`do … while` can't declare a variable in its condition", this.tok.span, "the body runs before the binding would exist");
      }
      const cond = this.parseExpr();
      this.expectClose(")", open);
      this.endStatement();
      return { kind: "DoWhile", body, cond, span: this.sp(start) };
    }

    if (this.eat("return")) {
      // Restricted production: a line break ends the return statement.
      let value: A.Expr | undefined;
      if (!this.tok.nl && !this.is(";") && !this.is("}") && this.tok.kind !== "eof") {
        value = this.exprOrError();
        if (value.kind === "Error") return { kind: "Return", value, span: this.sp(start) };
      }
      // `return⏎ value`: remember it for a better message (the value is a separate statement).
      const next = this.tok;
      const looksLikeValue = !value && next.nl && next.kind !== "eof" && !this.is("}") &&
        !(next.kind === "keyword" && ["case", "default", "var", "const", "final", "if", "for", "while", "return", "throw", "try", "switch", "do", "break", "continue"].includes(next.value));
      this.endStatement();
      return { kind: "Return", value, lineBreakBefore: looksLikeValue ? next.span : undefined, span: this.sp(start) };
    }

    if (this.is("break") || this.is("continue")) {
      const kw = this.advance();
      if (this.tok.kind === "ident" && !this.tok.nl) this.fail("labels are not supported yet", this.tok.span);
      this.endStatement();
      return { kind: kw.value === "break" ? "Break" : "Continue", span: this.sp(start) };
    }

    if (this.eat("throw")) {
      if (this.tok.nl) this.fail("expected an expression after `throw` on the same line", this.tok.span);
      const value = this.parseExpr();
      this.endStatement();
      return { kind: "Throw", value, span: this.sp(start) };
    }

    if (this.eat("try")) {
      const block = this.parseBlock();
      const catches: A.CatchClause[] = [];
      while (this.is("catch")) {
        const cStart = this.advance().span.start;
        const open = this.expect("(");
        const name = this.ident("a name for the caught exception");
        const type = this.eat(":") ? this.parseType() : undefined;
        this.expectClose(")", open);
        catches.push({ name, type, body: this.parseBlock(), span: this.sp(cStart) });
      }
      const fin = this.eat("finally") ? this.parseBlock() : undefined;
      if (catches.length === 0 && !fin) this.unexpected("`catch` or `finally`");
      return { kind: "Try", block, catches, finally: fin, span: this.sp(start) };
    }

    if ((this.is("function") && this.peekTok().kind === "ident") || (this.is("async") && this.is("function", this.peekTok()))) {
      const fn = this.parseFunction(false) as A.FunctionNode & { name: A.Ident; body: A.Block };
      return { kind: "FuncDecl", fn, span: this.sp(start) };
    }

    if (this.is("using") || (this.is("await") && this.is("using", this.peekTok()))) return this.parseUsing();

    if (this.atDefer()) {
      this.advance();
      return { kind: "Defer", body: this.parseStatement(), span: this.sp(start) };
    }

    if (t.kind === "ident" && this.is(":", this.peekTok())) {
      this.fail("labels are not supported yet", cover(t.span, this.peekTok().span));
    }

    const expr = this.parseExpr();
    this.rangeOutsideLoop();
    this.endStatement();
    return { kind: "ExprStmt", expr, span: this.sp(start) };
  }

  /**
   * `defer` is contextual: a statement keyword only when a statement follows on the same line
   * (`defer {`, `defer close()`), so `defer` stays usable as a name (`script.defer = true`, `defer(x)`).
   */
  private atDefer(): boolean {
    if (this.tok.kind !== "ident" || this.tok.value !== "defer") return false;
    const next = this.peekTok();
    if (next.nl) return false;
    if (next.kind === "punct") return next.value === "{";
    if (next.kind === "keyword") return !["in", "is", "as", "instanceof"].includes(next.value);
    return next.kind === "ident";
  }

  /** `using x:T = e`, `using (x:T = e, …) body`, `using (expr) body`, each optionally `await`-prefixed. */
  /**
   * `using (var x = …)`, `using final x = …`: `using` already declares the variable (always final,
   * since the value it was given is the one disposed). Reported with a fix-it removing the keyword,
   * which is skipped so the rest parses as usual.
   */
  private skipUsingKeyword(): void {
    if (!(this.is("var") || this.is("final") || this.is("const"))) return;
    const kw = this.advance();
    const text = this.file.text;
    let end = kw.span.end;
    while (end < text.length && (text[end] === " " || text[end] === "\t")) end++;
    this.diags.error("X0809", "`using` already declares the variable", kw.span, "remove this")
      .note("a `using` variable is always final: it is disposed as the value it was given")
      .help(`remove \`${kw.value}\``, [{ span: span(this.file, kw.span.start, end), text: "" }]);
  }

  private parseUsing(): A.Stmt {
    const start = this.tok.span.start;
    const isAwait = !!this.eat("await");
    this.expect("using");
    if (this.is("(")) {
      const open = this.advance();
      const resources: A.UsingResource[] = [];
      do {
        this.skipUsingKeyword();
        const rStart = this.tok.span.start;
        if (this.tok.kind === "ident" && (this.is(":", this.peekTok()) || this.is("=", this.peekTok()))) {
          const name = this.ident();
          const type = this.eat(":") ? this.parseType() : undefined;
          this.expect("=");
          resources.push({ kind: "Decl", name, type, init: this.parseAssign(), span: this.sp(rStart) });
        } else {
          resources.push({ kind: "Expr", expr: this.parseAssign(), span: this.sp(rStart) });
        }
      } while (this.eat(","));
      this.expectClose(")", open);
      const body = this.parseStatement();
      return { kind: "UsingBlock", isAwait, resources, body, span: this.sp(start) };
    }
    this.skipUsingKeyword();
    const name = this.ident("a variable name");
    const type = this.eat(":") ? this.parseType() : undefined;
    if (!this.is("=")) this.unexpected("`=` and the resource to dispose later");
    this.advance();
    const init = this.parseExpr();
    this.endStatement();
    return { kind: "UsingDecl", isAwait, name, type, init, span: this.sp(start) };
  }

  private rangeOutsideLoop() {
    if (this.is("..") || this.is("..=")) {
      this.diags.error("X0333", "ranges are only supported in `for (… of …)` loops", this.tok.span)
        .help("for example `for (var i:Int of 0..10) { … }`");
      throw new ParseError("range");
    }
  }

  /** `{a, b: c, d = 1, ...rest}` / `[x, , y = 2, ...rest]` in a declaration. */
  private parsePattern(): A.Pattern {
    const start = this.tok.span.start;
    if (this.is("{")) {
      const open = this.advance();
      const props: { key: A.Ident; value: A.Pattern; span: Span }[] = [];
      let rest: A.Pattern | undefined;
      while (!this.is("}")) {
        const pStart = this.tok.span.start;
        if (this.eat("...")) {
          const name = this.ident("a name for the rest");
          rest = { kind: "BindingName", name, span: name.span };
          break;
        }
        const key = this.memberName();
        let value: A.Pattern;
        if (this.eat(":")) value = this.parsePatternElement();
        else {
          if (key.name !== "" && this.tokens[this.i - 1]!.kind === "keyword") {
            this.fail(`\`${key.name}\` is a keyword; rename it: \`{${key.name}: name}\``, key.span);
          }
          value = { kind: "BindingName", name: key, span: key.span };
          if (this.eat("=")) value.init = this.parseAssign();
        }
        props.push({ key, value, span: this.sp(pStart) });
        if (!this.eat(",")) break;
      }
      this.expectClose("}", open);
      return { kind: "ObjectPattern", props, rest, span: this.sp(start) };
    }
    const open = this.expect("[");
    const elements: (A.Pattern | null)[] = [];
    let rest: A.Pattern | undefined;
    while (!this.is("]")) {
      if (this.is(",")) {
        this.advance();
        elements.push(null); // hole: `[a, , c]`
        continue;
      }
      if (this.eat("...")) {
        const name = this.ident("a name for the rest");
        rest = { kind: "BindingName", name, span: name.span };
        break;
      }
      elements.push(this.parsePatternElement());
      if (!this.eat(",")) break;
    }
    this.expectClose("]", open);
    return { kind: "ArrayPattern", elements, rest, span: this.sp(start) };
  }

  /** A name or nested pattern, optionally with `= default`. */
  private parsePatternElement(): A.Pattern {
    const p: A.Pattern = this.is("{") || this.is("[") ? this.parsePattern() : (() => {
      const name = this.ident("a variable name");
      return { kind: "BindingName" as const, name, span: name.span };
    })();
    if (this.eat("=")) p.init = this.parseAssign();
    return p;
  }

  /** Reinterprets an array/object literal on the left of `=` as a destructuring pattern. */
  private exprToPattern(e: A.Expr): A.Pattern {
    const target = (x: A.Expr): A.Pattern => {
      if (x.kind === "Array" || x.kind === "Object") return this.exprToPattern(x);
      if (x.kind === "Assign" && x.op === "=") {
        const p = target(x.target);
        p.init = x.value;
        return p;
      }
      if (x.kind === "Ident" || x.kind === "Member" || x.kind === "Index") return { kind: "Target", expr: x, span: x.span };
      this.fail("this can't be assigned to", x.span, "not an assignment target");
    };
    if (e.kind === "Array") {
      const elements: (A.Pattern | null)[] = [];
      let rest: A.Pattern | undefined;
      e.elements.forEach((el, i) => {
        if (el.kind === "Spread") {
          if (i !== e.elements.length - 1) this.fail("the rest element must be last", el.span);
          rest = target(el.arg);
        } else elements.push(target(el));
      });
      return { kind: "ArrayPattern", elements, rest, span: e.span };
    }
    if (e.kind === "Object") {
      const props: { key: A.Ident; value: A.Pattern; span: Span }[] = [];
      let rest: A.Pattern | undefined;
      for (const p of e.props) {
        if (p.kind === "SpreadProp") rest = target(p.arg);
        else if (p.kind === "Shorthand") props.push({ key: p.name, value: { kind: "Target", expr: { kind: "Ident", name: p.name.name, span: p.name.span }, span: p.span }, span: p.span });
        else if (p.kind === "Accessor" || p.method) this.fail("a method can't be destructured", p.span);
        else if ("name" in p.key) props.push({ key: p.key, value: target(p.value), span: p.span });
        else this.fail("computed and quoted keys can't be destructured", p.span);
      }
      return { kind: "ObjectPattern", props, rest, span: e.span };
    }
    this.fail("expected a pattern", e.span);
  }

  /**
   * An expression that ends a statement (initializer, return value). If it is broken, the error is
   * reported, the rest of the statement skipped, and an `Error` node keeps the statement itself
   * (so the variable stays declared and the `return` stays a return: no follow-up errors).
   */
  private exprOrError(): A.Expr {
    const start = this.i;
    try {
      return this.parseExpr();
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      const from = this.tokens[start]!.span.start;
      this.syncStatement(start);
      return { kind: "Error", span: span(this.file, from, Math.max(from, this.prevEnd)) };
    }
  }

  /** `var`/`const`/`final` at the start of an `if`/`while` header. */
  private startsBinding(): boolean {
    return this.is("var") || this.is("const") || (this.is("final") && this.peekTok().kind === "ident");
  }

  /** Header of `if (var …)` / `while (var …)`: bindings and conditions separated by commas. */
  private parseHeader(): A.HeaderItem[] {
    const items: A.HeaderItem[] = [];
    do {
      const start = this.tok.span.start;
      if (this.startsBinding()) {
        const kw = this.advance();
        if (kw.value !== "var") {
          this.diags.error("X0107", `use \`var\` for a binding in a condition`, kw.span)
            .help("replace it with `var`", [{ span: kw.span, text: "var" }]);
        }
        const name = this.ident("a variable name");
        const type = this.eat(":") ? this.parseType() : undefined;
        if (!this.is("=")) this.unexpected("`=` and a value to bind");
        this.advance();
        const init = this.parseAssign();
        items.push({ kind: "Binding", name, type, init, span: this.sp(start) });
      } else {
        const expr = this.parseAssign();
        items.push({ kind: "Cond", expr, span: this.sp(start) });
      }
    } while (this.eat(","));
    return items;
  }

  private loopVar(): A.LoopVar {
    const start = this.tok.span.start;
    const decl = this.advance().value as A.LoopVar["decl"];
    if (this.is("{") || this.is("[")) {
      const pattern = this.parsePattern();
      const type = this.eat(":") ? this.parseType() : undefined;
      return { decl, name: { name: "", span: pattern.span }, pattern, type, span: this.sp(start) };
    }
    const name = this.ident("a loop variable name");
    const type = this.eat(":") ? this.parseType() : undefined;
    return { decl, name, type, span: this.sp(start) };
  }

  private parseFor(): A.Stmt {
    const start = this.advance().span.start; // for
    if (this.isIdent("each") && this.is("(", this.peekTok())) {
      this.diags.error("X0106", "`for each` is written `for (var v:T of coll)` in Xenon", cover(this.tokens[this.i - 1]!.span, this.tok.span))
        .help("use `of`: `for (var v:T of collection)`");
      throw new ParseError("for each");
    }
    const open = this.expect("(");

    if (this.startsBinding() && (this.peekTok().kind === "ident" || this.is("{", this.peekTok()) || this.is("[", this.peekTok()))) {
      // Look past `var name[:Type]` to see which loop this is.
      const save = this.i;
      const variable = this.loopVar();
      if (this.isIdent("of")) {
        this.advance();
        const source = this.parseExpr();
        if (this.is("..") || this.is("..=")) return this.finishRange(variable, source, open, start);
        this.expectClose(")", open);
        const body = this.parseStatement();
        return { kind: "ForOf", variable, iterable: source, body, span: this.sp(start) };
      }
      if (variable.pattern) this.unexpected("`of` (destructuring works with `for … of`)");
      if (this.eat("in")) {
        const object = this.parseExpr();
        this.expectClose(")", open);
        const body = this.parseStatement();
        return { kind: "ForIn", variable, object, body, span: this.sp(start) };
      }
      this.i = save; // C-style for with a declaration
    } else if (this.tok.kind === "ident" && (this.isIdent("of", this.peekTok()) || this.is("in", this.peekTok()))) {
      this.fail("the loop variable must be declared here", this.tok.span, `write \`var ${this.tok.value}:Type\``);
    }

    let init: A.VarDecl | { kind: "ExprStmt"; expr: A.Expr; span: Span } | undefined;
    if (this.startsBinding()) {
      const s = this.tok.span.start;
      const decl = this.advance().value as A.VarDecl["decl"];
      const name = this.ident("a variable name");
      const type = this.eat(":") ? this.parseType() : undefined;
      const initExpr = this.eat("=") ? this.parseExpr() : undefined;
      init = { kind: "VarDecl", decl, name, type, init: initExpr, span: this.sp(s) };
    } else if (!this.is(";")) {
      const s = this.tok.span.start;
      init = { kind: "ExprStmt", expr: this.parseExpr(), span: this.sp(s) };
    }
    this.expect(";");
    const cond = this.is(";") ? undefined : this.parseExpr();
    this.expect(";");
    const update = this.is(")") ? undefined : this.parseExpr();
    this.expectClose(")", open);
    const body = this.parseStatement();
    return { kind: "For", init, cond, update, body, span: this.sp(start) };
  }

  private finishRange(variable: A.LoopVar, startExpr: A.Expr, open: Token, start: number): A.Stmt {
    const inclusive = this.advance().value === "..=";
    let end: A.Expr | undefined;
    if (!this.is(")") && !this.isIdent("step")) end = this.parseExpr();
    if (inclusive && !end) this.fail("an inclusive range `..=` needs an end", this.tok.span);
    let step: A.Expr | undefined;
    if (this.isIdent("step")) {
      this.advance();
      step = this.parseExpr();
    }
    this.expectClose(")", open);
    const body = this.parseStatement();
    return { kind: "ForRange", variable, start: startExpr, end, inclusive, step, body, span: this.sp(start) };
  }

  private parseSwitch(): A.Stmt {
    const start = this.advance().span.start; // switch
    const open = this.expect("(");
    const discriminant = this.parseExpr();
    this.expectClose(")", open);
    const brace = this.expect("{");
    const cases: A.SwitchCase[] = [];
    while (!this.is("}") && this.tok.kind !== "eof") {
      const caseStart = this.tok.span.start;
      let test: A.Expr | undefined;
      if (this.eat("case")) test = this.parseExpr();
      else if (!this.eat("default")) this.unexpected("`case` or `default`");
      this.expect(":");
      const body: A.Stmt[] = [];
      while (!this.is("case") && !this.is("default") && !this.is("}") && !this.atEof()) {
        const stmtStart = this.i;
        try {
          body.push(this.parseStatement());
        } catch (e) {
          if (!(e instanceof ParseError)) throw e;
          this.syncStatement(stmtStart);
        }
      }
      cases.push({ test, body, span: this.sp(caseStart) });
    }
    this.expectClose("}", brace);
    return { kind: "Switch", discriminant, cases, span: this.sp(start) };
  }

  /* ---------------------------- expressions ---------------------------- */

  parseExpr(): A.Expr {
    return this.parseAssign();
  }

  private parseAssign(): A.Expr {
    const start = this.tok.span.start;
    const left = this.parseConditional();
    if (this.is("=") && (left.kind === "Array" || left.kind === "Object")) {
      this.advance();
      const pattern = this.exprToPattern(left);
      const value = this.parseAssign();
      return { kind: "DestructAssign", pattern, value, span: this.sp(start) };
    }
    if (this.tok.kind === "punct" && ASSIGN_OPS.has(this.tok.value)) {
      const opTok = this.advance();
      if (!["Ident", "Member", "Index"].includes(left.kind)) {
        this.diags.error("X0105", "invalid assignment target", left.span, "can't assign to this expression");
      }
      const value = this.parseAssign();
      return { kind: "Assign", op: opTok.value, target: left, value, opSpan: opTok.span, span: this.sp(start) };
    }
    return left;
  }

  private parseConditional(): A.Expr {
    const start = this.tok.span.start;
    const cond = this.parseBinary(1);
    if (this.eat("?")) {
      const then = this.parseAssign();
      this.expect(":");
      const els = this.parseAssign();
      return { kind: "Conditional", cond, then, else: els, span: this.sp(start) };
    }
    return cond;
  }

  private binaryOp(): string | undefined {
    const t = this.tok;
    if (t.kind === "punct" && t.value in BINARY_PREC) return t.value;
    if (t.kind === "keyword" && (t.value === "in" || t.value === "is" || t.value === "as")) return t.value;
    return undefined;
  }

  private parseBinary(minPrec: number): A.Expr {
    const start = this.tok.span.start;
    let left = this.parseUnary();
    for (;;) {
      const op = this.binaryOp();
      if (!op) return left;
      const prec = BINARY_PREC[op]!;
      if (prec < minPrec) return left;
      const opTok = this.advance();
      if (op === "is" || op === "as") {
        const type = this.parseType(false);
        left = { kind: "TypeOp", op, expr: left, type, span: this.sp(start) };
        continue;
      }
      // `**` is right-associative.
      const right = op === "**" ? this.parseBinary(prec) : this.parseBinary(prec + 1);
      left = { kind: "Binary", op, left, right, opSpan: opTok.span, span: this.sp(start) };
    }
  }

  private parseUnary(): A.Expr {
    const t = this.tok;
    const start = t.span.start;
    if (t.kind === "punct" && ["!", "-", "+", "~"].includes(t.value)) {
      this.advance();
      return { kind: "Unary", op: t.value, arg: this.parseUnary(), span: this.sp(start) };
    }
    // `void save()`: evaluates and discards (marks a promise as intentionally not awaited).
    if (this.is("typeof") || this.is("delete") || this.is("void")) {
      this.advance();
      return { kind: "Unary", op: t.value, arg: this.parseUnary(), span: this.sp(start) };
    }
    if (this.is("await")) {
      this.advance();
      return { kind: "Await", arg: this.parseUnary(), span: this.sp(start) };
    }
    if (this.is("++") || this.is("--")) {
      this.advance();
      const arg = this.parseUnary();
      return { kind: "Update", op: t.value as "++", prefix: true, arg, span: this.sp(start) };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): A.Expr {
    const start = this.tok.span.start;
    const expr = this.parseCallMember();
    // Restricted production: no line break before postfix ++/--.
    if ((this.is("++") || this.is("--")) && !this.tok.nl) {
      const op = this.advance().value as "++";
      return { kind: "Update", op, prefix: false, arg: expr, span: this.sp(start) };
    }
    return expr;
  }

  private parseArgs(): A.Expr[] {
    const open = this.expect("(");
    const args: A.Expr[] = [];
    while (!this.is(")")) {
      args.push(this.parseSpreadOrExpr());
      if (!this.eat(",")) break;
    }
    this.expectClose(")", open);
    return args;
  }

  private parseSpreadOrExpr(): A.Expr {
    const start = this.tok.span.start;
    if (this.eat("...")) return { kind: "Spread", arg: this.parseAssign(), span: this.sp(start) };
    return this.parseAssign();
  }

  private parseCallMember(): A.Expr {
    const start = this.tok.span.start;
    let expr = this.parsePrimary();
    for (;;) {
      if (this.is(".")) {
        this.advance();
        const name = this.memberName();
        expr = { kind: "Member", object: expr, name, optional: false, span: this.sp(start) };
      } else if (this.is("?.")) {
        this.advance();
        if (this.is("(")) {
          expr = { kind: "Call", callee: expr, args: this.parseArgs(), optional: true, span: this.sp(start) };
        } else if (this.is("[")) {
          const open = this.advance();
          const index = this.parseExpr();
          this.expectClose("]", open);
          expr = { kind: "Index", object: expr, index, optional: true, span: this.sp(start) };
        } else {
          expr = { kind: "Member", object: expr, name: this.memberName(), optional: true, span: this.sp(start) };
        }
      } else if (this.is("::")) {
        this.advance();
        expr = { kind: "PropertyReference", owner: expr, name: this.memberName(), span: this.sp(start) };
      } else if (this.is("(") && !this.tok.nl) {
        expr = { kind: "Call", callee: expr, args: this.parseArgs(), optional: false, span: this.sp(start) };
      } else if (this.is("[") && !this.tok.nl) {
        const open = this.advance();
        const index = this.parseExpr();
        this.expectClose("]", open);
        expr = { kind: "Index", object: expr, index, optional: false, span: this.sp(start) };
      } else {
        return expr;
      }
    }
  }

  /** Member names may be keywords (`obj.default`, `promise.catch`), as in JS. */
  private memberName(): A.Ident {
    const t = this.tok;
    if (t.kind === "ident" || t.kind === "keyword") {
      this.advance();
      return { name: t.value, span: t.span };
    }
    this.unexpected("a member name");
  }

  private parsePrimary(): A.Expr {
    const t = this.tok;
    const start = t.span.start;
    switch (t.kind) {
      case "ident":
        if (this.is("=>", this.peekTok()) && !this.peekTok().nl) return this.parseFunction(true);
        this.advance();
        return { kind: "Ident", name: t.value, span: t.span };
      case "number": {
        this.advance();
        return { kind: "Number", raw: t.value, value: Number(t.value.replaceAll("_", "")), span: t.span };
      }
      case "string":
        this.advance();
        return { kind: "String", value: t.value, span: t.span };
      case "regex":
        this.advance();
        return { kind: "Regex", pattern: t.pattern!, flags: t.flags!, span: t.span };
      case "template": {
        this.advance();
        const parts: A.TemplateExprPart[] = [];
        for (const p of t.parts!) {
          if (p.kind === "text") parts.push({ kind: "text", value: p.value });
          else {
            const sub = new Parser(p.tokens, this.file, this.diags);
            try {
              const expr = sub.parseExpr();
              if (sub.tok.kind !== "eof") sub.unexpected("`}`");
              parts.push({ kind: "expr", expr });
            } catch (e) {
              if (!(e instanceof ParseError)) throw e;
              parts.push({ kind: "expr", expr: { kind: "Error", span: p.span } });
            }
          }
        }
        return { kind: "Template", parts, span: t.span };
      }
      case "keyword":
        switch (t.value) {
          case "this": this.advance(); return { kind: "This", span: t.span };
          case "super": this.advance(); return { kind: "Super", span: t.span };
          case "true": case "false":
            this.advance();
            return { kind: "Bool", value: t.value === "true", span: t.span };
          case "null": this.advance(); return { kind: "Null", span: t.span };
          case "undefined": this.advance(); return { kind: "Undefined", span: t.span };
          case "nameof": {
            this.advance();
            return { kind: "Nameof", args: this.parseArgs(), span: this.sp(start) };
          }
          case "new": {
            this.advance();
            const callee = this.parseType(false);
            const args = this.is("(") && !this.tok.nl ? this.parseArgs() : [];
            return { kind: "New", callee, args, span: this.sp(start) };
          }
          case "function":
            return this.parseFunction(false);
          case "async":
            if (this.is("function", this.peekTok()) || this.is("(", this.peekTok()) || this.peekTok().kind === "ident") {
              return this.is("function", this.peekTok()) ? this.parseFunction(false) : this.parseFunction(true);
            }
            break;
        }
        break;
      case "punct":
        switch (t.value) {
          case "(": {
            if (this.arrowAhead()) return this.parseFunction(true);
            const open = this.advance();
            const inner = this.parseExpr();
            // `(expr : Type)`: a compile-time type check (an arrow's `(a:int) =>` was ruled out above).
            if (this.eat(":")) {
              const type = this.parseType();
              this.expectClose(")", open);
              return { kind: "TypeCheck", expr: inner, type, span: this.sp(start) };
            }
            this.expectClose(")", open);
            return inner;
          }
          case "[": {
            const open = this.advance();
            const elements: A.Expr[] = [];
            while (!this.is("]")) {
              elements.push(this.parseSpreadOrExpr());
              if (!this.eat(",")) break;
            }
            this.expectClose("]", open);
            return { kind: "Array", elements, span: this.sp(start) };
          }
          case "{":
            return this.parseObject();
          case "/":
            this.fail("expected an expression, found `/`", t.span, "regex literals start with `~`: `~/…/`");
        }
        break;
    }
    this.unexpected("an expression");
  }

  /** At `(`: is this the parameter list of an arrow function? Looks past `)` for `=>` or `: Type =>`. */
  private arrowAhead(): boolean {
    let depth = 0;
    let j = this.i;
    for (; j < this.tokens.length; j++) {
      const t = this.tokens[j]!;
      if (t.kind === "eof") return false;
      if (t.kind === "punct" && (t.value === "(" || t.value === "[" || t.value === "{")) depth++;
      if (t.kind === "punct" && (t.value === ")" || t.value === "]" || t.value === "}")) {
        depth--;
        if (depth === 0) break;
      }
    }
    const after = this.tokens[j + 1];
    if (!after) return false;
    if (after.kind === "punct" && after.value === "=>") return true;
    if (!(after.kind === "punct" && after.value === ":")) return false;
    // `(…): Type =>` — skip tokens that can appear in a type.
    for (let k = j + 2; k < this.tokens.length; k++) {
      const t = this.tokens[k]!;
      if (t.kind === "punct" && t.value === "=>") return true;
      const typeish = t.kind === "ident" || (t.kind === "keyword" && t.value === "void") ||
        (t.kind === "punct" && [".", "<", ">", ">>", ">>>", ",", "*"].includes(t.value));
      if (!typeish) return false;
    }
    return false;
  }

  /**
   * `function [name](params)[:T] { … }`, `[async] (params)[:T] => body`, `x => body`.
   * `arrow` selects the arrow syntax; a leading `async` is consumed here.
   */
  private parseFunction(arrow: boolean): A.FunctionNode {
    const start = this.tok.span.start;
    const isAsync = !!this.eat("async");
    let name: A.Ident | undefined;
    let typeParams: A.TypeParam[] | undefined;
    let params: A.Param[];
    if (arrow) {
      if (this.tok.kind === "ident") {
        const id = this.ident();
        params = [{ name: id, rest: false, final: false, span: id.span }];
      } else params = this.parseParams();
    } else {
      this.expect("function");
      if (this.tok.kind === "ident") name = this.ident();
      typeParams = this.typeParamList();
      params = this.parseParams();
    }
    const returnType = this.eat(":") ? this.parseType() : undefined;
    let body: A.Block | A.Expr;
    if (arrow) {
      this.expect("=>");
      body = this.is("{") ? this.parseBlock() : this.parseAssign();
    } else body = this.parseBlock();
    return { kind: "Function", arrow, async: isAsync, name, typeParams, params, returnType, body, span: this.sp(start) };
  }

  /** `function name(…)`, `async function name(…)`; `function: 1` and `async,` are plain keys. */
  private startsObjectFunction(): boolean {
    const isFunction = (t: Token) => t.kind === "keyword" && t.value === "function";
    if (this.is("async")) return isFunction(this.peekTok());
    if (!isFunction(this.tok)) return false;
    const next = this.peekTok();
    return next.kind === "ident" || next.kind === "keyword";
  }

  /**
   * `get area():T {…}` or `get function area():T {…}`: an accessor written the JavaScript way. Nothing is
   * consumed here.
   */
  private misplacedAccessor(): { accessor: "get" | "set"; reversed: boolean } | undefined {
    if (!(this.isIdent("get") || this.isIdent("set"))) return undefined;
    const next = this.peekTok();
    const afterName = this.tokens[this.i + 2];
    const named = (t: Token | undefined) => !!t && (t.kind === "ident" || t.kind === "keyword");
    const accessor = this.tok.value as "get" | "set";
    if (this.is("function", next) && named(afterName)) return { accessor, reversed: true };
    if (named(next) && !this.is("function", next) && !!afterName && this.is("(", afterName)) return { accessor, reversed: false };
    return undefined;
  }

  /** Reports a misplaced accessor with a fix, and parses it anyway so the editor keeps the literal's types. */
  private parseMisplacedAccessor(found: { accessor: "get" | "set"; reversed: boolean }): A.ObjectProp {
    const word = this.advance();
    const next = this.tok;
    if (found.reversed) {
      this.diags.error("X0100", `\`${word.value}\` comes after \`function\``, cover(word.span, next.span), "wrong order")
        .help(`write \`function ${word.value}\``, [{ span: cover(word.span, next.span), text: `function ${word.value}` }]);
      this.advance(); // `function`
    } else {
      this.diags.error("X0100", `an accessor in an object literal starts with \`function\``, cover(word.span, next.span), "missing `function`")
        .help(`write \`function ${word.value} ${next.value}\``, [{ span: span(this.file, word.span.start, word.span.start), text: "function " }]);
    }
    return this.parseObjectFunction(found.accessor, word.span.start);
  }

  /** A method or accessor of an object literal: `[async] function [get|set] name(params)[:T] { … }`. */
  private parseObjectFunction(preset?: "get" | "set", from?: number): A.ObjectProp {
    const start = from ?? this.tok.span.start;
    let accessor = preset;
    let isAsync = false;
    if (!preset) {
      isAsync = !!this.eat("async");
      this.expect("function");
      if ((this.isIdent("get") || this.isIdent("set")) && (this.peekTok().kind === "ident" || this.peekTok().kind === "keyword")) {
        accessor = this.advance().value as "get" | "set";
      }
    }
    const key = this.memberName();
    const typeParams = this.typeParamList();
    const params = this.parseParams();
    const returnType = this.eat(":") ? this.parseType() : undefined;
    const body = this.parseBlock();
    const fn: A.FunctionNode = { kind: "Function", arrow: false, async: isAsync, typeParams, params, returnType, body, span: this.sp(start) };
    if (accessor) return { kind: "Accessor", accessor, key, fn, span: this.sp(start) };
    return { kind: "Prop", key, value: fn, method: true, span: this.sp(start) };
  }

  private parseObject(): A.Expr {
    const open = this.expect("{");
    const start = open.span.start;
    const props: A.ObjectProp[] = [];
    while (!this.is("}")) {
      const pStart = this.tok.span.start;
      if (this.eat("...")) {
        props.push({ kind: "SpreadProp", arg: this.parseAssign(), span: this.sp(pStart) });
      } else if (this.is("[")) {
        const o = this.advance();
        const expr = this.parseAssign();
        this.expectClose("]", o);
        this.expect(":");
        props.push({ kind: "Prop", key: { kind: "Computed", expr }, value: this.parseAssign(), span: this.sp(pStart) });
      } else if (this.tok.kind === "string") {
        const key = this.advance().value;
        this.expect(":");
        props.push({ kind: "Prop", key: { kind: "StringKey", value: key }, value: this.parseAssign(), span: this.sp(pStart) });
      } else if (this.startsObjectFunction()) {
        props.push(this.parseObjectFunction());
      } else if (this.misplacedAccessor()) {
        props.push(this.parseMisplacedAccessor(this.misplacedAccessor()!));
      } else {
        const name = this.memberName();
        if (this.eat(":")) props.push({ kind: "Prop", key: name, value: this.parseAssign(), span: this.sp(pStart) });
        else props.push({ kind: "Shorthand", name, span: this.sp(pStart) });
      }
      if (this.eat(",")) continue;
      // A member on the next line without the comma: say so and carry on, so the rest of the literal still parses.
      if (!this.is("}") && this.tok.nl && (this.tok.kind === "ident" || this.tok.kind === "keyword" || this.tok.kind === "string" || this.is("[") || this.is("..."))) {
        const at = span(this.file, this.prevEnd, this.prevEnd);
        this.diags.error("X0100", "expected `,` between the members of an object literal", this.tok.span, "missing `,` before this")
          .help("add `,`", [{ span: at, text: "," }]);
        continue;
      }
      break;
    }
    this.expectClose("}", open);
    return { kind: "Object", props, span: this.sp(start) };
  }
}
