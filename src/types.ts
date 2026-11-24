import type { ClassInfo, TypedefInfo } from "./checker.ts";
import type { Span } from "./source.ts";

/** The primitive types, by their canonical names (`int`, `uint` and `Boolean` are prelude typedefs of them). */
export type PrimName = "Int" | "UInt" | "Float" | "String" | "Bool";

/** Built-in reference types that are not (yet) modelled member by member. */
export type BuiltinName = "Object" | "Array" | "Function" | "Class" | "Tuple" | "Record";

/** A type parameter (`T` in `class Box<T>` or `function map<U>()`), compared by identity. */
export interface TypeParamInfo {
  name: string;
  variance: "invariant" | "in" | "out";
  span?: Span;
  /** Upper bound declared as `T extends Base`. */
  constraint?: Type;
  constraintSpan?: Span;
  /** A class's `<T = EventTarget>`: the argument when a use leaves it out (set after the classes are known). */
  default?: Type;
}

function argumentFits(actual: Type, expected: Type, variance: TypeParamInfo["variance"]): boolean {
  if (sameType(actual, expected) || isDynamic(actual) || isDynamic(expected)) return true;
  if (variance === "out") return assignable(actual, expected);
  if (variance === "in") return assignable(expected, actual);
  return sameArg(actual, expected);
}

export interface MethodType {
  kind: "method";
  params: { name: string; type: Type; optional: boolean; rest: boolean }[];
  ret: Type;
  /** Type parameters of a generic method/function, inferred at each call. */
  typeParams?: TypeParamInfo[];
  /** Typedef name, for messages (`Reducer` instead of `(acc:int, value:int) -> int`). */
  alias?: string;
  /** Type arguments of a generic typedef (`Callback<int>`); substituted along with the type. */
  aliasArgs?: Type[];
  /** The typedef behind `alias`. */
  typedef?: TypedefInfo;
}

/** A member of a structural shape `{ x:Float, ?label:String, final id:int }`. */
export interface ShapeMember {
  name: string;
  optional: boolean;
  readonly: boolean;
  /** Resolved on demand, so shapes can refer to themselves through members. */
  type: () => Type;
}

export interface ShapeType {
  kind: "shape";
  members: Map<string, ShapeMember>;
  alias?: string;
  aliasArgs?: Type[];
  typedef?: TypedefInfo;
}

export interface UnionType {
  kind: "union";
  types: Type[];
  alias?: string;
  aliasArgs?: Type[];
}

export type Type =
  /** `literal`: a literal type, the one value of its base type (`true`, `'buffer'`, `1`, `0.5`). */
  | { kind: "prim"; name: PrimName; literal?: LiteralValue }
  | { kind: "void" }
  | { kind: "null" }
  | { kind: "any" } // `*`
  | { kind: "builtin"; name: BuiltinName; args: Type[] }
  | { kind: "class"; info: ClassInfo; args?: Type[] } // instance of a Xenon class (`args` for generic classes)
  | { kind: "typeParam"; param: TypeParamInfo }
  | { kind: "classRef"; info: ClassInfo } // the class itself (`Dog` in `Dog.create()`)
  | MethodType
  | ShapeType
  /** `int?` / `Null<int>`: a value type or type parameter that may also be `null`. Build with `nullableOf`. */
  | { kind: "nullable"; inner: Type }
  /**
   * `int | String`: a value of one of these types. Build with `unionOf`: at least two members,
   * none a union, `*`, `null` or nullable (`int | null` is `int?`, `int | Boolean | null` the
   * nullable union), none fitting another (`'a' | String` is `String`). `alias`: a typedef's name.
   */
  | UnionType
  | { kind: "error" }; // result of an expression that already produced an error

export const T = {
  int: { kind: "prim", name: "Int" } as Type,
  uint: { kind: "prim", name: "UInt" } as Type,
  Float: { kind: "prim", name: "Float" } as Type,
  String: { kind: "prim", name: "String" } as Type,
  Boolean: { kind: "prim", name: "Bool" } as Type,
  void: { kind: "void" } as Type,
  null: { kind: "null" } as Type,
  any: { kind: "any" } as Type,
  error: { kind: "error" } as Type,
  Object: { kind: "builtin", name: "Object", args: [] } as Type,
  /** The untyped array `Array` = `Array<*>`. */
  Array: { kind: "builtin", name: "Array", args: [{ kind: "any" }] } as Type,
  Function: { kind: "builtin", name: "Function", args: [] } as Type,
};

/** Names the compiler itself knows in type positions. (`Int`, `Bool`, `Void` & co. are prelude typedefs.) */
export const BUILTIN_TYPES: Record<string, Type> = {
  Int: T.int,
  UInt: T.uint,
  Float: T.Float,
  String: T.String,
  Bool: T.Boolean,
  Void: T.void,
  Object: T.Object,
  Array: T.Array,
  Function: T.Function,
  Class: { kind: "builtin", name: "Class", args: [] },
};

