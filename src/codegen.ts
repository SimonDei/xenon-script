import { posix } from "node:path";
import type * as A from "./ast.ts";
import { accessorHalf, type CheckResult, chainDestructor, type ClassInfo, findMember, isManualDisposable, isNative, jsNameOf, type MemberSig, type RuntimeCheck, type TypedefInfo, visibilityOf } from "./checker.ts";
import { bind, isSubclass, nonNull, subst, supertypes, type Type } from "./types.ts";
import { constToJs } from "./consteval.ts";
import { buildSourceMap, type LineOrigin, originOf } from "./sourcemap.ts";
import type { SourceFile, Span } from "./source.ts";

/**
 * How a field is stored in JavaScript. Private fields are `#name` (really private: invisible to
 * other code, `JSON.stringify` and spread). Other `final`/`const` fields are `#name` behind a
 * getter, so JavaScript code can read but not assign them. Everything else is a plain property.
 * Enums, native classes and the prelude keep plain properties.
 */
function fieldStorage(m: MemberSig | undefined): "private" | "readonly" | "plain" {
  if (!m || m.decl.kind !== "Field" || m.owner.decl.isEnum || isNative(m.owner) || m.owner.file.file.prelude) return "plain";
  if (visibilityOf(m.decl) === "private") return "private";
  return m.decl.decl === "var" ? "plain" : "readonly";
}

/**
 * A property with a public (or protected/internal) getter and a private setter: the setter is a
 * JavaScript private accessor `set #name`, so JavaScript code can't assign the property either.
 */
function privateSetter(m: MemberSig | undefined): boolean {
  if (!m || m.kind !== "accessor" || isNative(m.owner) || m.owner.file.file.prelude) return false;
  const get = accessorHalf(m, "get");
  const set = accessorHalf(m, "set");
  return !!get && !!set && visibilityOf(set) === "private" && visibilityOf(get) !== "private";
}

/**
 * A private method, or a property whose getter and setter are both private: a JavaScript `#name`,
 * which no other code can call. Not constructors, destructors, operator methods (`operator+` is no
 * identifier), enums, native classes or the prelude.
 */
function privateMethod(m: MemberSig | undefined): boolean {
  if (!m || (m.kind !== "method" && m.kind !== "accessor") || m.owner.decl.isEnum || isNative(m.owner) || m.owner.file.file.prelude) return false;
  if (!/^[A-Za-z_$][\w$]*$/.test(m.name)) return false;
  if (m.kind === "accessor") return [accessorHalf(m, "get"), accessorHalf(m, "set")].every((d) => !d || visibilityOf(d) === "private");
  const d = m.decl as A.Method;
  return !d.isConstructor && !d.isDestructor && visibilityOf(d) === "private";
}

/** Standard-library classes that are iterable at runtime but not in TypeScript's typings: the TypeScript output casts them in `for … of`. */
const TS_NOT_ITERABLE = new Set(["xenon.FormData"]);

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

/**
 * Lines of generated code, each remembering where in the Xenon source it came from (for source maps).
 * Code built in a separate writer and spliced in as text (function bodies) carries its origins along
 * as markers at the start of its lines: `\u0001<n>\u0002`, an index into `markers`. Generated lines
 * never start inside a string (line breaks in strings are escaped), so the markers can't clash.
 */
class Writer {
  private lines: string[] = [];
  private origins: (LineOrigin | undefined)[] = [];
  private depth = 0;
  /** Where the lines written now come from: the statement or declaration being generated. */
  origin?: LineOrigin;
  constructor(private readonly markers: LineOrigin[] = []) {}
  /** Adds a line (or several, when `text` contains line breaks) at the current indentation. */
  line(text = "") {
    for (let l of text.split("\n")) {
      let origin = this.origin;
      const m = /^\u0001(\d+)\u0002/.exec(l);
      if (m) {
        origin = this.markers[Number(m[1])];
        l = l.slice(m[0].length);
      }
      this.lines.push(l === "" ? "" : "  ".repeat(this.depth) + l);
      this.origins.push(l === "" ? undefined : origin);
    }
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
    this.origins.splice(index, 0, undefined);
  }
  toString() {
    return this.lines.join("\n") + "\n";
  }
  /** The text with origin markers, for splicing into another writer's lines. */
  marked(): string {
    return this.lines.map((l, i) => {
      const origin = this.origins[i];
      if (!origin) return l;
      this.markers.push(origin);
      return `\u0001${this.markers.length - 1}\u0002${l}`;
    }).join("\n") + "\n";
  }
  /** Each line with its origin. */
  entries(): { text: string; origin?: LineOrigin }[] {
    return this.lines.map((text, i) => ({ text, origin: this.origins[i] }));
  }
}

/** Entry module. Contains a `-` so it can never collide with a class module (Bun treats `main.js`/`Main.js` as one module). */
export const ENTRY_FILE = "xenon-main.js";

/** The entry module's file name for an output target. */
export function entryFile(target: "js" | "ts" = "js"): string {
  return target === "ts" ? ENTRY_FILE.replace(/\.js$/, ".ts") : ENTRY_FILE;
}

/**
 * A range of the Xenon source and the generated code it became (offsets). Names keep their
 * length; other tokens may change it (`trace` → `console.log`, `int` → `number`).
 */
export interface Mapping {
  source: number;
  sourceLength: number;
  generated: number;
  generatedLength: number;
}

/** The Xenon offset a generated offset came from (inside a mapped token), or undefined. */
export function sourceOffsetAt(mappings: Mapping[], generated: number): number | undefined {
  const m = mappings.find((m) => m.generated <= generated && generated < m.generated + Math.max(1, m.generatedLength));
  return m && m.source + Math.min(generated - m.generated, Math.max(0, m.sourceLength - 1));
}

/** The generated offset of a Xenon offset (inside a mapped token), or undefined. */
export function generatedOffsetAt(mappings: Mapping[], source: number): number | undefined {
  const m = mappings.find((m) => m.source <= source && source < m.source + Math.max(1, m.sourceLength));
  return m && m.generated + Math.min(source - m.source, Math.max(0, m.generatedLength - 1));
}

export interface OutputFile {
  path: string;
  text: string;
  /** The Xenon file this module was generated from (not for maps and the entry module). */
  source?: SourceFile;
  /** Token mappings between `source` and `text` (TypeScript output). */
  mappings?: Mapping[];
  /** A JavaScript file of the source folder, copied as it is. */
  asset?: boolean;
}

export interface GenerateOptions {
  /**
   * Emit a `.js.map` next to every module; `sourceRoot` is the source directory as seen from the
   * output directory (`../src`), so the maps point at the real `.xn` files.
   */
  sourceMaps?: { sourceRoot: string };
  /**
   * `ts`: typed TypeScript instead of JavaScript (`.ts` modules, imports still name `.js`), with
   * token mappings: the virtual files a TypeScript language service works on.
   */
  target?: "js" | "ts";
  /** Code with errors (editor mode): a file whose generation fails is skipped instead of throwing. */
  tolerant?: boolean;
  /**
   * Packages a page loads as globals (`<script>` tags): `{ "pizzip": "PizZip" }`. Their imports
   * become reads of the global in JavaScript output (typed from the package all the same).
   */
  globals?: Record<string, string>;
}

/** The module a source file compiles to: `com/zoo/Dog.xn` → `com/zoo/Dog.js` (a file's package matches its directory). */
function moduleOf(file: A.XenonFile): string {
  return file.file.path.replace(/\.xn$/, ".js");
}

/** Generates one ES module per source file with classes (file-private classes go into the same module). */
export function generate(files: A.XenonFile[], check: CheckResult, mainClass: ClassInfo | undefined, options: GenerateOptions = {}): OutputFile[] {
  const ts = options.target === "ts";
  const toTs = (module: string) => (ts ? module.replace(/\.js$/, ".ts") : module);
  const out: OutputFile[] = [];
  // One ES module per source file: its package-level classes are exported, file-private ones are not.
  for (const file of files) {
    if (file.file.generated) continue; // declarations of JavaScript modules: nothing to emit
    const all = [...file.decls, ...file.privateDecls];
    const first = all.find((d) => d.kind === "Class" && !d.modifiers.native);
    // Only typedefs and native declarations: nothing to emit (TypeScript keeps the typedefs, as types).
    if (!first && !(ts && !file.file.prelude && all.some((d) => d.kind === "Typedef"))) continue;
    const module = (first && [...check.classes.values()].find((c) => c.decl === first)?.module) || moduleOf(file);
    const gen = new ModuleGen(module, file, check, ts, ts || !!options.sourceMaps);
    gen.globals = options.globals ?? {};
    let entries: ReturnType<ModuleGen["run"]>;
    try {
      entries = gen.run();
    } catch (e) {
      if (options.tolerant) continue;
      throw e;
    }
    const { lines, mappings } = resolveTokens(entries, gen.tokens, file.file);
    let text = lines.map((l) => l.text).join("\n") + "\n";
    if (options.sourceMaps && !ts) {
      const name = posix.basename(module);
      // The prelude has no file on disk; its map carries the text (`sourcesContent`), as all maps do.
      const up = posix.relative(posix.dirname(module), ".");
      const source = file.file.prelude ? posix.basename(file.file.path) : posix.join(up, options.sourceMaps.sourceRoot, file.file.path);
      const map = buildSourceMap(name, source, file.file.text, lines);
      text += `//# sourceMappingURL=${name}.map\n`;
      out.push({ path: module + ".map", text: JSON.stringify(map) + "\n" });
    }
    out.push({ path: toTs(module), text, source: file.file, ...(ts ? { mappings } : {}) });
  }
  if (!mainClass) return out;
  const entry = new Writer();
  entry.line(`import { ${mainClass.decl.name.name} } from ${jsString("./" + mainClass.module)};`);
  entry.line();
  entry.line(`new ${mainClass.decl.name.name}();`);
  out.push({ path: entryFile(options.target), text: entry.toString() });
  return out;
}

