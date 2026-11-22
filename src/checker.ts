import type * as A from "./ast.ts";
import type { DiagnosticBag, DiagnosticBuilder, Edit } from "./diagnostics.ts";
import type { JsBinding } from "./dts.ts";
import { checkScoped } from "./scoped.ts";
import { attributeUsage, checkDeprecated, COMPILE_TIME_ATTRIBUTES, isConstantArgument } from "./attributes.ts";
import { type Budget, type ConstLookup, ConstObject, type ConstValue, fits, type Fold, fold, isPrimitive, callNative, run } from "./consteval.ts";
import { assignedNames, assignmentWrites, breaksOut, completes, mentions } from "./flow.ts";
import { GLOBAL_HINTS, JS_GLOBALS, TYPED_GLOBALS } from "./globals.ts";
import { cover, type SourceFile, type Span, span, spanText } from "./source.ts";
import { suggest } from "./suggest.ts";
import {
  arithmeticResult, assignable, isSubclass, supertypes, BUILTIN_TYPES, arrayOf, elementOf, isDynamic, isNullable, isNumeric, isPrim, nonNull, nullableOf,
  bind, classValueOf, eraseParams, memberTypeIn, stdClassOf, type MethodType, numberLiteralType, sameType, type ShapeMember, type ShapeType, subst, superclasses,
  supertypeArgs, T, type Type, type TypeParamInfo, typeToString, unify,
  requiredParams, literalType, literalOf, widen, unionOf, membersOf, valueFits, type UnionType, tupleOf, tupleElements, nullSafety,
} from "./types.ts";

/** A class known to the project. */
export interface ClassInfo {
  /** How messages and hovers name it when that isn't `decl.name`: a namespace's type, `JSZip.JSZipObject`. */
  displayName?: string;
  /** A JavaScript class whose constructor value is an instance too (JSZip): instance members work through the class name. */
  selfInstance?: boolean;
  decl: A.ClassDecl;
  file: A.XenonFile;
  /** Dotted package name ('' for the top level). */
  pkg: string;
  /** Fully qualified name, e.g. `com.zoo.Dog`. */
  qname: string;
  /** Public class of its file (has its own module) or a file-private helper. */
  filePrivate: boolean;
  /** Output module path relative to the out dir, e.g. `com/zoo/Dog.js`. */
  module: string;
  /** Xenon superclass, once resolved. */
  parent?: ClassInfo;
  /** The class extends a JavaScript class: inherited members are unknown (`*`). */
  jsParent?: boolean;
  /** Directly implemented interfaces (for an interface: the interfaces it extends). */
  interfaces: ClassInfo[];
  /** `class Box<T>`: the class's type parameters. */
  typeParams: TypeParamInfo[];
  /** Type arguments passed to the parent (`extends Box<int>`), in terms of `typeParams`. */
  parentArgs: Type[];
  /** Type arguments passed to each interface, aligned with `interfaces`. */
  interfaceArgs: Type[][];
  /** Declared members by name (filled by the checker). */
  members: Map<string, MemberSig>;
  ctor?: { decl: A.Method; type: MethodType };
  /** Own destructor `~Name()`. */
  dtor?: { decl: A.Method; async: boolean };
  /** For enums: member values in declaration order. */
  enumValues?: Map<string, ConstValue>;
  /** Native classes: further constructor signatures (overloads) after `ctor`. */
  ctorOverloads?: { decl: A.Method; type: MethodType }[];
}

/** A `native` class describes an existing JS class: no code, no imports. */
export function isNative(info: ClassInfo): boolean {
  return !!info.decl.modifiers.native;
}

/** The JS name a class is referenced by (`native('Number') class Float` → `Number`). */
export function jsNameOf(info: ClassInfo): string {
  return info.decl.modifiers.nativeName ?? info.decl.name.name;
}

/** A `typedef` known to the project. Its target is resolved lazily (and cached in `state`). */
export interface TypedefInfo {
  /** How messages and hovers name it when that isn't `decl.name`: a namespace's type, `JSZip.JSZipObject`. */
  displayName?: string;
  decl: A.TypedefDecl;
  file: A.XenonFile;
  pkg: string;
  qname: string;
  filePrivate: boolean;
  /** `typedef Pair<A, B>`: the target is resolved once with these, then substituted per use. */
  params: TypeParamInfo[];
  state?: "busy" | Type;
}

/** Type parameters visible while resolving a type annotation, by name. */
export type TypeParamScope = Map<string, TypeParamInfo>;

export function paramScope(...lists: (TypeParamInfo[] | undefined)[]): TypeParamScope {
  const m: TypeParamScope = new Map();
  for (const l of lists) for (const p of l ?? []) m.set(p.name, p);
  return m;
}

/** `Box<T>` inside the class itself: its own parameters as arguments. */
export function ownType(info: ClassInfo): Type {
  return { kind: "class", info, args: info.typeParams.map((param) => ({ kind: "typeParam", param })) };
}

export interface MemberSig {
  name: string;
  owner: ClassInfo;
  decl: A.Field | A.Method;
  isStatic: boolean;
  kind: "field" | "method" | "accessor";
  /** Field type, method type, or accessor (getter, else setter) value type. */
  type: Type;
  /** Span of the declared type annotation, used as the origin of expected types. */
  typeSpan?: Span;
  /** The other half of a getter/setter pair. */
  decl2?: A.Method;
  /** An overriding accessor that lacks the other half of its parent's pair: codegen delegates it to `super`. */
  delegate?: "get" | "set";
  /** Native classes only: all signatures of an overloaded method (the first is `type`). */
  overloads?: { decl: A.Method; type: MethodType }[];
  readonly?: "const" | "final" | "getter";
}

/** How `x is T` / `x as T` is tested at runtime (all plain JS, no helpers). */
export type RuntimeCheck =
  | { kind: "class"; info: ClassInfo } // x instanceof Dog
  | { kind: "interface"; info: ClassInfo } // x?.[IShape] === true
  | { kind: "enum"; info: ClassInfo } // Object.values(Direction).includes(x)
  | { kind: "js"; name: string } // x instanceof Response (JS import or global)
  | { kind: "typeof"; tag: "string" | "number" | "boolean" | "function" }
  | { kind: "iterable" } // typeof x?.[Symbol.iterator] === 'function': `is Iterable` (arrays, strings, … have no marker)
  | { kind: "int" } // Number.isInteger(x)
  | { kind: "uint" } // Number.isInteger(x) && x >= 0
  | { kind: "array" } // Array.isArray(x)
  | { kind: "object" }; // x != null

/** What an identifier expression refers to. */
export type Resolution =
  /** `decl`: the local's name where it is declared (for go-to-definition). */
  | { kind: "local"; decl: Span }
  | { kind: "member"; isStatic: boolean; owner: ClassInfo }
  | { kind: "class"; info: ClassInfo }
  | { kind: "jsImport" }
  | { kind: "global" }
  /** A standard library function declared at package level (`setTimeout`); emitted by its JS name. */
  | { kind: "function"; decl: A.Method }
  | { kind: "builtin"; name: BuiltinFn };

type BuiltinFn = "trace" | "Int" | "UInt" | "Float" | "String" | "Bool";
/** `trace` and the conversions, by every spelling (`int(x)` is `Int(x)`), to their canonical name. */
const BUILTIN_FN_NAMES: Record<string, BuiltinFn> = { trace: "trace", Int: "Int", UInt: "UInt", Float: "Float", String: "String", Bool: "Bool", int: "Int", uint: "UInt", Boolean: "Bool" };
const BUILTIN_FNS = new Set<string>(Object.keys(BUILTIN_FN_NAMES));
const CASTS: Record<string, Type> = { Int: T.int, UInt: T.uint, Float: T.Float, String: T.String, Bool: T.Boolean };

export interface CheckResult {
  /**
   * Per file, the types its JavaScript imports provide, for completion: a namespace's exports
   * (`xlsx.WorkBook`, `JSZip.JSZipObject`) and imported classes themselves (`JSZip`).
   */
  qualifiedTypes: Map<A.XenonFile, Map<string, ClassInfo | TypedefInfo>>;
  resolutions: Map<A.Expr | A.ObjectProp, Resolution>;
  /** Class referenced by a type node (`new X`, `extends X`, annotations). */
  typeResolutions: Map<A.TypeNode, ClassInfo>;
  /** The resolved type of every type annotation (for the TypeScript output). */
  typeNodeTypes: Map<A.TypeNode, Type>;
  /** Static type of every checked expression. */
  exprTypes: Map<A.Expr, Type>;
  /** References to `inline` constants and their folded values (pasted by codegen). */
  inlineValues: Map<A.Expr, ConstValue>;
  /** Folded values of `inline` fields. */
  inlineFields: Map<A.Field, ConstValue>;
  /** Runtime test of every `is`/`as` expression. */
  typeChecks: Map<A.Expr, RuntimeCheck>;
  /** Instance methods used as values (not called): codegen binds them to their object, cached per instance. */
  methodClosures: Set<A.Expr>;
  /** `a + b` / `a -= b` & co. that call `a['operator+'](b)`, and `a == b` / `a != b` that call `operator==` (the operator is the node's). */
  operatorCalls: Set<A.Expr>;
  /** `x.getEnumerator` resolving to `Iterable`'s declaration (x may be built-in): compiled to `Enumerable.enumerate(x)`. */
  enumerateCalls: Set<A.Expr>;
  /**
   * Calls of standard-library members typed differently from TypeScript's (`p.catch(log)` is a
   * `Promise<T?>` here, a `Promise<T | void>` there): the TypeScript output casts their result.
   */
  tsResultCasts: Set<A.Expr>;
  /**
   * Calls of overloaded methods and functions, keyed by the callee: every overload as seen on this
   * receiver (`all`), and the one the call chose with its type as called (`chosen`; none if no
   * overload fits). For hovers and signature help.
   */
  overloadPicks: Map<A.Expr, { all: { decl: A.Method; type: MethodType }[]; chosen?: { decl: A.Method; type: MethodType } }>;
  classes: Map<string, ClassInfo>;
  /** Every typedef by qualified name (for completion). */
  typedefs: Map<string, TypedefInfo>;
  /** The type of each name a destructuring pattern or an unannotated callback parameter declares (`var [key, value] = entry`, `e => …`), for hover. */
  bindingTypes: Map<A.Ident, Type>;
  /** Names of JavaScript imports that are TypeScript interfaces or type aliases (no value at run time: not imported by the JavaScript). */
  typeOnlyImports: Set<A.Ident>;
  /** The type each value was checked against (arguments, initializers, return values, assignments). */
  expectedTypes: Map<A.Expr, Type>;
  /** Locals owning a scoped value, by declared name: destroyed at the end of their block (src/scoped.ts). */
  scopedLocals: Map<A.Ident, ScopedOwner>;
  /** Scoped values created by a statement without being bound: destroyed at the end of the statement. */
  scopedTemps: Map<A.Expr, ScopedOwner>;
  /** `return r` statements handing an owned local on to the caller (it isn't destroyed here). */
  scopedReturns: Set<A.Stmt>;
  /**
   * Attributes created at run time, per declaration: the `new` expression creating each (checked
   * like one) and its named values. Compile-time attributes (`Usage`, `Deprecated`) aren't here.
   */
  attributes: Map<A.ClassDecl | A.Method | A.Field, { node: A.Attribute; create: A.Expr & { kind: "New" } }[]>;
}

/** How a scoped value is destroyed: awaited for an async destructor; `handedOff` when some `return` passes it on. */
export interface ScopedOwner {
  async: boolean;
  handedOff?: boolean;
}

/** A value type, which can't be `null` without `?` even when null safety is off (`int`, `Boolean`, …). */
function isLegacyValueType(t: Type): boolean {
  return (t.kind === "prim" && t.name !== "String") || t.kind === "typeParam" || t.kind === "void";
}

/** X0521's note and fix: `inline var` becomes `inline final` (the `var` right before the name). */
function inlineVar(d: DiagnosticBuilder, name: A.Ident) {
  d.note("an inline constant's value can never change");
  const text = name.span.file.text;
  const kw = text.lastIndexOf("var", name.span.start);
  if (kw >= 0 && text.slice(kw + 3, name.span.start).trim() === "") {
    d.help("declare it `inline final`", [{ span: span(name.span.file, kw, kw + 3), text: "final" }]);
  }
}

/** `void`, or its alias `Void`, as written (the alias can't be redeclared: X0028). */
function isVoidNode(t: A.TypeNode | undefined): boolean {
  return t?.kind === "VoidType" || (t?.kind === "TypeName" && t.name.length === 1 && t.name[0]!.name === "Void" && t.args.length === 0);
}

/**
 * A method (or a native getter) declared `constexpr`: with a body, or in the standard library,
 * where the JavaScript built-in runs. `decl`: the overload a call uses (natives only have overloads).
 */
function isConstexpr(m: MemberSig, decl?: A.Method): boolean {
  const d = decl ?? (m.kind === "accessor" ? accessorHalf(m, "get") : m.kind === "method" ? m.decl : undefined);
  return d?.kind === "Method" && !!d.modifiers.constexpr && (!!d.body || isNative(m.owner));
}

/**
 * The overload of a native `m` a constant call with `argc` arguments runs: the one the checker
 * chose, else the first `constexpr` one that takes that many (constants are never functions, so
 * `replace(pattern, replacer:Function)` can't be the one meant).
 */
function constexprOverload(m: MemberSig, chosen: A.Method | undefined, argc: number): A.Method | undefined {
  if (chosen) return isConstexpr(m, chosen) ? chosen : undefined;
  const forms = m.overloads?.map((o) => o.decl) ?? (m.decl.kind === "Method" ? [m.decl] : []);
  return forms.find((d) => isConstexpr(m, d) && (d.params.some((p) => p.rest) || (argc <= d.params.length && argc >= d.params.filter((p) => !p.init).length)));
}

/** The value a field gets without an initializer: `0`, `NaN`, `false` or `null`. */
function defaultValueOf(type: A.TypeNode | undefined): ConstValue {
  const name = type?.kind === "TypeName" && type.name.length === 1 ? type.name[0]!.name : undefined;
  if (name === "int" || name === "uint" || name === "Int" || name === "UInt") return 0;
  if (name === "Float") return NaN;
  if (name === "Boolean" || name === "Bool") return false;
  return null;
}

/** May a setter with visibility `set` pair with a getter with `get`? Only if it is as visible or less. */
function setterFits(get: string, set: string): boolean {
  return set === get || set === "private" || get === "public";
}

/** The getter or setter of an accessor member. */
export function accessorHalf(m: MemberSig, which: "get" | "set"): A.Method | undefined {
  return [m.decl, m.decl2].find((d): d is A.Method => d?.kind === "Method" && d.accessor === which);
}

/** The declaration whose visibility governs reading `m`: an accessor's getter (else its setter), any other member itself. */
export function readDecl(m: MemberSig): A.Field | A.Method {
  return m.kind === "accessor" ? accessorHalf(m, "get") ?? m.decl : m.decl;
}

/** The operators a class can define with `operator<op>` methods. */
const OVERLOADABLE = new Set(["+", "-", "*", "/"]);

const TS_UNDICI_CLASSES = new Set(["Response", "FormData"]);

/**
 * A standard-library result TypeScript types differently: a nullable type inside a type argument
 * (`Promise<T?>`, where TypeScript's `T | undefined` doesn't stand in for it), or a `Response` or
 * `FormData` (with Node's types next to Bun's, `res.clone()` and `res.formData()` give undici's
 * classes, not the global ones), or a `*` inside a type argument (TypeScript's `unknown` there).
 */
function tsDivergent(node: A.TypeNode | undefined, inArgs = false): boolean {
  if (!node) return false;
  if (node.kind === "NullableType") return inArgs || tsDivergent(node.inner, inArgs);
  // `Array<Array<*>>` (`Object.entries`): TypeScript's is `[string, unknown][]`, whose values allow nothing.
  if (node.kind === "AnyType") return inArgs;
  if (node.kind !== "TypeName") return false;
  return (node.name.length === 1 && TS_UNDICI_CLASSES.has(node.name[0]!.name)) || node.args.some((a) => tsDivergent(a, true));
}

/** Names visible inside one file. */
interface FileScope {
  file: A.XenonFile;
  /** Classes by simple name: own package, file-private classes and imports. */
  classes: Map<string, ClassInfo>;
  /** Names offered by several wildcard imports (and those imports); an error only when used. */
  ambiguous: Map<string, { infos: ClassInfo[]; imports: A.Import[] }>;
  jsImports: Set<string>;
  /** JavaScript imports typed as a static of a generated declaration (functions and values). */
  jsMembers: Map<string, { info: ClassInfo; member: string }>;
  /** Typedefs by simple name: own package, file-private and imported. */
  typedefs: Map<string, TypedefInfo>;
  /** The import that provides a name (for unused-import warnings). */
  importOf: Map<string, A.Import>;
  used: Set<A.Import>;
}

type DAState = "no" | "yes" | "maybe";

interface Local {
  type: Type;
  writes?: { at: number; deferred: boolean }[];
  captureUnstable?: boolean;
  /** Read at least once (for the unused-variable warning). */
  used?: boolean;
  /** Folded value of an `inline` local constant. */
  inline?: ConstValue;
  kind: "var" | "const" | "final" | "param" | "range";
  nameSpan: Span;
  typeSpan?: Span;
}

/** A local known to have a narrower type: non-null (`x != null`), or a union member (`x is String`, `x == 'utf8'`). */
interface Fact {
  local: Local;
  type: Type;
}

/** Facts of a condition: what is known about locals when it is true / when it is false. */
interface Facts {
  whenTrue: Fact[];
  whenFalse: Fact[];
}
const NO_FACTS: Facts = { whenTrue: [], whenFalse: [] };

class Scope {
  private locals = new Map<string, Local>();
  /** Locals narrowed in this scope (`if (x != null) { … }`, `if (x is String) { … }`); `undefined` cancels an outer one. */
  private narrowed?: Map<Local, Type | undefined>;
  /** A function expression's scope: later writes outside it invalidate narrowing carried across it. */
  boundaryAt?: number;
  constructor(
    readonly parent?: Scope,
    private functionWrites: Map<string, { at: number; deferred: boolean }[]> =
      parent?.functionWrites ?? new Map<string, { at: number; deferred: boolean }[]>(),
  ) {}

  /** A child scope in which these facts hold (later ones win: they were found knowing the earlier). */
  withFacts(facts: Fact[]): Scope {
    if (facts.length === 0) return this;
    const s = new Scope(this);
    for (const f of facts) s.narrow(f);
    return s;
  }
  narrow(fact: Fact) {
    (this.narrowed ??= new Map()).set(fact.local, fact.type);
  }
  /** The variable was assigned a value that may be null: drop narrowing up to where it was declared. */
  unnarrow(local: Local) {
    for (let s: Scope | undefined = this; s; s = s.parent) {
      if (s.narrowed?.has(local)) s.narrowed.set(local, undefined);
      if (s.owns(local)) return;
    }
  }
  /** The local's type here: narrowed to non-null if a check says so. `blocked`: a check exists outside a function boundary. */
  typeOf(local: Local): { type: Type; blocked: boolean } {
    let crossedAt: number | undefined;
    for (let s: Scope | undefined = this; s; s = s.parent) {
      if (s.narrowed?.has(local)) {
        const narrowed = s.narrowed.get(local);
        const changed = local.captureUnstable || local.writes?.some((write) =>
          write.deferred || (crossedAt !== undefined && write.at > crossedAt));
        if (narrowed && crossedAt !== undefined && local.kind !== "final" && local.kind !== "const" && changed) {
          return { type: local.type, blocked: true };
        }
        return { type: narrowed ?? local.type, blocked: false };
      }
      if (s.owns(local)) break;
      if (s.boundaryAt !== undefined) crossedAt = crossedAt === undefined ? s.boundaryAt : Math.min(crossedAt, s.boundaryAt);
    }
    return { type: local.type, blocked: false };
  }
  declare(name: string, local: Local) {
    local.writes = this.functionWrites.get(name);
    this.locals.set(name, local);
  }
  private owns(local: Local): boolean {
    for (const l of this.locals.values()) if (l === local) return true;
    return false;
  }
  get(name: string): Local | undefined {
    return this.locals.get(name) ?? this.parent?.get(name);
  }
  getOwn(name: string): Local | undefined {
    return this.locals.get(name);
  }
  names(): string[] {
    return [...this.locals.keys(), ...(this.parent?.names() ?? [])];
  }
}

/* ===================================================================== */

/**
 * `jsBindings`: JavaScript imports typed by generated declarations (src/dts.ts), by importing file
 * path and local name; other JavaScript imports are `*`.
 */
export function check(files: A.XenonFile[], classes: Map<string, ClassInfo>, typedefs: Map<string, TypedefInfo>, diags: DiagnosticBag, jsBindings?: Map<string, Map<string, JsBinding>>): CheckResult {
  const result: CheckResult = {
    qualifiedTypes: new Map(), resolutions: new Map(), typeResolutions: new Map(), typeNodeTypes: new Map(), exprTypes: new Map(), inlineValues: new Map(), inlineFields: new Map(), typeChecks: new Map(), methodClosures: new Set(), operatorCalls: new Set(), enumerateCalls: new Set(), tsResultCasts: new Set(), overloadPicks: new Map(), classes, typedefs, bindingTypes: new Map(), typeOnlyImports: new Set(),
    expectedTypes: new Map(), scopedLocals: new Map(), scopedTemps: new Map(), scopedReturns: new Set(), attributes: new Map(),
  };
  const env = new Env(classes, typedefs, diags, result);
  env.jsBindings = jsBindings;
  for (const file of jsBindings?.values() ?? []) {
    for (const b of file.values()) {
      const info = b.kind === "class" && b.selfInstance ? classes.get(b.qname) : undefined;
      if (info) info.selfInstance = true;
    }
  }

  const scopes = env.scopes;
  for (const file of files) scopes.set(file, env.fileScope(file));
  for (const [file, scope] of scopes) {
    const qualified: [string, ClassInfo | TypedefInfo][] = [...scope.classes, ...scope.typedefs]
      .filter(([name, t]) => name.includes(".") || t.file.file.generated);
    if (qualified.length > 0) result.qualifiedTypes.set(file, new Map(qualified));
  }

  const infos = [...classes.values()];
  for (const info of infos) env.resolveParent(info, scopes.get(info.file)!);
  for (const info of infos) env.checkHierarchy(info);
  for (const info of infos) env.collectMembers(info, scopes.get(info.file)!);
  for (const info of infos) env.constexprClass(info);
  for (const info of infos) env.wireDestructors(info);
  for (const info of infos) if (info.decl.isEnum) env.computeEnum(info);
  for (const td of typedefs.values()) env.resolveTypedef(td);
  for (const file of files) env.collectFunctions(file, scopes.get(file)!);
  for (let i = 0; i < env.pendingShapeMembers.length; i++) env.pendingShapeMembers[i]!.type();
  for (const info of infos) env.checkOverrides(info);
  for (const info of infos) env.checkImplements(info);
  for (const info of infos) env.checkAbstractImplemented(info);
  for (const info of infos) if (!info.decl.isInterface && !info.decl.isEnum && !isNative(info)) new BodyChecker(env, info, scopes.get(info.file)!).run();
  checkScoped(files, result, diags);
  checkDeprecated(files, result, diags);
  for (const scope of scopes.values()) env.reportUnusedImports(scope);
  for (const info of infos) env.reportUnusedPrivates(info);

  return result;
}

/** Project-wide state shared by the phases. */
class Env {
  readonly scopes = new Map<A.XenonFile, FileScope>();
  /** Typed JavaScript imports (see `check`). */
  jsBindings?: Map<string, Map<string, JsBinding>>;
  /** Shape members whose types are resolved after all signatures (reports errors inside shapes). */
  readonly pendingShapeMembers: ShapeMember[] = [];
  /** Members referenced anywhere (for the unused-private-member warning). */
  readonly usedMembers = new Set<MemberSig>();
  /** Files with syntax errors (unused-code warnings are skipped there). */
  readonly syntaxErrors: Set<SourceFile>;
  /** The standard library's package-level functions by name; several entries are overloads. */
  readonly functions = new Map<string, { decl: A.Method; type: MethodType }[]>();

  /** Signatures of a prelude file's `native function`s (user files can't declare any: X0029). */
  collectFunctions(file: A.XenonFile, scope: FileScope) {
    if (!file.file.prelude) return;
    for (const m of file.functions) {
      const tparams = paramScope(this.typeParamsOf(m));
      const ret = m.returnType ? this.resolveType(m.returnType, scope, true, tparams) : T.void;
      const list = this.functions.get(m.name.name) ?? [];
      list.push({ decl: m, type: this.methodType(m, scope, ret, tparams) });
      this.functions.set(m.name.name, list);
    }
  }

  /** X0862: private members that nothing refers to. */
  reportUnusedPrivates(info: ClassInfo) {
    if (info.file.file.prelude || isNative(info) || info.decl.isInterface || info.decl.isEnum || this.syntaxErrors.has(info.file.file)) return;
    for (const m of info.members.values()) {
      if (m.owner !== info || this.usedMembers.has(m) || visibilityOf(m.decl) !== "private") continue;
      if (m.decl.kind === "Method" && (m.decl.isConstructor || m.decl.isDestructor || m.decl.name.name.startsWith("operator"))) continue;
      const what = m.kind === "field" ? "field" : m.kind === "accessor" ? "property" : "method";
      this.diags.warning("X0862", `private ${what} \`${m.name}\` is never used`, m.decl.name.span, "declared here")
        .help("remove it, or use it");
    }
  }
  private inlineState = new Map<MemberSig, "busy" | Fold>();

  constructor(
    readonly classes: Map<string, ClassInfo>,
    readonly typedefs: Map<string, TypedefInfo>,
    readonly diags: DiagnosticBag,
    readonly result: CheckResult,
  ) {
    // `Array<int>` and `String` fit interfaces their std classes implement (`Iterable<T>`).
    stdClassOf.fn = (t) => {
      if (t.kind === "builtin" && (t.name === "Array" || t.name === "Tuple") && this.arrayClass) return { kind: "class", info: this.arrayClass, args: [elementOf(t)!] };
      if (t.kind === "prim") {
        const info = this.primClass(t.name);
        if (info) return { kind: "class", info };
      }
      return undefined;
    };
    this.syntaxErrors = new Set(diags.items.filter((d) => d.severity === "error" && /^X0[01]\d\d$/.test(d.code ?? "") && d.code !== "X0001")
      .flatMap((d) => d.labels.map((l) => l.span.file)));
  }

  fileScope(file: A.XenonFile): FileScope {
    const pkg = file.packageName.map((n) => n.name).join(".");
    const scope: FileScope = { file, classes: new Map(), ambiguous: new Map(), jsImports: new Set(), jsMembers: new Map(), typedefs: new Map(), importOf: new Map(), used: new Set() };
    for (const td of this.typedefs.values()) {
      if (td.pkg === pkg && (!td.filePrivate || td.file === file)) scope.typedefs.set(td.decl.name.name, td);
    }
    /** Where each name came from, for clash messages. */
    const origin = new Map<string, { kind: "package" | "private" | "import"; span: Span }>();

    // 1. Own package and file-private classes.
    for (const info of this.classes.values()) {
      if (info.pkg !== pkg || info.filePrivate) continue;
      scope.classes.set(info.decl.name.name, info);
      origin.set(info.decl.name.name, { kind: "package", span: info.decl.name.span });
    }
    for (const info of this.classes.values()) {
      if (!info.filePrivate || info.file !== file) continue;
      const name = info.decl.name.name;
      const prev = origin.get(name);
      if (prev) {
        this.diags.error("X0434", `file-private class \`${name}\` has the same name as a class in this package`, info.decl.name.span)
          .secondary(prev.span, "the other class");
      }
      scope.classes.set(name, info);
      origin.set(name, { kind: "private", span: info.decl.name.span });
    }

    const clash = (name: string, at: Span) => {
      const prev = origin.get(name);
      if (!prev || prev.kind === "package") return false; // an explicit import shadows a same-package class
      this.diags.error("X0432", `\`${name}\` is imported more than once`, at, "this import")
        .secondary(prev.span, prev.kind === "private" ? "a file-private class has this name" : "already imported here")
        .help("import one of them under another name, or use a qualified name");
      return true;
    };

    // 2. Explicit imports: Xenon classes and JS bindings.
    const wildcards: A.XenonImport[] = [];
    for (const imp of file.imports) {
      if (imp.kind === "JsImport") {
        for (const n of [imp.defaultName, imp.namespace, ...imp.named.map((x) => x.alias ?? x.name)]) {
          if (!n) continue;
          if (clash(n.name, n.span)) {
            scope.used.add(imp); // already reported
            continue;
          }
          scope.classes.delete(n.name);
          scope.importOf.set(n.name, imp);
          origin.set(n.name, { kind: "import", span: n.span });
          // Typed from a `.d.ts`: a class (or module namespace) is a native class under this name.
          const bindings = this.jsBindings?.get(file.file.path);
          const typed = bindings?.get(n.name);
          const info = typed && typed.kind !== "type" ? this.classes.get(typed.qname) : undefined;
          if (typed && typed.kind !== "member" && typed.typeOnly) this.result.typeOnlyImports.add(n);
          // A namespace's exported types, named `Ns.Type` (a native class or a typedef).
          for (const [key, b] of bindings ?? []) {
            if (!key.startsWith(`${n.name}.`)) continue;
            const cls = b.kind === "class" ? this.classes.get(b.qname) : undefined;
            const td = b.kind === "typedef" ? this.typedefs.get(b.qname) : undefined;
            if (cls) scope.classes.set(key, cls);
            if (td) scope.typedefs.set(key, td);
            // Generated for this file alone: shown under the name it's written with.
            if (cls) cls.displayName ??= key;
            if (td) td.displayName ??= key;
            if (cls || td) scope.importOf.set(key, imp);
          }
          if (typed?.kind === "class" && info) {
            scope.classes.set(n.name, info);
            continue;
          }
          // An imported TypeScript interface or type alias that is a shape (no value at run time).
          const shape = typed?.kind === "typedef" ? this.typedefs.get(typed.qname) : undefined;
          if (shape) {
            scope.typedefs.set(n.name, shape);
            continue;
          }
          scope.jsImports.add(n.name);
          if (typed?.kind === "member" && info) scope.jsMembers.set(n.name, { info, member: typed.member });
        }
        continue;
      }
      if (imp.wildcard) {
        wildcards.push(imp);
        continue;
      }
      const path = imp.path.map((p) => p.name).join(".");
      const at = cover(imp.path[0]!.span, imp.path.at(-1)!.span);
      const td = this.typedefs.get(path);
      if (td && !td.filePrivate && !this.classes.has(path)) {
        if (td.pkg !== pkg && visibilityOf(td.decl) !== "public") {
          scope.used.add(imp);
          this.diags.error("X0441", `typedef \`${td.qname}\` is internal to package \`${td.pkg}\``, at, "not visible here")
            .secondary(td.decl.name.span, "declared without `public`");
          continue;
        }
        scope.typedefs.set(td.decl.name.name, td);
        scope.importOf.set(td.decl.name.name, imp);
        continue;
      }
      const info = this.classes.get(path);
      if (!info || info.filePrivate) {
        scope.used.add(imp); // reported here; no "unused" warning on top
        const hidden = [...this.classes.values()].find((c) => c.filePrivate && c.pkg === path.split(".").slice(0, -1).join(".") && c.decl.name.name === imp.path.at(-1)!.name);
        if (hidden) {
          this.diags.error("X0435", `\`${hidden.decl.name.name}\` is file-private and can't be imported`, at)
            .secondary(hidden.decl.name.span, "declared after the package block, so only its own file can use it");
          continue;
        }
        const names = [...this.classes.values()].filter((c) => !c.filePrivate).map((c) => c.qname);
        const d = this.diags.error("X0431", `cannot find class \`${path}\``, at, "not found");
        const sug = suggest(path, names);
        if (sug) d.help(`a class with a similar name exists: \`${sug}\``, [{ span: at, text: sug }]);
        continue;
      }
      const name = info.decl.name.name;
      if (scope.classes.get(name) === info && origin.get(name)?.kind === "import") {
        this.diags.warning("X0871", `\`${path}\` is imported twice`, imp.span).secondary(origin.get(name)!.span, "first imported here");
        scope.used.add(imp);
        continue;
      }
      if (!classAccessible(info, pkg)) {
        scope.used.add(imp);
        this.classAccessError(info, at);
        continue;
      }
      if (info.pkg === pkg) {
        this.diags.warning("X0872", `\`${name}\` is in this package and needs no import`, imp.span);
        scope.used.add(imp);
        continue;
      }
      if (clash(name, at)) {
        scope.used.add(imp);
        continue;
      }
      scope.classes.set(name, info);
      scope.importOf.set(name, imp);
      origin.set(name, { kind: "import", span: at });
    }

    // 3. Wildcard imports: lowest priority; names offered twice become ambiguous.
    const fromWildcard = new Map<string, ClassInfo>();
    for (const imp of wildcards) {
      const path = imp.path.map((p) => p.name).join(".");
      const found = [...this.classes.values()].filter((c) => c.pkg === path && !c.filePrivate);
      const foundTypedefs = [...this.typedefs.values()].filter((t) => t.pkg === path && !t.filePrivate && (t.pkg === pkg || visibilityOf(t.decl) === "public"));
      for (const td of foundTypedefs) {
        if (scope.typedefs.has(td.decl.name.name)) continue;
        scope.typedefs.set(td.decl.name.name, td);
        scope.importOf.set(td.decl.name.name, imp);
      }
      if (found.length === 0 && foundTypedefs.length > 0) continue;
      if (found.length === 0) {
        scope.used.add(imp);
        const d = this.diags.error("X0430", `package \`${path}\` not found`, cover(imp.path[0]!.span, imp.path.at(-1)!.span));
        const pkgs = [...new Set([...this.classes.values()].map((c) => c.pkg).filter((p) => p !== ""))];
        const sug = suggest(path, pkgs);
        if (sug) d.help(`a package with a similar name exists: \`${sug}\``);
        continue;
      }
      if (path === pkg) {
        this.diags.warning("X0872", `package \`${path}\` is this file's own package and needs no import`, imp.span);
        scope.used.add(imp);
        continue;
      }
      for (const info of found) {
        const name = info.decl.name.name;
        if (origin.has(name) || scope.jsImports.has(name) || !classAccessible(info, pkg)) continue;
        const other = fromWildcard.get(name);
        if (other && other !== info) {
          const entry = scope.ambiguous.get(name) ?? { infos: [other], imports: [scope.importOf.get(name)!] };
          entry.infos.push(info);
          entry.imports.push(imp);
          scope.ambiguous.set(name, entry);
          continue;
        }
        fromWildcard.set(name, info);
        scope.classes.set(name, info);
        scope.importOf.set(name, imp);
      }
    }
    for (const name of scope.ambiguous.keys()) scope.classes.delete(name);

    // 4. The prelude (`Exception` & co.) is visible everywhere without an import.
    for (const info of this.classes.values()) {
      if (info.file.file.prelude && !info.filePrivate && !scope.classes.has(info.decl.name.name)) scope.classes.set(info.decl.name.name, info);
    }
    for (const td of this.typedefs.values()) {
      if (td.file.file.prelude && !td.filePrivate && !scope.typedefs.has(td.decl.name.name)) scope.typedefs.set(td.decl.name.name, td);
    }
    return scope;
  }

  classAccessError(info: ClassInfo, at: Span) {
    const vis = info.decl.modifiers.visibility;
    this.diags.error("X0441", `class \`${info.qname}\` is ${VIS_DESCRIPTION.internal(info)}`, at, "not visible here")
      .secondary(info.decl.name.span, "declared without `public`")
      .help("make the class `public` to use it from other packages", vis ? undefined : [
        { span: span(info.decl.span.file, info.decl.span.start, info.decl.span.start), text: "public " },
      ]);
  }

  /** Reports a member (or constructor) that isn't visible from class `from`. Returns false if not accessible. */
  checkAccess(d: A.Field | A.Method, owner: ClassInfo, from: ClassInfo, at: Span, what?: string): boolean {
    const vis = visibilityOf(d);
    if (canAccess(vis, owner, from)) return true;
    const name = what ?? `\`${d.name.name}\``;
    const label = vis === "private" ? "private member" : vis === "protected" ? "protected member" : "internal member";
    const diag = this.diags.error("X0603", `${name} is ${VIS_DESCRIPTION[vis](owner)}`, at, label)
      .secondary(d.name.span, `declared \`${vis}\` here`);
    // `_name` with a public `name` accessor is the usual pattern.
    const plain = d.name.name.replace(/^_+/, "");
    const alt = plain !== d.name.name ? findMember(owner, plain) : undefined;
    if (alt && canAccess(visibilityOf(alt.decl), alt.owner, from)) {
      diag.help(`use the ${visibilityOf(alt.decl)} ${alt.kind === "accessor" ? "getter" : alt.kind} \`${plain}\``, [{ span: at, text: plain }]);
    }
    return false;
  }

  /** The native class describing a primitive's members (`String`, `Float`, `int`, `uint`, `Boolean`); numbers fall back to `Float`. */
  primClass(name: string): ClassInfo | undefined {
    const natives = [...this.classes.values()].filter((c) => isNative(c));
    return natives.find((c) => c.decl.name.name === name) ??
      (name === "Int" || name === "UInt" ? natives.find((c) => c.decl.name.name === "Float") : undefined);
  }


  /** The prelude's `Iterable<T>`: what `for … of` loops over. */
  get enumerable(): ClassInfo | undefined {
    return this.classes.get("xenon.Iterable");
  }

  /**
   * What `for … of` yields for a class type: the `T` of the `Iterable<T>` it implements (`Set<T>`,
   * `Iterator<T>`, `Iterable<T>` itself, or any class implementing it). Undefined if it doesn't.
   */
  iterableElement(t: Type): Type | undefined {
    const e = this.enumerable;
    if (t.kind !== "class" || !e || !isSubclass(t.info, e)) return undefined;
    return supertypeArgs(t.info, t.args ?? [], e)?.[0] ?? T.any;
  }

  /** The std library's `RegExp` (src/prelude/std/RegExp.xn): the type of `~/…/` literals. */
  get regexpClass(): ClassInfo | undefined {
    return this.classes.get("xenon.RegExp");
  }

  /**
   * An instance member every object inherits from `Object.prototype` (`toString`, `hasOwnProperty`, …),
   * declared in src/prelude/std/Object.xn: the fallback for class instances, shapes and `Object` values.
   */
  rootMember(name: string): MemberSig | undefined {
    const m = this.classes.get("xenon.Object")?.members.get(name);
    return m && !m.isStatic ? m : undefined;
  }

