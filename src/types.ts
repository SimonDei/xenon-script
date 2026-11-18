import type { ClassInfo } from "./checker.ts";

export type PrimName = "int" | "uint" | "Float" | "String" | "Boolean";

/** Built-in reference types that are not (yet) modelled member by member. */
export type BuiltinName = "Object" | "Array" | "Function" | "RegExp" | "Class";

/** A type parameter (`T` in `class Box<T>` or `function map<U>()`), compared by identity. */
export interface TypeParamInfo {
  name: string;
}

export interface MethodType {
  kind: "method";
  params: { name: string; type: Type; optional: boolean; rest: boolean }[];
  ret: Type;
  /** Type parameters of a generic method/function, inferred at each call. */
  typeParams?: TypeParamInfo[];
  /** Typedef name, for messages (`Reducer` instead of `(acc:int, value:int) -> int`). */
  alias?: string;
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
}

export type Type =
  | { kind: "prim"; name: PrimName }
  | { kind: "void" }
  | { kind: "null" }
  | { kind: "any" } // `*`
  | { kind: "builtin"; name: BuiltinName; args: Type[] }
  | { kind: "class"; info: ClassInfo; args?: Type[] } // instance of a Klass class (`args` for generic classes)
  | { kind: "typeParam"; param: TypeParamInfo }
  | { kind: "classRef"; info: ClassInfo } // the class itself (`Dog` in `Dog.create()`)
  | MethodType
  | ShapeType
  | { kind: "error" }; // result of an expression that already produced an error

export const T = {
  int: { kind: "prim", name: "int" } as Type,
  uint: { kind: "prim", name: "uint" } as Type,
  Float: { kind: "prim", name: "Float" } as Type,
  String: { kind: "prim", name: "String" } as Type,
  Boolean: { kind: "prim", name: "Boolean" } as Type,
  void: { kind: "void" } as Type,
  null: { kind: "null" } as Type,
  any: { kind: "any" } as Type,
  error: { kind: "error" } as Type,
  Object: { kind: "builtin", name: "Object", args: [] } as Type,
  /** The untyped array `Array` = `Array<*>`. */
  Array: { kind: "builtin", name: "Array", args: [{ kind: "any" }] } as Type,
  Function: { kind: "builtin", name: "Function", args: [] } as Type,
  RegExp: { kind: "builtin", name: "RegExp", args: [] } as Type,
};

/** Names the compiler itself knows in type positions. (`Int`, `Bool`, `Void` & co. are prelude typedefs.) */
export const BUILTIN_TYPES: Record<string, Type> = {
  int: T.int,
  uint: T.uint,
  Float: T.Float,
  String: T.String,
  Boolean: T.Boolean,
  Object: T.Object,
  Array: T.Array,
  Function: T.Function,
  RegExp: T.RegExp,
  Class: { kind: "builtin", name: "Class", args: [] },
};

/** `Array<T>`: the typed array (one element type). A bare `Array` is `Array<*>`. */
export function arrayOf(element: Type): Type {
  return { kind: "builtin", name: "Array", args: [element] };
}

/** The element type of an `Array<T>` (`*` for a bare `Array`), or undefined for other types. */
export function elementOf(t: Type): Type | undefined {
  return t.kind === "builtin" && t.name === "Array" ? t.args[0] ?? T.any : undefined;
}

export function isNumeric(t: Type): boolean {
  return t.kind === "prim" && (t.name === "int" || t.name === "uint" || t.name === "Float");
}

export function isPrim(t: Type, name: PrimName): boolean {
  return t.kind === "prim" && t.name === name;
}

/** `*` and error types switch checking off. */
export function isDynamic(t: Type): boolean {
  return t.kind === "any" || t.kind === "error";
}

/** Types whose values can be `null`. */
export function isNullable(t: Type): boolean {
  if (t.kind === "prim") return t.name === "String";
  return t.kind !== "void";
}

export function typeToString(t: Type): string {
  switch (t.kind) {
    case "prim": return t.name;
    case "void": return "void";
    case "null": return "null";
    case "any": return "*";
    case "error": return "{error}";
    case "builtin": return t.args.length && !t.args.every(isDynamic) ? `${t.name}<${t.args.map(typeToString).join(", ")}>` : t.name;
    case "class": return t.args?.length ? `${t.info.decl.name.name}<${t.args.map(typeToString).join(", ")}>` : t.info.decl.name.name;
    case "typeParam": return t.param.name;
    case "classRef": return `Class<${t.info.decl.name.name}>`;
    case "method": {
      if (t.alias) return t.alias;
      const ps = t.params.map((p) => `${p.rest ? "..." : ""}${p.name ? p.name + ":" : ""}${typeToString(p.type)}${p.optional ? "?" : ""}`);
      return `(${ps.join(", ")}) -> ${typeToString(t.ret)}`;
    }
    case "shape": {
      if (t.alias) return t.alias;
      const ms = [...t.members.values()].map((m) => `${m.readonly ? "final " : ""}${m.optional ? "?" : ""}${m.name}:${typeToString(m.type())}`);
      return `{ ${ms.join(", ")} }`;
    }
  }
}

