/**
 * The language service behind `xenon lsp`, independent of the protocol: diagnostics, hover,
 * go-to-definition and completion for a project held in memory (open editors override the disk).
 *
 * Xenon's own checker answers first (types are shown as Xenon spells them: `int`, not `number`).
 * TypeScript runs over the virtual `.ts` files of the `ts` target and fills in where Xenon only
 * knows `*`: JavaScript and npm imports, whose `.d.ts` types TypeScript reads. Its errors are
 * reported too, mapped back through the token mappings.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import ts from "typescript";
import type * as A from "./ast.ts";
import { type ClassInfo, findMember, type MemberSig, type Resolution, visibilityOf } from "./checker.ts";
import { generatedOffsetAt, type Mapping, type OutputFile, sourceOffsetAt } from "./codegen.ts";
import { compileProject, type CompileResult, PRELUDE, type SourceInput } from "./compiler.ts";
import { KEYWORDS } from "./lexer.ts";
import { SourceFile, type Span } from "./source.ts";
import { isSubclass, memberTypeIn, type MethodType, stdClassOf, supertypes, type Type, typeToString } from "./types.ts";

/** Options of the virtual TypeScript project. Xenon references may be `null`: no strict null checks. */
export const TS_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ["lib.esnext.d.ts"],
  strict: false,
  noEmit: true,
  skipLibCheck: true,
  esModuleInterop: true,
};

/** 0-based line and UTF-16 column, as editors count. */
export interface Position {
  line: number;
  character: number;
}
export interface Range {
  start: Position;
  end: Position;
}
export interface Location {
  /** Absolute file path. */
  path: string;
  range: Range;
}

export interface ServiceDiagnostic {
  range: Range;
  severity: "error" | "warning" | "info";
  message: string;
  code?: string;
  source: "xenon" | "typescript";
  related: { location: Location; message: string }[];
}

export type CompletionKind = "field" | "method" | "property" | "class" | "interface" | "enum" | "variable" | "function" | "keyword" | "typedef" | "value";

export interface CompletionItem {
  label: string;
  kind: CompletionKind;
  /** The type or signature. */
  detail?: string;
  documentation?: string;
}

export interface Hover {
  /** Markdown: the signature in a code block, then the documentation. */
  contents: string;
  range: Range;
}

function rangeOf(file: SourceFile, start: number, end: number): Range {
  const pos = (offset: number): Position => {
    const { line, col } = file.position(offset);
    return { line: line - 1, character: col - 1 };
  };
  return { start: pos(start), end: pos(end) };
}

/** An AST node: anything with a span (statements, expressions, declarations, names, types). */
type Node = { span: Span; kind?: string; [key: string]: any };

function isNode(v: unknown): v is Node {
  const s = (v as Node | null)?.span;
  return !!s && typeof s === "object" && typeof s.start === "number" && !(v instanceof SourceFile);
}

/** The nearest nodes below `v` (looking through arrays and plain objects without spans). */
function childNodes(v: unknown, out: Node[] = []): Node[] {
  if (!v || typeof v !== "object" || v instanceof SourceFile) return out;
  if (Array.isArray(v)) {
    for (const x of v) {
      if (isNode(x)) out.push(x);
      else childNodes(x, out);
    }
    return out;
  }
  for (const [k, x] of Object.entries(v)) {
    if (k === "span") continue;
    if (isNode(x)) out.push(x);
    else childNodes(x, out);
  }
  return out;
}

/** The nodes containing `offset`, outermost first. A cursor right after a name counts as on it. */
export function nodesAt(file: A.XenonFile, offset: number): Node[] {
  const chain: Node[] = [];
  let level: Node[] = childNodes([file.imports, file.decls, file.privateDecls, file.functions]);
  for (;;) {
    const inside = level.filter((n) => n.span.start <= offset && offset < n.span.end);
    const next = inside.at(-1) ?? level.find((n) => n.span.end === offset && n.span.start < offset);
    if (!next) return chain;
    chain.push(next);
    level = childNodes(next);
  }
}

/** The `/** … *\/` comment right before a declaration, without its stars. */
function docComment(file: SourceFile, start: number): string | undefined {
  const before = file.text.slice(0, start).trimEnd();
  if (!before.endsWith("*/")) return undefined;
  const open = before.lastIndexOf("/**");
  if (open < 0) return undefined;
  return before.slice(open + 3, -2).split("\n").map((l) => l.replace(/^\s*\* ?/, "")).join("\n").trim() || undefined;
}

