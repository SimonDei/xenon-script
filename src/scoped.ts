/**
 * Scoped classes (PLAN.md A6, "Scoped destructors"): a class with a destructor that doesn't opt into
 * manual disposal (`implements IDisposable`) is destroyed when the scope owning it ends. JavaScript
 * can't tell when the last reference to an object is gone, so ownership is decided here, at compile
 * time, and made safe by never letting a scoped value outlive its scope:
 *
 * - owners: a local declared from a value created here (`var r = new Res()`, `var r = make()`), the
 *   caller of a `return`, or the statement creating a value it doesn't bind (a *temporary*);
 * - anything else holding a scoped value only borrows it (parameters, `this`, `var b = r`);
 * - a scoped value can't be stored (X0822), captured by a closure (X0823), converted to a type that
 *   isn't scoped (X0824), returned by a function that doesn't own it (X0825) or reassigned (X0826).
 *
 * Runs after the body checker, on its results (types, resolutions, expected types), and records
 * what codegen destroys where: `scopedLocals`, `scopedTemps`, `scopedReturns`.
 */
import type * as A from "./ast.ts";
import { chainDestructor, type CheckResult, type ClassInfo, isNative, isScoped } from "./checker.ts";
import type { DiagnosticBag, DiagnosticBuilder } from "./diagnostics.ts";
import { type Span, span } from "./source.ts";
import { mentions } from "./flow.ts";
import type { Type } from "./types.ts";

/** How a value reaches its context. `branch`: an arm of `?:`/`??`/`||`/`&&`, judged with the whole expression. */
type Ctx = "discard" | "receiver" | "use" | "arg" | "store" | "default" | "branch";

/** Where a scoped value comes from: created here (owned), held by someone else (borrowed), or both (on different branches). */
type Origin = "owned" | "borrowed" | "null" | "mixed";

type NoTemps = "loop" | "condition" | "header" | "field" | "default" | "arrow" | undefined;

/** The scoped class of a value's type (`Res` or `Res?`). */
function scopedClass(t: Type | undefined): ClassInfo | undefined {
  const n = t?.kind === "nullable" ? t.inner : t;
  return n?.kind === "class" && isScoped(n.info) ? n.info : undefined;
}

/** A type holding a scoped value inside it, where it would be kept: a type argument, a union or shape member. */
function holdsScoped(t: Type, seen = new Set<Type>()): ClassInfo | undefined {
  if (seen.has(t)) return undefined;
  seen.add(t);
  const deep = (x: Type) => scopedClass(x) ?? holdsScoped(x, seen);
  switch (t.kind) {
    case "nullable":
      return holdsScoped(t.inner, seen);
    case "class":
    case "builtin":
      for (const a of t.args ?? []) {
        const found = deep(a);
        if (found) return found;
      }
      return undefined;
    case "union":
      for (const m of t.types) {
        const found = deep(m);
        if (found) return found;
      }
      return undefined;
    case "shape":
      for (const m of t.members.values()) {
        const found = deep(m.type());
        if (found) return found;
      }
      return undefined;
    default:
      return undefined; // function types only borrow (parameters) or hand on (results)
  }
}

export function checkScoped(files: A.XenonFile[], result: CheckResult, diags: DiagnosticBag) {
  const own = new Set(files.filter((f) => !f.file.prelude && !f.file.generated));
  if (![...result.classes.values()].some((c) => !isNative(c) && chainDestructor(c))) return; // nothing scoped anywhere
  const checker = new ScopedChecker(result, diags);
  for (const info of result.classes.values()) {
    if (!own.has(info.file) || isNative(info) || info.decl.isInterface || info.decl.isEnum) continue;
    checker.classDecl(info);
  }
  checker.typeNodes(own);
}

/** One function being checked (a method, a closure, a field initializer). */
interface Fn {
  async: boolean;
  /** Locals and parameters declared in it, by their name's span. */
  locals: Set<Span>;
  /** Closures nest: captures are uses of a scoped local from an outer function, or of `this` inside a closure. */
  depth: number;
}

