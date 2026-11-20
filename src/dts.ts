/**
 * Types for JavaScript imports from their `.d.ts` files (milestone 23).
 *
 * TypeScript resolves a probe file that repeats every `.xn` file's JavaScript imports; each
 * imported binding is then written out as Xenon native declarations (the form of the standard
 * library in `src/prelude/std`), one generated file per importing file, compiled with the
 * program but never emitted:
 * - a module namespace (`import * as path from 'node:path'`, or a default export that is a plain
 *   object) becomes a native class named after the local binding, its exports as statics;
 * - an exported class becomes a native class (nominal: `new`, `is`, its statics and members);
 * - an exported function or value becomes a static of the file's holder class, which the checker
 *   binds to the local name (overloads stay overloads);
 * - TypeScript interfaces and object types become typedef shapes (structural, as in TypeScript),
 *   functions types `(a:T) -> R`, arrays `Array<T>`, `Promise`/`Map`/`Set`/`Iterator`/`RegExp`/`Date`
 *   the standard library's classes; `number` is `Float`, `string | null` is `String`, `number | null`
 *   is `Float?`; a tuple `[string, number]` is `Tuple<String, Float>`.
 * Whatever doesn't map (other unions, intersections, tuples with optional or rest elements, enums, generics' type parameters,
 * overloaded methods inside object types, other built-in types such as `Uint8Array`) is `*`,
 * member by member, so code that compiled against untyped imports keeps compiling.
 */
import type tsModule from "typescript";
import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import type * as A from "./ast.ts";
import { KEYWORDS } from "./lexer.ts";

type TS = typeof tsModule;
let tsLoaded: TS | undefined;
/** TypeScript is loaded only when a project has JavaScript imports (it takes a moment). */
function typescript(): TS {
  return (tsLoaded ??= require("typescript") as TS);
}

/** Compiler options for reading declarations (also the language server's virtual project). */
export function tsOptions(): tsModule.CompilerOptions {
  const ts = typescript();
  return {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ["lib.esnext.d.ts"],
    // Xenon references may be `null`: no strict null checks.
    strict: false,
    noEmit: true,
    skipLibCheck: true,
    esModuleInterop: true,
  };
}

/** What a JavaScript import's local name refers to in the generated declarations. */
export type JsBinding =
  /** A class, or a module namespace (its exports are the class's statics). */
  | { kind: "class"; qname: string }
  /** A function or value: a static of the generated holder class. */
  | { kind: "member"; qname: string; member: string }
  /** A type exported by a namespace import, named `Ns.Type` (a structural shape). */
  | { kind: "typedef"; qname: string };

export interface JsDeclarations {
  /** Generated `.xn` files (paths below `GENERATED_DIR`). */
  sources: { path: string; text: string }[];
  /** By importing file (its path), then local name. Names without types stay `*`. */
  bindings: Map<string, Map<string, JsBinding>>;
}

/** A union of more literals of one kind than this is their base type (`String` for event names). */
const MAX_LITERALS = 30;

/** Types that need `?` or `| null` to hold `null`: numbers, booleans, their literals, unions of them. */

/** A string as a Xenon literal type: `'buffer'`. */
function quote(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n").replace(/\r/g, "\\r")}'`;
}

/** A number literal type as written: `1`, `-1`, `0.5`, `1e+21`. */
const NUMBER = /^-?\d[\d.]*(e[+-]?\d+)?$/;

/** A number as a Xenon literal type (TypeScript's number literals are all `number`: a whole one is an `int` literal). */
function numberText(value: number): string {
  return Number.isFinite(value) ? String(value) : "Float";
}

/** An optional parameter's default: `Float` 0, a literal itself, `false` for `Boolean`, else `null`. */
function defaultFor(type: string): string {
  if (type === "Float") return "0";
  if (type === "Boolean") return "false";
  if (type === "true" || type === "false" || NUMBER.test(type)) return type; // a literal: its value
  return "null";
}

/** Web platform classes the standard library declares under the same name (non-generic ones). */
const WEB_CLASSES = new Set(["Blob", "File", "FormData", "Response", "ArrayBuffer", "Event", "EventTarget", "Node", "Element", "Document", "DOMParser", "XMLSerializer", "HTMLCollection"]);

/** The package (and directory) of generated declarations. */
export const GENERATED_DIR = "__js";

/**
 * Declarations generated per project and set of imports: generation is slow, imports change
 * rarely. An entry is reused while the files it was made from are unchanged, and no package was
 * installed or removed since (the language server lives longer than a `node_modules`).
 */
