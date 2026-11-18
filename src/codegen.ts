import { posix } from "node:path";
import type * as A from "./ast.ts";
import { type CheckResult, chainDestructor, type ClassInfo, findMember, isNative, jsNameOf, type RuntimeCheck } from "./checker.ts";
import { supertypes } from "./types.ts";
import { constToJs } from "./consteval.ts";

/* JS operator precedence (higher binds tighter). */
const P = {
  assign: 2,
  cond: 3,
  or: 4, // || and ??
  and: 5,
  bitor: 6,
  bitxor: 7,
  bitand: 8,
  eq: 9,
  rel: 10,
  shift: 11,
  add: 12,
  mul: 13,
  exp: 14,
  unary: 15,
  postfix: 16,
  call: 17,
  primary: 18,
};

const BINARY_JS_PREC: Record<string, number> = {
  "??": P.or, "||": P.or, "&&": P.and, "|": P.bitor, "^": P.bitxor, "&": P.bitand,
  "==": P.eq, "!=": P.eq, "===": P.eq, "!==": P.eq,
  "<": P.rel, ">": P.rel, "<=": P.rel, ">=": P.rel, in: P.rel, instanceof: P.rel,
  "<<": P.shift, ">>": P.shift, ">>>": P.shift,
  "+": P.add, "-": P.add, "*": P.mul, "/": P.mul, "%": P.mul, "**": P.exp,
};

interface Code {
  code: string;
  prec: number;
}

/** Quotes a string as a single-quoted JS literal. */
export function jsString(value: string): string {
  let out = "'";
  for (const ch of value) {
    switch (ch) {
      case "\\": out += "\\\\"; break;
      case "'": out += "\\'"; break;
      case "\n": out += "\\n"; break;
      case "\r": out += "\\r"; break;
      case "\t": out += "\\t"; break;
      case "\0": out += "\\0"; break;
      default: {
        const c = ch.codePointAt(0)!;
        out += c < 0x20 || c === 0x2028 || c === 0x2029 ? `\\u${c.toString(16).padStart(4, "0")}` : ch;
      }
    }
  }
  return out + "'";
}

function templateText(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("`", "\\`")
    .replaceAll("${", "\\${")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r");
}

/** Default value for a field/variable of the given declared type (AS3 semantics). */
function defaultValue(type?: A.TypeNode): string {
  if (type?.kind === "TypeName" && type.name.length === 1) {
    switch (type.name[0]!.name) {
      case "int": case "uint": case "Int": case "UInt": return "0";
      case "Float": return "NaN";
      case "Boolean": case "Bool": return "false";
    }
  }
  return "null";
}

/** JS name of a method; operator methods use a computed name: `['operator+']`. */
function methodName(name: string): string {
  return name.startsWith("operator") && name.length > "operator".length ? `[${jsString(name)}]` : name;
}

function bindingNames(items: A.HeaderItem[]): string {
  return items.flatMap((i) => (i.kind === "Binding" ? [i.name.name] : [])).join(", ");
}

class Writer {
  private lines: string[] = [];
  private depth = 0;
  /** Adds a line (or several, when `text` contains line breaks) at the current indentation. */
  line(text = "") {
    for (const l of text.split("\n")) this.lines.push(l === "" ? "" : "  ".repeat(this.depth) + l);
  }
  indent() {
    this.depth++;
  }
  dedent() {
    this.depth--;
  }
  /** Position for a later `insertAt`. */
  mark(): number {
    return this.lines.length;
  }
  /** Inserts a line at a marked position, indented one level deeper than the current depth. */
  insertAt(index: number, text: string) {
    this.lines.splice(index, 0, "  ".repeat(this.depth + 1) + text);
  }
  toString() {
    return this.lines.join("\n") + "\n";
  }
}

/** Entry module. Contains a `-` so it can never collide with a class module (Bun treats `main.js`/`Main.js` as one module). */
export const ENTRY_FILE = "klass-main.js";

export interface OutputFile {
  path: string;
  text: string;
}

/** Generates one ES module per public class (file-private classes go into the same module). */
export function generate(files: A.KlassFile[], check: CheckResult, mainClass: ClassInfo): OutputFile[] {
  const out: OutputFile[] = [];
  // One ES module per source file: its package-level classes are exported, file-private ones are not.
  for (const file of files) {
    const first = [...file.decls, ...file.privateDecls].find((d) => d.kind === "Class" && !d.modifiers.native);
    if (!first) continue; // only typedefs and native declarations: nothing to emit
    const module = [...check.classes.values()].find((c) => c.decl === first)!.module;
    out.push({ path: module, text: new ModuleGen(module, file, check).run() });
  }
  const entry = new Writer();
  entry.line(`import { ${mainClass.decl.name.name} } from ${jsString("./" + mainClass.module)};`);
  entry.line();
  entry.line(`new ${mainClass.decl.name.name}();`);
  out.push({ path: ENTRY_FILE, text: entry.toString() });
  return out;
}

class ModuleGen {
  private w = new Writer();
  private imports = new Map<string, ClassInfo>();
  private temps = new Map<string, number>();
  /** Temporaries to declare at the top of the current function; null outside functions. */
  private fnTemps: string[] | null = null;
  /** Nesting depth of `function(){}` expressions, whose `this` is not the instance. */
  private dynDepth = 0;
  /** The current method needs `const $self = this;` (members used inside `function` expressions). */
  private selfNeeded = false;

  constructor(
    private module: string,
    private file: A.KlassFile,
    private check: CheckResult,
  ) {}