class ScopedChecker {
  private info!: ClassInfo;
  private fn: Fn = { async: false, locals: new Set(), depth: 0 };
  /** `defer`s whose code runs when the current statement leaves its block (innermost last). */
  private defers: (A.Stmt & { kind: "Defer" })[] = [];
  /**
   * Why a value created here couldn't be destroyed at a single moment (X0829), or `undefined` where
   * the current statement destroys it at its end: expression statements, `var` and `return`.
   */
  private noTemps: NoTemps = "field";
  /** Locals owning a value, by declaration span (for `return r` hand-off). */
  private owners = new Map<Span, A.Ident>();
  /** Locals of a scoped type (owning or borrowing), by declaration span (for X0826). */
  private scopedLocals = new Set<Span>();
  /** Result types of `async` functions: `Promise<Res>` is reported at the `return` instead (X0824). */
  private asyncResults = new Set<A.TypeNode>();
  /** Spans already reported, so an enclosing expression isn't reported again. */
  private reported: Span[] = [];

  constructor(private result: CheckResult, private diags: DiagnosticBag) {}

  private type(e: A.Expr): Type | undefined {
    return this.result.exprTypes.get(e);
  }

  private error(code: string, message: string, at: Span, label: string, cls?: ClassInfo): DiagnosticBuilder {
    this.reported.push(at);
    const d = this.diags.error(code, message, at, label);
    const dtor = cls && chainDestructor(cls);
    if (cls && dtor) d.secondary(dtor.decl.name.span, `this destructor makes \`${cls.decl.name.name}\` scoped`);
    return d;
  }

  private keepHelp(d: DiagnosticBuilder, cls: ClassInfo) {
    d.help(`to keep \`${cls.decl.name.name}\` values beyond a scope, give it no destructor and implement \`IDisposable\` instead: its own \`dispose()\`, called by \`using\` or by hand`);
  }

  private covered(at: Span): boolean {
    return this.reported.some((r) => r.file === at.file && r.start >= at.start && r.end <= at.end);
  }

  /* ----------------------------- declarations ----------------------------- */

  classDecl(info: ClassInfo) {
    this.info = info;
    for (const m of info.decl.members) {
      if (m.kind === "Field") this.field(m);
      else if (m.kind === "Method") this.method(m);
      else this.function(false, [], () => this.block(m.body));
    }
  }

  private field(f: A.Field) {
    const t = (f.type && this.result.typeNodeTypes.get(f.type)) ?? (f.init && this.type(f.init));
    const cls = scopedClass(t);
    if (cls) {
      const d = this.error("X0822", `a field can't hold a scoped \`${cls.decl.name.name}\``, f.type?.span ?? f.name.span, "a field outlives any scope", cls);
      d.note("scoped values are destroyed when the scope owning them ends, so they can't be kept in fields");
      this.keepHelp(d, cls);
      return;
    }
    if (!f.init) return;
    this.function(false, [], () => {
      this.noTemps = "field";
      this.visit(f.init!, "store");
    });
  }

  private method(m: A.Method) {
    if (m.modifiers.async && m.returnType) this.asyncResults.add(m.returnType);
    if (!m.body) return;
    this.function(!!m.modifiers.async, m.params, () => this.block(m.body!));
  }

  /** Runs `body` as a function of its own: its locals, its `async`, closures one level deeper. */
  private function(async: boolean, params: A.Param[], body: () => void, closure = false) {
    const saved = { fn: this.fn, noTemps: this.noTemps, defers: this.defers };
    this.fn = { async, locals: new Set(), depth: closure ? saved.fn.depth + 1 : 0 };
    this.defers = [];
    try {
      for (const p of params) {
        this.fn.locals.add(p.name.span);
        if (p.type && scopedClass(this.result.typeNodeTypes.get(p.type))) this.scopedLocals.add(p.name.span);
        if (p.init) {
          this.noTemps = "default";
          this.visit(p.init, "default");
        }
      }
      body();
    } finally {
      this.fn = saved.fn;
      this.noTemps = saved.noTemps;
      this.defers = saved.defers;
    }
  }