/** `Array<T>`: the typed array (one element type). A bare `Array` is `Array<*>`. */
export function arrayOf(element: Type): Type {
  return { kind: "builtin", name: "Array", args: [element] };
}

/**
 * `Tuple<A, B, …>`: an array with exactly these element types, one per position (`Object.entries`
 * gives `Array<Tuple<String, *>>`). At runtime a plain array.
 */
export function tupleOf(elements: Type[]): Type {
  return { kind: "builtin", name: "Tuple", args: elements };
}

/**
 * `Record<String, V>`: a plain object used as a dictionary (`element.dataset`). Reading a key gives
 * `V?` (it may be missing), writing one takes a `V`. (`Record<'a' | 'b', V>` is a shape instead.)
 */
export function recordOf(value: Type): Type {
  return { kind: "builtin", name: "Record", args: [T.String, value] };
}

/** The value type of a `Record<String, V>`, or undefined for other types. */
export function recordValue(t: Type): Type | undefined {
  return t.kind === "builtin" && t.name === "Record" ? t.args[1] ?? T.any : undefined;
}

/** The element types of a `Tuple<…>`, or undefined for other types. */
export function tupleElements(t: Type): Type[] | undefined {
  return t.kind === "builtin" && t.name === "Tuple" ? t.args : undefined;
}

/**
 * The element type of an `Array<T>` (`*` for a bare `Array`), or undefined for other types. A
 * tuple's elements as one type: the union of its element types (what `for … of` and its array
 * methods see; positions are typed one by one through indexes and destructuring).
 */
export function elementOf(t: Type): Type | undefined {
  if (t.kind === "builtin" && t.name === "Tuple") return unionOf(t.args.map(widen));
  return t.kind === "builtin" && t.name === "Array" ? t.args[0] ?? T.any : undefined;
}

export function isNumeric(t: Type): boolean {
  return t.kind === "prim" && (t.name === "Int" || t.name === "UInt" || t.name === "Float");
}

/** The value of a literal type. */
export type LiteralValue = boolean | string | number;

/**
 * A literal type: `true`, `false`, a string (`'buffer'`) or a number. A number's base type is
 * `int` for an integer in its range (`1`, `-1`), `uint` above it, else `Float` (`0.5`, or `1.0`:
 * `float` when written with a fraction or exponent).
 */
export function literalType(value: LiteralValue, float = false): Type {
  if (typeof value === "boolean") return { kind: "prim", name: "Bool", literal: value };
  if (typeof value === "string") return { kind: "prim", name: "String", literal: value };
  return { kind: "prim", name: float || !Number.isInteger(value) ? "Float" : value >= -0x80000000 && value <= 0x7fffffff ? "Int" : value >= 0 && value <= 0xffffffff ? "UInt" : "Float", literal: value };
}

/** Does the number `v` fit the numeric type `name` (`int` range, `uint` sign)? */
function numberFits(v: number, name: PrimName): boolean {
  if (name === "Int") return Number.isInteger(v) && v >= -0x80000000 && v <= 0x7fffffff;
  if (name === "UInt") return Number.isInteger(v) && v >= 0 && v <= 0xffffffff;
  return name === "Float";
}

/** The value of a literal type (looking through `?`), if it is one. */
export function literalOf(t: Type): LiteralValue | undefined {
  const inner = nonNull(t);
  return inner.kind === "prim" ? inner.literal : undefined;
}

/** A literal type's base (`Boolean` for `true`); other types as they are. */
export function widen(t: Type): Type {
  if (t.kind === "prim" && t.literal !== undefined) return { kind: "prim", name: t.name };
  if (t.kind === "nullable") return nullableOf(widen(t.inner));
  if (t.kind === "union") return unionOf(t.types.map(widen)); // `1 | 2` is an `int`
  return t;
}

export function isPrim(t: Type, name: PrimName): boolean {
  return t.kind === "prim" && t.name === name;
}

/**
 * The union of these types, normalized: nested unions flattened, `*` swallows everything, `null`
 * (and nullable members) make the result nullable, members fitting another member are dropped
 * (`'utf8' | String` is `String`, `Dog | Animal` is `Animal`), one member left is just that type.
 */