  run(): string {
    const body = new Writer();
    const swap = this.w;
    this.w = body;
    // Typedefs are compile-time only and emit nothing.
    let first = true;
    // Enums and interface symbols depend on nothing: emit them first, so static initializers of
    // the classes below can use them (a later `const` would still be in its temporal dead zone).
    const all = [...this.file.decls.map((d) => [d, true] as const), ...this.file.privateDecls.map((d) => [d, false] as const)];
    const plain = (d: A.TypeDecl) => d.kind === "Class" && (d.isEnum || d.isInterface);
    for (const [decl, exported] of [...all.filter(([d]) => plain(d)), ...all.filter(([d]) => !plain(d))]) {
      if (decl.kind !== "Class" || decl.modifiers.native) continue;
      if (!first) this.w.line();
      first = false;
      this.classDecl(decl, exported);
    }
    this.w = swap;

    for (const imp of this.file.imports) {
      if (imp.kind === "JsImport") this.w.line(this.jsImport(imp));
    }
    const byModule = new Map<string, string[]>();
    for (const dep of this.imports.values()) byModule.set(dep.module, [...(byModule.get(dep.module) ?? []), dep.decl.name.name]);
    for (const [module, names] of byModule) {
      let rel = posix.relative(posix.dirname(this.module), module);
      if (!rel.startsWith(".")) rel = "./" + rel;
      this.w.line(`import { ${names.sort().join(", ")} } from ${jsString(rel)};`);
    }
    const head = this.w.toString();
    return (head.trim() === "" ? "" : head + "\n") + body.toString();
  }

  private jsImport(imp: A.JsImport): string {
    const parts: string[] = [];
    if (imp.defaultName) parts.push(imp.defaultName.name);
    if (imp.namespace) parts.push(`* as ${imp.namespace.name}`);
    if (imp.named.length > 0) {
      parts.push(`{ ${imp.named.map((n) => (n.alias ? `${n.name.name} as ${n.alias.name}` : n.name.name)).join(", ")} }`);
    }
    return parts.length === 0 ? `import ${jsString(imp.module)};` : `import ${parts.join(", ")} from ${jsString(imp.module)};`;
  }

  /** Records that this module references another class and returns its local name. */
  private classRef(info: ClassInfo): string {
    if (isNative(info)) return jsNameOf(info); // a JS global: nothing to import
    if (info.module !== this.module) this.imports.set(info.qname, info);
    return info.decl.name.name;
  }

  private typeName(t: A.TypeNode): string {
    const info = this.check.typeResolutions.get(t);
    if (info) return this.classRef(info);
    return t.kind === "TypeName" ? t.name.map((n) => n.name).join(".") : "Object";
  }

  private classDecl(decl: A.ClassDecl, exported: boolean) {
    const info = [...this.check.classes.values()].find((c) => c.decl === decl)!;
    if (decl.isEnum) {
      // Enums are frozen plain objects: `Direction.Up` reads like JS and `Object.values` lists them.
      const entries = [...(info.enumValues ?? [])].map(([k, v]) => `${k}: ${constToJs(v, jsString).code}`);
      this.w.line(`${exported ? "export " : ""}const ${decl.name.name} = Object.freeze({ ${entries.join(", ")} });`);
      return;
    }
    if (decl.isInterface) {
      // Interfaces exist at runtime only as a marker symbol for `x is IShape`.
      this.w.line(`${exported ? "export " : ""}const ${decl.name.name} = Symbol(${jsString(info.qname)});`);
      return;
    }
    const ext = decl.extends ? ` extends ${this.typeName(decl.extends)}` : "";
    this.w.line(`${exported ? "export " : ""}class ${decl.name.name}${ext} {`);
    this.w.indent();
    let prev: A.Member | undefined;
    if (info.dtor) {
      this.w.line("#disposed = false;");
      prev = decl.members.find((m) => m.kind === "Field") ?? decl.members[0];
    }
    const guard = decl.modifiers.abstract ? this.abstractGuard(decl) : undefined;
    if (guard && !decl.members.some((m) => m.kind === "Method" && m.isConstructor)) {
      // An abstract class without a constructor still needs the guard; arguments go to the parent.
      this.w.line(decl.extends ? "constructor(...args) {" : "constructor() {");
      this.w.indent();
      this.w.line(guard);
      if (decl.extends) this.w.line("super(...args);");
      this.w.dedent();
      this.w.line("}");
      prev = decl.members[0];
    }
    for (const m of decl.members) {
      if (m.kind === "Method" && !m.body && !m.modifiers.abstract) continue;
      // Private inline constants exist only at compile time: every use was replaced by its value.
      if (m.kind === "Field" && m.modifiers.inline && m.modifiers.visibility?.value === "private") continue;
      // Fields stay together; methods and static blocks are separated by blank lines.
      if (prev && (m.kind !== "Field" || prev.kind !== "Field")) this.w.line();
      prev = m;
      if (m.kind === "Field") this.field(m);
      else if (m.kind === "Method" && m.isDestructor) {
        this.destructor(info, m);
      } else if (m.kind === "Method" && !m.body) {
        this.abstractStub(decl, m);
      } else if (m.kind === "Method") {
        this.method(m, !!decl.extends, m.isConstructor ? guard : undefined);
        this.accessorDelegate(decl, m);
      } else if (m.kind === "StaticBlock") {
        this.w.line("static {");
        this.functionBody(m.body);
        this.w.line("}");
      }
    }
    this.w.dedent();
    this.w.line("}");
    // Mark the prototype for every interface this class implements (super-interfaces included);
    // subclasses inherit the marks through the prototype chain.
    const marks = [...supertypes(info)].filter((t) => t.decl.isInterface && !this.inheritedMark(info, t));
    for (const iface of marks) this.w.line(`${decl.name.name}.prototype[${this.classRef(iface)}] = true;`);
  }