  /** A member of every function value (`call`, `bind`, `length`, … from src/prelude/std/Function.xn, then `Object`'s). */
  functionMember(name: string): MemberSig | undefined {
    const m = this.classes.get("xenon.Function")?.members.get(name);
    return m && !m.isStatic ? m : this.rootMember(name);
  }

  /** The element type an array must have to fit an interface the std `Array<T>` implements (`Iterable<int>` → `int`). */
  arrayElementFor(t: Type): Type | undefined {
    const array = this.arrayClass;
    if (!array || t.kind !== "class" || !t.info.decl.isInterface || !t.args?.length) return undefined;
    const param = array.typeParams[0]!;
    const seen = supertypeArgs(array, [{ kind: "typeParam", param }], t.info);
    const i = seen?.findIndex((a) => a.kind === "typeParam" && a.param === param) ?? -1;
    return i >= 0 ? t.args[i] : undefined;
  }

  /** The std library's `Array<T>` (src/prelude/std/Array.xn): the members of the built-in array type. */
  get arrayClass(): ClassInfo | undefined {
    return this.classes.get("xenon.Array");
  }

  /** The std library's `Promise<T>` (src/prelude/std/Promise.xn). */
  get promiseClass(): ClassInfo | undefined {
    return this.classes.get("xenon.Promise");
  }

  /** `Promise<T>`: the type of an `async` function's result. */
  promiseOf(arg: Type): Type {
    const info = this.promiseClass;
    return info ? { kind: "class", info, args: [arg] } : T.any;
  }

  /** The `T` of a `Promise<T>`, or undefined for other types. */
  promiseArg(t: Type): Type | undefined {
    if (t.kind === "class" && t.info === this.promiseClass) return t.args?.[0] ?? T.any;
    return undefined;
  }

  /** The prelude's `Exception` class. */
  get exception(): ClassInfo | undefined {
    return this.classes.get("xenon.Exception");
  }

  /** Looks a class name up in a file scope; marks the providing import as used. */
  lookupClass(scope: FileScope, name: string, at?: Span): ClassInfo | undefined {
    const ambiguous = scope.ambiguous.get(name);
    if (ambiguous) {
      for (const imp of ambiguous.imports) scope.used.add(imp);
      if (at) {
        this.diags.error("X0433", `\`${name}\` is ambiguous`, at, "imported by more than one wildcard import")
          .note(`it could be ${ambiguous.infos.map((c) => `\`${c.qname}\``).join(" or ")}`)
          .help(`add an explicit import, e.g. \`import ${ambiguous.infos[0]!.qname};\``);
      }
      return ambiguous.infos[0];
    }
    const info = scope.classes.get(name);
    if (info) this.markUsed(scope, name);
    return info;
  }

  /** JS globals; the prelude may additionally see the JS error classes hidden from user code. */
  isGlobal(scope: FileScope, name: string): boolean {
    return JS_GLOBALS.has(name) || TYPED_GLOBALS.has(name) || (scope.file.file.prelude && name in ERROR_HINTS);
  }

  /** The concrete type of a modeled JavaScript global, if one exists. */
  globalType(name: string): Type | undefined {
    const info = TYPED_GLOBALS.get(name) && this.classes.get(TYPED_GLOBALS.get(name)!);
    return info ? { kind: "class", info } : undefined;
  }

  lookupTypedef(scope: FileScope, name: string): TypedefInfo | undefined {
    const td = scope.typedefs.get(name);
    if (td) this.markUsed(scope, name);
    return td;
  }

  /** A typedef's target (transparent). Direct cycles are errors; cycles through shape members are fine. */
  resolveTypedef(td: TypedefInfo): Type {
    if (td.state === "busy") {
      this.diags.error("X0790", `typedef \`${td.decl.name.name}\` refers to itself`, td.decl.type.span)
        .note("a typedef can refer to itself only inside a shape member, e.g. `{ value:int, ?next:Node }`");
      td.state = T.error;
      return T.error;
    }
    if (td.state) return td.state;
    td.state = "busy";
    // Only the prelude may alias `void` (`typedef Void = void`); uses are checked in `resolveType`.
    let t = this.resolveType(td.decl.type, this.scopes.get(td.file)!, td.file.file.prelude, paramScope(td.params));
    if (td.state !== "busy") return td.state; // a cycle was reported while resolving
    const shown = td.displayName ?? td.decl.name.name;
    if (t.kind === "shape" || t.kind === "method") t = { ...t, alias: shown, typedef: td };
    else if (t.kind === "union") t = { ...t, alias: shown };
    else if (t.kind === "nullable" && t.inner.kind === "union") t = { kind: "nullable", inner: { ...t.inner, alias: shown } };
    td.state = t;
    return t;
  }

  isJsImport(scope: FileScope, name: string): boolean {
    if (!scope.jsImports.has(name)) return false;
    this.markUsed(scope, name);
    return true;
  }

  private markUsed(scope: FileScope, name: string) {
    const imp = scope.importOf.get(name);
    if (imp) scope.used.add(imp);
  }

  /** Warns about imports nothing refers to (side-effect-only JS imports are always kept). */
  reportUnusedImports(scope: FileScope) {
    for (const imp of scope.file.imports) {
      if (scope.used.has(imp)) continue;
      if (imp.kind === "JsImport" && !imp.defaultName && !imp.namespace && imp.named.length === 0) continue;
      const what = imp.kind === "JsImport" ? `\`${imp.module}\`` : `\`${imp.path.map((p) => p.name).join(".")}${imp.wildcard ? ".*" : ""}\``;
      this.diags.warning("X0870", `unused import ${what}`, imp.span, "nothing in this file uses it").help("remove the import");
    }
  }

  /** Resolves a type annotation. `allowVoid` only for return types. */
  /**
   * Resolves a type annotation. `allowVoid` only for return types; `tparams` are the type
   * parameters in scope; `allowRaw` permits a generic class without arguments (`x is Box`, `new Box(…)`).
   */
  resolveType(node: A.TypeNode, scope: FileScope, allowVoid = false, tparams?: TypeParamScope, allowRaw = false): Type {
    const t = this.resolveTypeNode(node, scope, allowVoid, tparams, allowRaw);
    if (!allowRaw && t.kind === "class" && t.info.decl.modifiers.static) {
      this.diags.error("X0415", `static class \`${t.info.decl.name.name}\` can't be used as a value type`, node.span)
        .secondary(t.info.decl.modifiers.static, "declared `static` here");
    }
    this.result.typeNodeTypes.set(node, t);
    return t;
  }

  private resolveTypeNode(node: A.TypeNode, scope: FileScope, allowVoid: boolean, tparams: TypeParamScope | undefined, allowRaw: boolean): Type {
    if (node.kind === "AnyType") return T.any;
    if (node.kind === "LiteralType") return literalType(node.value, node.float);
    if (node.kind === "NullType") {
      this.diags.error("X0798", "`null` is a type only in a union", node.span, "`null` alone")
        .help("a type that may be null is written `T?` or `T | null`");
      return T.error;
    }
    if (node.kind === "UnionType") {
      const types = node.types.map((n) => {
        if (n.kind !== "NullType") return this.resolveType(n, scope, false, tparams);
        this.result.typeNodeTypes.set(n, T.null);
        return T.null;
      });
      if (types.every((t) => t.kind === "null")) {
        this.diags.error("X0798", "`null` is a type only in a union", node.span, "only `null`");
        return T.error;
      }
      return unionOf(types);
    }
    // `int?` and `Null<int>`: the type plus `null` (types that already include `null` stay as they are).
    if (node.kind === "NullableType") return nullableOf(this.resolveType(node.inner, scope, false, tparams));
    if (node.kind === "ShapeType") {
      const members = new Map<string, ShapeMember>();
      for (const m of node.members) {
        if (members.has(m.name.name)) {
          this.diags.error("X0795", `\`${m.name.name}\` appears twice in this shape`, m.name.span);
          continue;
        }
        let cached: Type | undefined;
        const typeNode = m.type;
        const member: ShapeMember = {
          name: m.name.name, optional: m.optional, readonly: m.readonly,
          type: () => (cached ??= this.resolveType(typeNode, scope, false, tparams)),
        };
        members.set(m.name.name, member);
        // Resolved lazily (recursive shapes); `check` forces them later so errors in them surface.
        this.pendingShapeMembers.push(member);
      }
      return { kind: "shape", members };
    }
    if (node.kind === "FunctionType") {
      return {
        kind: "method",
        params: node.params.map((p) => ({ name: p.name?.name ?? "", type: this.resolveType(p.type, scope, false, tparams), optional: false, rest: p.rest })),
        ret: this.resolveType(node.ret, scope, true, tparams),
      };
    }
    if (node.kind === "VoidType") {
      if (!allowVoid) this.diags.error("X0421", "`Void` is only allowed as a return type", node.span);
      return allowVoid ? T.void : T.error;
    }
    const names = node.name.map((n) => n.name);
    const whole = cover(node.name[0]!.span, node.name.at(-1)!.span);
    // `Sheet.Book`: a type exported by a JavaScript namespace import (see `fileScope`).
    const exported = names.length > 1 && (scope.classes.has(names.join(".")) || scope.typedefs.has(names.join(".")));
    if (names.length > 1 && !exported) {
      const info = this.classes.get(names.join("."));
      if (info && !info.filePrivate) {
        if (!classAccessible(info, scope.file.packageName.map((n) => n.name).join("."))) this.classAccessError(info, whole);
        return this.genericClass(node, info, scope, tparams, allowRaw);
      }
      const d = this.diags.error("X0420", `cannot find type \`${names.join(".")}\``, whole, "not found");
      // `xlsx.Workbook`: the import is used (just misspelled), and its exports are the candidates.
      const prefix = names.slice(0, -1).join(".") + ".";
      if (scope.importOf.has(names[0]!)) this.markUsed(scope, names[0]!);
      const exports = [...scope.classes.keys(), ...scope.typedefs.keys()].filter((k) => k.startsWith(prefix));
      const s = suggest(names.join("."), exports);
      if (s) d.help(`a type with a similar name exists: \`${s}\``, [{ span: whole, text: s }]);
      return T.error;
    }
    const name = exported ? names.join(".") : names[0]!;
    const param = tparams?.get(name);
    if (param) {
      if (node.args.length > 0) this.diags.error("X0423", `type parameter \`${name}\` doesn't take type arguments`, node.span);
      return { kind: "typeParam", param };
    }
    // `Tuple<String, int>`: one type per position (unless a class of the program is named `Tuple`;
    // the standard library's `Tuple` only documents the type).
    const ownTuple = name === "Tuple" ? this.lookupClass(scope, name, whole) : undefined;
    if (name === "Tuple" && (!ownTuple || ownTuple.file.file.prelude) && !this.lookupTypedef(scope, name)) {
      if (node.args.length === 0) {
        this.diags.error("X0422", "`Tuple` needs a type argument per element: `Tuple<String, int>`", node.span);
        return T.error;
      }
      return tupleOf(node.args.map((a) => this.resolveType(a, scope, false, tparams)));
    }
    if (name === "Array" || (name === "Vector" && !this.lookupClass(scope, name, whole))) {
      if (name === "Vector") {
        this.diags.error("X0424", "`Vector` is called `Array<T>` in Xenon", node.name[0]!.span, "unknown type")
          .help("use `Array<T>`: a typed array (a bare `Array` is `Array<*>`)", [{ span: node.name[0]!.span, text: "Array" }]);
      }
      if (node.args.length > 1) {
        this.diags.error("X0422", "`Array` takes 1 type argument, the element type", node.span, `${node.args.length} given`);
        return T.error;
      }
      return arrayOf(node.args[0] ? this.resolveType(node.args[0], scope, false, tparams) : T.any);
    }
    // `Class<Dog>`: a class value holding `Dog` or a subclass (a bare `Class` holds any class).
    if (name === "Class" && node.args.length > 0) {
      if (node.args.length > 1) {
        this.diags.error("X0422", "`Class` takes 1 type argument, the class it holds", node.span, `${node.args.length} given`);
        return T.error;
      }
      const held = this.resolveType(node.args[0]!, scope, false, tparams);
      const ok = held.kind === "any" || held.kind === "typeParam" || held.kind === "error" || (held.kind === "class" && !held.info.decl.isEnum);
      if (!ok) {
        this.diags.error("X0830", `\`${typeToString(held)}\` isn't a class`, node.args[0]!.span, "`Class<…>` holds classes")
          .note("a `Class<T>` value is a class: an enum, a primitive, a typedef or a function type can't be one");
        return { kind: "builtin", name: "Class", args: [] };
      }
      return { kind: "builtin", name: "Class", args: [held] };
    }
    const builtin = BUILTIN_TYPES[name];
    if (builtin && node.args.length > 0) this.diags.error("X0423", `\`${name}\` doesn't take type arguments`, node.span);
    if (builtin) {
      if (builtin.kind === "void" && !allowVoid) {
        this.diags.error("X0421", "`Void` is only allowed as a return type", node.span);
        return T.error;
      }
      return builtin;
    }
    // The program's own declarations shadow the standard library's: a `typedef Node` beats the DOM's `Node`.
    const found = this.lookupClass(scope, name, whole);
    const ownTypedef = found?.file.file.prelude ? this.lookupTypedef(scope, name) : undefined;
    const info = ownTypedef && !ownTypedef.file.file.prelude ? undefined : found;
    if (info) return this.genericClass(node, info, scope, tparams, allowRaw);
    const td = this.lookupTypedef(scope, name);
    if (td) {
      const target = this.resolveTypedef(td);
      if (target.kind === "void" && !allowVoid) {
        this.diags.error("X0421", `\`${name}\` is only allowed as a return type`, node.span);
        return T.error;
      }
      if (!this.checkArgCount(node, td.decl.name.name, td.params.length, false)) return target;
      if (td.params.length === 0) return target;
      const args = node.args.map((a) => this.resolveType(a, scope, false, tparams));
      const t = subst(target, bind(td.params, args));
      const shown = td.displayName ?? td.decl.name.name;
      if (t.kind === "union") return { ...t, alias: shown, aliasArgs: args };
      return t.kind === "shape" || t.kind === "method" ? { ...t, alias: shown, aliasArgs: args, typedef: td } : t;
    }
    if (this.isJsImport(scope, name)) return T.any; // JS classes are dynamic until .d.ts support
    const d = this.diags.error("X0420", `cannot find type \`${name}\``, whole, "not found");
    const ownerWithParam = [...this.classes.values()].find((c) => c.file === scope.file && c.typeParams.some((p) => p.name === name) &&
      c.decl.span.start <= whole.start && whole.end <= c.decl.span.end);
    if (ownerWithParam) {
      d.note(`\`${name}\` is a type parameter of \`${ownerWithParam.decl.name.name}\`, which static members can't use (there's no instance to give it a type)`);
    } else if (name === "Number") d.help("Xenon calls floating-point numbers `Float`", [{ span: whole, text: "Float" }]);
    else if (name in ERROR_HINTS) {
      d.help(`use \`${ERROR_HINTS[name]}\` (JavaScript error classes are hidden in Xenon)`, [{ span: whole, text: ERROR_HINTS[name]! }]);
    } else {
      // `JSZipObject` for a type of an imported namespace: it's named `JSZip.JSZipObject`.
      const qualified = [...scope.classes.keys(), ...scope.typedefs.keys()].find((k) => k.endsWith(`.${name}`));
      const s = suggest(name, [...Object.keys(BUILTIN_TYPES), ...scope.classes.keys(), ...scope.typedefs.keys()]);
      if (qualified) d.help(`it belongs to the import \`${qualified.slice(0, -name.length - 1)}\`: \`${qualified}\``, [{ span: whole, text: qualified }]);
      else if (s) d.help(`a type with a similar name exists: \`${s}\``, [{ span: whole, text: s }]);
      else this.missingImportHint(d, name);
    }
    return T.error;
  }

  private classType(node: A.TypeNode, info: ClassInfo, args?: Type[]): Type {
    this.result.typeResolutions.set(node, info);
    return args?.length ? { kind: "class", info, args } : { kind: "class", info };
  }

  /** `Box<int>`: checks the argument count and resolves the arguments. */
  private genericClass(node: A.TypeNode & { kind: "TypeName" }, info: ClassInfo, scope: FileScope, tparams: TypeParamScope | undefined, allowRaw: boolean): Type {
    if (info.typeParams.length > 0 && node.args.length === 0 && allowRaw) return this.classType(node, info);
    if (!this.checkArgCount(node, info.decl.name.name, info.typeParams.length, true)) return this.classType(node, info);
    // `Promise<void>` (an async function without a result) is the one place `void` is a type argument.
    const allowVoid = info === this.promiseClass;
    return this.classType(node, info, node.args.map((a) => this.resolveType(a, scope, allowVoid, tparams)));
  }

  /** X0422/X0423: the number of type arguments must match the declaration. */
  private checkArgCount(node: A.TypeNode & { kind: "TypeName" }, name: string, want: number, isClass: boolean): boolean {
    const got = node.args.length;
    if (got === want) return true;
    if (want === 0) {
      this.diags.error("X0423", `\`${name}\` doesn't take type arguments`, node.span);
      return false;
    }
    this.diags.error("X0422", `\`${name}\` needs ${want} type argument${want === 1 ? "" : "s"}`, node.span, got === 0 ? "missing type arguments" : `${got} given`)
      .help(`for example \`${name}<${Array(want).fill("Int").join(", ")}>\`${isClass && got === 0 ? "; `new` and `is`/`as` can leave them out" : ""}`);
    return false;
  }

  /** Suggests `import x.y.Name;` when a class of that name exists in another package. */
  missingImportHint(d: DiagnosticBuilder, name: string) {
    const other = [...this.classes.values()].find((c) => !c.filePrivate && c.decl.name.name === name);
    if (other) d.help(`a class with this name exists in package \`${other.pkg}\`; add \`import ${other.qname};\``);
  }

  resolveParent(info: ClassInfo, scope: FileScope) {
    const isInterface = !!info.decl.isInterface;
    const tparams = paramScope(info.typeParams);
    for (const node of info.decl.implements) {
      const t = this.resolveType(node, scope, false, tparams);
      if (t.kind === "error") continue;
      if (t.kind !== "class" || !t.info.decl.isInterface) {
        const d = this.diags.error(isInterface ? "X0783" : "X0784", `\`${typeToString(t)}\` is not an interface`, node.span,
          isInterface ? "interfaces can only extend interfaces" : "only interfaces can be implemented");
        if (!isInterface && t.kind === "class") d.help("use `extends` for a superclass");
        continue;
      }
      if (info.interfaces.includes(t.info)) {
        this.diags.warning("X0789", `\`${t.info.decl.name.name}\` is listed twice`, node.span);
        continue;
      }
      info.interfaces.push(t.info);
      info.interfaceArgs.push(t.args ?? []);
    }
    const ext = info.decl.extends;
    if (!ext) return;
    // An untyped JavaScript parent: its members are unknown. (One typed from a `.d.ts` is a native class.)
    if (ext.kind === "TypeName" && ext.name.length === 1 && !scope.classes.has(ext.name[0]!.name) &&
      (this.isJsImport(scope, ext.name[0]!.name) || this.isGlobal(scope, ext.name[0]!.name))) {
      info.jsParent = true;
      return;
    }
    const t = this.resolveType(ext, scope, false, tparams);
    if (t.kind === "class" && t.info.decl.isEnum) {
      this.diags.error("X0700", `enum \`${t.info.decl.name.name}\` can't be extended`, ext.span);
    } else if (t.kind === "class" && t.info.decl.isInterface) {
      this.diags.error("X0785", `\`${t.info.decl.name.name}\` is an interface`, ext.span, "can't be extended by a class")
        .help("use `implements`");
      info.interfaces.push(t.info);
      info.interfaceArgs.push(t.args ?? []);
    } else if (t.kind === "class") {
      info.parent = t.info;
      info.parentArgs = t.args ?? [];
    } else if (t.kind === "prim" && info.file.file.prelude && isNative(info) && this.primClass(t.name)) {
      // std: `native('Number') class int extends Float` inherits the members of numbers.
      info.parent = this.primClass(t.name);
    }
    else if (t.kind !== "error") this.diags.error("X0700", `\`${typeToString(t)}\` can't be extended`, ext.span);
  }

  /** Interfaces only declare public method and accessor signatures. */
  private checkInterfaceMembers(decl: A.ClassDecl) {
    for (const m of decl.members) {
      if (m.kind === "StaticBlock") {
        this.diags.error("X0782", "interfaces can't have `static` blocks", m.span);
        continue;
      }
      if (m.kind === "Field") {
        this.diags.error("X0781", "interfaces can't have fields", m.name.span).help("declare a getter instead: `function get x():T`");
        continue;
      }
      if (m.body) {
        this.diags.error("X0780", "interface members can't have a body", m.body.span).note("the implementing class provides the body");
      }
      const vis = m.modifiers.visibility;
      if (vis && vis.value !== "public") this.diags.error("X0782", "interface members are always `public`", vis.span);
      for (const key of ["static", "override", "final", "inline", "abstract", "async"] as const) {
        const mod = m.modifiers[key];
        if (mod) this.diags.error("X0782", `interface members can't be \`${key}\``, mod);
      }
    }
  }

  /**
   * Enum member values: explicit constants or the previous integer + 1. All members are `int`s
   * or all are `String`s (which need explicit values); values are unique.
   */
  computeEnum(info: ClassInfo) {
    const values = new Map<string, ConstValue>();
    info.enumValues = values;
    const scope = this.scopes.get(info.file)!;
    const seen = new Map<ConstValue, A.Ident>();
    let next: number | undefined = 0;
    let kind: "number" | "string" | undefined;
    for (const m of info.decl.members) {
      if (m.kind !== "Field") continue;
      if (m.name.name === "values") {
        this.diags.error("X0816", "`values` is reserved in enums", m.name.span).note("`Enum.values()` lists all members");
        continue;
      }
      let v: ConstValue;
      if (m.init) {
        const f = fold(m.init, (e, args) => {
          if (e.kind === "Ident" && values.has(e.name)) return { ok: true, value: values.get(e.name)! };
          return this.constLookup(info, scope)(e, args);
        });
        if (!f.ok) {
          if (!f.reported) this.diags.error("X0817", "enum values must be compile-time constants", f.at, f.reason);
          next = undefined;
          continue;
        }
        v = f.value;
      } else {
        if (next === undefined) {
          this.diags.error("X0812", `\`${m.name.name}\` needs a value`, m.name.span,
            kind === "string" ? "members of a `String` enum need explicit values" : "the previous member has no numeric value to count from");
          continue;
        }
        v = next;
      }
      const vk = typeof v === "number" && Number.isInteger(v) ? "number" : typeof v === "string" ? "string" : undefined;
      if (!vk) {
        this.diags.error("X0811", "enum values must be `Int`s or `String`s", m.init?.span ?? m.name.span, `found ${JSON.stringify(v)}`);
        continue;
      }
      if (kind && vk !== kind) {
        this.diags.error("X0811", "an enum can't mix numbers and strings", m.init?.span ?? m.name.span, `this is a ${vk === "number" ? "number" : "String"}`);
        continue;
      }
      kind = vk;
      const dup = seen.get(v);
      if (dup) {
        this.diags.error("X0813", `\`${m.name.name}\` has the same value as \`${dup.name}\``, m.init?.span ?? m.name.span, `= ${JSON.stringify(v)}`)
          .secondary(dup.span, "first member with this value");
        continue;
      }
      seen.set(v, m.name);
      values.set(m.name.name, v);
      next = typeof v === "number" ? v + 1 : undefined;
    }
  }

  /** Native members describe JS: no bodies, no initial values. */
  private checkNativeMember(m: A.Member) {
    if (m.kind === "StaticBlock") {
      this.diags.error("X0820", "native classes can't have `static` blocks", m.span);
    } else if (m.kind === "Method" && m.body) {
      this.diags.error("X0820", "native members can't have a body", m.body.span).note("a native class only describes an existing JavaScript class");
    } else if (m.kind === "Field" && m.init && !m.modifiers.inline) {
      // (`inline` constants are compile-time values: their initializer is needed, no JS is involved.)
      this.diags.error("X0821", "native fields can't have an initial value", m.init.span).note("the value comes from JavaScript");
    } else if (m.kind === "Method" && m.isDestructor) {
      this.diags.error("X0820", "native classes can't declare destructors", m.name.span);
    }
  }

  /** `~Name()` rules (X0800–X0804). */
  private collectDestructor(info: ClassInfo, m: A.Method) {
    const name = info.decl.name.name;
    if (info.decl.isInterface) {
      this.diags.error("X0800", "interfaces can't have destructors", m.name.span);
      return;
    }
    if (info.dtor) {
      this.diags.error("X0800", `class \`${name}\` has more than one destructor`, m.name.span).secondary(info.dtor.decl.name.span, "first destructor here");
      return;
    }
    if (m.name.name !== name) {
      this.diags.error("X0803", `a destructor must be named \`~${name}\``, m.name.span)
        .help(`rename it to \`~${name}\``, [{ span: m.name.span, text: name }]);
    }
    if (m.params.length > 0) this.diags.error("X0804", "destructors have no parameters", m.params[0]!.span);
    if (m.returnType) this.diags.error("X0804", "destructors have no return type", m.returnType.span);
    for (const key of ["static", "abstract", "final", "inline", "override"] as const) {
      const mod = m.modifiers[key];
      if (mod) this.diags.error("X0804", `destructors can't be \`${key}\``, mod);
    }
    const vis = m.modifiers.visibility;
    if (vis && vis.value !== "public" && vis.value !== "protected") {
      this.diags.error("X0804", "destructors are `public` or `protected`", vis.span);
    }
    // Destructors default to public (unlike other members);
    // an invalid visibility was reported above and is treated as public from here on.
    if (!vis || (vis.value !== "public" && vis.value !== "protected")) m.modifiers.visibility = { value: "public", span: m.name.span };
    info.dtor = { decl: m, async: !!m.modifiers.async };
  }

  /**
   * After all members are known: the implicit `dispose()` of classes with destructors, the
   * `IDisposable`/`IAsyncDisposable` interfaces they implement, and the rules tying them together.
   */
  wireDestructors(info: ClassInfo) {
    const inherited = info.parent ? chainDestructor(info.parent) : undefined;
    const own = info.dtor;
    if (own) {
      if (inherited && inherited.async !== own.async) {
        this.diags.error("X0806", `\`${info.decl.name.name}\`'s destructor must be ${inherited.async ? "async" : "synchronous"} like its parent's`, own.decl.name.span)
          .secondary(inherited.decl.name.span, `\`${inherited.async ? "async " : ""}~${inherited.owner.decl.name.name}\` declared here`)
          .note("the parent destructor runs right after this one");
        own.async = inherited.async; // reported; avoid follow-up interface mismatches
      }
    }
    if (info.decl.isInterface || !isManualDisposable(info)) return;
    // A class is scoped (a destructor: destroyed when its scope ends) or manual (`IDisposable`: its
    // own `dispose()`, called by `using` or by hand), never both.
    const name = info.decl.name.name;
    const node = info.decl.implements.find((_, i) => info.interfaces[i] && isManualDisposable(info.interfaces[i]!));
    if (own) {
      const from = node ? undefined : [...superclasses(info)].find((c) => isManualDisposable(c));
      const d = this.diags.error("X0808", `\`${name}\` can't have a destructor and implement \`IDisposable\``, own.decl.name.span, "a destructor makes the class scoped");
      if (node) d.secondary(node.span, "`IDisposable` makes it manual");
      else if (from) d.secondary(from.decl.name.span, `\`IDisposable\` comes from \`${from.decl.name.name}\``);
      d.note("a scoped class is destroyed when its scope ends; a manual one when `dispose()` is called (by `using` or by hand). A class is one or the other")
        .help(node ? "move the destructor's code into `dispose()` and remove the destructor, or remove `implements IDisposable`" : "move the destructor's code into an override of `dispose()`");
    } else if (inherited && node) {
      this.diags.error("X0828", `\`${name}\` can't implement \`IDisposable\`: its parent \`${inherited.owner.decl.name.name}\` is scoped`, node.span)
        .secondary(inherited.decl.name.span, `this destructor makes \`${inherited.owner.decl.name.name}\` scoped`)
        .note("a subclass of a scoped class is scoped too: a value of the parent type is destroyed when its scope ends")
        .help("remove `implements IDisposable`");
    }
  }

  /** `abstract` rules: only abstract classes have abstract members; they have no body and can be overridden. */
  private checkAbstractMembers(decl: A.ClassDecl) {
    const abstractClass = decl.modifiers.abstract;
    if (abstractClass && decl.modifiers.final) {
      this.diags.error("X0717", "a class can't be both `abstract` and `final`", decl.modifiers.final)
        .note("an abstract class only makes sense when it is extended");
    }
    for (const m of decl.members) {
      if (m.kind === "StaticBlock") continue;
      const abs = m.modifiers.abstract;
      if (m.kind === "Field") {
        if (abs) this.diags.error("X0715", "fields can't be `abstract`", abs).help("declare an abstract getter instead");
        continue;
      }
      if (m.isConstructor) {
        if (abs) this.diags.error("X0715", "constructors can't be `abstract`", abs);
        continue;
      }
      if (abs) {
        if (!abstractClass) {
          const kw = decl.span.file.text.indexOf("class", decl.span.start);
          this.diags.error("X0712", `\`${m.name.name}\` is abstract, but \`${decl.name.name}\` isn't`, abs)
            .help("make the class abstract", [{ span: span(decl.span.file, kw, kw), text: "abstract " }]);
        }
        if (m.body) this.diags.error("X0713", "abstract members can't have a body", m.body.span).note("subclasses provide the implementation");
        for (const key of ["static", "final", "inline"] as const) {
          const mod = m.modifiers[key];
          if (mod) this.diags.error("X0716", `abstract members can't be \`${key}\``, mod);
        }
        if (m.modifiers.visibility?.value === "private") {
          this.diags.error("X0716", "abstract members can't be `private`", m.modifiers.visibility.span).note("subclasses couldn't see it to implement it");
        }
      } else if (!m.body) {
        const end = m.span.end;
        this.diags.error("X0714", `\`${m.name.name}\` has no body`, m.name.span)
          .help(abstractClass ? "add a body, or mark it `abstract`" : "add a body", [{ span: span(m.span.file, end, end), text: " {}" }]);
      }
    }
  }

  /** Concrete classes must implement every abstract member they inherit. */
  checkAbstractImplemented(info: ClassInfo) {
    if (info.decl.isInterface || isNative(info) || info.decl.modifiers.abstract || hasJsAncestor(info)) return;
    const missing: MemberSig[] = [];
    const seen = new Set<string>();
    for (const sup of superclasses(info)) {
      for (const m of sup.members.values()) {
        if (seen.has(m.name) || !isAbstract(m)) continue;
        // Bodies and `private` on abstract members are errors already; don't require them again.
        if (m.decl.kind === "Method" && m.decl.body) continue;
        if (visibilityOf(m.decl) === "private") continue;
        seen.add(m.name);
        const impl = findClassMember(info, m.name);
        if (!impl || isAbstract(impl)) missing.push(m);
      }
    }
    if (missing.length === 0) return;
    const names = missing.map((m) => `\`${m.name}\``).join(", ");
    const d = this.diags.error("X0711", `\`${info.decl.name.name}\` doesn't implement the abstract ${missing.length === 1 ? "member" : "members"} ${names}`, info.decl.name.span, `inherits ${missing.length} abstract member${missing.length === 1 ? "" : "s"}`);
    for (const m of missing.slice(0, 3)) d.secondary(m.decl.name.span, `declared abstract in \`${m.owner.decl.name.name}\``);
    this.addStubsFix(d, info, missing, true);
  }

  /** Fix-it inserting member stubs above the class's closing `}`. */
  private addStubsFix(d: DiagnosticBuilder, info: ClassInfo, members: MemberSig[], override: boolean) {
    const file = info.decl.span.file;
    const close = info.decl.span.end - 1;
    const lineStart = file.lineStarts[file.lineOf(close) - 1]!;
    const classIndent = /^\s*/.exec(file.lineText(file.lineOf(info.decl.span.start)))![0];
    const onOwnLine = file.text.slice(lineStart, close).trim() === "";
    const at = onOwnLine ? lineStart : close;
    // Types as the class sees them: `implements Iterable<int>` stubs return `Iterator<int>`, not `Iterator<T>`.
    const stubs = members.map((m) => stubFor({ ...m, type: memberTypeIn(info, info.typeParams.map((param) => ({ kind: "typeParam", param })), m.owner, m.type) }, classIndent + "  ", override)).join("\n") + "\n";
    d.help("add the missing members (the stubs throw `NotImplementedException`)", [{ span: span(file, at, at), text: onOwnLine ? stubs : "\n" + stubs }]);
  }

  /** Every interface member must be implemented, public and with the same signature. */
  checkImplements(info: ClassInfo) {
    if (info.decl.isInterface || isNative(info) || hasJsAncestor(info)) return;
    const missing: MemberSig[] = [];
    const seen = new Set<string>();
    // Built-in enumerables (`Set`, `Map`, …) are iterable in JavaScript without a `getEnumerator()`;
    // `Enumerable.enumerate` provides one, so subclasses don't need to either.
    const builtinEnumerable = [...superclasses(info)].some((c) => isNative(c) && !!this.enumerable && isSubclass(c, this.enumerable));
    for (const iface of supertypes(info)) {
      if (!iface.decl.isInterface) continue;
      for (const req of iface.members.values()) {
        if (seen.has(req.name)) continue;
        seen.add(req.name);
        const impl = findClassMember(info, req.name);
        if (!impl) {
          if (builtinEnumerable && req.owner === this.enumerable) continue;
          // `IAttribute.wrap` is optional: only attributes that wrap methods define it.
          if (req.owner.qname === "xenon.IAttribute" && req.name === "wrap") continue;
          missing.push(req);
          continue;
        }
        // Compare as seen from this class: `implements IComparable<Dog>` requires `compareTo(other:Dog)`.
        const asSeen = (m: MemberSig): MemberSig => ({ ...m, type: memberTypeIn(info, ownArgs(info), m.owner, m.type) });
        const diffs = signatureDiffs(asSeen(impl), asSeen(req));
        if (visibilityOf(impl.decl) !== "public") diffs.unshift(`it must be \`public\` (it is \`${visibilityOf(impl.decl)}\`)`);
        if (impl.isStatic) diffs.unshift("it is `static`");
        const reqHalves = accessorHalves(req);
        const implHalves = req.kind === "accessor" && impl.kind === "accessor" ? [...accessorHalves(impl), ...(impl.delegate ? [impl.delegate] : [])] : [];
        for (const h of reqHalves) if (impl.kind === "accessor" && !implHalves.includes(h)) diffs.push(`it has no ${h === "get" ? "getter" : "setter"}`);
        if (diffs.length > 0) {
          const d = this.diags.error("X0788", `\`${impl.owner.decl.name.name}.${req.name}\` doesn't match \`${iface.decl.name.name}.${req.name}\``, impl.decl.name.span)
            .secondary(req.decl.name.span, "required by this interface member");
          for (const diff of diffs) d.note(diff);
        }
      }
    }
    // Abstract classes may leave interface members to their subclasses.
    if (missing.length === 0 || info.decl.modifiers.abstract) return;
    const names = missing.map((m) => `\`${m.name}\``).join(", ");
    const d = this.diags.error("X0787", `\`${info.decl.name.name}\` doesn't implement ${names}`, info.decl.name.span, `missing ${missing.length} interface member${missing.length === 1 ? "" : "s"}`);
    for (const m of missing.slice(0, 3)) d.secondary(m.decl.name.span, `required by \`${m.owner.decl.name.name}\``);
    this.addStubsFix(d, info, missing, false);
  }

  /** Inheritance cycles and `final` parents. */
  checkHierarchy(info: ClassInfo) {
    // Interface cycles: does any extended interface lead back here?
    const reaches = (from: ClassInfo, seen: Set<ClassInfo>): boolean => {
      if (from === info) return true;
      if (seen.has(from)) return false;
      seen.add(from);
      return from.interfaces.some((i) => reaches(i, seen));
    };
    for (const i of [...info.interfaces]) {
      if (reaches(i, new Set())) {
        const node = info.decl.implements[info.interfaces.indexOf(i)] ?? info.decl.name;
        this.diags.error("X0701", "inheritance cycle", "span" in node ? node.span : info.decl.name.span, `\`${i.decl.name.name}\` leads back to \`${info.decl.name.name}\``);
        info.interfaces = info.interfaces.filter((x) => x !== i);
      }
    }
    const ext = info.decl.extends;
    if (!info.parent || !ext) return;
    const chain = [info];
    let cur: ClassInfo | undefined = info.parent;
    while (cur) {
      if (cur === info) {
        const names = [...chain, info].map((c) => c.decl.name.name).join(" extends ");
        this.diags.error("X0701", "inheritance cycle", ext.span, names);
        info.parent = undefined; // break the cycle so later phases terminate
        return;
      }
      if (chain.includes(cur)) return; // a cycle further up, reported for those classes
      chain.push(cur);
      cur = cur.parent;
    }
    const finalMod = info.parent.decl.modifiers.final;
    if (finalMod) {
      this.diags.error("X0702", `\`${info.parent.decl.name.name}\` is \`final\` and can't be extended`, ext.span)
        .secondary(finalMod, "declared `final` here");
    }
  }

  /** `override` rules (X0720–X0726) and accessor halves inherited from the parent. */
  checkOverrides(info: ClassInfo) {
    if (info.decl.isInterface || isNative(info)) return;
    const jsAncestor = hasJsAncestor(info);
    for (const m of info.decl.members) {
      if (m.kind === "StaticBlock") continue;
      const ov = m.modifiers.override;
      if (m.kind === "Method" && m.isDestructor) continue; // checked in collectDestructor
      if (m.kind === "Method" && m.isConstructor) {
        if (ov) this.diags.error("X0721", "constructors can't be `override`", ov);
        continue;
      }
      const name = m.name.name;
      const isStatic = !!m.modifiers.static;
      // Only superclasses are overridden; implementing an interface member doesn't use `override`.
      const inherited = info.parent ? findClassMember(info.parent, name) : undefined;
      const parentName = inherited?.owner.decl.name.name;
      // Declared by a `.d.ts` (a typed JavaScript parent): `override` stays optional and signatures
      // aren't compared, as for untyped JavaScript parents; TypeScript's types are often looser.
      if (inherited?.owner.file.file.generated) continue;

      if (m.kind === "Field") {
        if (ov) this.diags.error("X0726", "fields can't be overridden", ov).help("remove `override`");
        if (inherited && !(isStatic && inherited.isStatic)) {
          this.diags.error("X0724", `\`${name}\` is already declared in \`${parentName}\``, m.name.span, "redeclared here")
            .secondary(inherited.decl.name.span, "inherited member")
            .note("fields can't be overridden; use the inherited one or pick another name");
        }
        continue;
      }
      if (isStatic) {
        if (ov) this.diags.error("X0721", "static members can't be overridden", ov).note("a static member with a parent's name simply hides it");
        if (inherited && !inherited.isStatic) {
          this.diags.error("X0725", `static \`${name}\` conflicts with the instance member of \`${parentName}\``, m.name.span)
            .secondary(inherited.decl.name.span, "instance member");
        }
        continue;
      }
      if (!inherited) {
        const root = info.qname === "xenon.Object" ? undefined : this.rootMember(name);
        if (root && !jsAncestor) {
          if (!ov) this.missingOverride(m, `\`Object.${name}\``);
          const forms = root.overloads ?? [{ decl: root.decl as A.Method, type: root.type as MethodType }];
          const own = info.members.get(name)?.type;
          const ret = own?.kind === "method" ? own.ret : undefined;
          if (m.accessor || !forms.some((f) => f.decl.params.length === m.params.length && (!ret || assignable(ret, f.type.ret)))) {
            const d = this.diags.error("X0722", `\`${name}\` doesn't match \`Object.${name}\``, m.name.span);
            for (const f of forms) d.note(`it must be \`${name}${signatureText(f.decl)}\``);
          }
        } else if (ov && !jsAncestor) {
          const d = this.diags.error("X0721", `\`${name}\` doesn't override anything`, ov, "nothing to override");
          const fromInterface = [...supertypes(info)].find((t) => t.decl.isInterface && t.members.has(name));
          if (fromInterface) d.note(`it implements \`${fromInterface.decl.name.name}.${name}\`; implementing an interface member doesn't use \`override\``);
          const names = info.parent ? allMemberNames(info.parent) : [];
          const sug = suggest(name, names);
          if (sug) d.help(`the parent has a member with a similar name: \`${sug}\``, [{ span: m.name.span, text: sug }]);
          else if (!info.parent) d.note(`\`${info.decl.name.name}\` has no superclass`);
        }
        continue;
      }
      if (inherited.isStatic) {
        this.diags.error("X0725", `instance member \`${name}\` conflicts with static \`${parentName}.${name}\``, m.name.span)
          .secondary(inherited.decl.name.span, "static member");
        continue;
      }
      if (inherited.kind === "field") {
        this.diags.error("X0724", `\`${name}\` is a field in \`${parentName}\` and can't be redefined`, m.name.span)
          .secondary(inherited.decl.name.span, "inherited field");
        continue;
      }
      if (!ov) this.missingOverride(m, `\`${parentName}.${name}\``, inherited);
      const parentHalf = m.accessor
        ? [inherited.decl, inherited.decl2].find((d) => d?.kind === "Method" && d.accessor === m.accessor)
        : inherited.decl;
      const finalMod = parentHalf?.modifiers.final;
      if (finalMod) {
        this.diags.error("X0723", `\`${parentName}.${name}\` is \`final\` and can't be overridden`, m.name.span)
          .secondary(finalMod, "declared `final` here");
        continue;
      }
      // A `constexpr` method is implicitly `final`: its calls may already be computed at compile time.
      const constexprMod = parentHalf?.modifiers.constexpr;
      if (constexprMod) {
        this.diags.error("X0723", `\`${parentName}.${name}\` is \`constexpr\` and can't be overridden`, m.name.span)
          .secondary(constexprMod, "declared `constexpr` here")
          .note("a `constexpr` method is implicitly `final`: calls of it may be computed at compile time, so no subclass can replace it");
        continue;
      }
      this.checkSignature(m, info, inherited);
    }
  }

  private missingOverride(m: A.Method, what: string, inherited?: MemberSig) {
    const at = span(m.span.file, m.span.start, m.span.start);
    const d = this.diags.error("X0720", `\`${m.name.name}\` overrides ${what} but is not marked \`override\``, m.name.span, `overrides ${what}`);
    if (inherited) d.secondary(inherited.decl.name.span, "original declared here");
    d.help("add `override`", [{ span: at, text: "override " }]);
  }

  /** X0722: an override must match the original's shape. Also wires up inherited accessor halves. */
  private checkSignature(m: A.Method, info: ClassInfo, inherited: MemberSig) {
    const own = info.members.get(m.name.name)!;
    const diffs: string[] = [];
    const vis = (x: A.Member) => x.modifiers.visibility?.value ?? "internal";
    if (vis(m) !== vis(inherited.decl)) diffs.push(`visibility: \`${vis(m)}\` instead of \`${vis(inherited.decl)}\``);
    if (!!m.modifiers.async !== !!inherited.decl.modifiers.async) diffs.push(m.modifiers.async ? "it is `async` but the original isn't" : "the original is `async`");
    if (isConstMember(inherited) && m.accessor !== "set" && !m.isConst) diffs.push("the original is `const`, so the override must be `const` too");
    if (own.kind !== inherited.kind) {
      diffs.push(own.kind === "accessor" ? "an accessor can't override a method" : "a method can't override an accessor");
    } else if (own.kind === "method") {
      const a = own.type as MethodType;
      const b = alignTypeParams(memberTypeIn(info, ownArgs(info), inherited.owner, inherited.type) as MethodType, a);
      if ((a.typeParams?.length ?? 0) !== (b.typeParams?.length ?? 0)) diffs.push(`${a.typeParams?.length ?? 0} type parameter(s) instead of ${b.typeParams?.length ?? 0}`);
      if (a.params.length !== b.params.length) diffs.push(`${a.params.length} parameter(s) instead of ${b.params.length}`);
      a.params.forEach((p, i) => {
        const q = b.params[i];
        if (!q) return;
        if (!sameType(p.type, q.type)) diffs.push(`parameter \`${p.name}\` is \`${typeToString(p.type)}\` instead of \`${typeToString(q.type)}\``);
        if (p.optional !== q.optional || p.rest !== q.rest) diffs.push(`parameter \`${p.name}\` differs in being optional/rest`);
      });
      if (!(a.ret.kind === "void" ? b.ret.kind === "void" : b.ret.kind !== "void" && assignable(a.ret, b.ret))) {
        diffs.push(`returns \`${typeToString(a.ret)}\` instead of \`${typeToString(b.ret)}\``);
      }
    } else {
      // accessors: the value type must stay the same
      const halves = (x: MemberSig) => [x.decl, x.decl2].flatMap((d) => (d?.kind === "Method" && d.accessor ? [d.accessor] : []));
      const inheritedType = memberTypeIn(info, ownArgs(info), inherited.owner, inherited.type);
      if (!sameType(own.type, inheritedType)) diffs.push(`type \`${typeToString(own.type)}\` instead of \`${typeToString(inheritedType)}\``);
      const ownHalves = halves(own);
      const parentHalves = halves(inherited);
      if (ownHalves.length === 1 && m === own.decl) {
        const other = ownHalves[0] === "get" ? "set" : "get";
        if (parentHalves.includes(other)) {
          own.delegate = other;
          if (other === "set") own.readonly = undefined;
        }
      }
    }
    if (diffs.length === 0) return;
    const d = this.diags.error("X0722", `\`${m.name.name}\` doesn't match the member it overrides`, m.name.span)
      .secondary(inherited.decl.name.span, `\`${inherited.owner.decl.name.name}.${m.name.name}\` declared here`);
    for (const diff of diffs) d.note(diff);
  }

  collectMembers(info: ClassInfo, scope: FileScope) {
    const decl = info.decl;
    if (decl.isInterface) this.checkInterfaceMembers(decl);
    else if (!decl.isEnum && !isNative(info)) this.checkAbstractMembers(decl);
    for (const m of decl.members) {
      if (m.kind === "StaticBlock") {
        if (isNative(info)) this.checkNativeMember(m);
        continue;
      }
      if (decl.modifiers.static && m.kind === "Method" && (m.isConstructor || m.isDestructor)) {
        this.diags.error("X0415", `static class \`${decl.name.name}\` can't declare a ${m.isConstructor ? "constructor" : "destructor"}`, m.name.span)
          .secondary(decl.modifiers.static, "declared as a static class here");
        continue;
      }
      if (decl.modifiers.static && !m.modifiers.static) {
        const kind = m.kind === "Field" ? "field" : m.accessor ? "accessor" : "method";
        const d = this.diags.error("X0415", `${kind} \`${m.name.name}\` in static class \`${decl.name.name}\` must be \`static\``, m.name.span)
          .secondary(decl.modifiers.static, "declared as a static class here");
        d.help("make the member static", [{ span: span(m.span.file, m.span.start, m.span.start), text: "static " }]);
      }
      if (m.kind === "Method" && m.isDestructor) {
        this.collectDestructor(info, m);
        continue;
      }
      if (m.kind === "Method" && m.name.name.startsWith("operator") && m.name.name !== "operator") {
        const sym = m.name.name.slice("operator".length);
        const op = `\`operator${sym}\``;
        if (sym === "!=") {
          this.diags.error("X0371", "`!=` can't be overloaded on its own", m.name.span, op)
            .note("`a != b` is `!(a == b)`: declare `operator==` instead");
        } else if (!OVERLOADABLE.has(sym) && sym !== "==") {
          this.diags.error("X0371", `\`${sym}\` can't be overloaded`, m.name.span, op)
            .note("the operators that can be overloaded are `+`, `-`, `*`, `/` and `==` (which `!=` uses)");
        } else {
          if (sym === "==" && m.returnType && !(m.returnType.kind === "TypeName" && ["Boolean", "Bool"].includes(m.returnType.name.at(-1)!.name))) {
            this.diags.error("X0372", "`operator==` must return a `Bool`", m.returnType.span);
          }
          if (m.modifiers.static) this.diags.error("X0373", `${op} must be an instance method`, m.modifiers.static);
          if (m.accessor) this.diags.error("X0372", `${op} must be a method, not an accessor`, m.name.span);
          if (m.params.length !== 1 || m.params[0]!.rest || m.params[0]!.init) {
            this.diags.error("X0372", `${op} takes exactly one (required) parameter: the right operand`, m.name.span);
          }
          if (isVoidNode(m.returnType)) this.diags.error("X0372", `${op} must return a value`, m.returnType!.span);
        }
      }
      if (m.kind === "Method" && m.isConst) {
        const what = m.isConstructor ? "constructors" : m.modifiers.static ? "static methods" : m.accessor === "set" ? "setters" : undefined;
        if (what) {
          this.diags.error("X0903", `${what} can't be \`const\``, m.name.span)
            .note(m.modifiers.static ? "`const` restricts `this`, which static methods don't have" : "`const` means the method doesn't change `this`");
        }
      }
      if (isNative(info)) this.checkNativeMember(m);
      if (m.kind === "Method" && m.isConstructor && info.ctor && isNative(info)) {
        (info.ctorOverloads ??= []).push({ decl: m, type: this.methodType(m, scope, T.void, this.memberParams(info, m)) });
        continue;
      }
      if (m.kind === "Method" && m.isConstructor) {
        if (info.ctor) {
          this.diags.error("X0202", `class \`${decl.name.name}\` has more than one constructor`, m.name.span)
            .secondary(info.ctor.decl.name.span, "first constructor here")
            .note("Xenon has no overloading; use default parameter values instead");
          continue;
        }
        if (m.returnType) this.diags.error("X0203", "constructors don't have a return type", m.returnType.span);
        info.ctor = { decl: m, type: this.methodType(m, scope, T.void, this.memberParams(info, m)) };
        continue;
      }
      const isStatic = !!m.modifiers.static;
      const prev = info.members.get(m.name.name);

      if (m.kind === "Method" && m.accessor) {
        const valueType = m.accessor === "get"
          ? (m.returnType ? this.resolveType(m.returnType, scope, false, this.memberParams(info, m)) : this.untypedReturn(m.name, m.span, m.body, "getter"))
          : m.params[0]?.type ? this.resolveType(m.params[0].type, scope, false, this.memberParams(info, m)) : this.untyped(m.name.span, "setter parameter");
        if (m.accessor === "get" && m.params.length > 0) this.diags.error("X0205", "getters can't have parameters", m.params[0]!.span);
        if (m.accessor === "set" && m.params.length !== 1) this.diags.error("X0206", "setters take exactly one parameter", m.name.span);
        if (m.accessor === "set" && m.returnType && !isVoidNode(m.returnType)) {
          this.diags.error("X0211", "a setter's return type must be `void`", m.returnType.span)
            .help("use `:void`", [{ span: m.returnType.span, text: "void" }]);
        }
        if (prev && prev.kind === "accessor" && !prev.decl2 && (prev.decl as A.Method).accessor !== m.accessor && prev.isStatic === isStatic) {
          prev.decl2 = m;
          // The setter may be less visible than the getter (`public get` + `private set`), never more.
          const getter = m.accessor === "get" ? m : (prev.decl as A.Method);
          const setter = m.accessor === "set" ? m : (prev.decl as A.Method);
          if (!setterFits(visibilityOf(getter), visibilityOf(setter))) {
            this.diags.error("X0212", "a setter can't be more visible than its getter", setter.name.span, `\`${visibilityOf(setter)}\``)
              .secondary(getter.name.span, `\`${visibilityOf(getter)}\``)
              .note("a property can be read where it can be written: make the getter at least as visible");
          }
          const getterType = m.accessor === "get" ? valueType : prev.type;
          const setterType = m.accessor === "set" ? valueType : prev.type;
          if (!sameType(getterType, setterType) && !isDynamic(getterType) && !isDynamic(setterType)) {
            this.diags.error("X0207", "getter and setter types don't match", m.name.span, `this is \`${typeToString(valueType)}\``)
              .secondary(prev.decl.name.span, `the other accessor uses \`${typeToString(prev.type)}\``);
          }
          prev.type = getterType;
          prev.readonly = undefined;
          if (m.accessor === "get") prev.typeSpan = m.returnType?.span;
          continue;
        }
        if (prev) {
          this.duplicate(m, prev);
          continue;
        }
        info.members.set(m.name.name, {
          name: m.name.name, owner: info, decl: m, isStatic, kind: "accessor", type: valueType,
          typeSpan: m.accessor === "get" ? m.returnType?.span : m.params[0]?.type?.span,
          readonly: m.accessor === "get" ? "getter" : undefined,
        });
        continue;
      }

      if (prev && isNative(info) && m.kind === "Method" && prev.kind === "method" && prev.isStatic === isStatic) {
        // Overloads: native declarations only (they stand in for TypeScript's unions).
        const ret = m.returnType ? this.resolveType(m.returnType, scope, true, this.memberParams(info, m)) : this.untypedReturn(m.name, m.span, m.body);
        prev.overloads ??= [{ decl: prev.decl as A.Method, type: prev.type as MethodType }];
        prev.overloads.push({ decl: m, type: this.methodType(m, scope, ret, this.memberParams(info, m)) });
        continue;
      }
      if (prev) {
        this.duplicate(m, prev);
        continue;
      }
      if (m.modifiers.inline && m.kind === "Method") {
        this.diags.error("X0520", "`inline` is only allowed on constants", m.modifiers.inline)
          .note("a function evaluated at compile time is `static constexpr function`");
      }
      if (m.modifiers.constexpr) this.constexprDecl(m, isNative(info));
      if (m.kind === "Field" && m.modifiers.inline) {
        if (!m.modifiers.static) {
          this.diags.error("X0520", "an `inline` field must be `static`", m.modifiers.inline)
            .help("add `static`", [{ span: span(m.modifiers.inline.file, m.modifiers.inline.start, m.modifiers.inline.start), text: "static " }]);
        }
        if (m.decl === "var") inlineVar(this.diags.error("X0521", "an `inline` field must be `final`", m.name.span, "declared with `var`"), m.name);
        if (!m.init) this.diags.error("X0522", `inline constant \`${m.name.name}\` needs a value`, m.name.span);
      }
      if (m.kind === "Field") {
        const type = m.type ? this.resolveType(m.type, scope, false, this.memberParams(info, m)) : this.untyped(m.name.span, "field", m.init);
        if (m.decl === "const" && !m.init && !decl.isEnum && !isNative(info)) {
          this.diags.error("X0503", `constant \`${m.name.name}\` must be initialized`, m.name.span)
            .help("use `final` for a value assigned once in the constructor");
        }
        info.members.set(m.name.name, {
          name: m.name.name, owner: info, decl: m, isStatic, kind: "field", type, typeSpan: m.type?.span,
          readonly: m.decl === "var" ? undefined : m.decl,
        });
      } else {
        const ret = m.returnType ? this.resolveType(m.returnType, scope, true, this.memberParams(info, m)) : this.untypedReturn(m.name, m.span, m.body);
        info.members.set(m.name.name, {
          name: m.name.name, owner: info, decl: m, isStatic, kind: "method", type: this.methodType(m, scope, ret, this.memberParams(info, m)), typeSpan: m.returnType?.span,
        });
      }
    }
  }

  /** Folds an `inline` field's initializer (once; detects cycles between constants). */
  inlineFold(sig: MemberSig): Fold {
    const state = this.inlineState.get(sig);
    const field = sig.decl as A.Field;
    if (state === "busy") return { ok: false, at: field.name.span, reason: "cycle", cycle: true };
    if (state) return state;
    if (!field.init) return { ok: false, at: field.name.span, reason: "no value", reported: true };
    this.inlineState.set(sig, "busy");
    const scope = this.scopes.get(sig.owner.file)!;
    const result = fold(field.init, this.constLookup(sig.owner, scope));
    this.inlineState.set(sig, result);
    return result;
  }

  /** Resolves `NAME` / `Class.NAME` inside an inline initializer of `owner`. */
  /** X0526: what a `constexpr` declaration must be (its body and types are checked with the body). */
  private constexprDecl(m: A.Member, native: boolean) {
    const at = m.modifiers.constexpr!;
    const bad = (message: string, help?: string) => {
      const d = this.diags.error("X0526", message, at);
      if (help) d.help(help);
    };
    if (m.kind !== "Method") return bad("`constexpr` is for functions", "a compile-time constant is `static inline final NAME:T = …`");
    // The standard library's getters (`String.length`) and rest parameters (`Math.max`) run as JavaScript.
    if (m.isDestructor || (m.accessor && !(native && m.accessor === "get"))) return bad(`${m.isDestructor ? "a destructor" : "a getter or setter"} can't be \`constexpr\``);
    if (m.modifiers.async || m.modifiers.abstract) bad(`a \`constexpr\` function can't be \`${m.modifiers.async ? "async" : "abstract"}\``);
    if (m.params.some((p) => p.rest) && !native) bad("a `constexpr` function can't have a rest parameter");
  }

  /**
   * A `constexpr` constructor builds an immutable object at compile time: the class has no
   * superclass and only `final`/`const` instance fields (X0526).
   */
  constexprClass(info: ClassInfo) {
    const ctor = info.decl.members.find((m): m is A.Method => m.kind === "Method" && m.isConstructor && !!m.modifiers.constexpr);
    if (!ctor) return;
    if (info.decl.extends) {
      this.diags.error("X0526", "a class with a `constexpr` constructor can't extend another class", info.decl.extends.span)
        .secondary(ctor.modifiers.constexpr!, "`constexpr` constructor");
    }
    for (const f of info.decl.members) {
      if (f.kind === "Field" && !f.modifiers.static && f.decl === "var") {
        this.diags.error("X0526", `field \`${f.name.name}\` must be \`final\`: a \`constexpr\` constructor builds an immutable object`, f.name.span)
          .secondary(ctor.modifiers.constexpr!, "`constexpr` constructor")
          .help("declare it `final`");
      }
    }
  }

  /** Compile-time lookup in `owner`'s context: inline constants, `constexpr` getters, and calls, `new` and operators (see `constCall`). */
  constLookup(owner: ClassInfo, scope: FileScope): ConstLookup {
    return (e, args, self) => {
      if (e.kind === "Call" || e.kind === "New" || e.kind === "Binary") return this.constCall(e, args ?? [], { owner, scope }, 0, self);
      if (e.kind === "Member" && self !== undefined) return this.constGet(e, self);
      return this.constRef(e, owner, scope);
    };
  }

  /** The class whose members a constant has: its own, or the standard library's `String`, `Float` or `Boolean`. */
  private constClass(v: ConstValue): ClassInfo | undefined {
    if (v instanceof ConstObject) return v.cls as ClassInfo;
    const name = typeof v === "string" ? "String" : typeof v === "number" ? "Float" : typeof v === "boolean" ? "Bool" : v instanceof RegExp ? "RegExp" : undefined;
    return name ? this.primClass(name) : undefined;
  }

  /** A `constexpr` getter of the standard library on a constant: `'abc'.length`. */
  constGet(e: A.Expr & { kind: "Member" }, self: ConstValue): Fold | undefined {
    const info = self instanceof ConstObject ? undefined : this.constClass(self);
    const m = info && findMember(info, e.name.name);
    if (!m || m.kind !== "accessor" || m.isStatic || !isConstexpr(m)) return undefined;
    return callNative(self, m.name, [], true, e.span);
  }

  /** The static `constexpr` function a call names (`f(…)` in its class, `Cls.f(…)`), if any. */
  constexprTarget(callee: A.Expr, owner: ClassInfo, scope: FileScope): MemberSig | undefined {
    let m: MemberSig | undefined;
    if (callee.kind === "Ident") m = findMember(owner, callee.name);
    else if (callee.kind === "Member" && callee.object.kind === "Ident") {
      const cls = callee.object.name === owner.decl.name.name ? owner : this.lookupClass(scope, callee.object.name);
      if (cls) m = findMember(cls, callee.name.name);
    }
    return m && m.isStatic && isConstexpr(m, this.result.overloadPicks.get(callee)?.chosen?.decl) ? m : undefined;
  }

  /** Calls made by the current top-level compile-time evaluation (a budget against runaway recursion). */
  private constexprCalls = 0;
  /** Statements and loop rounds left for the current top-level evaluation (against endless loops). */
  private constexprBudget: Budget = { steps: 0 };

  /**
   * Compile-time evaluation of a call, a `new` or an operator on an object, with these argument
   * values (`self`: the receiver object). `ctx` is where names are resolved and `this` (inside a
   * `constexpr` method or constructor). Pure `Math` functions; static `constexpr` functions;
   * `constexpr` methods of objects built at compile time (looked up on the object's own class);
   * `constexpr` constructors; `constexpr` operator methods. At most 1000
   * calls deep, 100000 calls and 1000000 steps. Undefined if the code isn't `constexpr`.
   */
  constCall(e: A.Expr, args: ConstValue[], ctx: { owner: ClassInfo; scope: FileScope; self?: ConstObject }, depth = 0, self?: ConstValue): Fold | undefined {
    if (depth === 0) {
      this.constexprCalls = 0;
      this.constexprBudget = { steps: 1_000_000 };
    }
    if (e.kind === "New") {
      const info = e.callee.kind === "TypeName" ? this.lookupClass(ctx.scope, e.callee.name.map((n) => n.name).join(".")) ?? (e.callee.name.at(-1)!.name === ctx.owner.decl.name.name ? ctx.owner : undefined) : undefined;
      const ctor = info?.ctor;
      if (!info || !ctor || !ctor.decl.modifiers.constexpr) return undefined;
      return this.construct(info, ctor.decl, args, e.span, depth);
    }
    if (e.kind === "Binary") {
      if (!(self instanceof ConstObject)) return undefined;
      const eq = ["==", "===", "!=", "!=="].includes(e.op);
      const m = findMember(self.cls as ClassInfo, eq ? "operator==" : `operator${e.op}`);
      if (!m || !isConstexpr(m) || m.isStatic) return undefined;
      const f = this.invoke(m, args, self, e.span, depth);
      return f.ok && eq && e.op.startsWith("!") ? { ok: true, value: !f.value } : f;
    }
    if (e.kind !== "Call") return undefined;
    const callee = e.callee;
    // A method of a string or number: the standard library's `constexpr` ones (`'a b'.replace(~/ /g, '')`).
    if (callee.kind === "Member" && self !== undefined && !(self instanceof ConstObject)) {
      const m = findMember(this.constClass(self) ?? ctx.owner, callee.name.name);
      const decl = m && !m.isStatic && isNative(m.owner) ? constexprOverload(m, this.result.overloadPicks.get(callee)?.chosen?.decl, args.length) : undefined;
      return decl ? this.invoke(m!, args, self, e.span, depth) : undefined;
    }
    // A method of an object: `v.length()`, or a bare `length()` inside another of its methods.
    const receiver = callee.kind === "Member" ? self as ConstObject | undefined : callee.kind === "Ident" ? ctx.self : undefined;
    if (receiver) {
      const name = callee.kind === "Member" ? callee.name.name : (callee as A.Expr & { kind: "Ident" }).name;
      const m = findMember(receiver.cls as ClassInfo, name);
      if (m && isConstexpr(m) && !m.isStatic) return this.invoke(m, args, receiver, e.span, depth);
      if (callee.kind === "Member" && callee.object.kind !== "This") return undefined;
    }
    // `fact(10)` / `this.fact(10)` in the class's own code, where `this` is a runtime object: a
    // `constexpr` method (implicitly `final`, so no subclass runs other code) runs without one; if
    // it uses `this`, it isn't folded.
    const own = callee.kind === "Ident" ? callee.name : callee.kind === "Member" && callee.object.kind === "This" ? callee.name.name : undefined;
    if (own !== undefined && !receiver) {
      const m = findMember(ctx.owner, own);
      if (m && isConstexpr(m) && !m.isStatic) return this.invoke(m, args, undefined, e.span, depth);
      if (callee.kind === "Member") return undefined;
    }
    const m = this.constexprTarget(callee, ctx.owner, ctx.scope);
    return m ? this.invoke(m, args, undefined, e.span, depth) : undefined;
  }

  /**
   * Runs a `constexpr` function or method (`self`: its `this`) with these argument values; one of
   * the standard library runs as the JavaScript built-in (`Math.floor`, `'abc'.trim()`).
   */
  private invoke(m: MemberSig, args: ConstValue[], self: ConstValue | undefined, at: Span, depth: number): Fold {
    this.usedMembers.add(m);
    if (depth > 1000) return { ok: false, at, reason: `\`${m.name}\` recurses more than 1000 calls deep`, limit: true };
    if (++this.constexprCalls > 100_000) return { ok: false, at, reason: `evaluating \`${m.name}\` takes more than 100000 calls`, limit: true };
    const decl = m.decl as A.Method;
    if (!decl.body && isNative(m.owner)) {
      const target = m.isStatic ? (globalThis as Record<string, unknown>)[jsNameOf(m.owner)] : self;
      return callNative(target, m.name, args, false, at);
    }
    if (!decl.body || (self !== undefined && !(self instanceof ConstObject))) return { ok: false, at, reason: `\`${m.name}\` has no body`, reported: true };
    const { params, lookup, failed } = this.bindParams(decl, m.owner, args, self, at, depth);
    if (failed) return failed;
    // An expression body is folded; a block body runs statement by statement.
    const stmt = decl.body.body[0];
    const f = decl.exprBody && stmt?.kind === "Return" && stmt.value ? fold(stmt.value, lookup) : run(decl.body, params, lookup, this.constexprBudget, at);
    if (f.ok) return f;
    // Too deep or too long is reported at the outermost call; anything else at the declaration.
    return f.limit ? { ...f, at } : { ok: false, at, reason: `\`${m.name}\` can't be evaluated at compile time`, reported: true };
  }

  /** An object built by a `constexpr` constructor: field initializers first, then the constructor's body. */
  private construct(info: ClassInfo, ctor: A.Method, args: ConstValue[], at: Span, depth: number): Fold {
    if (depth > 1000) return { ok: false, at, reason: `\`new ${info.decl.name.name}\` recurses more than 1000 calls deep`, limit: true };
    if (++this.constexprCalls > 100_000) return { ok: false, at, reason: "the evaluation takes more than 100000 calls", limit: true };
    const self = new ConstObject(info, new Map());
    const { params, lookup, failed } = this.bindParams(ctor, info, args, self, at, depth);
    if (failed) return failed;
    for (const f of info.decl.members) {
      if (f.kind !== "Field" || f.modifiers.static) continue;
      let v: ConstValue = defaultValueOf(f.type);
      if (f.init) {
        const r = fold(f.init, lookup);
        if (!r.ok) return { ok: false, at, reason: `the initial value of \`${f.name.name}\` isn't a compile-time constant`, reported: true };
        v = r.value;
      }
      self.fields.set(f.name.name, v);
    }
    if (!ctor.body) return { ok: true, value: self };
    const r = run(ctor.body, params, lookup, this.constexprBudget, at, self);
    if (!r.ok && !(r.limit && r.reason.startsWith("the function ended"))) {
      return r.limit ? { ...r, at } : { ok: false, at, reason: `\`new ${info.decl.name.name}\` can't be evaluated at compile time`, reported: true };
    }
    return { ok: true, value: self };
  }

  /** The parameters bound to `args` (defaults filled in) and the lookup a `constexpr` body runs with. */
  private bindParams(decl: A.Method, owner: ClassInfo, args: ConstValue[], self: ConstObject | undefined, at: Span, depth: number) {
    const ownerScope = this.scopes.get(owner.file)!;
    const outer = this.constLookup(owner, ownerScope);
    const params = new Map<string, ConstValue>();
    const lookup: ConstLookup = (x, a, s) => {
      if (x.kind === "Ident" && params.has(x.name)) return { ok: true, value: params.get(x.name)! };
      if (x.kind === "This" && self) return { ok: true, value: self };
      if (x.kind === "Ident" && self?.fields.has(x.name)) return { ok: true, value: self.fields.get(x.name)! };
      if (x.kind === "Call" || x.kind === "New" || x.kind === "Binary") return this.constCall(x, a ?? [], { owner, scope: ownerScope, self }, depth + 1, s);
      return outer(x);
    };
    let failed: Fold | undefined;
    for (const [i, p] of decl.params.entries()) {
      if (i < args.length) params.set(p.name.name, args[i]!);
      else if (p.init) {
        const d = fold(p.init, lookup);
        if (!d.ok) failed ??= { ok: false, at, reason: `the default of \`${p.name.name}\` isn't a compile-time constant`, reported: true };
        else params.set(p.name.name, d.value);
      }
    }
    return { params, lookup, failed };
  }

  /** The class a typedef names (`int.MAX_VALUE` through `typedef int = Int`), for using it as a value. */
  typedefClass(scope: FileScope, name: string): ClassInfo | undefined {
    const td = this.lookupTypedef(scope, name);
    if (!td || td.params.length > 0) return undefined;
    const t = this.resolveTypedef(td);
    if (t.kind === "class" && !t.info.typeParams.length) return t.info;
    if (t.kind === "prim") return this.primClass(t.name);
    return undefined;
  }

  constRef(e: A.Expr, owner: ClassInfo, scope: FileScope): Fold | undefined {
    let m: MemberSig | undefined;
    if (e.kind === "Ident") m = findMember(owner, e.name);
    else if (e.kind === "Member" && e.object.kind === "Ident") {
      const cls = e.object.name === owner.decl.name.name ? owner : this.lookupClass(scope, e.object.name) ?? this.typedefClass(scope, e.object.name);
      if (cls) m = findMember(cls, e.name.name);
    }
    if (m) this.usedMembers.add(m);
    if (m?.owner.decl.isEnum && m.kind === "field") {
      const v = m.owner.enumValues?.get(m.name);
      return v === undefined ? { ok: false, at: e.span, reason: "broken enum member", reported: true } : { ok: true, value: v };
    }
    if (!m || !isInline(m)) return undefined;
    const f = this.inlineFold(m);
    if (f.ok) return f;
    // A broken dependency is reported at its own declaration; cycles at every member of the cycle.
    return f.cycle ? { ...f, at: e.span } : { ok: false, at: e.span, reason: "depends on a broken constant", reported: true };
  }

  private duplicate(m: A.Field | A.Method, prev: MemberSig) {
    this.diags.error("X0201", `\`${m.name.name}\` is declared more than once in \`${prev.owner.decl.name.name}\``, m.name.span, "duplicate declaration")
      .secondary(prev.decl.name.span, "first declared here");
  }

  /** Warns about a missing annotation and types the declaration as `*`. `fixAt`: where `:*` goes. */
  untyped(at: Span, what: string, init?: A.Expr, fixAt: number = at.end): Type {
    const d = this.diags.warning("X0850", `missing type annotation on ${what}; it is untyped (\`*\`)`, at);
    if (init) d.note("fields and parameters need a type (only local variables take their value's type)");
    d.help("add a type, or `:*` to make it explicitly dynamic", [{ span: span(at.file, fixAt, fixAt), text: ":*" }]);
    return T.any;
  }

  /** Untyped return value: the fix-it goes after the parameter list. */
  untypedReturn(name: A.Ident, fnSpan: Span, body: A.Block | A.Expr | undefined, what = "return type"): Type {
    const text = fnSpan.file.text;
    const limit = body?.kind === "Block" ? body.span.start : fnSpan.end;
    const close = text.lastIndexOf(")", limit);
    return this.untyped(name.span, what, undefined, close >= 0 ? close + 1 : name.span.end);
  }

  methodType(m: A.Method, scope: FileScope, ret: Type, tparams?: TypeParamScope): MethodType {
    let sawOptional = false;
    const params = m.params.map((p, i) => {
      const type = p.type ? this.resolveType(p.type, scope, false, tparams) : this.untyped(p.name.span, `parameter \`${p.name.name}\``);
      if (p.rest && i !== m.params.length - 1) this.diags.error("X0208", "a rest parameter must be the last parameter", p.span);
      if (p.rest && p.type && !elementOf(type) && !isDynamic(type)) {
        this.diags.error("X0209", "a rest parameter must be an `Array`, e.g. `...names:Array<String>`", p.type.span);
      }
      if (p.init) sawOptional = true;
      else if (sawOptional && !p.rest) {
        this.diags.error("X0210", "a required parameter can't follow an optional one", p.span);
      }
      return { name: p.name.name, type, optional: !!p.init, rest: p.rest };
    });
    const own = this.typeParamsOf(m);
    return own.length > 0 ? { kind: "method", params, ret, typeParams: own } : { kind: "method", params, ret };
  }

  /** Stable type parameter objects of a generic method or function. */
  private readonly fnParams = new Map<A.Method | A.FunctionNode, TypeParamInfo[]>();
  typeParamsOf(m: A.Method | A.FunctionNode): TypeParamInfo[] {
    let ps = this.fnParams.get(m);
    if (!ps) {
      const seen = new Set<string>();
      ps = (m.typeParams ?? []).flatMap((p) => {
        if (seen.has(p.name)) {
          this.diags.error("X0796", `type parameter \`${p.name}\` is declared twice`, p.span);
          return [];
        }
        seen.add(p.name);
        return [{ name: p.name }];
      });
      this.fnParams.set(m, ps);
    }
    return ps;
  }

  /**
   * Type parameters visible in a member's signature: the class's (not for statics, which have no
   * instance to give them a meaning) plus the method's own.
   */
  memberParams(info: ClassInfo, m: A.Member): TypeParamScope {
    const own = m.kind === "Method" ? this.typeParamsOf(m) : [];
    return paramScope(m.modifiers.static ? [] : info.typeParams, own);
  }
}

