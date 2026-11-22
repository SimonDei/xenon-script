import type * as A from "./ast.ts";
import type { Span } from "./source.ts";
import { isNullable, type Type } from "./types.ts";

/**
 * An object built at compile time by a `constexpr` constructor: its class and its (`final`/`const`)
 * fields. It only exists during evaluation; only primitive results reach the output.
 */
export class ConstObject {
  constructor(
    /** The class (a `ClassInfo`; typed loosely so this module doesn't depend on the checker). */
    readonly cls: object,
    readonly fields: Map<string, ConstValue>,
  ) {}
}

/** A value known at compile time. */
export type ConstValue = number | string | boolean | null | ConstObject | RegExp;

/** A value that can be pasted into the output. */
export const isPrimitive = (v: ConstValue): v is number | string | boolean | null => !(v instanceof ConstObject) && !(v instanceof RegExp);

export type Fold =
  | { ok: true; value: ConstValue }
  /**
   * `reported`: the cause was already reported (e.g. a broken dependency), don't report again.
   * `limit`: a `constexpr` evaluation went too deep or took too long (always worth reporting).
   */
  | { ok: false; at: Span; reason: string; reported?: boolean; cycle?: boolean; limit?: boolean };

/**
 * Resolves a name/member reference to a constant, or undefined if it isn't one. For a call, a
 * `new` or an operator on an object, `args` holds the arguments' values (the right operand for an
 * operator) and `self` the receiver, if any: `constexpr` code is evaluated with them. A member
 * with `self` is a getter on a constant (`'abc'.length`).
 */
export type ConstLookup = (e: A.Expr, args?: ConstValue[], self?: ConstValue) => Fold | undefined;

const CASTS: Record<string, (v: number | string | boolean | null) => ConstValue> = {
  int: (v) => (v as number) | 0,
  uint: (v) => (v as number) >>> 0,
  Float: (v) => Number(v),
  String: (v) => String(v),
  Boolean: (v) => Boolean(v),
};

const notConst = (e: A.Expr, reason = "not a compile-time constant"): Extract<Fold, { ok: false }> => ({ ok: false, at: e.span, reason });

/**
 * Evaluates a constant expression with exact JavaScript semantics (the type checker has already
 * made sure the operators are applied to sensible types). Xenon `==` is strict.
 */