  /** X0824 for type annotations keeping a scoped type inside another: `Array<Res>`, `Res | int`, `{ r:Res }`. */
  typeNodes(own: Set<A.XenonFile>) {
    const files = new Set([...own].map((f) => f.file));
    for (const [node, t] of this.result.typeNodeTypes) {
      if (!files.has(node.span.file) || this.covered(node.span) || this.asyncResults.has(node)) continue;
      const cls = holdsScoped(t);
      if (!cls) continue;
      const d = this.error("X0824", `a scoped \`${cls.decl.name.name}\` can't be kept inside another type`, node.span, "this type would keep it", cls);
      d.note("only a variable, a parameter or a return value can hold a scoped value: they end with their scope");
      this.keepHelp(d, cls);
    }
  }

  /* ------------------------------ statements ------------------------------ */

  private block(b: A.Block) {
    const n = this.defers.length;
    for (const s of b.body) {
      this.stmt(s);
      if (s.kind === "Defer") this.defers.push(s);
    }
    this.defers.length = n;
  }

  private stmt(s: A.Stmt): void {
    const saved = this.noTemps;
    this.noTemps = "header";
    try {
      this.statement(s);
    } finally {
      this.noTemps = saved;
    }
  }

  private statement(s: A.Stmt): void {
    switch (s.kind) {
      case "Block":
        return this.block(s);
      case "VarDecl":
        if (this.noTemps !== "loop") this.noTemps = undefined;
        return this.varDecl(s);
      case "ExprStmt":
        this.noTemps = undefined;
        return this.visit(s.expr, "discard");
      case "Return":
        return this.returnStmt(s);
      case "If":
        this.noTemps = "condition";
        this.visit(s.cond, "use");
        this.stmt(s.then);
        if (s.else) this.stmt(s.else);
        return;
      case "IfVar":
      case "WhileVar":
        this.noTemps = s.kind === "WhileVar" ? "loop" : "condition";
        for (const h of s.header) {
          if (h.kind === "Cond") this.visit(h.expr, "use");
          else this.binding(h.name, h.init, h.type);
        }
        if (s.kind === "IfVar") {
          this.stmt(s.then);
          if (s.else) this.stmt(s.else);
        } else this.stmt(s.body);
        return;
      case "While":
      case "DoWhile":
        this.noTemps = "loop";
        this.visit(s.cond, "use");
        return this.stmt(s.body);
      case "For":
        this.noTemps = "loop";
        if (s.init?.kind === "VarDecl") this.varDecl(s.init);
        else if (s.init) this.visit(s.init.expr, "discard");
        if (s.cond) this.visit(s.cond, "use");
        if (s.update) this.visit(s.update, "discard");
        return this.stmt(s.body);
      case "ForIn":
      case "ForOf":
        this.noTemps = "loop";
        this.visit(s.kind === "ForIn" ? s.object : s.iterable, "use");
        return this.stmt(s.body);
      case "ForRange":
        this.noTemps = "loop";
        for (const e of [s.start, s.end, s.step]) if (e) this.visit(e, "use");
        return this.stmt(s.body);
      case "Switch":
        this.noTemps = "condition";
        this.visit(s.discriminant, "use");
        for (const c of s.cases) {
          this.noTemps = "condition";
          if (c.test) this.visit(c.test, "use");
            for (const x of c.body) this.stmt(x);
        }
        return;
      case "Throw":
        this.noTemps = "header";
        return this.visit(s.value, "store", "thrown");
      case "Try":
        this.block(s.block);
        for (const c of s.catches) this.block(c.body);
        if (s.finally) this.block(s.finally);
        return;
      case "FuncDecl":
        this.fn.locals.add(s.fn.name.span);
        return this.closure(s.fn);
      case "DestructDecl":
        this.noTemps = "header";
        return this.visit(s.init, "receiver");
      case "UsingDecl":
      case "UsingBlock": {
        this.noTemps = "header";
        const resources = s.kind === "UsingDecl" ? [{ init: s.init, name: s.name }] : s.resources.map((r) => (r.kind === "Decl" ? { init: r.init, name: r.name } : { init: r.expr, name: undefined }));
        for (const r of resources) {
          const cls = scopedClass(this.type(r.init));
          if (cls) this.redundantUsing(s, r.init, cls);
          else this.visit(r.init, "use");
          if (r.name) this.fn.locals.add(r.name.span);
        }
        if (s.kind === "UsingBlock") this.stmt(s.body);
        return;
      }
      case "Defer":
        return this.stmt(s.body);
      case "Break":
      case "Continue":
      case "Empty":
        return;
    }
  }