/** Looks a member up on a class and its Xenon superclasses (implementations only, no interfaces). */
export function findClassMember(info: ClassInfo, name: string): MemberSig | undefined {
  const own = info.members.get(name);
  if (own) return own;
  for (const sup of superclasses(info)) {
    const m = sup.members.get(name);
    if (m) return m;
  }
  return undefined;
}

/** Looks a member up on a class or interface: the class chain first, then implemented interfaces. */
export function findMember(info: ClassInfo, name: string): MemberSig | undefined {
  const m = findClassMember(info, name);
  if (m) return m;
  for (const t of supertypes(info)) {
    const im = t.decl.isInterface ? t.members.get(name) : undefined;
    if (im) return im;
  }
  return undefined;
}

/** Can values of this type be used with `using`? (`*` is checked at runtime.) */
function disposeKind(t: Type, env: Env): "sync" | "async" | "none" | "dynamic" {
  if (isDynamic(t) || t.kind === "null") return "dynamic";
  if (t.kind !== "class") return "none";
  // A scoped class: `using` is redundant, reported by src/scoped.ts (X0827).
  if (chainDestructor(t.info)) return "dynamic";
  const iSync = env.classes.get("xenon.IDisposable");
  const iAsync = env.classes.get("xenon.IAsyncDisposable");
  if (iAsync && isSubclass(t.info, iAsync)) return "async";
  if (iSync && isSubclass(t.info, iSync)) return "sync";
  return "none";
}

/** Opted into manual disposal: implements `IDisposable` or `IAsyncDisposable` (directly, through an interface or a parent). */
export function isManualDisposable(info: ClassInfo): boolean {
  for (const t of supertypes(info)) if (t.qname === "xenon.IDisposable" || t.qname === "xenon.IAsyncDisposable") return true;
  return false;
}

/**
 * A scoped class: it has a destructor (its own or inherited) and doesn't opt into manual disposal.
 * Its instances are destroyed at the end of the scope that owns them (src/scoped.ts).
 */
export function isScoped(info: ClassInfo): boolean {
  return !!chainDestructor(info) && !isManualDisposable(info);
}

/** The destructor a class runs: its own or the nearest inherited one. */
export function chainDestructor(info: ClassInfo): { decl: A.Method; async: boolean; owner: ClassInfo } | undefined {
  for (const c of [info, ...superclasses(info)]) if (c.dtor) return { ...c.dtor, owner: c };
  return undefined;
}

/** A `const` method, or an accessor whose getter is `const`. */
function isConstMember(m: MemberSig): boolean {
  if (m.kind === "method") return m.decl.kind === "Method" && m.decl.isConst;
  if (m.kind === "accessor") {
    const getter = [m.decl, m.decl2].find((d) => d?.kind === "Method" && d.accessor === "get") as A.Method | undefined;
    return !!getter?.isConst;
  }
  return true;
}

/** An abstract member of a class (interface members are handled separately). */
function isAbstract(m: MemberSig): boolean {
  if (m.kind === "field" || m.isStatic) return false; // invalid abstract declarations are reported elsewhere
  return !!m.decl.modifiers.abstract || !!m.decl2?.modifiers.abstract;
}