export function fold(e: A.Expr, lookup: ConstLookup): Fold {
  switch (e.kind) {
    case "Number": return { ok: true, value: e.value };
    case "String": return { ok: true, value: e.value };
    case "Bool": return { ok: true, value: e.value };
    case "Null": return { ok: true, value: null };
    case "TypeCheck": return fold(e.expr, lookup);
    // A fresh object per evaluation (a regex keeps state between `exec` calls).
    case "Regex": return { ok: true, value: new RegExp(e.pattern, e.flags) };
    case "This":
      return lookup(e) ?? notConst(e, "`this` is not a compile-time constant here");
    case "Ident":
      return lookup(e) ?? notConst(e, `\`${e.name}\` is not an inline constant`);
    case "Member": {
      const found = lookup(e);
      if (found) return found;
      // A field of an object built at compile time (`v.x`), or a `constexpr` getter (`'abc'.length`).
      const o = fold(e.object, lookup);
      if (o.ok && o.value instanceof ConstObject && o.value.fields.has(e.name.name)) return { ok: true, value: o.value.fields.get(e.name.name)! };
      const got = o.ok && o.value !== null && !(o.value instanceof ConstObject) ? lookup(e, [], o.value) : undefined;
      if (got) return got;
      return notConst(e, `\`${e.name.name}\` is not an inline constant`);
    }
    case "Template": {
      let out = "";
      for (const p of e.parts) {
        if (p.kind === "text") out += p.value;
        else {
          const f = fold(p.expr, lookup);
          if (!f.ok) return f;
          if (!isPrimitive(f.value)) return notConst(p.expr, "an object's text is not known at compile time");
          out += String(f.value);
        }
      }
      return { ok: true, value: out };
    }
    case "Unary": {
      if (e.op === "typeof" || e.op === "delete") return notConst(e);
      const f = fold(e.arg, lookup);
      if (!f.ok) return f;
      if (!isPrimitive(f.value)) return notConst(e);
      const v = f.value as number;
      switch (e.op) {
        case "-": return { ok: true, value: -v };
        case "+": return { ok: true, value: +v };
        case "!": return { ok: true, value: !f.value };
        case "~": return { ok: true, value: ~v };
      }
      return notConst(e);
    }
    case "Binary": {
      const l = fold(e.left, lookup);
      if (!l.ok) return l;
      // Short-circuit operators only evaluate the right side when needed (it must still be constant).
      const r = fold(e.right, lookup);
      if (!r.ok) return r;
      // An operator on an object: its `constexpr` operator method (`==` without one compares identity).
      if (l.value instanceof ConstObject) {
        const viaMethod = lookup(e, [r.value], l.value);
        if (viaMethod) return viaMethod;
        if (["==", "===", "!=", "!=="].includes(e.op)) return { ok: true, value: (l.value === r.value) === !e.op.startsWith("!") };
        return notConst(e, `\`${e.op}\` on this object is not a \`constexpr\` operator`);
      }
      if (r.value instanceof ConstObject) return ["==", "===", "!=", "!=="].includes(e.op) ? { ok: true, value: e.op.startsWith("!") } : notConst(e);
      const value = binary(e.op, l.value, r.value);
      return value === undefined ? notConst(e) : { ok: true, value };
    }
    case "Conditional": {
      // Only the chosen branch is evaluated (a recursive `constexpr` function ends this way).
      const c = fold(e.cond, lookup);
      if (!c.ok) return c;
      return fold(c.value ? e.then : e.else, lookup);
    }
    case "Call": {
      if (e.callee.kind === "Ident" && e.callee.name in CASTS && e.args.length === 1 && e.args[0]!.kind !== "Spread") {
        const f = fold(e.args[0]!, lookup);
        if (!f.ok) return f;
        if (!isPrimitive(f.value)) return notConst(e, "an object can't be converted at compile time");
        return { ok: true, value: CASTS[e.callee.name]!(f.value) };
      }
      // A `constexpr` function or method (the standard library's too): the receiver and arguments first, then the call.
      let self: ConstValue | undefined;
      if (e.callee.kind === "Member") {
        const r = fold(e.callee.object, lookup);
        if (r.ok && r.value !== null) self = r.value;
      }
      const values = foldArgs(e.args, lookup);
      if (!Array.isArray(values)) return values;
      return lookup(e, values, self) ?? notConst(e, "only `constexpr` functions and conversions can be called at compile time");
    }
    case "New": {
      // An object of a class with a `constexpr` constructor.
      const values = foldArgs(e.args, lookup);
      if (!Array.isArray(values)) return values;
      return lookup(e, values) ?? notConst(e, "only a `constexpr` constructor builds an object at compile time");
    }
    case "Array":
    case "Object":
      return notConst(e, "array and object literals are not compile-time constants");
    default:
      return notConst(e);
  }
}

/** Longest string a standard-library call may build at compile time (`'-'.repeat(n)`). */
const MAX_STRING = 1_000_000;

/**
 * Runs a `constexpr` member of the standard library (a JavaScript built-in) at compile time:
 * `target[name](...args)`, or the getter `target[name]`. `undefined` is `null`; an exception, an
 * object result or a huge string is no constant.
 */
export function callNative(target: unknown, name: string, args: ConstValue[], getter: boolean, at: Span): Fold {
  const fail = (reason: string): Fold => ({ ok: false, at, reason });
  const counts = args.filter((a): a is number => typeof a === "number");
  if (typeof target === "string" && (name === "repeat" || name === "padStart" || name === "padEnd") && Math.max(0, ...counts) * Math.max(1, target.length) > MAX_STRING) {
    return fail(`the result of \`${name}\` is too long to compute at compile time`);
  }
  try {
    const member = (target as Record<string, unknown>)[name];
    const value = getter ? member : (member as (...a: unknown[]) => unknown).apply(target, args);
    if (value === undefined || value === null) return { ok: true, value: null };
    if (!["number", "string", "boolean"].includes(typeof value)) return fail(`\`${name}\` returns an object`);
    return { ok: true, value: value as number | string | boolean };
  } catch (err) {
    return fail(`\`${name}\` fails at compile time: ${(err as Error).message}`);
  }
}

function foldArgs(args: A.Expr[], lookup: ConstLookup): ConstValue[] | Fold {
  const values: ConstValue[] = [];
  for (const a of args) {
    if (a.kind === "Spread") return notConst(a);
    const f = fold(a, lookup);
    if (!f.ok) return f;
    values.push(f.value);
  }
  return values;
}