/** Token markers in generated code: `\u0003<n>\u0004text\u0005` maps `text` to the source span `tokens[n]`. */
const TOKEN = /\u0003(\d+)\u0004|\u0005/g;

/** Code without token markers (for code that inspects generated text). */
function plain(code: string): string {
  return code.replace(TOKEN, "");
}

/**
 * Removes the token markers: returns the clean lines, each with the source positions of its tokens
 * (for column-exact source maps), and the token mappings as offsets.
 */
function resolveTokens(entries: { text: string; origin?: LineOrigin }[], tokens: Span[], file: SourceFile) {
  const mappings: Mapping[] = [];
  const open: { span: Span; generated: number }[] = [];
  let offset = 0;
  const lines = entries.map(({ text, origin }) => {
    let clean = "";
    let last = 0;
    const segments: { col: number; origin: LineOrigin }[] = [];
    for (const m of text.matchAll(TOKEN)) {
      clean += text.slice(last, m.index);
      last = m.index + m[0].length;
      if (m[1] !== undefined) {
        const span = tokens[Number(m[1])]!;
        open.push({ span, generated: offset + clean.length });
        const { line, col } = file.position(span.start);
        segments.push({ col: clean.length, origin: { line: line - 1, col: col - 1 } });
      } else {
        const t = open.pop()!;
        mappings.push({ source: t.span.start, sourceLength: t.span.end - t.span.start, generated: t.generated, generatedLength: offset + clean.length - t.generated });
      }
    }
    clean += text.slice(last);
    offset += clean.length + 1;
    return { text: clean, origin, segments };
  });
  mappings.sort((a, b) => a.generated - b.generated);
  return { lines, mappings };
}

/** TypeScript names of the standard library's native classes, where they differ. */
/** Native classes TypeScript names differently: its generic `NodeList` is `NodeListOf<T>`. */
const TS_NATIVE: Record<string, string> = { Iterator: "IteratorObject", NodeList: "NodeListOf" };

/**
 * Built-in enumerables (`Array<T> implements Iterable<T>` in the standard library) get
 * `getEnumerator()` in the TypeScript output's types, so they fit `Iterable<T>` there too. At
 * runtime calls go through `Enumerable.enumerate`.
 */
/**
 * Destruction of scoped values (src/scoped.ts), appended to the prelude module: the method key
 * destructors are compiled to, and the helpers a scope's `finally` calls. `error` is what is leaving
 * the scope (`$noError` on a normal exit); a destructor failing during an exception keeps both
 * errors as a `SuppressedError`, as JavaScript's `using` does.
 */
function scopedHelpers(ts: boolean): string {
  const any = ts ? ": any" : "";
  return `/** The method destructors of scoped classes are compiled to. */
export const $Destroy${ts ? ": unique symbol" : ""} = Symbol("xenon.destroy");
/** Passed to \`$destroy\` when a scope ends without an exception. */
export const $noError${ts ? ": unique symbol" : ""} = Symbol("xenon.noError");
/** Destroys a scoped value at the end of its scope (nothing for \`null\`: a value handed on by \`return\`). */
export function $destroy(value${any}, error${ts ? ": unknown" : ""})${ts ? ": void" : ""} {
  if (value == null) return;
  if (error === $noError) return value[$Destroy]();
  try {
    value[$Destroy]();
  } catch (e) {
    throw $suppressed(e, error);
  }
}
/** \`$destroy\` for async destructors. */
export async function $destroyAsync(value${any}, error${ts ? ": unknown" : ""})${ts ? ": Promise<void>" : ""} {
  if (value == null) return;
  if (error === $noError) return await value[$Destroy]();
  try {
    await value[$Destroy]();
  } catch (e) {
    throw $suppressed(e, error);
  }
}
/**
 * A method wrapped by attributes (\`IAttribute.wrap\`), on its first call: the attribute classes may
 * be defined after this class (later in the module, or in a module of an import cycle).
 */
export function $wrapLazily(method${any}, wrap${ts ? ": (method: any) => any" : ""})${ts ? ": any" : ""} {
  let wrapped${any};
  return function (${ts ? "this: any, " : ""}...args${ts ? ": any[]" : ""}) {
    return (wrapped ??= wrap(method)).apply(this, args);
  };
}
/** A checked position (\`a[i]\` on an array or string): \`i\` itself, or a \`RangeException\` when it is out of range. */
export function $index(array${ts ? ": { length: number }" : ""}, i${ts ? ": number" : ""})${ts ? ": number" : ""} {
  if (i >= 0 && i < array.length) return i;
  throw new RangeException(\`index \${i} is out of range (length \${array.length})\`);
}
function $suppressed(error${ts ? ": unknown" : ""}, suppressed${ts ? ": unknown" : ""})${ts ? ": Error" : ""} {
  const message = "An error was suppressed during disposal";
  if (typeof SuppressedError === "function") return new SuppressedError(error, suppressed, message);
  const e${any} = new Error(message);
  e.name = "SuppressedError";
  e.error = error;
  e.suppressed = suppressed;
  return e;
}`;
}

const TS_ENUMERABLE_GLOBALS = `declare global {
  interface Array<T> { getEnumerator(): IEnumerator<T>; }
  interface String { getEnumerator(): IEnumerator<string>; }
  interface Set<T> { getEnumerator(): IEnumerator<T>; }
  interface Map<K, V> { getEnumerator(): IEnumerator<any[]>; }
  interface IteratorObject<T, TReturn, TNext> { getEnumerator(): IEnumerator<T>; }
}`;

class ModuleGen {
  /** Packages loaded as globals (`GenerateOptions.globals`): package → global name. */
  globals: Record<string, string> = {};
  /** Origins of lines spliced in as text (see `Writer`), shared by this module's writers. */
  private markers: LineOrigin[] = [];
  private w = new Writer(this.markers);
  private imports = new Map<string, ClassInfo>();
  private temps = new Map<string, number>();
  /** Temporaries to declare at the top of the current function; null outside functions. */
  private fnTemps: string[] | null = null;
  /** Nesting depth of `function(){}` expressions, whose `this` is not the instance. */
  private dynDepth = 0;
  /** The current method needs `const $self = this;` (members used inside `function` expressions). */
  private selfNeeded = false;
  /** Source spans of the token markers in the generated code (see `tok`). */
  readonly tokens: Span[] = [];
  /** Typedefs imported for TypeScript annotations: module → names. */
  private typeImports = new Map<string, Set<string>>();
  /** The prelude's scope helpers this module uses (`$destroy`, …). */
  private helpers = new Set<string>();
  /** Temporaries of the statement being generated that own a scoped value (src/scoped.ts); null when none can. */
  private stmtTemps: { name: string; async: boolean }[] | null = null;

  /** A scope helper of the prelude, imported on demand (the prelude itself defines them). */
  private helper(name: "$Destroy" | "$noError" | "$destroy" | "$destroyAsync" | "$wrapLazily" | "$index"): string {
    if (!this.file.file.prelude) this.helpers.add(name);
    return name;
  }

  constructor(
    private module: string,
    private file: A.XenonFile,
    private check: CheckResult,
    /** TypeScript output: annotations, interfaces and typedefs as types. */
    private ts = false,
    /** Mark tokens with their source positions (`resolveTokens` turns the markers into mappings). */
    private mapTokens = false,
  ) {}

  /** `text`, generated from the source at `span`. */
  private tok(span: Span, text: string): string {
    if (!this.mapTokens) return text;
    this.tokens.push(span);
    return `\u0003${this.tokens.length - 1}\u0004${text}\u0005`;
  }

  /** A name copied from the source. */
  private name(id: A.Ident): string {
    return this.tok(id.span, id.name);
  }

  // ---- TypeScript types ----

  /** `: T` for a type annotation (TypeScript output only). */
  private ann(node: A.TypeNode | undefined): string {
    if (!this.ts || !node) return "";
    const t = this.check.typeNodeTypes.get(node);
    return `: ${this.tok(node.span, t ? this.tsType(t) : "any")}`;
  }

  /** `: T` for a type that has no annotation in the source (TypeScript output only). */
  private annType(t: Type | undefined): string {
    return this.ts && t ? `: ${this.tsType(t)}` : "";
  }

  /** `<T, U>` for declared type parameters (TypeScript output only). */
  private typeParams(params: A.Ident[] | undefined): string {
    return this.ts && params?.length ? `<${params.map((p) => this.name(p)).join(", ")}>` : "";
  }