/** Differences that keep `impl` from standing in for `req` (parameters, return type, kind). */
function signatureDiffs(impl: MemberSig, req: MemberSig): string[] {
  const diffs: string[] = [];
  if (isConstMember(req) && !isConstMember(impl)) diffs.push("the interface member is `const`, so the implementation must be `const` too");
  if (impl.kind !== req.kind) {
    diffs.push(req.kind === "accessor" ? "it must be a getter/setter" : "it must be a method");
    return diffs;
  }
  if (impl.kind === "accessor") {
    if (!sameType(impl.type, req.type)) diffs.push(`type \`${typeToString(impl.type)}\` instead of \`${typeToString(req.type)}\``);
    return diffs;
  }
  const a = impl.type as MethodType;
  const b = alignTypeParams(req.type as MethodType, a);
  if ((a.typeParams?.length ?? 0) !== (b.typeParams?.length ?? 0)) diffs.push(`${a.typeParams?.length ?? 0} type parameter(s) instead of ${b.typeParams?.length ?? 0}`);
  if (a.params.length !== b.params.length) diffs.push(`${a.params.length} parameter(s) instead of ${b.params.length}`);
  a.params.forEach((p, i) => {
    const q = b.params[i];
    if (q && !sameType(p.type, q.type)) diffs.push(`parameter \`${p.name}\` is \`${typeToString(p.type)}\` instead of \`${typeToString(q.type)}\``);
  });
  if (!(a.ret.kind === "void" ? b.ret.kind === "void" : b.ret.kind !== "void" && assignable(a.ret, b.ret))) {
    diffs.push(`returns \`${typeToString(a.ret)}\` instead of \`${typeToString(b.ret)}\``);
  }
  return diffs;
}

/** A class's own type parameters as arguments (`Box<T>` inside `Box`). */
function ownArgs(info: ClassInfo): Type[] {
  return info.typeParams.map((param) => ({ kind: "typeParam", param }));
}

/** Renames `b`'s method type parameters to `a`'s (`map<U>` vs `map<V>`) so signatures can be compared. */
function alignTypeParams(b: MethodType, a: MethodType): MethodType {
  const bp = b.typeParams ?? [];
  const ap = a.typeParams ?? [];
  if (bp.length === 0 || bp.length !== ap.length) return b;
  return subst(b, new Map(bp.map((p, i) => [p, { kind: "typeParam", param: ap[i]! } as Type]))) as MethodType;
}

/** Source text of a stub implementing an interface member. */
function stubFor(m: MemberSig, indent: string, override = false): string {
  const d = m.decl as A.Method;
  const vis = override ? `override ${visibilityOf(d)}` : "public";
  const params = (m.kind === "method" ? (m.type as MethodType).params : []).map((p) => `${p.rest ? "..." : ""}${p.name}:${typeToString(p.type)}`);
  const ret = m.kind === "method" ? typeToString((m.type as MethodType).ret) : typeToString(m.type);
  const body = "{ throw new NotImplementedException() }";
  if (m.kind === "accessor") {
    const halves = accessorHalves(m);
    return halves.map((h) => h === "get"
      ? `${indent}${vis} function get ${m.name}():${ret} ${body}`
      : `${indent}${vis} function set ${m.name}(value:${ret}):void ${body}`).join("\n");
  }
  return `${indent}${vis} ${d.modifiers.async ? "async " : ""}function ${m.name}(${params.join(", ")}):${ret} ${body}`;
}

/** True if the class (or a superclass) extends a JS class, so unknown members may exist. */
/** Does the type name something declared only for a `.d.ts` (which a user file can't write)? */
function fromDeclarations(t: Type): boolean {
  switch (t.kind) {
    case "class": return t.info.file.file.generated || (t.args ?? []).some(fromDeclarations);
    case "builtin": return t.args.some(fromDeclarations);
    case "nullable": return fromDeclarations(t.inner);
    case "shape": case "method": return !!t.typedef?.file.file.generated;
    default: return false;
  }
}

function hasJsAncestor(info: ClassInfo): boolean {
  if (info.jsParent) return true;
  for (const sup of superclasses(info)) if (sup.jsParent) return true;
  return false;
}

/** JS error classes are hidden from Xenon code; each maps to the exception to use instead. */
const ERROR_HINTS: Record<string, string> = {
  Error: "Exception", TypeError: "TypeException", RangeError: "RangeException", SyntaxError: "Exception",
  ReferenceError: "Exception", EvalError: "Exception", URIError: "Exception", AggregateError: "Exception",
  SuppressedError: "Exception",
};

export type Visibility = "public" | "internal" | "protected" | "private";

export function visibilityOf(d: { modifiers: A.Modifiers }): Visibility {
  return d.modifiers.visibility?.value ?? "internal";
}

/** May code in class `from` use a member (or constructor) with this visibility declared in `owner`? */
function canAccess(vis: Visibility, owner: ClassInfo, from: ClassInfo): boolean {
  switch (vis) {
    case "public": return true;
    case "internal": return from.pkg === owner.pkg;
    case "protected": return from === owner || superclassesInclude(from, owner);
    case "private": return from === owner;
  }
}

function superclassesInclude(from: ClassInfo, owner: ClassInfo): boolean {
  for (const c of superclasses(from)) if (c === owner) return true;
  return false;
}

/** May code in package `pkg` use this class? File-private classes are already limited to their file. */
function classAccessible(info: ClassInfo, pkg: string): boolean {
  return info.filePrivate || info.pkg === pkg || visibilityOf(info.decl) === "public";
}

const VIS_DESCRIPTION: Record<Visibility, (owner: ClassInfo) => string> = {
  public: () => "public",
  internal: (o) => (o.pkg ? `internal to package \`${o.pkg}\`` : "internal to the top-level package"),
  protected: (o) => `protected in \`${o.decl.name.name}\``,
  private: (o) => `private to \`${o.decl.name.name}\``,
};


function accessorHalves(m: MemberSig): ("get" | "set")[] {
  return [m.decl, m.decl2].flatMap((d) => (d?.kind === "Method" && d.accessor ? [d.accessor] : []));
}

type CtorRef =
  | { kind: "declared"; decl: A.Method; type: MethodType; owner: ClassInfo }
  | { kind: "dynamic" } // inherited from a JS class: arguments unchecked
  | { kind: "none" }; // root class without a constructor: implicit, no parameters

/**
 * The constructor `new X(…)` / `super(…)` runs: the class's own, else the one it inherits
 * (a class without a constructor takes its parent's, like a JS default constructor).
 */
function resolveCtor(info: ClassInfo): CtorRef {
  const seen = new Set<ClassInfo>();
  let cur: ClassInfo | undefined = info;
  while (cur && !seen.has(cur)) {
    if (cur.ctor) return { kind: "declared", decl: cur.ctor.decl, type: cur.ctor.type, owner: cur };
    if (cur.jsParent) return { kind: "dynamic" };
    seen.add(cur);
    cur = cur.parent;
  }
  return { kind: "none" };
}

const NO_PARAMS: MethodType = { kind: "method", params: [], ret: T.void };

function requiresArgs(c: CtorRef): boolean {
  return c.kind === "declared" && c.type.params.some((p) => !p.optional && !p.rest);
}

function allMemberNames(info: ClassInfo): string[] {
  return [...supertypes(info)].flatMap((c) => [...c.members.keys()]);
}

/* ===================================================================== */

/** The innermost function being checked: a method, a function expression or an arrow. */
interface MethodContext {
  /** Type `return` values are checked against (for async functions: the `T` of `Promise<T>`). */
  ret: Type;
  retSpan?: Span;
  isConstructor: boolean;
  name: string;
  async: boolean;
  /** Where `async ` would be inserted by a fix-it. */
  asyncAt: Span;
}

/** Checks member initializers and method bodies of one class. */
class BodyChecker {
  private isStatic = false;
  private method?: MethodContext;
  /** Enclosing loops/switches, innermost last (for `break`/`continue`). */
  private targets: ("loop" | "switch")[] = [];
  /** Definite-assignment state of `final` locals/fields that must be assigned exactly once. */
  private da = new Map<object, DAState>();
  /** Null safety: `var` fields without a value whose type excludes `null` (tracked in `da` like `final` ones). */
  private nonNullFields = new Set<MemberSig>();
  /** Null safety: such `var` locals (`var s:String` with no value), assigned before they're read. */
  private nonNullLocals = new Set<object>();
  /** Loop depth at which each tracked entity was declared (assigning it in a deeper loop is an error). */
  private daDepth = new Map<object, number>();
  private loopDepth = 0;
  /** The expression being checked is the target of a plain `=` (not a read). */
  private writing = false;
  /** The constructor's leading `super(...)` call, the only place one is allowed. */
  private superCall?: A.Expr;
  /** Checking the arguments of `super(...)`: `this` doesn't exist yet. */
  private beforeSuper = false;
  /** Nesting depth of `function(){}` expressions (dynamic `this`) around the current code. */
  private dynamicThis = 0;
  /** Checking a field initializer (no enclosing method). */
  private fieldInit = false;
  /** Signatures of hoisted local functions. */
  private fnSigs = new Map<A.FunctionNode, MethodType>();
  /** Type parameters in scope (class and enclosing generic methods/functions). */
  private tparams: TypeParamScope = new Map();
  /** Expressions already checked during generic inference; `expr` returns their type once. */
  private preTyped = new Map<A.Expr, Type>();
  /** Overloaded native members by callee expression (seen through the object's type arguments). */
  private calleeOverloads = new Map<A.Expr, { decl: A.Method; type: MethodType }[]>();

  /** Expected type of the call/`new` being checked (consumed on entry). */
  private expected?: Type;
  private takeExpected(): Type | undefined {
    const t = this.expected;
    this.expected = undefined;
    return t;
  }

  /** Resolves a type annotation in the current type-parameter scope. */
  private resolveT(node: A.TypeNode, _scope: FileScope, allowVoid = false, allowRaw = false): Type {
    return this.env.resolveType(node, this.scope, allowVoid, this.tparams, allowRaw);
  }

  /** The type of `this`: `Box<T>` inside a generic class. */
  private get thisType(): Type {
    return ownType(this.info);
  }

  /** A member's type as seen through `obj` (generic arguments substituted). */
  private seenThrough(obj: Type, m: MemberSig): Type {
    if (m.isStatic) return m.type;
    if (obj.kind === "class") return memberTypeIn(obj.info, obj.args ?? [], m.owner, m.type);
    return m.type;
  }
  /** Locals holding a newly created disposable (for X0801): were they disposed or did they escape? */
  private disposables = new Map<Local, { name: A.Ident; disposed: boolean; escaped: boolean; type: string }>();
  /** Locals declared in the current method (for the unused-variable warning). */
  private declared: { local: Local; name: A.Ident; fn?: boolean }[] = [];
  /** Name of the enclosing `const` method: `this` is read-only there (arrows inherit it). */
  private constMethod?: string;
  /** Reads of a variable whose null check is outside the enclosing function expression (for an X0398 note). */
  private narrowingBlocked = new Set<A.Expr>();
  /** The callee of the call being checked (`d?.bark` in `d?.bark()`): a method there isn't taken as a value. */
  private calledCallee?: A.Expr;
  /** The identifier currently used as the object of a member access (`x` in `x.dispose()`). */
  private memberObject?: A.Expr;
  private memberName = "";

  constructor(
    private env: Env,
    private info: ClassInfo,
    private scope: FileScope,
  ) {}

  private get diags() {
    return this.env.diags;
  }

  /**
   * The attributes of this class and its members (src/attributes.ts): each is a `new` of an
   * attribute class with constant arguments, allowed on its target by the class's `Usage`.
   */
  private checkAttributes() {
    const decl = this.info.decl;
    const scope = new Scope();
    this.isStatic = true;
    this.tparams = new Map();
    const iface = this.env.classes.get("xenon.IAttribute");
    const check = (owner: A.ClassDecl | A.Method | A.Field, target: "Class" | "Method" | "Field", what: string) => {
      const list = owner.attributes;
      if (!list?.length) return;
      const seen = new Map<ClassInfo, A.Attribute>();
      const emitted: { node: A.Attribute; create: A.Expr & { kind: "New" } }[] = [];
      for (const a of list) {
        const t = this.resolveT(a.name, this.scope, false, true);
        if (t.kind === "error") continue;
        const info = t.kind === "class" && !t.info.decl.isInterface && !t.info.decl.isEnum ? t.info : undefined;
        if (!info) {
          this.diags.error("X0833", `\`${typeToString(t)}\` isn't an attribute class`, a.name.span, "not a class");
          continue;
        }
        if (iface && !isSubclass(info, iface)) {
          this.diags.error("X0832", `\`${info.decl.name.name}\` isn't an attribute: it doesn't implement \`IAttribute\``, a.name.span)
            .secondary(info.decl.name.span, "declared here")
            .help(`add \`implements IAttribute\` to \`${info.decl.name.name}\``);
          continue;
        }
        const usage = attributeUsage(info);
        if (!usage.targets.has(target)) {
          const allowed = [...usage.targets].map((x) => x.toLowerCase() + (x === "Class" ? "es" : "s")).join(", ");
          const d = this.diags.error("X0834", `\`${info.decl.name.name}\` can't be used on ${what}`, a.name.span, `allowed on ${allowed}`);
          if (usage.node) d.secondary(usage.node.span, "where it may be used");
        }
        const first = seen.get(info);
        if (first && !usage.multiple) {
          const d = this.diags.error("X0835", `\`${info.decl.name.name}\` is used more than once here`, a.name.span, "repeated")
            .secondary(first.name.span, "first used here");
          if (usage.node) d.secondary(usage.node.span, "`multiple = true` would allow it");
        }
        seen.set(info, a);
        // A wrapping attribute on a `constexpr` method: calls with constant arguments are computed
        // when compiling, so the wrapper would only see the others.
        const wrap = findMember(info, "wrap");
        if (owner.kind === "Method" && owner.modifiers.constexpr && wrap && !wrap.owner.decl.isInterface) {
          this.diags.error("X0838", `\`${info.decl.name.name}\` wraps the method, which can't be \`constexpr\``, a.name.span, "defines `wrap`")
            .secondary(owner.modifiers.constexpr, "calls with constant arguments are computed when compiling")
            .note("the wrapper would run only for calls whose arguments are known at run time")
            .help("remove `constexpr`, or use an attribute without `wrap`");
        }
        // Checked like `new Route(args)`; its named values like assignments to its members.
        const create = { kind: "New" as const, callee: a.name, args: a.args, span: a.span };
        this.valueExpr(create, scope);
        for (const n of a.named) {
          const m = findMember(info, n.name.name);
          const writable = m && !m.isStatic && visibilityOf(m.decl) === "public" && (m.kind === "field" ? !m.readonly : m.kind === "accessor" && !!accessorHalf(m, "set"));
          if (!m || !writable) {
            const d = this.diags.error("X0837", `\`${n.name.name}\` can't be set on \`${info.decl.name.name}\``, n.name.span, m ? "not a public writable field or setter" : "no such member");
            if (m) d.secondary(m.decl.name.span, "declared here");
            this.valueExpr(n.value, scope);
            continue;
          }
          this.checkAssign(n.value, m.type, m.typeSpan && { span: m.typeSpan, label: "member type" }, scope);
        }
        for (const v of [...a.args, ...a.named.map((n) => n.value)]) {
          const arg = v.kind === "Spread" ? v.arg : v;
          if (!isConstantArgument(arg, (x) => this.constValue(x).ok, this.env.result)) {
            this.diags.error("X0836", "attribute arguments must be constants", arg.span, "not a compile-time constant")
              .note("literals, enum members, `inline` constants, `constexpr` calls and arrays of them: attributes are created from them at run time, without running other code");
          }
        }
        if (!COMPILE_TIME_ATTRIBUTES.has(info.qname)) emitted.push({ node: a, create });
      }
      if (emitted.length > 0) this.env.result.attributes.set(owner, emitted);
    };
    check(decl, "Class", "a class");
    for (const m of decl.members) {
      if (m.kind === "StaticBlock" || !m.attributes?.length) continue;
      if (m.kind === "Method" && (m.isConstructor || m.isDestructor || m.accessor || decl.isInterface)) {
        const what = m.isConstructor ? "a constructor" : m.isDestructor ? "a destructor" : m.accessor ? "a getter or setter" : "an interface member";
        const at = cover(m.attributes[0]!.span, m.attributes.at(-1)!.span);
        this.diags.error("X0834", `attributes can't be used on ${what}`, at, "not allowed here").note("attributes can be used on classes, methods and fields");
        continue;
      }
      check(m, m.kind === "Field" ? "Field" : "Method", m.kind === "Field" ? "a field" : "a method");
    }
    this.isStatic = false;
  }

  run() {
    this.checkAttributes();
    const members = this.info.decl.members;
    const finals = (isStatic: boolean) =>
      members.flatMap((m) => {
        if (m.kind !== "Field" || m.decl !== "final" || !!m.modifiers.static !== isStatic) return [];
        const sig = this.info.members.get(m.name.name);
        return sig && sig.decl === m ? [{ field: m, sig }] : [];
      });
    const instanceFinals = finals(false);
    const staticFinals = finals(true);
    // Null safety: a `var` field whose type excludes `null` (and whose default would be `null`)
    // needs a value by the end of the constructor (or the static blocks), like a `final` one.
    const nonNull = (isStatic: boolean) => !nullSafety.on ? [] :
      members.flatMap((m) => {
        if (m.kind !== "Field" || m.decl !== "var" || m.init || !!m.modifiers.static !== isStatic) return [];
        const sig = this.info.members.get(m.name.name);
        return sig && sig.decl === m && !isNullable(sig.type) && !isLegacyValueType(sig.type) ? [{ field: m, sig }] : [];
      });
    const instanceNonNull = nonNull(false);
    const staticNonNull = nonNull(true);
    for (const f of [...instanceNonNull, ...staticNonNull]) this.nonNullFields.add(f.sig);

    // Static `final` fields without a value must be assigned once, in `static { }` blocks.
    let staticDA = new Map<object, DAState>([...staticFinals.filter((f) => !f.field.init && !f.field.modifiers.inline), ...staticNonNull].map((f) => [f.sig, "no"]));

    for (const m of members) {
      this.isStatic = !!m.modifiers.static;
      this.targets = [];
      this.loopDepth = 0;
      this.constMethod = undefined;
      this.tparams = m.kind === "StaticBlock" ? new Map() : this.env.memberParams(this.info, m);
      if (m.kind === "StaticBlock") {
        this.method = undefined;
        this.da = staticDA;
        this.block(m.body, new Scope(undefined, assignmentWrites(m.body)));
        staticDA = this.da;
        continue;
      }
      this.da = new Map();
      const scope = new Scope(undefined, m.kind === "Method" && m.body ? assignmentWrites(m.body) : undefined);
      this.fieldInit = m.kind === "Field";
      if (m.kind === "Field") {
        this.method = undefined;
        const sig = this.info.members.get(m.name.name);
        if (!m.init || sig?.decl !== m) continue;
        if (isInline(sig)) {
          // The folded value decides: `inline final HALF:int = MAX / 2` is fine when the result is whole.
          this.valueExpr(m.init, scope);
          const f = this.env.inlineFold(sig);
          if (this.reportFold(f, m.name, sig.type, m.type?.span, m.init)) this.env.result.inlineFields.set(m, (f as { value: ConstValue }).value);
          continue;
        }
        this.checkAssign(m.init, sig.type, sig.typeSpan && { span: sig.typeSpan, label: "field type declared here" });
        continue;
      }
      this.superCall = undefined;
      if (m.isConstructor) {
        for (const f of instanceFinals) this.da.set(f.sig, f.field.init ? "yes" : "no");
        for (const f of instanceNonNull) this.da.set(f.sig, "no");
        const first = m.body?.body[0];
        if (first?.kind === "ExprStmt" && first.expr.kind === "Call" && first.expr.callee.kind === "Super") this.superCall = first.expr;
        else if (this.info.parent) {
          const pc = resolveCtor(this.info.parent);
          if (pc.kind === "declared") this.env.checkAccess(pc.decl, pc.owner, this.info, m.name.span, `the constructor of \`${pc.owner.decl.name.name}\` (called implicitly)`);
          if (pc.kind === "declared" && requiresArgs(pc)) {
            const name = pc.owner.decl.name.name;
            const d = this.diags.error("X0731", `the constructor must call \`super(...)\` first`, m.name.span, `\`${name}\`'s constructor needs arguments`);
            d.secondary(pc.decl.name.span, `\`${name}\` constructor`);
            if (m.body) {
              const at = m.body.span.start + 1;
              d.help("call the parent constructor first", [{ span: span(m.body.span.file, at, at), text: ` super(…)` }]);
            }
          }
        }
      }
      if (m.isDestructor) {
        if (!m.body) continue;
        const fnKw = m.span.file.text.indexOf("~", m.span.start);
        this.method = { ret: T.void, isConstructor: false, name: `~${m.name.name}`, async: !!m.modifiers.async, asyncAt: span(m.span.file, fnKw, fnKw) };
        this.disposables = new Map();
        this.declared = [];
        this.block(m.body, scope);
        this.reportUndisposed();
        this.reportUnusedLocals();
        continue;
      }
      this.constMethod = m.isConst && !m.modifiers.static && m.accessor !== "set" && !m.isConstructor ? m.name.name : undefined;
      const sig = this.info.members.get(m.name.name);
      const type = m.isConstructor ? this.info.ctor?.type : sig?.kind === "method" && sig.decl === m ? (sig.type as MethodType) : undefined;
      const ret = m.isConstructor || m.accessor === "set" ? T.void : m.accessor === "get" ? sig?.type ?? T.any : type?.ret ?? T.any;
      // `async` is inserted right before `function` by fix-its.
      const fnKw = m.span.file.text.indexOf("function", m.span.start);
      const asyncAt = span(m.span.file, fnKw >= 0 ? fnKw : m.span.start, fnKw >= 0 ? fnKw : m.span.start);
      let bodyRet = ret;
      if (m.modifiers.async) {
        if (m.isConstructor || m.accessor) {
          this.diags.error("X0761", `${m.isConstructor ? "constructors" : "getters and setters"} can't be \`async\``, m.modifiers.async);
        } else bodyRet = this.asyncResult(ret, m.returnType);
      }
      this.method = { ret: bodyRet, retSpan: m.accessor === "set" ? undefined : m.returnType?.span, isConstructor: m.isConstructor, name: m.name.name, async: !!m.modifiers.async, asyncAt };
      m.params.forEach((p, i) => {
        const pType = type?.params[i]?.type ?? (m.accessor === "set" && sig ? sig.type : T.any);
        if (p.init) this.checkAssign(p.init, pType, p.type && { span: p.type.span, label: "parameter type declared here" });
        scope.declare(p.name.name, { type: pType, kind: p.final ? "final" : "param", nameSpan: p.name.span, typeSpan: p.type?.span });
      });
      if (!m.body) continue;
      this.disposables = new Map();
      this.declared = [];
      this.block(m.body, scope);
      this.reportUndisposed();
      this.reportUnusedLocals();
      if (m.modifiers.constexpr) this.constexprBody(m, type);
      const close = span(m.body.span.file, m.body.span.end - 1, m.body.span.end);
      const needsValue = !m.isConstructor && m.accessor !== "set" && bodyRet.kind !== "void" && !isDynamic(bodyRet);
      if (needsValue && completes(m.body)) {
        const d = this.diags.error("X0314", `not all code paths of \`${m.name.name}\` return a value`, close, "execution can reach the end of the method here");
        if (m.returnType) d.secondary(m.returnType.span, `returns \`${typeToString(ret)}\``);
      }
      if (m.isConstructor && completes(m.body)) this.finalFieldsAssigned(close, "the constructor can end here");
    }

    // Without its own constructor a class inherits its parent's (like a JS default constructor).
    const inherited = !this.info.ctor && this.info.parent ? resolveCtor(this.info.parent) : undefined;
    if (inherited?.kind === "declared") {
      this.env.checkAccess(inherited.decl, inherited.owner, this.info, this.info.decl.name.span, `the constructor of \`${inherited.owner.decl.name.name}\` (inherited)`);
    }

    for (const f of staticFinals) {
      if (!f.field.init && !f.field.modifiers.inline && staticDA.get(f.sig) !== "yes") {
        this.diags.error("X0514", `static final field \`${f.field.name.name}\` is not assigned on every path`, f.field.name.span)
          .help("give it a value, or assign it in a `static { }` block");
      }
    }
    for (const f of staticNonNull) {
      if (staticDA.get(f.sig) !== "yes") this.nonNullFieldError(f.sig, "give it a value, assign it in a `static { }` block, or make its type nullable");
    }
    if (!this.info.ctor) {
      for (const f of instanceFinals) {
        if (!f.field.init) {
          this.diags.error("X0515", `final field \`${f.field.name.name}\` is never assigned`, f.field.name.span)
            .help("give it a value, or assign it in the constructor");
        }
      }
      for (const f of instanceNonNull) this.nonNullFieldError(f.sig, "give it a value, assign it in a constructor, or make its type nullable");
    }
  }

  /** X0819: a non-null field that would stay `null` (no value, no assignment). */
  private nonNullFieldError(m: MemberSig, help: string, at?: Span, label?: string) {
    const d = this.diags.error("X0819", `field \`${m.name}\` needs a value: \`${typeToString(m.type)}\` can't be null`, at ?? m.decl.name.span, label);
    if (at) d.secondary(m.decl.name.span, `\`${m.name}\` declared here without a value`);
    const typeSpan = m.typeSpan;
    d.help(help);
    if (typeSpan) d.help("make it nullable", [{ span: span(typeSpan.file, typeSpan.end, typeSpan.end), text: "?" }]);
  }

  /** In a constructor: every `final` field must be assigned when the constructor finishes. */
  private finalFieldsAssigned(at: Span, label: string) {
    for (const [key, state] of this.da) {
      const m = key as MemberSig;
      if (m.owner !== this.info || m.kind !== "field" || state === "yes") continue;
      if (this.nonNullFields.has(m)) {
        this.nonNullFieldError(m, "assign it on every path, give it a value, or make its type nullable", at, label);
        continue;
      }
      this.diags.error("X0514", `final field \`${m.name}\` is not assigned on every path through the constructor`, at, label)
        .secondary(m.decl.name.span, `\`${m.name}\` declared \`final\` here`);
    }
  }

  /* ------------------------- inline constants ------------------------- */

  /** Records a reference to an `inline` constant so codegen can paste its value. */
  private inlineRef(e: A.Expr, m: MemberSig) {
    if (!isInline(m)) return;
    const f = this.env.inlineFold(m);
    if (f.ok) this.env.result.inlineValues.set(e, f.value);
  }

  /** The value of an already type-checked expression, if it is a compile-time constant. */
  private constValue(e: A.Expr): Fold {
    return fold(e, (x, args, self) => {
      const v = this.env.result.inlineValues.get(x);
      if (v !== undefined) return { ok: true, value: v };
      if (x.kind === "Call" || x.kind === "New" || x.kind === "Binary") return this.env.constCall(x, args ?? [], { owner: this.info, scope: this.scope }, 0, self);
      if (x.kind === "Member" && self !== undefined) return this.env.constGet(x, self);
      return x.kind === "Member" ? this.env.constRef(x, this.info, this.scope) : undefined;
    });
  }

  /**
   * A `constexpr` function's types and body: constant types only (numbers, `String`, `Boolean`),
   * and an expression that only uses its parameters, literals, operators, `?:`, conversions,
   * inline constants, `Math`'s pure functions and constants, and `constexpr` functions (X0526).
   */
  private constexprBody(m: A.Method, type: MethodType | undefined) {
    // Values a compile-time evaluation can hold: primitives, and objects (of classes with a `constexpr` constructor).
    const constType = (t: Type) => {
      const n = nonNull(t);
      return (n.kind === "prim" && ["Int", "UInt", "Float", "String", "Bool"].includes(n.name)) || n.kind === "class";
    };
    const what = "a number, `String`, `Bool` or an object";
    if (type) {
      type.params.forEach((p, i) => {
        if (!constType(p.type)) this.diags.error("X0526", `a \`constexpr\` parameter must be ${what}`, m.params[i]!.type?.span ?? m.params[i]!.name.span, `\`${typeToString(p.type)}\``);
      });
      if (!m.isConstructor && !constType(type.ret)) this.diags.error("X0526", `a \`constexpr\` function must return ${what}`, m.returnType?.span ?? m.name.span, `\`${typeToString(type.ret)}\``);
    }
    if (!m.body) return;
    const params = new Set(m.params.map((p) => p.name.name));
    const instance = !m.modifiers.static;
    /** A local of the function (statically checked: a `constexpr` function has no outer locals). */
    const isLocal = (e: A.Expr) => e.kind === "Ident" && (params.has(e.name) || this.env.result.resolutions.get(e)?.kind === "local");
    /** A field of this object, named bare (`x`) or through `this` (`this.x`). */
    const ownField = (e: A.Expr): MemberSig | undefined => {
      if (!instance) return undefined;
      const name = e.kind === "Ident" && this.env.result.resolutions.get(e)?.kind === "member" ? e.name : e.kind === "Member" && e.object.kind === "This" ? e.name.name : undefined;
      const f = name === undefined ? undefined : findMember(this.info, name);
      return f?.kind === "field" && !f.isStatic ? f : undefined;
    };
    /**
     * A `constexpr` instance member of a value of type `t`: a method (`callee`: the call, for the
     * overload it chose) of an object, or of a string or number (`'a'.trim()`), or a native getter.
     */
    const constexprMethod = (t: Type | undefined, name: string, callee?: A.Expr) => {
      const n = t && nonNull(t);
      const info = n?.kind === "class" ? n.info : n?.kind === "prim" ? this.env.primClass(n.name) : undefined;
      const f = info && findMember(info, name);
      return !!f && !f.isStatic && isConstexpr(f, callee && this.env.result.overloadPicks.get(callee)?.chosen?.decl);
    };
    const bad = (e: A.Expr, what: string, label?: string) => {
      this.diags.error("X0526", `${what} isn't allowed in a \`constexpr\` function`, e.span, label)
        .secondary(m.modifiers.constexpr!, "`constexpr` here")
        .note("allowed: parameters and locals, `this` and its fields, literals, operators, `?:`, conversions like `Int()`, inline constants, `constexpr` functions (also the standard library's: `Math.floor`, `trim`, `replace`, …), methods and constructors, and the statements `if`, `while`, `for`, `switch`, `return`, `break` and `continue`");
      return false;
    };
    const ok = (e: A.Expr): boolean => {
      switch (e.kind) {
        case "Number": case "String": case "Bool": case "Null": case "Regex": return true;
        case "TypeCheck": return ok(e.expr);
        case "This": return instance || bad(e, "`this`");
        case "Template": return e.parts.every((p) => p.kind === "text" || ok(p.expr));
        case "Unary": return e.op === "typeof" || e.op === "delete" ? bad(e, `\`${e.op}\``) : ok(e.arg);
        case "Binary": {
          // An operator method must be `constexpr` too.
          if (this.env.result.operatorCalls.has(e)) {
            const op = ["==", "===", "!=", "!=="].includes(e.op) ? "==" : e.op;
            if (!constexprMethod(this.env.result.exprTypes.get(e.left), `operator${op}`)) return bad(e, `\`${e.op}\` on \`${typeToString(this.env.result.exprTypes.get(e.left) ?? T.any)}\``, `\`operator${op}\` is not \`constexpr\``);
          }
          return ok(e.left) && ok(e.right);
        }
        case "Conditional": return ok(e.cond) && ok(e.then) && ok(e.else);
        case "Ident": {
          if (isLocal(e) || ownField(e)) return true;
          return this.env.result.inlineValues.has(e) || bad(e, `\`${e.name}\``, "not a parameter, local, field or inline constant");
        }
        case "Member": {
          if (this.env.result.inlineValues.has(e)) return true;
          // A `constexpr` getter of the standard library: `s.length`.
          if (constexprMethod(this.env.result.exprTypes.get(e.object), e.name.name)) return ok(e.object);
          // A field of an object: only `final`/`const` fields, which a `constexpr` constructor can fill in.
          const t = this.env.result.exprTypes.get(e.object);
          const n = t && nonNull(t);
          const f = n?.kind === "class" ? findMember(n.info, e.name.name) : undefined;
          if (f?.kind === "field" && !f.isStatic) return ok(e.object);
          return bad(e, `\`${spanText(e.span)}\``, "not a field or an inline constant");
        }
        case "Call": {
          const c = e.callee;
          const allowed = (c.kind === "Ident" && BUILTIN_FNS.has(c.name) && c.name !== "trace" && this.env.result.resolutions.get(c)?.kind === "builtin")

            || !!this.env.constexprTarget(c, this.info, this.scope)
            || (c.kind === "Member" && constexprMethod(this.env.result.exprTypes.get(c.object), c.name.name, c) && ok(c.object))
            || (c.kind === "Ident" && instance && this.env.result.resolutions.get(c)?.kind === "member" && constexprMethod({ kind: "class", info: this.info }, c.name));
          return (allowed || bad(e, `calling \`${spanText(c.span)}\``, "not `constexpr`")) && e.args.every((a) => a.kind !== "Spread" && ok(a));
        }
        case "New": {
          const info = this.env.result.typeResolutions.get(e.callee);
          return (!!info?.ctor?.decl.modifiers.constexpr || bad(e, `\`new ${spanText(e.callee.span)}\``, "its constructor is not `constexpr`")) && e.args.every((a) => a.kind !== "Spread" && ok(a));
        }
        default: return bad(e, "this expression");
      }
    };
    /** An expression statement: an assignment or `++`/`--` to a local, or an allowed expression. */
    const effect = (e: A.Expr): boolean => {
      // Locals can change; a `constexpr` constructor also fills in its object's fields.
      const writable = (t: A.Expr) => isLocal(t) || (m.isConstructor && !!ownField(t));
      const why = m.isConstructor ? "only locals and this object's fields can change" : "only locals can change";
      if (e.kind === "Assign" && !this.env.result.operatorCalls.has(e)) return (writable(e.target) || bad(e.target, `assigning \`${spanText(e.target.span)}\``, why)) && ok(e.value);
      if (e.kind === "Update") return writable(e.arg) || bad(e.arg, `changing \`${spanText(e.arg.span)}\``, why);
      return ok(e);
    };
    const stmt = (st: A.Stmt): boolean => {
      switch (st.kind) {
        case "Block": return st.body.every(stmt);
        case "Empty": case "Break": case "Continue": return true;
        case "VarDecl": return !st.init || ok(st.init);
        case "ExprStmt": return effect(st.expr);
        case "Return": return !st.value || ok(st.value);
        case "If": return ok(st.cond) && stmt(st.then) && (!st.else || stmt(st.else));
        case "While": case "DoWhile": return ok(st.cond) && stmt(st.body);
        case "For": return (!st.init || (st.init.kind === "VarDecl" ? stmt(st.init) : effect(st.init.expr))) && (!st.cond || ok(st.cond)) && (!st.update || effect(st.update)) && stmt(st.body);
        case "ForRange": return !st.variable.pattern && ok(st.start) && (!st.end || ok(st.end)) && (!st.step || ok(st.step)) && stmt(st.body);
        case "Switch": return ok(st.discriminant) && st.cases.every((c) => (!c.test || ok(c.test)) && c.body.every(stmt));
        default: {
          const what = { Try: "`try`", Throw: "`throw`", ForOf: "`for … of`", ForIn: "`for … in`", FuncDecl: "a local function", UsingDecl: "`using`", UsingBlock: "`using`", DestructDecl: "destructuring", IfVar: "`if (var …)`", WhileVar: "`while (var …)`" }[st.kind] ?? "this statement";
          return bad({ span: st.span } as A.Expr, what);
        }
      }
    };
    stmt(m.body);
  }

  private constNumber(e: A.Expr): number | undefined {
    const f = this.constValue(e);
    return f.ok && typeof f.value === "number" ? f.value : undefined;
  }

  /** Reports a failed fold or a value that doesn't fit; returns true when the constant is usable. */
  private reportFold(f: Fold, name: A.Ident, type: Type, typeSpan: Span | undefined, init: A.Expr): boolean {
    if (!f.ok) {
      if (f.cycle) {
        this.diags.error("X0524", `inline constant \`${name.name}\` depends on itself`, name.span)
          .secondary(f.at, "this reference leads back to it");
      } else if (!f.reported) {
        this.diags.error("X0523", "inline initializer is not a compile-time constant", f.at, f.reason)
          .secondary(name.span, `\`${name.name}\` is declared \`inline\``)
          .note("allowed: literals, other inline constants, operators and `Int()`/`UInt()`/`Float()`/`String()`/`Bool()`");
      }
      return false;
    }
    if (f.value instanceof ConstObject) {
      this.diags.error("X0523", "an inline constant can't hold an object", init.span, "an object built at compile time")
        .secondary(name.span, `\`${name.name}\` is declared \`inline\``)
        .note("an inline constant is pasted into the code: it must be a number, `String` or `Bool`; use `static final` for an object");
      return false;
    }
    const enumOk = type.kind === "class" && type.info.decl.isEnum && [...(type.info.enumValues?.values() ?? [])].includes(f.value);
    if (!enumOk && !fits(f.value, type)) {
      const d = this.diags.error("X0525", `the value of \`${name.name}\` doesn't fit \`${typeToString(type)}\``, name.span, `evaluates to ${JSON.stringify(f.value)}`);
      if (typeSpan) d.secondary(typeSpan, "declared type");
      if ((isPrim(type, "Int") || isPrim(type, "UInt")) && typeof f.value === "number") {
        const fn = isPrim(type, "Int") ? "Int" : "UInt";
        d.help(`convert the value with \`${fn}()\``, [
          { span: span(init.span.file, init.span.start, init.span.start), text: `${fn}(` },
          { span: span(init.span.file, init.span.end, init.span.end), text: ")" },
        ]);
      }
      return false;
    }
    return true;
  }

  /* ----------------------- definite assignment ----------------------- */

  private snapshot(): Map<object, DAState> {
    return new Map(this.da);
  }

  /** Joins the states of several paths that meet; entities not known on every path went out of scope. */
  private join(states: Map<object, DAState>[], fallback: Map<object, DAState>) {
    if (states.length === 0) {
      this.da = new Map(fallback); // nothing continues past this point
      return;
    }
    const out = new Map<object, DAState>();
    for (const [key, first] of states[0]!) {
      const all = states.map((m) => m.get(key));
      if (all.some((v) => v === undefined)) continue;
      out.set(key, all.every((v) => v === first) ? first : "maybe");
    }
    this.da = out;
  }

  /** Reading a tracked `final` before it is (definitely) assigned is an error. */
  private daRead(key: object, at: Span, declSpan: Span, name: string) {
    if (this.writing) return;
    const state = this.da.get(key);
    if (state === "no") {
      this.diags.error("X0510", `${name} is used before it is assigned`, at).secondary(declSpan, "declared here without a value");
    } else if (state === "maybe") {
      this.diags.error("X0511", `${name} might not be assigned here`, at)
        .secondary(declSpan, "declared here without a value")
        .note("it is assigned on some paths but not on others");
    }
  }