  /** X0827: `using` on a scoped value, which is destroyed at scope end anyway. */
  private redundantUsing(s: A.Stmt & { kind: "UsingDecl" | "UsingBlock" }, init: A.Expr, cls: ClassInfo) {
    const name = cls.decl.name.name;
    const d = this.error("X0827", `\`${name}\` is scoped: \`using\` isn't needed`, init.span, "destroyed when its scope ends anyway", cls);
    if (s.kind === "UsingDecl") {
      // `[await] using r = …` → `var r = …`
      d.help("declare it with `var`", [{ span: span(s.span.file, s.span.start, s.name.span.start), text: "var " }]);
    } else {
      d.help("declare the resources with `var` inside the block instead");
    }
  }

  private varDecl(s: A.VarDecl) {
    this.fn.locals.add(s.name.span);
    const declared = s.type ? this.result.typeNodeTypes.get(s.type) : undefined;
    const cls = scopedClass(declared ?? (s.init && this.type(s.init)));
    if (cls) this.scopedLocals.add(s.name.span);
    if (!s.init) return;
    if (!cls) return this.visit(s.init, "use", undefined, declared);
    const origin = this.origin(s.init);
    if (origin === "mixed") this.mixed(s.init, cls);
    else if (origin === "owned") this.own(s.name, s.init, cls);
    this.children(s.init);
  }

  /** An `if (var r = …)` / `while (var r = …)` binding: borrowing only (nothing could destroy an owned value). */
  private binding(name: A.Ident, init: A.Expr, type?: A.TypeNode) {
    this.fn.locals.add(name.span);
    const declared = type ? this.result.typeNodeTypes.get(type) : undefined;
    const cls = scopedClass(declared ?? this.type(init));
    if (!cls) return this.visit(init, "use", undefined, declared);
    this.scopedLocals.add(name.span);
    if (this.origin(init) !== "borrowed") this.noTemp(init, cls);
    this.children(init);
  }

  /** `name` owns the value `init` creates: destroyed at the end of its block. */
  private own(name: A.Ident, init: A.Expr, cls: ClassInfo) {
    if (this.noTemps === "loop") return this.noTemp(init, cls);
    const async = !!chainDestructor(cls)?.async;
    if (async && !this.fn.async) this.asyncOwner(init, cls);
    this.owners.set(name.span, name);
    this.result.scopedLocals.set(name, { async });
  }

  private returnStmt(s: A.Stmt & { kind: "Return" }) {
    if (!s.value) return;
    const v = s.value;
    this.noTemps = undefined;
    const cls = scopedClass(this.type(v));
    if (!cls) return this.visit(v, "use");
    this.returned(v, cls, s);
    this.children(v);
  }

  /** A scoped value leaving its function through `return` (or an arrow's expression body). */
  private returned(v: A.Expr, cls: ClassInfo, s?: A.Stmt) {
    const name = cls.decl.name.name;
    if (this.fn.async) {
      const d = this.error("X0824", `an \`async\` function can't return a scoped \`${name}\` yet`, v.span, "would be kept in a `Promise`", cls);
      d.note("the promise would hold the value after this function's scope ended");
      this.keepHelp(d, cls);
      return;
    }
    const expected = this.result.expectedTypes.get(v);
    if (expected && !scopedClass(expected) && expected.kind !== "error") return this.converted(v, expected, cls);
    const origin = this.origin(v);
    if (origin === "mixed") return this.mixed(v, cls);
    if (origin !== "borrowed") return; // created here: handed to the caller
    const r = v.kind === "Ident" ? this.result.resolutions.get(v) : undefined;
    const owner = r?.kind === "local" ? this.owners.get(r.decl) : undefined;
    if (owner && s) {
      // `return r`: the caller owns it now; this scope no longer destroys it.
      this.result.scopedReturns.add(s);
      this.result.scopedLocals.get(owner)!.handedOff = true;
      // The variable is cleared as it's handed on, before deferred code runs.
      const local = (v as A.Expr & { kind: "Ident" }).name;
      const deferred = this.defers.find((d) => mentions(d.body as unknown as A.Expr, local));
      if (deferred) {
        this.error("X0805", `\`${local}\` is handed on here, but deferred code still uses it`, v.span, "the caller owns it from here")
          .secondary(span(deferred.span.file, deferred.span.start, deferred.span.start + "defer".length), "runs after the `return`")
          .note("deferred code runs after `return` has handed the value to the caller, so the variable no longer holds it");
      }
      return;
    }
    const what = v.kind === "This" ? "`this`" : v.kind === "Ident" && r?.kind === "local" ? `\`${v.name}\`` : "this value";
    const d = this.error("X0825", `${what} can't be returned: this function doesn't own it`, v.span, "borrowed, not owned here", cls);
    d.note(v.kind === "This"
      ? "the caller already holds this object; returning it would let two scopes destroy it"
      : "whoever passed it in still owns it and destroys it at the end of their scope; returning it would destroy it twice");
    d.help(`return a \`${name}\` created here (\`new ${name}(…)\` or a call returning one), or return nothing`);
  }