const results = new Map<string, { result: JsDeclarations; stamps: Map<string, number> }>();
/** Parsed library and `node_modules` declarations, shared by all programs (until the file changes). */
const parsed = new Map<string, { mtime: number; file: tsModule.SourceFile }>();

/** A file's or folder's modification time, or -1 if there is none. */
function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return -1;
  }
}

/** The `node_modules` folders packages are found in from `root`: installing one changes their time. */
function packageFolders(root: string): string[] {
  const folders: string[] = [];
  for (let dir = root; ; dir = dirname(dir)) {
    folders.push(join(dir, "node_modules"), join(dir, "node_modules", "@types"));
    if (dirname(dir) === dir) return folders;
  }
}

const IDENT = /^[A-Za-z_$][\w$]*$/;
/** At most this many typedefs and classes per generated file; beyond, types are `*`. */
const MAX_DECLS = 400;

/**
 * Declarations for the JavaScript imports of `files`, resolved from `root` (a directory whose
 * `node_modules` hold the packages and their types). `reserved`: names generated declarations must
 * not take (the prelude's).
 */
export function jsDeclarations(files: A.XenonFile[], root: string, reserved: Set<string>): JsDeclarations {
  const probes: { file: A.XenonFile; local: string; kind: "default" | "namespace" | "named"; probe: string }[] = [];
  const lines: string[] = [];
  /** Folders of relative imports: a `.d.ts` added there later must be noticed. */
  const folders = new Set(packageFolders(root));
  for (const file of files) {
    for (const imp of file.imports) {
      if (imp.kind !== "JsImport") continue;
      // A relative import names a file next to the importing one (`../lib/xlsx.js`): TypeScript
      // gets its absolute path, finding `xlsx.d.ts` beside it.
      const relative = imp.module.startsWith("./") || imp.module.startsWith("../");
      const target = relative ? join(root, dirname(file.file.path), imp.module) : imp.module;
      if (relative) folders.add(dirname(target));
      const spec = JSON.stringify(target);
      const add = (local: string, kind: "default" | "namespace" | "named", clause: (p: string) => string) => {
        const probe = `__xenon${probes.length}`;
        probes.push({ file, local, kind, probe });
        lines.push(`import ${clause(probe)} from ${spec};`);
      };
      if (imp.defaultName) add(imp.defaultName.name, "default", (p) => p);
      if (imp.namespace) add(imp.namespace.name, "namespace", (p) => `* as ${p}`);
      for (const n of imp.named) add((n.alias ?? n.name).name, "named", (p) => `{ ${n.name.name} as ${p} }`);
    }
  }
  const empty: JsDeclarations = { sources: [], bindings: new Map() };
  if (probes.length === 0) return empty;
  const text = lines.join("\n") + "\n";
  const key = `${root}\n${text}`;
  const cached = results.get(key);
  if (cached && [...cached.stamps].every(([path, time]) => mtime(path) === time)) return cached.result;

  let result: JsDeclarations;
  const read = new Set<string>(folders);
  try {
    result = generate(probes, text, root, reserved, read);
  } catch {
    result = empty; // TypeScript failed on these declarations: the imports stay untyped
  }
  if (results.size > 20) results.clear();
  results.set(key, { result, stamps: new Map([...read].map((path) => [path, mtime(path)])) });
  return result;
}