export function binary(op: string, a: ConstValue, b: ConstValue): ConstValue | undefined {
  // The operands are already type-checked; the casts only satisfy TypeScript.
  const x = a as number;
  const y = b as number;
  switch (op) {
    case "+": return (a as string) + (b as string);
    case "-": return x - y;
    case "*": return x * y;
    case "/": return x / y;
    case "%": return x % y;
    case "**": return x ** y;
    case "<<": return x << y;
    case ">>": return x >> y;
    case ">>>": return x >>> y;
    case "&": return x & y;
    case "|": return x | y;
    case "^": return x ^ y;
    case "&&": return a && b;
    case "||": return a || b;
    case "??": return a ?? b;
    case "==": case "===": return a === b;
    case "!=": case "!==": return a !== b;
    case "<": return x < y;
    case "<=": return x <= y;
    case ">": return x > y;
    case ">=": return x >= y;
  }
  return undefined;
}

/** Does a constant value fit a declared type (`int` range, `uint` sign, …)? */
export function fits(v: ConstValue, t: Type): boolean {
  if (v instanceof ConstObject) return false;
  switch (t.kind) {
    case "any":
    case "error":
      return true;
    case "prim":
      if (t.literal !== undefined) return v === t.literal;
      switch (t.name) {
        case "Int": return typeof v === "number" && Number.isInteger(v) && v >= -0x80000000 && v <= 0x7fffffff;
        case "UInt": return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 0xffffffff;
        case "Float": return typeof v === "number";
        case "Bool": return typeof v === "boolean";
        case "String": return typeof v === "string" || v === null;
      }
      return false;
    case "builtin":
      return t.name === "Object" ? true : v === null;
    case "nullable":
      return v === null || fits(v, t.inner);
    case "union":
      return t.types.some((m) => fits(v, m)) || (v === null && isNullable(t));
    default:
      return v === null && isNullable(t);
  }
}

/** JS source for a folded value. */
export function constToJs(v: ConstValue, quote: (s: string) => string): { code: string; negative: boolean } {
  if (v instanceof ConstObject || v instanceof RegExp) throw new Error("constToJs: an object can't be written as a constant");
  if (v === null) return { code: "null", negative: false };
  if (typeof v === "string") return { code: quote(v), negative: false };
  if (typeof v === "boolean") return { code: String(v), negative: false };
  if (Number.isNaN(v)) return { code: "NaN", negative: false };
  if (v === Infinity) return { code: "Infinity", negative: false };
  if (v === -Infinity) return { code: "-Infinity", negative: true };
  if (Object.is(v, -0)) return { code: "-0", negative: true };
  return { code: String(v), negative: v < 0 };
}

/* ------------------------- constexpr function bodies ------------------------- */

/** Steps left for one compile-time evaluation (statements and loop rounds), shared by nested calls. */
export interface Budget {
  steps: number;
}

class Returned {
  constructor(readonly value: ConstValue) {}
}
class Broke {}
class Continued {}
type Failure = Extract<Fold, { ok: false }>;
class Failed {
  constructor(readonly fold: Failure) {}
}

/** The value a local gets without an initializer, as at runtime: `0`, `NaN`, `false` or `null`. */
function defaultOf(type: A.TypeNode | undefined): ConstValue {
  const name = type?.kind === "TypeName" && type.name.length === 1 ? type.name[0]!.name : undefined;
  if (name === "int" || name === "uint" || name === "Int" || name === "UInt") return 0;
  if (name === "Float") return NaN;
  if (name === "Boolean" || name === "Bool") return false;
  return null;
}

/**
 * Runs a `constexpr` function's block body at compile time with its parameters bound, in exact
 * JavaScript semantics: locals, assignments (`=`, `+=`, `++`, …) to them, `if`, `while`,
 * `do … while`, `for`, range loops, `switch`, `return`, `break` and `continue`. The checker has
 * made sure nothing else occurs. Fails like `fold`, or with `limit` when the budget runs out.
 */