  /** Is the interface already marked on a superclass's prototype? */
  private inheritedMark(info: ClassInfo, iface: ClassInfo): boolean {
    return !!info.parent && [...supertypes(info.parent)].includes(iface);
  }

  private field(f: A.Field) {
    const folded = this.check.inlineFields.get(f);
    const init = folded !== undefined ? constToJs(folded, jsString).code : f.init ? this.expr(f.init).code : defaultValue(f.type);
    this.w.line(`${f.modifiers.static ? "static " : ""}${f.name.name} = ${init};`);
  }

  private params(params: A.Param[]): string {
    return params
      .map((p) => (p.rest ? "..." : "") + p.name.name + (p.init ? ` = ${this.expr(p.init).code}` : ""))
      .join(", ");
  }

  /**
   * An overriding getter without a setter (or vice versa) would hide the parent's other half in JS;
   * emit it as a plain delegate: `set x(v) { super.x = v; }`.
   */
  private accessorDelegate(decl: A.ClassDecl, m: A.Method) {
    if (!m.accessor) return;
    const info = [...this.check.classes.values()].find((c) => c.decl === decl);
    const sig = info?.members.get(m.name.name);
    if (!sig?.delegate || sig.decl !== m) return;
    const name = m.name.name;
    this.w.line();
    if (sig.delegate === "set") this.w.line(`set ${name}(value) { super.${name} = value; }`);
    else this.w.line(`get ${name}() { return super.${name}; }`);
  }

  /**
   * `~Name()` → `[Symbol.dispose]()` (async: `[Symbol.asyncDispose]()`), run at most once; the
   * parent's destructor runs afterwards, also after an early `return` or an exception. The
   * topmost class with a destructor also gets `dispose()`.
   */
  private destructor(info: ClassInfo, m: A.Method) {
    const async = !!m.modifiers.async;
    const sym = async ? "Symbol.asyncDispose" : "Symbol.dispose";
    const parent = info.parent ? chainDestructor(info.parent) : undefined;
    this.w.line(`${async ? "async " : ""}[${sym}]() {`);
    this.w.indent();
    this.w.line("if (this.#disposed) return;");
    this.w.line("this.#disposed = true;");
    this.w.dedent();
    if (parent) {
      this.w.indent();
      this.w.line("try {");
      this.functionBody(m.body!);
      this.w.line("} finally {");
      this.w.line(`  ${async ? "await " : ""}super[${sym}]();`);
      this.w.line("}");
      this.w.dedent();
    } else {
      this.functionBody(m.body!);
    }
    this.w.line("}");
    if (!parent) {
      this.w.line();
      this.w.line(async ? `dispose() { return this[${sym}](); }` : `dispose() { this[${sym}](); }`);
    }
  }

  /** `if (new.target === Shape) throw new StateException('Shape is abstract');` */
  private abstractGuard(decl: A.ClassDecl): string {
    const exc = this.classRef(this.check.classes.get("klass.StateException")!);
    const name = decl.name.name;
    return `if (new.target === ${name}) throw new ${exc}(${jsString(`${name} is abstract`)});`;
  }

  /** Abstract members still exist at runtime, for plain-JS subclasses that forget them. */
  private abstractStub(decl: A.ClassDecl, m: A.Method) {
    const exc = this.classRef(this.check.classes.get("klass.NotImplementedException")!);
    const throwLine = `throw new ${exc}(${jsString(`${decl.name.name}.${m.name.name}`)});`;
    const head = m.accessor === "set" ? `set ${m.name.name}(value)` : m.accessor === "get" ? `get ${m.name.name}()` : `${m.modifiers.async ? "async " : ""}${methodName(m.name.name)}(${this.params(m.params)})`;
    this.w.line(`${head} {`);
    this.w.line(`  ${throwLine}`);
    this.w.line("}");
  }

  private method(m: A.Method, hasParent = false, guard?: string) {
    const prefix = [
      m.modifiers.static ? "static " : "",
      m.modifiers.async ? "async " : "",
      m.accessor ? `${m.accessor} ` : "",
    ].join("");
    const name = m.isConstructor ? "constructor" : methodName(m.name.name);
    this.w.line(`${prefix}${name}(${this.params(m.params)}) {`);
    // Derived constructors must call super() before using `this`; Klass inserts it when omitted.
    const first = m.body!.body[0];
    const explicitSuper = first?.kind === "ExprStmt" && first.expr.kind === "Call" && first.expr.callee.kind === "Super";
    const prologue = [guard, m.isConstructor && hasParent && !explicitSuper ? "super();" : undefined].filter((x) => x).join("\n");
    this.functionBody(m.body!, prologue || undefined, m.isConstructor && explicitSuper);
    this.w.line("}");
  }