  private daWrite(key: object, at: Span, declSpan: Span, name: string) {
    const state = this.da.get(key);
    if (this.loopDepth > (this.daDepth.get(key) ?? 0)) {
      this.diags.error("X0513", `${name} can't be assigned inside a loop or a function`, at)
        .secondary(declSpan, "declared `final` here")
        .note("the loop or function could run more than once");
    } else if (state === "yes") {
      this.diags.error("X0501", `cannot assign twice to ${name}`, at).secondary(declSpan, "declared `final` here");
    } else if (state === "maybe") {
      this.diags.error("X0512", `${name} might already be assigned`, at)
        .secondary(declSpan, "declared `final` here")
        .note("an earlier path may have assigned it");
    }
    this.da.set(key, "yes");
  }

  /** Runs a loop body: it may run zero or more times, and finals declared outside can't be assigned in it. */
  private loopBody(fn: () => void, atLeastOnce = false) {
    const before = this.snapshot();
    this.loopDepth++;
    try {
      this.inTarget("loop", fn);
    } finally {
      this.loopDepth--;
    }
    if (!atLeastOnce) this.join([before, this.snapshot()], before);
  }

  /* --------------------------- statements --------------------------- */

  private block(b: A.Block, parent: Scope): void {
    this.stmts(b.body, new Scope(parent));
  }

  /** Checks a statement list, warning once about code after a `return`/`throw`/`break`/`continue`. */
  private stmts(list: A.Stmt[], scope: Scope) {
    // Local functions are hoisted: they can be called before their declaration and call each other.
    for (const s of list) {
      if (s.kind !== "FuncDecl") continue;
      const prev = scope.getOwn(s.fn.name.name);
      if (prev) {
        this.diags.error("X0204", `\`${s.fn.name.name}\` is already declared in this scope`, s.fn.name.span).secondary(prev.nameSpan, "previously declared here");
      }
      const sig = this.fnSignature(s.fn, true);
      this.fnSigs.set(s.fn, sig);
      const fnLocal: Local = { type: sig, kind: "const", nameSpan: s.fn.name.span };
      this.declared.push({ local: fnLocal, name: s.fn.name, fn: true });
      scope.declare(s.fn.name.name, fnLocal);
    }
    let reachable = true;
    let warned = false;
    for (const s of list) {
      if (!reachable && !warned && s.kind !== "Empty") {
        const d = this.diags.warning("X0860", "unreachable code", s.span, "this is never executed");
        const prev = list[list.indexOf(s) - 1];
        // Typed functions already get X0313 with this explanation; untyped (`*`) ones only get this warning.
        if (prev?.kind === "Return" && prev.lineBreakBefore && this.method && isDynamic(this.method.ret) && !this.method.isConstructor) {
          d.note("a line break after `return` ends the statement; to return this value, put it on the same line as `return`");
        }
        warned = true;
      }
      this.stmt(s, scope);
      if (!completes(s)) reachable = false;
    }
  }

  private inTarget(kind: "loop" | "switch", fn: () => void) {
    this.targets.push(kind);
    try {
      fn();
    } finally {
      this.targets.pop();
    }
  }

  private nested(s: A.Stmt, scope: Scope) {
    if (s.kind === "Block") this.block(s, scope);
    else this.stmt(s, new Scope(scope));
  }

  private stmt(s: A.Stmt, scope: Scope): void {
    switch (s.kind) {
      case "Block":
        return this.block(s, scope);
      case "VarDecl":
        return this.varDecl(s, scope);
      case "ExprStmt":
        this.expr(s.expr, scope);
        return;
      case "Return":
        return this.returnStmt(s, scope);
      case "If": {
        this.condition(s.cond, scope);
        const f = this.facts(s.cond, scope);
        this.branches(s.then, s.else, scope.withFacts(f.whenTrue), scope.withFacts(f.whenFalse));
        // `if (x == null) return;`: the rest of the block knows `x` isn't null (and vice versa).
        if (!completes(s.then) && (!s.else || completes(s.else))) for (const l of f.whenFalse) scope.narrow(l);
        else if (s.else && !completes(s.else) && completes(s.then)) for (const l of f.whenTrue) scope.narrow(l);
        return;
      }
      case "IfVar":
        return this.branches(s.then, s.else, this.header(s.header, scope), scope);
      case "While": {
        this.unnarrowAssignedIn(s, scope);
        this.loopBody(() => {
          this.condition(s.cond, scope);
          this.nested(s.body, scope.withFacts(this.facts(s.cond, scope).whenTrue));
        });
        // `while (x == null) x = next()`: afterwards `x` isn't null (unless a `break` left early).
        if (!breaksOut(s.body)) for (const l of this.facts(s.cond, scope).whenFalse) scope.narrow(l);
        return;
      }
      case "WhileVar":
        this.unnarrowAssignedIn(s, scope);
        return this.loopBody(() => this.nested(s.body, this.header(s.header, scope)));
      case "DoWhile":
        this.unnarrowAssignedIn(s, scope);
        return this.loopBody(() => {
          this.nested(s.body, scope);
          this.condition(s.cond, scope);
        }, true);
      case "For":
        this.unnarrowAssignedIn(s, scope);
        return this.forStmt(s, scope);
      case "ForIn":
        this.unnarrowAssignedIn(s, scope);
        return this.forIn(s, scope);
      case "ForOf":
        this.unnarrowAssignedIn(s, scope);
        return this.forOf(s, scope);
      case "ForRange":
        this.unnarrowAssignedIn(s, scope);
        return this.forRange(s, scope);
      case "Switch":
        return this.switchStmt(s, scope);
      case "Throw": {
        const t = this.valueExpr(s.value, scope);
        const exc = this.env.exception;
        if (exc && !isDynamic(t) && !assignable(t, { kind: "class", info: exc })) {
          const d = this.diags.error("X0750", "only `Exception`s can be thrown", s.value.span, `this is \`${typeToString(t)}\``);
          if (isPrim(t, "String")) {
            d.help("wrap the message in an exception", [
              { span: span(s.value.span.file, s.value.span.start, s.value.span.start), text: "new Exception(" },
              { span: span(s.value.span.file, s.value.span.end, s.value.span.end), text: ")" },
            ]);
          }
          // `throw failure()` where `failure` is async: the exception is inside the promise.
          const inner = this.env.promiseArg(t);
          if (inner && !isDynamic(inner) && assignable(inner, { kind: "class", info: exc })) {
            if (this.method?.async) d.help("add `await`", [{ span: span(s.value.span.file, s.value.span.start, s.value.span.start), text: "await " }]);
            else d.note("the exception is the promise's result: `throw await …` inside an `async` function");
          }
        }
        return;
      }
      case "Try":
        return this.tryStmt(s, scope);
      case "FuncDecl":
        this.fnExpr(s.fn, scope);
        return;
      case "UsingDecl": {
        const type = this.usingResource(s.init, s.type, s.isAwait, s.span, scope);
        scope.declare(s.name.name, { type, kind: "const", nameSpan: s.name.span, typeSpan: s.type?.span });
        return;
      }
      case "UsingBlock": {
        const inner = new Scope(scope);
        for (const r of s.resources) {
          if (r.kind === "Decl") {
            const type = this.usingResource(r.init, r.type, s.isAwait, s.span, inner);
            inner.declare(r.name.name, { type, kind: "const", nameSpan: r.name.span, typeSpan: r.type?.span });
          } else this.usingResource(r.expr, undefined, s.isAwait, s.span, inner);
        }
        this.nested(s.body, inner);
        return;
      }
      case "DestructDecl": {
        let type: Type;
        if (s.type) {
          // Checked like `var x:T = …`, so array literals take their type from the annotation.
          type = this.resolveT(s.type, this.scope);
          this.checkAssign(s.init, type, { span: s.type.span, label: "expected because of this type" }, scope);
        } else type = this.valueExpr(s.init, scope);
        this.bindPattern(s.pattern, type, scope, s.decl);
        return;
      }
      case "Break":
        if (this.targets.length === 0) this.diags.error("X0340", "`break` outside of a loop or `switch`", s.span);
        return;
      case "Continue":
        if (!this.targets.includes("loop")) this.diags.error("X0341", "`continue` outside of a loop", s.span);
        return;
      case "Empty":
        return;
    }
  }

  private varDecl(s: A.VarDecl, scope: Scope) {
    const prev = scope.getOwn(s.name.name);
    if (prev) {
      this.diags.error("X0204", `\`${s.name.name}\` is already declared in this scope`, s.name.span)
        .secondary(prev.nameSpan, "previously declared here");
    }
    // Without an annotation the variable has its value's type (`var n = 0` is an `Int`); only a
    // value that says nothing (none, `null`) leaves it untyped.
    let inferred: Type | undefined;
    if (!s.type) {
      const d = this.diags.warning("X0850", `variable \`${s.name.name}\` has no type annotation; it is untyped (\`*\`)`, s.name.span);
      const initType = s.init ? this.expr(s.init, scope) : undefined;
      const at = span(s.name.span.file, s.name.span.end, s.name.span.end);
      const describable = initType && !isDynamic(initType) && !["null", "void", "method", "classRef"].includes(initType.kind) && !fromDeclarations(initType);
      if (describable) d.help("add the type of the initializer", [{ span: at, text: `:${typeToString(widen(initType))}` }]);
      else d.help("add a type, or `:*` to make it explicitly dynamic", [{ span: at, text: ":*" }]);
      const untypedLocal: Local = { type: T.any, kind: s.decl, nameSpan: s.name.span };
      this.declared.push({ local: untypedLocal, name: s.name });
      scope.declare(s.name.name, untypedLocal);
      return;
    }
    const type = inferred ?? this.resolveT(s.type!, this.scope);
    if (s.decl === "const" && !s.init) {
      this.diags.error("X0503", `constant \`${s.name.name}\` must be initialized`, s.name.span)
        .help("use `final` for a value assigned once later");
    }
    const local: Local = { type, kind: s.decl, nameSpan: s.name.span, typeSpan: s.type?.span };
    if (inferred) this.env.result.bindingTypes.set(s.name, type);
    this.declared.push({ local, name: s.name });
    if (s.init?.kind === "New" && type.kind === "class" && isManualDisposable(type.info) && !chainDestructor(type.info)) {
      this.disposables.set(local, { name: s.name, disposed: false, escaped: false, type: type.info.decl.name.name });
    }
    if (s.inline && s.decl !== "var" && s.init) {
      if (s.type) this.valueExpr(s.init, scope);
      const f = this.constValue(s.init);
      if (this.reportFold(f, s.name, type, s.type?.span, s.init)) local.inline = (f as { value: ConstValue }).value;
    } else {
      if (s.inline && s.decl === "var") inlineVar(this.diags.error("X0521", "an `inline` constant must be `final`", s.name.span, "declared with `var`"), s.name);
      if (s.inline && !s.init) this.diags.error("X0522", `inline constant \`${s.name.name}\` needs a value`, s.name.span);
      if (s.init && s.type) this.checkAssign(s.init, type, { span: s.type.span, label: "expected because of this type" }, scope);
    }
    // A `final` without a value, and (null safety) a `var` whose type excludes `null`: assigned before it's read.
    const nonNullVar = nullSafety.on && s.decl === "var" && !s.init && !isNullable(type) && !isLegacyValueType(type);
    if ((s.decl === "final" && !s.init) || nonNullVar) {
      this.da.set(local, "no");
      this.daDepth.set(local, this.loopDepth);
      if (nonNullVar) this.nonNullLocals.add(local);
    }
    scope.declare(s.name.name, local);
  }

  /**
   * The type a variable without an annotation takes from its value: the value's type with literal
   * types widened (`var n = 0` is an `Int`, not the type `0`). Literals, which have no type of
   * their own outside a context, get one from their parts: `['a', 'b']` is an `Array<String>`
   * (a union for mixed elements), `{ x: 1, name: 'a' }` the shape `{ x:Int, name:String }`.
   */
  private inferredType(e: A.Expr): Type {
    const own = this.env.result.exprTypes.get(e) ?? T.any;
    if (e.kind === "Array" && e.elements.length > 0 && e.elements.every((el) => el.kind !== "Spread")) {
      const elements = e.elements.map((el) => this.inferredType(el));
      return elements.some(isDynamic) || elements.some((t) => t.kind === "error") ? own : arrayOf(unionOf(elements));
    }
    if (e.kind === "Object" && e.props.length > 0 && e.props.every((p) => p.kind === "Prop" && !("expr" in p.key))) {
      const members = new Map<string, ShapeMember>();
      for (const p of e.props as (A.ObjectProp & { kind: "Prop" })[]) {
        const name = "name" in p.key ? p.key.name : (p.key as { value: string }).value;
        const t = this.inferredType(p.value);
        members.set(name, { name, optional: false, readonly: false, type: () => t });
      }
      return { kind: "shape", members };
    }
    return widen(own);
  }

  private returnStmt(s: A.Stmt & { kind: "Return" }, scope: Scope) {
    const m = this.method;
    if (!m) return;
    if (m.isConstructor) this.finalFieldsAssigned(s.span, "the constructor can return here");
    if (!s.value) {
      if (!m.isConstructor && m.ret.kind !== "void" && !isDynamic(m.ret)) {
        const d = this.diags.error("X0313", `\`${m.name}\` must return a \`${typeToString(m.ret)}\``, s.span, "missing return value");
        if (m.retSpan) d.secondary(m.retSpan, "return type declared here");
        if (s.lineBreakBefore) {
          d.secondary(s.lineBreakBefore, "this is a separate statement")
            .note("a line break after `return` ends the statement; put the value on the same line");
        }
      }
      return;
    }
    if (m.isConstructor || m.ret.kind === "void") {
      this.expr(s.value, scope);
      const d = this.diags.error("X0312", `${m.isConstructor ? "a constructor" : `\`${m.name}\``} can't return a value`, s.value.span);
      if (m.retSpan) d.secondary(m.retSpan, "declared `Void` here");
      return;
    }
    const origin = m.retSpan && { span: m.retSpan, label: "expected because of this return type" };
    // `return response.json()` in an `async` function: a promise is waited for (as `return await …`),
    // so its value must fit. Literals are still typed from the return type.
    const promise = this.env.promiseClass;
    if (m.async && promise && !["Array", "Object", "Function"].includes(s.value.kind)) {
      const t = this.valueExpr(s.value, scope);
      const n = nonNull(t);
      if (n.kind === "class" && n.info === promise) {
        const value = n.args?.[0] ?? T.any;
        if (!assignable(value, m.ret)) this.mismatch(s.value, t, m.ret, origin);
        return;
      }
      this.preTyped.set(s.value, t);
    }
    this.checkAssign(s.value, m.ret, origin, scope);
  }

  /**
   * `try`/`catch`/`finally`. Catch types must be exceptions; a catch after one that already
   * catches its type is unreachable. Definite assignment: a catch may start after any part of
   * the `try` ran, so assignments made in the `try` are only "maybe" there.
   */
  private tryStmt(s: A.Stmt & { kind: "Try" }, scope: Scope) {
    const exc = this.env.exception;
    const before = this.snapshot();
    this.block(s.block, scope);
    const afterTry = this.snapshot();
    const ends: Map<object, DAState>[] = completes(s.block) ? [afterTry] : [];
    const caught: { info: ClassInfo; span: Span }[] = [];
    for (const c of s.catches) {
      let info = exc;
      if (c.type) {
        const t = this.resolveT(c.type, this.scope);
        if (t.kind === "class" && exc && isSubclass(t.info, exc)) info = t.info;
        else if (t.kind === "any") {
          this.diags.error("X0752", "`catch (e:*)` is not allowed: everything caught is an `Exception`", c.type.span)
            .help("catch `Exception`", [{ span: c.type.span, text: "Exception" }]);
        } else if (t.kind !== "error") {
          this.diags.error("X0751", `\`${typeToString(t)}\` is not an \`Exception\` and can't be caught`, c.type.span)
            .note("catch `Exception` or one of its subclasses");
        }
      }
      const shadow = info && caught.find((p) => isSubclass(info!, p.info));
      if (shadow && info) {
        this.diags.error("X0753", "unreachable `catch`", c.type?.span ?? c.name.span, `\`${info.decl.name.name}\` is already caught above`)
          .secondary(shadow.span, `catches \`${shadow.info.decl.name.name}\``);
      } else if (info) caught.push({ info, span: c.type?.span ?? c.name.span });
      const catchScope = new Scope(scope);
      catchScope.declare(c.name.name, { type: info ? { kind: "class", info } : T.any, kind: "var", nameSpan: c.name.span, typeSpan: c.type?.span });
      this.join([before, afterTry], before);
      this.block(c.body, catchScope);
      if (completes(c.body)) ends.push(this.snapshot());
    }
    if (s.finally) {
      // `finally` runs after any of the paths above (or after an exception escaped).
      this.join([before, afterTry, ...ends], before);
      this.block(s.finally, scope);
      if (ends.length > 0) {
        const afterFinally = this.snapshot();
        this.join(ends, before);
        for (const [k, v] of afterFinally) if (v === "yes") this.da.set(k, "yes");
      }
      return;
    }
    this.join(ends, before);
  }

  /** `then`/`else` branches: definite assignment joins the paths that continue afterwards. */
  private branches(then: A.Stmt, els: A.Stmt | undefined, thenScope: Scope, elseScope: Scope) {
    const before = this.snapshot();
    const ends: Map<object, DAState>[] = [];
    this.nested(then, thenScope);
    if (completes(then)) ends.push(this.snapshot());
    this.da = new Map(before);
    if (els) {
      this.nested(els, elseScope);
      if (completes(els)) ends.push(this.snapshot());
    } else ends.push(before);
    this.join(ends, before);
  }

  /* ----------------------------- loops ----------------------------- */

  /** Checks an `if (var …)` / `while (var …)` header; returns the scope holding its bindings. */
  private header(items: A.HeaderItem[], scope: Scope): Scope {
    const inner = new Scope(scope);
    for (const item of items) {
      if (item.kind === "Cond") {
        this.condition(item.expr, inner);
        for (const l of this.facts(item.expr, inner).whenTrue) inner.narrow(l);
        continue;
      }
      if (mentions(item.init, item.name.name) && scope.get(item.name.name)) {
        this.diags.error("X0321", `the value bound to \`${item.name.name}\` refers to another \`${item.name.name}\``, item.init.span)
          .secondary(item.name.span, "binding declared here")
          .help("give the binding a different name");
      }
      let type: Type;
      if (item.type) {
        // `if (var n:int = maybe)`: the value may be `int?`; inside the block `n` is an `int`.
        type = nonNull(this.resolveT(item.type, this.scope));
        this.checkAssign(item.init, nullableOf(type), { span: item.type.span, label: "expected because of this type" }, inner);
        const init = this.env.result.exprTypes.get(item.init);
        if (init && !isNullable(init) && !isDynamic(init)) {
          this.diags.error("X0320", `this value can never be null; use a normal condition`, item.init.span, `\`${typeToString(init)}\``)
            .note("`if (var x:T = …)` runs its block only when the value is not null");
        }
      } else {
        // `if (var n = maybe)`: the value's type without `null` (the block runs only when it isn't).
        const init = this.valueExpr(item.init, inner);
        type = init.kind === "null" ? this.env.untyped(item.name.span, `binding \`${item.name.name}\``) : nonNull(widen(init));
        this.env.result.bindingTypes.set(item.name, type);
      }
      inner.declare(item.name.name, { type, kind: "var", nameSpan: item.name.span, typeSpan: item.type?.span });
    }
    return inner;
  }

  /** Declares a `for (… in/of …)` loop variable after checking it against the element type. */
  private loopVar(v: A.LoopVar, element: Type, scope: Scope, what: string, kind: Local["kind"] = v.decl) {
    if (v.pattern) {
      // `for (var [k, v] of …)`: an annotation states the element type; otherwise it comes from the
      // source. Tuples (a map's `Tuple<K, V>`) keep their positions' types under a `:*` too.
      const declared = v.type && this.resolveT(v.type, this.scope);
      const source = declared && !(isDynamic(declared) && tupleElements(element)) ? declared : element;
      if (v.type && !assignable(element, source)) {
        this.diags.error("X0308", "mismatched types", v.type.span, `the ${what} are \`${typeToString(element)}\``);
      }
      this.bindPattern(v.pattern, source, scope, v.decl === "var" ? "var" : v.decl);
      return;
    }
    let type: Type;
    if (v.type) {
      type = this.resolveT(v.type, this.scope);
      if (!assignable(element, type)) {
        this.diags.error("X0308", "mismatched types", v.type.span, `the ${what} are \`${typeToString(element)}\``)
          .secondary(v.name.span, `\`${v.name.name}\` declared as \`${typeToString(type)}\``);
      }
    } else {
      // Without an annotation: the element type (`for (var name of names)` is a `String`).
      type = element;
      this.env.result.bindingTypes.set(v.name, type);
    }
    scope.declare(v.name.name, { type, kind, nameSpan: v.name.span, typeSpan: v.type?.span, captureUnstable: true });
  }

  private forStmt(s: A.Stmt & { kind: "For" }, outer: Scope) {
    const scope = new Scope(outer);
    if (s.init?.kind === "VarDecl") this.varDecl(s.init, scope);
    else if (s.init) this.expr(s.init.expr, scope);
    this.loopBody(() => {
      if (s.cond) this.condition(s.cond, scope);
      this.nested(s.body, s.cond ? scope.withFacts(this.facts(s.cond, scope).whenTrue) : scope);
      if (s.update) this.expr(s.update, scope);
    });
  }

  private forIn(s: A.Stmt & { kind: "ForIn" }, outer: Scope) {
    const scope = new Scope(outer);
    const t = this.valueExpr(s.object, outer);
    if (t.kind === "prim" || t.kind === "null") {
      this.diags.error("X0392", `can't iterate over the keys of \`${typeToString(t)}\``, s.object.span);
    }
    this.loopVar(s.variable, T.String, scope, "keys");
    this.loopBody(() => this.nested(s.body, scope));
  }

  private forOf(s: A.Stmt & { kind: "ForOf" }, outer: Scope) {
    const scope = new Scope(outer);
    const t = this.valueExpr(s.iterable, outer);
    let element: Type = T.any;
    const arrayElement = elementOf(t) ?? this.env.iterableElement(t);
    if (arrayElement) element = arrayElement;
    else if (isPrim(t, "String")) element = T.String;
    else if (t.kind === "builtin" && t.name === "Object") {
      const e = s.iterable.span;
      this.diags.error("X0390", "an `Object` is not iterable", e, "plain objects can't be used with `of`")
        .help("iterate over its values", [
          { span: span(e.file, e.start, e.start), text: "Object.values(" },
          { span: span(e.file, e.end, e.end), text: ")" },
        ]);
      element = T.error;
    } else if (t.kind === "prim" || t.kind === "null" || t.kind === "classRef" || t.kind === "method" ||
      (t.kind === "builtin" && t.name !== "Array") || (t.kind === "class" && !hasJsAncestor(t.info))) {
      const d = this.diags.error("X0391", `\`${typeToString(t)}\` is not iterable`, s.iterable.span);
      if (t.kind === "class") d.help(`implement \`Iterable<T>\` in \`${t.info.decl.name.name}\`: \`function getEnumerator():IEnumerator<T>\``);
      element = T.error;
    }
    this.loopVar(s.variable, element, scope, "elements");
    this.loopBody(() => this.nested(s.body, scope));
  }

  private forRange(s: A.Stmt & { kind: "ForRange" }, outer: Scope) {
    const scope = new Scope(outer);
    for (const bound of [s.start, s.end]) {
      if (!bound) continue;
      const t = this.valueExpr(bound, outer);
      if (!isPrim(t, "Int") && !isPrim(t, "UInt") && !isDynamic(t)) {
        this.diags.error("X0334", "range bounds must be `Int` or `UInt`", bound.span, `found \`${typeToString(t)}\``);
      }
    }
    let integerStep = true;
    if (s.step) {
      this.valueExpr(s.step, outer);
      const step = this.constNumber(s.step);
      if (step === undefined) {
        this.diags.error("X0330", "a range `step` must be a constant", s.step.span).note("use a C-style `for` for a computed step");
      } else if (step === 0) {
        this.diags.error("X0330", "a range `step` can't be 0", s.step.span, "the step must be positive");
      } else if (step < 0) {
        this.diags.error("X0330", "ranges can't count down", s.step.span, "the step must be positive")
          .help("use a C-style `for`, e.g. `for (var i:Int = 10; i >= 0; i--)`");
      } else integerStep = Number.isInteger(step);
    }
    const a = this.constNumber(s.start);
    const b = s.end && this.constNumber(s.end);
    if (a !== undefined && b !== undefined && (s.inclusive ? a > b : a >= b)) {
      this.diags.warning("X0331", `range \`${a}${s.inclusive ? "..=" : ".."}${b}\` is empty and runs 0 times`, cover(s.start.span, s.end!.span))
        .note("ranges never count down; use a C-style `for` for that");
    }
    const declared = s.variable.type ? this.resolveT(s.variable.type, this.scope) : undefined;
    if (declared && !isNumeric(declared) && !isDynamic(declared)) {
      this.diags.error("X0334", "a range loop variable must be a number", s.variable.type!.span);
    } else if (declared && !integerStep && !isPrim(declared, "Float")) {
      this.diags.error("X0330", "a fractional `step` needs a `Float` loop variable", s.step!.span);
    }
    const element = declared && isPrim(declared, "UInt") ? T.uint : T.int;
    this.loopVar(s.variable, element, scope, "range values", "range");
    this.loopBody(() => this.nested(s.body, scope));
  }

  private switchStmt(s: A.Stmt & { kind: "Switch" }, scope: Scope) {
    const t = this.valueExpr(s.discriminant, scope);
    const seen = new Map<string, A.Expr>();
    let defaultCase: A.SwitchCase | undefined;
    for (const c of s.cases) {
      if (!c.test) {
        if (defaultCase) {
          this.diags.error("X0344", "a `switch` can only have one `default`", c.span).secondary(defaultCase.span, "first `default` here");
        }
        defaultCase = c;
        continue;
      }
      const ct = this.valueExpr(c.test, scope);
      if (!comparable(t, ct)) {
        this.diags.error("X0319", "this case can never match", c.test.span, `\`${typeToString(ct)}\``)
          .secondary(s.discriminant.span, `the switch value is \`${typeToString(t)}\``);
      }
      const key = this.literalKey(c.test);
      if (key !== undefined) {
        const prev = seen.get(key);
        if (prev) this.diags.error("X0343", "duplicate `case`", c.test.span).secondary(prev.span, "first used here");
        else seen.set(key, c.test);
      }
    }
    const before = this.snapshot();
    const ends: Map<object, DAState>[] = [];
    let previous: Map<object, DAState> | undefined; // state falling through from the previous case
    this.inTarget("switch", () => {
      for (const c of s.cases) {
        if (previous) this.join([before, previous], before);
        else this.da = new Map(before);
        this.stmts(c.body, new Scope(scope));
        const falls = c.body.every(completes);
        if (c.body.some(breaksOut) || (falls && c === s.cases.at(-1))) ends.push(this.snapshot());
        previous = falls ? this.snapshot() : undefined;
      }
    });
    if (!defaultCase) ends.push(before);
    this.join(ends, before);
    // A switch over an enum without `default` should handle every member.
    if (!defaultCase && t.kind === "class" && t.info.decl.isEnum && t.info.enumValues) {
      const handled = new Set(s.cases.map((c) => (c.test ? this.enumMemberName(c.test, t.info) : undefined)).filter((n) => n));
      const missing = [...t.info.enumValues.keys()].filter((n) => !handled.has(n));
      if (missing.length > 0) {
        this.diags.warning("X0814", `this \`switch\` doesn't handle ${missing.map((n) => `\`${t.info.decl.name.name}.${n}\``).join(", ")}`, s.discriminant.span)
          .help("add the missing cases, or a `default:`");
      }
    }
  }

  /** Conditions must be `Boolean` (no truthiness in Xenon). */
  private condition(e: A.Expr, scope: Scope) {
    if (e.kind === "Assign" && e.op === "=") {
      this.expr(e, scope);
      this.diags.error("X0322", "`=` assigns; it can't be used as a condition", e.opSpan, "assignment")
        .help("compare with `==`", [{ span: e.opSpan, text: "==" }])
        .note("to bind a value and test it, use `if (var x:T = …)`");
      return;
    }
    const t = this.expr(e, scope);
    if (isPrim(t, "Bool") || isDynamic(t)) return;
    const d = this.diags.error("X0310", "condition must be a `Bool`", e.span, `expected \`Bool\`, found \`${typeToString(t)}\``);
    const end = span(e.span.file, e.span.end, e.span.end);
    if (isNumeric(t)) d.help("compare explicitly", [{ span: end, text: " != 0" }]);
    else if (t.kind === "nullable" && isPrim(t.inner, "Bool")) d.help("compare with `true` (`null` and `false` both skip)", [{ span: end, text: " == true" }]);
    else if (isPrim(nonNull(t), "String")) {
      // JavaScript's `if (s)` means "not empty" (and not null): the same test, written out.
      d.help("a `String` is true in JavaScript when it isn't empty: compare explicitly", [{ span: end, text: " != ''" }]);
      if (isNullable(t)) d.note("`null` != '' is true too: write `s != null && s != ''` if `null` must count as empty");
    } else if (isNullable(t) && t.kind !== "null") d.help("check for null explicitly", [{ span: end, text: " != null" }]);
  }

  /* -------------------------- assignability -------------------------- */

  /** Checks that `e` can be stored where `expected` is wanted; reports X0308 with fix-its otherwise. */
  private checkAssign(e: A.Expr, expected: Type, origin?: { span: Span; label: string }, scope = new Scope()) {
    this.env.result.expectedTypes.set(e, expected);
    // Already checked while inferring a generic call: just compare.
    const pre = this.preTyped.get(e);
    if (pre) {
      this.preTyped.delete(e);
      if (!assignable(pre, expected) && !this.constantFits(e, expected)) this.mismatch(e, this.shownType(e, pre, expected), expected, origin);
      return;
    }
    // A literal is never null: against `Node?` it is checked against `Node` (null safety).
    if ((e.kind === "Object" || e.kind === "Function" || e.kind === "Array") && expected.kind === "nullable" && expected.inner.kind !== "union") {
      this.checkAssign(e, expected.inner, origin, scope);
      return;
    }
    // A literal against a union: checked against the member of its kind (`{…}` against the shape).
    if ((e.kind === "Object" || e.kind === "Function" || e.kind === "Array") && nonNull(expected).kind === "union") {
      const member = this.unionMemberFor(e, nonNull(expected) as UnionType);
      if (member) {
        this.checkAssign(e, member, origin, scope);
        return;
      }
    }
    // Generic calls and `new` can infer type arguments from the expected type.
    if (e.kind === "Call" || e.kind === "New") this.expected = expected;
    if (e.kind === "Object" && expected.kind === "shape") {
      this.objectAgainstShape(e, expected, scope);
      this.record(e, expected);
      return;
    }
    if (e.kind === "Function" && expected.kind === "method") {
      // Arrows and function expressions take parameter types from the expected function type.
      const t = this.record(e, this.fnExpr(e, scope, expected));
      if (!assignable(t, expected)) this.mismatch(e, t, expected, origin);
      return;
    }
    // `var pair:Tuple<String, int> = ['a', 1]`: one element per position, each checked against its type.
    const positions = e.kind === "Array" ? tupleElements(expected) : undefined;
    if (e.kind === "Array" && positions) {
      this.tupleLiteral(e, positions, expected, scope);
      return;
    }
    // Array literals take their type from context: `var v:Array<int> = [1, 2]`, also through an
    // interface arrays implement: `Iterable<int>`.
    const expectedElement = e.kind === "Array" ? elementOf(expected) ?? this.env.arrayElementFor(expected) : undefined;
    if (e.kind === "Array" && expectedElement) {
      const element = expectedElement;
      for (const el of e.elements) {
        if (el.kind === "Spread") this.spreadInto(el, element, scope);
        else this.checkAssign(el, element, origin, scope);
      }
      this.record(e, elementOf(expected) ? expected : arrayOf(element));
      return;
    }
    const actual = this.valueExpr(e, scope);
    if (assignable(actual, expected) || this.constantFits(e, expected)) return;
    this.mismatch(e, this.shownType(e, actual, expected), expected, origin);
  }

  /**
   * An argument's type for inferring type arguments against `pattern`. A literal for a tuple
   * (`['a', 1]` for `Tuple<K, V>`) is typed position by position (its elements are remembered in
   * `preTyped`; the literal itself is checked against the inferred tuple later); anything else whole.
   */
  private inferredLiteral(e: A.Expr, pattern: Type, scope: Scope): Type {
    const positions = tupleElements(pattern);
    if (e.kind === "Array" && positions && e.elements.length === positions.length && e.elements.every((el) => el.kind !== "Spread")) {
      return tupleOf(e.elements.map((el) => {
        const t = this.valueExpr(el, scope);
        this.preTyped.set(el, t);
        return widen(t);
      }));
    }
    const t = this.valueExpr(e, scope);
    this.preTyped.set(e, t);
    return t;
  }

  /** `...source` in an array literal of `element`s: what it spreads must fit (an untyped source passes). */
  private spreadInto(el: A.Expr & { kind: "Spread" }, element: Type, scope: Scope) {
    const t = this.valueExpr(el.arg, scope);
    const spread = elementOf(t) ?? this.env.iterableElement(t) ?? (isPrim(t, "String") ? T.String : undefined);
    if (spread && !assignable(spread, element)) {
      this.diags.error("X0308", "mismatched types", el.arg.span, `its elements are \`${typeToString(spread)}\`, expected \`${typeToString(element)}\``);
    }
  }

  /** An array literal for a `Tuple<…>`: as many elements as positions (X0323), no spread, each fitting its type. */
  private tupleLiteral(e: A.Expr & { kind: "Array" }, positions: Type[], expected: Type, scope: Scope) {
    const spread = e.elements.find((el) => el.kind === "Spread");
    if (spread) {
      this.diags.error("X0323", `a \`${typeToString(expected)}\` literal lists its elements one by one`, spread.span, "the length of a spread isn't known");
      for (const el of e.elements) this.valueExpr(el.kind === "Spread" ? el.arg : el, scope);
    } else if (e.elements.length !== positions.length) {
      const extra = e.elements[positions.length];
      this.diags.error("X0323", "wrong tuple length", extra?.span ?? e.span, `\`${typeToString(expected)}\` has ${positions.length} element${positions.length === 1 ? "" : "s"}, found ${e.elements.length}`);
    }
    if (!spread) e.elements.forEach((el, i) => (i < positions.length ? this.checkAssign(el, positions[i]!, undefined, scope) : this.valueExpr(el, scope)));
    this.record(e, expected);
  }

  /**
   * The member of a union an object, function or array literal is checked against: the first shape
   * it may fit (else the only shape), the function type, the array type.
   */
  private unionMemberFor(e: A.Expr, u: UnionType): Type | undefined {
    if (e.kind === "Object") {
      const shapes = u.types.filter((m): m is ShapeType => m.kind === "shape");
      return shapes.find((m) => this.objectMayFit(e, m)) ?? (shapes.length === 1 ? shapes[0] : undefined);
    }
    if (e.kind === "Function") return u.types.find((m) => m.kind === "method");
    return u.types.find((m) => elementOf(m) || this.env.arrayElementFor(m));
  }

  /**
   * A compile-time constant is accepted when its value fits: `var u:uint = 5`, `var h:int = MAX / 2`,
   * and a literal type takes a constant with its value (`withFileTypes:true` takes `true`).
   */
  private constantFits(e: A.Expr, expected: Type): boolean {
    const c = this.constValue(e);
    if (!c.ok) return false;
    if (isNumeric(expected) && typeof c.value === "number" && fits(c.value, expected)) return true;
    return valueFits(c.value, expected);
  }

  /** `expected \`false\`, found \`true\``: a constant against a literal type shows its value. */
  private shownType(e: A.Expr, actual: Type, expected: Type): Type {
    if (!membersOf(expected).some((m) => literalOf(m) !== undefined)) return actual;
    const c = this.constValue(e);
    return c.ok && (typeof c.value === "boolean" || typeof c.value === "string" || typeof c.value === "number") ? literalType(c.value) : actual;
  }

  /**
   * X0398: a `T?` value used where it must not be null (arithmetic, `.member`). Reports and returns
   * the non-null type, so checking continues as if it had been checked.
   */
  private mayBeNull(e: A.Expr, t: Type, written = false): Type {
    if (t.kind !== "nullable") return t;
    const d = this.diags.error("X0398", `this value may be null`, e.span, `\`${typeToString(t)}\``);
    const fallback = written ? undefined : defaultFor(t.inner); // `n++` can't become `(n ?? 0)++`
    const isField = (e.kind === "Ident" && this.env.result.resolutions.get(e)?.kind === "member") || e.kind === "Member";
    if (isField) d.note("a null check narrows only local variables and parameters (a field can change in between): copy it into a local first");
    if (this.narrowingBlocked.has(e)) {
      d.note("a null check outside a function expression doesn't reach into it: the variable could change before the function runs")
        .help(`copy it into a \`final\` local after the check: \`final value:${typeToString(t.inner)} = ${spanText(e.span)}\``);
      return t.inner;
    }
    if (fallback) d.help(`give a default with \`??\``, nullishFix(e, fallback, true));
    const local = e.kind === "Ident" && this.env.result.resolutions.get(e)?.kind === "local";
    const or = fallback ? "or " : "";
    d.help(local
      ? `${or}check it first: inside \`if (${spanText(e.span)} != null) { … }\` it can't be null`
      : `${or}check it first: \`if (var x:${typeToString(t.inner)} = …) { … }\` runs only when it isn't null`);
    return t.inner;
  }

  private mismatch(e: A.Expr, actual: Type, expected: Type, origin?: { span: Span; label: string }) {
    const d = this.diags.error("X0308", "mismatched types", e.span, `expected \`${typeToString(expected)}\`, found \`${typeToString(actual)}\``);
    if (origin) d.secondary(origin.span, origin.label);
    const wrap = (fn: string): Edit[] => [
      { span: span(e.span.file, e.span.start, e.span.start), text: `${fn}(` },
      { span: span(e.span.file, e.span.end, e.span.end), text: ")" },
    ];
    const value = nonNull(actual); // conversions also take `null` (`String(n)` of an `int?`)
    if (literalOf(expected) !== undefined) {
      // One value fits: no conversion helps.
      d.note(`\`${typeToString(nonNull(expected))}\` is a literal type: it takes only the value ${typeToString(nonNull(expected))}`);
    } else if ((isPrim(expected, "Int") || isPrim(expected, "UInt")) && (isNumeric(value) || isPrim(value, "String")) && !sameType(value, expected)) {
      const fn = isPrim(expected, "Int") ? "Int" : "UInt";
      d.help(`convert the value with \`${fn}()\``, wrap(fn));
    } else if (isPrim(expected, "Float") && isPrim(value, "String")) {
      d.help("convert the value with `Float()`", wrap("Float"));
    } else if (isPrim(expected, "String") && (isNumeric(value) || isPrim(value, "Bool"))) {
      d.help("convert the value with `String()`", wrap("String"));
    } else if (actual.kind === "nullable" && assignable(actual.inner, expected)) {
      const fallback = defaultFor(actual.inner);
      if (fallback) d.help(`the value may be null: give a default with \`??\``, nullishFix(e, fallback));
      else d.note("the value may be null");
    } else if (actual.kind === "null" && !isNullable(expected)) {
      d.note(`\`${typeToString(expected)}\` can never be null; \`${typeToString(expected)}${expected.kind === "union" && !expected.alias ? " | null" : "?"}\` can`);
    } else if (expected.kind === "shape" && (actual.kind === "shape" || actual.kind === "class")) {
      for (const note of shapeMismatch(actual, expected)) d.note(note);
    }
  }