  /** A Xenon type in TypeScript. `top`: a typedef's own body (not its name). */
  private tsType(t: Type, top = false): string {
    switch (t.kind) {
      case "prim":
        if (t.literal !== undefined) return JSON.stringify(t.literal); // `true`, `"buffer"`
        return t.name === "String" ? "string" : t.name === "Bool" ? "boolean" : "number";
      case "void": return "void";
      case "null": return "null";
      case "union": return t.types.map((m) => (m.kind === "method" ? `(${this.tsType(m)})` : this.tsType(m))).join(" | ");
      case "any": case "error": return "any";
      case "builtin":
        switch (t.name) {
          case "Array": return `Array<${this.tsType(t.args[0] ?? { kind: "any" })}>`;
          case "Tuple": return `[${t.args.map((a) => this.tsType(a)).join(", ")}]`;
          case "Function": return "Function";
          case "Object": return "Record<string, any>"; // a dynamic object: any property may be read
          // A class value: anything `new` can create a `T` with (abstract classes included).
          case "Class": return t.args[0] ? `(abstract new (...args: any) => ${this.tsType(t.args[0])})` : "any";
        }
        return "any";
      case "class": {
        const info = t.info;
        const args = t.args?.length ? `<${t.args.map((a) => this.tsType(a)).join(", ")}>` : "";
        if (isNative(info)) {
          const name = jsNameOf(info);
          // Declared from a `.d.ts`: TypeScript knows the type under the local import name only.
          if (info.file.file.generated) return this.importedNames().has(name) ? name : "any";
          return (TS_NATIVE[name] ?? name) + args;
        }
        return this.classRef(info) + args;
      }
      case "typeParam": return t.param.name;
      case "classRef":
        if (t.info.file.file.generated && !this.importedNames().has(jsNameOf(t.info))) return "any";
        return `typeof ${this.classRef(t.info)}`;
      case "nullable": {
        const inner = this.tsType(t.inner);
        return `${inner.includes("=>") ? `(${inner})` : inner} | null`;
      }
      case "method": {
        if (!top && t.typedef) return this.typedefRef(t.typedef, t.aliasArgs);
        const params = t.params.map((p, i) => `${p.rest ? "..." : ""}${p.name || `p${i}`}${p.optional ? "?" : ""}: ${this.tsType(p.type)}`);
        const tps = t.typeParams?.length ? `<${t.typeParams.map((p) => p.name).join(", ")}>` : "";
        return `${tps}(${params.join(", ")}) => ${this.tsType(t.ret)}`;
      }
      case "shape": {
        if (!top && t.typedef) return this.typedefRef(t.typedef, t.aliasArgs);
        const members = [...t.members.values()].map((m) => `${m.readonly ? "readonly " : ""}${m.name}${m.optional ? "?" : ""}: ${this.tsType(m.type())}`);
        return members.length === 0 ? "{}" : `{ ${members.join("; ")} }`;
      }
    }
  }

  /**
   * A typedef by name, imported when it lives in another file. The standard library's typedefs
   * describe JavaScript types and are named after them (`IteratorResult<T>`, `RequestInit`): TypeScript knows them.
   */
  private typedefRef(td: TypedefInfo, args: Type[] | undefined): string {
    if (td.file.file.generated) return "any"; // a `.d.ts` type: TypeScript reads the original
    if (td.file !== this.file && !td.file.file.prelude) {
      const module = moduleOf(td.file);
      this.typeImports.set(module, (this.typeImports.get(module) ?? new Set()).add(td.decl.name.name));
    }
    return td.decl.name.name + (args?.length ? `<${args.map((a) => this.tsType(a)).join(", ")}>` : "");
  }

  /** The local names of this file's JavaScript imports. */
  private importedNames(): Set<string> {
    return new Set(this.file.imports.flatMap((i) => (i.kind === "JsImport" ? [i.defaultName, i.namespace, ...i.named.map((n) => n.alias ?? n.name)].flatMap((n) => (n ? [n.name] : [])) : [])));
  }

  /** `private `/`protected ` (TypeScript output only; `internal` has no TypeScript equivalent). */
  private visibility(d: { modifiers: A.Modifiers }): string {
    if (!this.ts) return "";
    const v = visibilityOf(d);
    return v === "private" || v === "protected" ? `${v} ` : "";
  }

  /** The module's lines, each with the source position it came from. */
  run(): { text: string; origin?: LineOrigin }[] {
    const body = new Writer(this.markers);
    const swap = this.w;
    this.w = body;
    // Typedefs are compile-time only and emit nothing.
    let first = true;
    // Enums and interface symbols depend on nothing: emit them first, so static initializers of
    // the classes below can use them (a later `const` would still be in its temporal dead zone).
    const all = [...this.file.decls.map((d) => [d, true] as const), ...this.file.privateDecls.map((d) => [d, false] as const)];
    const standalone = (d: A.TypeDecl) => d.kind === "Class" && (d.isEnum || d.isInterface);
    for (const [decl, exported] of [...all.filter(([d]) => standalone(d)), ...all.filter(([d]) => !standalone(d))]) {
      if (decl.kind === "Typedef" && this.ts && !this.file.file.prelude) {
        if (!first) this.w.line();
        first = false;
        const t = this.check.typeNodeTypes.get(decl.type);
        this.from(decl, () => this.w.line(`${exported ? "export " : ""}type ${this.name(decl.name)}${this.typeParams(decl.typeParams)} = ${this.tok(decl.type.span, t ? this.tsType(t, true) : "any")};`));
      }
      if (decl.kind !== "Class" || decl.modifiers.native) continue;
      if (!first) this.w.line();
      first = false;
      this.from(decl, () => this.classDecl(decl, exported));
    }
    if (this.ts && this.file.file.prelude) {
      this.w.line();
      this.w.line(TS_ENUMERABLE_GLOBALS);
    }
    if (this.file.file.prelude) {
      this.w.line();
      this.w.line(scopedHelpers(this.ts));
    }
    this.w = swap;

    for (const imp of this.file.imports) {
      if (imp.kind !== "JsImport") continue;
      const line = this.jsImport(imp);
      if (line) this.w.line(line);
    }
    const byModule = new Map<string, string[]>();
    for (const dep of this.imports.values()) byModule.set(dep.module, [...(byModule.get(dep.module) ?? []), dep.decl.name.name]);
    for (const [module, names] of byModule) {
      let rel = posix.relative(posix.dirname(this.module), module);
      if (!rel.startsWith(".")) rel = "./" + rel;
      this.w.line(`import { ${names.sort().join(", ")} } from ${jsString(rel)};`);
    }
    if (this.helpers.size > 0) {
      const prelude = this.check.classes.get("xenon.Exception")!.module;
      let rel = posix.relative(posix.dirname(this.module), prelude);
      if (!rel.startsWith(".")) rel = "./" + rel;
      this.w.line(`import { ${[...this.helpers].sort().join(", ")} } from ${jsString(rel)};`);
    }
    for (const [module, names] of this.typeImports) {
      let rel = posix.relative(posix.dirname(this.module), module);
      if (!rel.startsWith(".")) rel = "./" + rel;
      this.w.line(`import type { ${[...names].sort().join(", ")} } from ${jsString(rel)};`);
    }
    const head = this.w.entries();
    return [...(head.length === 0 ? [] : [...head, { text: "" }]), ...body.entries()];
  }

  /** The import statement for `imp`, or nothing when it only imports TypeScript types (erased from JavaScript). */
  private jsImport(imp: A.JsImport): string | undefined {
    // Interfaces and type aliases have no value at run time: JavaScript can't import them, TypeScript imports them as types.
    const typeOnly = (n: A.Ident) => this.check.typeOnlyImports.has(n);
    const kept = this.ts ? imp : {
      ...imp,
      defaultName: imp.defaultName && !typeOnly(imp.defaultName) ? imp.defaultName : undefined,
      named: imp.named.filter((n) => !typeOnly(n.alias ?? n.name)),
    };
    const erased = kept.defaultName !== imp.defaultName || kept.named.length !== imp.named.length;
    if (erased && !kept.defaultName && !kept.namespace && kept.named.length === 0) return undefined;
    // A package the page loads as a global: read it (the TypeScript output keeps the import, for its types).
    const global = this.globals[imp.module];
    if (global !== undefined && !this.ts) return this.globalImport(kept, global);
    const parts: string[] = [];
    if (kept.defaultName) parts.push(kept.defaultName.name);
    if (kept.namespace) parts.push(`* as ${kept.namespace.name}`);
    if (kept.named.length > 0) {
      const spec = (n: A.JsImport["named"][number]) => (typeOnly(n.alias ?? n.name) ? "type " : "") + (n.alias ? `${n.name.name} as ${n.alias.name}` : n.name.name);
      parts.push(`{ ${kept.named.map(spec).join(", ")} }`);
    }
    return parts.length === 0 ? `import ${jsString(imp.module)};` : `import ${parts.join(", ")} from ${jsString(imp.module)};`;
  }