function generate(probes: { file: A.XenonFile; local: string; kind: string; probe: string }[], text: string, root: string, reserved: Set<string>, read: Set<string>): JsDeclarations {
  const ts = typescript();
  const options = tsOptions();
  const probePath = join(root, "__xenon_imports__.ts");
  const host = ts.createCompilerHost(options);
  const { getSourceFile, fileExists, readFile } = host;
  host.getCurrentDirectory = () => root;
  host.fileExists = (f) => f === probePath || fileExists.call(host, f);
  host.readFile = (f) => (f === probePath ? text : readFile.call(host, f));
  host.getSourceFile = (f, lang, ...rest) => {
    if (f === probePath) return ts.createSourceFile(f, text, lang);
    // Every declaration file read is a dependency of the result; a missing one is never cached.
    read.add(f);
    const time = mtime(f);
    const hit = parsed.get(f);
    if (hit?.mtime === time) return hit.file;
    const file = getSourceFile.call(host, f, lang, ...rest);
    if (file) parsed.set(f, { mtime: time, file });
    else parsed.delete(f);
    return file;
  };
  const program = ts.createProgram([probePath], options, host);
  const checker = program.getTypeChecker();
  const probeFile = program.getSourceFile(probePath)!;
  const locals = new Map<string, tsModule.Identifier>();
  const visit = (n: tsModule.Node) => {
    // The local names: `import { readFileSync as __xenon3 }` has `readFileSync` too, which doesn't match.
    if (ts.isIdentifier(n) && n.text.startsWith("__xenon")) locals.set(n.text, n);
    n.forEachChild(visit);
  };
  visit(probeFile);

  const out: JsDeclarations = { sources: [], bindings: new Map() };
  const byFile = new Map<A.XenonFile, typeof probes>();
  for (const p of probes) byFile.set(p.file, [...(byFile.get(p.file) ?? []), p]);
  let index = 0;
  for (const [file, list] of byFile) {
    const holder = `F${index++}`;
    const gen = new DeclWriter(ts, checker, program, reserved, list.map((p) => p.local));
    const statics: string[] = [];
    const bindings = new Map<string, JsBinding>();
    const path = `${GENERATED_DIR}/${holder}.xn`;
    const symbolOf = (p: (typeof list)[number]) => {
      const node = locals.get(p.probe);
      if (!node || reserved.has(p.local)) return undefined;
      let sym = checker.getSymbolAtLocation(node);
      if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
      return sym?.declarations?.length ? { node, sym } : undefined; // none: no types for this module
    };
    // Imported classes and types first (`import { Dirent }`, `import { ChildProcessWithoutNullStreams }`):
    // declared under the local name before a function's signature (`readdir`'s) declares them, so
    // both name one class rather than two (`Dirent` and `Dirent2`, which wouldn't be assignable).
    const isClass = (sym: tsModule.Symbol) => !!(sym.flags & ts.SymbolFlags.Class);
    const typeOnly = (sym: tsModule.Symbol) => !!(sym.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias)) && !(sym.flags & ts.SymbolFlags.Value);
    for (const p of list) {
      const found = symbolOf(p);
      if (!found || !(isClass(found.sym) || typeOnly(found.sym))) continue;
      // A class is a value too: its JavaScript name is the local binding.
      const declared = isClass(found.sym) ? gen.importedClass(found.sym, p.local) : gen.importedType(found.sym, p.local);
      if (declared) bindings.set(p.local, { kind: declared.kind, qname: `${path}#${declared.name}` });
    }
    for (const p of list) {
      const found = symbolOf(p);
      if (!found || isClass(found.sym) || typeOnly(found.sym)) continue;
      const { node, sym } = found;
      const type = checker.getTypeOfSymbolAtLocation(sym, node);
      if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) continue;
      // A constructor held in a variable (`declare var URL: typeof _URL`, `BufferConstructor`): the class it makes.
      const made = type.getConstructSignatures()[0]?.getReturnType().getSymbol();
      if (made && made.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Interface) && !(p.kind === "namespace")) {
        gen.classDecl(made, p.local, p.local, type);
        bindings.set(p.local, { kind: "class", qname: `${path}#${p.local}` });
        continue;
      }
      const callable = type.getCallSignatures().length > 0;
      if (p.kind === "namespace" || (!callable && type.getConstructSignatures().length === 0 && checker.getPropertiesOfType(type).length > 0 && type.flags & ts.TypeFlags.Object)) {
        // The module's exported types, nameable as `Ns.Type`: classes reached through the
        // namespace at run time too (`new Ns.Cell(…)`), so that is their JavaScript name.
        const types = sym.flags & ts.SymbolFlags.Module ? checker.getExportsOfModule(sym).flatMap((exp) => {
          const target = exp.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exp) : exp;
          return IDENT.test(exp.name) && target.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias) ? [[exp.name, target] as const] : [];
        }) : [];
        for (const [name, target] of types) gen.jsNames.set(target, `${p.local}.${name}`);
        gen.namespaceDecl(type, p.local, sym);
        bindings.set(p.local, { kind: "class", qname: `${path}#${p.local}` });
        for (const [name, target] of types) {
          const declared = gen.typeExport(target);
          if (declared) bindings.set(`${p.local}.${name}`, { kind: declared.kind, qname: `${path}#${declared.name}` });
        }
        continue;
      }
      const decl = gen.member(sym, type, p.local, true, "  ");
      if (!decl) continue;
      statics.push(decl);
      bindings.set(p.local, { kind: "member", qname: `${GENERATED_DIR}.${holder}`, member: p.local });
    }
    if (bindings.size === 0) continue;
    out.bindings.set(file.file.path, bindings);
    out.sources.push({
      path,
      text: [
        `// Generated from TypeScript declarations: the JavaScript imports of ${file.file.path}.`,
        `package ${GENERATED_DIR} {`,
        `  public native class ${holder} {`,
        `    private function ${holder}()`,
        ...statics.map((s) => "  " + s),
        "  }",
        "}",
        ...gen.decls,
        "",
      ].join("\n"),
    });
  }
  return out;
}