  /* --------------------------- expressions --------------------------- */

  private record(e: A.Expr, t: Type): Type {
    this.env.result.exprTypes.set(e, t);
    return t;
  }

  private expr(e: A.Expr, scope: Scope): Type {
    const pre = this.preTyped.get(e);
    if (pre) {
      this.preTyped.delete(e);
      return pre;
    }
    return this.record(e, this.exprInner(e, scope));
  }

  private exprInner(e: A.Expr, scope: Scope): Type {
    switch (e.kind) {
      case "Ident":
        return this.ident(e, scope);
      case "Number":
        return numberLiteralType(e.raw, e.value);
      case "String":
        return T.String;
      case "Template":
        for (const p of e.parts) if (p.kind === "expr") this.valueExpr(p.expr, scope);
        return T.String;
      case "Regex": {
        const regexp = this.env.regexpClass;
        return regexp ? { kind: "class", info: regexp } : T.any;
      }
      case "Bool":
        return T.Boolean;
      case "Null":
        return T.null;
      case "Undefined":
        this.undefinedWarning(e.span, false);
        return T.any;
      case "This":
        if (this.beforeSuper) {
          this.diags.error("X0736", "`this` can't be used before `super(...)` returns", e.span);
          return T.error;
        }
        if (this.dynamicThis > 0) return T.any; // `function(){}` has a dynamic `this`
        if (this.isStatic) {
          this.diags.error("X0411", "`this` can't be used in a static context", e.span);
          return T.error;
        }
        return this.thisType;
      case "Super":
        this.diags.error("X0734", "`super` can only be used as `super(...)` or `super.member`", e.span);
        return T.error;
      case "Array": {
        const types = e.elements.map((el) => this.valueExpr(el.kind === "Spread" ? el.arg : el, scope));
        // `[...text.matchAll(re)]`, `[...a, ...b]`: only spreads of typed sources give their elements' type.
        if (e.elements.length > 0 && e.elements.every((el) => el.kind === "Spread")) {
          const elements = types.map((t) => elementOf(t) ?? this.env.iterableElement(t) ?? (isPrim(t, "String") ? T.String : undefined));
          if (elements.every((t) => t && !isDynamic(t))) return arrayOf(unionOf(elements.map((t) => widen(t!))));
        }
        return T.Array;
      }
      case "Object":
        this.objectLiteral(e, scope);
        return T.Object;
      case "Spread":
        this.diags.error("X0335", "spread `...` is only allowed in calls and array literals", e.span);
        this.expr(e.arg, scope);
        return T.error;
      case "Member": {
        const t = this.member(e, scope);
        // A field of an object built at compile time: `new Size(4, 3).width` → `4`.
        if (["New", "Call", "Binary"].includes(e.object.kind) && !this.writing) {
          const f = this.constValue(e);
          if (f.ok && isPrimitive(f.value)) this.env.result.inlineValues.set(e, f.value);
        }
        return t;
      }
      case "Index": {
        const obj = this.valueExpr(e.object, scope);
        const idx = this.valueExpr(e.index, scope);
        if (isPrim(obj, "String")) {
          if (!isNumeric(idx) && !isDynamic(idx)) {
            this.diags.error("X0308", "mismatched types", e.index.span, `a \`String\` index is an \`int\`, found \`${typeToString(idx)}\``);
          }
          return T.String;
        }
        // `pair[0]`: a constant position has its own type; any other index the union of them.
        const positions = tupleElements(obj);
        if (positions) {
          if (!isNumeric(idx) && !isDynamic(idx)) {
            this.diags.error("X0308", "mismatched types", e.index.span, `a tuple index is an \`int\`, found \`${typeToString(idx)}\``);
          }
          const at = this.constValue(e.index);
          if (at.ok && typeof at.value === "number") {
            if (Number.isInteger(at.value) && at.value >= 0 && at.value < positions.length) return positions[at.value]!;
            this.diags.error("X0324", "tuple index out of range", e.index.span, `\`${typeToString(obj)}\` has positions 0 to ${positions.length - 1}`);
            return T.error;
          }
          return elementOf(obj)!;
        }
        const element = elementOf(obj);
        if (element && !isDynamic(element)) {
          if (!isNumeric(idx) && !isDynamic(idx)) {
            this.diags.error("X0308", "mismatched types", e.index.span, `an \`Array\` index is an \`int\`, found \`${typeToString(idx)}\``);
          }
          return element;
        }
        return obj.kind === "error" ? T.error : T.any;
      }
      case "Call":
        return this.call(e, scope);
      case "New":
        return this.newExpr(e, scope);
      case "Unary":
        return this.unary(e, scope);
      case "Update":
        return this.update(e, scope);
      case "Binary":
        return this.binary(e, scope);
      case "Assign":
        return this.assign(e, scope);
      case "Conditional":
        return this.conditional(e, scope);
      case "Await":
        return this.awaitExpr(e, scope);
      case "Function":
        return this.fnExpr(e, scope);
      case "DestructAssign": {
        const source = this.valueExpr(e.value, scope);
        this.bindPattern(e.pattern, source, scope);
        return source;
      }
      case "TypeOp":
        return this.typeOp(e, scope);
      case "TypeCheck": {
        // `(expr : Type)`: `expr` is checked top-down against `Type` (literals take it from there), and is a `Type` from here on.
        const t = this.resolveT(e.type, this.scope);
        this.checkAssign(e.expr, t, { span: e.type.span, label: "expected because of this type check" }, scope);
        return t;
      }
      case "Error":
        return T.error;
    }
  }

  /** An expression whose value is used: `void` results are errors. */
  private valueExpr(e: A.Expr, scope: Scope): Type {
    const t = this.expr(e, scope);
    if (t.kind === "void") {
      this.diags.error("X0311", "this expression has no value", e.span, "returns `Void`");
      return T.error;
    }
    return t;
  }

  private ident(e: A.Expr & { kind: "Ident" }, scope: Scope): Type {
    const res = this.env.result.resolutions;
    const name = e.name;
    const local = scope.get(name);
    if (local) {
      res.set(e, { kind: "local", decl: local.nameSpan });
      if (!this.writing) local.used = true;
      const tracked = this.disposables.get(local);
      if (tracked) {
        if (this.memberObject === e) {
          if (this.memberName === "dispose") tracked.disposed = true;
        } else tracked.escaped = true;
      }
      if (local.inline !== undefined) this.env.result.inlineValues.set(e, local.inline);
      if (this.da.has(local)) this.daRead(local, e.span, local.nameSpan, `${this.nonNullLocals.has(local) ? "" : "final "}\`${name}\``);
      const seen = scope.typeOf(local);
      if (seen.blocked) this.narrowingBlocked.add(e);
      return seen.type;
    }
    const member = findMember(this.info, name) ?? (hasJsAncestor(this.info) ? undefined : this.env.rootMember(name));
    if (member) {
      this.env.checkAccess(readDecl(member), member.owner, this.info, e.span);
      if (this.dynamicThis > 0 && this.fieldInit && !member.isStatic) {
        this.diags.error("X0738", `\`${name}\` can't be reached from a \`function\` expression in a field initializer`, e.span)
          .help("use an arrow function, which keeps `this`");
      }
      if (this.beforeSuper && !member.isStatic) {
        this.diags.error("X0736", `instance member \`${name}\` can't be used before \`super(...)\` returns`, e.span);
      }
      if (this.da.has(member)) this.daRead(member, e.span, member.decl.name.span, `${this.nonNullFields.has(member) ? "" : "final "}field \`${name}\``);
      if (!member.isStatic && this.isStatic) {
        this.diags.error("X0410", `instance member \`${name}\` can't be used in a static context`, e.span)
          .secondary(member.decl.name.span, "declared as an instance member here");
      }
      res.set(e, { kind: "member", isStatic: member.isStatic, owner: member.owner });
      this.inlineRef(e, member);
      this.memberUse(e, member, e.span);
      return this.seenThrough(this.thisType, member);
    }
    const cls = this.env.lookupClass(this.scope, name, e.span) ?? this.typedefClass(name);
    if (cls) {
      res.set(e, { kind: "class", info: cls });
      return { kind: "classRef", info: cls };
    }
    if (this.env.isJsImport(this.scope, name)) {
      res.set(e, { kind: "jsImport" });
      // Typed from a `.d.ts`: a function (with its overloads) or a value.
      const typed = this.scope.jsMembers.get(name);
      const m = typed && findMember(typed.info, typed.member);
      if (m) {
        if (m.overloads && m.overloads.length > 1) this.calleeOverloads.set(e, m.overloads);
        return m.type;
      }
      return T.any;
    }
    const fns = this.env.functions.get(name);
    if (fns) {
      res.set(e, { kind: "function", decl: fns[0]!.decl });
      if (fns.length > 1) this.calleeOverloads.set(e, fns);
      return fns[0]!.type;
    }
    if (BUILTIN_FNS.has(name)) {
      res.set(e, { kind: "builtin", name: BUILTIN_FN_NAMES[name]! });
      return T.Function;
    }
    const globalType = this.env.globalType(name);
    if (globalType) {
      res.set(e, { kind: "global" });
      return globalType;
    }
    if (this.env.isGlobal(this.scope, name)) {
      res.set(e, { kind: "global" });
      return T.any;
    }
    if (hasJsAncestor(this.info)) {
      // Possibly inherited from a JS parent class: `name` becomes `this.name`.
      res.set(e, { kind: "member", isStatic: this.isStatic, owner: this.info });
      return T.any;
    }
    const d = this.diags.error("X0425", `cannot find \`${name}\` in this scope`, e.span, "not found in this scope");
    const s = suggest(name, [...scope.names(), ...allMemberNames(this.info), ...this.scope.classes.keys(), ...this.scope.jsImports, ...BUILTIN_FNS, ...this.env.functions.keys()]);
    if (name === "Number") d.help("JavaScript's `Number` is called `Float` in Xenon", [{ span: e.span, text: "Float" }]);
    else if (GLOBAL_HINTS[name]) {
      const hint = GLOBAL_HINTS[name]!;
      if (hint.note) d.note(hint.note);
      d.help(`use \`${hint.use}\``, [{ span: e.span, text: hint.use }]);
    }
    else if (s) d.help(`a name with a similar spelling exists: \`${s}\``, [{ span: e.span, text: s }]);
    else if (name in ERROR_HINTS) {
      d.help(`use \`${ERROR_HINTS[name]}\` (JavaScript error classes are hidden in Xenon)`, [{ span: e.span, text: ERROR_HINTS[name]! }]);
    } else this.env.missingImportHint(d, name);
    return T.error;
  }

  private objectLiteral(e: A.Expr & { kind: "Object" }, scope: Scope) {
    for (const p of e.props) {
      if (p.kind === "Prop") {
        if ("kind" in p.key && p.key.kind === "Computed") this.valueExpr(p.key.expr, scope);
        this.valueExpr(p.value, scope);
      } else if (p.kind === "SpreadProp") {
        this.valueExpr(p.arg, scope);
      } else {
        const ident = { kind: "Ident" as const, name: p.name.name, span: p.name.span };
        this.ident(ident, scope);
        const r = this.env.result.resolutions.get(ident);
        if (r) this.env.result.resolutions.set(p, r);
      }
    }
  }

  /** Member access `obj.name`. */
  private member(e: A.Expr & { kind: "Member" }, scope: Scope): Type {
    if (e.object.kind === "Super") return this.superMember(e);
    this.memberObject = e.object;
    this.memberName = e.name.name;
    const objType = this.valueExpr(e.object, scope);
    this.memberObject = undefined;
    // `n?.toFixed(2)` on an `int?`: the member of the `int`, and the result may be null too.
    if (objType.kind === "nullable") {
      if (!e.optional) return this.memberOn(e, this.mayBeNull(e.object, objType));
      return nullableOf(this.memberOn(e, objType.inner));
    }
    return this.memberOn(e, objType);
  }

  /** `obj.name` once the object's type is known (not nullable). */
  private memberOn(e: A.Expr & { kind: "Member" }, objType: Type): Type {
    let obj = objType;
    // The built-in array type has its members from the std class `Array<T>`.
    const arrayClass = this.env.arrayClass;
    // A tuple is an array of its elements' union (`pair.join(',')`, `pair.length`).
    if (obj.kind === "builtin" && (obj.name === "Array" || obj.name === "Tuple") && arrayClass) obj = { kind: "class", info: arrayClass, args: [elementOf(obj)!] };
    const name = e.name.name;
    switch (obj.kind) {
      case "builtin": {
        // An `Object` value: the inherited members are typed, anything else stays dynamic.
        if (obj.name === "Object") {
          const root = this.env.rootMember(name);
          return root ? this.rootMemberUse(e, root) : T.any;
        }
        if (obj.name === "Function") return this.functionMemberUse(e, obj);
        // A typed class value: only its `name` (the actual class, and so its statics, is known at run time).
        if (obj.name === "Class" && obj.args.length > 0) {
          if (name === "name") return T.String;
          this.diags.error("X0831", `\`${name}\` isn't available through a \`${typeToString(obj)}\``, e.name.span, "the class is only known at run time")
            .note("a `Class<T>` value can be passed on, compared, tested against (`x is kind`) and asked for its `name`; its statics depend on the actual class");
          return T.error;
        }
        return T.any;
      }
      case "nullable": // (unwrapped by `member`)
        return this.memberOn(e, this.mayBeNull(e.object, obj));
      case "union":
        return this.unionMember(e, obj);
      case "method":
        return this.functionMemberUse(e, obj);
      case "any":
        return T.any;
      case "error":
      case "void":
        return T.error;
      case "typeParam":
        this.diags.error("X0426", `no member \`${name}\` on type parameter \`${obj.param.name}\``, e.name.span, "unknown member")
          .note("a type parameter can be any type, so it has no members; type parameter bounds are not supported");
        return T.error;
      case "shape": {
        const m = obj.members.get(name);
        if (m) return m.optional ? nullableOf(m.type()) : m.type(); // `?count:int` may be missing
        const root = this.env.rootMember(name);
        if (root) return this.rootMemberUse(e, root);
        const d = this.diags.error("X0426", `no member \`${name}\` on \`${typeToString(obj)}\``, e.name.span, "unknown member");
        const sug = suggest(name, [...obj.members.keys()]);
        if (sug) d.help(`a member with a similar name exists: \`${sug}\``, [{ span: e.name.span, text: sug }]);
        return T.error;
      }
      case "null":
        this.diags.error("X0427", "can't access a member of `null`", e.span);
        return T.error;
      case "prim": {
        const cls = this.env.primClass(obj.name);
        if (!cls) {
          this.diags.error("X0426", `no member \`${name}\` on \`${obj.name}\``, e.name.span);
          return T.error;
        }
        const m = findMember(cls, name);
        if (!m || m.isStatic) {
          const d = this.diags.error("X0426", `no member \`${name}\` on \`${obj.name}\``, e.name.span, "unknown member");
          const sug = suggest(name, allMemberNames(cls));
          if (sug) d.help(`a member with a similar name exists: \`${sug}\``, [{ span: e.name.span, text: sug }]);
          else d.help(`if this JavaScript API exists, use it dynamically: \`(${dynamicReceiver(e.object)} as *).${name}\``);
          return T.error;
        }
        if (m.overloads) this.calleeOverloads.set(e, m.overloads);
        this.memberUse(e, m, e.name.span);
        this.enumerateCall(e, m);
        return this.seenThrough({ kind: "class", info: cls }, m);
      }
      case "class":
      case "classRef": {
        const wantStatic = obj.kind === "classRef";
        const m = findMember(obj.info, name) ?? (wantStatic || hasJsAncestor(obj.info) ? undefined : this.env.rootMember(name));
        if (m) this.env.checkAccess(readDecl(m), m.owner, this.info, e.name.span);
        if (!m) {
          if (hasJsAncestor(obj.info)) return T.any;
          const d = this.diags.error("X0426", `no ${wantStatic ? "static " : ""}member \`${name}\` on \`${obj.info.decl.name.name}\``, e.name.span, "unknown member");
          const s = suggest(name, allMemberNames(obj.info));
          if (s) d.help(`a member with a similar name exists: \`${s}\``, [{ span: e.name.span, text: s }]);
          else if (isNative(obj.info)) d.help(`if this JavaScript API exists, use it dynamically: \`(${dynamicReceiver(e.object)} as *).${name}\``);
          // `if (pet is Dog) pet.bark()` with a field `pet`: `is` narrows locals and parameters only.
          const field = !wantStatic && (e.object.kind === "Member" || (e.object.kind === "Ident" && this.env.result.resolutions.get(e.object)?.kind === "member"));
          const sub = field && [...this.env.classes.values()].find((c) => c !== obj.info && isSubclass(c, obj.info) && findMember(c, name));
          if (sub) {
            d.note(`\`${sub.decl.name.name}\` has \`${name}\`, but a check like \`is ${sub.decl.name.name}\` doesn't narrow a field: it could change before this use`)
              .help(`copy it into a local first: \`var ${e.object.kind === "Member" ? `${e.object.name.name} = ${spanText(e.object.span)}` : `${(e.object as { name: string }).name} = this.${(e.object as { name: string }).name}`}\`, then check and use the local`);
          }
          return T.error;
        }
        if (wantStatic && !m.isStatic && !obj.info.selfInstance) {
          this.diags.error("X0414", `\`${name}\` is an instance member; it can't be accessed through the class`, e.name.span)
            .secondary(m.decl.name.span, "declared here");
          return T.error;
        }
        if (this.da.has(m) && (e.object.kind === "This" || (wantStatic && obj.info === this.info))) {
          this.daRead(m, e.name.span, m.decl.name.span, `${this.nonNullFields.has(m) ? "" : "final "}field \`${name}\``);
        }
        if (wantStatic) this.inlineRef(e, m);
        this.memberUse(e, m, e.name.span);
        this.enumerateCall(e, m);
        const seen = this.seenThrough(obj, m);
        if (m.overloads) {
          this.calleeOverloads.set(e, m.overloads.map((o) => ({ decl: o.decl, type: (m.isStatic ? o.type : this.seenThrough(obj, { ...m, type: o.type })) as MethodType })));
        }
        if (!wantStatic && m.isStatic) {
          const owner = m.owner.decl.name.name;
          this.diags.error("X0413", `\`${name}\` is static; access it through the class`, e.name.span)
            .help(`use \`${owner}.${name}\``, [{ span: e.span, text: `${owner}.${name}` }]);
          return T.error;
        }
        return seen;
      }
    }
  }