export function run(body: A.Block, params: Map<string, ConstValue>, lookup: ConstLookup, budget: Budget, at: Span, self?: ConstObject): Fold {
  const scopes: Map<string, ConstValue>[] = [params];
  const find = (name: string) => scopes.findLast((s) => s.has(name));
  const local: ConstLookup = (e, args, receiver) => {
    if (e.kind === "Ident") {
      const s = find(e.name);
      if (s) return { ok: true, value: s.get(e.name)! };
    }
    return lookup(e, args, receiver);
  };
  const value = (e: A.Expr): ConstValue => {
    const f = fold(e, local);
    if (!f.ok) throw new Failed(f);
    return f.value;
  };
  const tick = () => {
    if (--budget.steps < 0) throw new Failed({ ok: false, at, reason: "the evaluation takes more than 1000000 steps (an endless loop?)", limit: true });
  };
  /** Where a target lives: a local (`x`), or a field of the object being built (`this.x`, or `x` when no local has that name). */
  const home = (t: A.Expr): [Map<string, ConstValue>, string] | undefined => {
    if (t.kind === "Member" && t.object.kind === "This" && self) return [self.fields, t.name.name];
    if (t.kind !== "Ident") return undefined;
    const scope = find(t.name) ?? (self?.fields.has(t.name) ? self.fields : undefined);
    return scope && [scope, t.name];
  };
  /** An expression statement: an assignment or `++`/`--` on a local, or a value (discarded). */
  const effect = (e: A.Expr) => {
    const target = e.kind === "Assign" ? home(e.target) : e.kind === "Update" ? home(e.arg) : undefined;
    if (e.kind === "Assign" && target) {
      const [scope, name] = target;
      if (e.op === "=") return void scope.set(name, value(e.value));
      const old = scope.get(name)!;
      const op = e.op.slice(0, -1);
      if (op === "&&") return void scope.set(name, old ? value(e.value) : old);
      if (op === "||") return void scope.set(name, old ? old : value(e.value));
      if (op === "??") return void scope.set(name, old ?? value(e.value));
      const v = binary(op, old, value(e.value));
      if (v === undefined) throw new Failed(notConst(e));
      return void scope.set(name, v);
    }
    if (e.kind === "Update" && target) {
      const [scope, name] = target;
      const old = scope.get(name) as number;
      return void scope.set(name, e.op === "++" ? old + 1 : old - 1);
    }
    value(e);
  };
  const block = (stmts: A.Stmt[]) => {
    scopes.push(new Map());
    try {
      for (const s of stmts) exec(s);
    } finally {
      scopes.pop();
    }
  };
  /** A loop round: `false` once a `break` ends the loop. */
  const round = (body: A.Stmt): boolean => {
    tick();
    try {
      exec(body);
    } catch (x) {
      if (x instanceof Broke) return false;
      if (!(x instanceof Continued)) throw x;
    }
    return true;
  };
  const exec = (s: A.Stmt): void => {
    tick();
    switch (s.kind) {
      case "Block": return block(s.body);
      case "Empty": return;
      case "VarDecl":
        scopes.at(-1)!.set(s.name.name, s.init ? value(s.init) : defaultOf(s.type));
        return;
      case "ExprStmt": return effect(s.expr);
      case "Return": throw new Returned(s.value ? value(s.value) : null);
      case "Break": throw new Broke();
      case "Continue": throw new Continued();
      case "If":
        if (value(s.cond)) exec(s.then);
        else if (s.else) exec(s.else);
        return;
      case "While":
        while (value(s.cond)) if (!round(s.body)) break;
        return;
      case "DoWhile":
        do if (!round(s.body)) break; while (value(s.cond));
        return;
      case "For":
        scopes.push(new Map());
        try {
          if (s.init) s.init.kind === "VarDecl" ? exec(s.init) : effect(s.init.expr);
          while (!s.cond || value(s.cond)) {
            if (!round(s.body)) break;
            if (s.update) effect(s.update);
          }
        } finally {
          scopes.pop();
        }
        return;
      case "ForRange": {
        const step = s.step ? (value(s.step) as number) : 1;
        const end = s.end ? (value(s.end) as number) : undefined;
        scopes.push(new Map([[s.variable.name.name, value(s.start)]]));
        try {
          const name = s.variable.name.name;
          for (;;) {
            const v = scopes.at(-1)!.get(name) as number;
            if (end !== undefined && (s.inclusive ? v > end : v >= end)) break;
            if (!round(s.body)) break;
            scopes.at(-1)!.set(name, (scopes.at(-1)!.get(name) as number) + step);
          }
        } finally {
          scopes.pop();
        }
        return;
      }
      case "Switch": {
        // As in JavaScript: the first matching case (else `default`), then falling through until `break`.
        const d = value(s.discriminant);
        let start = s.cases.findIndex((c) => c.test && value(c.test) === d);
        if (start < 0) start = s.cases.findIndex((c) => !c.test);
        if (start < 0) return;
        try {
          for (const c of s.cases.slice(start)) block(c.body);
        } catch (x) {
          if (!(x instanceof Broke)) throw x;
        }
        return;
      }
      default:
        throw new Failed(notConst({ span: s.span } as A.Expr, "not allowed in a `constexpr` function"));
    }
  };
  try {
    block(body.body);
  } catch (x) {
    if (x instanceof Returned) return { ok: true, value: x.value };
    if (x instanceof Failed) return x.fold;
    if (x instanceof Broke || x instanceof Continued) return notConst({ span: body.span } as A.Expr);
    throw x;
  }
  return { ok: false, at, reason: "the function ended without returning a value", limit: true };
}