  /* ------------------------------ expressions ----------------------------- */

  /** Where a scoped value comes from. */
  private origin(e: A.Expr): Origin {
    switch (e.kind) {
      case "New":
      case "Call":
      case "Member": // a getter
        return "owned";
      case "Null":
        return "null";
      case "Ident":
        return this.result.resolutions.get(e)?.kind === "member" ? "owned" : "borrowed";
      case "Conditional":
        return combine(this.origin(e.then), this.origin(e.else));
      case "Binary":
        return e.op === "??" || e.op === "||" || e.op === "&&" ? combine(this.origin(e.left), this.origin(e.right)) : "borrowed";
      case "TypeOp":
      case "TypeCheck":
        return this.origin(e.expr);
      case "Unconst":
        return this.origin(e.arg);
      default:
        return "borrowed";
    }
  }

  private mixed(e: A.Expr, cls: ClassInfo) {
    const d = this.error("X0825", `this \`${cls.decl.name.name}\` is created on one branch and borrowed on another`, e.span, "owned or not depending on the branch", cls);
    d.note("a scoped value is destroyed by its owner; here the owner would depend on which branch ran");
    d.help("use an `if`/`else` with a separate variable on each branch");
  }

  /** X0829: a value created where nothing can destroy it at a single moment. */
  private noTemp(e: A.Expr, cls: ClassInfo) {
    const where = this.noTemps === "loop" ? "in a loop header" : this.noTemps === "condition" ? "in a condition" : this.noTemps === "default" ? "in a parameter default" : this.noTemps === "field" ? "in a field initializer" : this.noTemps === "arrow" ? "in an arrow's expression body" : "here";
    const d = this.error("X0829", `a scoped \`${cls.decl.name.name}\` can't be created ${where}`, e.span, "nothing here can destroy it", cls);
    if (this.noTemps === "arrow") d.help("use a block body: `(…) => { … }`, then the statement inside destroys it");
    else if (this.noTemps === "default") d.help("create it inside the function body instead");
    else d.help("create it in a `var` first (inside the loop for a value per iteration): it is destroyed when that variable's block ends");
    if (this.noTemps === "loop") d.note("a loop header runs many times; there's no single point where its values could be destroyed");
  }

  private asyncOwner(e: A.Expr, cls: ClassInfo) {
    this.error("X0807", `\`${cls.decl.name.name}\` has an async destructor: only an \`async\` function can own one`, e.span, "created in a function that isn't async", cls)
      .note("destroying it is awaited when its scope ends");
  }

  /** `e` is a temporary owned by the current statement. */
  private temp(e: A.Expr, cls: ClassInfo) {
    if (this.noTemps) return this.noTemp(e, cls);
    const async = !!chainDestructor(cls)?.async;
    if (async && !this.fn.async) this.asyncOwner(e, cls);
    this.result.scopedTemps.set(e, { async });
  }

  /** X0824: a scoped value converted to a type that could keep it. */
  private converted(e: A.Expr, to: Type | undefined, cls: ClassInfo, what?: string) {
    const name = cls.decl.name.name;
    const target = what ?? (to ? `\`${typeText(to)}\`` : "an untyped parameter");
    const d = this.error("X0824", `a scoped \`${name}\` can't be passed on as ${target}`, e.span, to ? `converted to \`${typeText(to)}\`` : "passed to untyped code", cls);
    d.note(`only \`${name}\` (or a scoped parent class) can hold it: anything else could keep it after its scope ended`);
    this.keepHelp(d, cls);
  }

