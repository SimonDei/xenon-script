import type * as A from "./ast.ts";

/**
 * Can execution continue after this statement ("complete normally")?
 * `return`, `throw`, `break` and `continue` never do; loops that can only be left
 * through `break` complete only if they contain such a `break`.
 */
export function completes(s: A.Stmt): boolean {
  switch (s.kind) {
    case "Return":
    case "Throw":
    case "Break":
    case "Continue":
      return false;
    case "Block":
      return s.body.every(completes);
    case "If":
    case "IfVar":
      return !s.else || completes(s.then) || completes(s.else);
    case "While":
      return !isTrue(s.cond) || breaksOut(s.body);
    case "DoWhile":
      return breaksOut(s.body) || (!isTrue(s.cond) && (completes(s.body) || continues(s.body)));
    case "For":
      return (s.cond !== undefined && !isTrue(s.cond)) || breaksOut(s.body);
    case "ForRange":
      return s.end !== undefined || breaksOut(s.body);
    case "UsingBlock":
      return completes(s.body);
    case "Try":
      return (completes(s.block) || s.catches.some((c) => completes(c.body))) && (!s.finally || completes(s.finally));
    case "Switch": {
      if (!s.cases.some((c) => !c.test)) return true;
      if (s.cases.some((c) => c.body.some(breaksOut))) return true;
      const last = s.cases.at(-1)!;
      return last.body.every(completes);
    }
    default:
      return true;
  }
}

function isTrue(e: A.Expr): boolean {
  return e.kind === "Bool" && e.value;
}

/** Does `s` contain a `break` that leaves the enclosing loop/switch (not one nested deeper)? */
export function breaksOut(s: A.Stmt): boolean {
  switch (s.kind) {
    case "Break":
      return true;
    case "Block":
      return s.body.some(breaksOut);
    case "If":
    case "IfVar":
      return breaksOut(s.then) || (!!s.else && breaksOut(s.else));
    case "UsingBlock":
      return breaksOut(s.body);
    case "Try":
      return [s.block, ...s.catches.map((c) => c.body), ...(s.finally ? [s.finally] : [])].some(breaksOut);
    default:
      return false; // loops and switches capture their own breaks
  }
}

/** Does `s` contain a `continue` for the enclosing loop? (`switch` doesn't capture `continue`.) */
function continues(s: A.Stmt): boolean {
  switch (s.kind) {
    case "Continue":
      return true;
    case "Block":
      return s.body.some(continues);
    case "If":
    case "IfVar":
      return continues(s.then) || (!!s.else && continues(s.else));
    case "Switch":
      return s.cases.some((c) => c.body.some(continues));
    case "UsingBlock":
      return continues(s.body);
    case "Try":
      return [s.block, ...s.catches.map((c) => c.body), ...(s.finally ? [s.finally] : [])].some(continues);
    default:
      return false;
  }
}

/** Does the expression mention the identifier `name` anywhere? */
export function mentions(e: A.Expr, name: string): boolean {
  let found = false;
  const visit = (x: unknown): void => {
    if (found || !x || typeof x !== "object") return;
    if (Array.isArray(x)) return x.forEach(visit);
    const node = x as { kind?: string; name?: unknown; span?: unknown; file?: unknown };
    if (node.kind === "Ident" && node.name === name) {
      found = true;
      return;
    }
    for (const [k, v] of Object.entries(node)) if (k !== "span" && k !== "file") visit(v);
  };
  visit(e);
  return found;
}