/** Writes Xenon declarations for TypeScript types into one generated file. */
class DeclWriter {
  /** File-private typedefs and native classes, in order. */
  readonly decls: string[] = [];
  private names: Set<string>;
  private typeNames = new Map<tsModule.Type, string>();
  private classNames = new Map<tsModule.Symbol, string>();
  /** JavaScript names of classes reachable through a namespace import (`Sheet.Cell`). */
  readonly jsNames = new Map<tsModule.Symbol, string>();

  constructor(
    private ts: TS,
    private checker: tsModule.TypeChecker,
    private program: tsModule.Program,
    reserved: Set<string>,
    locals: string[],
  ) {
    this.names = new Set([...reserved, ...locals]);
  }

  private unique(raw: string): string {
    // Module symbols are named `"node:fs/promises"`: keep the letters (`node_fs_promises`).
    let base = raw.replace(/^"|"$/g, "").replace(/[^\w$]+/g, "_").replace(/^_+|_+$/g, "");
    if (!IDENT.test(base) || KEYWORDS.has(base)) base = "Type";
    let name = base;
    for (let i = 2; this.names.has(name); i++) name = `${base}${i}`;
    this.names.add(name);
    return name;
  }

  private full(): boolean {
    return this.decls.length >= MAX_DECLS;
  }

  // ---- declarations ----

  /** A module namespace: a native class named after the local binding, its exports as statics. */
  namespaceDecl(type: tsModule.Type, local: string, sym: tsModule.Symbol) {
    const members = this.checker.getPropertiesOfType(type).flatMap((p) => {
      const decl = this.member(p, this.checker.getTypeOfSymbol(p), p.name, true, "  ");
      return decl ? [decl] : [];
    });
    this.decls.push([`${this.doc(sym, "")}native('${local}') class ${local} {`, `  private function ${local}()`, ...members, "}"].join("\n"));
  }

  /**
   * A class, or an interface with methods (`Buffer`, `Stats`, a stream): its constructors, statics
   * (when it is also a value) and instance members. It extends its first base that is one too, and
   * then declares only its own members. `name` is its Xenon name, `jsName` its JavaScript one;
   * `constructorType`: the type of the value that constructs it, when that isn't the symbol itself.
   */
  classDecl(sym: tsModule.Symbol, name: string, jsName: string, constructorType?: tsModule.Type) {
    const ts = this.ts;
    this.classNames.set(sym, name);
    // Reserve the slot now: members may refer back to this class.
    const at = this.decls.push("") - 1;
    const checker = this.checker;
    const instance = checker.getDeclaredTypeOfSymbol(sym);
    // Statics and constructors: of the class, or of the variable holding its constructor.
    const statics = constructorType ?? (sym.flags & ts.SymbolFlags.Value ? checker.getTypeOfSymbol(sym) : undefined);
    // Built-in bases (`Uint8Array` for `Buffer`) aren't declared: their members are listed instead.
    const base = instance.isClassOrInterface() ? (checker.getBaseTypes(instance) ?? []).map((b) => b.getSymbol()).find((b) => b && this.isClassLike(b) && !this.isLib(b)) : undefined;
    const parent = base && !this.full() ? this.classRefOf(base) : undefined;
    const lines = [`${this.doc(sym, "")}native('${jsName}') class ${name}${parent ? ` extends ${parent}` : ""} {`];
    const ctors = statics?.getConstructSignatures() ?? [];
    if (ctors.length === 0) lines.push(`  private function ${name}()`);
    for (const c of ctors) lines.push(`  function ${name}(${this.params(c)})`);
    // A static and an instance member can't share a name in Xenon (`Buffer.compare`): the instance one wins.
    const instanceNames = new Set(checker.getPropertiesOfType(instance).map((p) => p.name));
    for (const p of statics ? checker.getPropertiesOfType(statics) : []) {
      if (p.name === "prototype" || instanceNames.has(p.name)) continue;
      const d = this.member(p, checker.getTypeOfSymbol(p), p.name, true, "  ");
      if (d) lines.push(d);
    }
    for (const p of checker.getPropertiesOfType(instance)) {
      if (parent && !sym.members?.has(p.escapedName)) continue; // inherited from the parent
      const d = this.member(p, checker.getTypeOfSymbol(p), p.name, false, "  ");
      if (d) lines.push(d);
    }
    lines.push("}");
    this.decls[at] = lines.join("\n");
  }

