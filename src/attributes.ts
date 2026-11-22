/**
 * Attributes (PLAN.md A6e): `[Route('/', verb = 'POST')]` before a class, method or field. The
 * body checker checks each one like `new Route('/')` plus assignments of the named values
 * (`BodyChecker.checkAttributes`); this module holds what doesn't need a body checker: an attribute
 * class's `Usage`, which arguments are constants, and the compile-time `Deprecated` attribute.
 */
import type * as A from "./ast.ts";
import { type CheckResult, type ClassInfo, findMember, type MemberSig } from "./checker.ts";
import type { DiagnosticBag } from "./diagnostics.ts";
import { cover, type Span } from "./source.ts";
import { nonNull, superclasses } from "./types.ts";

/** Read by the compiler only: never created at run time. */
export const COMPILE_TIME_ATTRIBUTES = new Set(["xenon.Usage", "xenon.Deprecated", "xenon.NoDiscard"]);

export type AttributeTarget = "Class" | "Method" | "Field";

/** Last part of an attribute's name: `Usage` for `[xenon.Usage(…)]`. */
function simpleName(a: A.Attribute): string {
  return a.name.name.at(-1)!.name;
}

/**
 * Where an attribute class may be used and whether it may repeat on one declaration: from a
 * `[Usage(AttributeTarget.Method, …, multiple = true)]` on it or a parent (read from the syntax,
 * so it doesn't depend on the order classes are checked in). Without one: everywhere, once.
 */
export function attributeUsage(info: ClassInfo): { targets: Set<AttributeTarget>; multiple: boolean; node?: A.Attribute } {
  for (const c of [info, ...superclasses(info)]) {
    const node = c.decl.attributes?.find((a) => simpleName(a) === "Usage");
    if (!node) continue;
    const targets = new Set<AttributeTarget>();
    for (const arg of node.args) {
      if (arg.kind === "Member" && ["Class", "Method", "Field"].includes(arg.name.name)) targets.add(arg.name.name as AttributeTarget);
    }
    const multiple = node.named.some((n) => n.name.name === "multiple" && n.value.kind === "Bool" && n.value.value);
    return { targets: targets.size > 0 ? targets : new Set(["Class", "Method", "Field"]), multiple, node };
  }
  return { targets: new Set(["Class", "Method", "Field"]), multiple: false };
}

/**
 * A compile-time constant attribute argument: a literal, an enum member, an `inline` constant, a
 * `constexpr` call (`folds`: the checker's constant folder), or an array of constants.
 */
export function isConstantArgument(e: A.Expr, folds: (e: A.Expr) => boolean, result: CheckResult): boolean {
  switch (e.kind) {
    case "Null":
    case "Bool":
    case "Number":
    case "String":
      return true;
    case "Template":
      return e.parts.every((p) => p.kind === "text");
    case "Array":
      return e.elements.every((x) => x.kind !== "Spread" && isConstantArgument(x, folds, result));
    default:
      return result.inlineValues.has(e) || folds(e);
  }
}

/**
 * X0873 for uses of declarations marked `[Deprecated('…')]` (outside the declaration itself), and
 * X0834 for attributes on interface and enum members (which have no body checker).
 */
export function checkDeprecated(files: A.XenonFile[], result: CheckResult, diags: DiagnosticBag) {
  const own = new Set(files.filter((f) => !f.file.prelude && !f.file.generated).map((f) => f.file));
  const deprecated = new Map<object, { message: string; span: Span; mark: Span }>();
  for (const info of result.classes.values()) {
    const decl = info.decl;
    for (const owner of [decl, ...decl.members]) {
      if (owner.kind === "StaticBlock" || !owner.attributes?.length) continue;
      if (owner !== decl && (decl.isInterface || decl.isEnum) && own.has(decl.span.file)) {
        const at = cover(owner.attributes[0]!.span, owner.attributes.at(-1)!.span);
        diags.error("X0834", `attributes can't be used on ${decl.isEnum ? "an enum" : "an interface"} member`, at, "not allowed here")
          .note("attributes can be used on classes, methods and fields");
        continue;
      }
      const a = owner.attributes.find((x) => result.typeResolutions.get(x.name)?.qname === "xenon.Deprecated");
      if (!a) continue;
      const first = a.args[0];
      const message = first?.kind === "String" ? first.value : "";
      deprecated.set(owner === decl ? info : owner, { message, span: owner.span, mark: a.span });
    }
  }
  if (deprecated.size === 0) return;

  const reported = new Set<string>();
  const warn = (at: Span, what: string, found: { message: string; span: Span; mark: Span }) => {
    if (!own.has(at.file)) return;
    // Inside the deprecated declaration itself (its own recursion, its attributes): no warning.
    if (at.file === found.span.file && at.start >= found.span.start && at.end <= found.span.end) return;
    const key = `${at.file.path}:${at.start}`;
    if (reported.has(key)) return;
    reported.add(key);
    const d = diags.warning("X0873", `${what} is deprecated${found.message ? `: ${found.message}` : ""}`, at, "deprecated");
    d.secondary(found.mark, "marked here");
  };
  const member = (m: MemberSig | undefined, at: Span) => {
    const found = m && deprecated.get(m.decl);
    if (m && found) warn(at, `\`${m.owner.decl.name.name}.${m.name}\``, found);
  };
  const cls = (info: ClassInfo | undefined, at: Span) => {
    const found = info && deprecated.get(info);
    if (info && found) warn(at, `\`${info.decl.name.name}\``, found);
  };
  for (const [node, info] of result.typeResolutions) cls(info, node.span);
  for (const e of result.exprTypes.keys()) {
    if (e.kind === "Member") {
      const t = result.exprTypes.get(e.object);
      const obj = t && nonNull(t);
      if (obj?.kind === "class" || obj?.kind === "classRef") member(findMember(obj.info, e.name.name), e.name.span);
    } else if (e.kind === "Ident") {
      const r = result.resolutions.get(e);
      if (r?.kind === "member") member(findMember(r.owner, e.name), e.span);
      else if (r?.kind === "class") cls(r.info, e.span);
    }
  }
}