export function sameType(a: Type, b: Type): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "prim": return a.name === (b as typeof a).name;
    case "class": {
      const bb = b as typeof a;
      if (a.info !== bb.info) return false;
      const x = a.args ?? [];
      const y = bb.args ?? [];
      return x.length === y.length && x.every((t, i) => sameType(t, y[i]!));
    }
    case "classRef": return a.info === (b as typeof a).info;
    case "typeParam": return a.param === (b as typeof a).param;
    case "builtin": {
      const bb = b as typeof a;
      return a.name === bb.name && a.args.length === bb.args.length && a.args.every((x, i) => sameType(x, bb.args[i]!));
    }
    case "method":
    case "shape":
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

/** Pairs of structural types currently being compared (recursive shapes are assumed compatible). */
const comparing = new Map<Type, Set<Type>>();

/** Can a value of type `from` be stored where `to` is expected (without an explicit conversion)? */
export function assignable(from: Type, to: Type): boolean {
  if (from === to) return true;
  if (isDynamic(from) || isDynamic(to)) return true;
  // Type parameters are opaque: a `T` fits only `T` (and `Object`); only `T` and `null` fit a `T`.
  if (from.kind === "typeParam") return (to.kind === "typeParam" && to.param === from.param) || (to.kind === "builtin" && to.name === "Object");
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
    }
  }
  if (from.kind === "void" || to.kind === "void") return false;
  if (from.kind === "null") return isNullable(to);
  if (to.kind === "builtin" && to.name === "Object") return true; // everything (but void) is an Object
  if (to.kind === "prim") {
    if (from.kind !== "prim") return false;
    if (from.name === to.name) return true;
    // Widening only: int/uint → Float. Everything else needs a cast.
    return to.name === "Float" && (from.name === "int" || from.name === "uint");
  }
  if (to.kind === "class") {
    if (from.kind !== "class" || !isSubclass(from.info, to.info)) return false;
    if (!to.args?.length) return true;
    // Generic types are invariant: compare the arguments as seen from the target class.
    const seen = supertypeArgs(from.info, from.args ?? [], to.info);
    // `*` as a type argument is a wildcard on either side: `Box<int>` fits `Box<*>` and back.
    return !seen || seen.length === 0 || to.args.every((a, i) => sameType(a, seen[i] ?? T.any) || isDynamic(a) || isDynamic(seen[i] ?? T.any));
  }
  if (to.kind === "builtin") {
    if (to.name === "Function") return from.kind === "method" || (from.kind === "builtin" && from.name === "Function");
    if (to.name === "Class") return from.kind === "classRef" || (from.kind === "builtin" && from.name === "Class");
    if (from.kind !== "builtin" || from.name !== to.name) return false;
    // `*` element types are a wildcard: `Array<int>` fits `Array` (= `Array<*>`) and back.
    return to.args.every((a, i) => sameType(a, from.args[i] ?? T.any) || isDynamic(a) || isDynamic(from.args[i] ?? T.any));
  }
  if (to.kind === "classRef") return from.kind === "classRef" && isSubclass(from.info, to.info);
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
    case "class": return t.args?.length ? { ...t, args: t.args.map((a) => subst(a, map)) } : t;
    case "builtin": return t.args.length ? { ...t, args: t.args.map((a) => subst(a, map)) } : t;
    case "method":
      return {
        ...t,
        params: t.params.map((p) => ({ ...p, type: subst(p.type, map) })),
        ret: subst(t.ret, map),
      };
    case "shape": {
      const members = new Map<string, ShapeMember>();
      for (const [k, m] of t.members) {
        let cached: Type | undefined;
        members.set(k, { ...m, type: () => (cached ??= subst(m.type(), map)) });
      }
      return { ...t, members };
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
 * Infers type parameters (`vars`) by matching a pattern type against an actual type, recording
 * the first binding found for each parameter in `out`.
 */
export function unify(pattern: Type, actual: Type, vars: Set<TypeParamInfo>, out: Map<TypeParamInfo, Type>) {
  switch (pattern.kind) {
    case "typeParam":
      if (vars.has(pattern.param) && !out.has(pattern.param) && actual.kind !== "null" && actual.kind !== "error") {
        out.set(pattern.param, actual);
      }
      return;
    case "class": {
      if (actual.kind !== "class" || !pattern.args?.length) return;
      const seen = supertypeArgs(actual.info, actual.args ?? [], pattern.info);
      if (seen) pattern.args.forEach((p, i) => seen[i] && unify(p, seen[i]!, vars, out));
      return;
    }
    case "builtin":
      if (actual.kind === "builtin" && actual.name === pattern.name) pattern.args.forEach((p, i) => actual.args[i] && unify(p, actual.args[i]!, vars, out));
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
export function mentions(t: Type, params: Set<TypeParamInfo>): boolean {
  switch (t.kind) {
    case "typeParam": return params.has(t.param);
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

/** Function types: contravariant parameters, covariant return; fewer parameters are fine (as in JS). */
function fitsFunction(from: Type, to: MethodType): boolean {
  if (from.kind !== "method") return false;
  const required = from.params.filter((p) => !p.optional && !p.rest).length;
  if (required > to.params.length && !to.params.some((p) => p.rest)) return false;
  for (let i = 0; i < from.params.length; i++) {
    const mine = from.params[i]!;
    const theirs = to.params[i] ?? to.params.find((p) => p.rest);
    if (!theirs) break;
    if (!assignable(theirs.type, mine.type)) return false;
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
  if (isPrim(a, "Float") || isPrim(b, "Float")) return T.Float;
  if (sameType(a, b)) return a;
  return T.Float; // int mixed with uint
}