export function unionOf(types: Type[]): Type {
  let nullable = false;
  const flat: Type[] = [];
  const add = (t: Type) => {
    if (t.kind === "union") t.types.forEach(add);
    else if (t.kind === "null") nullable = true;
    else if (t.kind === "nullable") {
      nullable = true;
      add(t.inner);
    } else flat.push(t);
  };
  types.forEach(add);
  if (flat.some((t) => t.kind === "any" || t.kind === "error")) return flat.find((t) => t.kind === "error") ?? T.any;
  // Keep a member unless another (kept or later) member takes all its values; equal members once.
  const kept: Type[] = [];
  flat.forEach((t, i) => {
    const covered = flat.some((u, j) => j !== i && assignable(t, u) && !(assignable(u, t) && j > i));
    if (!covered) kept.push(t);
  });
  if (kept.length === 0) return nullable ? T.null : T.any;
  // `true | false` is `Boolean`.
  const t = kept.findIndex((m) => m.kind === "prim" && m.literal === true);
  const f = kept.findIndex((m) => m.kind === "prim" && m.literal === false);
  if (t >= 0 && f >= 0) return unionOf([...kept.filter((_, i) => i !== t && i !== f), T.Boolean, ...(nullable ? [T.null] : [])]);
  const result: Type = kept.length === 1 ? kept[0]! : { kind: "union", types: kept };
  return nullable ? nullableOf(result) : result;
}

/** The members of a union (a type itself otherwise), `null` left out. */
export function membersOf(t: Type): Type[] {
  const inner = nonNull(t);
  return inner.kind === "union" ? inner.types : [inner];
}

/**
 * Does the constant `v` fit `t` by its value: numbers by range, literal types by equality, a union
 * when it fits a member. `plain`: strings and booleans also fit `String`/`Boolean` (otherwise only
 * where the static type already decides, so an enum's string value doesn't pass for a `String`).
 */
export function valueFits(v: unknown, t: Type, plain = false): boolean {
  if (t.kind === "nullable") return v === null || valueFits(v, t.inner, plain);
  if (t.kind === "union") return t.types.some((m) => valueFits(v, m, plain));
  if (t.kind !== "prim") return false;
  if (t.literal !== undefined) return v === t.literal;
  if (typeof v === "number") return isNumeric(t) && numberFits(v, t.name);
  return plain && ((typeof v === "string" && t.name === "String") || (typeof v === "boolean" && t.name === "Bool"));
}

/** `*` and error types switch checking off. */
export function isDynamic(t: Type): boolean {
  return t.kind === "any" || t.kind === "error";
}

/**
 * Null safety (the default; off with `"nullSafety": false`): object types (`String`, classes, shapes, arrays, functions,
 * `Object`) exclude `null` and `T?` adds it, as it does for `int`. Without it they include `null`,
 * as in ActionScript. Set by `compileProject` for the duration of a compile.
 */
export const nullSafety = { on: false };

/** Types whose values can be `null`. */
export function isNullable(t: Type): boolean {
  if (t.kind === "nullable" || t.kind === "null" || t.kind === "any" || t.kind === "error") return true;
  if (t.kind === "union") return t.types.some(isNullable);
  if (nullSafety.on) return false;
  if (t.kind === "prim") return t.name === "String";
  return t.kind !== "void";
}

/**
 * `T?`: wraps the types that can't hold `null` themselves (`int`, `uint`, `Float`, `Boolean`) and
 * type parameters (which may stand for one); other types already include `null` and stay as they are.
 */
export function nullableOf(t: Type): Type {
  if (nullSafety.on) {
    return t.kind === "nullable" || t.kind === "null" || t.kind === "any" || t.kind === "error" || t.kind === "void" || (t.kind === "union" && isNullable(t)) ? t : { kind: "nullable", inner: t };
  }
  if ((t.kind === "prim" && t.name !== "String") || t.kind === "typeParam" || (t.kind === "union" && !isNullable(t))) return { kind: "nullable", inner: t };
  return t;
}

/** The non-null part of a type: `int` for `int?`, the type itself otherwise. */
export function nonNull(t: Type): Type {
  return t.kind === "nullable" ? t.inner : t;
}

