import type * as A from "./ast.ts";
import type { Span } from "./source.ts";
import { isNullable, type Type } from "./types.ts";

/** A value known at compile time. */
export type ConstValue = number | string | boolean | null;

export type Fold =
  | { ok: true; value: ConstValue }
  /** `reported`: the cause was already reported (e.g. a broken dependency), don't report again. */
  | { ok: false; at: Span; reason: string; reported?: boolean; cycle?: boolean };

/** Resolves a name/member reference to a constant, or undefined if it isn't one. */
export type ConstLookup = (e: A.Expr) => Fold | undefined;

const CASTS: Record<string, (v: ConstValue) => ConstValue> = {
  int: (v) => (v as number) | 0,
  uint: (v) => (v as number) >>> 0,
  Float: (v) => Number(v),
  String: (v) => String(v),
  Boolean: (v) => Boolean(v),
};

const notConst = (e: A.Expr, reason = "not a compile-time constant"): Fold => ({ ok: false, at: e.span, reason });

/**
 * Evaluates a constant expression with exact JavaScript semantics (the type checker has already
 * made sure the operators are applied to sensible types). Klass `==` is strict.
 */
export function fold(e: A.Expr, lookup: ConstLookup): Fold {
  switch (e.kind) {
    case "Number": return { ok: true, value: e.value };
    case "String": return { ok: true, value: e.value };
    case "Bool": return { ok: true, value: e.value };
    case "Null": return { ok: true, value: null };
    case "Ident":
    case "Member":
      return lookup(e) ?? notConst(e, e.kind === "Ident" ? `\`${e.name}\` is not an inline constant` : `\`${e.name.name}\` is not an inline constant`);
    case "Template": {
      let out = "";
      for (const p of e.parts) {
        if (p.kind === "text") out += p.value;
        else {
          const f = fold(p.expr, lookup);
          if (!f.ok) return f;
          out += String(f.value);
        }
      }
      return { ok: true, value: out };
    }
    case "Unary": {
      if (e.op === "typeof" || e.op === "delete") return notConst(e);
      const f = fold(e.arg, lookup);
      if (!f.ok) return f;
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
      const value = binary(e.op, l.value, r.value);
      return value === undefined ? notConst(e) : { ok: true, value };
    }
    case "Conditional": {
      const c = fold(e.cond, lookup);
      if (!c.ok) return c;
      const a = fold(e.then, lookup);
      if (!a.ok) return a;
      const b = fold(e.else, lookup);
      if (!b.ok) return b;
      return c.value ? a : b;
    }
    case "Call": {
      if (e.callee.kind === "Ident" && e.callee.name in CASTS && e.args.length === 1 && e.args[0]!.kind !== "Spread") {
        const f = fold(e.args[0]!, lookup);
        if (!f.ok) return f;
        return { ok: true, value: CASTS[e.callee.name]!(f.value) };
      }
      return notConst(e, "function calls are not compile-time constants");
    }
    case "New":
      return notConst(e, "`new` is not a compile-time constant");
    case "Array":
    case "Object":
      return notConst(e, "array and object literals are not compile-time constants");
    default:
      return notConst(e);
  }
}

function binary(op: string, a: ConstValue, b: ConstValue): ConstValue | undefined {
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
  switch (t.kind) {
    case "any":
    case "error":
      return true;
    case "prim":
      switch (t.name) {
        case "int": return typeof v === "number" && Number.isInteger(v) && v >= -0x80000000 && v <= 0x7fffffff;
        case "uint": return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 0xffffffff;
        case "Float": return typeof v === "number";
        case "Boolean": return typeof v === "boolean";
        case "String": return typeof v === "string" || v === null;
      }
      return false;
    case "builtin":
      return t.name === "Object" ? true : v === null;
    default:
      return v === null && isNullable(t);
  }
}

/** JS source for a folded value. */
export function constToJs(v: ConstValue, quote: (s: string) => string): { code: string; negative: boolean } {
  if (v === null) return { code: "null", negative: false };
  if (typeof v === "string") return { code: quote(v), negative: false };
  if (typeof v === "boolean") return { code: String(v), negative: false };
  if (Number.isNaN(v)) return { code: "NaN", negative: false };
  if (v === Infinity) return { code: "Infinity", negative: false };
  if (v === -Infinity) return { code: "-Infinity", negative: true };
  if (Object.is(v, -0)) return { code: "-0", negative: true };
  return { code: String(v), negative: v < 0 };
}
