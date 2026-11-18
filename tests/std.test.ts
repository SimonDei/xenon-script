/**
 * Conformance of the standard library declarations (src/prelude/std) with the JavaScript runtime:
 * every declared class and member must exist in Bun with the declared kind (method, property,
 * static, constructor), and zero-argument members of primitives must return the declared type.
 */
import { expect, test } from "bun:test";
import { basename, join } from "node:path";
import type * as A from "../src/ast.ts";
import { PRELUDE } from "../src/compiler.ts";
import { DiagnosticBag } from "../src/diagnostics.ts";
import { parseFile } from "../src/parser.ts";
import { SourceFile, spanText } from "../src/source.ts";

const stdDir = join(import.meta.dir, "..", "src", "prelude", "std");
const stdFiles = (await Array.fromAsync(new Bun.Glob("*.kl").scan({ cwd: stdDir }))).sort();

/** Sample values for running members of primitive classes. */
const SAMPLES: Record<string, unknown[]> = {
  Boolean: [true, false],
  Float: [0, 42, -7, 3.75, 1e21, -0.5e-7, NaN, Infinity],
  int: [0, 42, -7, 2147483647, -2147483648],
  uint: [0, 7, 4294967295],
  Array: [[3, 1, 2], ["b", "a"], []],
  String: ["", "abc", "Hello World", "  padded  ", "a-b"],
  Date: [new Date(0), new Date(1.7e12), new Date(2024, 1, 29, 12, 30, 15, 500)],
  // `next` lives on the concrete iterators, not on Iterator.prototype
  RegExp: [/ab+/gi, new RegExp('x', 'dy')],
  Iterator: [[1, 2, 3].values(), new Set([4, 5]).values(), new Map([[1, 2]]).keys()],
};

/** Does a runtime value match a declared (primitive) type name? Unknown types aren't checked. */
function matches(type: A.TypeNode | undefined, value: unknown): boolean {
  if (!type || type.kind !== "TypeName") return true;
  switch (type.name.map((n) => n.name).join(".")) {
    case "Boolean": case "Bool": return typeof value === "boolean";
    case "String": return typeof value === "string";
    case "Float": return typeof value === "number";
    case "int": case "Int": return Number.isInteger(value) && (value as number) === ((value as number) | 0);
    case "uint": case "UInt": return Number.isInteger(value) && (value as number) >= 0;
    default: return true;
  }
}

test("every std file is part of the prelude", () => {
  const loaded = new Set(PRELUDE.map((s) => basename(s.path)));
  for (const f of stdFiles) expect(loaded.has(f)).toBe(true);
});

for (const file of stdFiles) {
  test(`std/${file} matches the runtime`, async () => {
    const source = new SourceFile(`klass/${file}`, await Bun.file(join(stdDir, file)).text(), true);
    const diags = new DiagnosticBag();
    const ast = parseFile(source, diags);
    expect(diags.items).toEqual([]);
    const problems: string[] = [];

    for (const decl of [...ast.decls, ...ast.privateDecls]) {
      if (decl.kind !== "Class" || !decl.modifiers.native) continue;
      const jsName = decl.modifiers.nativeName ?? decl.name.name;
      const ctor = (globalThis as Record<string, unknown>)[jsName] as Record<string, unknown> | undefined;
      if (ctor == null) {
        problems.push(`${jsName}: no such global`);
        continue;
      }
      const proto = (ctor as { prototype?: Record<string, unknown> }).prototype ?? {};
      // Overloads share one JS function: compare its arity with the longest overload.
      const arity = new Map<string, number>();
      for (const m of decl.members) {
        if (m.kind !== "Method" || m.accessor || m.isConstructor) continue;
        const key = `${!!m.modifiers.static}:${m.name.name}`;
        const n = m.params.some((p) => p.rest) ? Infinity : m.params.length;
        arity.set(key, Math.max(arity.get(key) ?? 0, n));
      }
      for (const m of decl.members) {
        if (m.kind !== "Method" && m.kind !== "Field") continue;
        if (m.modifiers.inline) continue; // compile-time constant: no runtime counterpart (the checker folds and range-checks it)
        const name = m.name.name;
        const isStatic = !!m.modifiers.static;
        const where = `${decl.name.name}.${isStatic ? "" : "prototype."}${name}`;
        if (m.kind === "Method" && m.isConstructor) {
          if (m.modifiers.visibility?.value === "private") continue; // hidden: nothing to check
          if (typeof ctor !== "function") problems.push(`${decl.name.name}: constructor declared, but \`${jsName}\` is not a class`);
          continue;
        }
        const target = isStatic ? ctor : proto;
        const onSample = !isStatic && (SAMPLES[decl.name.name] ?? []).some((v) => name in Object(v));
        if (!(name in target) && !onSample) {
          problems.push(`${where}: missing at runtime`);
          continue;
        }
        if (m.kind === "Method" && !m.accessor) {
          const fn = target[name] ?? (SAMPLES[decl.name.name] ?? []).map((v) => (Object(v) as Record<string, unknown>)[name]).find((f) => f !== undefined);
          if (typeof fn !== "function") problems.push(`${where}: declared as a method, but is a ${typeof fn}`);
          else {
            const declared = arity.get(`${isStatic}:${name}`)!;
            if (fn.length > declared) {
              problems.push(`${where}: runtime takes ${fn.length} parameters, declared ${declared}`);
            }
          }
        } else if (isStatic && typeof target[name] === "function") {
          problems.push(`${where}: declared as a property, but is a method`);
        } else if (isStatic && m.kind === "Field" && !matches(m.type, target[name])) {
          problems.push(`${where}: is ${String(target[name])}, not a \`${spanText(m.type!.span)}\``);
        }

        // Run zero-argument members on sample values and compare with the declared type.
        const samples = isStatic ? [] : SAMPLES[decl.name.name] ?? [];
        const ret = m.kind === "Field" ? m.type : m.returnType;
        if (m.kind === "Method" && (m.accessor === "set" || m.params.some((p) => !p.init && !p.rest))) continue;
        for (const sample of samples) {
          const value = m.kind === "Method" && !m.accessor
            ? ((Object(sample) as Record<string, (this: unknown) => unknown>)[name] as (this: unknown) => unknown).call(sample)
            : (Object(sample) as Record<string, unknown>)[name];
          if (!matches(ret, value)) problems.push(`${where}: returned ${JSON.stringify(value)} for ${JSON.stringify(sample)}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
}