  /**
   * `import PizZip from 'pizzip'` with `"globals": { "pizzip": "PizZip" }`: `const PizZip = globalThis.PizZip`,
   * failing at once with a clear message when the page didn't load it. A dotted name reads a path
   * (`window.docxtemplater`).
   */
  private globalImport(imp: A.JsImport, global: string): string {
    // `globalThis.PizZip`, `globalThis.window?.docxtemplater` (a missing step gives the message below too).
    const path = global.split(".").map((p, i) => {
      const dot = i === 0 ? "." : "?.";
      return /^[A-Za-z_$][\w$]*$/.test(p) ? `${dot}${p}` : `${i === 0 ? "" : "?."}[${jsString(p)}]`;
    }).join("");
    const message = `\`${global}\` (the package '${imp.module}') is not loaded: add its <script> tag before this one`;
    const value = `globalThis${path} ?? (() => { throw new ReferenceError(${jsString(message)}); })()`;
    const lines: string[] = [];
    if (imp.defaultName) lines.push(`const ${imp.defaultName.name} = ${value};`);
    if (imp.namespace) lines.push(`const ${imp.namespace.name} = ${value};`);
    if (imp.named.length > 0) {
      lines.push(`const { ${imp.named.map((n) => (n.alias ? `${n.name.name}: ${n.alias.name}` : n.name.name)).join(", ")} } = ${value};`);
    }
    return lines.length > 0 ? lines.join("\n") : `// '${imp.module}' is loaded by the page (\`${global}\`)`;
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
      const name = this.name(decl.name);
      this.w.line(`${exported ? "export " : ""}const ${name} = Object.freeze({ ${entries.join(", ")} });`);
      // TypeScript: the enum type is the union of its values.
      if (this.ts) this.w.line(`${exported ? "export " : ""}type ${decl.name.name} = (typeof ${decl.name.name})[keyof typeof ${decl.name.name}];`);
      return;
    }
    if (decl.isInterface) {
      if (this.ts) this.interfaceType(decl, exported);
      // Interfaces exist at runtime only as a marker symbol for `x is IShape`.
      this.w.line(`${exported ? "export " : ""}const ${this.ts ? decl.name.name : this.name(decl.name)} = Symbol(${jsString(info.qname)});`);
      return;
    }
    const ext = decl.extends ? ` extends ${this.superType(decl.extends)}` : "";
    const impl = this.ts && decl.implements.length > 0 ? ` implements ${decl.implements.map((n) => this.superType(n)).join(", ")}` : "";
    this.w.line(`${exported ? "export " : ""}class ${this.name(decl.name)}${this.typeParams(decl.typeParams)}${ext}${impl} {`);
    this.w.indent();
    let prev: A.Member | undefined;
    const guard = decl.modifiers.abstract ? this.abstractGuard(decl) : undefined;
    if (guard && !decl.members.some((m) => m.kind === "Method" && m.isConstructor)) {
      // An abstract class without a constructor still needs the guard; arguments go to the parent.
      this.w.line(decl.extends ? `constructor(...args${this.ts ? `: ${this.parentCtorParams(info)}` : ""}) {` : "constructor() {");
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
      this.from(m, () => this.member(info, decl, m, guard));
    }
    this.enumerableIterator(info);
    this.disposeBridge(info, !!prev);
    this.w.dedent();
    this.w.line("}");
    for (const l of this.afterClass) this.w.line(l);
    this.afterClass = [];
    this.attributeTable(info, decl);
    // Mark the prototype for every interface this class implements (super-interfaces included);
    // subclasses inherit the marks through the prototype chain.
    const marks = [...supertypes(info)].filter((t) => t.decl.isInterface && !this.inheritedMark(info, t));
    for (const iface of marks) {
      const proto = this.ts ? `(${decl.name.name}.prototype as any)` : `${decl.name.name}.prototype`;
      this.w.line(`${proto}[${this.classRef(iface)}] = true;`);
    }
  }

  /** TypeScript: the parameters of the parent's constructor as a tuple type, `[name: string, age?: number]`. */
  private parentCtorParams(info: ClassInfo): string {
    let owner = info.parent;
    let map = bind(info.parent?.typeParams ?? [], info.parentArgs);
    while (owner && !owner.ctor) {
      map = new Map([...map, ...bind(owner.parent?.typeParams ?? [], owner.parentArgs.map((a) => subst(a, map)))]);
      owner = owner.parent;
    }
    if (!owner?.ctor) return info.jsParent ? "any[]" : "[]";
    const params = owner.ctor.type.params.map((p) => `${p.rest ? "..." : ""}${p.name}${p.optional ? "?" : ""}: ${this.tsType(subst(p.type, map))}`);
    return `[${params.join(", ")}]`;
  }

  /** A parent class or interface: with type arguments in TypeScript (`extends Box<number>`). */
  private superType(node: A.TypeNode): string {
    const t = this.ts ? this.check.typeNodeTypes.get(node) : undefined;
    return t?.kind === "class" ? this.tok(node.span, this.tsType(t)) : this.tok(node.span, this.typeName(node));
  }

  /** TypeScript: an interface's members as an `interface` (next to the runtime marker of the same name). */
  private interfaceType(decl: A.ClassDecl, exported: boolean) {
    const ext = decl.implements.length > 0 ? ` extends ${decl.implements.map((n) => this.superType(n)).join(", ")}` : "";
    this.w.line(`${exported ? "export " : ""}interface ${this.name(decl.name)}${this.typeParams(decl.typeParams)}${ext} {`);
    this.w.indent();
    // `for … of` works on every enumerable: classes get a `[Symbol.iterator]` (see `enumerableIterator`).
    if (decl.name.name === "Iterable" && this.file.file.prelude) this.w.line("[Symbol.iterator](): Iterator<T>;");
    for (const m of decl.members) {
      if (m.kind !== "Method") continue;
      this.from(m, () => {
        const name = this.tok(m.name.span, methodName(m.name.name));
        if (m.accessor === "set") this.w.line(`set ${name}(${this.params(m.params)});`);
        else if (m.accessor === "get") this.w.line(`get ${name}()${this.ann(m.returnType)};`);
        // `IAttribute.wrap` is optional (see the prelude); TypeScript rejects classes implementing an
        // interface of only optional members that have none of them, so it isn't declared there.
        else if (!(this.file.file.prelude && decl.name.name === "IAttribute" && m.name.name === "wrap")) {
          this.w.line(`${name}${this.typeParams(m.typeParams)}(${this.params(m.params, true)})${this.ann(m.returnType) || ": void"};`);
        }
      });
    }
    this.w.dedent();
    this.w.line("}");
  }

  /** One member of a class body. */
  private member(info: ClassInfo, decl: A.ClassDecl, m: A.Member, guard: string | undefined) {
    if (m.kind === "Field") this.field(m, info);
    else if (m.kind === "Method" && m.isDestructor) {
      this.scopedDestructor(info, m);
    } else if (m.kind === "Method" && !m.body) {
      this.abstractStub(decl, m);
    } else if (m.kind === "Method") {
      this.method(m, !!decl.extends, m.isConstructor ? guard : undefined, info);
      this.accessorDelegate(decl, m);
    } else if (m.kind === "StaticBlock") {
      this.w.line("static {");
      this.functionBody(m.body);
      this.w.line("}");
    }
  }

  /**
   * The first class (from the top) implementing `Iterable<T>` becomes a JavaScript iterable: `for … of`
   * (also in plain JavaScript) walks its `getEnumerator()`. Subclasses inherit it; built-ins have their own.
   */
  private enumerableIterator(info: ClassInfo) {
    const e = this.check.classes.get("xenon.Iterable");
    if (!e || info.decl.isInterface || !isSubclass(info, e) || (info.parent && isSubclass(info.parent, e))) return;
    this.w.line();
    this.w.line("*[Symbol.iterator]() {");
    this.w.indent();
    this.w.line("const items = this.getEnumerator();");
    this.w.line("while (items.moveNext()) yield items.current;");
    this.w.dedent();
    this.w.line("}");
  }

  /** Is the interface already marked on a superclass's prototype? */
  private inheritedMark(info: ClassInfo, iface: ClassInfo): boolean {
    return !!info.parent && [...supertypes(info.parent)].includes(iface);
  }

  private field(f: A.Field, info: ClassInfo) {
    const folded = this.check.inlineFields.get(f);
    const init = folded !== undefined ? constToJs(folded, jsString).code : f.init ? this.expr(f.init).code : defaultValue(f.type);
    const type = f.type ? this.ann(f.type) : this.annType(info.members.get(f.name.name)?.type);
    const st = f.modifiers.static ? "static " : "";
    const storage = fieldStorage(info.members.get(f.name.name));
    if (storage === "plain") {
      this.w.line(`${this.visibility(f)}${st}${this.name(f.name)}${type} = ${init};`);
      return;
    }
    // `#name`; a `final`/`const` field that isn't private is read through a getter. A static getter
    // names its class: `this.#x` would throw when called through a subclass (`Sub.X`).
    this.w.line(`${st}#${f.name.name}${type} = ${init};`);
    if (storage === "readonly") {
      const owner = f.modifiers.static ? this.classRef(info) : "this";
      this.w.line(`${this.visibility(f)}${st}get ${this.name(f.name)}()${type} { return ${owner}.#${f.name.name}; }`);
    }
  }

  /** Parameter list; `signature`: without default values (interfaces), optional ones marked `?`. */
  private params(params: A.Param[], signature = false): string {
    return params
      .map((p) => {
        const name = (p.rest ? "..." : "") + this.name(p.name);
        if (signature) return name + (p.init ? "?" : "") + this.ann(p.type);
        return name + this.ann(p.type) + (p.init ? ` = ${this.expr(p.init).code}` : "");
      })
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
    if (sig.delegate === "set") this.w.line(`set ${name}(value${this.annType(sig.type)}) { super.${name} = value; }`);
    else this.w.line(`get ${name}()${this.annType(sig.type)} { return super.${name}; }`);
  }

  /**
   * `~Name()` → `[Symbol.dispose]()` (async: `[Symbol.asyncDispose]()`), run at most once; the
   * parent's destructor runs afterwards, also after an early `return` or an exception. The
   * topmost class with a destructor also gets `dispose()`.
   */
  /** Code creating one attribute: `new Route("/")`, with its named values `Object.assign`ed. */
  private attributeValue({ node, create }: { node: A.Attribute; create: A.Expr }): string {
    const made = this.expr(create).code;
    if (node.named.length === 0) return made;
    return `Object.assign(${made}, { ${node.named.map((n) => `${n.name.name}: ${this.wrap(this.expr(n.value), P.assign)}`).join(", ")} })`;
  }

  /**
   * Attributes (src/attributes.ts): a function creating them, kept on the class under
   * `Attributes.KEY` and called by the first lookup. Nothing runs when the module loads, so the
   * attribute classes may come from modules loaded later (cycles included).
   */
  private attributeTable(info: ClassInfo, decl: A.ClassDecl) {
    const create = (list: { node: A.Attribute; create: A.Expr }[]) => `[${list.map((a) => this.attributeValue(a)).join(", ")}]`;
    const own = this.check.attributes.get(decl);
    const members = decl.members.flatMap((m) => {
      const list = m.kind === "StaticBlock" ? undefined : this.check.attributes.get(m);
      const key = m.kind === "StaticBlock" ? "" : /^[A-Za-z_$][\w$]*$/.test(m.name.name) ? m.name.name : jsString(m.name.name);
      return m.kind !== "StaticBlock" && list ? [`${key}: ${create(list)}`] : [];
    });
    if (!own && members.length === 0) return;
    const key = `${this.classRef(this.check.classes.get("xenon.Attributes")!)}.KEY`;
    const target = this.ts ? `(${decl.name.name} as any)` : decl.name.name;
    this.w.line(`${target}[${key}] = () => ({`);
    this.w.indent();
    this.w.line(`type: ${own ? create(own) : "[]"},`);
    if (members.length === 0) this.w.line("members: {},");
    else {
      this.w.line("members: {");
      this.w.indent();
      for (const m of members) this.w.line(`${m},`);
      this.w.dedent();
      this.w.line("},");
    }
    this.w.dedent();
    this.w.line("});");
  }

  /**
   * `IDisposable`: JavaScript's `using` (which `using` compiles to) calls `[Symbol.dispose]()`, so the
   * topmost class implementing it forwards that to `dispose()` (overrides included).
   */
  private disposeBridge(info: ClassInfo, after: boolean) {
    if (isNative(info) || info.decl.isInterface || !isManualDisposable(info)) return;
    if (info.parent && isManualDisposable(info.parent)) return; // inherited
    const async = [...supertypes(info)].some((t) => t.qname === "xenon.IAsyncDisposable");
    if (after) this.w.line();
    this.w.line(async
      ? `[Symbol.asyncDispose]()${this.ts ? ": Promise<void>" : ""} { return this.dispose(); }`
      : `[Symbol.dispose]()${this.ts ? ": void" : ""} { this.dispose(); }`);
  }

  /**
   * A scoped class's destructor: `[$Destroy]()`, called exactly once by the scope owning the object
   * (so no guard), then the parent's, also after an early `return` or an exception.
   */
  private scopedDestructor(info: ClassInfo, m: A.Method) {
    const async = !!m.modifiers.async;
    const key = this.helper("$Destroy");
    const parent = info.parent ? chainDestructor(info.parent) : undefined;
    this.w.line(`${async ? "async " : ""}[${key}]()${this.ts ? (async ? ": Promise<void>" : ": void") : ""} {`);
    if (parent) {
      this.w.indent();
      this.w.line("try {");
      this.functionBody(m.body!);
      this.w.line("} finally {");
      this.w.line(`  ${async ? "await " : ""}super[${key}]();`);
      this.w.line("}");
      this.w.dedent();
    } else {
      this.functionBody(m.body!);
    }
    this.w.line("}");
  }

  /**
   * Statements of a block. After a local owning a scoped value, the rest of the block runs in a
   * `try` whose `finally` destroys it: on every exit, in reverse order of declaration.
   */
  private stmtList(list: A.Stmt[]) {
    for (let i = 0; i < list.length; i++) {
      const s = list[i]!;
      this.stmt(s);
      const owner = s.kind === "VarDecl" ? this.check.scopedLocals.get(s.name) : undefined;
      if (!owner || s.kind !== "VarDecl") continue;
      const name = s.name.name;
      this.from(s, () => this.destroyAfter(name, owner.async, () => this.stmtList(list.slice(i + 1))));
      return;
    }
  }

  /** Runs `body` in a `try` that destroys `value` at its end, keeping an error leaving it. */
  private destroyAfter(value: string, async: boolean, body: () => void) {
    const err = this.temp("$e");
    this.w.line(`let ${err}${this.ts ? ": unknown" : ""} = ${this.helper("$noError")};`);
    this.w.line("try {");
    this.w.indent();
    body();
    this.w.dedent();
    const destroy = `${async ? "await " : ""}${this.helper(async ? "$destroyAsync" : "$destroy")}(${value}, ${err});`;
    this.w.line(`} catch ($c) { throw (${err} = $c); } finally { ${destroy} }`);
  }

  /**
   * Generates one statement's line(s) with `gen`; when its expression created temporaries owning
   * scoped values, they are declared first and destroyed when the statement ends (the last created
   * first). `hoist`: a declaration to make before them (`let n;` when `gen` assigns a `var`).
   */
  private withTemps(gen: () => string[], hoist?: () => string) {
    const saved = this.stmtTemps;
    const temps: { name: string; async: boolean }[] = [];
    this.stmtTemps = temps;
    let lines: string[];
    try {
      lines = gen();
    } finally {
      this.stmtTemps = saved;
    }
    if (temps.length === 0) {
      for (const l of lines) this.w.line(l);
      return false;
    }
    this.w.line(`let ${temps.map((t) => `${t.name}${this.ts ? ": any" : ""} = null`).join(", ")};`);
    if (hoist) this.w.line(hoist());
    const nest = (i: number): void => {
      if (i === temps.length) {
        for (const l of lines) this.w.line(l);
        return;
      }
      this.destroyAfter(temps[i]!.name, temps[i]!.async, () => nest(i + 1));
    };
    nest(0);
    return true;
  }

  /** `if (new.target === Shape) throw new StateException('Shape is abstract');` */
  private abstractGuard(decl: A.ClassDecl): string {
    const exc = this.classRef(this.check.classes.get("xenon.StateException")!);
    const name = decl.name.name;
    return `if (new.target === ${name}) throw new ${exc}(${jsString(`${name} is abstract`)});`;
  }

  /** Abstract members still exist at runtime, for plain-JS subclasses that forget them. */
  private abstractStub(decl: A.ClassDecl, m: A.Method) {
    const exc = this.classRef(this.check.classes.get("xenon.NotImplementedException")!);
    const throwLine = `throw new ${exc}(${jsString(`${decl.name.name}.${m.name.name}`)});`;
    const name = this.tok(m.name.span, methodName(m.name.name));
    const head = m.accessor === "set"
      ? `${this.visibility(m)}set ${name}(${this.params(m.params)})`
      : m.accessor === "get"
      ? `${this.visibility(m)}get ${name}()${this.ann(m.returnType)}`
      : `${this.visibility(m)}${m.modifiers.async ? "async " : ""}${name}${this.typeParams(m.typeParams)}(${this.params(m.params)})${this.ann(m.returnType)}`;
    this.w.line(`${head} {`);
    this.w.line(`  ${throwLine}`);
    this.w.line("}");
  }

  /**
   * The attributes on `m` that wrap it (their class defines `IAttribute.wrap`), as code creating
   * each, outermost first (the attribute nearest the method wraps it first).
   */
  private wrappers(m: A.Method): string[] {
    if (!m.body || m.isConstructor || m.isDestructor || m.accessor) return [];
    return (this.check.attributes.get(m) ?? []).filter(({ node }) => {
      const info = this.check.typeResolutions.get(node.name);
      const wrap = info && findMember(info, "wrap");
      return !!wrap && !wrap.owner.decl.isInterface;
    }).map((a) => this.attributeValue(a));
  }

  /**
   * `fn` passed through each wrapping attribute on its first call:
   * `$wrapLazily(fn, (m) => new A().wrap(new B().wrap(m, "m"), "m"))`.
   */
  private wrapChain(wrappers: string[], fn: string, name: string): string {
    const m = this.ts ? "(m: any)" : "(m)";
    return `${this.helper("$wrapLazily")}(${fn}, ${m} => ${wrappers.reduceRight((inner, w) => `${w}.wrap(${inner}, ${jsString(name)})`, "m")})`;
  }

  /** Lines run right after the class's declaration (wrapping public methods). */
  private afterClass: string[] = [];

  private method(m: A.Method, hasParent = false, guard?: string, info?: ClassInfo) {
    const wrappers = this.wrappers(m);
    if (wrappers.length > 0 && info) {
      const hidden = privateMethod(info.members.get(m.name.name));
      const cls = info.decl.name.name;
      if (!hidden) {
        // Replaced once the class exists: `C.prototype.m = new Logged().wrap(C.prototype.m, "m")`.
        const holder = m.modifiers.static ? cls : `${cls}.prototype`;
        const target = this.ts ? `(${holder} as any)` : holder;
        const name = methodName(m.name.name);
        this.afterClass.push(`${target}.${name} = ${this.wrapChain(wrappers, `${target}.${name}`, m.name.name)};`);
      } else {
        // A `#private` method can't be replaced: the body becomes `#m$raw`, and `#m` calls the
        // wrapped function, created once when the class is defined.
        const st = m.modifiers.static ? "static " : "";
        const any = this.ts ? ": any" : "";
        const raw = `#${m.name.name}$raw`;
        const wrapped = `#${m.name.name}$wrapped`;
        const params = this.ts ? "this: any, ...args: any[]" : "...args";
        this.w.line(`static ${wrapped}${any} = ${this.wrapChain(wrappers, `function (${params}) { return this.${raw}(...args); }`, m.name.name)};`);
        this.w.line();
        this.w.line(`${st}#${this.tok(m.name.span, m.name.name)}(...args${this.ts ? ": any[]" : ""})${any} { return ${cls}.${wrapped}.apply(this, args); }`);
        this.w.line();
        const ret = this.ann(m.returnType);
        this.w.line(`${st}${m.modifiers.async ? "async " : ""}${raw}${this.typeParams(m.typeParams)}(${this.params(m.params)})${ret} {`);
        this.functionBody(m.body!);
        this.w.line("}");
        return;
      }
    }
    // A private setter of a readable property: `set #name(v)`, plus `get #name()` reading through the
    // public getter, so `this.#name += 1` works inside the class.
    const sig = m.accessor === "set" && info ? info.members.get(m.name.name) : undefined;
    if (sig && privateSetter(sig) && accessorHalf(sig, "set") === m) {
      const st = m.modifiers.static ? "static " : "";
      const self = m.modifiers.static ? this.classRef(info!) : "this";
      const type = this.annType(sig.type);
      this.w.line(`${st}get #${m.name.name}()${type} { return ${self}.${m.name.name}; }`);
      this.w.line(`${st}set #${this.tok(m.name.span, m.name.name)}(${this.params(m.params)}) {`);
      this.functionBody(m.body!);
      this.w.line("}");
      return;
    }
    // A private method is a JavaScript `#name` (TypeScript allows no `private` keyword on one).
    const hidden = !!info && privateMethod(info.members.get(m.name.name));
    const prefix = [
      hidden ? "" : this.visibility(m),
      m.modifiers.static ? "static " : "",
      m.modifiers.async ? "async " : "",
      m.accessor ? `${m.accessor} ` : "",
    ].join("");
    const name = (hidden ? "#" : "") + this.tok(m.name.span, m.isConstructor ? "constructor" : methodName(m.name.name));
    const ret = m.isConstructor || m.accessor === "set" ? "" : this.ann(m.returnType);
    this.w.line(`${prefix}${name}${this.typeParams(m.typeParams)}(${this.params(m.params)})${ret} {`);
    // Derived constructors must call super() before using `this`; Xenon inserts it when omitted.
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
    this.stmtList(rest);
    this.w.dedent();
    const decls: string[] = [];
    if (this.fnTemps.length > 0) decls.push(this.tempDecl());
    if (this.selfNeeded) decls.push("const $self = this;");
    for (const d of decls.reverse()) this.w.insertAt(at, d);
    this.fnTemps = null;
  }

  /** `let $t, $t2;` (typed `any` in TypeScript: temporaries hold values of any type). */
  private tempDecl(): string {
    return `let ${this.fnTemps!.map((t) => (this.ts ? `${t}: any` : t)).join(", ")};`;
  }

  /** How instance members are reached here: `this`, or `$self` inside `function` expressions. */
  /** Member expressions being assigned (`this.x = …`, `x++`, `[this.a, this.b] = …`). */
  private writeTargets = new Set<A.Expr>();
  /** Write targets that are read too: `a[i] += 1`, `a[i]++` (their index is checked like a read's). */
  private readWrites = new Set<A.Expr>();

  /**
   * The property name for an access to member `m` (see `fieldStorage`): `#x` for a private field or
   * method (`privateMethod`), and for writing a `final`/`const` one (only its class can); the plain
   * name otherwise.
   */
  private fieldName(m: MemberSig | undefined, access: A.Expr, id: A.Ident, plain = this.name(id)): string {
    const storage = fieldStorage(m);
    // The `#` stays outside the mapped token: `items` in the source maps to `items` in `#items`.
    const write = this.writeTargets.has(access);
    if (storage === "private" || privateMethod(m) || (write && (storage === "readonly" || privateSetter(m)))) return `#${this.tok(id.span, id.name)}`;
    return plain;
  }

  private receiver(): string {
    if (this.dynDepth === 0) return "this";
    this.selfNeeded = true;
    return "$self";
  }

  /** Code for a function expression, arrow function or local function declaration. */
  private fn(f: A.FunctionNode): Code {
    const saved = { w: this.w, temps: this.temps, fnTemps: this.fnTemps };
    this.w = new Writer(this.markers);
    this.temps = new Map();
    this.fnTemps = [];
    if (!f.arrow) this.dynDepth++;
    try {
      const params = `${this.typeParams(f.typeParams)}(${this.params(f.params)})${this.ann(f.returnType)}`;
      const head = (f.async ? "async " : "") + (f.arrow ? `${params} =>` : `function${f.name ? " " + this.name(f.name) : ""}${params}`);
      if (f.body.kind !== "Block") {
        const body = this.expr(f.body);
        if (this.fnTemps.length === 0) {
          const code = plain(body.code).startsWith("{") ? `(${body.code})` : this.wrap(body, P.assign);
          return { code: `${head} ${code}`, prec: P.assign };
        }
        // Temporaries need statements: turn the expression body into a block.
        return { code: `${head} {\n  ${this.tempDecl()}\n  return ${body.code};\n}`, prec: P.assign };
      }
      const at = this.w.mark();
      this.blockBody(f.body);
      if (this.fnTemps.length > 0) this.w.insertAt(at, this.tempDecl());
      const inner = this.w.marked().replace(/\n$/, "");
      const code = inner === "" ? `${head} {}` : `${head} {\n${inner}\n}`;
      return { code, prec: f.arrow ? P.assign : P.primary };
    } finally {
      Object.assign(this, saved);
      if (!f.arrow) this.dynDepth--;
    }
  }

  private blockBody(b: A.Block) {
    this.w.indent();
    this.stmtList(b.body);
    this.w.dedent();
  }

  /** Emits the statements of a nested body (a block's contents or a single statement), indented. */
  private body(b: A.Stmt) {
    if (b.kind === "Block") return this.blockBody(b);
    this.w.indent();
    this.stmtList([b]);
    this.w.dedent();
  }

  private nested(head: string, body: A.Stmt, tail = "") {
    this.w.line(`${head} {`);
    this.body(body);
    this.w.line(`}${tail}`);
  }

  /** Generates code whose lines map back to `node` (unless something inside maps them more precisely). */
  private from<T>(node: { span: Span }, gen: () => T): T {
    const w = this.w;
    const saved = w.origin;
    w.origin = originOf(node.span);
    try {
      return gen();
    } finally {
      w.origin = saved;
    }
  }

  private stmt(s: A.Stmt) {
    this.from(s, () => this.statement(s));
  }

  private statement(s: A.Stmt) {
    switch (s.kind) {
      case "Block":
        this.w.line("{");
        this.blockBody(s);
        this.w.line("}");
        return;
      case "VarDecl": {
        if (s.inline) return; // inline constants are pasted at every use
        // A local whose value some `return` hands on is cleared there (see `Return`), so it can't be `const`.
        const kw = s.decl === "var" || this.check.scopedLocals.get(s.name)?.handedOff ? "let" : s.decl === "const" ? "const" : s.init ? "const" : "let";
        let init: string | undefined;
        // With temporaries the declaration comes first (`let n;`) and the statement assigns it.
        this.withTemps(() => {
          init = s.init ? this.expr(s.init).code : s.decl === "var" ? defaultValue(s.type) : undefined;
          return this.stmtTemps!.length > 0
            ? [`${s.name.name} = ${init};`]
            : [`${kw} ${this.name(s.name)}${this.ann(s.type)}${init === undefined ? "" : ` = ${init}`};`];
        }, () => `let ${this.name(s.name)}${this.ann(s.type)};`);
        return;
      }
      case "ExprStmt": {
        const code = this.expr(s.expr).code;
        // An expression statement must not start with `{` or `function` in JS.
        this.w.line(/^(\{|function\b)/.test(plain(code)) ? `(${code});` : `${code};`);
        return;
      }
      case "Return":
        if (s.value && this.check.scopedReturns.has(s)) {
          // `return r`: handed to the caller, so the `finally` of `r`'s scope must not destroy it.
          const r = (s.value as A.Expr & { kind: "Ident" }).name;
          const t = this.temp("$r", true);
          this.w.line(`return (${t} = ${this.expr(s.value).code}, ${r} = null, ${t});`);
          return;
        }
        this.withTemps(() => [s.value ? `return ${this.expr(s.value).code};` : "return;"]);
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
        this.w.line(`let ${this.bindings(s.header)};`);
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
        this.nested(`for (let ${this.bindings(s.header)}; ${this.headerCond(s.header)}; )`, s.body);
        return;
      case "For": {
        let init = "";
        if (s.init?.kind === "VarDecl") {
          const d = s.init;
          const value = d.init ? this.expr(d.init).code : defaultValue(d.type);
          init = `${d.decl === "var" ? "let" : "const"} ${this.name(d.name)}${this.ann(d.type)} = ${value}`;
        } else if (s.init) init = this.expr(s.init.expr).code;
        const cond = s.cond ? ` ${this.expr(s.cond).code}` : "";
        const update = s.update ? ` ${this.expr(s.update).code}` : "";
        this.nested(`for (${init};${cond};${update})`, s.body);
        return;
      }
      case "ForIn":
      case "ForOf": {
        const kw = s.variable.decl === "var" ? "let" : "const";
        let source = s.kind === "ForIn" ? `in ${this.expr(s.object).code}` : `of ${this.expr(s.iterable).code}`;
        // TypeScript's typings declare no iterator on some iterable web classes (the global `FormData`).
        const iterated = s.kind === "ForOf" && this.ts ? this.check.exprTypes.get(s.iterable) : undefined;
        if (s.kind === "ForOf" && iterated?.kind === "class" && TS_NOT_ITERABLE.has(iterated.info.qname)) source = `of (${this.expr(s.iterable).code} as unknown as Iterable<any>)`;
        const target = s.variable.pattern ? this.pattern(s.variable.pattern) : this.name(s.variable.name);
        this.nested(`for (${kw} ${target} ${source})`, s.body);
        return;
      }
      case "ForRange": {
        const v = s.variable.name.name;
        const start = this.wrap(this.expr(s.start), P.assign);
        const step = s.step ? Number(plain(this.expr(s.step).code)) : 1;
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
          // Each case has its own scope in Xenon; JS needs braces when a case declares variables.
          const braces = c.body.some((x) => x.kind === "VarDecl" || x.kind === "UsingDecl" || x.kind === "DestructDecl" || x.kind === "FuncDecl");
          this.w.line(braces ? `${label} {` : label);
          this.w.indent();
          this.stmtList(c.body);
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
        this.w.line(`${s.decl === "var" ? "let" : "const"} ${this.pattern(s.pattern)}${this.ann(s.type)} = ${this.wrap(this.expr(s.init), P.assign)};`);
        return;
      case "UsingDecl":
        this.w.line(`${s.isAwait ? "await " : ""}using ${this.name(s.name)}${this.ann(s.type)} = ${this.wrap(this.expr(s.init), P.assign)};`);
        return;
      case "UsingBlock": {
        // A plain block whose `using` declarations end with it.
        const decls = s.resources.map((r) => {
          const name = r.kind === "Decl" ? this.name(r.name) + this.ann(r.type) : this.temp("$r");
          return `${name} = ${this.wrap(this.expr(r.kind === "Decl" ? r.init : r.expr), P.assign)}`;
        });
        this.w.line("{");
        this.w.indent();
        this.w.line(`${s.isAwait ? "await " : ""}using ${decls.join(", ")};`);
        this.stmtList(s.body.kind === "Block" ? s.body.body : [s.body]);
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
    return this.classRef(this.check.classes.get("xenon.Exception")!);
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
        return !info || info.qname === "xenon.Exception";
      };
      const only = s.catches[0]!;
      if (s.catches.length === 1 && isCatchAll(only)) {
        this.w.line(`let ${this.name(only.name)} = ${exc}.from(${raw});`);
        this.stmtList(only.body.body);
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
          this.w.line(`let ${this.name(c.name)} = ${value};`);
          this.stmtList(c.body.body);
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
        return this.name(p.name) + init;
      case "Target":
        this.writeTargets.add(p.expr);
        return this.expr(p.expr).code + init;
      case "ObjectPattern": {
        const props = p.props.map((prop) => {
          const v = prop.value;
          // `{name}` / `{name = 1}` stay shorthand; everything else is `key: pattern`.
          if (v.kind === "BindingName" && v.name.name === prop.key.name) return this.pattern(v);
          return `${this.name(prop.key)}: ${this.pattern(v)}`;
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

  /** The variables of an `if`/`while` binding header: `a, b` (typed in TypeScript). */
  private bindings(items: A.HeaderItem[]): string {
    if (!this.ts) return bindingNames(items);
    return items.flatMap((i) => {
      if (i.kind !== "Binding") return [];
      const t = this.check.exprTypes.get(i.init);
      return [i.name.name + (i.type ? this.ann(i.type) : this.annType(t && nonNull(t)))];
    }).join(", ");
  }

  /** `(a = x) != null && (b = y) != null && cond` for an `if`/`while` binding header. */
  private headerCond(items: A.HeaderItem[]): string {
    return items
      .map((item) =>
        item.kind === "Binding"
          ? `(${this.name(item.name)} = ${this.wrap(this.expr(item.init), P.assign)}) != null`
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
    // A field of `this` (not a getter) reads the same twice without side effects: `this.#items`.
    const ownField = (e.kind === "Member" && e.object.kind === "This" && (() => {
      const t = this.check.exprTypes.get(e.object);
      return t?.kind === "class" && findMember(t.info, e.name.name)?.kind === "field";
    })()) || (e.kind === "Ident" && r?.kind === "member" && findMember(r.owner, e.name)?.kind === "field");
    const simple = ownField || e.kind === "This" || e.kind === "Bool" || e.kind === "String" || e.kind === "Number" || (e.kind === "Ident" && (r?.kind === "local" || r?.kind === "jsImport" || r?.kind === "global" || r?.kind === "function"));
    if (simple) return build(this.wrap(v, P.call), this.wrap(v, P.call));
    if (this.fnTemps) {
      const t = this.temp("$t", true);
      return build(`(${t} = ${this.wrap(v, P.assign)})`, t);
    }
    // Outside a function (field initializers): an arrow function call provides the temporary.
    const inner = build("$t", "$t");
    return { code: `(($t${this.ts ? ": any" : ""}) => ${inner.code})(${this.wrap(v, P.assign)})`, prec: P.call };
  }

  /**
   * An instance method used as a value, bound to its object like an AS3 method closure.
   * The bound function is cached on the instance under a registered symbol, so `this.handle`
   * is the same function every time (`removeEventListener` works) and it stays invisible to
   * `JSON.stringify`/`Object.keys`.
   */
  private methodClosure(e: A.Expr): Code {
    const key = (k: string) => `Symbol.for(${jsString(k)})`;
    // TypeScript doesn't know the cache property.
    const cache = (o: string) => (this.ts ? `(${o} as any)` : o);
    if (e.kind === "Ident") {
      const self = this.receiver();
      const r = this.check.resolutions.get(e);
      const prop = this.fieldName(r?.kind === "member" ? findMember(r.owner, e.name) : undefined, e, e, this.tok(e.span, e.name));
      return { code: `${cache(self)}[${key(`xenon.bound.${e.name}`)}] ??= ${self}.${prop}.bind(${self})`, prec: P.assign };
    }
    if (e.kind !== "Member") throw new Error("codegen: unexpected method closure");
    const name = e.name.name;
    if (e.object.kind === "Super") {
      // The parent's version, cached separately from an override with the same name.
      const parent = (this.check.exprTypes.get(e.object) as { info?: ClassInfo }).info?.decl.name.name ?? "super";
      return { code: `${cache("this")}[${key(`xenon.bound.${parent}.${name}`)}] ??= super.${this.name(e.name)}.bind(this)`, prec: P.assign };
    }
    // A primitive can't hold the cache property (strict mode throws), and has no identity anyway.
    if (this.check.exprTypes.get(e.object)?.kind === "prim") {
      return this.reuse(e.object, (first, again) => ({ code: `${first}.${this.name(e.name)}.bind(${again})`, prec: P.call }));
    }
    const objType = this.check.exprTypes.get(e.object);
    const t = objType && nonNull(objType);
    const prop = this.fieldName(t?.kind === "class" || t?.kind === "classRef" ? findMember(t.info, name) : undefined, e, e.name);
    return this.reuse(e.object, (first, again) => ({
      code: `${cache(first)}[${key(`xenon.bound.${name}`)}] ??= ${again}.${prop}.bind(${again})`,
      prec: P.assign,
    }));
  }

  /** Plain-JS runtime test for `is`/`as`. */
  private runtimeTest(check: RuntimeCheck, first: string, again: string): Code {
    // TypeScript: the marker and `Symbol.iterator` aren't part of the static type.
    const dyn = (v: string) => (this.ts ? `(${v} as any)` : v);
    switch (check.kind) {
      case "class": return { code: `${first} instanceof ${this.classRef(check.info)}`, prec: P.rel };
      case "interface": return { code: `${dyn(first)}?.[${this.classRef(check.info)}] === true`, prec: P.eq };
      case "iterable": return { code: `typeof ${dyn(first)}?.[Symbol.iterator] === 'function'`, prec: P.eq };
      case "enum": return { code: `Object.values(${this.classRef(check.info)}).includes(${dyn(first)})`, prec: P.call };
      case "js": return { code: `${first} instanceof ${check.name}`, prec: P.rel };
      case "typeof": return { code: `typeof ${first} === ${jsString(check.tag)}`, prec: P.eq };
      case "int": return { code: `Number.isInteger(${first})`, prec: P.call };
      case "uint": return { code: `Number.isInteger(${first}) && ${dyn(again)} >= 0`, prec: P.and };
      case "array": return { code: `Array.isArray(${first})`, prec: P.call };
      case "object": return { code: `${first} != null`, prec: P.eq };
    }
  }

  private typeOp(e: A.Expr & { kind: "TypeOp" }): Code {
    const code = this.typeTest(e);
    if (e.op === "is" || !this.ts) return code;
    // TypeScript: the result has the target type. A cast TypeScript can't see as a downcast
    // (between interfaces, from a class to an interface it doesn't declare) goes through `unknown`.
    const from = this.check.exprTypes.get(e.expr);
    const to = this.check.exprTypes.get(e) ?? { kind: "any" };
    const down = from?.kind === "any" || (from?.kind === "class" && to.kind === "class" && isSubclass(to.info, from.info));
    // `x as kind` (a `Class<T>` local): the written name is a value, not the type TypeScript gets.
    // The written type maps to its own text; the `| null` that `as` adds (null safety) stays outside it.
    const inner = to.kind === "nullable" && e.type.kind !== "NullableType" ? to.inner : to;
    const orNull = inner !== to ? " | null" : "";
    const written = this.check.typeChecks.get(e)?.kind === "js" ? this.tsType(to) : this.tok(e.type.span, this.tsType(inner)) + orNull;
    return { code: `(${this.wrap(code, P.rel)} as ${down ? "" : "unknown as "}${written})`, prec: P.primary };
  }

  private typeTest(e: A.Expr & { kind: "TypeOp" }): Code {
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
    // A temporary owning a scoped value: kept where it is created, so evaluation order is unchanged.
    const temp = this.stmtTemps && this.check.scopedTemps.get(e);
    if (temp) {
      const name = this.temp("$t");
      this.stmtTemps!.push({ name, async: temp.async });
      return { code: `(${name} = ${this.wrap(this.exprInner(e), P.assign)})`, prec: P.primary };
    }
    return this.exprInner(e);
  }

  private exprInner(e: A.Expr): Code {
    const folded = this.check.inlineValues.get(e);
    if (folded !== undefined) {
      const js = constToJs(folded, jsString);
      return { code: js.code, prec: js.negative ? P.unary : P.primary };
    }
    if (this.check.methodClosures.has(e)) return this.methodClosure(e);
    switch (e.kind) {
      case "Ident": {
        const r = this.check.resolutions.get(e);
        const name = this.tok(e.span, e.name);
        if (r?.kind === "member") {
          const prop = this.fieldName(findMember(r.owner, e.name), e, e, name);
          return { code: r.isStatic ? `${this.classRef(r.owner)}.${prop}` : `${this.receiver()}.${prop}`, prec: P.call };
        }
        if (r?.kind === "class") return { code: this.tok(e.span, this.classRef(r.info)), prec: P.primary };
        if (r?.kind === "function") return { code: this.tok(e.span, r.decl.modifiers.nativeName ?? e.name), prec: P.primary };
        if (r?.kind === "builtin" && r.name === "trace") return { code: this.tok(e.span, "console.log"), prec: P.call };
        // A cast through an alias (`Bool(x)`) calls the real JS function.
        if (r?.kind === "builtin") return { code: this.tok(e.span, r.name === "Float" || r.name === "Int" || r.name === "UInt" ? "Number" : r.name === "Bool" ? "Boolean" : r.name), prec: P.primary };
        return { code: name, prec: P.primary };
      }
      case "This": return { code: "this", prec: P.primary };
      case "Super": return { code: "super", prec: P.primary };
      // `255.toString()` is a JS syntax error (the `.` is read as a decimal point): integer
      // literals get parentheses where a member access follows, and nowhere else.
      case "Number": return { code: this.tok(e.span, e.raw), prec: /^[0-9_]+$/.test(e.raw) ? P.postfix : P.primary };
      case "String": return { code: this.tok(e.span, jsString(e.value)), prec: P.primary };
      case "Bool": return { code: this.tok(e.span, String(e.value)), prec: P.primary };
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
            if (r?.kind === "member") {
              const prop = this.fieldName(findMember(r.owner, p.name.name), p as unknown as A.Expr, p.name, p.name.name);
              return `${p.name.name}: ${r.isStatic ? this.classRef(r.owner) : this.receiver()}.${prop}`;
            }
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
        // `items.getEnumerator` as a value, on a possibly built-in enumerable.
        if (this.check.enumerateCalls.has(e)) return { code: `() => ${this.enumerate(e.object)}`, prec: P.assign };
        // Inherited statics are addressed through their declaring class: in JS, `Dog.count++`
        // would create a new property on `Dog` instead of updating `Animal.count`.
        const objType = this.check.exprTypes.get(e.object);
        const t = objType && nonNull(objType);
        const m = t?.kind === "class" || t?.kind === "classRef" ? findMember(t.info, e.name.name) : undefined;
        const prop = this.fieldName(m, e, e.name);
        if (t?.kind === "classRef" && m?.isStatic && m.owner !== t.info) return { code: `${this.classRef(m.owner)}.${prop}`, prec: P.call };
        return { code: `${this.wrap(this.expr(e.object), P.call)}${e.optional ? "?." : "."}${prop}`, prec: P.call };
      }
      case "Index": {
        // `a[i]` read (or changed: `a[i] += 1`, `a[i]++`): a position out of range throws instead of
        // giving `undefined`. A plain `a[i] = x` isn't checked: it may grow the array.
        const plainWrite = this.writeTargets.has(e) && !this.readWrites.has(e);
        if (!this.check.checkedIndexes.has(e) || plainWrite) {
          return { code: `${this.wrap(this.expr(e.object), P.call)}${e.optional ? "?." : ""}[${this.expr(e.index).code}]`, prec: P.call };
        }
        const index = this.helper("$index");
        return this.reuse(e.object, (first, again) => ({ code: `${first}${e.optional ? "?." : ""}[${index}(${again}, ${this.wrap(this.expr(e.index), P.assign)})]`, prec: P.call }));
      }
      case "Call": {
        const call = this.call(e);
        const t = this.ts && this.check.tsResultCasts.has(e) ? this.check.exprTypes.get(e) : undefined;
        return t ? { code: `(${call.code} as unknown as ${this.tsType(t)})`, prec: P.call } : call;
      }
      case "New": {
        // TypeScript keeps explicit type arguments: `new Box<number>()`.
        const t = this.ts && e.callee.kind === "TypeName" && e.callee.args.length > 0 ? this.check.typeNodeTypes.get(e.callee) : undefined;
        const callee = t?.kind === "class" ? this.tsType(t) : this.typeName(e.callee);
        return { code: `new ${this.tok(e.callee.span, callee)}(${this.args(e.args)})`, prec: P.call };
      }
      case "Unary": {
        const op = e.op === "typeof" || e.op === "delete" ? `${e.op} ` : e.op;
        let arg = this.wrap(this.expr(e.arg), P.unary);
        // Avoid `- -x` turning into `--x`.
        if ((e.op === "-" || e.op === "+") && plain(arg).startsWith(e.op)) arg = `(${arg})`;
        return { code: op + arg, prec: P.unary };
      }
      case "Await":
        return { code: `await ${this.wrap(this.expr(e.arg), P.unary)}`, prec: P.unary };
      case "Update": {
        this.writeTargets.add(e.arg);
        const arg = this.wrap(this.expr(e.arg), P.postfix);
        return e.prefix ? { code: e.op + arg, prec: P.unary } : { code: arg + e.op, prec: P.postfix };
      }
      case "Binary":
        return this.binary(e);
      case "Assign":
        if (this.check.operatorCalls.has(e)) return this.operatorAssign(e);
        this.writeTargets.add(e.target);
        return { code: `${this.expr(e.target).code} ${e.op} ${this.wrap(this.expr(e.value), P.assign)}`, prec: P.assign };
      case "Conditional":
        return {
          code: `${this.wrap(this.expr(e.cond), P.or)} ? ${this.wrap(this.expr(e.then), P.assign)} : ${this.wrap(this.expr(e.else), P.assign)}`,
          prec: P.cond,
        };
      case "TypeOp":
        return this.typeOp(e);
      case "TypeCheck": {
        // No runtime effect. TypeScript gets the checked type, so it types the value as Xenon does (`['a', 1]` as a tuple).
        const inner = this.expr(e.expr);
        if (!this.ts) return inner;
        const t = this.check.typeNodeTypes.get(e.type) ?? { kind: "any" };
        return { code: `(${this.wrap(inner, P.rel)} as ${this.tok(e.type.span, this.tsType(t))})`, prec: P.primary };
      }
      case "Function":
        return this.fn(e);
      case "DestructAssign":
        return { code: `${this.pattern(e.pattern)} = ${this.wrap(this.expr(e.value), P.assign)}`, prec: P.assign };
      case "Error":
        // Only reached in editor mode (code with errors): a placeholder TypeScript accepts anywhere.
        if (this.ts) return { code: "(undefined as any)", prec: P.primary };
        throw new Error(`codegen: unsupported expression ${e.kind}`);
    }
  }

  /** `items.getEnumerator()` on an enumerable that may be built-in (an array, a set, …): the prelude's helper. */
  private enumerate(object: A.Expr): string {
    return `${this.classRef(this.check.classes.get("xenon.Enumerable")!)}.enumerate(${this.wrap(this.expr(object), P.assign)})`;
  }

  private call(e: A.Expr & { kind: "Call" }): Code {
    if (e.callee.kind === "Member" && this.check.enumerateCalls.has(e.callee)) return { code: this.enumerate(e.callee.object), prec: P.call };
    // `Direction.values()` → `Object.values(Direction)`
    if (e.callee.kind === "Member" && e.callee.name.name === "values" && e.args.length === 0) {
      const obj = this.check.exprTypes.get(e.callee.object);
      if (obj?.kind === "classRef" && obj.info.decl.isEnum) return { code: `Object.values(${this.classRef(obj.info)})`, prec: P.call };
    }
    const r = e.callee.kind === "Ident" ? this.check.resolutions.get(e.callee) : undefined;
    if (r?.kind === "builtin" && e.args.length === 1) {
      let arg = this.expr(e.args[0]!);
      // TypeScript only takes numbers in arithmetic: `int('12')` converts a string.
      const t = this.check.exprTypes.get(e.args[0]!);
      if (this.ts && (r.name === "Int" || r.name === "UInt") && !(t?.kind === "any" || (t?.kind === "prim" && t.name !== "String" && t.name !== "Bool"))) {
        arg = { code: `(${arg.code} as any)`, prec: P.primary };
      }
      switch (r.name) {
        case "Int": return { code: `${this.wrap(arg, P.bitor + 1)} | 0`, prec: P.bitor };
        case "UInt": return { code: `${this.wrap(arg, P.shift + 1)} >>> 0`, prec: P.shift };
        case "Float": return { code: `Number(${this.wrap(arg, P.assign)})`, prec: P.call };
      }
    }
    const callee = this.wrap(this.expr(e.callee), P.call);
    return { code: `${callee}${e.optional ? "?." : ""}(${this.args(e.args)})`, prec: P.call };
  }

  /** `a += b` with `operator+` (likewise `-=`, `*=`, `/=`): `a = a['operator+'](b)`, evaluating the target's object/index once. */
  private operatorAssign(e: A.Expr & { kind: "Assign" }): Code {
    const t = e.target;
    const rhs = this.wrap(this.expr(e.value), P.assign);
    const method = jsString(`operator${e.op.slice(0, -1)}`);
    const call = (read: string) => `${read}[${method}](${rhs})`;
    if (t.kind === "Member") {
      // The property as read and as written (`#x` for a private field or a private setter).
      const objType = this.check.exprTypes.get(t.object);
      const ot = objType && nonNull(objType);
      const m = ot?.kind === "class" || ot?.kind === "classRef" ? findMember(ot.info, t.name.name) : undefined;
      const read = this.fieldName(m, t, t.name);
      this.writeTargets.add(t);
      const write = this.fieldName(m, t, t.name);
      return this.reuse(t.object, (first, again) => ({ code: `${first}.${write} = ${call(`${again}.${read}`)}`, prec: P.assign }));
    }
    if (t.kind === "Index") {
      return this.reuse(t.object, (fo, ao) => this.reuse(t.index, (fi, ai) => ({
        code: `${fo}[${fi}] = ${call(`${ao}[${ai}]`)}`,
        prec: P.assign,
      })));
    }
    const read = this.expr(t).code; // a local or `this.x`: repeating it is free
    this.writeTargets.add(t);
    const target = this.expr(t).code;
    return { code: `${target} = ${call(read)}`, prec: P.assign };
  }

  /**
   * `a == b` with `operator==`: the same object, or neither null and `a['operator=='](b)`; each
   * operand evaluated once, left first. `!=` negates it.
   */
  private equalityCall(e: A.Expr & { kind: "Binary" }): Code {
    const code = this.reuse(e.left, (l1, l) => this.reuse(e.right, (r1, r) => ({
      code: `${l1} === ${r1} || ${l} != null && ${r} != null && ${l}['operator=='](${r})`,
      prec: P.or,
    })));
    return e.op.startsWith("!") ? { code: `!(${code.code})`, prec: P.unary } : code;
  }

  private binary(e: A.Expr & { kind: "Binary" }): Code {
    if (this.check.operatorCalls.has(e) && ["==", "!=", "===", "!=="].includes(e.op)) return this.equalityCall(e);
    if (this.check.operatorCalls.has(e)) {
      return { code: `${this.wrap(this.expr(e.left), P.call)}[${jsString(`operator${e.op}`)}](${this.wrap(this.expr(e.right), P.assign)})`, prec: P.call };
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
