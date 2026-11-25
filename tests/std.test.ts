/**
 * Conformance of the standard library declarations (src/prelude/std) with the JavaScript runtime:
 * every declared class and member must exist in Bun with the declared kind (method, property,
 * static, constructor), and zero-argument members of primitives must return the declared type.
 */
import { afterAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { join } from "node:path";
import type * as A from "../src/ast.ts";
import { PRELUDE } from "../src/compiler.ts";
import { DiagnosticBag } from "../src/diagnostics.ts";
import { parseFile } from "../src/parser.ts";
import { SourceFile, spanText } from "../src/source.ts";
import { CONST_MARKED } from "../src/checker.ts";

const stdDir = join(import.meta.dir, "..", "src", "prelude", "std");
const stdFiles = [
  ...(await Array.fromAsync(new Bun.Glob("*.xn").scan({ cwd: stdDir }))).sort(),
  ...(await Array.fromAsync(new Bun.Glob("dom/*.xn").scan({ cwd: stdDir }))).map((f) => f.split("\\").join("/")).sort(),
];

/** The DOM (`std/dom`): Bun has none, so its classes are checked against happy-dom's. */
const dom = new Window();
afterAll(() => dom.happyDOM.close());

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
  Symbol: [Symbol("sample")],
  CSSStyleProperties: [dom.document.createElement("div").style],
  CharacterData: [dom.document.createTextNode("text")],
  // happy-dom keeps a FileReader's state in instance fields (browsers: prototype accessors).
  FileReader: [new dom.FileReader()],
};

/**
 * Bun's `length` differs from the standard here: `Response.prototype.clone.length` is 1, and Bun's
 * `Blob.prototype.stream` takes an optional chunk size; the standard's take no arguments.
 */
const ARITY_QUIRKS = new Set(["Response.prototype.clone", "Blob.prototype.stream"]);

/** Standard DOM members (every browser has them) that happy-dom doesn't implement. */
/** Browser classes happy-dom doesn't have at all (their members can't be compared). */
const HAPPY_DOM_MISSING_CLASSES = new Set(["ElementInternals"]);

const HAPPY_DOM_GAPS = new Set([
  "HTMLInputElement.prototype.dirName",
  "HTMLOptionElement.prototype.label",
  "HTMLOptionElement.prototype.defaultSelected",
  "HTMLSelectElement.prototype.size",
  "HTMLSelectElement.prototype.autocomplete",
  "HTMLSelectElement.prototype.namedItem",
  "HTMLSelectElement.prototype.showPicker",
  "HTMLTemplateElement.prototype.shadowRootMode",
  "HTMLTemplateElement.prototype.shadowRootClonable",
  "HTMLTemplateElement.prototype.shadowRootDelegatesFocus",
  "HTMLTemplateElement.prototype.shadowRootSerializable",
  "HTMLInputElement.prototype.capture",
  "HTMLInputElement.prototype.showPicker",
  "Node.prototype.lookupPrefix",
  "Node.prototype.lookupNamespaceURI",
  "Node.prototype.isDefaultNamespace",
  "Element.prototype.style", // `style` lives on HTMLElement/SVGElement, while Xenon's DOM uses Element.
  "TreeWalker.prototype.root",
  "TreeWalker.prototype.whatToShow",
  "TreeWalker.prototype.filter",
  "HTMLElement.prototype.accessKeyLabel",
  "HTMLElement.prototype.anchorElement",
  "HTMLElement.prototype.attributeStyleMap",
  "HTMLElement.prototype.autocapitalize",
  "HTMLElement.prototype.autocorrect",
  "HTMLElement.prototype.autofocus",
  "HTMLElement.prototype.containerTiming",
  "HTMLElement.prototype.containerTimingIgnore",
  "HTMLElement.prototype.draggable",
  "HTMLElement.prototype.editContext",
  "HTMLElement.prototype.enterKeyHint",
  "HTMLElement.prototype.inputMode",
  "HTMLElement.prototype.nonce",
  "HTMLElement.prototype.spellcheck",
  "HTMLElement.prototype.translate",
  "HTMLElement.prototype.virtualKeyboardPolicy",
  "HTMLElement.prototype.writingSuggestions",
  "HTMLElement.prototype.offsetParent",
  "HTMLElement.prototype.attachInternals",
  "HTMLElement.prototype.hidePopover",
  "HTMLElement.prototype.showPopover",
  "HTMLElement.prototype.togglePopover",
]);

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
  const loaded = new Set(PRELUDE.map((s) => s.path));
  for (const f of stdFiles) expect(loaded.has(`xenon/${f}`)).toBe(true);
});