  /** Declared globally by TypeScript's library, Node's types (`@types/node`) or Bun's types: a platform type, not a package's. */
  private isGlobal(sym: tsModule.Symbol): boolean {
    return this.isLib(sym) || !!sym.declarations?.some((d) => /[\\/](@types[\\/]node|@types[\\/]bun|bun-types)[\\/]/.test(d.getSourceFile().fileName));
  }

  /** Declared by TypeScript's own library (`lib.*.d.ts`). */
  private isLib(sym: tsModule.Symbol): boolean {
    return !!sym.declarations?.some((d) => this.program.isSourceFileDefaultLibrary(d.getSourceFile()));
  }

  /**
   * Classes become native classes. Interfaces are structural, as in TypeScript: shapes, so an object
   * literal can be passed for one (docxtemplater's `{ get(scope) { … } }` parser, an options bag
   * with callbacks), unless a shape can't hold them: a method with overloads or type parameters
   * (Node's `Buffer`) makes a native class.
   */
  private isClassLike(sym: tsModule.Symbol): boolean {
    const ts = this.ts;
    if (sym.flags & ts.SymbolFlags.Class) return true;
    if (!(sym.flags & ts.SymbolFlags.Interface)) return false;
    return this.checker.getPropertiesOfType(this.checker.getDeclaredTypeOfSymbol(sym)).some((p) => {
      if (!(p.flags & ts.SymbolFlags.Method)) return false;
      const calls = this.checker.getTypeOfSymbol(p).getCallSignatures();
      return calls.length > 1 || calls.some((c) => (c.typeParameters?.length ?? 0) > 0);
    });
  }

  /** The native class for a class-like symbol, declared on first use. */
  private classRefOf(sym: tsModule.Symbol): string {
    const known = this.classNames.get(sym);
    if (known) return known;
    const name = this.unique(sym.name);
    this.classDecl(sym, name, this.jsNames.get(sym) ?? sym.name);
    return name;
  }

  /** A class imported by name: declared under its local name, which is also its JavaScript one. */
  importedClass(sym: tsModule.Symbol, local: string): { kind: "class"; name: string } {
    const known = this.classNames.get(sym);
    if (known) return { kind: "class", name: known };
    this.classDecl(sym, local, local);
    return { kind: "class", name: local };
  }

  /** A type imported by name: declared under its local name (unless already declared). */
  importedType(sym: tsModule.Symbol, local: string): { kind: "class" | "typedef"; name: string } | undefined {
    if (this.full() || this.isLib(sym)) return undefined;
    if (this.isClassLike(sym)) {
      const known = this.classNames.get(sym);
      if (known) return { kind: "class", name: known };
      this.classDecl(sym, local, this.jsNames.get(sym) ?? sym.name);
      return { kind: "class", name: local };
    }
    // A shape is named after its TypeScript name: the local one is reserved, so let it take that.
    const own = sym.name === local;
    if (own) this.names.delete(local);
    const declared = this.typeExport(sym);
    if (own) this.names.add(local);
    return declared;
  }

  /** A module's exported type, declared to be named as `Ns.Type`: a native class or a typedef shape. */
  typeExport(sym: tsModule.Symbol): { kind: "class" | "typedef"; name: string } | undefined {
    if (this.full() || this.isLib(sym)) return undefined;
    if (this.isClassLike(sym)) return { kind: "class", name: this.classRefOf(sym) };
    const text = this.type(this.checker.getDeclaredTypeOfSymbol(sym), false);
    return [...this.typeNames.values()].includes(text) ? { kind: "typedef", name: text } : undefined;
  }

  /** One member: methods with all their signatures, read-only properties as getters (statics as `const`). */
  member(sym: tsModule.Symbol, type: tsModule.Type, name: string, isStatic: boolean, indent: string): string | undefined {
    const ts = this.ts;
    if (!IDENT.test(name) || KEYWORDS.has(name) || name === "constructor") return undefined;
    const doc = this.doc(sym, indent);
    const st = isStatic ? "static " : "";
    const calls = type.getCallSignatures();
    const isFunction = sym.flags & (ts.SymbolFlags.Method | ts.SymbolFlags.Function) || (calls.length > 0 && this.checker.getPropertiesOfType(type).length === 0);
    if (isFunction && calls.length > 0) {
      return calls.map((c, i) => `${i === 0 ? doc : ""}${indent}${st}function ${name}(${this.params(c)}):${this.type(c.getReturnType(), true)}`).join("\n");
    }
    const t = this.type(type, false);
    if (this.readonly(sym)) return isStatic ? `${doc}${indent}static const ${name}:${t}` : `${doc}${indent}function get ${name}():${t}`;
    return `${doc}${indent}${st}var ${name}:${t}`;
  }