  /** A method or static block body, with its temporaries declared first (`let $t, $t2;`). */
  /**
   * A method or static block body. Temporaries are declared first (`let $t, $t2;`), and
   * `const $self = this;` when `function` expressions inside use instance members. In a
   * constructor both go after `super(...)`, before which `this` doesn't exist.
   */
  private functionBody(b: A.Block, prologue?: string, explicitSuper = false) {
    this.temps = new Map();
    this.fnTemps = [];
    this.selfNeeded = false;
    this.w.indent();
    if (prologue) this.w.line(prologue);
    const rest = explicitSuper ? b.body.slice(1) : b.body;
    if (explicitSuper) this.stmt(b.body[0]!);
    const at = this.w.mark();
    for (const s of rest) this.stmt(s);
    this.w.dedent();
    const decls: string[] = [];
    if (this.fnTemps.length > 0) decls.push(`let ${this.fnTemps.join(", ")};`);
    if (this.selfNeeded) decls.push("const $self = this;");
    for (const d of decls.reverse()) this.w.insertAt(at, d);
    this.fnTemps = null;
  }

  /** How instance members are reached here: `this`, or `$self` inside `function` expressions. */
  private receiver(): string {
    if (this.dynDepth === 0) return "this";
    this.selfNeeded = true;
    return "$self";
  }

  /** Code for a function expression, arrow function or local function declaration. */
  private fn(f: A.FunctionNode): Code {
    const saved = { w: this.w, temps: this.temps, fnTemps: this.fnTemps };
    this.w = new Writer();
    this.temps = new Map();
    this.fnTemps = [];
    if (!f.arrow) this.dynDepth++;
    try {
      const params = this.params(f.params);
      const head = (f.async ? "async " : "") + (f.arrow ? `(${params}) =>` : `function${f.name ? " " + f.name.name : ""}(${params})`);
      if (f.body.kind !== "Block") {
        const body = this.expr(f.body);
        if (this.fnTemps.length === 0) {
          const code = body.code.startsWith("{") ? `(${body.code})` : this.wrap(body, P.assign);
          return { code: `${head} ${code}`, prec: P.assign };
        }
        // Temporaries need statements: turn the expression body into a block.
        return { code: `${head} {\n  let ${this.fnTemps.join(", ")};\n  return ${body.code};\n}`, prec: P.assign };
      }
      const at = this.w.mark();
      this.blockBody(f.body);
      if (this.fnTemps.length > 0) this.w.insertAt(at, `let ${this.fnTemps.join(", ")};`);
      const inner = this.w.toString().replace(/\n$/, "");
      const code = inner === "" ? `${head} {}` : `${head} {\n${inner}\n}`;
      return { code, prec: f.arrow ? P.assign : P.primary };
    } finally {
      Object.assign(this, saved);
      if (!f.arrow) this.dynDepth--;
    }
  }

  private blockBody(b: A.Block) {
    this.w.indent();
    for (const s of b.body) this.stmt(s);
    this.w.dedent();
  }

  /** Emits the statements of a nested body (a block's contents or a single statement), indented. */
  private body(b: A.Stmt) {
    if (b.kind === "Block") return this.blockBody(b);
    this.w.indent();
    this.stmt(b);
    this.w.dedent();
  }

  private nested(head: string, body: A.Stmt, tail = "") {
    this.w.line(`${head} {`);
    this.body(body);
    this.w.line(`}${tail}`);
  }