export function typeToString(t: Type): string {
  switch (t.kind) {
    case "prim": return t.literal === undefined ? t.name : typeof t.literal !== "string" ? literalNumberText(t) : `'${t.literal.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
    case "void": return "Void";
    case "null": return "null";
    case "any": return "*";
    case "error": return "{error}";
    case "builtin": return t.args.length && (t.name === "Tuple" || !t.args.every(isDynamic)) ? `${t.name}<${t.args.map(typeToString).join(", ")}>` : t.name;
    case "class": {
      const name = t.info.displayName ?? t.info.decl.name.name;
      return t.args?.length ? `${name}<${t.args.map(typeToString).join(", ")}>` : name;
    }
    case "typeParam": return t.param.name;
    // `int | Boolean | null`, as written (`(int | Boolean)?` isn't Xenon).
    case "nullable": return t.inner.kind === "union" && !t.inner.alias ? `${typeToString(t.inner)} | null` : `${typeToString(t.inner)}?`;
    case "union": return t.alias ? aliasText(t) : t.types.map((m) => (m.kind === "method" && !m.alias ? `(${typeToString(m)})` : typeToString(m))).join(" | ");
    case "classRef": return `Class<${t.info.displayName ?? t.info.decl.name.name}>`;
    case "method": {
      if (t.alias) return aliasText(t);
      const ps = t.params.map((p) => `${p.rest ? "..." : ""}${p.name ? p.name + ":" : ""}${typeToString(p.type)}${p.optional ? "?" : ""}`);
      return `(${ps.join(", ")}) -> ${typeToString(t.ret)}`;
    }
    case "shape": {
      if (t.alias) return aliasText(t);
      const ms = [...t.members.values()].map((m) => `${m.readonly ? "final " : ""}${m.optional ? "?" : ""}${m.name}:${typeToString(m.type())}`);
      return `{ ${ms.join(", ")} }`;
    }
  }
}

/** `true`, `1`, `-1`, `0.5`; a `Float` with an integer value keeps its fraction (`1.0`). */
function literalNumberText(t: { name: PrimName; literal?: LiteralValue }): string {
  const text = String(t.literal);
  return typeof t.literal === "number" && t.name === "Float" && Number.isInteger(t.literal) && !/e/i.test(text) ? `${text}.0` : text;
}

/** `Reducer`, or `Callback<int>` for a generic typedef. */
function aliasText(t: { alias?: string; aliasArgs?: Type[] }): string {
  return t.aliasArgs?.length ? `${t.alias}<${t.aliasArgs.map(typeToString).join(", ")}>` : t.alias!;
}

export function sameType(a: Type, b: Type): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "prim": return a.name === (b as typeof a).name && a.literal === (b as typeof a).literal;
    case "class": {
      const bb = b as typeof a;
      if (a.info !== bb.info) return false;
      const x = a.args ?? [];
      const y = bb.args ?? [];
      return x.length === y.length && x.every((t, i) => sameType(t, y[i]!));
    }
    case "classRef": return a.info === (b as typeof a).info;
    case "typeParam": return a.param === (b as typeof a).param;
    case "nullable": return sameType(a.inner, (b as typeof a).inner);
    case "builtin": {
      const bb = b as typeof a;
      return a.name === bb.name && a.args.length === bb.args.length && a.args.every((x, i) => sameType(x, bb.args[i]!));
    }
    case "method":
    case "shape":
    case "union":
      return a === b || (assignable(a, b) && assignable(b, a));
    default: return true;
  }
}

/** Walks the superclass chain (stops at JS parents and cycles). */
export function* superclasses(info: ClassInfo): Generator<ClassInfo> {
  const seen = new Set<ClassInfo>([info]);
  let cur = info.parent;
  while (cur && !seen.has(cur)) {
    yield cur;
    seen.add(cur);
    cur = cur.parent;
  }
}

/** Is `sub` the same as `sup`, a subclass of it, or (transitively) an implementation of interface `sup`? */
export function isSubclass(sub: ClassInfo, sup: ClassInfo): boolean {
  for (const t of supertypes(sub)) if (t === sup) return true;
  return false;
}

/** The class itself, its superclasses, and every interface they implement (breadth-first, no duplicates). */
export function* supertypes(info: ClassInfo): Generator<ClassInfo> {
  const seen = new Set<ClassInfo>();
  const queue = [info];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    yield cur;
    if (cur.parent) queue.push(cur.parent);
    queue.push(...cur.interfaces);
  }
}

/**
 * Set by the checker: the std class that gives a built-in type its members (`Array<int>` → class
 * `Array<int>`, `String` → class `String`), so such values fit the interfaces it implements (`Iterable<T>`).
 */
export const stdClassOf: { fn?: (t: Type) => Type | undefined } = {};

/** Pairs of structural types currently being compared (recursive shapes are assumed compatible). */
const comparing = new Map<Type, Set<Type>>();

/** Can a value of type `from` be stored where `to` is expected (without an explicit conversion)? */
export function assignable(from: Type, to: Type): boolean {
  if (from === to) return true;
  if (isDynamic(from) || isDynamic(to)) return true;
  // A union fits where each of its members fits; a value fits a union when it fits a member.
  if (from.kind === "union") return from.types.every((m) => assignable(m, to));
  if (from.kind === "nullable" && from.inner.kind === "union") return from.inner.types.every((m) => assignable(nullableOf(m), to));
  if (to.kind === "union") return from.kind === "null" ? isNullable(to) : to.types.some((m) => assignable(from, m));
  // `int?` takes `null`, `int` and `int?`; an `int?` fits only where `null` fits too.
  if (to.kind === "nullable") return from.kind === "null" || assignable(nonNull(from), to.inner);
  if (from.kind === "nullable") return isNullable(to) && to.kind !== "typeParam" && assignable(from.inner, to);
  // A type parameter fits its own identity, `Object`, and everything guaranteed by its upper bound.
  if (from.kind === "typeParam") {
    if ((to.kind === "typeParam" && to.param === from.param) || (to.kind === "builtin" && to.name === "Object")) return true;
    return !!from.param.constraint && constraintAssignable(from.param.constraint, to, new Set([from.param]));
  }
  if (to.kind === "typeParam") return from.kind === "null";
  if ((to.kind === "shape" || to.kind === "method") && from.kind !== "null") {
    const set = comparing.get(from) ?? new Set<Type>();
    if (set.has(to)) return true;
    set.add(to);
    comparing.set(from, set);
    try {
      return to.kind === "shape" ? fitsShape(from, to) : fitsFunction(from, to);
    } finally {
      set.delete(to);
      // Remove the entry too: kept, it would hold every compared type (and so every compile) forever.
      if (set.size === 0) comparing.delete(from);
    }
  }
  if (from.kind === "void" || to.kind === "void") return false;
  if (from.kind === "null") return isNullable(to);
  if (to.kind === "builtin" && to.name === "Object") return true; // everything (but void) is an Object
  if (to.kind === "prim") {
    if (from.kind !== "prim") return false;
    // A literal type takes only its value; a literal fits its base type (`true` is a `Boolean`).
    // Numbers compare by value: the `int` literal `1` fits the `Float` literal `1.0`.
    if (to.literal !== undefined) return from.literal === to.literal && (from.name === to.name || (isNumeric(from) && isNumeric(to)));
    // A number literal fits every numeric type its value fits: `1` is an `int`, a `uint` and a `Float`.
    if (typeof from.literal === "number" && isNumeric(to)) return numberFits(from.literal, to.name);
    if (from.name === to.name) return true;
    // Widening only: int/uint → Float. Everything else needs a cast.
    return to.name === "Float" && (from.name === "Int" || from.name === "UInt");
  }
  if (to.kind === "class" && to.info.decl.isInterface && (from.kind === "builtin" || from.kind === "prim")) {
    const c = stdClassOf.fn?.(from);
    return !!c && assignable(c, to);
  }
  if (to.kind === "class") {
    if (from.kind !== "class" || !isSubclass(from.info, to.info)) return false;
    if (!to.args?.length) return true;
    // Generic types are invariant: compare the arguments as seen from the target class.
    const seen = supertypeArgs(from.info, from.args ?? [], to.info);
    // `*` as a type argument is a wildcard on either side: `Box<int>` fits `Box<*>` and back.
    return !seen || seen.length === 0 || to.args.every((a, i) =>
      argumentFits(seen[i] ?? T.any, a, to.info.typeParams[i]?.variance ?? "invariant"));
  }
  if (to.kind === "builtin") {
    if (to.name === "Function") return from.kind === "method" || (from.kind === "builtin" && from.name === "Function");
    if (to.name === "Class") return classFits(from, to.args[0]);
    // A shape is a record when each of its members holds a `V` (`{ a:Int, b:Int }` fits `Record<String, Int>`).
    if (to.name === "Record" && from.kind === "shape") {
      const value = to.args[1] ?? T.any;
      return [...from.members.values()].every((m) => assignable(m.type(), value));
    }
    if (from.kind !== "builtin") return false;
    // A tuple is an array: it fits `Array<*>`, and `Array<T>` when every element is a `T`.
    if (to.name === "Array" && from.name === "Tuple") {
      const e = to.args[0] ?? T.any;
      return isDynamic(e) || from.args.every((a) => sameType(widen(a), e) || isDynamic(a));
    }
    if (from.name !== to.name) return false;
    // Tuples of the same length, position by position (with `*` as a wildcard, like type arguments).
    if (to.name === "Tuple" && from.args.length !== to.args.length) return false;
    // `*` element types are a wildcard: `Array<int>` fits `Array` (= `Array<*>`) and back.
    return to.args.every((a, i) => sameArg(a, from.args[i] ?? T.any));
  }
  if (to.kind === "classRef") return from.kind === "classRef" && isSubclass(from.info, to.info);
  return false;
}

function constraintAssignable(from: Type, to: Type, seen: Set<TypeParamInfo>): boolean {
  if (from.kind !== "typeParam") return assignable(from, to);
  if (to.kind === "typeParam" && from.param === to.param) return true;
  if (seen.has(from.param) || !from.param.constraint) return false;
  seen.add(from.param);
  return constraintAssignable(from.param.constraint, to, seen);
}

/**
 * Type arguments match: the same type, with `*` as a wildcard on either side, also nested
 * (`Iterable<Tuple<String, int>>` fits `Iterable<Tuple<*, int>>`).
 */
function sameArg(a: Type, b: Type): boolean {
  if (sameType(a, b) || isDynamic(a) || isDynamic(b)) return true;
  if (a.kind === "builtin" && b.kind === "builtin") return a.name === b.name && a.args.length === b.args.length && a.args.every((x, i) => sameArg(x, b.args[i]!));
  if (a.kind === "class" && b.kind === "class") return a.info === b.info && (a.args ?? []).length === (b.args ?? []).length && (a.args ?? []).every((x, i) => sameArg(x, b.args![i]!));
  if (a.kind === "nullable" && b.kind === "nullable") return sameArg(a.inner, b.inner);
  return false;
}

/** Public instance member types of a class, as seen structurally. */
function classMemberType(info: ClassInfo, args: Type[], name: string): { type: Type; readonly: boolean } | undefined {
  for (const t of supertypes(info)) {
    const m = t.members.get(name);
    if (!m) continue;
    if (m.isStatic || (m.decl.modifiers.visibility?.value ?? "internal") !== "public") return undefined;
    return { type: memberTypeIn(info, args, m.owner, m.type), readonly: m.readonly !== undefined };
  }
  return undefined;
}

/* ------------------------------ generics ------------------------------ */

/** Maps type parameters to arguments (missing arguments, e.g. raw types, become `*`). */
export function bind(params: TypeParamInfo[], args: Type[]): Map<TypeParamInfo, Type> {
  return new Map(params.map((p, i) => [p, args[i] ?? T.any]));
}

/** Replaces type parameters inside a type. */
export function subst(t: Type, map: Map<TypeParamInfo, Type>): Type {
  if (map.size === 0) return t;
  switch (t.kind) {
    case "typeParam": return map.get(t.param) ?? t;
    case "nullable": return nullableOf(subst(t.inner, map)); // `V?` with `V = Dog` is just `Dog`
    case "union": {
      const u = unionOf(t.types.map((m) => subst(m, map)));
      return u.kind === "union" && t.alias ? { ...u, alias: t.alias, aliasArgs: t.aliasArgs?.map((a) => subst(a, map)) } : u;
    }
    case "class": return t.args?.length ? { ...t, args: t.args.map((a) => subst(a, map)) } : t;
    case "builtin": return t.args.length ? { ...t, args: t.args.map((a) => subst(a, map)) } : t;
    case "method": {
      const remaining = t.typeParams?.filter((p) => !map.has(p));
      const renamed = remaining?.map((p) => ({
        ...p,
        ...(p.constraint ? { constraint: subst(p.constraint, map) } : {}),
      }));
      const effective = renamed?.length
        ? new Map<TypeParamInfo, Type>([
            ...map,
            ...remaining!.map((p, i) => [p, { kind: "typeParam", param: renamed[i]! } as Type] as const),
          ])
        : map;
      return {
        ...t,
        params: t.params.map((p) => ({ ...p, type: subst(p.type, effective) })),
        ret: subst(t.ret, effective),
        ...(renamed?.length ? { typeParams: renamed } : t.typeParams?.length ? { typeParams: [] } : {}),
        ...(t.aliasArgs ? { aliasArgs: t.aliasArgs.map((a) => subst(a, map)) } : {}),
      };
    }
    case "shape": {
      const members = new Map<string, ShapeMember>();
      for (const [k, m] of t.members) {
        let cached: Type | undefined;
        members.set(k, { ...m, type: () => (cached ??= subst(m.type(), map)) });
      }
      return { ...t, members, ...(t.aliasArgs ? { aliasArgs: t.aliasArgs.map((a) => subst(a, map)) } : {}) };
    }
    default: return t;
  }
}

/** Replaces the given type parameters with `*` (for contexts where they are not known yet). */
export function eraseParams(t: Type, params: Iterable<TypeParamInfo>): Type {
  return subst(t, new Map([...params].map((p) => [p, T.any])));
}

/**
 * The type arguments `target` (a superclass or interface of `info`) receives when `info` has the
 * arguments `args`: `IntBox extends Box<int>` → `Box` sees `[int]`. Undefined if unrelated.
 */
export function supertypeArgs(info: ClassInfo, args: Type[], target: ClassInfo): Type[] | undefined {
  const seen = new Set<ClassInfo>();
  const queue: [ClassInfo, Type[]][] = [[info, args]];
  while (queue.length > 0) {
    const [cur, curArgs] = queue.shift()!;
    if (cur === target) return curArgs;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const map = bind(cur.typeParams, curArgs);
    if (cur.parent) queue.push([cur.parent, cur.parentArgs.map((a) => subst(a, map))]);
    cur.interfaces.forEach((i, n) => queue.push([i, (cur.interfaceArgs[n] ?? []).map((a) => subst(a, map))]));
  }
  return undefined;
}

/** A member's type as seen through an object of class `info<args>` (owner's parameters substituted). */
export function memberTypeIn(info: ClassInfo, args: Type[], owner: ClassInfo, type: Type): Type {
  if (owner.typeParams.length === 0) return type;
  return subst(type, bind(owner.typeParams, supertypeArgs(info, args, owner) ?? []));
}

/**
 * The class a class value holds: `Dog` for the value `Dog` (a `classRef`), `T` for a `Class<T>`
 * (`*` for a bare `Class`). Enums and interfaces aren't classes at run time: undefined.
 */
export function classValueOf(t: Type): Type | undefined {
  if (t.kind === "classRef") {
    if (t.info.decl.isEnum || t.info.decl.isInterface) return undefined;
    return { kind: "class", info: t.info, ...(t.info.typeParams.length ? { args: t.info.typeParams.map(() => T.any) } : {}) };
  }
  if (t.kind === "builtin" && t.name === "Class") return t.args[0] ?? T.any;
  return undefined;
}

/** Does a class value fit `Class<want>`? Covariant: `Class<Dog>` fits `Class<Animal>` (it is only read). */
function classFits(from: Type, want: Type | undefined): boolean {
  const got = classValueOf(from);
  if (!got) return false;
  if (!want || isDynamic(want) || isDynamic(got)) return true;
  if (want.kind === "typeParam" || got.kind === "typeParam") return got.kind === "typeParam" && want.kind === "typeParam" && got.param === want.param;
  if (want.kind === "class" && got.kind === "class") return isSubclass(got.info, want.info);
  return false;
}

/**
 * Infers type parameters (`vars`) by matching a pattern type against an actual type, recording
 * the first binding found for each parameter in `out`.
 */
export function unify(pattern: Type, actual: Type, vars: Set<TypeParamInfo>, out: Map<TypeParamInfo, Type>) {
  // An untyped value (`*`) says nothing more: the type parameters it would decide are `*` too
  // (`dyn.flatMap(e => e.split(','))` is an `Array<*>`), unless something decided them already.
  if (actual.kind === "any") {
    for (const p of paramsIn(pattern)) if (vars.has(p) && !out.has(p)) out.set(p, actual);
    return;
  }
  switch (pattern.kind) {
    case "typeParam":
      if (vars.has(pattern.param) && !out.has(pattern.param) && actual.kind !== "null" && actual.kind !== "error") {
        out.set(pattern.param, actual);
      }
      return;
    case "nullable":
      unify(pattern.inner, nonNull(actual), vars, out);
      return;
    case "union": {
      // `T | null`-like patterns: the one member with type parameters takes what the others don't.
      const open = pattern.types.filter((m) => mentions(m, vars));
      const rest = membersOf(actual).filter((a) => !pattern.types.some((m) => !mentions(m, vars) && assignable(a, m)));
      if (open.length === 1 && rest.length > 0) unify(open[0]!, unionOf(rest), vars, out);
      return;
    }
    case "class": {
      const cls = actual.kind === "class" ? actual : stdClassOf.fn?.(actual); // `Iterable<T>` from an `Array<int>`
      if (cls?.kind !== "class" || !pattern.args?.length) return;
      const seen = supertypeArgs(cls.info, cls.args ?? [], pattern.info);
      if (seen) pattern.args.forEach((p, i) => seen[i] && unify(p, seen[i]!, vars, out));
      return;
    }
    case "builtin":
      // `Class<T>` from a class value: `first(Route)` makes `T` a `Route`.
      if (pattern.name === "Class" && pattern.args[0]) {
        const held = classValueOf(actual);
        if (held && !(actual.kind === "builtin" && actual.args.length === 0)) unify(pattern.args[0], held, vars, out);
        return;
      }
      if (actual.kind === "builtin" && actual.name === pattern.name) pattern.args.forEach((p, i) => actual.args[i] && unify(p, actual.args[i]!, vars, out));
      // `Array<T>` from a tuple: `T` is the union of its elements.
      else if (pattern.name === "Array" && pattern.args[0] && tupleElements(actual)) unify(pattern.args[0], elementOf(actual)!, vars, out);
      // `Record<String, V>` from a shape: `V` is the union of its members (`*` for a shape without
      // members, like a `.d.ts` type that only has an index signature: its values are unknown).
      else if (pattern.name === "Record" && pattern.args[1] && actual.kind === "shape") {
        const values = [...actual.members.values()].map((m) => widen(m.type()));
        unify(pattern.args[1], values.length > 0 ? unionOf(values) : T.any, vars, out);
      }
      return;
    case "method":
      if (actual.kind !== "method") return;
      pattern.params.forEach((p, i) => actual.params[i] && unify(p.type, actual.params[i]!.type, vars, out));
      unify(pattern.ret, actual.ret, vars, out);
      return;
    case "shape":
      if (actual.kind !== "shape") return;
      for (const [k, m] of pattern.members) {
        const a = actual.members.get(k);
        if (a) unify(m.type(), a.type(), vars, out);
      }
      return;
  }
}

/** Does the type mention any of these parameters? */
/** The type parameters a type mentions (`K` and `V` in `Map<K, Array<V>>`). */
export function paramsIn(t: Type, found: TypeParamInfo[] = []): TypeParamInfo[] {
  switch (t.kind) {
    case "typeParam": found.push(t.param); break;
    case "nullable": paramsIn(t.inner, found); break;
    case "union": t.types.forEach((m) => paramsIn(m, found)); break;
    case "class": t.args?.forEach((a) => paramsIn(a, found)); break;
    case "builtin": t.args.forEach((a) => paramsIn(a, found)); break;
    case "method": t.params.forEach((p) => paramsIn(p.type, found)); paramsIn(t.ret, found); break;
    case "shape": for (const m of t.members.values()) paramsIn(m.type(), found); break;
  }
  return found;
}

export function mentions(t: Type, params: Set<TypeParamInfo>): boolean {
  switch (t.kind) {
    case "typeParam": return params.has(t.param);
    case "nullable": return mentions(t.inner, params);
    case "union": return t.types.some((m) => mentions(m, params));
    case "class": return !!t.args?.some((a) => mentions(a, params));
    case "builtin": return t.args.some((a) => mentions(a, params));
    case "method": return t.params.some((p) => mentions(p.type, params)) || mentions(t.ret, params);
    default: return false;
  }
}

/** Structural check: every required member of the shape exists with a compatible type. */
function fitsShape(from: Type, to: ShapeType): boolean {
  if (from.kind !== "shape" && from.kind !== "class") return false;
  for (const m of to.members.values()) {
    const have = from.kind === "shape"
      ? (() => {
        const sm = from.members.get(m.name);
        return sm && !(sm.optional && !m.optional) ? { type: sm.type() } : undefined;
      })()
      : classMemberType(from.info, from.args ?? [], m.name);
    if (!have) {
      if (m.optional) continue;
      return false;
    }
    if (!assignable(have.type, m.type())) return false;
  }
  return true;
}

/**
 * How many arguments a call must pass: the parameters up to the last one that isn't optional, rest
 * or `void`. A trailing `void` parameter may be left out (as in TypeScript), so the `resolve` of a
 * `Promise<void>` is called as `resolve()`.
 */
export function requiredParams(params: readonly { optional?: boolean; rest?: boolean; type: Type }[]): number {
  let n = params.length;
  while (n > 0 && (params[n - 1]!.optional || params[n - 1]!.rest || params[n - 1]!.type.kind === "void")) n--;
  return n;
}

/** Function types: contravariant parameters, covariant return; fewer parameters are fine (as in JS). */
function fitsFunction(from: Type, to: MethodType): boolean {
  if (from.kind !== "method") return false;
  const required = requiredParams(from.params);
  if (required > to.params.length && !to.params.some((p) => p.rest)) return false;
  for (let i = 0; i < from.params.length; i++) {
    const mine = from.params[i]!;
    const theirs = to.params[i] ?? to.params.find((p) => p.rest);
    if (!theirs) break;
    // A parameter against a rest parameter receives one of its elements (`(chunk:String)` fits
    // `(...args:Array<*>)`); a rest parameter against a rest parameter, the array.
    const given = theirs.rest && !mine.rest ? (elementOf(theirs.type) ?? T.any) : theirs.type;
    if (!assignable(given, mine.type)) return false;
  }
  return to.ret.kind === "void" || assignable(from.ret, to.ret);
}

/** Type of a numeric literal: integers are `int` (or `uint` above the int range), others `Float`. */
export function numberLiteralType(raw: string, value: number): Type {
  const isFloatSyntax = !/^0[xXbBoO]/.test(raw) && /[.eE]/.test(raw);
  if (isFloatSyntax || !Number.isInteger(value)) return T.Float;
  if (value <= 0x7fffffff) return T.int;
  if (value <= 0xffffffff) return T.uint;
  return T.Float;
}

/** Result type of an arithmetic operator on two numeric types. */
export function arithmeticResult(a: Type, b: Type): Type {
  // Literal types compute as their base type: `1 + n` of a literal `1` and an `int` is an `int`.
  a = widen(a);
  b = widen(b);
  if (isPrim(a, "Float") || isPrim(b, "Float")) return T.Float;
  if (sameType(a, b)) return a;
  return T.Float; // int mixed with uint
}