  /**
   * Checks the value `e` in its context, then its parts. `expected`: the type it is converted to
   * (when not recorded by the checker); `what`: how a store is described.
   */
  private visit(e: A.Expr, ctx: Ctx, what?: string, expected?: Type): void {
    const cls = scopedClass(this.type(e));
    if (cls && ctx !== "branch") this.scopedValue(e, ctx, cls, what, expected);
    this.children(e, cls && ctx !== "store" && ctx !== "arg" ? "branch" : "use");
    // A value whose type keeps a scoped value inside (`[r]`, `Promise.resolve(r)`, `new Box(r)`).
    // Only where such a value is made: names and members have their type reported where declared,
    // and a value checked against an annotation has it reported there.
    const t = this.type(e);
    const made = e.kind === "Call" || e.kind === "New" || e.kind === "Array" || e.kind === "Comprehension" || e.kind === "Object";
    const annotated = this.result.expectedTypes.get(e);
    if (!t || !made || cls || (annotated && holdsScoped(annotated))) return;
    const held = holdsScoped(t);
    if (held && !this.covered(e.span)) {
      const d = this.error("X0824", `a scoped \`${held.decl.name.name}\` can't be kept in a \`${typeText(t)}\``, e.span, "this value would keep it", held);
      this.keepHelp(d, held);
    }
  }

  private scopedValue(e: A.Expr, ctx: Ctx, cls: ClassInfo, what?: string, expected?: Type) {
    const origin = this.origin(e);
    if (origin === "mixed") return this.mixed(e, cls);
    const created = origin === "owned";
    switch (ctx) {
      case "discard":
      case "receiver":
      case "use": {
        const to = expected ?? this.result.expectedTypes.get(e);
        if (ctx === "use" && to && !scopedClass(to) && to.kind !== "error") return this.converted(e, to, cls);
        if (created) this.temp(e, cls);
        return;
      }
      case "arg": {
        const to = this.result.expectedTypes.get(e);
        if (!to || !scopedClass(to)) return this.converted(e, to && to.kind !== "error" ? to : undefined, cls);
        if (created) this.temp(e, cls);
        return;
      }
      case "default":
        if (created) return this.noTemp(e, cls);
        return;
      case "store": {
        const d = this.error("X0822", `a scoped \`${cls.decl.name.name}\` can't be ${what ?? "stored"}`, e.span, "it would outlive its scope", cls);
        d.note("scoped values are destroyed when the scope owning them ends, so nothing may keep them");
        this.keepHelp(d, cls);
        return;
      }
    }
  }