  private stmt(s: A.Stmt) {
    switch (s.kind) {
      case "Block":
        this.w.line("{");
        this.blockBody(s);
        this.w.line("}");
        return;
      case "VarDecl": {
        if (s.inline) return; // inline constants are pasted at every use
        const kw = s.decl === "var" ? "let" : s.decl === "const" ? "const" : s.init ? "const" : "let";
        const init = s.init ? this.expr(s.init).code : s.decl === "var" ? defaultValue(s.type) : undefined;
        this.w.line(`${kw} ${s.name.name}${init === undefined ? "" : ` = ${init}`};`);
        return;
      }
      case "ExprStmt": {
        const code = this.expr(s.expr).code;
        // An expression statement must not start with `{` or `function` in JS.
        this.w.line(/^(\{|function\b)/.test(code) ? `(${code});` : `${code};`);
        return;
      }
      case "Return":
        this.w.line(s.value ? `return ${this.expr(s.value).code};` : "return;");
        return;
      case "If": {
        this.w.line(`if (${this.expr(s.cond).code}) {`);
        this.body(s.then);
        let els = s.else;
        while (els) {
          if (els.kind === "If") {
            this.w.line(`} else if (${this.expr(els.cond).code}) {`);
            this.body(els.then);
            els = els.else;
          } else {
            this.w.line("} else {");
            this.body(els);
            els = undefined;
          }
        }
        this.w.line("}");
        return;
      }
      case "IfVar":
        this.w.line("{");
        this.w.indent();
        this.w.line(`let ${bindingNames(s.header)};`);
        this.w.line(`if (${this.headerCond(s.header)}) {`);
        this.body(s.then);
        if (s.else) {
          this.w.line("} else {");
          this.body(s.else);
        }
        this.w.line("}");
        this.w.dedent();
        this.w.line("}");
        return;
      case "WhileVar":
        this.nested(`for (let ${bindingNames(s.header)}; ${this.headerCond(s.header)}; )`, s.body);
        return;
      case "For": {
        let init = "";
        if (s.init?.kind === "VarDecl") {
          const d = s.init;
          const value = d.init ? this.expr(d.init).code : defaultValue(d.type);
          init = `${d.decl === "var" ? "let" : "const"} ${d.name.name} = ${value}`;
        } else if (s.init) init = this.expr(s.init.expr).code;
        const cond = s.cond ? ` ${this.expr(s.cond).code}` : "";
        const update = s.update ? ` ${this.expr(s.update).code}` : "";
        this.nested(`for (${init};${cond};${update})`, s.body);
        return;
      }
      case "ForIn":
      case "ForOf": {
        const kw = s.variable.decl === "var" ? "let" : "const";
        const source = s.kind === "ForIn" ? `in ${this.expr(s.object).code}` : `of ${this.expr(s.iterable).code}`;
        const target = s.variable.pattern ? this.pattern(s.variable.pattern) : s.variable.name.name;
        this.nested(`for (${kw} ${target} ${source})`, s.body);
        return;
      }
      case "ForRange": {
        const v = s.variable.name.name;
        const start = this.wrap(this.expr(s.start), P.assign);
        const step = s.step ? Number(this.expr(s.step).code) : 1;
        const update = step === 1 ? `${v}++` : `${v} += ${step}`;
        if (!s.end) {
          this.nested(`for (let ${v} = ${start}; ; ${update})`, s.body);
          return;
        }
        const cmp = s.inclusive ? "<=" : "<";
        let decls = `let ${v} = ${start}`;
        let end: string;
        const endCode = this.expr(s.end);
        if (s.end.kind === "Number" || (endCode.prec === P.primary && this.check.inlineValues.has(s.end))) end = endCode.code;
        else {
          end = this.temp("$end");
          decls += `, ${end} = ${this.wrap(this.expr(s.end), P.assign)}`;
        }
        this.nested(`for (${decls}; ${v} ${cmp} ${end}; ${update})`, s.body);
        return;
      }
      case "Switch":
        this.w.line(`switch (${this.expr(s.discriminant).code}) {`);
        this.w.indent();
        for (const c of s.cases) {
          const label = c.test ? `case ${this.expr(c.test).code}:` : "default:";
          // Each case has its own scope in Klass; JS needs braces when a case declares variables.
          const braces = c.body.some((x) => x.kind === "VarDecl" || x.kind === "UsingDecl" || x.kind === "DestructDecl" || x.kind === "FuncDecl");
          this.w.line(braces ? `${label} {` : label);
          this.w.indent();
          for (const x of c.body) this.stmt(x);
          this.w.dedent();
          if (braces) this.w.line("}");
        }
        this.w.dedent();
        this.w.line("}");
        return;
      case "While":
        this.nested(`while (${this.expr(s.cond).code})`, s.body);
        return;
      case "DoWhile":
        this.nested("do", s.body, ` while (${this.expr(s.cond).code});`);
        return;
      case "Break":
        this.w.line("break;");
        return;
      case "Continue":
        this.w.line("continue;");
        return;
      case "Throw": {
        // A `*` value is normalized at runtime so that only Exceptions are ever thrown.
        const t = this.check.exprTypes.get(s.value);
        const v = this.expr(s.value).code;
        this.w.line(t?.kind === "any" ? `throw ${this.exceptionRef()}.from(${v});` : `throw ${v};`);
        return;
      }
      case "Try":
        return this.tryStmt(s);
      case "FuncDecl":
        this.w.line(this.fn(s.fn).code);
        return;
      case "DestructDecl":
        this.w.line(`${s.decl === "var" ? "let" : "const"} ${this.pattern(s.pattern)} = ${this.wrap(this.expr(s.init), P.assign)};`);
        return;
      case "UsingDecl":
        this.w.line(`${s.isAwait ? "await " : ""}using ${s.name.name} = ${this.wrap(this.expr(s.init), P.assign)};`);
        return;
      case "UsingBlock": {
        // A plain block whose `using` declarations end with it.
        const decls = s.resources.map((r) => {
          const name = r.kind === "Decl" ? r.name.name : this.temp("$r");
          return `${name} = ${this.wrap(this.expr(r.kind === "Decl" ? r.init : r.expr), P.assign)}`;
        });
        this.w.line("{");
        this.w.indent();
        this.w.line(`${s.isAwait ? "await " : ""}using ${decls.join(", ")};`);
        if (s.body.kind === "Block") for (const x of s.body.body) this.stmt(x);
        else this.stmt(s.body);
        this.w.dedent();
        this.w.line("}");
        return;
      }
      case "Empty":
        return;
    }
  }

  /** Reference to the prelude's `Exception` class (imported on demand). */
  private exceptionRef(): string {
    return this.classRef(this.check.classes.get("klass.Exception")!);
  }

  /**
   * `try`/`catch`/`finally`. Everything caught is normalized with `Exception.from`, then
   * dispatched with `instanceof`; when no clause matches, the original value is rethrown.
   */
  private tryStmt(s: A.Stmt & { kind: "Try" }) {
    this.w.line("try {");
    this.blockBody(s.block);
    if (s.catches.length > 0) {
      const raw = this.temp("$err");
      this.w.line(`} catch (${raw}) {`);
      this.w.indent();
      const exc = this.exceptionRef();
      const typeOf = (c: A.CatchClause) => (c.type ? this.check.typeResolutions.get(c.type) : undefined);
      const isCatchAll = (c: A.CatchClause) => {
        const info = typeOf(c);
        return !info || info.qname === "klass.Exception";
      };
      const only = s.catches[0]!;
      if (s.catches.length === 1 && isCatchAll(only)) {
        this.w.line(`let ${only.name.name} = ${exc}.from(${raw});`);
        for (const x of only.body.body) this.stmt(x);
      } else {
        const value = this.temp("$exc");
        this.w.line(`const ${value} = ${exc}.from(${raw});`);
        let head = "if";
        let catchAll = false;
        for (const c of s.catches) {
          if (isCatchAll(c)) {
            this.w.line(head === "if" ? "{" : "} else {");
            catchAll = true;
          } else {
            this.w.line(`${head === "if" ? "if" : "} else if"} (${value} instanceof ${this.classRef(typeOf(c)!)}) {`);
          }
          this.w.indent();
          this.w.line(`let ${c.name.name} = ${value};`);
          for (const x of c.body.body) this.stmt(x);
          this.w.dedent();
          head = "else";
          if (catchAll) break;
        }
        if (!catchAll) {
          this.w.line("} else {");
          this.w.line(`  throw ${raw};`);
        }
        this.w.line("}");
      }
      this.w.dedent();
    }
    if (s.finally) {
      this.w.line("} finally {");
      this.blockBody(s.finally);
    }
    this.w.line("}");
  }

  /** JS destructuring syntax for a pattern (declarations and assignments alike). */
  private pattern(p: A.Pattern): string {
    const init = p.init ? ` = ${this.wrap(this.expr(p.init), P.assign)}` : "";
    switch (p.kind) {
      case "BindingName":
        return p.name.name + init;
      case "Target":
        return this.expr(p.expr).code + init;
      case "ObjectPattern": {
        const props = p.props.map((prop) => {
          const v = prop.value;
          // `{name}` / `{name = 1}` stay shorthand; everything else is `key: pattern`.
          if (v.kind === "BindingName" && v.name.name === prop.key.name) return this.pattern(v);
          return `${prop.key.name}: ${this.pattern(v)}`;
        });
        if (p.rest) props.push(`...${this.pattern(p.rest)}`);
        return `{ ${props.join(", ")} }${init}`;
      }
      case "ArrayPattern": {
        const els = p.elements.map((el) => (el ? this.pattern(el) : ""));
        if (p.rest) els.push(`...${this.pattern(p.rest)}`);
        // A trailing hole needs its comma: `[a, ]`.
        const trailingHole = p.elements.length > 0 && p.elements.at(-1) === null && !p.rest;
        return `[${els.join(", ")}${trailingHole ? "," : ""}]${init}`;
      }
    }
  }

  /** `(a = x) != null && (b = y) != null && cond` for an `if`/`while` binding header. */
  private headerCond(items: A.HeaderItem[]): string {
    return items
      .map((item) =>
        item.kind === "Binding"
          ? `(${item.name.name} = ${this.wrap(this.expr(item.init), P.assign)}) != null`
          : this.wrap(this.expr(item.expr), P.and + 1),
      )
      .join(" && ");
  }

  /** A fresh temporary name within the current method (`$end`, `$end2`, …); `declare` hoists a `let`. */
  private temp(base: string, declare = false): string {
    const n = (this.temps.get(base) ?? 0) + 1;
    this.temps.set(base, n);
    const name = n === 1 ? base : `${base}${n}`;
    if (declare) this.fnTemps?.push(name);
    return name;
  }

  /**
   * Builds code that uses a value more than once. Simple values (locals, `this`) are repeated;
   * others are stored in a temporary: `build("($t = expr)", "$t")`.
   */
  private reuse(e: A.Expr, build: (first: string, again: string) => Code): Code {
    const v = this.expr(e);
    const r = e.kind === "Ident" ? this.check.resolutions.get(e) : undefined;
    const simple = e.kind === "This" || e.kind === "Bool" || e.kind === "String" || e.kind === "Number" || (e.kind === "Ident" && (r?.kind === "local" || r?.kind === "jsImport" || r?.kind === "global"));
    if (simple) return build(this.wrap(v, P.call), this.wrap(v, P.call));
    if (this.fnTemps) {
      const t = this.temp("$t", true);
      return build(`(${t} = ${this.wrap(v, P.assign)})`, t);
    }
    // Outside a function (field initializers): an arrow function call provides the temporary.
    const inner = build("$t", "$t");
    return { code: `(($t) => ${inner.code})(${this.wrap(v, P.assign)})`, prec: P.call };
  }

  /**
   * An instance method used as a value, bound to its object like an AS3 method closure.
   * The bound function is cached on the instance under a registered symbol, so `this.handle`
   * is the same function every time (`removeEventListener` works) and it stays invisible to
   * `JSON.stringify`/`Object.keys`.
   */
  private methodClosure(e: A.Expr): Code {
    const key = (k: string) => `Symbol.for(${jsString(k)})`;
    if (e.kind === "Ident") {
      const self = this.receiver();
      return { code: `${self}[${key(`klass.bound.${e.name}`)}] ??= ${self}.${e.name}.bind(${self})`, prec: P.assign };
    }
    if (e.kind !== "Member") throw new Error("codegen: unexpected method closure");
    const name = e.name.name;
    if (e.object.kind === "Super") {
      // The parent's version, cached separately from an override with the same name.
      const parent = (this.check.exprTypes.get(e.object) as { info?: ClassInfo }).info?.decl.name.name ?? "super";
      return { code: `this[${key(`klass.bound.${parent}.${name}`)}] ??= super.${name}.bind(this)`, prec: P.assign };
    }
    // A primitive can't hold the cache property (strict mode throws), and has no identity anyway.
    if (this.check.exprTypes.get(e.object)?.kind === "prim") {
      return this.reuse(e.object, (first, again) => ({ code: `${first}.${name}.bind(${again})`, prec: P.call }));
    }
    return this.reuse(e.object, (first, again) => ({
      code: `${first}[${key(`klass.bound.${name}`)}] ??= ${again}.${name}.bind(${again})`,
      prec: P.assign,
    }));
  }

  /** Plain-JS runtime test for `is`/`as`. */
  private runtimeTest(check: RuntimeCheck, first: string, again: string): Code {
    switch (check.kind) {
      case "class": return { code: `${first} instanceof ${this.classRef(check.info)}`, prec: P.rel };
      case "interface": return { code: `${first}?.[${this.classRef(check.info)}] === true`, prec: P.eq };
      case "enum": return { code: `Object.values(${this.classRef(check.info)}).includes(${first})`, prec: P.call };
      case "js": return { code: `${first} instanceof ${check.name}`, prec: P.rel };
      case "typeof": return { code: `typeof ${first} === ${jsString(check.tag)}`, prec: P.eq };
      case "int": return { code: `Number.isInteger(${first})`, prec: P.call };
      case "uint": return { code: `Number.isInteger(${first}) && ${again} >= 0`, prec: P.and };
      case "array": return { code: `Array.isArray(${first})`, prec: P.call };
      case "object": return { code: `${first} != null`, prec: P.eq };
    }
  }

  private typeOp(e: A.Expr & { kind: "TypeOp" }): Code {
    const check = this.check.typeChecks.get(e);
    if (!check) return this.expr(e.expr); // `x as Shape`: an unchecked cast to a structural type
    if (e.op === "is") {
      if (check.kind !== "uint") {
        const v = this.wrap(this.expr(e.expr), check.kind === "typeof" ? P.unary : check.kind === "interface" ? P.call : P.rel + 1);
        return this.runtimeTest(check, v, v);
      }
      return this.reuse(e.expr, (first, again) => this.runtimeTest(check, first, again));
    }
    return this.reuse(e.expr, (first, again) => {
      const test = this.runtimeTest(check, first, again);
      return { code: `${this.wrap(test, P.or)} ? ${again} : null`, prec: P.cond };
    });
  }

  private wrap(c: Code, min: number): string {
    return c.prec < min ? `(${c.code})` : c.code;
  }

  private args(args: A.Expr[]): string {
    return args.map((a) => this.wrap(this.expr(a), P.assign)).join(", ");
  }

  expr(e: A.Expr): Code {
    const folded = this.check.inlineValues.get(e);
    if (folded !== undefined) {
      const js = constToJs(folded, jsString);
      return { code: js.code, prec: js.negative ? P.unary : P.primary };
    }
    if (this.check.methodClosures.has(e)) return this.methodClosure(e);
    switch (e.kind) {
      case "Ident": {
        const r = this.check.resolutions.get(e);
        if (r?.kind === "member") {
          return { code: r.isStatic ? `${this.classRef(r.owner)}.${e.name}` : `${this.receiver()}.${e.name}`, prec: P.call };
        }
        if (r?.kind === "class") return { code: this.classRef(r.info), prec: P.primary };
        if (r?.kind === "builtin" && r.name === "trace") return { code: "console.log", prec: P.call };
        // A cast through an alias (`Bool(x)`) calls the real JS function.
        if (r?.kind === "builtin") return { code: r.name === "Float" ? "Number" : r.name, prec: P.primary };
        return { code: e.name, prec: P.primary };
      }
      case "This": return { code: "this", prec: P.primary };
      case "Super": return { code: "super", prec: P.primary };
      // `255.toString()` is a JS syntax error (the `.` is read as a decimal point): integer
      // literals get parentheses where a member access follows, and nowhere else.
      case "Number": return { code: e.raw, prec: /^[0-9_]+$/.test(e.raw) ? P.postfix : P.primary };
      case "String": return { code: jsString(e.value), prec: P.primary };
      case "Bool": return { code: String(e.value), prec: P.primary };
      case "Null": return { code: "null", prec: P.primary };
      case "Undefined": return { code: "undefined", prec: P.primary };
      case "Regex": return { code: `/${e.pattern}/${e.flags}`, prec: P.primary };
      case "Template": {
        let code = "`";
        for (const p of e.parts) code += p.kind === "text" ? templateText(p.value) : "${" + this.expr(p.expr).code + "}";
        return { code: code + "`", prec: P.primary };
      }
      case "Array":
        return { code: `[${this.args(e.elements)}]`, prec: P.primary };
      case "Object": {
        if (e.props.length === 0) return { code: "{}", prec: P.primary };
        const props = e.props.map((p) => {
          if (p.kind === "SpreadProp") return `...${this.wrap(this.expr(p.arg), P.assign)}`;
          if (p.kind === "Shorthand") {
            const r = this.check.resolutions.get(p);
            if (r?.kind === "member") return `${p.name.name}: ${r.isStatic ? this.classRef(r.owner) : this.receiver()}.${p.name.name}`;
            return p.name.name;
          }
          const key = "name" in p.key ? p.key.name : p.key.kind === "StringKey" ? jsString(p.key.value) : `[${this.expr(p.key.expr).code}]`;
          return `${key}: ${this.wrap(this.expr(p.value), P.assign)}`;
        });
        return { code: `{ ${props.join(", ")} }`, prec: P.primary };
      }
      case "Spread":
        return { code: `...${this.wrap(this.expr(e.arg), P.assign)}`, prec: P.assign };
      case "Member": {
        // Inherited statics are addressed through their declaring class: in JS, `Dog.count++`
        // would create a new property on `Dog` instead of updating `Animal.count`.
        const objType = this.check.exprTypes.get(e.object);
        if (objType?.kind === "classRef") {
          const m = findMember(objType.info, e.name.name);
          if (m?.isStatic && m.owner !== objType.info) return { code: `${this.classRef(m.owner)}.${e.name.name}`, prec: P.call };
        }
        return { code: `${this.wrap(this.expr(e.object), P.call)}${e.optional ? "?." : "."}${e.name.name}`, prec: P.call };
      }
      case "Index":
        return { code: `${this.wrap(this.expr(e.object), P.call)}${e.optional ? "?." : ""}[${this.expr(e.index).code}]`, prec: P.call };
      case "Call":
        return this.call(e);
      case "New":
        return { code: `new ${this.typeName(e.callee)}(${this.args(e.args)})`, prec: P.call };
      case "Unary": {
        const op = e.op === "typeof" || e.op === "delete" ? `${e.op} ` : e.op;
        let arg = this.wrap(this.expr(e.arg), P.unary);
        // Avoid `- -x` turning into `--x`.
        if ((e.op === "-" || e.op === "+") && arg.startsWith(e.op)) arg = `(${arg})`;
        return { code: op + arg, prec: P.unary };
      }
      case "Await":
        return { code: `await ${this.wrap(this.expr(e.arg), P.unary)}`, prec: P.unary };
      case "Update": {
        const arg = this.wrap(this.expr(e.arg), P.postfix);
        return e.prefix ? { code: e.op + arg, prec: P.unary } : { code: arg + e.op, prec: P.postfix };
      }
      case "Binary":
        return this.binary(e);
      case "Assign":
        if (this.check.operatorCalls.has(e)) return this.operatorAssign(e);
        return { code: `${this.expr(e.target).code} ${e.op} ${this.wrap(this.expr(e.value), P.assign)}`, prec: P.assign };
      case "Conditional":
        return {
          code: `${this.wrap(this.expr(e.cond), P.or)} ? ${this.wrap(this.expr(e.then), P.assign)} : ${this.wrap(this.expr(e.else), P.assign)}`,
          prec: P.cond,
        };
      case "TypeOp":
        return this.typeOp(e);
      case "Function":
        return this.fn(e);
      case "DestructAssign":
        return { code: `${this.pattern(e.pattern)} = ${this.wrap(this.expr(e.value), P.assign)}`, prec: P.assign };
      case "Error":
        throw new Error(`codegen: unsupported expression ${e.kind}`);
    }
  }

  private call(e: A.Expr & { kind: "Call" }): Code {
    // `Direction.values()` → `Object.values(Direction)`
    if (e.callee.kind === "Member" && e.callee.name.name === "values" && e.args.length === 0) {
      const obj = this.check.exprTypes.get(e.callee.object);
      if (obj?.kind === "classRef" && obj.info.decl.isEnum) return { code: `Object.values(${this.classRef(obj.info)})`, prec: P.call };
    }
    const r = e.callee.kind === "Ident" ? this.check.resolutions.get(e.callee) : undefined;
    if (r?.kind === "builtin" && e.args.length === 1) {
      const arg = this.expr(e.args[0]!);
      switch (r.name) {
        case "int": return { code: `${this.wrap(arg, P.bitor + 1)} | 0`, prec: P.bitor };
        case "uint": return { code: `${this.wrap(arg, P.shift + 1)} >>> 0`, prec: P.shift };
        case "Float": return { code: `Number(${this.wrap(arg, P.assign)})`, prec: P.call };
      }
    }
    const callee = this.wrap(this.expr(e.callee), P.call);
    return { code: `${callee}${e.optional ? "?." : ""}(${this.args(e.args)})`, prec: P.call };
  }

  /** `a += b` with `operator+`: `a = a['operator+'](b)`, evaluating the target's object/index once. */
  private operatorAssign(e: A.Expr & { kind: "Assign" }): Code {
    const t = e.target;
    const rhs = this.wrap(this.expr(e.value), P.assign);
    const call = (read: string) => `${read}['operator+'](${rhs})`;
    if (t.kind === "Member") {
      return this.reuse(t.object, (first, again) => ({ code: `${first}.${t.name.name} = ${call(`${again}.${t.name.name}`)}`, prec: P.assign }));
    }
    if (t.kind === "Index") {
      return this.reuse(t.object, (fo, ao) => this.reuse(t.index, (fi, ai) => ({
        code: `${fo}[${fi}] = ${call(`${ao}[${ai}]`)}`,
        prec: P.assign,
      })));
    }
    const target = this.expr(t).code; // a local or `this.x`: repeating it is free
    return { code: `${target} = ${call(target)}`, prec: P.assign };
  }

  private binary(e: A.Expr & { kind: "Binary" }): Code {
    if (this.check.operatorCalls.has(e)) {
      return { code: `${this.wrap(this.expr(e.left), P.call)}['operator+'](${this.wrap(this.expr(e.right), P.assign)})`, prec: P.call };
    }
    let op = e.op;
    const nullCompare = e.left.kind === "Null" || e.right.kind === "Null";
    if (op === "==" && !nullCompare) op = "===";
    if (op === "!=" && !nullCompare) op = "!==";
    const prec = BINARY_JS_PREC[op]!;
    const left = this.expr(e.left);
    const right = this.expr(e.right);
    // JS forbids mixing `??` with `||`/`&&` without parentheses.
    const mixes = (c: A.Expr) => c.kind === "Binary" && ((op === "??") !== (c.op === "??")) && ["??", "||", "&&"].includes(c.op);
    const l = mixes(e.left) ? `(${left.code})` : this.wrap(left, op === "**" ? P.postfix : prec);
    const r = mixes(e.right) ? `(${right.code})` : this.wrap(right, op === "**" ? prec : prec + 1);
    return { code: `${l} ${op} ${r}`, prec };
  }
}
