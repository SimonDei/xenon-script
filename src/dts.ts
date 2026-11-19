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
 *   is `Float?`.
 * Whatever doesn't map (other unions, intersections, tuples, enums, generics' type parameters,
 * overloaded methods inside object types, other built-in types such as `Uint8Array`) is `*`,
 * member by member, so code that compiled against untyped imports keeps compiling.
 */
import type tsModule from "typescript";
import { join } from "node:path";
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
  | { kind: "member"; qname: string; member: string };

export interface JsDeclarations {
  /** Generated `.xn` files (paths below `GENERATED_DIR`). */
  sources: { path: string; text: string }[];
  /** By importing file (its path), then local name. Names without types stay `*`. */
  bindings: Map<string, Map<string, JsBinding>>;
}

/** The package (and directory) of generated declarations. */
export const GENERATED_DIR = "__js";

/** Declarations generated from one `.d.ts` per project: generation is slow, imports change rarely. */
const results = new Map<string, JsDeclarations>();
/** Parsed library and `node_modules` declarations, shared by all programs. */
const parsed = new Map<string, tsModule.SourceFile | undefined>();

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
  for (const file of files) {
    for (const imp of file.imports) {
      if (imp.kind !== "JsImport") continue;
      const spec = JSON.stringify(imp.module);
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
  if (cached) return cached;

  let result: JsDeclarations;
  try {
    result = generate(probes, text, root, reserved);
  } catch {
    result = empty; // TypeScript failed on these declarations: the imports stay untyped
  }
  if (results.size > 20) results.clear();
  results.set(key, result);
  return result;
}

function generate(probes: { file: A.XenonFile; local: string; kind: string; probe: string }[], text: string, root: string, reserved: Set<string>): JsDeclarations {
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
    if (!parsed.has(f)) parsed.set(f, getSourceFile.call(host, f, lang, ...rest));
    return parsed.get(f);
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
    for (const p of list) {
      const node = locals.get(p.probe);
      if (!node || reserved.has(p.local)) continue;
      let sym = checker.getSymbolAtLocation(node);
      if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
      if (!sym || !sym.declarations?.length) continue; // no types for this module
      if (sym.flags & ts.SymbolFlags.Class) {
        gen.classDecl(sym, p.local, p.local);
        bindings.set(p.local, { kind: "class", qname: `${path}#${p.local}` });
        continue;
      }
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
        gen.namespaceDecl(type, p.local, sym);
        bindings.set(p.local, { kind: "class", qname: `${path}#${p.local}` });
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

  /** Declared by TypeScript's own library (`lib.*.d.ts`). */
  private isLib(sym: tsModule.Symbol): boolean {
    return !!sym.declarations?.some((d) => this.program.isSourceFileDefaultLibrary(d.getSourceFile()));
  }

  /** Classes and interfaces with methods become native classes; other object types shapes. */
  private isClassLike(sym: tsModule.Symbol): boolean {
    const ts = this.ts;
    if (sym.flags & ts.SymbolFlags.Class) return true;
    if (!(sym.flags & ts.SymbolFlags.Interface)) return false;
    return this.checker.getPropertiesOfType(this.checker.getDeclaredTypeOfSymbol(sym)).some((p) => p.flags & ts.SymbolFlags.Method);
  }

  /** The native class for a class-like symbol, declared on first use. */
  private classRefOf(sym: tsModule.Symbol): string {
    const known = this.classNames.get(sym);
    if (known) return known;
    const name = this.unique(sym.name);
    this.classDecl(sym, name, sym.name);
    return name;
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
      return optional ? `${name}:${text} = ${text === "Float" ? "0" : text === "Boolean" ? "false" : "null"}` : `${name}:${text}`;
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
    if (t.flags & F.StringLike) return "String";
    if (t.flags & F.NumberLike) return "Float";
    if (t.flags & F.BooleanLike) return "Boolean";
    if (t.isUnion()) {
      const parts = t.types.filter((x) => !(x.flags & (F.Null | F.Undefined | F.Void)));
      if (parts.length === 0) return ret ? "void" : "*";
      // Several object types: no Xenon equivalent (and generating each would be wasted).
      if (parts.length > 1 && parts.some((x) => x.flags & F.Object)) return "*";
      const texts = new Set(parts.map((x) => this.type(x, false)));
      if (texts.size !== 1) return "*";
      const only = [...texts][0]!;
      return parts.length < t.types.length && (only === "Float" || only === "Boolean") ? `${only}?` : only;
    }
    if (t.flags & F.Object) return this.objectType(t as tsModule.ObjectType);
    return "*"; // type parameters, intersections, enums, symbols, bigints, …
  }

  private objectType(t: tsModule.ObjectType): string {
    const checker = this.checker;
    if (checker.isTupleType(t)) return "Array<*>";
    if (checker.isArrayType(t)) return `Array<${this.type(checker.getTypeArguments(t as tsModule.TypeReference)[0]!, false)}>`;
    const sym = t.getSymbol();
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
    const params = this.params(sig).replace(/ = (0|false|null)(?=,|$)/g, "");
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
    this.decls[at] = `typedef ${name} = { ${members.join(", ")} }`;
    return name;
  }
}