  /** The parts of `e`, each in its own context. `branch`: arms of `?:`/`??` are judged with `e`. */
  private children(e: A.Expr, arms: Ctx = "branch"): void {
    switch (e.kind) {
      case "Ident":
        return this.ident(e);
      case "This":
        return this.thisExpr(e);
      case "Template":
        for (const p of e.parts) if (p.kind === "expr") this.visit(p.expr, "use");
        return;
      case "Array":
        for (const el of e.elements) this.visit(el.kind === "Spread" ? el.arg : el, "store", "stored in an array");
        return;
      case "Comprehension": {
        const saved = this.noTemps;
        this.noTemps = "loop";
        for (const clause of e.clauses) {
          if (clause.kind === "If") this.visit(clause.cond, "use");
          else {
            if (clause.kind === "For") this.visit(clause.iterable, "use");
            else for (const bound of [clause.start, clause.end, clause.step]) if (bound) this.visit(bound, "use");
            if (clause.variable.pattern) {
              const addBindings = (p: A.Pattern): void => {
                if (p.kind === "BindingName") this.fn.locals.add(p.name.span);
                else if (p.kind === "ArrayPattern") {
                  for (const item of p.elements) if (item) addBindings(item);
                  if (p.rest) addBindings(p.rest);
                } else if (p.kind === "ObjectPattern") {
                  for (const prop of p.props) addBindings(prop.value);
                  if (p.rest) addBindings(p.rest);
                }
              };
              this.pattern(clause.variable.pattern);
              addBindings(clause.variable.pattern);
            } else this.fn.locals.add(clause.variable.name.span);
          }
        }
        this.visit(e.value, "store", "stored in an array");
        this.noTemps = saved;
        return;
      }
      case "Object":
        for (const p of e.props) {
          if (p.kind === "Prop") {
            if ("expr" in p.key) this.visit(p.key.expr, "use");
            this.visit(p.value, "store", "stored in an object");
          } else if (p.kind === "Shorthand") {
            const cls = scopedClass(this.type({ kind: "Ident", name: p.name.name, span: p.name.span }));
            if (cls) this.scopedValue({ kind: "Ident", name: p.name.name, span: p.name.span }, "store", cls, "stored in an object");
          } else if (p.kind === "Accessor") this.visit(p.fn, "use");
          else this.visit(p.arg, "store", "spread into an object");
        }
        return;
      case "Spread":
        return this.visit(e.arg, "store", "spread");
      case "Member":
        this.visit(e.object, "receiver");
        return this.methodClosure(e, e.object);
      case "PropertyReference":
        return; // The type is not evaluated and no receiver is captured.
      case "Index":
        this.visit(e.object, "receiver");
        return this.visit(e.index, "use");
      case "Call":
        if (this.result.inlineValues.has(e)) return;
        if (e.callee.kind === "Member") {
          this.visit(e.callee.object, "receiver");
        } else if (e.callee.kind !== "Ident" && e.callee.kind !== "Super") this.visit(e.callee, "use");
        else if (e.callee.kind === "Ident") this.ident(e.callee);
        for (const a of e.args) this.visit(a.kind === "Spread" ? a.arg : a, a.kind === "Spread" ? "store" : "arg", "spread");
        return;
      case "Nameof":
        return; // Checked without evaluating its target.
      case "Unconst":
        return this.visit(e.arg, arms); // the value passes through, like a conditional's branch
      case "New":
        for (const a of e.args) this.visit(a.kind === "Spread" ? a.arg : a, a.kind === "Spread" ? "store" : "arg", "spread");
        return;
      case "Unary":
      case "Update":
      case "Await":
        return this.visit(e.arg, "use");
      case "Binary":
        if (e.op === "??" || e.op === "||" || e.op === "&&") {
          this.visit(e.left, arms);
          return this.visit(e.right, arms);
        }
        this.visit(e.left, "use");
        return this.visit(e.right, "use");
      case "Conditional":
        this.visit(e.cond, "use");
        this.visit(e.then, arms);
        return this.visit(e.else, arms);
      case "TypeOp":
      case "TypeCheck": {
        const inner = scopedClass(this.type(e.expr));
        const target = this.type(e);
        if (inner && e.kind === "TypeOp" && e.op === "is") return this.visit(e.expr, "use");
        if (inner && !scopedClass(target)) {
          this.converted(e.expr, target, inner);
          return this.children(e.expr);
        }
        return this.visit(e.expr, inner ? "branch" : "use");
      }
      case "Assign":
        return this.assign(e);
      case "DestructAssign":
        this.pattern(e.pattern);
        return this.visit(e.value, "receiver");
      case "Function":
        return this.closure(e);
      default:
        return;
    }
  }

  private assign(e: A.Expr & { kind: "Assign" }) {
    const t = e.target;
    const r = t.kind === "Ident" ? this.result.resolutions.get(t) : undefined;
    if (r?.kind === "local" && this.scopedLocals.has(r.decl)) {
      const cls = scopedClass(this.type(t)) ?? scopedClass(this.type(e.value));
      this.error("X0826", `\`${(t as A.Expr & { kind: "Ident" }).name}\` holds a scoped value and can't be assigned again`, e.span, "reassigned here", cls)
        .note("its value is destroyed when its scope ends; another value would be left undestroyed, or this one destroyed too early")
        .help("declare a new variable for the other value");
      this.children(e.value);
      return;
    }
    if (t.kind === "Ident") this.ident(t);
    else this.children(t, "use");
    if (r?.kind === "local") return this.visit(e.value, "use");
    // A field, a property or an element: a store.
    this.visit(e.value, "store", r?.kind === "member" || t.kind === "Member" ? "stored in a field or property" : t.kind === "Index" ? "stored in an element" : "stored");
  }