function signature(t: MethodType, name: string): string {
  const tps = t.typeParams?.length ? `<${t.typeParams.map((p) => p.name).join(", ")}>` : "";
  const ps = t.params.map((p) => `${p.rest ? "..." : ""}${p.name}${p.optional ? "?" : ""}:${typeToString(p.type)}`);
  return `${name}${tps}(${ps.join(", ")}):${typeToString(t.ret)}`;
}

/** How a member reads in hovers and completion details. */
function memberText(m: MemberSig): string {
  const owner = m.owner.decl.name.name;
  const st = m.isStatic ? "static " : "";
  if (m.kind === "method" && m.type.kind === "method") return `${st}function ${owner}.${signature(m.type, m.name)}`;
  if (m.kind === "accessor") return `${st}function get ${owner}.${m.name}():${typeToString(m.type)}`;
  const kw = m.readonly === "const" ? "const" : m.readonly === "final" ? "final" : "var";
  return `${st}${kw} ${owner}.${m.name}:${typeToString(m.type)}`;
}

function classText(info: ClassInfo): string {
  const d = info.decl;
  const what = d.isInterface ? "interface" : d.isEnum ? "enum" : `${d.modifiers.abstract ? "abstract " : ""}class`;
  const tps = info.typeParams.length ? `<${info.typeParams.map((p) => p.name).join(", ")}>` : "";
  const ext = info.parent ? ` extends ${info.parent.decl.name.name}` : "";
  const impl = info.interfaces.length ? ` ${d.isInterface ? "extends" : "implements"} ${info.interfaces.map((i) => i.decl.name.name).join(", ")}` : "";
  return `${what} ${info.qname.replace(/^.*#/, "")}${tps}${ext}${impl}`;
}

function memberKind(m: MemberSig): CompletionKind {
  return m.kind === "method" ? "method" : m.kind === "accessor" ? "property" : "field";
}

interface Analysis {
  result: CompileResult;
  /** Outputs by source path (the `.xn` path relative to the source root). */
  outputs: Map<string, OutputFile>;
}

export class XenonProject {
  /** Source texts by path relative to the source root. */
  private sources = new Map<string, string>();
  private cached?: Analysis;
  private version = 0;
  /** Virtual TypeScript files: absolute path → text and version. */
  private virtual = new Map<string, { text: string; version: number }>();
  private tsService: ts.LanguageService;
  private libCache = new Map<string, ts.IScriptSnapshot | undefined>();

  constructor(
    /** Absolute path of the source root (`src`). */
    readonly srcRoot: string,
    readonly main = "Main",
    /** Where the virtual `.ts` files live (TypeScript resolves npm packages from there upwards). */
    readonly virtualRoot = join(dirname(srcRoot), ".xenon", "ts"),
  ) {
    const host: ts.LanguageServiceHost = {
      getCompilationSettings: () => TS_OPTIONS,
      getScriptFileNames: () => [...this.virtual.keys()],
      getScriptVersion: (f) => String(this.virtual.get(f)?.version ?? 0),
      getScriptSnapshot: (f) => {
        const v = this.virtual.get(f);
        if (v) return ts.ScriptSnapshot.fromString(v.text);
        if (!this.libCache.has(f)) {
          const text = ts.sys.readFile(f);
          this.libCache.set(f, text === undefined ? undefined : ts.ScriptSnapshot.fromString(text));
        }
        return this.libCache.get(f);
      },
      getCurrentDirectory: () => dirname(srcRoot),
      getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
      fileExists: (f) => this.virtual.has(f) || ts.sys.fileExists(f),
      readFile: (f) => this.virtual.get(f)?.text ?? ts.sys.readFile(f),
      directoryExists: (d) => d === this.virtualRoot || [...this.virtual.keys()].some((f) => f.startsWith(d + "/")) || ts.sys.directoryExists(d),
      getDirectories: ts.sys.getDirectories,
    };
    this.tsService = ts.createLanguageService(host, ts.createDocumentRegistry());
  }

  /** Reads every `.xn` file below the source root (replacing what was set before). */
  async load() {
    const glob = new Bun.Glob("**/*.xn");
    for await (const p of glob.scan({ cwd: this.srcRoot })) {
      this.sources.set(p.split("\\").join("/"), await Bun.file(join(this.srcRoot, p)).text());
    }
    this.changed();
  }