for (const file of stdFiles) {
  test(`std/${file} matches the runtime`, async () => {
    const source = new SourceFile(`xenon/${file}`, await Bun.file(join(stdDir, file)).text(), true);
    const diags = new DiagnosticBag();
    const ast = parseFile(source, diags);
    expect(diags.items).toEqual([]);
    const problems: string[] = [];

    for (const decl of [...ast.decls, ...ast.privateDecls]) {
      if (decl.kind !== "Class" || !decl.modifiers.native) continue;
      const jsName = decl.modifiers.nativeName ?? decl.name.name;
      const runtime = file.startsWith("dom/") ? (dom as unknown as Record<string, unknown>) : (globalThis as Record<string, unknown>);
      // happy-dom has no global `DOMTokenList`: its class is the one of an element's `classList`.
      const hidden: Record<string, unknown> = { DOMTokenList: Object.getPrototypeOf(dom.document.createElement("div").classList).constructor };
      const ctor = (runtime[jsName] ?? (file.startsWith("dom/") ? hidden[jsName] : undefined)) as Record<string, unknown> | undefined;
      if (ctor == null) {
        if (file.startsWith("dom/") && HAPPY_DOM_MISSING_CLASSES.has(jsName)) continue;
        problems.push(`${jsName}: no such global`);
        continue;
      }
      const proto = (ctor as { prototype?: Record<PropertyKey, unknown> }).prototype ?? {};
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
        if (m.name.name === "operator[]") continue; // native indexing (`files[0]`): not a method
        const name = m.name.name;
        const wellKnown = /^\[Symbol\.([A-Za-z_$][\w$]*)\]$/.exec(name);
        const runtimeName: PropertyKey = wellKnown ? (Symbol as any)[wellKnown[1]!] as symbol : name;
        const isStatic = !!m.modifiers.static;
        const where = `${decl.name.name}.${isStatic ? "" : "prototype."}${name}`;
        if (m.kind === "Method" && m.isConstructor) {
          if (m.modifiers.visibility?.value === "private") continue; // hidden: nothing to check
          if (typeof ctor !== "function") problems.push(`${decl.name.name}: constructor declared, but \`${jsName}\` is not a class`);
          continue;
        }
        const target = (isStatic ? ctor : proto) as Record<PropertyKey, unknown>;
        const onSample = !isStatic && (SAMPLES[decl.name.name] ?? []).some((v) => runtimeName in Object(v));
        if (file.startsWith("dom/") && HAPPY_DOM_GAPS.has(where)) continue;
        // Browser CSS properties are engine-dependent; happy-dom exposes only a subset on its style object.
        if (decl.name.name === "CSSStyleProperties" && (m.kind === "Field" || (m.kind === "Method" && m.accessor)) && !onSample) continue;
        if (!(runtimeName in target) && !onSample) {
          problems.push(`${where}: missing at runtime`);
          continue;
        }
        if (m.kind === "Method" && !m.accessor) {
          const fn = target[runtimeName] ?? (SAMPLES[decl.name.name] ?? []).map((v) => (Object(v) as Record<PropertyKey, unknown>)[runtimeName]).find((f) => f !== undefined);
          if (typeof fn !== "function") problems.push(`${where}: declared as a method, but is a ${typeof fn}`);
          else {
            const declared = arity.get(`${isStatic}:${name}`)!;
            if (fn.length > declared && !ARITY_QUIRKS.has(where)) {
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
            ? ((Object(sample) as Record<PropertyKey, (this: unknown) => unknown>)[runtimeName] as (this: unknown) => unknown).call(sample)
            : (Object(sample) as Record<PropertyKey, unknown>)[runtimeName];
          if (!matches(ret, value)) problems.push(`${where}: returned ${JSON.stringify(value)} for ${JSON.stringify(sample)}`);
        }
      }
    }
    // Package-level functions: globals of that name, taking no more parameters than the longest overload.
    const fnArity = new Map<string, number>();
    for (const fn of ast.functions) {
      const jsName = fn.modifiers.nativeName ?? fn.name.name;
      fnArity.set(jsName, Math.max(fnArity.get(jsName) ?? 0, fn.params.some((p) => p.rest) ? Infinity : fn.params.length));
    }
    for (const [jsName, declared] of fnArity) {
      const fn = (jsName === "getComputedStyle" ? (dom as unknown as Record<string, unknown>) : (globalThis as Record<string, unknown>))[jsName];
      if (typeof fn !== "function") problems.push(`${jsName}: no such global function`);
      else if (fn.length > declared) problems.push(`${jsName}: runtime takes ${fn.length} parameters, declared ${declared}`);
    }
    expect(problems).toEqual([]);
  });
}

/**
 * `const` members of the standard library (classes in `CONST_MARKED`) must not change their
 * receiver: each one is called on a fresh sample, and the sample's observable state compared.
 * A member marked `const` without a call here fails, so new marks get checked too.
 */
const CONST_CHECKS: Record<string, { sample: () => any; state: (v: any) => unknown; calls: Record<string, (v: any) => unknown> }> = {
  Array: {
    sample: () => [3, 1, 2],
    state: (a) => [...a],
    calls: {
      slice: (a) => a.slice(1), concat: (a) => a.concat([4]), toReversed: (a) => a.toReversed(), toSorted: (a) => a.toSorted(),
      toSpliced: (a) => a.toSpliced(0, 1), with: (a) => a.with(0, 9), flat: (a) => a.flat(), at: (a) => a.at(0),
      indexOf: (a) => a.indexOf(1), lastIndexOf: (a) => a.lastIndexOf(1), includes: (a) => a.includes(2), join: (a) => a.join("-"),
      toString: (a: any) => a.toString(), forEach: (a) => a.forEach(() => {}), map: (a) => a.map((x: number) => x * 2),
      flatMap: (a) => a.flatMap((x: number) => [x]), filter: (a) => a.filter((x: number) => x > 1), some: (a) => a.some((x: number) => x > 2),
      every: (a) => a.every((x: number) => x > 0), find: (a) => a.find((x: number) => x > 1), findIndex: (a) => a.findIndex((x: number) => x > 1),
      findLast: (a) => a.findLast((x: number) => x > 1), findLastIndex: (a) => a.findLastIndex((x: number) => x > 1),
      reduce: (a) => a.reduce((s: number, x: number) => s + x), reduceRight: (a) => a.reduceRight((s: number, x: number) => s + x),
      keys: (a) => [...a.keys()], values: (a) => [...a.values()], entries: (a) => [...a.entries()],
    },
  },
  Map: {
    sample: () => new Map([["a", 1], ["b", 2]]),
    state: (m) => [...m],
    calls: { get: (m) => m.get("a"), has: (m) => m.has("a"), forEach: (m) => m.forEach(() => {}), keys: (m) => [...m.keys()], values: (m) => [...m.values()], entries: (m) => [...m.entries()] },
  },
  Set: {
    sample: () => new Set([1, 2]),
    state: (s) => [...s],
    calls: {
      has: (s) => s.has(1), forEach: (s) => s.forEach(() => {}), values: (s) => [...s.values()], keys: (s) => [...s.keys()], entries: (s) => [...s.entries()],
      union: (s) => s.union(new Set([3])), intersection: (s) => s.intersection(new Set([1])), difference: (s) => s.difference(new Set([1])),
      symmetricDifference: (s) => s.symmetricDifference(new Set([3])), isSubsetOf: (s) => s.isSubsetOf(new Set([1, 2, 3])),
      isSupersetOf: (s) => s.isSupersetOf(new Set([1])), isDisjointFrom: (s) => s.isDisjointFrom(new Set([5])),
    },
  },
  Date: {
    sample: () => new Date(2024, 1, 29, 12, 30, 15, 500),
    state: (d) => d.getTime(),
    calls: Object.fromEntries([
      "getFullYear", "getMonth", "getDate", "getDay", "getHours", "getMinutes", "getSeconds", "getMilliseconds", "getTime", "valueOf",
      "getTimezoneOffset", "getUTCFullYear", "getUTCMonth", "getUTCDate", "getUTCDay", "getUTCHours", "getUTCMinutes", "getUTCSeconds",
      "getUTCMilliseconds", "toISOString", "toJSON", "toString", "toDateString", "toTimeString", "toUTCString", "toLocaleString",
      "toLocaleDateString", "toLocaleTimeString",
    ].map((n) => [n, (d: any) => d[n]()])),
  },
  URLSearchParams: {
    sample: () => new URLSearchParams("b=2&a=1&a=3"),
    state: (p) => p.toString(),
    calls: {
      get: (p) => p.get("a"), getAll: (p) => p.getAll("a"), has: (p) => p.has("a"), toString: (p: any) => p.toString(), forEach: (p) => p.forEach(() => {}),
      keys: (p) => [...p.keys()], values: (p) => [...p.values()], entries: (p) => [...p.entries()],
    },
  },
  FormData: {
    sample: () => { const f = new FormData(); f.append("a", "1"); f.append("b", "2"); return f; },
    state: (f) => [...f.entries()],
    calls: {
      has: (f) => f.has("a"), get: (f) => f.get("a"), getAll: (f) => f.getAll("a"), forEach: (f) => f.forEach(() => {}),
      keys: (f) => [...f.keys()], values: (f) => [...f.values()], entries: (f) => [...f.entries()],
    },
  },
  RegExp: {
    sample: () => /a+/g,
    state: (r) => [r.source, r.flags, r.lastIndex],
    calls: { toString: (r: any) => r.toString() },
  },
  Promise: {
    sample: () => Promise.resolve(1),
    state: (p) => typeof p.then,
    calls: { then: (p) => p.then((x: number) => x), catch: (p) => p.catch(() => {}), finally: (p) => p.finally(() => {}) },
  },
  Blob: {
    sample: () => new Blob(["hello"], { type: "text/plain" }),
    state: (b) => [b.size, b.type],
    calls: { slice: (b) => b.slice(1), text: (b) => b.text(), arrayBuffer: (b) => b.arrayBuffer(), bytes: (b) => b.bytes(), stream: (b) => b.stream() },
  },
  ArrayBuffer: {
    sample: () => new Uint8Array([1, 2, 3]).buffer,
    state: (b) => [b.byteLength, b.detached, [...new Uint8Array(b)]],
    calls: { slice: (b) => b.slice(1) },
  },
  Object: {
    sample: () => ({ a: 1 }),
    state: (o) => JSON.stringify(o),
    calls: {
      toString: (o: any) => o.toString(), toLocaleString: (o: any) => o.toLocaleString(), valueOf: (o: any) => o.valueOf(), hasOwnProperty: (o) => o.hasOwnProperty("a"),
      isPrototypeOf: (o) => o.isPrototypeOf({}), propertyIsEnumerable: (o) => o.propertyIsEnumerable("a"),
    },
  },
};

test("`const` members of the standard library don't change their receiver", async () => {
  const problems: string[] = [];
  for (const qname of CONST_MARKED) {
    const name = qname.replace(/^xenon\./, "");
    const check = CONST_CHECKS[name];
    if (!check) {
      problems.push(`${name}: in CONST_MARKED, but no entry in CONST_CHECKS`);
      continue;
    }
    const source = new SourceFile(`xenon/${name}.xn`, await Bun.file(join(stdDir, `${name}.xn`)).text(), true);
    const ast = parseFile(source, new DiagnosticBag());
    const decl = ast.decls.find((d): d is A.ClassDecl => d.kind === "Class" && d.name.name === name)!;
    const marked = new Set(decl.members.filter((m): m is A.Method => m.kind === "Method" && m.isConst && !m.modifiers.static && !m.isConstructor).map((m) => m.name.name));
    for (const m of marked) if (!check.calls[m]) problems.push(`${name}.${m}: marked \`const\`, but not called here`);
    for (const m of Object.keys(check.calls)) if (!marked.has(m)) problems.push(`${name}.${m}: called here, but not marked \`const\``);
    for (const [m, call] of Object.entries(check.calls)) {
      const sample = check.sample();
      const before = JSON.stringify(check.state(sample));
      await call(sample);
      const after = JSON.stringify(check.state(sample));
      if (before !== after) problems.push(`${name}.${m}: changed its receiver (${before} → ${after})`);
    }
  }
  expect(problems).toEqual([]);
});