  private pattern(p: A.Pattern) {
    if (p.kind === "Target") this.children(p.expr, "use");
    if (p.kind === "ObjectPattern") for (const x of p.props) this.pattern(x.value);
    if (p.kind === "ArrayPattern") for (const x of p.elements) if (x) this.pattern(x);
    if ((p.kind === "ObjectPattern" || p.kind === "ArrayPattern") && p.rest) this.pattern(p.rest);
    if (p.init) this.visit(p.init, "store");
  }

  /** X0823 for a scoped local or parameter used inside a closure declared after it. */
  private ident(e: A.Expr & { kind: "Ident" }) {
    const r = this.result.resolutions.get(e);
    if (r?.kind === "local") {
      const cls = scopedClass(this.type(e));
      if (cls && !this.fn.locals.has(r.decl)) this.captured(e.span, `\`${e.name}\``, cls);
      return;
    }
    // A bare member name reaches `this`.
    if (r?.kind === "member" && !r.isStatic && this.fn.depth > 0 && isScoped(this.info)) {
      this.captured(e.span, "`this`", this.info, e.name);
      return;
    }
    if (r?.kind === "member" && this.result.methodClosures.has(e) && isScoped(this.info) && !r.isStatic) this.methodValue(e.span, this.info);
  }

  private thisExpr(e: A.Expr) {
    const cls = scopedClass(this.type(e));
    if (cls && this.fn.depth > 0) this.captured(e.span, "`this`", cls);
  }

  private captured(at: Span, what: string, cls: ClassInfo, member?: string) {
    if (this.covered(at)) return;
    const d = this.error("X0823", `${what} is a scoped \`${cls.decl.name.name}\` and can't be used in a closure`, at, member ? `\`${member}\` reads \`this\` here` : "captured here", cls);
    d.note("the closure could run after the scope ended and its value was destroyed");
    d.help("use the value outside the closure, or pass what the closure needs instead (`var name:String = r.name`)");
  }

  /** `r.read` as a value: a method closure keeps `r`. */
  private methodClosure(e: A.Expr & { kind: "Member" }, object: A.Expr) {
    if (!this.result.methodClosures.has(e)) return;
    const cls = scopedClass(this.type(object));
    if (cls) this.methodValue(e.span, cls);
  }

  private methodValue(at: Span, cls: ClassInfo) {
    const d = this.error("X0823", `a method of a scoped \`${cls.decl.name.name}\` can't be used as a value`, at, "this function value keeps its object", cls);
    d.note("the function could be called after the object was destroyed");
    d.help("call the method here instead");
  }

  private closure(f: A.FunctionNode) {
    if (f.async && f.returnType) this.asyncResults.add(f.returnType);
    this.function(f.async, f.params, () => {
      if (f.body.kind === "Block") return this.block(f.body);
      // An expression body returns its value; it has no statement to destroy temporaries.
      const v = f.body;
      const cls = scopedClass(this.type(v));
      this.noTemps = "arrow";
      if (cls) {
        this.returned(v, cls);
        this.children(v);
      } else this.visit(v, "use");
    }, true);
  }
}

function combine(a: Origin, b: Origin): Origin {
  if (a === "null") return b;
  if (b === "null") return a;
  return a === b ? a : "mixed";
}

/** A type as messages show it (compact; the checker's own printer lives there). */
function typeText(t: Type): string {
  switch (t.kind) {
    case "any":
      return "*";
    case "class":
      return t.info.decl.name.name + (t.args?.length ? `<${t.args.map(typeText).join(", ")}>` : "");
    case "builtin":
      return t.name + (t.args.length ? `<${t.args.map(typeText).join(", ")}>` : "");
    case "nullable":
      return typeText(t.inner) + "?";
    case "prim":
      return t.name;
    case "union":
      return t.alias ?? t.types.map(typeText).join(" | ");
    case "shape":
      return t.alias ?? "{…}";
    case "method":
      return t.alias ?? "Function";
    case "typeParam":
      return t.param.name;
    default:
      return t.kind;
  }
}