  /** Sets a file's text (an open editor, or a file changed on disk). */
  set(path: string, text: string) {
    if (this.sources.get(path) === text) return;
    this.sources.set(path, text);
    this.changed();
  }

  remove(path: string) {
    if (this.sources.delete(path)) this.changed();
  }

  paths(): string[] {
    return [...this.sources.keys()].sort();
  }

  private changed() {
    this.cached = undefined;
  }

  /** Compiles the project as it is now (cached until something changes). */
  private analyze(): Analysis {
    if (this.cached) return this.cached;
    const inputs: SourceInput[] = [...this.sources].map(([path, text]) => ({ path, text }));
    this.cached = this.compile(inputs);
    // The virtual files TypeScript sees: new versions where the text changed.
    const now = new Set<string>();
    for (const o of this.cached.result.outputs) {
      const path = join(this.virtualRoot, o.path);
      now.add(path);
      const v = this.virtual.get(path);
      if (v?.text !== o.text) this.virtual.set(path, { text: o.text, version: ++this.version });
    }
    for (const path of this.virtual.keys()) if (!now.has(path)) this.virtual.delete(path);
    return this.cached;
  }

  private compile(inputs: SourceInput[]): Analysis {
    const result = compileProject(inputs, { main: this.main, target: "ts", tolerant: true });
    const outputs = new Map<string, OutputFile>();
    for (const o of result.outputs) if (o.source) outputs.set(o.source.path, o);
    return { result, outputs };
  }

  private astOf(a: Analysis, path: string): A.XenonFile | undefined {
    return a.result.asts.find((f) => f.file.path === path && !f.file.prelude);
  }