  private readonly(sym: tsModule.Symbol): boolean {
    const ts = this.ts;
    if (sym.flags & ts.SymbolFlags.GetAccessor && !(sym.flags & ts.SymbolFlags.SetAccessor)) return true;
    return !!sym.declarations?.some((d) =>
      ts.getCombinedModifierFlags(d as tsModule.Declaration) & ts.ModifierFlags.Readonly ||
      (ts.isVariableDeclaration(d) && ts.getCombinedNodeFlags(d) & ts.NodeFlags.Const));
  }

  /**
   * A union: `String | Buffer | URL`, `Shape | BufferEncoding | null`. A named one (`BufferEncoding`)
   * becomes a typedef of that name, and is kept as one member where TypeScript wrote it into a
   * larger union. `true | false` is `Boolean`; more than `MAX_LITERALS` literals of one kind are
   * their base type (an event name list); a function member is `Function` (a function type can't
   * be a union member in Xenon: `() -> void | String` reads as a function returning a union).
   */
  private unionType(t: tsModule.UnionType, ret: boolean): string {
    const F = this.ts.TypeFlags;
    const nullish = t.types.some((x) => x.flags & (F.Null | F.Undefined | F.Void));
    // As written, where TypeScript kept it (`Options | BufferEncoding | null`, not 14 members).
    const written = (t as tsModule.UnionType & { origin?: tsModule.Type }).origin;
    const source = written?.isUnion() ? written.types : t.types;
    const parts = source.filter((x) => !(x.flags & (F.Null | F.Undefined | F.Void)));
    if (parts.length === 0) return ret ? "void" : "*";
    if (parts.length === 1) {
      const only = this.type(parts[0]!, false);
      // `T | null` / `T | undefined`: `T?` (for object types that matters with null safety; without it they hold `null` anyway).
      if (!nullish || only === "*" || only === "void") return only;
      if (only.includes(" | ")) return `${only} | null`;
      return only.startsWith("(") ? `Null<${only}>` : `${only}?`;
    }
    if (t.aliasSymbol && !written?.isUnion()) {
      const known = this.typeNames.get(t);
      if (known) return known + (nullish ? " | null" : "");
    }
    const texts: string[] = [];
    for (const kind of [F.StringLiteral, F.NumberLiteral]) {
      const lits = parts.filter((x) => x.flags & kind && !(x.flags & F.EnumLiteral));
      if (lits.length > MAX_LITERALS) texts.push(kind === F.StringLiteral ? "String" : "Float");
    }
    const bools = parts.filter((x) => x.flags & F.BooleanLiteral);
    if (bools.length === 2) texts.push("Boolean");
    for (const x of parts) {
      if (x.flags & F.BooleanLiteral && bools.length === 2) continue;
      if (texts.includes("String") && x.flags & F.StringLiteral) continue;
      if (texts.includes("Float") && x.flags & F.NumberLiteral && !(x.flags & F.EnumLiteral)) continue;
      const text = x.getCallSignatures().length > 0 && this.checker.getPropertiesOfType(x).length === 0 ? "Function" : this.type(x, false);
      if (text === "*") return "*";
      if (!texts.includes(text)) texts.push(text);
    }
    let text = texts.join(" | ");
    // A named union is a typedef: `BufferEncoding` in hovers, declared once.
    if (t.aliasSymbol && texts.length > 1 && !written?.isUnion() && !this.full()) {
      const name = this.unique(t.aliasSymbol.name);
      this.typeNames.set(t, name);
      this.decls.push(`${this.aliasDoc(t.aliasSymbol)}typedef ${name} = ${text}`);
      text = name;
    }
    return nullish ? `${text} | null` : text;
  }

  /** A type alias's JSDoc as a comment. */
  private aliasDoc(sym: tsModule.Symbol): string {
    return this.doc(sym, "");
  }

  /** `name:T, opt:T = null, ...rest:Array<T>` */
  private params(sig: tsModule.Signature): string {
    const ts = this.ts;
    return sig.parameters.map((p, i) => {
      const decl = p.valueDeclaration as tsModule.ParameterDeclaration | undefined;
      const name = IDENT.test(p.name) && !KEYWORDS.has(p.name) ? p.name : `p${i}`;
      const t = this.checker.getTypeOfSymbol(p);
      if (decl && ts.isParameter(decl) && decl.dotDotDotToken) {
        const element = this.checker.isArrayType(t) ? this.checker.getTypeArguments(t as tsModule.TypeReference)[0] : undefined;
        return `...${name}:Array<${element ? this.type(element, false) : "*"}>`;
      }
      const text = this.type(t, false);
      const optional = !!decl && ts.isParameter(decl) && (!!decl.questionToken || !!decl.initializer);
      return optional ? `${name}:${text} = ${defaultFor(text)}` : `${name}:${text}`;
    }).join(", ");
  }