  /**
   * `x.name` on a union: every member must have it. Its type is the members' (one type, or their
   * union for values); methods must be callable alike: one signature every other one fits (`toString`
   * of an `int | String`), giving the union of their results.
   */
  private unionMember(e: A.Expr & { kind: "Member" }, obj: UnionType): Type {
    const name = e.name.name;
    const missing = obj.types.filter((m) => !this.hasMember(m, name));
    if (missing.length > 0) {
      const d = this.diags.error("X0426", `no member \`${name}\` on \`${typeToString(obj)}\``, e.name.span, "not on every member of the union");
      d.note(`${missing.map((m) => `\`${typeToString(m)}\``).join(", ")} ${missing.length === 1 ? "has" : "have"} no \`${name}\``);
      const has = obj.types.find((m) => !missing.includes(m));
      if (has) d.help(`narrow it first: inside \`if (${spanText(e.object.span)} is ${testable(has)}) { … }\` it is a \`${typeToString(has)}\``);
      return T.error;
    }
    const types = obj.types.map((m) => this.memberOn(e, m));
    if (types.some((t) => t.kind === "error")) return T.error;
    const first = types[0]!;
    if (types.every((t) => sameType(t, first))) return first;
    if (types.every((t) => t.kind === "method")) {
      const sigs = types as MethodType[];
      // A call valid for `common` is valid for every member's method (they all fit it).
      const common = sigs.find((c) => sigs.every((m) => assignable(m, c)));
      if (common) return { kind: "method", params: common.params, ret: unionOf(sigs.map((m) => m.ret)) };
    }
    if (types.some((t) => t.kind === "method" || t.kind === "classRef")) {
      const d = this.diags.error("X0428", `\`${name}\` differs between the members of \`${typeToString(obj)}\``, e.name.span, "no common signature");
      obj.types.forEach((m, i) => d.note(`on \`${typeToString(m)}\`: \`${typeToString(types[i]!)}\``));
      d.help(`narrow it first: \`if (${spanText(e.object.span)} is ${testable(obj.types[0]!)}) { … }\``);
      return T.error;
    }
    return unionOf(types);
  }

  /** Does a value of type `t` have an instance member `name` (without reporting anything)? */
  private hasMember(t: Type, name: string): boolean {
    switch (t.kind) {
      case "any": case "error": return true;
      case "prim": {
        const cls = this.env.primClass(t.name);
        const m = cls && findMember(cls, name);
        return !!m && !m.isStatic;
      }
      case "builtin":
        if ((t.name === "Array" || t.name === "Tuple") && this.env.arrayClass) return this.hasMember({ kind: "class", info: this.env.arrayClass, args: [elementOf(t)!] }, name);
        if (t.name === "Function") return !!this.env.functionMember(name);
        return t.name === "Object" || !!this.env.rootMember(name);
      case "method": return !!this.env.functionMember(name);
      case "shape": return t.members.has(name) || !!this.env.rootMember(name);
      case "class": {
        if (hasJsAncestor(t.info)) return true;
        const m = findMember(t.info, name) ?? this.env.rootMember(name);
        return !!m && !m.isStatic;
      }
      case "union": return t.types.every((m) => this.hasMember(m, name));
      default: return false;
    }
  }

  /**
   * `x.getEnumerator` that resolves to `Iterable`'s own declaration: `x` may be a built-in (an array,
   * a set, …) without the method, so it compiles to `Enumerable.enumerate(x)`.
   */
  private enumerateCall(e: A.Expr & { kind: "Member" }, m: MemberSig) {
    if (m.owner !== this.env.enumerable || m.name !== "getEnumerator") return;
    this.env.result.enumerateCalls.add(e);
    this.env.result.methodClosures.delete(e);
  }

  /** `f.call`, `f.length` & co. on a function value; other names are errors. */
  private functionMemberUse(e: A.Expr & { kind: "Member" }, fn: Type): Type {
    const m = this.env.functionMember(e.name.name);
    // Reading `name`/`length` of a method needn't bind it (a bound copy is named `bound …`);
    // `call`/`apply`/`bind` keep the binding, so the method keeps its `this`.
    if (m && m.kind !== "method") this.env.result.methodClosures.delete(e.object);
    if (m) return this.rootMemberUse(e, m);
    const instanceNames = (q: string) => [...(this.env.classes.get(q)?.members.values() ?? [])].filter((x) => !x.isStatic).map((x) => x.name);
    const names = [...instanceNames("xenon.Function"), ...instanceNames("xenon.Object")];
    const d = this.diags.error("X0426", `no member \`${e.name.name}\` on \`${typeToString(fn)}\``, e.name.span, "unknown member");
    const sug = suggest(e.name.name, names);
    if (sug) d.help(`a member with a similar name exists: \`${sug}\``, [{ span: e.name.span, text: sug }]);
    else d.help(`if this JavaScript property exists, use it dynamically: \`(${dynamicReceiver(e.object)} as *).${e.name.name}\``);
    return T.error;
  }

  /** `x.toString` & co. on a shape, an `Object` or a function value: a declared std member. */
  private rootMemberUse(e: A.Expr & { kind: "Member" }, m: MemberSig): Type {
    if (m.overloads) this.calleeOverloads.set(e, m.overloads);
    this.memberUse(e, m, e.name.span);
    return m.type;
  }

  private call(e: A.Expr & { kind: "Call" }, scope: Scope): Type {
    const expected = this.takeExpected();
    if (e.callee.kind === "Super") return this.superCallExpr(e, scope);
    const savedCallee = this.calledCallee;
    this.calledCallee = e.callee;
    let callee = this.expr(e.callee, scope);
    this.calledCallee = savedCallee;
    // `a?.m(x)` / `f?.(x)`: the call happens only when there's something to call (the result is
    // nullable below); a nullable function called directly may be null (X0398).
    if (callee.kind === "nullable") {
      const optional = e.optional || (e.callee.kind === "Member" && e.callee.optional);
      callee = optional ? callee.inner : this.mayBeNull(e.callee, callee);
    }
    this.env.result.methodClosures.delete(e.callee); // called directly, not used as a value
    let res = e.callee.kind === "Ident" ? this.env.result.resolutions.get(e.callee) : undefined;
    // `Boolean(x)`, `String(x)`, `Float(x)`: the std library's native class of a primitive is
    // only used for its members; called, the name is still the built-in conversion.
    // (Also through a typedef: `Int(x)`, `Bool(x)`.)
    const calleeClass = res?.kind === "class" ? res.info : undefined;
    const castName = calleeClass && Object.keys(CASTS).find((p) => calleeClass.decl.name.name === p && calleeClass === this.env.primClass(p));
    if (e.callee.kind === "Ident" && castName) {
      res = { kind: "builtin", name: castName as BuiltinFn };
      this.env.result.resolutions.set(e.callee, res);
    }

    if (res?.kind === "builtin") {
      if (res.name === "trace") {
        for (const a of e.args) this.valueExpr(a.kind === "Spread" ? a.arg : a, scope);
        return T.void;
      }
      if (e.args.length !== 1 || e.args[0]!.kind === "Spread") {
        this.diags.error("X0601", `\`${res.name}()\` takes exactly 1 argument`, e.span);
        for (const a of e.args) this.valueExpr(a.kind === "Spread" ? a.arg : a, scope);
        return CASTS[res.name]!;
      }
      this.valueExpr(e.args[0]!, scope);
      return CASTS[res.name]!;
    }

    switch (callee.kind) {
      case "method": {
        let chosen = { type: callee, decl: this.calleeDecl(e.callee) };
        const overloads = this.calleeOverloads.get(e.callee);
        if (overloads) {
          this.calleeOverloads.delete(e.callee);
          const name = e.callee.kind === "Member" ? e.callee.name.name : e.callee.kind === "Ident" ? e.callee.name : "function";
          const pick = this.pickOverload(overloads, e.args, scope, e.callee.span, name);
          this.env.result.overloadPicks.set(e.callee, { all: overloads });
          if (!pick) return overloads[0]!.type.ret;
          chosen = pick;
        }
        const target = chosen.type;
        const sig = target.typeParams?.length ? this.instantiate(target, target.typeParams, e.args, scope, e.callee.span, expected && [target.ret, expected]).sig : target;
        this.checkArgs(e, sig, chosen.decl, scope);
        // Before folding: a native `constexpr` call runs the overload chosen here.
        if (overloads && chosen.decl) this.env.result.overloadPicks.set(e.callee, { all: overloads, chosen: { decl: chosen.decl, type: sig } });
        // A `constexpr` call with constant arguments: evaluated now, its value pasted into the output.
        if (chosen.decl?.modifiers.constexpr) {
          const f = this.constValue(e);
          if (f.ok && isPrimitive(f.value)) this.env.result.inlineValues.set(e, f.value);
          else if (!f.ok && f.limit) this.diags.error("X0527", f.reason, f.at).note("the call is evaluated at compile time because its arguments are constants");
        }
        if (chosen.decl?.name.span.file.prelude && tsDivergent(chosen.decl.returnType)) this.env.result.tsResultCasts.add(e);
        // `b?.valueOf()` / `f?.()`: `null` when the object (or function) is.
        const optional = e.optional || (e.callee.kind === "Member" && e.callee.optional);
        return optional ? nullableOf(sig.ret) : sig.ret;
      }
      case "any":
      case "error":
        for (const a of e.args) this.valueExpr(a.kind === "Spread" ? a.arg : a, scope);
        return callee.kind === "error" ? T.error : T.any;
      case "builtin":
        if (callee.name === "Function") {
          for (const a of e.args) this.valueExpr(a.kind === "Spread" ? a.arg : a, scope);
          return T.any;
        }
        break;
      case "classRef":
        this.diags.error("X0380", `\`${callee.info.decl.name.name}(x)\` casts are not supported`, e.span)
          .help(`use \`x as ${callee.info.decl.name.name}\`, which gives \`null\` if the value has another type`);
        for (const a of e.args) this.valueExpr(a.kind === "Spread" ? a.arg : a, scope);
        return { kind: "class", info: callee.info };
    }
    this.diags.error("X0602", `\`${typeToString(callee)}\` is not callable`, e.callee.span);
    for (const a of e.args) this.valueExpr(a.kind === "Spread" ? a.arg : a, scope);
    return T.error;
  }

  /**
   * A fresh object literal against a shape: each value is checked against its member,
   * unknown keys are errors (typos like `{ x: 1, yy: 2 }`), and required members must be present.
   */
  private objectAgainstShape(e: A.Expr & { kind: "Object" }, shape: ShapeType, scope: Scope) {
    const given = new Set<string>();
    const unknown: A.Ident[] = [];
    let spread = false;
    for (const p of e.props) {
      if (p.kind === "SpreadProp") {
        spread = true;
        this.valueExpr(p.arg, scope);
        continue;
      }
      let key: A.Ident | undefined;
      if (p.kind === "Shorthand") key = p.name;
      else if ("name" in p.key) key = p.key;
      else if (p.key.kind === "StringKey") key = { name: p.key.value, span: p.span };
      if (!key) {
        if (p.kind === "Prop" && "kind" in p.key && p.key.kind === "Computed") this.valueExpr(p.key.expr, scope);
        if (p.kind === "Prop") this.valueExpr(p.value, scope);
        continue;
      }
      given.add(key.name);
      const member = shape.members.get(key.name);
      if (!member) {
        unknown.push(key);
        if (p.kind === "Prop") this.valueExpr(p.value, scope);
        continue;
      }
      const memberType = member.optional ? nullableOf(member.type()) : member.type();
      if (p.kind === "Shorthand") {
        const ident = { kind: "Ident" as const, name: p.name.name, span: p.name.span };
        this.checkAssign(ident, memberType, undefined, scope);
        const r = this.env.result.resolutions.get(ident);
        if (r) this.env.result.resolutions.set(p, r);
      } else this.checkAssign(p.value, memberType, undefined, scope);
    }
    const missing = spread ? [] : [...shape.members.values()].filter((m) => !m.optional && !given.has(m.name));
    const free = [...shape.members.keys()].filter((n) => !given.has(n));
    for (const key of unknown) {
      const d = this.diags.error("X0791", `\`${key.name}\` is not a member of \`${typeToString(shape)}\``, key.span, "unknown member");
      // One unknown key and one missing member: almost certainly a typo, even for short names.
      const sug = unknown.length === 1 && missing.length === 1 ? missing[0]!.name : suggest(key.name, free);
      if (sug) d.help(`did you mean \`${sug}\`?`, [{ span: key.span, text: sug }]);
      if (sug && missing.length === 1 && missing[0]!.name === sug) return; // the typo explains the missing member
    }
    if (missing.length > 0) {
      this.diags.error("X0792", `missing ${missing.map((m) => `\`${m.name}\``).join(", ")} for \`${typeToString(shape)}\``, e.span,
        `${missing.length === 1 ? "this member is" : "these members are"} required`);
    }
  }

  /* ----------------------------- disposal ----------------------------- */

  /** Checks one `using` resource; returns its (declared or inferred) type. */
  private usingResource(init: A.Expr, typeNode: A.TypeNode | undefined, isAwait: boolean, stmt: Span, scope: Scope): Type {
    let type: Type;
    if (typeNode) {
      type = this.resolveT(typeNode, this.scope);
      this.checkAssign(init, type, { span: typeNode.span, label: "expected because of this type" }, scope);
    } else type = this.valueExpr(init, scope); // the resource's type is obvious from its value
    // The value is owned by `using` now, not leaked.
    if (init.kind === "Ident") {
      const local = scope.get(init.name);
      const tracked = local && this.disposables.get(local);
      if (tracked) tracked.disposed = true;
    }
    const kind = disposeKind(type, this.env);
    const at = typeNode?.span ?? init.span;
    if (kind === "none") {
      const d = this.diags.error("X0802", `\`${typeToString(type)}\` can't be used with \`using\``, at, "not disposable");
      if (type.kind === "class") d.help(`let \`${type.info.decl.name.name}\` implement \`IDisposable\`: a \`dispose()\` method that \`using\` calls`);
    } else if (kind === "async" && !isAwait) {
      this.diags.error("X0807", `\`${typeToString(type)}\` has an async \`dispose()\` (\`IAsyncDisposable\`) and needs \`await using\``, at)
        .help("add `await`", [{ span: span(stmt.file, stmt.start, stmt.start), text: "await " }]);
    }
    if (isAwait && !this.method?.async) {
      const d = this.diags.error("X0760", "`await using` is only allowed inside `async` functions", span(stmt.file, stmt.start, stmt.start + 5));
      if (this.method) d.help(`make \`${this.method.name}\` async`, [{ span: this.method.asyncAt, text: "async " }]);
    }
    return type;
  }

  /** X0861: locals and local functions that are never read. `_name` marks intentionally unused ones. */
  private reportUnusedLocals() {
    // With syntax errors in the file, uses may sit in the broken code: the warning would be noise.
    if (this.env.syntaxErrors.has(this.info.file.file)) {
      this.declared = [];
      return;
    }
    for (const { local, name, fn } of this.declared) {
      if (local.used || name.name.startsWith("_")) continue;
      // A scoped value held only for its destructor (`var lock:Lock = new Lock()`, a C++-style guard).
      const t = local.type.kind === "nullable" ? local.type.inner : local.type;
      if (!fn && t.kind === "class" && isScoped(t.info)) continue;
      this.diags.warning("X0861", `${fn ? "local function" : "variable"} \`${name.name}\` is never used`, name.span, "never read")
        .help("remove it, or prefix the name with `_` if that's intended", [{ span: span(name.span.file, name.span.start, name.span.start), text: "_" }]);
    }
    this.declared = [];
  }

  /** X0801: a new disposable stored in a local that is never disposed, returned, passed or stored. */
  private reportUndisposed() {
    for (const t of this.disposables.values()) {
      if (t.disposed || t.escaped) continue;
      const kw = t.name.span.file.text.lastIndexOf("var", t.name.span.start);
      const d = this.diags.warning("X0801", `\`${t.name.name}\` holds a \`${t.type}\` that is never disposed`, t.name.span, "created here, never disposed")
        .note(`\`${t.type}\` has a destructor; it only runs through \`using\` or \`dispose()\``);
      if (kw >= 0 && t.name.span.start - kw <= 4) {
        d.help("declare it with `using`", [{ span: span(t.name.span.file, kw, kw + 3), text: "using" }]);
      }
    }
    this.disposables = new Map();
  }

  /* --------------------------- destructuring --------------------------- */

  /**
   * Matches a pattern against a value of type `source`. With `decl` it declares the bound
   * names (types come from the source); without it, leaves are assignment targets.
   */
  private bindPattern(p: A.Pattern, source: Type, scope: Scope, decl?: "var" | "const" | "final") {
    if (p.init) {
      // A default replaces a missing (`undefined`) value; it must fit the slot's type.
      this.checkAssign(p.init, source, undefined, scope);
    }
    switch (p.kind) {
      case "BindingName": {
        const prev = scope.getOwn(p.name.name);
        if (prev) {
          this.diags.error("X0204", `\`${p.name.name}\` is already declared in this scope`, p.name.span).secondary(prev.nameSpan, "previously declared here");
        }
        scope.declare(p.name.name, { type: source, kind: decl ?? "var", nameSpan: p.name.span });
        this.env.result.bindingTypes.set(p.name, source);
        return;
      }
      case "Target": {
        const { type, commit } = this.lvalue(p.expr, scope, true);
        if (!assignable(source, type)) {
          this.diags.error("X0308", "mismatched types", p.expr.span, `expected \`${typeToString(type)}\`, found \`${typeToString(source)}\``);
        }
        commit();
        return;
      }
      case "ObjectPattern": {
        const fail = source.kind === "prim" && source.name !== "String" || source.kind === "null" || source.kind === "void" || source.kind === "method";
        if (fail) this.diags.error("X0770", `\`${typeToString(source)}\` values can't be destructured with \`{…}\``, p.span);
        for (const prop of p.props) {
          this.bindPattern(prop.value, fail ? T.error : this.propertyType(source, prop.key), scope, decl);
        }
        if (p.rest) this.bindPattern(p.rest, isDynamic(source) ? T.any : T.Object, scope, decl);
        return;
      }
      case "ArrayPattern": {
        // `var [key, value] = entry`: each name gets its position's type; `...rest` the remaining ones.
        const positions = tupleElements(source);
        if (positions) {
          const extra = p.elements.findIndex((el, i) => el && i >= positions.length);
          if (extra >= 0) {
            this.diags.error("X0773", "too many names for a tuple", p.elements[extra]!.span, `\`${typeToString(source)}\` has ${positions.length} element${positions.length === 1 ? "" : "s"}`);
          }
          p.elements.forEach((el, i) => el && this.bindPattern(el, positions[i] ?? T.error, scope, decl));
          const remaining = positions.slice(p.elements.length);
          if (p.rest) this.bindPattern(p.rest, remaining.length ? tupleOf(remaining) : arrayOf(T.any), scope, decl);
          return;
        }
        let element: Type = T.any;
        let rest: Type = T.Array;
        const sourceElement = elementOf(source);
        if (sourceElement) {
          element = sourceElement;
          rest = source;
        } else if (isPrim(source, "String")) element = T.String;
        else if (source.kind === "error") element = T.error;
        else if (!isDynamic(source) && !(source.kind === "builtin" && source.name === "Object")) {
          this.diags.error("X0770", `\`${typeToString(source)}\` values can't be destructured with \`[…]\``, p.span);
          element = T.error;
        }
        for (const el of p.elements) if (el) this.bindPattern(el, element, scope, decl);
        if (p.rest) this.bindPattern(p.rest, rest, scope, decl);
        return;
      }
    }
  }

  /** Type of `source.key` for `{key}` destructuring (same rules as member access). */
  private propertyType(source: Type, key: A.Ident): Type {
    // Classes, and primitives through their std class (`var { length } = text`).
    const info = source.kind === "class" ? source.info : source.kind === "prim" ? this.env.primClass(source.name) : undefined;
    if (info) {
      const m = findMember(info, key.name);
      if (m) this.env.usedMembers.add(m);
      if (!m) {
        if (hasJsAncestor(info)) return T.any;
        const d = this.diags.error("X0426", `no member \`${key.name}\` on \`${source.kind === "class" ? info.decl.name.name : typeToString(source)}\``, key.span, "unknown member");
        const sug = suggest(key.name, allMemberNames(info));
        if (sug) d.help(`a member with a similar name exists: \`${sug}\``);
        return T.error;
      }
      this.env.checkAccess(readDecl(m), m.owner, this.info, key.span);
      // A private field is a JavaScript `#private` field, which destructuring can't read.
      if (m.decl.kind === "Field" && visibilityOf(m.decl) === "private" && !m.owner.decl.isEnum && !isNative(m.owner) && !m.owner.file.file.prelude) {
        this.diags.error("X0772", `private field \`${key.name}\` can't be destructured`, key.span)
          .note("private fields are JavaScript `#private` fields, which destructuring can't read")
          .help(`read it directly: \`var ${key.name}:${typeToString(m.type)} = ….${key.name}\``);
      }
      if (m.isStatic) {
        this.diags.error("X0413", `\`${key.name}\` is static and can't be destructured from an instance`, key.span);
        return T.error;
      }
      if (m.kind === "method") {
        this.diags.error("X0771", `method \`${key.name}\` can't be destructured`, key.span, "it would lose `this`")
          .help("call it on the object instead");
        return T.error;
      }
      return this.seenThrough(source, m);
    }
    if (source.kind === "shape") {
      const m = source.members.get(key.name);
      if (m) return m.optional ? nullableOf(m.type()) : m.type();
      this.diags.error("X0426", `no member \`${key.name}\` on \`${typeToString(source)}\``, key.span, "unknown member");
      return T.error;
    }
    return source.kind === "error" ? T.error : T.any;
  }

  /* ---------------------------- functions ---------------------------- */

  /** For an async function declared `:Promise<T>`, returns `T` (what `return` statements produce). */
  private asyncResult(declared: Type, node?: A.TypeNode, at?: Span): Type {
    const arg = this.env.promiseArg(declared);
    if (arg) return arg;
    if (isDynamic(declared)) return T.any;
    const d = this.diags.error("X0763", "an `async` function must return a `Promise<T>`", node?.span ?? at ?? this.method?.asyncAt, `found \`${typeToString(declared)}\``);
    if (node && declared.kind !== "void") d.help(`return \`Promise<${typeToString(declared)}>\``, [{ span: node.span, text: `Promise<${typeToString(declared)}>` }]);
    else if (node) d.help("use `Promise<void>`", [{ span: node.span, text: "Promise<void>" }]);
    return T.any;
  }

  /** Parameter and return types of a function node (async: the declared `Promise<T>`). */
  private fnSignature(f: A.FunctionNode, named: boolean, context?: MethodType): MethodType {
    const own = this.env.typeParamsOf(f);
    const saved = this.tparams;
    if (own.length > 0) this.tparams = new Map([...saved, ...own.map((p) => [p.name, p] as const)]);
    try {
      const sig = this.fnSignatureInner(f, named, context);
      return own.length > 0 ? { ...sig, typeParams: own } : sig;
    } finally {
      this.tparams = saved;
    }
  }

  private fnSignatureInner(f: A.FunctionNode, named: boolean, context?: MethodType): MethodType {
    const params = f.params.map((p, i) => {
      const type = p.type
        ? this.resolveT(p.type, this.scope)
        : context?.params[i]?.type ?? (named ? this.env.untyped(p.name.span, `parameter \`${p.name.name}\``) : T.any);
      return { name: p.name.name, type, optional: !!p.init, rest: p.rest };
    });
    let ret: Type = T.any;
    if (f.returnType) ret = this.resolveT(f.returnType, this.scope, true);
    else if (context && f.body.kind === "Block") ret = context.ret;
    else if (named) ret = this.env.untypedReturn(f.name!, f.span, f.body);
    return { kind: "method", params, ret };
  }

  /** Checks a function expression, arrow function or local function; returns its type. */
  private fnExpr(f: A.FunctionNode, scope: Scope, context?: MethodType): MethodType {
    const sig = this.fnSigs.get(f) ?? this.fnSignature(f, false, context);
    const contextRet = !f.returnType && context && f.body.kind === "Block";
    const saved = { method: this.method, targets: this.targets, beforeSuper: this.beforeSuper, superCall: this.superCall, constMethod: this.constMethod };
    if (!f.arrow) this.constMethod = undefined; // a `function` expression has its own `this`
    const asyncAt = span(f.span.file, f.span.start, f.span.start);
    // An async callback where the result is ignored (`setTimeout(async () => { … })`): its body returns nothing.
    const voidContext = f.async && contextRet && sig.ret.kind === "void";
    let bodyRet = voidContext ? T.void
      : f.async ? (f.returnType || contextRet ? this.asyncResult(sig.ret, f.returnType, asyncAt) : T.any)
      : sig.ret;
    this.method = { ret: bodyRet, retSpan: f.returnType?.span, isConstructor: false, name: f.name?.name ?? "function", async: f.async, asyncAt };
    this.targets = [];
    this.beforeSuper = false;
    this.superCall = undefined;
    this.loopDepth++; // a closure may run any number of times: outer finals can't be assigned in it
    if (!f.arrow) this.dynamicThis++;
    const savedParams = this.tparams;
    if (sig.typeParams?.length) this.tparams = new Map([...savedParams, ...sig.typeParams.map((p) => [p.name, p] as const)]);
    try {
      const inner = new Scope(scope, assignmentWrites(f.body));
      inner.boundaryAt = f.span.start;
      if (f.name && !this.fnSigs.has(f)) inner.declare(f.name.name, { type: sig, kind: "const", nameSpan: f.name.span }); // named function expression
      f.params.forEach((p, i) => {
        const pt = sig.params[i]!.type;
        if (p.init) this.checkAssign(p.init, pt, p.type && { span: p.type.span, label: "parameter type declared here" }, inner);
        inner.declare(p.name.name, { type: pt, kind: p.final ? "final" : "param", nameSpan: p.name.span, typeSpan: p.type?.span });
        if (!p.type) this.env.result.bindingTypes.set(p.name, pt); // `e => …`: the type from context, for hover
      });
      if (f.body.kind === "Block") {
        this.block(f.body, inner);
        if (bodyRet.kind !== "void" && !isDynamic(bodyRet) && completes(f.body)) {
          const close = span(f.body.span.file, f.body.span.end - 1, f.body.span.end);
          const d = this.diags.error("X0314", "not all code paths of this function return a value", close, "execution can reach the end here");
          if (f.returnType) d.secondary(f.returnType.span, `returns \`${typeToString(sig.ret)}\``);
        }
      } else if (f.returnType) {
        if (bodyRet.kind === "void") this.expr(f.body, inner);
        else this.checkAssign(f.body, bodyRet, { span: f.returnType.span, label: "expected because of this return type" }, inner);
      } else if (context && !f.async && ["Object", "Array", "Function"].includes(f.body.kind) && context.ret.kind !== "void" && !isDynamic(context.ret)) {
        // `tag => ({ get: … })` where a `(tag:String) -> Parser` is expected: the literal is typed from `Parser`.
        this.checkAssign(f.body, context.ret, undefined, inner);
        bodyRet = context.ret;
      } else {
        // `x => x * 2`: the body's type is the return type.
        bodyRet = this.expr(f.body, inner);
      }
    } finally {
      Object.assign(this, saved);
      this.tparams = savedParams;
      this.loopDepth--;
      if (!f.arrow) this.dynamicThis--;
    }
    // The function's type: a declared return type wins; an expression body gives its own type.
    let ret: Type;
    if (voidContext) ret = this.env.promiseOf(T.void);
    else if (f.returnType || contextRet) ret = sig.ret;
    else if (f.body.kind === "Block") ret = f.async ? this.env.promiseOf(T.any) : T.any;
    else ret = f.async ? this.env.promiseOf(bodyRet) : bodyRet;
    return { kind: "method", params: sig.params, ret };
  }

  /** `await x`: only inside `async` functions; unwraps `Promise<T>` to `T`. */
  private awaitExpr(e: A.Expr & { kind: "Await" }, scope: Scope): Type {
    const m = this.method;
    if (!m?.async) {
      const d = this.diags.error("X0760", "`await` is only allowed inside `async` functions", e.span);
      if (m) d.help(`make \`${m.name}\` async`, [{ span: m.asyncAt, text: "async " }]);
    }
    const t = this.valueExpr(e.arg, scope);
    const arg = this.env.promiseArg(t);
    if (arg) return arg;
    if (isDynamic(t)) return T.any;
    this.diags.warning("X0762", "`await` on a value that isn't a `Promise`", e.arg.span, `this is \`${typeToString(t)}\``)
      .note("awaiting a plain value just returns it");
    return t;
  }

  /**
   * A typedef used as a value stands for the class it names, so its statics are reachable:
   * `Int.MAX_VALUE` (the prelude's `typedef Int = int`), `Bool(x)`. Only non-generic targets.
   */
  private typedefClass(name: string): ClassInfo | undefined {
    return this.env.typedefClass(this.scope, name);
  }

  /** Bookkeeping for every member reference: setter-only reads and method closures. */
  private memberUse(e: A.Expr, m: MemberSig, at: Span) {
    this.env.usedMembers.add(m);
    // In a const method, only const methods and getters may be used on `this`.
    const onThis = e.kind === "Ident" || (e.kind === "Member" && (e.object.kind === "This" || e.object.kind === "Super"));
    if (this.constMethod && onThis && !m.isStatic && !this.writing && (m.kind === "method" || m.kind === "accessor") && !isConstMember(m)) {
      const what = m.kind === "method" ? "method" : "getter";
      this.diags.error("X0902", `cannot use non-const ${what} \`${m.name}\` in const method \`${this.constMethod}\``, at)
        .secondary(m.decl.name.span, `\`${m.name}\` is not \`const\``)
        .note(`it might change the object; mark it \`const\` if it doesn't`);
    }
    if (m.kind === "accessor" && !this.writing && !accessorHalves(m).includes("get") && m.delegate !== "get") {
      this.diags.error("X0506", `\`${m.name}\` has a setter but no getter`, at, "can't be read").secondary(m.decl.name.span, "setter declared here");
    }
    if (m.kind === "method" && !m.isStatic) {
      if (e === this.calledCallee) return; // called right away (`d?.bark()`): no closure needed
      if (e.kind === "Member" && e.optional) {
        this.diags.error("X0607", "a method can't be taken as a value through `?.`", at).help("call it, or check for null first");
        return;
      }
      this.env.result.methodClosures.add(e);
    }
  }

  /**
   * Infers the type parameters `vars` of a generic signature from the call's arguments (and the
   * expected result type, `seed`). Plain arguments come first; then function arguments, which get
   * their parameter types from what is known and contribute their return types. Arguments checked
   * here are remembered (`preTyped`) so `checkArgs` doesn't check them twice.
   */
  private instantiate(sig: MethodType, vars: TypeParamInfo[], args: A.Expr[], scope: Scope, at: Span, seed?: [Type, Type]): { sig: MethodType; bindings: Map<TypeParamInfo, Type> } {
    const set = new Set(vars);
    const out = new Map<TypeParamInfo, Type>();
    const rest = sig.params.find((p) => p.rest);
    const patternAt = (i: number): Type | undefined => {
      const p = i < sig.params.length && !sig.params[i]!.rest ? sig.params[i] : rest;
      if (!p) return undefined;
      return p.rest ? (p.type.kind === "builtin" && p.type.args.length === 1 ? p.type.args[0]! : T.any) : p.type;
    };
    args.forEach((a, i) => {
      const pattern = patternAt(i);
      if (a.kind === "Function" || a.kind === "Spread" || !pattern) return;
      // An array literal for `Array<X>` or `Iterable<X>` (`Promise.all([a, b])`): unify `X` with each element.
      const enumerable = pattern.kind === "class" && pattern.info.qname === "xenon.Iterable" ? pattern.args?.[0] : undefined;
      const patternElement = a.kind === "Array" ? elementOf(pattern) ?? enumerable : undefined;
      if (a.kind === "Array" && patternElement) {
        for (const el of a.elements) {
          if (el.kind === "Spread") continue;
          const t = this.inferredLiteral(el, patternElement, scope);
          // Elements of different types: the wider one, or `*` if neither holds the other.
          const mine = new Map<TypeParamInfo, Type>();
          unify(patternElement, t, set, mine);
          for (const [v, b] of mine) {
            const old = out.get(v);
            if (!old || assignable(old, b)) out.set(v, b);
            else if (!assignable(b, old)) out.set(v, T.any);
          }
        }
        return;
      }
      if (a.kind === "Object" && pattern.kind === "shape") return; // checked against the shape later
      if ((a.kind === "Array" || a.kind === "Object") && pattern.kind === "typeParam") return; // decided last (the expected type may name it: `Object.freeze({ … })`)
      const t = this.valueExpr(a, scope);
      this.preTyped.set(a, t);
      unify(pattern, t, set, out);
    });
    // What the expected type says, as a fallback context for function arguments: in
    // `var p:Promise<void> = new Promise((resolve, reject) => resolve())`, `resolve` takes a `void`.
    const seeded = new Map<TypeParamInfo, Type>();
    if (seed) unify(seed[0], seed[1], set, seeded);
    args.forEach((a, i) => {
      const pattern = patternAt(i);
      if (a.kind !== "Function" || !pattern) return;
      const known = subst(pattern, new Map([...seeded, ...out]));
      const t = this.record(a, this.fnExpr(a, scope, known.kind === "method" ? (eraseParams(known, set) as MethodType) : undefined));
      this.preTyped.set(a, t);
      unify(pattern, t, set, out);
    });
    // The expected type is the weakest source: it only fills in what the arguments left open.
    if (seed) unify(seed[0], seed[1], set, out);
    // Array and object literals for a bare type parameter: if still open, the literal itself decides.
    args.forEach((a, i) => {
      const pattern = patternAt(i);
      if ((a.kind !== "Array" && a.kind !== "Object") || pattern?.kind !== "typeParam" || out.has(pattern.param) || !set.has(pattern.param)) return;
      const t = this.valueExpr(a, scope);
      this.preTyped.set(a, t);
      unify(pattern, t, set, out);
    });
    const missing = vars.filter((v) => !out.has(v));
    if (missing.length > 0) {
      this.diags.error("X0797", `can't infer the type of ${missing.map((v) => `\`${v.name}\``).join(", ")}`, at, "type arguments are inferred from the arguments")
        .help("pass arguments that determine it, or assign the result to a variable with a type");
      for (const v of missing) out.set(v, T.any);
    }
    return {
      sig: { kind: "method", params: sig.params.map((p) => ({ ...p, type: subst(p.type, out) })), ret: subst(sig.ret, out) },
      bindings: out,
    };
  }

  /**
   * Chooses the first overload whose arity and argument types fit. Plain arguments are checked
   * once here (and remembered for `checkArgs`); literals and functions fit any compatible
   * parameter. Reports X0604 and returns undefined when nothing fits.
   */
  private pickOverload(cands: { decl: A.Method; type: MethodType }[], args: A.Expr[], scope: Scope, at: Span, name: string): { decl: A.Method; type: MethodType } | undefined {
    if (cands.length === 1) return cands[0];
    const literal = (a: A.Expr) => a.kind === "Function" || a.kind === "Array" || a.kind === "Object" || a.kind === "Spread";
    const types = args.map((a) => {
      if (literal(a)) return undefined;
      const t = this.valueExpr(a, scope);
      this.preTyped.set(a, t);
      return t;
    });
    // `strict`: object literals must fit a shape structurally (see `objectMayFit`). When none
    // does, the first overload taking a shape is chosen, and checking reports what's wrong with it.
    const matches = (c: { type: MethodType }, strict: boolean): boolean => {
      const sig = c.type;
      const erase = (t: Type) => (sig.typeParams?.length ? eraseParams(t, sig.typeParams) : t);
      const rest = sig.params.find((p) => p.rest);
      const required = requiredParams(sig.params);
      if (!args.some((a) => a.kind === "Spread") && (args.length < required || (!rest && args.length > sig.params.length))) return false;
      return args.every((a, i) => {
        const p = i < sig.params.length && !sig.params[i]!.rest ? sig.params[i] : rest;
        if (!p) return a.kind === "Spread";
        const pattern = p.rest ? (p.type.kind === "builtin" && p.type.args.length === 1 ? p.type.args[0]! : T.any) : p.type;
        const pt = erase(pattern);
        if (isDynamic(pt) || a.kind === "Spread") return true;
        // A literal fits a union when it fits a member.
        const each = (pt: Type) => membersOf(pt).some((m) => {
          if (a.kind === "Function") return m.kind === "method" || (m.kind === "builtin" && (m.name === "Function" || m.name === "Object"));
          if (a.kind === "Array") {
            // A tuple of the same length (a spread's length isn't known), an array, or an interface arrays implement.
            const positions = tupleElements(m);
            if (positions) return a.elements.length === positions.length && a.elements.every((el) => el.kind !== "Spread");
            return (m.kind === "builtin" && (m.name === "Array" || m.name === "Object")) || !!this.env.arrayElementFor(m);
          }
          return m.kind === "shape" ? !strict || this.objectMayFit(a as A.Expr & { kind: "Object" }, m) : m.kind === "builtin" && m.name === "Object";
        });
        if (a.kind === "Function" || a.kind === "Array" || a.kind === "Object") return each(pt);
        const t = types[i]!;
        if (assignable(t, pt)) return true;
        // Generic parameters: bind them from this argument first, so `Array<Array<V>>` accepts an
        // `Array<Array<String>>` (erased, the nested `Array<*>` wouldn't match: type arguments are invariant).
        if (sig.typeParams?.length) {
          const bound = new Map<TypeParamInfo, Type>();
          unify(pattern, t, new Set(sig.typeParams), bound);
          if (bound.size > 0 && assignable(t, erase(subst(pattern, bound)))) return true;
        }
        const c = this.constValue(a);
        return c.ok && valueFits(c.value, pt);
      });
    };
    let fitting = cands.filter((c) => matches(c, true));
    if (fitting.length === 0) fitting = cands.filter((c) => matches(c, false));
    const found = fitting.length > 1 ? this.byCallbackResults(fitting, args, scope) : fitting[0];
    if (found) return found;
    const given = args.map((a, i) => (types[i] ? typeToString(types[i]!) : a.kind === "Function" ? "function" : a.kind === "Array" ? "array literal" : a.kind === "Object" ? "object literal" : "…"));
    const d = this.diags.error("X0604", `no overload of \`${name}\` accepts (${given.join(", ")})`, at, "no matching overload");
    for (const c of cands) d.note(`\`${name}${signatureText(c.decl)}\``);
    for (const a of args) if (literal(a)) this.valueExpr(a.kind === "Spread" ? a.arg : a, scope);
    for (const a of args) this.preTyped.delete(a);
    return undefined;
  }

  /**
   * Could an object literal fit a shape (for choosing an overload, before it is checked)? Its keys
   * must be members and the required members given (unless it spreads), and constant values must
   * fit: a literal member takes only its value, so `{ withFileTypes: true }` picks the overload
   * whose shape says `withFileTypes:true` over the one saying `?withFileTypes:false`. Other values
   * aren't checked here.
   */
  private objectMayFit(e: A.Expr & { kind: "Object" }, shape: ShapeType): boolean {
    const given = new Set<string>();
    const spread = e.props.some((p) => p.kind === "SpreadProp");
    for (const p of e.props) {
      if (p.kind === "SpreadProp") continue;
      const key = p.kind === "Shorthand" ? p.name.name : "name" in p.key ? p.key.name : p.key.kind === "StringKey" ? p.key.value : undefined;
      if (key === undefined) continue; // computed
      given.add(key);
      const member = shape.members.get(key);
      if (!member) return false; // an unknown key (excess members are errors in a literal)
      if (p.kind !== "Prop") continue;
      const c = this.constValue(p.value);
      if (!c.ok) continue;
      const want = nonNull(member.type());
      if (c.value === null) {
        if (!member.optional && !isNullable(member.type())) return false;
        continue;
      }
      // Primitive, literal and union members (`encoding:'buffer'`, `level:0 | 1`) by the value.
      if (membersOf(want).every((m) => m.kind === "prim") && !valueFits(c.value, want, true)) return false;
    }
    return spread || [...shape.members.values()].every((m) => m.optional || given.has(m.name));
  }

  /**
   * Among overloads that all fit, the first whose callbacks type-check with it: overloads may
   * differ only in what a callback returns (`then(f:(value:T) -> Promise<U>)` before
   * `then(f:(value:T) -> U)`). Each function literal is tried with the overload's parameter type
   * as its context; the trial's diagnostics are discarded (the chosen overload checks it for real).
   */
  private byCallbackResults(cands: { decl: A.Method; type: MethodType }[], args: A.Expr[], scope: Scope): { decl: A.Method; type: MethodType } | undefined {
    if (!args.some((a) => a.kind === "Function")) return cands[0];
    const fits = (c: { type: MethodType }) => args.every((a, i) => {
      const p = c.type.params[i];
      if (a.kind !== "Function" || !p || p.rest || p.type.kind !== "method") return true;
      const set = new Set(c.type.typeParams ?? []);
      const context = (set.size ? eraseParams(p.type, [...set]) : p.type) as MethodType;
      const { result, failed } = this.diags.speculate(() => this.fnExpr(a, scope, context));
      if (failed) return false;
      const want = p.type.ret;
      // An untyped result (`*`) can't bind `U` in `Promise<U>`: it fits a bare `U` or a concrete type.
      if (isDynamic(result.ret)) return want.kind === "void" || want.kind === "typeParam" || sameType(eraseParams(want, [...set]), want);
      // `-> Void` among overloads means "returns nothing" (`catch(e => trace(e))`), not "any result ignored".
      if (want.kind === "void") return result.ret.kind === "void";
      if (isDynamic(context.ret) || assignable(result.ret, context.ret)) return true;
      // A generic result (`Promise<U>`): bind it from the callback's result, then compare.
      const bound = new Map<TypeParamInfo, Type>();
      unify(want, result.ret, set, bound);
      return bound.size > 0 && assignable(result.ret, eraseParams(subst(want, bound), [...set]));
    });
    return cands.find(fits) ?? cands[0];
  }

  /** `super(...)`: only as the first statement of a constructor of a class with a superclass. */
  private superCallExpr(e: A.Expr & { kind: "Call" }, scope: Scope): Type {
    const dynamicArgs = () => {
      for (const a of e.args) this.valueExpr(a.kind === "Spread" ? a.arg : a, scope);
    };
    if (e !== this.superCall) {
      const where = this.method?.isConstructor ? "must be the first statement of the constructor" : "is only allowed in a constructor";
      this.diags.error("X0732", `\`super(...)\` ${where}`, e.span);
      dynamicArgs();
      return T.void;
    }
    if (!this.info.parent && !this.info.jsParent) {
      this.diags.error("X0733", `\`${this.info.decl.name.name}\` has no superclass`, e.callee.span);
      dynamicArgs();
      return T.void;
    }
    this.beforeSuper = true;
    try {
      const pc = this.info.parent ? resolveCtor(this.info.parent) : ({ kind: "dynamic" } as CtorRef);
      if (pc.kind === "declared") {
        this.env.checkAccess(pc.decl, pc.owner, this.info, e.callee.span, `the constructor of \`${pc.owner.decl.name.name}\``);
        this.checkArgs(e, memberTypeIn(this.info.parent!, this.info.parentArgs, pc.owner, pc.type) as MethodType, pc.decl, scope);
      } else if (pc.kind === "none") this.checkArgs(e, NO_PARAMS, undefined, scope);
      else dynamicArgs();
    } finally {
      this.beforeSuper = false;
    }
    return T.void;
  }

  /** `super.name`: a method or accessor of the superclass. */
  private superMember(e: A.Expr & { kind: "Member" }): Type {
    this.record(e.object, this.parentType());
    if (this.dynamicThis > 0) {
      this.diags.error("X0737", "`super` can't be used inside a `function` expression", e.object.span)
        .help("use an arrow function, which keeps `this` and `super`");
      return T.error;
    }
    if (this.isStatic) {
      this.diags.error("X0411", "`super` can't be used in a static context", e.object.span);
      return T.error;
    }
    if (this.beforeSuper) {
      this.diags.error("X0736", "`super.member` can't be used before `super(...)` returns", e.span);
      return T.error;
    }
    const parent = this.info.parent;
    if (!parent) {
      if (!this.info.jsParent) this.diags.error("X0733", `\`${this.info.decl.name.name}\` has no superclass`, e.object.span);
      return this.info.jsParent ? T.any : T.error;
    }
    const m = findMember(parent, e.name.name);
    if (m) this.env.checkAccess(readDecl(m), m.owner, this.info, e.name.span);
    if (!m) {
      if (hasJsAncestor(parent)) return T.any;
      const d = this.diags.error("X0426", `no member \`${e.name.name}\` in the superclass \`${parent.decl.name.name}\``, e.name.span);
      const sug = suggest(e.name.name, allMemberNames(parent));
      if (sug) d.help(`a member with a similar name exists: \`${sug}\``, [{ span: e.name.span, text: sug }]);
      return T.error;
    }
    this.memberUse(e, m, e.name.span);
    if (isAbstract(m) || m.owner.decl.isInterface) {
      this.diags.error("X0718", `\`${m.owner.decl.name.name}.${e.name.name}\` is abstract and has no implementation to call`, e.span)
        .secondary(m.decl.name.span, "declared abstract here");
      return T.error;
    }
    if (m.kind === "field") {
      this.diags.error("X0735", "fields can't be accessed through `super`", e.span)
        .help(`use \`this.${e.name.name}\``, [{ span: e.object.span, text: "this" }]);
      return T.error;
    }
    if (m.isStatic) {
      const owner = m.owner.decl.name.name;
      this.diags.error("X0413", `\`${e.name.name}\` is static; access it through the class`, e.name.span)
        .help(`use \`${owner}.${e.name.name}\``, [{ span: e.span, text: `${owner}.${e.name.name}` }]);
      return T.error;
    }
    return this.seenThrough(this.parentType(), m);
  }

  /** The superclass as seen from this class: `Box<int>` for `class IntBox extends Box<int>`. */
  private parentType(): Type {
    const parent = this.info.parent;
    if (!parent) return T.any;
    return this.info.parentArgs.length ? { kind: "class", info: parent, args: this.info.parentArgs } : { kind: "class", info: parent };
  }

  /** Declaration of a called method, for "defined here" labels. */
  private calleeDecl(callee: A.Expr): A.Method | undefined {
    let m: MemberSig | undefined;
    const r = this.env.result.resolutions.get(callee);
    if (r?.kind === "function") return r.decl;
    if (callee.kind === "Ident") m = findMember(this.info, callee.name) ?? this.env.rootMember(callee.name);
    else if (callee.kind === "Member") {
      const objType = this.env.result.exprTypes.get(callee.object);
      const own = objType && nonNull(objType);
      if (own?.kind === "class" || own?.kind === "classRef") m = findMember(own.info, callee.name.name);
      // A string's or number's method: the standard library's declaration (`'a'.trim()`).
      if (!m && own?.kind === "prim") {
        const info = this.env.primClass(own.name);
        m = info && findMember(info, callee.name.name);
      }
      if (!m && (objType?.kind === "method" || (objType?.kind === "builtin" && objType.name === "Function"))) m = this.env.functionMember(callee.name.name);
      if (!m && objType?.kind !== "classRef") m = this.env.rootMember(callee.name.name);
    }
    return m?.decl.kind === "Method" ? m.decl : undefined;
  }

  private checkArgs(e: { args: A.Expr[]; span: Span }, sig: MethodType, decl: A.Method | undefined, scope: Scope) {
    const hasSpread = e.args.some((a) => a.kind === "Spread");
    const required = requiredParams(sig.params);
    const rest = sig.params.find((p) => p.rest);
    const max = rest ? Infinity : sig.params.length;
    if (!hasSpread && (e.args.length < required || e.args.length > max)) {
      const expected = required === max ? `${required}` : max === Infinity ? `at least ${required}` : `${required} to ${max}`;
      const message = `this call takes ${expected} argument${expected === "1" ? "" : "s"} but ${e.args.length} ${e.args.length === 1 ? "was" : "were"} given`;
      let d: DiagnosticBuilder;
      if (e.args.length > max) {
        const extra = e.args.slice(max);
        const n = extra.length;
        d = this.diags.error("X0601", message, cover(extra[0]!.span, extra.at(-1)!.span), `unexpected argument${n === 1 ? "" : "s"}`);
      } else {
        const missing = sig.params.slice(e.args.length, required);
        const list = missing.map((p) => `\`${p.name}:${typeToString(p.type)}\``).join(", ");
        d = this.diags.error("X0601", message, e.span, `missing ${list}`);
      }
      if (decl) d.secondary(decl.name.span, `\`${decl.isConstructor ? "constructor" : decl.name.name}\` defined here`);
    }
    e.args.forEach((a, i) => {
      if (a.kind === "Spread") {
        this.valueExpr(a.arg, scope);
        return;
      }
      const p = i < sig.params.length && !sig.params[i]!.rest ? sig.params[i] : rest;
      if (!p) {
        this.valueExpr(a, scope);
        return;
      }
      let want = p.type;
      if (p.rest) want = want.kind === "builtin" && want.args.length === 1 ? want.args[0]! : T.any;
      const pDecl = decl?.params[Math.min(i, decl.params.length - 1)];
      this.checkAssign(a, want, pDecl?.type && { span: pDecl.type.span, label: "parameter declared here" }, scope);
    });
  }

  private newExpr(e: A.Expr & { kind: "New" }, scope: Scope): Type {
    const t = e.callee;
    const dynamicArgs = () => {
      for (const a of e.args) this.valueExpr(a.kind === "Spread" ? a.arg : a, scope);
    };
    if (t.kind === "TypeName" && t.name.length === 1) {
      const name = t.name[0]!.name;
      // `new cls(…)` with a local holding a class (AS3 style): a dynamic instance.
      const local = scope.get(name);
      if (local && t.args.length === 0) {
        local.used = true;
        const lt = local.type;
        if (lt.kind === "builtin" && lt.name === "Class" && lt.args.length > 0) {
          this.diags.error("X0831", `\`new\` isn't available through a \`${typeToString(lt)}\``, t.span, "its constructor's parameters are unknown")
            .help("pass a function creating the value instead (`() -> T`), or use an untyped `Class` for a dynamic `new`");
        } else if (!isDynamic(lt) && !(lt.kind === "builtin" && (lt.name === "Class" || lt.name === "Function")) && lt.kind !== "classRef") {
          this.diags.error("X0415", `\`${name}\` is a \`${typeToString(lt)}\` and can't be instantiated with \`new\``, t.span);
        }
        dynamicArgs();
        return T.any;
      }
      if (!this.scope.classes.has(name) && !this.scope.ambiguous.has(name) && (this.env.isJsImport(this.scope, name) || this.env.isGlobal(this.scope, name))) {
        dynamicArgs();
        return T.any;
      }
    }
    const expected = this.takeExpected();
    let type = this.resolveT(t, this.scope, false, true);
    if (type.kind === "class" && type.info.decl.isEnum) {
      this.diags.error("X0815", `\`${type.info.decl.name.name}\` is an enum; use one of its members`, t.span)
        .help(`for example \`${type.info.decl.name.name}.${type.info.enumValues?.keys().next().value ?? "Member"}\``);
      dynamicArgs();
      return type;
    }
    if (type.kind === "class" && type.info.decl.modifiers.static) {
      this.diags.error("X0415", `static class \`${type.info.decl.name.name}\` can't be instantiated`, t.span)
        .secondary(type.info.decl.modifiers.static, "declared `static` here");
      dynamicArgs();
      return type;
    }
    if (type.kind === "class" && type.info.decl.isInterface) {
      this.diags.error("X0786", `\`${type.info.decl.name.name}\` is an interface and can't be instantiated`, t.span)
        .help("create an instance of a class that implements it");
      dynamicArgs();
      return type;
    }
    if (type.kind === "class" && type.info.decl.modifiers.abstract) {
      this.diags.error("X0710", `\`${type.info.decl.name.name}\` is abstract and can't be instantiated`, t.span)
        .secondary(type.info.decl.modifiers.abstract, "declared `abstract` here")
        .help("create an instance of a concrete subclass");
      dynamicArgs();
      return type;
    }
    if (type.kind === "class") {
      const info = type.info;
      const ctor = resolveCtor(info);
      const generic = info.typeParams.length > 0 && !type.args?.length; // `new Box(5)`: infer `T`
      if (generic && ctor.kind !== "declared") {
        const own = ownType(info);
        const out = new Map<TypeParamInfo, Type>();
        if (expected) unify(own, expected, new Set(info.typeParams), out);
        const missing = info.typeParams.filter((p) => !out.has(p));
        if (missing.length > 0) {
          this.diags.error("X0797", `can't infer the type of ${missing.map((v) => `\`${v.name}\``).join(", ")}`, t.span)
            .help(`write the type arguments: \`new ${info.decl.name.name}<…>()\``);
        }
        type = { kind: "class", info, args: info.typeParams.map((p) => out.get(p) ?? T.any) };
      }
      if (ctor.kind === "declared") {
        // An inherited constructor is as visible as the class (like a JS default constructor);
        // the parent's constructor access is checked where the subclass is declared.
        if (ctor.owner === info && isNative(info) && visibilityOf(ctor.decl) === "private") {
          // A native with a hidden constructor is a namespace (`JSON`, `Math`) or a primitive.
          this.diags.error("X0415", `\`${info.decl.name.name}\` can't be instantiated with \`new\``, t.span)
            .note(`\`${info.decl.name.name}\` only has static members, e.g. \`${info.decl.name.name}.${staticExample(info)}\``);
          return T.error;
        }
        if (ctor.owner === info) this.env.checkAccess(ctor.decl, ctor.owner, this.info, t.span, `the constructor of \`${ctor.owner.decl.name.name}\``);
        if (ctor.owner.ctorOverloads) {
          // Native constructor overloads (`new Date()`, `new Date(ms)`, `new Date(text)`).
          const all = [{ decl: ctor.decl, type: ctor.type }, ...ctor.owner.ctorOverloads].map((c) => ({
            decl: c.decl,
            type: memberTypeIn(info, (type as { args?: Type[] }).args ?? info.typeParams.map(() => T.any), ctor.owner, c.type) as MethodType,
          }));
          const pick = this.pickOverload(all, e.args, scope, t.span, `new ${info.decl.name.name}`);
          if (pick) this.checkArgs(e, pick.type, pick.decl, scope);
          if (generic) type = { kind: "class", info, args: info.typeParams.map(() => T.any) };
          return type;
        }
        if (generic) {
          // The constructor's parameters in terms of this class's own type parameters.
          const pattern = memberTypeIn(info, info.typeParams.map((param) => ({ kind: "typeParam" as const, param })), ctor.owner, ctor.type) as MethodType;
          const { sig, bindings } = this.instantiate(pattern, info.typeParams, e.args, scope, t.span, expected && [ownType(info), expected]);
          type = { kind: "class", info, args: info.typeParams.map((p) => bindings.get(p) ?? T.any) };
          this.checkArgs(e, sig, ctor.decl, scope);
        } else {
          this.checkArgs(e, memberTypeIn(info, type.args ?? [], ctor.owner, ctor.type) as MethodType, ctor.decl, scope);
        }
      } else if (ctor.kind === "none" && e.args.length > 0) {
        this.diags.error("X0601", `\`${type.info.decl.name.name}\` has no constructor parameters but ${e.args.length} argument${e.args.length === 1 ? " was" : "s were"} given`, e.span);
        dynamicArgs();
      } else if (ctor.kind === "dynamic") dynamicArgs();
      return type;
    }
    dynamicArgs();
    if (type.kind === "builtin" && type.name === "Function") {
      this.diags.error("X0415", "`Function` can't be instantiated with `new`", t.span)
        .note("`new Function('code')` compiles source text at runtime, like `eval`")
        .help("write the function as an arrow: `(x:Int):Int => x * 2`");
      dynamicArgs();
      return type;
    }
    if (type.kind === "builtin" || isDynamic(type)) return type;
    const d = this.diags.error("X0415", `\`${typeToString(type)}\` can't be instantiated with \`new\``, t.span);
    if (type.kind === "prim" && type.name in CASTS && type.name !== "Int" && type.name !== "UInt") {
      d.note("in JavaScript this creates a wrapper object, which is always truthy and never `==` a primitive value")
        .help(`to convert a value, call \`${type.name}(x)\` without \`new\``, [{ span: span(e.span.file, e.span.start, t.span.start), text: "" }]);
    }
    return T.error;
  }

  private unary(e: A.Expr & { kind: "Unary" }, scope: Scope): Type {
    let t = this.valueExpr(e.arg, scope);
    if (e.op !== "typeof" && e.op !== "delete" && e.op !== "void") t = this.mayBeNull(e.arg, t);
    const opSpan = span(e.span.file, e.span.start, e.span.start + e.op.length);
    switch (e.op) {
      case "!":
        if (!isPrim(t, "Bool") && !isDynamic(t)) this.opError(opSpan, "`!` needs a `Bool`", e.arg, t);
        return T.Boolean;
      case "-":
      case "+":
        if (isDynamic(t)) return T.any;
        if (!isNumeric(t)) {
          this.opError(opSpan, `cannot apply unary \`${e.op}\` to \`${typeToString(t)}\``, e.arg, t);
          return T.error;
        }
        return isPrim(t, "UInt") && e.op === "-" ? T.int : t;
      case "~":
        if (!isNumeric(t) && !isDynamic(t)) this.opError(opSpan, "`~` needs a number", e.arg, t);
        return T.int;
      case "typeof":
        return T.String;
      case "delete": {
        if (e.arg.kind !== "Member" && e.arg.kind !== "Index") {
          this.diags.error("X0316", "`delete` needs a property access", e.arg.span);
          return T.Boolean;
        }
        // Only dynamic objects can lose properties; class members are fixed.
        const objType = this.env.result.exprTypes.get(e.arg.object);
        if (objType && !isDynamic(objType) && !(objType.kind === "builtin" && (objType.name === "Object" || objType.name === "Array"))) {
          this.diags.error("X0316", `can't \`delete\` a property of \`${typeToString(objType)}\``, e.arg.span)
            .note("`delete` only works on `*` and `Object` values");
        }
        return T.Boolean;
      }
    }
    return T.error;
  }

  /** `x is T` (Boolean) and `x as T` (T, or null when the value has another type). */
  private typeOp(e: A.Expr & { kind: "TypeOp" }, scope: Scope): Type {
    const from = this.valueExpr(e.expr, scope);
    const t = e.type;
    // Span of the `is`/`as` keyword itself.
    const kwStart = e.span.file.text.indexOf(e.op, e.expr.span.end);
    const opSpan = span(e.span.file, kwStart, kwStart + e.op.length);
    // JS classes (imports and globals such as `Response`, `Map`) are tested with `instanceof`.
    if (t.kind === "TypeName" && t.name.length === 1 && t.args.length === 0) {
      const name = t.name[0]!.name;
      // `x is kind` / `x as kind` with a local holding a class (`kind:Class<T>`): `instanceof` that class.
      const local = !this.scope.classes.has(name) && !this.scope.typedefs.has(name) ? scope.get(name) : undefined;
      const held = local && classValueOf(local.type);
      if (local && held) {
        local.used = true;
        this.env.result.typeChecks.set(e, { kind: "js", name });
        this.env.result.typeNodeTypes.set(t, held);
        return e.op === "is" ? T.Boolean : isDynamic(held) ? T.any : nullableOf(held);
      }
      if (!this.scope.classes.has(name) && !(name in BUILTIN_TYPES) && (this.env.isJsImport(this.scope, name) || this.env.isGlobal(this.scope, name))) {
        this.env.result.typeChecks.set(e, { kind: "js", name });
        return e.op === "is" ? T.Boolean : T.any;
      }
    }
    const written = this.resolveT(t, this.scope, false, true);
    if (written.kind === "nullable" && e.op === "is") {
      const q = span(t.span.file, t.span.end - 1, t.span.end);
      this.diags.error("X0395", `\`is ${typeToString(written)}\` is the same as \`is ${typeToString(written.inner)}\``, t.span, "`null` never passes `is`")
        .help("remove the `?`", [{ span: q, text: "" }]);
    }
    // `x as int?`: checked like `int`; values of other types (and `null`) give `null`.
    const target = nonNull(written);
    // `x as *`: give up static typing for this value (the escape hatch for undeclared JS APIs).
    if (target.kind === "any" && e.op === "as") return T.any;
    if (target.kind === "class" && target.args?.length && e.op === "is") {
      this.diags.error("X0394", `\`${typeToString(target)}\` can't be checked at runtime`, t.span, "type arguments are erased")
        .help(`test the class: \`is ${target.info.decl.name.name}\``);
      return T.Boolean;
    }
    if (target.kind === "typeParam") {
      this.diags.error("X0394", `type parameter \`${target.param.name}\` can't be checked at runtime`, t.span, "type parameters are erased");
      return e.op === "is" ? T.Boolean : T.error;
    }
    if (target.kind === "shape" || target.kind === "method") {
      // Structural types are erased: `as` is an unchecked cast, `is` is impossible.
      if (e.op === "is") {
        this.diags.error("X0794", `\`${typeToString(target)}\` is a structural type and can't be tested at runtime`, t.span)
          .note("typedef shapes and function types are erased when compiling");
        return T.Boolean;
      }
      if (!isDynamic(from) && !(from.kind === "builtin" && from.name === "Object") && !assignable(from, target) && !assignable(target, from)) {
        this.diags.error("X0396", `\`${typeToString(from)}\` values can never be \`${typeToString(target)}\``, cover(opSpan, t.span));
      }
      return target;
    }
    if (literalOf(target) !== undefined) {
      // `x is true` would test only for a `Boolean` (and `as` would let `false` through).
      this.diags.error("X0394", `\`${typeToString(target)}\` can't be checked at runtime`, t.span, "a literal type")
        .help(`compare the value instead: \`${spanText(e.expr.span)} == ${typeToString(target)}\``);
      return e.op === "is" ? T.Boolean : T.error;
    }
    if (target.kind === "union") {
      const d = this.diags.error("X0394", `\`${typeToString(target)}\` can't be checked at runtime`, t.span, "a union type");
      const tests = target.types.map((m) => `${spanText(e.expr.span)} is ${testable(m)}`);
      if (target.types.every((m) => runtimeCheck(m))) d.help(`test its members: \`${tests.join(" || ")}\``);
      return e.op === "is" ? T.Boolean : T.error;
    }
    const check = runtimeCheck(target);
    if (target.kind === "error") return e.op === "is" ? T.Boolean : T.error;
    if (!check) {
      const d = this.diags.error("X0394", `\`${typeToString(target)}\` can't be checked at runtime`, t.span);
      if (elementOf(target)) d.help("check `is Array`; element types are not known at runtime");
      return e.op === "is" ? T.Boolean : T.error;
    }
    // `v is int` where `v` is an `int | String`: its only numbers are `int`s, so `typeof v === 'number'`
    // decides (and TypeScript narrows on it, as it can't on `Number.isInteger`).
    const sourceNumbers = isDynamic(from) ? [] : membersOf(from).filter((m) => isNumeric(m) || (m.kind === "builtin" && m.name === "Object"));
    const onlyThese = sourceNumbers.length > 0 && sourceNumbers.every((m) => m.kind === "prim" && m.name === (target as { name?: string }).name);
    this.env.result.typeChecks.set(e, (check.kind === "int" || check.kind === "uint") && onlyThese ? { kind: "typeof", tag: "number" } : check);
    // `as int` can't give `null` (write `int?`); with null safety, `as Shape` simply gives `Shape?`.
    if (e.op === "as" && !isNullable(target) && written.kind !== "nullable" && !(nullSafety.on && !isLegacyValueType(target))) {
      const fn = typeToString(target);
      this.diags.error("X0393", `\`as ${fn}\` is not possible: \`${fn}\` can never be null`, cover(opSpan, t.span))
        .help(`cast to \`${fn}?\`, which gives \`null\` for other values`, [{ span: span(t.span.file, t.span.end, t.span.end), text: "?" }])
        .help(`or convert with \`${fn}(x)\`, or test with \`x is ${fn}\``);
      return T.error;
    }
    if (!isDynamic(from) && !(from.kind === "builtin" && from.name === "Object")) {
      if (assignable(from, target) && from.kind !== "null") {
        this.diags.warning("X0397", e.op === "is" ? `this test is always true unless the value is null` : "unnecessary cast", cover(opSpan, t.span))
          .secondary(e.expr.span, `already \`${typeToString(from)}\``);
      } else if (!assignable(target, from) && !involvesInterface(from, target) && !enumFromRaw(from, target)) {
        this.diags.error("X0396", `\`${typeToString(from)}\` values can never be \`${typeToString(target)}\``, cover(opSpan, t.span))
          .secondary(e.expr.span, `\`${typeToString(from)}\``);
      }
    }
    // `x as Shape` gives `null` for other values: with null safety that is a `Shape?`.
    return e.op === "is" ? T.Boolean : nullSafety.on ? nullableOf(written) : written;
  }

  private opError(at: Span, message: string, operand: A.Expr, t: Type) {
    this.diags.error("X0315", message, at).secondary(operand.span, `this is \`${typeToString(t)}\``);
  }

  private update(e: A.Expr & { kind: "Update" }, scope: Scope): Type {
    const { type: target, commit } = this.lvalue(e.arg, scope, false);
    commit();
    const t = this.mayBeNull(e.arg, target, true);
    if (!isNumeric(t) && !isDynamic(t)) {
      this.opError(e.span, `\`${e.op}\` needs a number`, e.arg, t);
      return T.error;
    }
    return t;
  }

  private binary(e: A.Expr & { kind: "Binary" }, scope: Scope): Type {
    if (["==", "!=", "===", "!=="].includes(e.op)) return this.equality(e, scope);
    const l = this.valueExpr(e.left, scope);
    // `x != null && x > 0`, `x == null || x > 0`: the right side knows `x` isn't null.
    const rightScope = e.op === "&&" ? scope.withFacts(this.facts(e.left, scope).whenTrue)
      : e.op === "||" ? scope.withFacts(this.facts(e.left, scope).whenFalse) : scope;
    const r = this.valueExpr(e.right, rightScope);
    if (OVERLOADABLE.has(e.op)) {
      const ret = this.operatorCall(e, e.op, l, r, e.left, e.right, e.opSpan);
      if (ret) return ret;
    }
    return this.binaryResult(e.op, l, r, e.opSpan, e.left, e.right) ?? T.error;
  }

  /**
   * `left op right` (`+`, `-`, `*`, `/`, also as `+=` & co.) where the left operand's class declares
   * `operator<op>`: a method call, dispatched statically on the left type. `+` with a `String`
   * concatenates as usual. Returns undefined if not applicable.
   */
  private operatorCall(node: A.Expr, op: string, l: Type, r: Type, left: A.Expr, right: A.Expr, opSpan: Span): Type | undefined {
    if (l.kind !== "class" || (op === "+" && isPrim(r, "String"))) return undefined;
    const name = `operator${op}`;
    const m = findMember(l.info, name);
    if (!m || m.kind !== "method" || m.isStatic) return undefined;
    this.env.usedMembers.add(m);
    this.env.checkAccess(m.decl, m.owner, this.info, opSpan);
    const onThis = left.kind === "This";
    if (this.constMethod && onThis && !isConstMember(m)) {
      this.diags.error("X0902", `cannot use non-const method \`${name}\` in const method \`${this.constMethod}\``, opSpan)
        .secondary(m.decl.name.span, `\`${name}\` is not \`const\``);
    }
    const sig = this.seenThrough(l, m) as MethodType;
    const param = sig.params[0];
    if (param && !assignable(r, param.type)) {
      const decl = m.decl as A.Method;
      this.mismatch(right, r, param.type, decl.params[0]?.type && { span: decl.params[0].type.span, label: `\`${name}\` parameter declared here` });
    }
    this.env.result.operatorCalls.add(node);
    // A `constexpr` operator on objects built at compile time: evaluated now (`new V(1, 2) == new V(1, 2)` → `true`).
    if (isConstexpr(m)) {
      const f = this.constValue(node);
      if (f.ok && isPrimitive(f.value)) this.env.result.inlineValues.set(node, f.value);
    }
    return sig.ret;
  }

  /** X0370: an arithmetic operator on an object whose class doesn't declare it. */
  private noOperator(op: string, l: Type, left: A.Expr, opSpan: Span, note?: string): undefined {
    const d = this.diags.error("X0370", `\`${op}\` is not defined for \`${typeToString(l)}\``, opSpan)
      .secondary(left.span, `\`${typeToString(l)}\``);
    d.note(note ?? `declare \`public function operator${op}(other:…):…\` in the class to define it`);
    return undefined;
  }

  /** Result type of a binary operator; reports and returns undefined when it doesn't apply. */
  private binaryResult(op: string, l: Type, r: Type, opSpan: Span, left: A.Expr, right: A.Expr): Type | undefined {
    if (l.kind === "error" || r.kind === "error") return T.error;
    // `n + 1` with `n:int?` needs a value; `'n = ' + n` (concatenation) and `n ?? 0` don't.
    const concat = op === "+" && (isPrim(nonNull(l), "String") || isPrim(nonNull(r), "String"));
    if (op !== "??" && !concat) {
      l = this.mayBeNull(left, l);
      r = this.mayBeNull(right, r);
    }
    const dyn = isDynamic(l) || isDynamic(r);
    const fail = (why?: string) => {
      this.diags.error("X0315", why ?? `cannot apply \`${op}\` to \`${typeToString(l)}\` and \`${typeToString(r)}\``, opSpan)
        .secondary(left.span, `\`${typeToString(l)}\``)
        .secondary(right.span, `\`${typeToString(r)}\``);
      return undefined;
    };
    switch (op) {
      case "+":
        if (isPrim(l, "String") || isPrim(r, "String")) return T.String;
        if (dyn) return T.any;
        if (isNumeric(l) && isNumeric(r)) return arithmeticResult(l, r);
        if (l.kind === "class") return this.noOperator(op, l, left, opSpan, "concatenating with a `String` works; other uses need `operator+`");
        return fail();
      case "-": case "*": case "%":
        if (dyn) return T.any;
        if (isNumeric(l) && isNumeric(r)) return arithmeticResult(l, r);
        if (l.kind === "class" && op !== "%") return this.noOperator(op, l, left, opSpan);
        return fail();
      case "/": case "**":
        if (dyn) return T.any;
        if (isNumeric(l) && isNumeric(r)) return T.Float;
        if (l.kind === "class" && op === "/") return this.noOperator(op, l, left, opSpan);
        return fail();
      case "&": case "|": case "^": case "<<": case ">>": case ">>>":
        if (!dyn && !(isNumeric(l) && isNumeric(r))) return fail();
        return op === ">>>" ? T.uint : T.int;
      case "<": case ">": case "<=": case ">=":
        if (!dyn && !(isNumeric(l) && isNumeric(r)) && !(isPrim(l, "String") && isPrim(r, "String"))) fail();
        return T.Boolean;
      case "&&": case "||": {
        // One error per expression (the first non-`Boolean` side), and none that follow from it.
        let reported = false;
        for (const [t, side] of [[l, left], [r, right]] as const) {
          if (!reported && !isPrim(t, "Bool") && !isDynamic(t)) {
            reported = true;
            const d = this.diags.error("X0315", `\`${op}\` needs \`Boolean\` operands`, side.span, `this is \`${typeToString(t)}\``);
            const n = nonNull(t);
            if (op === "||" && side === left && (isPrim(n, "String") || isNumeric(n))) {
              // `s || 'default'`: JavaScript's `||` also replaces `''` (and `0`), which `??` doesn't.
              const empty = isPrim(n, "String") ? "''" : "0";
              const what = isPrim(n, "String") ? "an empty string" : "`0`";
              d.note(`in JavaScript, \`||\` also replaces ${what}; \`??\` replaces only \`null\``);
              const text = spanText(left.span);
              if (left.kind === "Ident") {
                d.help(`test it explicitly`, [{ span: cover(left.span, right.span), text: `${text} != ${empty} ? ${text} : ${spanText(right.span)}` }]);
              } else {
                d.help(`keep the value in a local and test it: \`final value:${typeToString(n)} = …\`, then \`value != ${empty} ? value : ${spanText(right.span)}\``);
              }
              if (isNullable(t)) d.help("or use `??` if only `null` should get the default");
            } else if (op === "||" && isNullable(t)) d.help("use `??` for a default value when something is null");
          }
        }
        return reported ? T.error : T.Boolean;
      }
      case "??":
        if (!isNullable(l) && !isDynamic(l)) {
          this.diags.warning("X0317", `\`??\` has no effect: \`${typeToString(l)}\` can never be null`, opSpan)
            .secondary(left.span, `\`${typeToString(l)}\``);
        }
        if (dyn) return T.any;
        // `n ?? 0` with `n:int?` is an `int`; `n ?? other` with `other:int?` stays `int?`.
        if (assignable(r, nonNull(l))) return l.kind === "null" ? r : r.kind === "nullable" ? l : nonNull(l);
        if (assignable(nonNull(l), r)) return r;
        return fail(`the two sides of \`??\` have incompatible types \`${typeToString(l)}\` and \`${typeToString(r)}\``);
      case "in":
        return T.Boolean;
    }
    return T.any;
  }

  private equality(e: A.Expr & { kind: "Binary" }, scope: Scope): Type {
    if (e.op === "===" || e.op === "!==") {
      const short = e.op === "===" ? "==" : "!=";
      this.diags.warning("X0841", `\`${e.op}\` is the same as \`${short}\` in Xenon`, e.opSpan)
        .note("`==` and `!=` are always strict in Xenon")
        .help(`use \`${short}\``, [{ span: e.opSpan, text: short }]);
    }
    const types: Type[] = [];
    for (const side of [e.left, e.right]) {
      if (side.kind === "Undefined") {
        this.undefinedWarning(side.span, true);
        types.push(this.record(side, T.any));
      } else types.push(this.valueExpr(side, scope));
    }
    const [l, r] = types as [Type, Type];
    // `a == b` with `operator==` on `a`'s class (`!=` negates it); `== null` stays a null check.
    if (e.left.kind !== "Null" && e.right.kind !== "Null" && r.kind !== "null") {
      const left = nonNull(l);
      if (left.kind === "class" && this.operatorCall(e, "==", left, nonNull(r), e.left, e.right, e.opSpan)) return T.Boolean;
    }
    // Null safety: `s == null` on a `String` is a (defensive) check that can't succeed: a warning.
    if (nullSafety.on && (l.kind === "null") !== (r.kind === "null") && !comparable(l, r)) {
      const other = l.kind === "null" ? r : l;
      this.diags.warning("X0818", `this comparison is always ${e.op.startsWith("!") ? "true" : "false"}`, e.opSpan)
        .secondary(l.kind === "null" ? e.right.span : e.left.span, `\`${typeToString(other)}\` can't be null`)
        .help(`declare the type \`${typeToString(other)}?\` if \`null\` is meant to be possible`);
      return T.Boolean;
    }
    if (!comparable(l, r)) {
      const d = this.diags.error("X0309", `this comparison is always ${e.op.startsWith("!") ? "true" : "false"}`, e.opSpan)
        .secondary(e.left.span, `\`${typeToString(l)}\``)
        .secondary(e.right.span, `\`${typeToString(r)}\``);
      if (l.kind === "null" || r.kind === "null") d.note(`\`${typeToString(l.kind === "null" ? r : l)}\` can never be null`);
      else d.note("`==` never converts between types in Xenon");
    }
    return T.Boolean;
  }

  /**
   * Assignment target. Returns its type and a `commit` that records the write; call it after the
   * assigned value has been checked (`x = x + 1` reads `x` before writing it).
   * `plain` is true for `=` (the target is not read), false for `+=`, `++`, ….
   */
  private lvalue(target: A.Expr, scope: Scope, plain: boolean): { type: Type; commit: () => void } {
    const none = () => {};
    const evalTarget = () => {
      const saved = this.writing;
      this.writing = plain;
      try {
        return this.expr(target, scope);
      } finally {
        this.writing = saved;
      }
    };
    if (target.kind === "Ident") {
      const local = scope.get(target.name);
      const read = evalTarget();
      const type = plain && local ? local.type : read; // `x = …` checks against the declared type, `x += …` reads the narrowed one
      if (local?.kind === "range") {
        this.diags.error("X0332", `the range loop variable \`${target.name}\` can't be assigned`, target.span)
          .secondary(local.nameSpan, "declared by the range loop here")
          .note("use a `while` loop or a C-style `for` to control the counter yourself");
        return { type, commit: none };
      }
      if (local && this.da.has(local)) {
        if (this.nonNullLocals.has(local)) return { type, commit: () => this.da.set(local, "yes") };
        return { type, commit: () => this.daWrite(local, target.span, local.nameSpan, `final \`${target.name}\``) };
      }
      if (local && (local.kind === "const" || local.kind === "final")) {
        this.diags.error("X0501", `cannot assign twice to ${local.kind} \`${target.name}\``, target.span)
          .secondary(local.nameSpan, `declared \`${local.kind}\` here`);
        return { type, commit: none };
      }
      if (!local) return { type, commit: this.memberWrite(target.name, this.info, target.span, true) };
      return { type, commit: none };
    }
    if (target.kind === "Member") {
      const type = evalTarget();
      const objType = this.env.result.exprTypes.get(target.object);
      if (objType?.kind === "shape" && objType.members.get(target.name.name)?.readonly) {
        this.diags.error("X0793", `\`${target.name.name}\` is read-only in \`${typeToString(objType)}\``, target.name.span)
          .note("it is declared `final` in the shape");
      }
      // A primitive's members come from its std class (`s.length = 3` is a getter-only write).
      const primCls = objType?.kind === "prim" ? this.env.primClass(objType.name) : undefined;
      if (primCls) return { type, commit: this.memberWrite(target.name.name, primCls, target.name.span, false) };
      // Function values: `f.name` is read-only, `f.call` a method.
      const fnCls = objType?.kind === "method" || (objType?.kind === "builtin" && objType.name === "Function") ? this.env.classes.get("xenon.Function") : undefined;
      if (fnCls) return { type, commit: this.memberWrite(target.name.name, fnCls, target.name.span, false) };
      if (objType?.kind === "class" || objType?.kind === "classRef") {
        const own = target.object.kind === "This" || (objType.kind === "classRef" && objType.info === this.info);
        return { type, commit: this.memberWrite(target.name.name, objType.info, target.name.span, own) };
      }
      return { type, commit: none };
    }
    if (target.kind === "Index") return { type: this.expr(target, scope), commit: none };
    this.diags.error("X0105", "invalid assignment target", target.span);
    return { type: T.error, commit: none };
  }

  /** Checks a write to a member; returns the definite-assignment commit for tracked `final` fields. */
  private memberWrite(name: string, info: ClassInfo, at: Span, own: boolean): () => void {
    const none = () => {};
    const m = findMember(info, name) ?? (hasJsAncestor(info) ? undefined : this.env.rootMember(name));
    if (!m) return none;
    this.env.usedMembers.add(m);
    // `public get` + `private set`: the read was checked against the getter, the write needs the setter.
    const setter = m.kind === "accessor" ? accessorHalf(m, "set") : undefined;
    if (setter && setter !== readDecl(m)) this.env.checkAccess(setter, m.owner, this.info, at, `the setter of \`${name}\``);
    if (this.constMethod && own && !m.isStatic && m.kind !== "method") {
      this.diags.error("X0901", `cannot change \`${name}\` in const method \`${this.constMethod}\``, at, `assigns \`this.${name}\``)
        .note("a `const` method doesn't change the object; remove `const` if it has to");
      return none;
    }
    // A non-null `var` field being given its first value (any number of times; reads before it are errors).
    if (own && this.nonNullFields.has(m) && this.da.has(m)) return () => this.da.set(m, "yes");
    if (m.readonly === "const") {
      this.diags.error("X0501", `cannot assign to constant \`${name}\``, at).secondary(m.decl.name.span, "declared `const` here");
    } else if (m.readonly === "getter") {
      this.diags.error("X0504", `\`${name}\` has a getter but no setter`, at).secondary(m.decl.name.span, "getter declared here");
    } else if (m.kind === "method") {
      this.diags.error("X0505", `cannot assign to method \`${name}\``, at);
    } else if (m.readonly === "final") {
      if (own && this.da.has(m)) return () => this.daWrite(m, at, m.decl.name.span, `final field \`${name}\``);
      const where = m.isStatic ? "in a `static { }` block of its class" : "in the constructor of its class";
      this.diags.error("X0502", `\`${name}\` is \`final\` and can only be assigned ${where}`, at)
        .secondary(m.decl.name.span, "declared `final` here");
    }
    return none;
  }

  private assign(e: A.Expr & { kind: "Assign" }, scope: Scope): Type {
    const { type: targetType, commit } = this.lvalue(e.target, scope, e.op === "=");
    const origin = this.declOrigin(e.target, scope);
    if (e.op === "=") {
      this.checkAssign(e.value, targetType, origin, scope);
      commit();
      this.assigned(e.target, this.env.result.exprTypes.get(e.value), scope);
      return targetType;
    }
    const op = e.op.slice(0, -1);
    const r = this.valueExpr(e.value, scope);
    commit();
    const overloaded = OVERLOADABLE.has(op) ? this.operatorCall(e, op, targetType, r, e.target, e.value, e.opSpan) : undefined;
    const result = overloaded ?? this.binaryResult(op, targetType, r, e.opSpan, e.target, e.value);
    this.assigned(e.target, result, scope);
    if (result && !assignable(result, targetType)) {
      const d = this.diags.error("X0308", "mismatched types", e.span, `\`${e.op}\` produces \`${typeToString(result)}\`, but the target is \`${typeToString(targetType)}\``);
      if (origin) d.secondary(origin.span, origin.label);
      if (isPrim(targetType, "Int") && op === "/") d.help("use `x = Int(x / y)` for integer division");
    }
    return targetType;
  }

  /**
   * After `x = value` / `x ??= 0`: a nullable or union local is narrowed to what the value can be
   * (a non-null value: non-null; a `String` into an `int | String`: `String`); anything else ends
   * its narrowing.
   */
  private assigned(target: A.Expr, value: Type | undefined, scope: Scope) {
    if (target.kind !== "Ident") return;
    const local = scope.get(target.name);
    if (!local) return;
    // A new value ends what checks proved about the old one (`a is Dog`, `x != null`).
    scope.unnarrow(local);
    if (local.type.kind !== "nullable" && local.type.kind !== "union") return;
    if (!value || isDynamic(value) || value.kind === "nullable" || value.kind === "null") return;
    const kept = membersOf(local.type).filter((m) => membersOf(value).some((v) => assignable(v, m)));
    scope.narrow({ local, type: kept.length > 0 ? unionOf(kept) : nonNull(local.type) });
  }

  /** A local's type at this point (narrowed by checks so far). */
  private currentType(local: Local, scope: Scope): Type {
    return scope.typeOf(local).type;
  }

  /**
   * What a condition proves about locals when true / false: `x != null` (non-null), `x is T` and
   * `x == 'utf8'` (union members), through `!`, `&&` and `||`.
   */
  private facts(e: A.Expr, scope: Scope): Facts {
    switch (e.kind) {
      case "TypeOp": {
        if (e.op !== "is" || e.expr.kind !== "Ident") return NO_FACTS;
        const local = scope.get(e.expr.name);
        const target = this.env.result.typeNodeTypes.get(e.type);
        if (!local || !target || isDynamic(target)) return NO_FACTS;
        const cur = this.currentType(local, scope);
        if (nonNull(cur).kind !== "union") {
          // `a is Dog` on an `Animal` (or a `*`, an `Object`, a `Dog?`): a `Dog` when true. Only towards
          // a narrower type: `a is IPet` on an `Animal` would lose `Animal`'s members (no intersections).
          const base = nonNull(cur);
          const open = isDynamic(base) || (base.kind === "builtin" && base.name === "Object");
          const narrower = open || (assignable(target, base) && !sameType(target, base));
          // `x is Box` on a `Box<Int>`-like type would lose the type arguments: only from untyped values.
          const generic = target.kind === "class" && target.info.typeParams.length > 0 && !open;
          if (!narrower || generic || (!open && sameType(target, cur))) return NO_FACTS;
          return { whenTrue: [{ local, type: target }], whenFalse: [] };
        }
        // `x is String` on an `int | String`: `String` when true, `int` (and `null`) when false.
        const members = membersOf(cur);
        const yes = members.flatMap((m) => (assignable(m, target) ? [m] : assignable(target, m) ? [target] : []));
        const no = members.filter((m) => !assignable(m, target));
        const otherwise = no.length > 0 ? unionOf(no) : undefined;
        return {
          whenTrue: yes.length > 0 ? [{ local, type: unionOf(yes) }] : [],
          whenFalse: otherwise ? [{ local, type: cur.kind === "nullable" ? nullableOf(otherwise) : otherwise }] : [],
        };
      }
      case "Binary": {
        if (["==", "!=", "===", "!=="].includes(e.op)) {
          const negated = e.op.startsWith("!");
          const optionalReceiver = (side: A.Expr): A.Expr & { kind: "Ident" } | undefined =>
            side.kind === "Member" && side.optional && side.object.kind === "Ident" ? side.object : undefined;
          const receiver = optionalReceiver(e.left) ?? optionalReceiver(e.right);
          const compared = receiver === (e.left.kind === "Member" ? e.left.object : undefined) ? e.right : e.left;
          const comparedType = this.env.result.exprTypes.get(compared);
          if (receiver && comparedType && !isNullable(comparedType) && !isDynamic(comparedType)) {
            const local = scope.get(receiver.name);
            const cur = local && this.currentType(local, scope);
            if (local && cur?.kind === "nullable") {
              const fact = { local, type: nonNull(cur) };
              return negated ? { whenTrue: [], whenFalse: [fact] } : { whenTrue: [fact], whenFalse: [] };
            }
          }
          const side = e.right.kind === "Null" ? e.left : e.left.kind === "Null" ? e.right : undefined;
          const local = side?.kind === "Ident" ? scope.get(side.name) : undefined;
          if (local) {
            const cur = this.currentType(local, scope);
            if (cur.kind !== "nullable") return NO_FACTS;
            const fact = { local, type: nonNull(cur) };
            return negated ? { whenTrue: [fact], whenFalse: [] } : { whenTrue: [], whenFalse: [fact] };
          }
          // `mode == 'utf8'` on a `'utf8' | 'ascii'`: `'utf8'` when true, `'ascii'` when false.
          const [ident, other] = e.left.kind === "Ident" ? [e.left, e.right] : e.right.kind === "Ident" ? [e.right, e.left] : [];
          const lit = ident && scope.get(ident.name);
          if (!lit || !other) return NO_FACTS;
          const cur = this.currentType(lit, scope);
          const c = this.constValue(other);
          if (!c.ok || nonNull(cur).kind !== "union" || !(typeof c.value === "string" || typeof c.value === "number" || typeof c.value === "boolean")) return NO_FACTS;
          const members = membersOf(cur);
          const equal = members.filter((m) => literalOf(m) === c.value);
          if (equal.length === 0) return NO_FACTS;
          const rest = members.filter((m) => !equal.includes(m));
          const isIt: Fact = { local: lit, type: equal[0]! };
          const isNot: Fact[] = rest.length > 0 ? [{ local: lit, type: cur.kind === "nullable" ? nullableOf(unionOf(rest)) : unionOf(rest) }] : [];
          return negated ? { whenTrue: isNot, whenFalse: [isIt] } : { whenTrue: [isIt], whenFalse: isNot };
        }
        if (e.op === "&&") {
          const l = this.facts(e.left, scope);
          return { whenTrue: [...l.whenTrue, ...this.facts(e.right, scope.withFacts(l.whenTrue)).whenTrue], whenFalse: [] };
        }
        if (e.op === "||") {
          const l = this.facts(e.left, scope);
          return { whenTrue: [], whenFalse: [...l.whenFalse, ...this.facts(e.right, scope.withFacts(l.whenFalse)).whenFalse] };
        }
        return NO_FACTS;
      }
      case "Unary": {
        if (e.op !== "!") return NO_FACTS;
        const inner = this.facts(e.arg, scope);
        return { whenTrue: inner.whenFalse, whenFalse: inner.whenTrue };
      }
      default:
        return NO_FACTS;
    }
  }

  /** Before a loop: locals assigned anywhere in it lose their narrowing (a later iteration may see the new value). */
  private unnarrowAssignedIn(node: object, scope: Scope) {
    for (const name of assignedNames(node)) {
      const local = scope.get(name);
      if (local) scope.unnarrow(local);
    }
  }

  /** Where the type of an assignment target was declared (for secondary labels). */
  private declOrigin(target: A.Expr, scope: Scope): { span: Span; label: string } | undefined {
    let m: MemberSig | undefined;
    let name = "";
    if (target.kind === "Ident") {
      const local = scope.get(target.name);
      if (local) return local.typeSpan && { span: local.typeSpan, label: "declared type" };
      m = findMember(this.info, target.name);
      name = target.name;
    } else if (target.kind === "Member") {
      const objType = this.env.result.exprTypes.get(target.object);
      if (objType?.kind === "class" || objType?.kind === "classRef") m = findMember(objType.info, target.name.name);
      name = target.name.name;
    }
    return m?.typeSpan && { span: m.typeSpan, label: `\`${name}\` declared as \`${typeToString(m.type)}\` here` };
  }

  private conditional(e: A.Expr & { kind: "Conditional" }, scope: Scope): Type {
    this.condition(e.cond, scope);
    const f = this.facts(e.cond, scope);
    const a = this.valueExpr(e.then, scope.withFacts(f.whenTrue));
    const b = this.valueExpr(e.else, scope.withFacts(f.whenFalse));
    if (isDynamic(a) || isDynamic(b)) return T.any;
    if (sameType(a, b)) return a;
    // `ok ? s : null`: a `String?` (with null safety; without it `String` already holds `null`).
    if (a.kind === "null" || b.kind === "null") return nullableOf(a.kind === "null" ? b : a);
    if (assignable(a, b)) return b;
    if (assignable(b, a)) return a;
    this.diags.error("X0318", "the branches of `?:` have incompatible types", e.span)
      .secondary(e.then.span, `\`${typeToString(a)}\``)
      .secondary(e.else.span, `\`${typeToString(b)}\``);
    return T.error;
  }

  /** `Direction.Up` as a case label: the member name, if `e` names a member of this enum. */
  private enumMemberName(e: A.Expr, info: ClassInfo): string | undefined {
    if (e.kind !== "Member") return undefined;
    const obj = this.env.result.exprTypes.get(e.object);
    return obj?.kind === "classRef" && obj.info === info && info.enumValues?.has(e.name.name) ? e.name.name : undefined;
  }

  /** Identity of a constant `case` label, for duplicate detection. */
  private literalKey(e: A.Expr): string | undefined {
    if (e.kind === "Member") {
      const obj = this.env.result.exprTypes.get(e.object);
      if (obj?.kind === "classRef" && obj.info.decl.isEnum) return `enum:${obj.info.qname}.${e.name.name}`;
    }
    const f = this.constValue(e);
    return f.ok ? `${typeof f.value}:${String(f.value)}` : undefined;
  }

  private undefinedWarning(at: Span, comparison: boolean) {
    this.diags.warning("X0840", "`undefined` is only supported for JavaScript compatibility", at, "use `null` instead")
      .help(comparison ? "compare with `null`: `x == null` matches both null and undefined" : "use `null`", [{ span: at, text: "null" }]);
  }
}