  /** Absolute path of a source file; the prelude's files are written to a cache directory to be opened. */
  private pathOf(file: SourceFile): string {
    if (!file.prelude) return join(this.srcRoot, file.path);
    const dir = join(tmpdir(), `xenon-prelude-${Bun.hash(PRELUDE.map((p) => p.text).join("\0")).toString(36)}`);
    const path = join(dir, file.path);
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, file.text);
    } catch {
      // read-only temp directory: the location is still reported
    }
    return path;
  }

  private location(span: Span): Location {
    return { path: this.pathOf(span.file), range: rangeOf(span.file, span.start, span.end) };
  }

  // ---- diagnostics ----

  /** Diagnostics of every source file (files without any get an empty list). */
  diagnostics(): Map<string, ServiceDiagnostic[]> {
    const a = this.analyze();
    const out = new Map<string, ServiceDiagnostic[]>(this.paths().map((p) => [p, []]));
    const xenonSpans = new Map<string, { start: number; end: number }[]>();
    for (const d of a.result.diagnostics.items) {
      const primary = d.labels.find((l) => l.primary) ?? d.labels[0];
      if (!primary || primary.span.file.prelude) continue;
      const path = primary.span.file.path;
      const extra = [...(primary.message ? [primary.message] : []), ...d.notes.map((n) => `note: ${n}`), ...d.help.map((h) => `help: ${h.message}`)];
      out.get(path)?.push({
        range: rangeOf(primary.span.file, primary.span.start, primary.span.end),
        severity: d.severity === "note" ? "info" : d.severity,
        message: [d.message, ...extra].join("\n"),
        code: d.code,
        source: "xenon",
        related: d.labels.filter((l) => l !== primary && l.message).map((l) => ({ location: this.location(l.span), message: l.message! })),
      });
      if (d.severity === "error") xenonSpans.set(path, [...(xenonSpans.get(path) ?? []), primary.span]);
    }
    for (const [path, o] of a.outputs) {
      if (o.source!.prelude || !out.has(path)) continue;
      const file = join(this.virtualRoot, o.path);
      const tsDiags = [...this.tsService.getSyntacticDiagnostics(file), ...this.tsService.getSemanticDiagnostics(file)];
      for (const d of tsDiags) {
        if (d.start === undefined || d.category !== ts.DiagnosticCategory.Error) continue;
        const range = this.mapBack(o, d.start, d.length ?? 0);
        if (!range) continue; // generated glue, not the user's code
        // Xenon already reported an error here: its message is the better one.
        if (xenonSpans.get(path)?.some((s) => s.start < range.end && range.start < s.end)) continue;
        out.get(path)!.push({
          range: rangeOf(o.source!, range.start, range.end),
          severity: "error",
          message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
          code: `TS${d.code}`,
          source: "typescript",
          related: [],
        });
      }
    }
    return out;
  }

  /** A generated range as a source range (by the tokens at its ends). */
  private mapBack(o: OutputFile, start: number, length: number): { start: number; end: number } | undefined {
    const s = sourceOffsetAt(o.mappings!, start);
    if (s === undefined) return undefined;
    const e = length > 0 ? sourceOffsetAt(o.mappings!, start + length - 1) : undefined;
    return { start: s, end: e !== undefined && e >= s ? e + 1 : s + Math.max(1, length) };
  }

  // ---- hover ----

  hover(path: string, offset: number): Hover | undefined {
    const a = this.analyze();
    const ast = this.astOf(a, path);
    if (!ast) return undefined;
    const chain = nodesAt(ast, offset);
    const info = this.describe(a, chain);
    if (info) {
      const contents = "```xenon\n" + info.text + "\n```" + (info.doc ? `\n\n${info.doc}` : "");
      return { contents, range: rangeOf(ast.file, info.span.start, info.span.end) };
    }
    // Xenon only knows `*` here: ask TypeScript (npm and node imports carry `.d.ts` types).
    const o = a.outputs.get(path);
    const gen = o?.mappings && generatedOffsetAt(o.mappings, offset);
    if (o === undefined || gen === undefined) return undefined;
    const q = this.tsService.getQuickInfoAtPosition(join(this.virtualRoot, o.path), gen);
    if (!q) return undefined;
    const doc = ts.displayPartsToString(q.documentation);
    const span = this.mapBack(o, q.textSpan.start, q.textSpan.length) ?? { start: offset, end: offset };
    return {
      contents: "```typescript\n" + ts.displayPartsToString(q.displayParts) + "\n```" + (doc ? `\n\n${doc}` : ""),
      range: rangeOf(ast.file, span.start, span.end),
    };
  }

  /** What the innermost name at the cursor is, in Xenon terms, and where it's declared. */
  private describe(a: Analysis, chain: Node[]): { text: string; doc?: string; span: Span; decl?: Span } | undefined {
    const check = a.result.check;
    const node = chain.at(-1);
    const parent = chain.at(-2);
    if (!node) return undefined;
    const ofMember = (m: MemberSig, span: Span) => ({ text: memberText(m), doc: docComment(m.decl.span.file, m.decl.span.start), span, decl: m.decl.name.span });
    const ofClass = (info: ClassInfo, span: Span) => ({ text: classText(info), doc: docComment(info.decl.span.file, info.decl.span.start), span, decl: info.decl.name.span });

    // A name inside a larger node: `obj.name`, a declaration's name, a type name.
    if (!node.kind && parent) {
      if (parent.kind === "Member" && parent.name === node) {
        const m = this.memberOf(a, check.exprTypes.get(parent.object as A.Expr), (node as A.Ident).name);
        return m && ofMember(m, node.span);
      }
      if ((parent.kind === "Field" || parent.kind === "Method") && parent.name === node) {
        const owner = [...check.classes.values()].find((c) => c.decl.members.includes(parent as A.Member));
        const m = owner && (parent.kind === "Method" && (parent as A.Method).isConstructor ? undefined : owner.members.get((node as A.Ident).name));
        if (m) return ofMember(m, node.span);
        if (owner) return ofClass(owner, node.span);
      }
      if (parent.kind === "Class" && parent.name === node) {
        const info = [...check.classes.values()].find((c) => c.decl === parent);
        return info && ofClass(info, node.span);
      }
      if (parent.kind === "Typedef") {
        const t = check.typeNodeTypes.get((parent as A.TypedefDecl).type);
        return { text: `typedef ${(node as A.Ident).name} = ${t ? typeToString({ ...t, alias: undefined } as Type) : "?"}`, span: node.span, decl: node.span };
      }
      if (parent.kind === "TypeName") return this.describeType(a, parent as A.TypeNode, node.span);
      const declared = this.declaredType(a, parent, node as A.Ident);
      if (declared) return { text: `${(node as A.Ident).name}:${typeToString(declared)}`, span: node.span, decl: node.span };
      return undefined;
    }
    if (node.kind === "TypeName") return this.describeType(a, node as A.TypeNode, node.span);
    if (node.kind === "Ident") {
      const e = node as A.Expr & { kind: "Ident" };
      const r = check.resolutions.get(e) as Resolution | undefined;
      const t = check.exprTypes.get(e);
      switch (r?.kind) {
        case "local": return { text: `${e.name}:${t ? typeToString(t) : "?"}`, span: e.span, decl: r.decl };
        case "member": {
          const m = findMember(r.owner, e.name);
          return m && ofMember(m, e.span);
        }
        case "class": return ofClass(r.info, e.span);
        case "function": {
          const doc = docComment(r.decl.span.file, r.decl.span.start);
          return { text: t?.kind === "method" ? `function ${signature(t, e.name)}` : `function ${e.name}`, doc, span: e.span, decl: r.decl.name.span };
        }
        case "builtin": return { text: e.name === "trace" ? "function trace(...values:Array<*>):void" : `function ${e.name}(value:*):${e.name}`, span: e.span };
      }
    }
    return undefined;
  }

  /** The type a declaration gives its name: a parameter, local, loop or catch variable. */
  private declaredType(a: Analysis, decl: Node, name: A.Ident): Type | undefined {
    const check = a.result.check;
    const typeNode = (decl as { type?: A.TypeNode }).type;
    if (typeNode && (decl as { name?: unknown }).name === name) return check.typeNodeTypes.get(typeNode);
    if (decl.kind === "VarDecl" && (decl as A.Stmt & { kind: "VarDecl" }).init) return check.exprTypes.get((decl as A.Stmt & { kind: "VarDecl" }).init!);
    return undefined;
  }

  private describeType(a: Analysis, node: A.TypeNode, span: Span): { text: string; doc?: string; span: Span; decl?: Span } | undefined {
    const info = a.result.check.typeResolutions.get(node);
    if (info) return { text: classText(info), doc: docComment(info.decl.span.file, info.decl.span.start), span, decl: info.decl.name.span };
    const t = a.result.check.typeNodeTypes.get(node);
    if (!t) return undefined;
    const td = (t.kind === "shape" || t.kind === "method") ? t.typedef : undefined;
    if (td) return { text: `typedef ${td.decl.name.name} = ${typeToString({ ...t, alias: undefined } as Type)}`, doc: docComment(td.decl.span.file, td.decl.span.start), span, decl: td.decl.name.span };
    return { text: typeToString(t), span };
  }

  /** A member of a value of type `t` (instance members, or statics of a class reference). */
  private memberOf(a: Analysis, t: Type | undefined, name: string): MemberSig | undefined {
    return this.membersOf(a, t).find((m) => m.name === name);
  }

  /** The members of a value of type `t`, nearest declaration first, each name once. */
  private membersOf(a: Analysis, t: Type | undefined): MemberSig[] {
    if (!t) return [];
    if (t.kind === "nullable") return this.membersOf(a, t.inner);
    if (t.kind === "prim" || t.kind === "builtin") {
      const std = stdClassOf.fn?.(t);
      return std && std !== t ? this.membersOf(a, std) : [];
    }
    if (t.kind === "classRef") return this.collect([t.info], (m) => m.isStatic);
    if (t.kind === "class") {
      const root = a.result.check.classes.get("xenon.Object");
      const members = this.collect([t.info, ...(root && !t.info.decl.isEnum ? [root] : [])], (m) => !m.isStatic);
      // As seen on this value: `Map<String, int>.set(key:String, value:int)`.
      const args = t.args ?? [];
      return args.length ? members.map((m) => (isSubclass(t.info, m.owner) ? { ...m, type: memberTypeIn(t.info, args, m.owner, m.type) } : m)) : members;
    }
    if (t.kind === "method") {
      const fn = a.result.check.classes.get("xenon.Function");
      return fn ? this.collect([fn], (m) => !m.isStatic) : [];
    }
    return [];
  }

  private collect(classes: ClassInfo[], keep: (m: MemberSig) => boolean): MemberSig[] {
    const seen = new Map<string, MemberSig>();
    for (const c of classes) {
      for (const s of supertypes(c)) {
        for (const m of s.members.values()) if (keep(m) && !seen.has(m.name) && m.name !== "constructor") seen.set(m.name, m);
      }
    }
    return [...seen.values()];
  }

  // ---- go to definition ----

  definition(path: string, offset: number): Location[] {
    const a = this.analyze();
    const ast = this.astOf(a, path);
    if (!ast) return [];
    const info = this.describe(a, nodesAt(ast, offset));
    if (info?.decl) return [this.location(info.decl)];
    // TypeScript: into `.d.ts` files, or back into Xenon code through the mappings.
    const o = a.outputs.get(path);
    const gen = o?.mappings && generatedOffsetAt(o.mappings, offset);
    if (o === undefined || gen === undefined) return [];
    const defs = this.tsService.getDefinitionAtPosition(join(this.virtualRoot, o.path), gen) ?? [];
    return defs.flatMap((d) => {
      const target = [...a.outputs.values()].find((x) => join(this.virtualRoot, x.path) === d.fileName);
      if (target) {
        const r = this.mapBack(target, d.textSpan.start, d.textSpan.length);
        return r ? [this.location({ file: target.source!, start: r.start, end: r.end })] : [];
      }
      if (this.virtual.has(d.fileName)) return []; // generated code without a source position
      const sf = this.tsService.getProgram()?.getSourceFile(d.fileName);
      if (!sf) return [];
      const s = sf.getLineAndCharacterOfPosition(d.textSpan.start);
      const e = sf.getLineAndCharacterOfPosition(d.textSpan.start + d.textSpan.length);
      return [{ path: d.fileName, range: { start: s, end: e } }];
    });
  }

  // ---- completion ----

  completions(path: string, offset: number): CompletionItem[] {
    const text = this.sources.get(path);
    if (text === undefined) return [];
    let start = offset;
    while (start > 0 && /[\w$]/.test(text[start - 1]!)) start--;
    if (text[start - 1] === ".") return this.memberCompletions(path, text, start, offset);
    return this.scopeCompletions(path, offset);
  }

  /** After `obj.`: the members of `obj`'s type (TypeScript's members where Xenon only knows `*`). */
  private memberCompletions(path: string, text: string, nameStart: number, offset: number): CompletionItem[] {
    // `obj.` with no name yet doesn't parse: complete against a placeholder name.
    const PLACEHOLDER = "__xenon_complete";
    const patched = nameStart === offset ? text.slice(0, offset) + PLACEHOLDER + text.slice(offset) : text;
    const a = patched === text ? this.analyze() : this.compile([...this.sources].map(([p, t]) => ({ path: p, text: p === path ? patched : t })));
    const ast = this.astOf(a, path);
    if (!ast) return [];
    const member = nodesAt(ast, nameStart).findLast((n) => n.kind === "Member" && (n.name as A.Ident).span.start === nameStart) as (A.Expr & { kind: "Member" }) | undefined;
    if (!member) return [];
    const t = a.result.check.exprTypes.get(member.object);
    if (t && t.kind !== "any" && t.kind !== "error") {
      const enclosing = this.enclosingClass(a, ast, nameStart);
      return this.membersOf(a, t).filter((m) => this.visible(m, enclosing)).map((m) => ({
        label: m.name,
        kind: memberKind(m),
        detail: memberText(m),
        documentation: docComment(m.decl.span.file, m.decl.span.start),
      }));
    }
    // `*`: TypeScript may know the type (JavaScript imports).
    const o = a.outputs.get(path);
    const gen = o?.mappings && generatedOffsetAt(o.mappings, nameStart);
    if (!o || gen === undefined) return [];
    if (patched !== text) this.virtual.set(join(this.virtualRoot, o.path), { text: o.text, version: ++this.version });
    try {
      const list = this.tsService.getCompletionsAtPosition(join(this.virtualRoot, o.path), gen, {});
      return (list?.entries ?? []).filter((e) => e.name !== PLACEHOLDER).map((e) => ({ label: e.name, kind: tsKind(e.kind) }));
    } finally {
      if (patched !== text) this.cached = undefined; // restore the real virtual file on the next analysis
    }
  }

  private visible(m: MemberSig, from: ClassInfo | undefined): boolean {
    const v = visibilityOf(m.decl);
    if (v === "private") return from === m.owner;
    if (v === "protected") return !!from && isSubclass(from, m.owner);
    return true;
  }

  private enclosingClass(a: Analysis, ast: A.XenonFile, offset: number): ClassInfo | undefined {
    const decl = nodesAt(ast, offset).findLast((n) => n.kind === "Class");
    return decl && [...a.result.check.classes.values()].find((c) => c.decl === decl);
  }

  /** Anywhere else: locals and parameters in scope, the class's members, classes, functions and keywords. */
  private scopeCompletions(path: string, offset: number): CompletionItem[] {
    const a = this.analyze();
    const ast = this.astOf(a, path);
    if (!ast) return [];
    const check = a.result.check;
    const items = new Map<string, CompletionItem>();
    const add = (item: CompletionItem) => {
      if (!items.has(item.label)) items.set(item.label, item);
    };
    const chain = nodesAt(ast, offset);
    // Locals: declarations before the cursor in the enclosing blocks, and the enclosing functions' parameters.
    for (const node of [...chain].reverse()) {
      const declaredHere: { name: A.Ident; type?: Type }[] = [];
      if (node.kind === "Block" || node.kind === "SwitchCase") {
        for (const s of (node.body as A.Stmt[] | undefined) ?? []) {
          if (s.span.start >= offset) break;
          if (s.kind === "VarDecl") declaredHere.push({ name: s.name, type: s.type ? check.typeNodeTypes.get(s.type) : s.init && check.exprTypes.get(s.init) });
          if (s.kind === "FuncDecl" && s.fn.name) declaredHere.push({ name: s.fn.name });
        }
      }
      if (node.kind === "Method" || node.kind === "Function") {
        for (const p of (node.params as A.Param[])) declaredHere.push({ name: p.name, type: p.type && check.typeNodeTypes.get(p.type) });
      }
      const variable = (node as { variable?: { name: A.Ident; type?: A.TypeNode } }).variable;
      if (variable?.name) declaredHere.push({ name: variable.name, type: variable.type && check.typeNodeTypes.get(variable.type) });
      for (const d of declaredHere) add({ label: d.name.name, kind: "variable", detail: d.type && `${d.name.name}:${typeToString(d.type)}` });
    }
    const cls = this.enclosingClass(a, ast, offset);
    const method = chain.findLast((n) => n.kind === "Method") as A.Method | undefined;
    if (cls) {
      const inStatic = !!method?.modifiers.static;
      for (const m of this.collect([cls], (m) => !inStatic || m.isStatic)) {
        if (this.visible(m, cls)) add({ label: m.name, kind: memberKind(m), detail: memberText(m), documentation: docComment(m.decl.span.file, m.decl.span.start) });
      }
    }
    // Classes this file can name: its package, its imports, the prelude, its own file-private ones.
    const pkg = ast.packageName.map((n) => n.name).join(".");
    const imported = new Set(ast.imports.flatMap((i) => (i.kind === "JsImport" ? [] : [i.path.map((p) => p.name).join(".")])));
    for (const c of check.classes.values()) {
      const visibleHere = c.filePrivate ? c.file === ast : c.pkg === pkg || c.pkg === "xenon" || imported.has(c.qname) || imported.has(c.pkg);
      if (!visibleHere || c.decl.name.name.startsWith("__")) continue;
      add({ label: c.decl.name.name, kind: c.decl.isInterface ? "interface" : c.decl.isEnum ? "enum" : "class", detail: classText(c), documentation: docComment(c.decl.span.file, c.decl.span.start) });
    }
    for (const f of a.result.asts.filter((f) => f.file.prelude).flatMap((f) => f.functions)) {
      add({ label: f.name.name, kind: "function", documentation: docComment(f.span.file, f.span.start) });
    }
    for (const imp of ast.imports) {
      if (imp.kind !== "JsImport") continue;
      for (const n of [imp.defaultName, imp.namespace, ...imp.named.map((x) => x.alias ?? x.name)]) if (n) add({ label: n.name, kind: "value", detail: `import from '${imp.module}'` });
    }
    add({ label: "trace", kind: "function", detail: "function trace(...values:Array<*>):void" });
    for (const k of KEYWORDS) add({ label: k, kind: "keyword" });
    for (const t of ["int", "uint", "Float", "String", "Boolean"]) add({ label: t, kind: "class" });
    return [...items.values()];
  }
}

function tsKind(kind: string): CompletionKind {
  switch (kind) {
    case "method": return "method";
    case "property": case "getter": case "setter": return "property";
    case "function": case "local function": return "function";
    case "class": return "class";
    case "interface": return "interface";
    case "enum": return "enum";
    case "keyword": return "keyword";
    default: return "variable";
  }
}

/** Re-exported for the tests' TypeScript checks. */
export type { Mapping };