  /** The declaration's JSDoc as a `/** … *\/` comment (what hovers show). */
  private doc(sym: tsModule.Symbol, indent: string): string {
    const text = this.ts.displayPartsToString(sym.getDocumentationComment(this.checker)).trim();
    if (!text) return "";
    const body = text.replace(/\*\//g, "* /").split("\n").join(`\n${indent} * `);
    return `${indent}/** ${body} */\n`;
  }

  // ---- types ----

  /** A TypeScript type in Xenon. `ret`: a return type (`void` allowed). */
  type(t: tsModule.Type, ret: boolean): string {
    const F = this.ts.TypeFlags;
    if (t.flags & (F.Any | F.Unknown)) return "*";
    if (t.flags & (F.Void | F.Undefined | F.Never)) return ret ? "void" : "*";
    // Literal types: what TypeScript chooses overloads by (`withFileTypes: true`, `encoding: 'buffer'`).
    if (t.flags & F.BooleanLiteral) return (t as tsModule.Type & { intrinsicName: string }).intrinsicName === "true" ? "true" : "false";
    if (t.flags & F.StringLiteral) return quote((t as tsModule.StringLiteralType).value);
    // A number literal (`mode: 1`), not an enum member (named by TypeScript, its value an accident).
    if (t.flags & F.NumberLiteral && !(t.flags & F.EnumLiteral)) return numberText((t as tsModule.NumberLiteralType).value);
    if (t.flags & F.StringLike) return "String";
    if (t.flags & F.NumberLike) return "Float";
    if (t.flags & F.BooleanLike) return "Boolean";
    if (t.isUnion()) return this.unionType(t, ret);
    if (t.flags & F.Object) return this.objectType(t as tsModule.ObjectType);
    // An intersection of object types (`ObjectEncodingOptions & { withFileTypes: true }`): one shape
    // with the members of all (not of classes: those are nominal).
    if (t.isIntersection() && t.types.every((x) => x.flags & F.Object && !(x.getSymbol() && this.isClassLike(x.getSymbol()!)) && x.getCallSignatures().length === 0)) {
      return this.shape(t as unknown as tsModule.ObjectType, undefined);
    }
    return "*"; // type parameters, other intersections, enums, symbols, bigints, …
  }

  private objectType(t: tsModule.ObjectType): string {
    const checker = this.checker;
    // `[string, number]`: a `Tuple<String, Float>`; with optional or rest elements its length varies: `Array<*>`.
    if (checker.isTupleType(t)) {
      const target = (t as tsModule.TypeReference).target as tsModule.TupleType;
      const fixed = target.elementFlags.every((f) => f & this.ts.ElementFlags.Required);
      const elements = checker.getTypeArguments(t as tsModule.TypeReference);
      return fixed && elements.length > 0 ? `Tuple<${elements.map((e) => this.type(e, false)).join(", ")}>` : "Array<*>";
    }
    if (checker.isArrayType(t)) return `Array<${this.type(checker.getTypeArguments(t as tsModule.TypeReference)[0]!, false)}>`;
    const sym = t.getSymbol();
    // A web platform class the standard library declares (`Blob` in pizzip's `generate(…): Blob`):
    // the same class, whether TypeScript's DOM library, Node's or Bun's types declare it.
    if (sym && WEB_CLASSES.has(sym.name) && this.names.has(sym.name) && this.isGlobal(sym)) return sym.name;
    if (sym && (sym.name === "NodeListOf" || sym.name === "NodeList") && this.isGlobal(sym)) {
      const args = (t as tsModule.TypeReference).target ? this.checker.getTypeArguments(t as tsModule.TypeReference) : [];
      return `NodeList<${args[0] ? this.type(args[0], false) : "Node"}>`;
    }
    if (sym && this.isLib(sym)) return this.libType(sym.name, t);
    const calls = t.getCallSignatures();
    const props = checker.getPropertiesOfType(t);
    if (t.getConstructSignatures().length > 0) return "*"; // a class itself, as a value
    if (calls.length > 0 && props.length === 0) return calls.length === 1 ? this.functionType(calls[0]!) : "Function";
    if (sym && this.isClassLike(sym)) return this.classNames.get(sym) ?? (this.full() ? "*" : this.classRefOf(sym));
    return this.shape(t, sym);
  }

  /** Built-in types the standard library declares; others (typed arrays, `Error`, …) are `*`. */
  private libType(name: string, t: tsModule.ObjectType): string {
    const args = (t as tsModule.TypeReference).target ? this.checker.getTypeArguments(t as tsModule.TypeReference) : [];
    const arg = (i: number, ret = false) => (args[i] ? this.type(args[i], ret) : "*");
    switch (name) {
      case "Promise": case "PromiseLike": return `Promise<${arg(0, true)}>`;
      case "Map": case "ReadonlyMap": return `Map<${arg(0)}, ${arg(1)}>`;
      case "Set": case "ReadonlySet": return `Set<${arg(0)}>`;
      case "Iterator": case "IterableIterator": case "IteratorObject": case "MapIterator": case "SetIterator": case "ArrayIterator": case "Generator":
        return `Iterator<${arg(0)}>`;
      case "RegExp": case "Date": case "Function": case "Object": return name;
      case "String": return "String";
      case "Number": return "Float";
      case "Boolean": return "Boolean";
      default: return "*";
    }
  }

  /** `(a:T, ...rest:Array<U>) -> R` (optional parameters become required: function types have none). */
  private functionType(sig: tsModule.Signature): string {
    const params = this.params(sig).replace(/ = (-?\d[\d.]*(?:e[+-]?\d+)?|false|true|null)(?=,|$)/g, "");
    return `(${params}) -> ${this.type(sig.getReturnType(), true)}`;
  }

  /** An interface or object type: a typedef shape (overloaded methods are `Function`). */
  private shape(t: tsModule.ObjectType, sym: tsModule.Symbol | undefined): string {
    const known = this.typeNames.get(t);
    if (known) return known;
    const props = this.checker.getPropertiesOfType(t);
    if (props.length === 0) return "Object";
    if (this.full()) return "*";
    const base = t.aliasSymbol?.name ?? (sym && sym.name !== "__type" && sym.name !== "__object" ? sym.name : "Shape");
    const name = this.unique(base);
    this.typeNames.set(t, name); // before the members: they may refer back
    const at = this.decls.push("") - 1;
    const members = props.flatMap((p) => {
      if (!IDENT.test(p.name) || KEYWORDS.has(p.name)) return [];
      const optional = !!(p.flags & this.ts.SymbolFlags.Optional);
      const type = this.checker.getTypeOfSymbol(p);
      const calls = type.getCallSignatures();
      const text = p.flags & this.ts.SymbolFlags.Method ? (calls.length === 1 ? this.functionType(calls[0]!) : "Function") : this.type(type, false);
      return [`${this.readonly(p) ? "final " : ""}${optional ? "?" : ""}${p.name}:${text}`];
    });
    this.decls[at] = `${this.shapeDoc(t, sym, props)}typedef ${name} = { ${members.join(", ")} }`;
    return name;
  }

  /**
   * A shape's doc comment: the TypeScript one, and what the shape can't hold as members (keys that
   * aren't identifiers, like SheetJS's `'!ref'`, and index signatures), which are read by index.
   */
  private shapeDoc(t: tsModule.ObjectType, sym: tsModule.Symbol | undefined, props: tsModule.Symbol[]): string {
    const lines: string[] = [];
    const own = sym && sym.name !== "__type" && sym.name !== "__object" ? this.ts.displayPartsToString(sym.getDocumentationComment(this.checker)).trim() : "";
    if (own) lines.push(own, "");
    const indexes = this.checker.getIndexInfosOfType(t).filter((i) => i.keyType.flags & (this.ts.TypeFlags.String | this.ts.TypeFlags.Number));
    for (const i of indexes) {
      const key = i.keyType.flags & this.ts.TypeFlags.String ? "String" : "int";
      lines.push(`Indexed by any \`${key}\` key (\`value[key]\`, untyped \`*\`); in TypeScript \`${this.checker.typeToString(i.type)}\`.`);
    }
    const other = props.filter((p) => !IDENT.test(p.name) || KEYWORDS.has(p.name));
    if (other.length > 0) {
      const shown = other.slice(0, 12).map((p) => `\`'${p.name}'\``).join(", ") + (other.length > 12 ? ", …" : "");
      lines.push(`Also has ${shown}, read by index: \`value['${other[0]!.name}']\` (untyped \`*\`).`);
    }
    while (lines.at(-1) === "") lines.pop();
    if (lines.length === 0) return "";
    return `/** ${lines.join("\n").replace(/\*\//g, "* /").split("\n").join("\n * ")} */\n`;
  }
}