/** Why a class or shape doesn't fit a shape (for notes). */
function shapeMismatch(actual: Type, expected: ShapeType): string[] {
  const notes: string[] = [];
  for (const m of expected.members.values()) {
    let have: Type | undefined;
    if (actual.kind === "shape") have = actual.members.get(m.name)?.type();
    else if (actual.kind === "class") {
      const cm = findMember(actual.info, m.name);
      if (cm && !cm.isStatic && visibilityOf(cm.decl) === "public") have = cm.type;
    }
    if (!have) {
      if (!m.optional) notes.push(`\`${typeToString(actual)}\` has no public member \`${m.name}\``);
    } else if (!assignable(have, m.type())) {
      notes.push(`\`${m.name}\` is \`${typeToString(have)}\`, but \`${typeToString(m.type())}\` is required`);
    }
  }
  return notes.slice(0, 5);
}

/** `404 is Status`, `'low' as Level`: raw numbers/strings can be tested against enums. */
function enumFromRaw(from: Type, target: Type): boolean {
  return target.kind === "class" && !!target.info.decl.isEnum && (isNumeric(from) || isPrim(from, "String"));
}

/** A subclass of any non-final class may implement an interface, so such tests can't be ruled out. */
function involvesInterface(a: Type, b: Type): boolean {
  const iface = (t: Type) => t.kind === "class" && !!t.info.decl.isInterface;
  const openClass = (t: Type) => t.kind === "class" && !t.info.decl.modifiers.final;
  return (iface(a) && (openClass(b) || iface(b))) || (iface(b) && openClass(a));
}

/** The runtime test for a Xenon type, or undefined if it can't be tested. */
/** How `is` names a type: without type arguments, which are erased (`Array` for `Array<int>`). */
function testable(t: Type): string {
  if (t.kind === "builtin") return t.name;
  if (t.kind === "class") return t.info.decl.name.name;
  return typeToString(t);
}

function runtimeCheck(t: Type): RuntimeCheck | undefined {
  switch (t.kind) {
    case "class":
      if (t.info.decl.isEnum) return { kind: "enum", info: t.info };
      if (t.info.qname === "xenon.Iterable") return { kind: "iterable" };
      return t.info.decl.isInterface ? { kind: "interface", info: t.info } : { kind: "class", info: t.info };
    case "prim":
      switch (t.name) {
        case "String": return { kind: "typeof", tag: "string" };
        case "Float": return { kind: "typeof", tag: "number" };
        case "Bool": return { kind: "typeof", tag: "boolean" };
        case "Int": return { kind: "int" };
        case "UInt": return { kind: "uint" };
      }
      return undefined;
    case "builtin":
      switch (t.name) {
        // `x is Array` (any array); `is Array<int>` can't be checked: elements aren't typed at runtime.
        case "Array": return isDynamic(t.args[0] ?? T.any) ? { kind: "array" } : undefined;
        case "Object": return { kind: "object" };
        case "Function": case "Class": return { kind: "typeof", tag: "function" };
      }
      return undefined;
    default:
      return undefined;
  }
}

function isInline(m: MemberSig): boolean {
  return m.kind === "field" && !!m.decl.modifiers.inline && m.isStatic && m.readonly !== undefined;
}

/** Can values of these two types ever be equal under strict `==`? */
/** A neutral default for `x ?? …` hints: `0` for numbers, `false` for `Boolean`. */
function defaultFor(t: Type): string | undefined {
  if (isNumeric(t)) return "0";
  if (isPrim(t, "Bool")) return "false";
  return undefined;
}

/**
 * Fix-it appending ` ?? fallback`. `??` binds loosely, so an operand of another operator or of `.`
 * (`operand`) needs parentheses: `(a.get(k) ?? 0) + 1`; a whole value only if it isn't simple.
 */
function nullishFix(e: A.Expr, fallback: string, operand = false): Edit[] {
  const simple = !operand && (e.kind === "Ident" || e.kind === "Member" || e.kind === "Call" || e.kind === "Index");
  const at = (n: number) => span(e.span.file, n, n);
  return simple
    ? [{ span: at(e.span.end), text: ` ?? ${fallback}` }]
    : [{ span: at(e.span.start), text: "(" }, { span: at(e.span.end), text: ` ?? ${fallback})` }];
}

function comparable(a: Type, b: Type): boolean {
  if (isDynamic(a) || isDynamic(b)) return true;
  if (a.kind === "builtin" && a.name === "Object") return true;
  if (b.kind === "builtin" && b.name === "Object") return true;
  if (a.kind === "null") return isNullable(b);
  if (b.kind === "null") return isNullable(a);
  if (isNumeric(a) && isNumeric(b)) return true;
  return assignable(a, b) || assignable(b, a);
}

/** Source text of a member access's object for a `(x as *)` hint, when it is short enough to quote. */
function dynamicReceiver(e: A.Expr): string {
  const text = spanText(e.span);
  return text.length <= 24 && !text.includes("\n") ? text : "x";
}

/** A method's signature as written, without modifiers or body: `(a:int, b:String = ''):Boolean`. */
function signatureText(m: A.Method): string {
  const params = m.params.map((p) => spanText(p.span)).join(", ");
  return `(${params})${m.returnType && !m.isConstructor ? `:${spanText(m.returnType.span)}` : ""}`;
}

/** The first static member of a class, for a hint. */
function staticExample(info: ClassInfo): string {
  const m = info.decl.members.find((x): x is A.Method | A.Field => (x.kind === "Method" || x.kind === "Field") && !!x.modifiers.static);
  return m ? (m.kind === "Method" && !m.accessor ? `${m.name.name}(…)` : m.name.name) : "…";
}
