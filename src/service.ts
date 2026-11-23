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
import { type CheckResult, type ClassInfo, findMember, isScoped, type TypedefInfo, type MemberSig, readDecl, type Resolution, visibilityOf } from "./checker.ts";
import { generatedOffsetAt, type Mapping, type OutputFile, sourceOffsetAt } from "./codegen.ts";
import { compileProject, type CompileResult, PRELUDE, type SourceInput } from "./compiler.ts";
import { defaultLibFilePath } from "./dts.ts";
import { CONTEXTUAL_KEYWORDS, KEYWORDS } from "./lexer.ts";
import { TYPED_GLOBALS } from "./globals.ts";
import { SourceFile, type Span, spanText } from "./source.ts";
import { isSubclass, memberTypeIn, nonNull, type MethodType, type ShapeMember, type ShapeType, stdClassOf, supertypes, type Type, typeToString } from "./types.ts";

/** Options of the virtual TypeScript project. Xenon references may be `null`: no strict null checks. */
export const TS_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  // The DOM too: `Element` & co. (std/dom) are the browser's classes.
  lib: ["lib.esnext.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
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
  fixes: Fix[];
}

export type CompletionKind = "field" | "method" | "property" | "class" | "interface" | "enum" | "variable" | "function" | "keyword" | "typedef" | "value" | "typeParameter" | "module";

export interface CompletionItem {
  label: string;
  kind: CompletionKind;
  /** The type or signature. */
  detail?: string;
  documentation?: string;
  /** The order in the list, where it isn't the label's (required shape members first). */
  sortText?: string;
}

export interface TextEdit {
  range: Range;
  newText: string;
}

/** A fix the checker suggests for a diagnostic (`help:` with edits): a quick fix in the editor. */
export interface Fix {
  title: string;
  /** Edits by absolute file path. */
  edits: { path: string; edits: TextEdit[] }[];
}

export interface WorkspaceEdit {
  /** Text edits by absolute file path. */
  changes: Map<string, TextEdit[]>;
  /** Files to rename (absolute paths), after the text edits: a public class lives in a file of its name. */
  renames: { from: string; to: string }[];
}

export interface SignatureHelp {
  signatures: { label: string; documentation?: string; parameters: { label: [number, number] }[] }[];
  activeSignature: number;
  activeParameter: number;
}

/** A name the grammar can't classify reliably, with its role from the parsed code (LSP semantic tokens). */
export interface SemanticToken {
  line: number;
  character: number;
  length: number;
  /** `property`: an object literal key (`{ method: 'POST' }`) or a member declared in a shape type (`{ to:String }`). */
  type: "property";
  modifiers: "declaration"[];
}

export type SymbolKind = "class" | "interface" | "enum" | "typedef" | "field" | "method" | "property" | "constructor" | "constant";

export interface DocumentSymbol {
  name: string;
  detail?: string;
  kind: SymbolKind;
  range: Range;
  selectionRange: Range;
  children: DocumentSymbol[];
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
    // The narrowest wins (the last among equals): a method's name lies inside its function's span.
    const next = inside.reduce<Node | undefined>((best, n) => (!best || n.span.end - n.span.start <= best.span.end - best.span.start ? n : best), undefined)
      ?? level.find((n) => n.span.end === offset && n.span.start < offset);
    if (!next) return chain;
    chain.push(next);
    level = childNodes(next);
  }
}

/** The `/** … *\/` comment right before a declaration, without its stars. */
function docComment(file: SourceFile, start: number): string | undefined {
  let before = file.text.slice(0, start).trimEnd();
  // A declaration with attributes starts at its first attribute's name, right after the `[`.
  if (before.endsWith("[")) before = before.slice(0, -1).trimEnd();
  // Attributes may sit between the comment and the declaration: `/** … */ [Route('/')] function …`.
  while (before.endsWith("]")) {
    let depth = 0;
    let i = before.length - 1;
    for (; i >= 0; i--) {
      if (before[i] === "]") depth++;
      else if (before[i] === "[" && --depth === 0) break;
    }
    if (i < 0) break;
    before = before.slice(0, i).trimEnd();
  }
  if (!before.endsWith("*/")) return undefined;
  const open = before.lastIndexOf("/**");
  if (open < 0) return undefined;
  return before.slice(open + 3, -2).split("\n").map((l) => l.replace(/^\s*\* ?/, "")).join("\n").trim() || undefined;
}

function signature(t: MethodType, name: string): string {
  const tps = t.typeParams?.length ? `<${t.typeParams.map((p) => `${p.variance === "invariant" ? "" : `${p.variance} `}${p.name}${p.constraint ? ` extends ${typeToString(p.constraint)}` : ""}`).join(", ")}>` : "";
  const ps = t.params.map((p) => `${p.rest ? "..." : ""}${p.name}${p.optional ? "?" : ""}:${typeToString(p.type)}`);
  return `${name}${tps}(${ps.join(", ")}):${typeToString(t.ret)}`;
}

/** How a member reads in hovers and completion details. */
function memberText(m: MemberSig): string {
  const owner = m.owner.decl.name.name;
  // A JavaScript module's export (`path.join`) isn't a static to the reader.
  const st = m.isStatic && !m.owner.file.file.generated ? "static " : "";
  // `constexpr` (the overload in `decl`, for a call that chose one) and `inline`, as declared.
  const decl = m.kind === "accessor" ? readDecl(m) : m.decl;
  const abstract = decl.kind === "Method" && decl.modifiers.abstract ? "abstract " : "";
  const final = decl.kind === "Method" && decl.modifiers.final ? "final " : "";
  const ce = decl.kind === "Method" && (decl.modifiers.consteval ? "consteval " : decl.modifiers.constexpr ? "constexpr " : "");
  if (m.kind === "method" && m.type.kind === "method") return `${st}${abstract}${final}${ce}function ${owner}.${signature(m.type, m.name)}`;
  if (m.kind === "accessor") return `${st}${abstract}${final}${ce}function get ${owner}.${m.name}():${typeToString(m.type)}`;
  const kw = m.readonly === "const" ? "const" : m.readonly === "final" ? "final" : "var";
  const inline = m.decl.modifiers.inline ? "inline " : "";
  return `${st}${inline}${kw} ${owner}.${m.name}:${typeToString(m.type)}`;
}

function classItem(c: ClassInfo): CompletionItem {
  return { label: c.decl.name.name, kind: c.decl.isInterface ? "interface" : c.decl.isEnum ? "enum" : "class", detail: classText(c), documentation: docComment(c.decl.span.file, c.decl.span.start) };
}

/** `typedef Column = { key:String, index:int, … }`, shortened to a line. */
function typedefText(td: TypedefInfo): string {
  const target = spanText(td.decl.type.span).replace(/\s+/g, " ").replace(/\{ /g, "{ ");
  const tps = td.params.length ? `<${td.params.map((p) => `${p.variance === "invariant" ? "" : `${p.variance} `}${p.name}${p.constraint ? ` extends ${typeToString(p.constraint)}` : ""}`).join(", ")}>` : "";
  const text = `typedef ${td.decl.name.name}${tps} = ${target}`;
  return text.length > 100 ? `${text.slice(0, 99)}…` : text;
}

function classText(info: ClassInfo): string {
  const d = info.decl;
  const modifiers = [
    d.modifiers.static ? "static" : "",
    d.modifiers.abstract ? "abstract" : "",
    d.modifiers.final ? "final" : "",
    // Not a keyword: a class with a destructor and no `implements IDisposable` (destroyed at scope end).
    !d.isInterface && isScoped(info) ? "scoped" : "",
  ].filter(Boolean).join(" ");
  const prefix = modifiers ? `${modifiers} ` : "";
  const what = d.isInterface ? `${prefix}interface` : d.isEnum ? `${prefix}enum` : `${prefix}class`;
  const tps = info.typeParams.length ? `<${info.typeParams.map((p) => `${p.variance === "invariant" ? "" : `${p.variance} `}${p.name}${p.constraint ? ` extends ${typeToString(p.constraint)}` : ""}${p.default ? ` = ${typeToString(p.default)}` : ""}`).join(", ")}>` : "";
  const ext = info.parent ? ` extends ${info.parent.decl.name.name}` : "";
  const impl = info.interfaces.length ? ` ${d.isInterface ? "extends" : "implements"} ${info.interfaces.map((i) => i.decl.name.name).join(", ")}` : "";
  return `${what} ${info.qname.replace(/^.*#/, "")}${tps}${ext}${impl}`;
}

/** A member of a shape, with its declaration in the typedef (for doc comments and go to definition). */
function shapeMember(shape: ShapeType, name: string): { member: ShapeMember; node?: A.ShapeMemberNode } | undefined {
  const member = shape.members.get(name);
  if (!member) return undefined;
  const target = shape.typedef?.decl.type;
  return { member, node: target?.kind === "ShapeType" ? target.members.find((n) => n.name.name === name) : undefined };
}

/** `?to:String`, `final id:int`: as written in a shape. */
function shapeMemberText(m: ShapeMember): string {
  return `${m.readonly ? "final " : ""}${m.optional ? "?" : ""}${m.name}:${typeToString(m.type())}`;
}

/** Completion inserts this name after a bare `obj.`, so the text parses. */
const PLACEHOLDER = "__xenon_complete";

/**
 * The expression before the dot ending at `nameStart` (`res`, `this.items[0]`, `load(x)?.data`):
 * names, member accesses and balanced `(…)`/`[…]`. Undefined if there is none.
 */
function receiverBefore(text: string, nameStart: number): { start: number } | undefined {
  let i = nameStart - 1; // the dot
  if (text[i] !== ".") return undefined;
  for (;;) {
    if (text[i - 1] === "?") i--; // `?.`
    let j = i;
    while (j > 0 && (text[j - 1] === ")" || text[j - 1] === "]")) {
      // A balanced group: a call's arguments or an index.
      let depth = 0;
      do {
        j--;
        if (text[j] === ")" || text[j] === "]") depth++;
        else if (text[j] === "(" || text[j] === "[") depth--;
      } while (j > 0 && depth > 0);
      if (depth > 0) return undefined;
    }
    while (j > 0 && /[\w$]/.test(text[j - 1]!)) j--;
    if (j === i) return undefined; // nothing before this dot
    // Not a member access: the end of a spread (`[...doc.`).
    if (text[j - 1] !== "." || text.slice(j - 3, j) === "...") return { start: j };
    i = j - 1; // continue with the dot before
  }
}

function memberKind(m: MemberSig): CompletionKind {
  return m.kind === "method" ? "method" : m.kind === "accessor" ? "property" : "field";
}

/** What a name refers to: its description for hovers, and its declaration. */
interface Sym {
  text: string;
  doc?: string;
  /** The name at the cursor. */
  span: Span;
  /** Where it's declared (undefined: built in). */
  decl?: Span;
  /** A class member: overrides of one another are the same symbol for references and rename. */
  member?: MemberSig;
  /** A class (or interface/enum): renaming it renames its file too. */
  info?: ClassInfo;
}

interface Analysis {
  result: CompileResult;
  /** Outputs by source path (the `.xn` path relative to the source root). */
  outputs: Map<string, OutputFile>;
}

/**
 * Shared by every project in the language server: the texts of library and `node_modules` files,
 * and TypeScript's parsed files (the DOM library, Node's types), which are the same for all of
 * them. Per project they cost 100–170 MB each; a workspace with many projects ran out of memory.
 */
const libCache = new Map<string, ts.IScriptSnapshot | undefined>();
const documentRegistry = ts.createDocumentRegistry();

export class XenonProject {
  /** Source texts by path relative to the source root. */
  private sources = new Map<string, string>();
  private cached?: Analysis;
  private version = 0;
  /** Virtual TypeScript files: absolute path → text and version. */
  private virtual = new Map<string, { text: string; version: number }>();
  private tsService: ts.LanguageService;

  constructor(
    /** Absolute path of the source root (`src`). */
    readonly srcRoot: string,
    readonly main = "Main",
    /** Where the virtual `.ts` files live (TypeScript resolves npm packages from there upwards). */
    readonly virtualRoot = join(dirname(srcRoot), ".xenon", "ts"),
    /** The project's compiler settings from `xenon.json` (`nullSafety`, on unless `false`). */
    readonly settings: { nullSafety?: boolean } = {},
  ) {
    const host: ts.LanguageServiceHost = {
      getCompilationSettings: () => TS_OPTIONS,
      getScriptFileNames: () => [...this.virtual.keys()],
      getScriptVersion: (f) => String(this.virtual.get(f)?.version ?? 0),
      getScriptSnapshot: (f) => {
        const v = this.virtual.get(f);
        if (v) return ts.ScriptSnapshot.fromString(v.text);
        if (!libCache.has(f)) {
          const text = ts.sys.readFile(f);
          libCache.set(f, text === undefined ? undefined : ts.ScriptSnapshot.fromString(text));
        }
        return libCache.get(f);
      },
      getCurrentDirectory: () => dirname(srcRoot),
      getDefaultLibFileName: (o) => defaultLibFilePath(ts, o),
      fileExists: (f) => this.virtual.has(f) || ts.sys.fileExists(f),
      readFile: (f) => this.virtual.get(f)?.text ?? ts.sys.readFile(f),
      directoryExists: (d) => d === this.virtualRoot || [...this.virtual.keys()].some((f) => f.startsWith(d + "/")) || ts.sys.directoryExists(d),
      getDirectories: ts.sys.getDirectories,
    };
    this.tsService = ts.createLanguageService(host, documentRegistry);
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
    const result = compileProject(inputs, { main: this.main, target: "ts", tolerant: true, typeRoot: this.srcRoot, nullSafety: this.settings.nullSafety });
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
        fixes: d.help.flatMap((h) => {
          const edits = (h.edits ?? []).filter((e) => !e.span.file.prelude);
          if (edits.length === 0) return [];
          const byFile = new Map<SourceFile, TextEdit[]>();
          for (const e of edits) byFile.set(e.span.file, [...(byFile.get(e.span.file) ?? []), { range: rangeOf(e.span.file, e.span.start, e.span.end), newText: e.text }]);
          return [{ title: h.message.replace(/`/g, ""), edits: [...byFile].map(([f, es]) => ({ path: this.pathOf(f), edits: es })) }];
        }),
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
        // Xenon already reported an error in this statement (or here): its message is the better one.
        const file = o.source!;
        const lines = (s: { start: number; end: number }) => [file.lineOf(s.start), file.lineOf(Math.max(s.start, s.end - 1))] as const;
        const [from, to] = lines(range);
        if (xenonSpans.get(path)?.some((s) => {
          const [a, b] = lines(s);
          return a <= to && from <= b;
        })) continue;
        out.get(path)!.push({
          range: rangeOf(o.source!, range.start, range.end),
          severity: "error",
          message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
          code: `TS${d.code}`,
          source: "typescript",
          related: [],
          fixes: [],
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
  private describe(a: Analysis, chain: Node[]): Sym | undefined {
    const check = a.result.check;
    const node = chain.at(-1);
    const parent = chain.at(-2);
    if (!node) return undefined;
    // `[Deprecated('…')]` shows in the documentation.
    const withDeprecation = (doc: string | undefined, attrs: A.Attribute[] | undefined) => {
      const a = attrs?.find((x) => check.typeResolutions.get(x.name)?.qname === "xenon.Deprecated");
      if (!a) return doc;
      const message = a.args[0]?.kind === "String" ? `: ${a.args[0].value}` : "";
      return `**Deprecated**${message}${doc ? `\n\n${doc}` : ""}`;
    };
    const ofMember = (m: MemberSig, span: Span): Sym => ({ text: memberText(m), doc: withDeprecation(docComment(m.decl.span.file, m.decl.span.start), m.decl.attributes), span, decl: m.decl.name.span, member: m });
    const ofClass = (info: ClassInfo, span: Span): Sym => ({ text: classText(info), doc: withDeprecation(docComment(info.decl.span.file, info.decl.span.start), info.decl.attributes), span, decl: info.decl.name.span, info });

    // A name inside a larger node: `obj.name`, a declaration's name, a type name.
    if (!node.kind && parent) {
      if (parent.kind === "Member" && parent.name === node) {
        const objType = check.exprTypes.get(parent.object as A.Expr);
        const shape = objType?.kind === "nullable" ? objType.inner : objType;
        if (shape?.kind === "shape") {
          // A shape's member: described as declared, with its typedef's doc comment (go to definition: the member).
          const s = shapeMember(shape, (node as A.Ident).name);
          if (!s) return undefined;
          const owner = shape.typedef ? `${shape.typedef.decl.name.name}.` : "";
          return { text: `${owner}${shapeMemberText(s.member)}`, doc: s.node && docComment(s.node.span.file, s.node.span.start), span: node.span, decl: s.node?.name.span };
        }
        const m = this.memberOf(a, objType, (node as A.Ident).name);
        // A call of an overloaded method: the overload it chose, as called (`append(name, value:Blob, fileName)`).
        const pick = check.overloadPicks.get(parent as A.Expr)?.chosen;
        if (m && pick) return { ...ofMember({ ...m, decl: pick.decl, type: pick.type }, node.span), doc: this.overloadDoc(check, parent as A.Expr, pick.decl), decl: pick.decl.name.span };
        return m && ofMember(m, node.span);
      }
      if (parent.kind === "PropertyReference" && parent.name === node) {
        const m = check.propertyReferences.get(parent as A.Expr & { kind: "PropertyReference" });
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
      // `com.zoo.Animal`: the last part names the type.
      if (parent.kind === "TypeName") return (parent as A.TypeNode & { kind: "TypeName" }).name.at(-1) === node ? this.describeType(a, parent as A.TypeNode, node.span) : undefined;
      if (parent.kind === "XenonImport") {
        const imp = parent as A.XenonImport;
        const info = imp.path.at(-1) === node && !imp.wildcard ? check.classes.get(imp.path.map((p) => p.name).join(".")) : undefined;
        return info && ofClass(info, node.span);
      }
      // `{ excelRow: 1 }` / `{ data }` in a literal checked against a shape: the shape's member.
      const isKey = (parent.kind === "Prop" || parent.kind === "Accessor") && (parent as A.ObjectProp & { kind: "Prop" | "Accessor" }).key === node;
      if (isKey || parent.kind === "Shorthand") {
        const literal = chain.findLast((n) => n.kind === "Object");
        const t = literal?.kind === "Object" ? check.exprTypes.get(literal as A.Expr) : undefined;
        const shape = t?.kind === "nullable" ? t.inner : t;
        const s = shape?.kind === "shape" ? shapeMember(shape, (node as A.Ident).name) : undefined;
        if (shape?.kind === "shape" && s) {
          const owner = shape.typedef ? `${shape.typedef.decl.name.name}.` : "";
          return { text: `${owner}${shapeMemberText(s.member)}`, doc: s.node && docComment(s.node.span.file, s.node.span.start), span: node.span, decl: s.node?.name.span };
        }
        if (isKey) return undefined;
      }
      // `{ name }`: the property is a variable or member in scope.
      if (parent.kind === "Shorthand") {
        const r = check.resolutions.get(parent as A.ObjectProp) as Resolution | undefined;
        if (r?.kind === "local") return { text: (node as A.Ident).name, span: node.span, decl: r.decl };
        if (r?.kind === "member") {
          const m = findMember(r.owner, (node as A.Ident).name);
          return m && ofMember(m, node.span);
        }
        return undefined;
      }
      // Any other declaration's name: a parameter, local, loop or catch variable, a destructured name.
      if (parent.name === node) {
        const declared = this.declaredType(a, parent, node as A.Ident);
        return { text: declared ? `${(node as A.Ident).name}:${typeToString(declared)}` : (node as A.Ident).name, span: node.span, decl: node.span };
      }
      return undefined;
    }
    if (node.kind === "TypeName") return this.describeType(a, node as A.TypeNode, (node as A.TypeNode & { kind: "TypeName" }).name.at(-1)!.span);
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
          // A call of an overloaded function (`fetch(url, options)`): the overload it chose.
          const pick = check.overloadPicks.get(e)?.chosen;
          if (pick) return { text: `function ${signature(pick.type, e.name)}`, doc: this.overloadDoc(check, e, pick.decl), span: e.span, decl: pick.decl.name.span };
          const doc = docComment(r.decl.span.file, r.decl.span.start);
          return { text: t?.kind === "method" ? `function ${signature(t, e.name)}` : `function ${e.name}`, doc, span: e.span, decl: r.decl.name.span };
        }
        case "builtin": return { text: e.name === "trace" ? "function trace(...values:Array<*>):void" : `function ${e.name}(value:*):${e.name}`, span: e.span };
      }
    }
    return undefined;
  }

  /**
   * Names whose role only the parser knows: object literal keys (whatever the spacing:
   * `{a:1}` is an object, `x:int` an annotation) and the members of shape types. Editors paint
   * these over the grammar's colours.
   */
  semanticTokens(path: string): SemanticToken[] {
    const a = this.analyze();
    const ast = this.astOf(a, path);
    if (!ast) return [];
    const tokens: SemanticToken[] = [];
    const add = (name: A.Ident, modifiers: "declaration"[]) => {
      const { start } = rangeOf(ast.file, name.span.start, name.span.end);
      tokens.push({ line: start.line, character: start.character, length: name.span.end - name.span.start, type: "property", modifiers });
    };
    const visit = (n: Node) => {
      if (n.kind === "Prop") {
        // `function name() {…}` in a literal keeps the grammar's function colour (like its accessors); `name: …` is a property.
        const { key, method } = n as A.ObjectProp & { kind: "Prop" };
        if (!("kind" in key) && !method) add(key, []);
      } else if (n.kind === "ShapeType") {
        for (const m of (n as A.TypeNode & { kind: "ShapeType" }).members) add(m.name, ["declaration"]);
      }
      for (const c of childNodes(n)) visit(c);
    };
    for (const n of childNodes([ast.imports, ast.decls, ast.privateDecls, ast.functions])) visit(n);
    return tokens.sort((x, y) => x.line - y.line || x.character - y.character);
  }

  /** An overload's doc comment; one without its own shares the nearest one above it in its group. */
  private overloadDoc(check: CheckResult, callee: A.Expr, decl: A.Method): string | undefined {
    const group = check.overloadPicks.get(callee)?.all.map((o) => o.decl) ?? [decl];
    const before = group.slice(0, group.indexOf(decl) + 1).reverse();
    return before.map((d) => docComment(d.span.file, d.span.start)).find((d) => d);
  }

  /** The type a declaration gives its name: a parameter, local, loop or catch variable. */
  private declaredType(a: Analysis, decl: Node, name: A.Ident): Type | undefined {
    const check = a.result.check;
    const bound = check.bindingTypes.get(name);
    if (bound) return bound;
    const typeNode = (decl as { type?: A.TypeNode }).type;
    if (typeNode && (decl as { name?: unknown }).name === name) return check.typeNodeTypes.get(typeNode);
    if (decl.kind === "VarDecl" && (decl as A.Stmt & { kind: "VarDecl" }).init) return check.exprTypes.get((decl as A.Stmt & { kind: "VarDecl" }).init!);
    return undefined;
  }

  private describeType(a: Analysis, node: A.TypeNode, span: Span): Sym | undefined {
    const info = a.result.check.typeResolutions.get(node);
    if (info) return { text: classText(info), doc: docComment(info.decl.span.file, info.decl.span.start), span, decl: info.decl.name.span, info };
    const t = a.result.check.typeNodeTypes.get(node);
    if (!t) return undefined;
    const td = (t.kind === "shape" || t.kind === "method") ? t.typedef : undefined;
    if (td) return { text: `typedef ${td.decl.name.name} = ${typeToString({ ...t, alias: undefined } as Type)}`, doc: docComment(td.decl.span.file, td.decl.span.start), span, decl: td.decl.name.span };
    // A built-in type (`int`, `String`, `Array<T>`, `Tuple<…>`): the standard library declares it.
    const std = this.stdClassFor(a, nonNull(t));
    if (std) return { text: typeToString(t), doc: docComment(std.decl.span.file, std.decl.span.start), span, decl: std.decl.name.span };
    return { text: typeToString(t), span };
  }

  /** The standard library's declaration of a built-in type: `Int` → `Int.xn`, `Tuple<…>` → `Tuple.xn`. */
  private stdClassFor(a: Analysis, t: Type): ClassInfo | undefined {
    const name = t.kind === "prim" ? t.name : t.kind === "builtin" ? t.name : undefined;
    return name ? a.result.check.classes.get(`xenon.${name}`) : undefined;
  }

  /** A member of a value of type `t` (instance members, or statics of a class reference). */
  private memberOf(a: Analysis, t: Type | undefined, name: string): MemberSig | undefined {
    return this.membersOf(a, t).find((m) => m.name === name);
  }

  /** The members of a value of type `t`, nearest declaration first, each name once. */
  private membersOf(a: Analysis, t: Type | undefined): MemberSig[] {
    if (!t) return [];
    if (t.kind === "nullable") return this.membersOf(a, t.inner);
    // A union: the members every member type has (what `x.` may use without narrowing).
    if (t.kind === "union") {
      const [first, ...rest] = t.types.map((m) => this.membersOf(a, m));
      return (first ?? []).filter((m) => rest.every((r) => r.some((x) => x.name === m.name)));
    }
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
    // Declarations generated from a `.d.ts` aren't files to open: TypeScript finds the original.
    if (info?.decl && !info.decl.file.generated) return [this.location(info.decl)];
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

  // ---- references and rename ----

  /** The symbol of the name at the cursor. */
  private symbolAt(a: Analysis, path: string, offset: number): Sym | undefined {
    const ast = this.astOf(a, path);
    if (!ast) return undefined;
    const sym = this.describe(a, nodesAt(ast, offset));
    return sym?.decl ? sym : undefined;
  }

  /** The topmost declarations a member overrides or implements (itself, if it overrides nothing). */
  private roots(m: MemberSig): A.Member[] {
    if (m.isStatic) return [m.decl];
    const declaring = [...supertypes(m.owner)].flatMap((c) => {
      const other = c.members.get(m.name);
      return other && !other.isStatic ? [other] : [];
    });
    return declaring.filter((d) => !declaring.some((x) => x !== d && x.owner !== d.owner && isSubclass(d.owner, x.owner))).map((d) => d.decl);
  }

  private same(x: Sym, target: Sym, targetRoots: A.Member[] | undefined): boolean {
    if (x.member && targetRoots) return x.member.name === target.member!.name && this.roots(x.member).some((r) => targetRoots.includes(r));
    return !!x.decl && x.decl.file === target.decl!.file && x.decl.start === target.decl!.start;
  }

  /** Every name in the project's files that refers to `target`. */
  private occurrences(a: Analysis, target: Sym): { span: Span; shorthand: boolean }[] {
    const roots = target.member && this.roots(target.member);
    const found: { span: Span; shorthand: boolean }[] = [];
    const visit = (node: Node, parent: Node | undefined) => {
      if (!node.kind || node.kind === "Ident") {
        const sym = this.describe(a, parent ? [parent, node] : [node]);
        if (sym && this.same(sym, target, roots)) found.push({ span: sym.span, shorthand: parent?.kind === "Shorthand" });
      }
      for (const child of childNodes(node)) visit(child, node);
    };
    for (const ast of a.result.asts) {
      if (ast.file.prelude || ast.file.generated) continue;
      for (const n of childNodes([ast.imports, ast.decls, ast.privateDecls])) visit(n, undefined);
    }
    return found;
  }

  /** Where the symbol at the cursor is used (with its declaration when `includeDeclaration`). */
  references(path: string, offset: number, includeDeclaration = true): Location[] {
    const a = this.analyze();
    const target = this.symbolAt(a, path, offset);
    if (!target) return [];
    const isDecl = (s: Span) => s.file === target.decl!.file && s.start === target.decl!.start;
    return this.occurrences(a, target).filter((o) => includeDeclaration || !isDecl(o.span)).map((o) => this.location(o.span));
  }

  /** Can the name at the cursor be renamed? Its range and text, or why not. */
  prepareRename(path: string, offset: number): { range: Range; placeholder: string } | { error: string } {
    const a = this.analyze();
    const target = this.symbolAt(a, path, offset);
    if (!target) return { error: "This isn't something that can be renamed." };
    const builtIn = target.decl!.file.prelude || (target.member && this.roots(target.member).some((r) => r.span.file.prelude));
    if (builtIn) return { error: `\`${spanText(target.span)}\` is part of the standard library.` };
    const external = target.decl!.file.generated || (target.member && this.roots(target.member).some((r) => r.span.file.generated));
    if (external) return { error: `\`${spanText(target.span)}\` is declared by a JavaScript module.` };
    return { range: rangeOf(target.span.file, target.span.start, target.span.end), placeholder: spanText(target.span) };
  }

  rename(path: string, offset: number, newName: string): WorkspaceEdit | { error: string } {
    const ok = this.prepareRename(path, offset);
    if ("error" in ok) return ok;
    if (!/^[A-Za-z_$][\w$]*$/.test(newName) || KEYWORDS.has(newName)) return { error: `\`${newName}\` isn't a valid name.` };
    const a = this.analyze();
    const target = this.symbolAt(a, path, offset)!;
    const old = spanText(target.span);
    const changes = new Map<string, TextEdit[]>();
    for (const o of this.occurrences(a, target)) {
      const file = this.pathOf(o.span.file);
      // `{ name }` keeps its property name: `{ name: renamed }`.
      const newText = o.shorthand ? `${old}: ${newName}` : newName;
      changes.set(file, [...(changes.get(file) ?? []), { range: rangeOf(o.span.file, o.span.start, o.span.end), newText }]);
    }
    // A class declared in the package block lives in a file named after it.
    const renames: WorkspaceEdit["renames"] = [];
    const info = target.info;
    if (info && !info.filePrivate && info.file.file.path.replace(/^.*\//, "") === `${old}.xn`) {
      const from = this.pathOf(info.file.file);
      renames.push({ from, to: join(dirname(from), `${newName}.xn`) });
    }
    return { changes, renames };
  }

  // ---- signature help ----

  /** Inside a call's parentheses: the callee's signatures and the parameter at the cursor. */
  signatureHelp(path: string, offset: number): SignatureHelp | undefined {
    const text = this.sources.get(path);
    if (text === undefined) return undefined;
    // `f(1, ` with nothing after the comma yet doesn't parse: fill in a placeholder argument.
    const before = text.slice(0, offset).trimEnd();
    const filled = before.endsWith(",") ? text.slice(0, offset) + "null" + text.slice(offset) : text;
    // If the statement doesn't parse yet (`if (f(x, ))` with no body so far), the parser drops it:
    // try again with an empty body at the end of the line.
    const lineEnd = filled.indexOf("\n", offset) < 0 ? filled.length : filled.indexOf("\n", offset);
    let found: { a: Analysis; patched: string; ast: A.XenonFile; call: A.Expr & { kind: "Call" | "New" } } | undefined;
    for (const patched of [filled, filled.slice(0, lineEnd) + " {}" + filled.slice(lineEnd)]) {
      const a = patched === text ? this.analyze() : this.compile([...this.sources].map(([p, t]) => ({ path: p, text: p === path ? patched : t })));
      const ast = this.astOf(a, path);
      const call = ast && (nodesAt(ast, offset).findLast((n) => {
        if (n.kind !== "Call" && n.kind !== "New") return false;
        const open = patched.indexOf("(", (n.callee as Node).span.end);
        return open >= 0 && open < offset && offset < n.span.end;
      }) as (A.Expr & { kind: "Call" | "New" }) | undefined);
      if (ast && call) {
        found = { a, patched, ast, call };
        break;
      }
    }
    if (!found) return undefined;
    const { a, patched, call } = found;
    const open = patched.indexOf("(", call.callee.span.end);
    const active = commasBefore(patched, open + 1, offset);
    const signatures = this.signaturesOf(a, call);
    if (signatures.length === 0) return this.tsSignatureHelp(a, path, call, active);
    // The overload the checker chose, else the first with enough parameters.
    const chosen = signatures.findIndex((s) => s.chosen);
    const fits = chosen >= 0 ? chosen : signatures.findIndex((s) => s.parameters.length > active || s.rest);
    return {
      signatures: signatures.map((s) => ({ label: s.label, documentation: s.documentation, parameters: s.parameters })),
      activeSignature: Math.max(0, fits),
      activeParameter: Math.min(active, Math.max(0, (signatures[Math.max(0, fits)]?.parameters.length ?? 1) - 1)),
    };
  }

  /** A callee Xenon only knows as `*` (a JavaScript import): TypeScript's signatures. */
  private tsSignatureHelp(a: Analysis, path: string, call: A.Expr & { kind: "Call" | "New" }, active: number): SignatureHelp | undefined {
    const o = a.outputs.get(path);
    // Just inside the generated call's parentheses: after the callee's last token, past the `(`.
    const last = o?.mappings && generatedOffsetAt(o.mappings, call.callee.span.end - 1);
    if (!o || last === undefined) return undefined;
    const at = o.text.indexOf("(", last) + 1;
    if (at <= 0) return undefined;
    const file = join(this.virtualRoot, o.path);
    // A patched analysis (placeholder argument): TypeScript sees it until the next analysis restores the file.
    if (this.virtual.get(file)?.text !== o.text) {
      this.virtual.set(file, { text: o.text, version: ++this.version });
      this.cached = undefined;
    }
    const help = this.tsService.getSignatureHelpItems(file, at, undefined);
    if (!help) return undefined;
    const text = (parts: ts.SymbolDisplayPart[]) => ts.displayPartsToString(parts);
    const signatures = help.items.map((item) => {
      let label = text(item.prefixDisplayParts);
      const parameters: { label: [number, number] }[] = [];
      item.parameters.forEach((p, i) => {
        if (i > 0) label += text(item.separatorDisplayParts);
        const t = text(p.displayParts);
        parameters.push({ label: [label.length, label.length + t.length] });
        label += t;
      });
      label += text(item.suffixDisplayParts);
      const doc = text(item.documentation);
      return { label, parameters, ...(doc ? { documentation: doc } : {}), rest: item.isVariadic };
    });
    const fits = signatures.findIndex((s) => s.parameters.length > active || s.rest);
    const chosen = fits >= 0 ? fits : help.selectedItemIndex;
    return {
      signatures: signatures.map(({ rest: _, ...s }) => s),
      activeSignature: chosen,
      activeParameter: Math.min(active, Math.max(0, (signatures[chosen]?.parameters.length ?? 1) - 1)),
    };
  }

  private signaturesOf(a: Analysis, call: A.Expr & { kind: "Call" | "New" }): { label: string; documentation?: string; parameters: { label: [number, number] }[]; rest: boolean; chosen?: boolean }[] {
    const check = a.result.check;
    const make = (name: string, t: MethodType, doc?: string) => {
      let label = `${name}(`;
      const parameters: { label: [number, number] }[] = [];
      t.params.forEach((p, i) => {
        if (i > 0) label += ", ";
        const text = `${p.rest ? "..." : ""}${p.name}${p.optional ? "?" : ""}:${typeToString(p.type)}`;
        parameters.push({ label: [label.length, label.length + text.length] });
        label += text;
      });
      label += `):${typeToString(t.ret)}`;
      return { label, documentation: doc, parameters, rest: t.params.at(-1)?.rest ?? false };
    };
    if (call.kind === "New") {
      const info = check.typeResolutions.get(call.callee);
      if (!info) return [];
      const ctors = info.ctorOverloads ?? (info.ctor ? [info.ctor] : []);
      const doc = (d: A.Method) => docComment(d.span.file, d.span.start);
      return ctors.length ? ctors.map((c) => make(`new ${info.decl.name.name}`, c.type, doc(c.decl))) : [make(`new ${info.decl.name.name}`, { kind: "method", params: [], ret: { kind: "void" } })];
    }
    const callee = call.callee;
    const name = callee.kind === "Member" ? callee.name.name : callee.kind === "Ident" ? callee.name : "function";
    // Overloads (standard library methods and functions): each as its own signature, as seen on this receiver.
    const set = check.overloadPicks.get(callee);
    if (set) return set.all.map((o) => ({ ...make(name, o.type, this.overloadDoc(check, callee, o.decl)), chosen: o.decl === set.chosen?.decl }));
    const sym = this.describe(a, callee.kind === "Member" ? [callee, callee.name as unknown as Node] : [callee as Node]);
    const doc = sym?.doc;
    // Overloads (standard library): each as its own signature, as seen on this receiver.
    const m = sym?.member;
    if (m?.overloads?.length) {
      const objType = callee.kind === "Member" ? check.exprTypes.get(callee.object) : undefined;
      const args = objType?.kind === "class" ? objType.args ?? [] : [];
      return m.overloads.map((o) => {
        const t = args.length && objType?.kind === "class" ? memberTypeIn(objType.info, args, m.owner, o.type) : o.type;
        return make(name, t as MethodType, doc);
      });
    }
    const t = check.exprTypes.get(callee);
    if (t?.kind === "method") return [make(name, t, doc)];
    if (callee.kind === "Ident" && callee.name === "trace") return [make("trace", { kind: "method", params: [{ name: "values", type: { kind: "any" }, optional: false, rest: true }], ret: { kind: "void" } })];
    return [];
  }

  // ---- outline ----

  /** The file's declarations: classes with their members, typedefs. */
  documentSymbols(path: string): DocumentSymbol[] {
    const a = this.analyze();
    const ast = this.astOf(a, path);
    if (!ast) return [];
    const file = ast.file;
    const r = (s: Span) => rangeOf(file, s.start, s.end);
    return [...ast.decls, ...ast.privateDecls].map((d): DocumentSymbol => {
      if (d.kind === "Typedef") {
        const t = a.result.check.typeNodeTypes.get(d.type);
        return { name: d.name.name, detail: t && typeToString({ ...t, alias: undefined } as Type), kind: "typedef", range: r(d.span), selectionRange: r(d.name.span), children: [] };
      }
      const info = [...a.result.check.classes.values()].find((c) => c.decl === d);
      const children = d.members.flatMap((m): DocumentSymbol[] => {
        if (m.kind === "StaticBlock") return [];
        const sig = m.kind === "Method" && m.isConstructor ? undefined : info?.members.get(m.name.name);
        const kind: SymbolKind = m.kind === "Field"
          ? (d.isEnum || m.decl === "const" ? "constant" : "field")
          : m.isConstructor ? "constructor" : m.accessor ? "property" : "method";
        const detail = sig ? (sig.type.kind === "method" ? signature(sig.type, "") : typeToString(sig.type)) : undefined;
        return [{ name: m.kind === "Method" && m.isConstructor ? "constructor" : m.kind === "Method" && m.accessor ? `${m.accessor} ${m.name.name}` : m.name.name, detail, kind, range: r(m.span), selectionRange: r(m.name.span), children: [] }];
      });
      const kind: SymbolKind = d.isInterface ? "interface" : d.isEnum ? "enum" : "class";
      return { name: d.name.name, detail: info && classText(info), kind, range: r(d.span), selectionRange: r(d.name.span), children };
    });
  }

  // ---- completion ----

  completions(path: string, offset: number): CompletionItem[] {
    const text = this.sources.get(path);
    if (text === undefined) return [];
    let start = offset;
    while (start > 0 && /[\w$]/.test(text[start - 1]!)) start--;
    if (text[start - 1] === ".") return this.typeCompletions(path, text, start) ?? this.memberCompletions(path, text, start, offset);
    if (text.slice(start - 2, start) === "::") return this.propertyReferenceCompletions(path, text, start, offset);
    if (isTypePosition(text, start)) return this.typeNameCompletions(path, offset);
    return this.keyCompletions(path, text, start, offset) ?? this.scopeCompletions(path, offset);
  }

  /** `User::`: visible instance members, synthesized as receiver-first functions. */
  private propertyReferenceCompletions(path: string, text: string, nameStart: number, offset: number): CompletionItem[] {
    const patched = nameStart === offset ? text.slice(0, offset) + PLACEHOLDER + text.slice(offset) : text;
    const a = patched === text ? this.analyze() : this.compile([...this.sources].map(([p, source]) => ({ path: p, text: p === path ? patched : source })));
    const ast = this.astOf(a, path);
    const ref = ast && nodesAt(ast, nameStart).findLast((n) => n.kind === "PropertyReference") as (A.Expr & { kind: "PropertyReference" }) | undefined;
    if (!ref) return [];
    const resolution = a.result.check.resolutions.get(ref.owner);
    if (resolution?.kind !== "class") return [];
    const enclosing = this.enclosingClass(a, ast!, nameStart);
    return this.collect([resolution.info], (m) => !m.isStatic && this.visible(m, enclosing)).map((m) => ({
      label: m.name,
      kind: memberKind(m),
      detail: memberText(m),
      documentation: docComment(m.decl.span.file, m.decl.span.start),
    }));
  }

  /**
   * A key of an object literal whose type is a shape (`rows.push({ ex| })` with `rows:Array<Row>`,
   * `var p:Point = { | }`): the shape's members that aren't given yet, required ones first.
   * Undefined outside a key position, where the cursor is in a value (`{ a: x| }`).
   */
  private keyCompletions(path: string, text: string, nameStart: number, offset: number): CompletionItem[] | undefined {
    let before = nameStart - 1;
    while (before >= 0 && /\s/.test(text[before]!)) before--;
    if (text[before] !== "{" && text[before] !== ",") return undefined;
    const a = this.analyze();
    const ast = this.astOf(a, path);
    if (!ast) return undefined;
    const chain = nodesAt(ast, offset);
    const at = chain.findLastIndex((n) => n.kind === "Object");
    if (at < 0) return undefined;
    const obj = chain[at] as A.Expr & { kind: "Object" };
    // Directly in this literal (not in a call inside one of its values), on a key being typed.
    const inner = chain.slice(at + 1).filter((n) => n.kind !== undefined); // not the key's own name
    const onKey = inner.every((n) => (n.kind === "Shorthand" && n.span.start === nameStart) || (n.kind === "Prop" && (n as A.ObjectProp).span.start === nameStart));
    if (!onKey || inner.length > 1 || before < obj.span.start) return undefined;
    const t = a.result.check.exprTypes.get(obj);
    const shape = t?.kind === "nullable" ? t.inner : t;
    if (shape?.kind !== "shape") return undefined;
    const given = new Set(obj.props.flatMap((p) => {
      if (p.span.start === nameStart) return []; // the key being typed
      if (p.kind === "Shorthand") return [p.name.name];
      if (p.kind === "Accessor") return [p.key.name];
      return p.kind === "Prop" && !("kind" in p.key) ? [p.key.name] : [];
    }));
    return this.shapeCompletions(shape)
      .filter((i) => !given.has(i.label))
      .map((i) => ({ ...i, sortText: `${shape.members.get(i.label)!.optional ? 1 : 0}${i.label}` }));
  }

  /**
   * `xlsx.` in a type (see `isTypePosition`): the types the
   * namespace import exports. Undefined elsewhere, where `xlsx.` is a value (its functions).
   */
  private typeCompletions(path: string, text: string, nameStart: number): CompletionItem[] | undefined {
    const before = text.slice(0, nameStart - 1);
    const receiver = /[A-Za-z_$][\w$]*$/.exec(before);
    if (!receiver || !isTypePosition(text, receiver.index)) return undefined;
    const a = this.analyze();
    const ast = this.astOf(a, path);
    const types = ast && a.result.check.qualifiedTypes.get(ast);
    const prefix = `${receiver[0]}.`;
    if (!types || ![...types.keys()].some((k) => k.startsWith(prefix))) return undefined;
    return [...types].filter(([k]) => k.startsWith(prefix)).map(([k, info]) => {
      const label = k.slice(prefix.length);
      if ("typeParams" in info) {
        return { label, kind: (info.decl.isInterface ? "interface" : "class") as CompletionKind, detail: classText(info), documentation: docComment(info.decl.span.file, info.decl.span.start) };
      }
      return { label, kind: "interface" as CompletionKind, detail: `typedef ${k}`, documentation: docComment(info.decl.span.file, info.decl.span.start) };
    });
  }

  /** After `obj.`: the members of `obj`'s type (TypeScript's members where Xenon only knows `*`). */
  private memberCompletions(path: string, text: string, nameStart: number, offset: number): CompletionItem[] {
    // `obj.` with no name yet doesn't parse: complete against a placeholder name.
    const patched = nameStart === offset ? text.slice(0, offset) + PLACEHOLDER + text.slice(offset) : text;
    const items = this.memberCompletionsIn(path, text, patched, nameStart);
    if (items) return items;
    // Still no `obj.name` node: the statement around it doesn't parse yet (`if (!res.)` with no body
    // so far), and the parser drops it. Complete `obj.` as a statement of its own, on a line inserted
    // above (the same block, so the same locals are in scope).
    const receiver = receiverBefore(text, nameStart);
    if (!receiver) return [];
    const lineStart = text.lastIndexOf("\n", receiver.start - 1) + 1;
    const statement = `${text.slice(receiver.start, nameStart)}${PLACEHOLDER};\n`;
    const alone = text.slice(0, lineStart) + statement + text.slice(lineStart);
    return this.memberCompletionsIn(path, text, alone, lineStart + nameStart - receiver.start) ?? [];
  }

  /** Members after the dot whose name starts at `nameStart` in `patched`; undefined if there is no such member expression. */
  private memberCompletionsIn(path: string, text: string, patched: string, nameStart: number): CompletionItem[] | undefined {
    const a = patched === text ? this.analyze() : this.compile([...this.sources].map(([p, t]) => ({ path: p, text: p === path ? patched : t })));
    const ast = this.astOf(a, path);
    if (!ast) return undefined;
    const member = nodesAt(ast, nameStart).findLast((n) => n.kind === "Member" && (n.name as A.Ident).span.start === nameStart) as (A.Expr & { kind: "Member" }) | undefined;
    if (!member) return undefined;
    const t = a.result.check.exprTypes.get(member.object);
    // A shape (`typedef Mail = { to:String, … }`, `{ x:Float }`): its members, with their doc comments.
    const shape = t?.kind === "nullable" ? t.inner : t;
    if (shape?.kind === "shape") return this.shapeCompletions(shape);
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

  private shapeCompletions(shape: ShapeType): CompletionItem[] {
    return [...shape.members.keys()].map((name) => {
      const { member, node } = shapeMember(shape, name)!;
      return { label: name, kind: "field" as CompletionKind, detail: shapeMemberText(member), documentation: node && docComment(node.span.file, node.span.start) };
    });
  }

  private visible(m: MemberSig, from: ClassInfo | undefined): boolean {
    const v = visibilityOf(readDecl(m)); // a property is listed where it can be read
    if (v === "private") return from === m.owner;
    if (v === "protected") return !!from && isSubclass(from, m.owner);
    return true;
  }

  private enclosingClass(a: Analysis, ast: A.XenonFile, offset: number): ClassInfo | undefined {
    const decl = nodesAt(ast, offset).findLast((n) => n.kind === "Class");
    return decl && [...a.result.check.classes.values()].find((c) => c.decl === decl);
  }

  /**
   * A type annotation (`var c:Co|`): the classes, interfaces, enums and typedefs this file can
   * name, the type parameters in scope, the built-in types, and namespace imports (`xlsx.` types).
   */
  private typeNameCompletions(path: string, offset: number): CompletionItem[] {
    const a = this.analyze();
    const ast = this.astOf(a, path);
    if (!ast) return [];
    const items = new Map<string, CompletionItem>();
    const add = (item: CompletionItem) => {
      if (!items.has(item.label)) items.set(item.label, item);
    };
    for (const n of nodesAt(ast, offset)) {
      for (const p of (n as { typeParams?: A.TypeParam[] }).typeParams ?? []) {
        const constraint = p.constraint ? ` extends ${spanText(p.constraint.span)}` : "";
        add({ label: p.name, kind: "typeParameter", detail: `type parameter ${p.name}${constraint}` });
      }
    }
    for (const t of ["Int", "UInt", "Float", "String", "Bool", "Void"]) add({ label: t, kind: "class" });
    add({ label: "Tuple", kind: "class", detail: "Tuple<A, B, …>: an array with one type per position" });
    const { classes, typedefs } = this.visibleTypes(a, ast);
    for (const c of classes) add(classItem(c));
    for (const td of typedefs) {
      add({ label: td.decl.name.name, kind: "typedef", detail: typedefText(td), documentation: docComment(td.decl.span.file, td.decl.span.start) });
    }
    // JavaScript imports that are types (`import JSZip from 'jszip'`) or hold some (`xlsx.`, `JSZip.`).
    const fromImports = a.result.check.qualifiedTypes.get(ast) ?? new Map();
    for (const [name, info] of fromImports) {
      if (name.includes(".")) continue;
      add("typeParams" in info ? { ...classItem(info), detail: classText(info) } : { label: name, kind: "typedef", detail: typedefText(info) });
    }
    for (const imp of ast.imports) {
      if (imp.kind !== "JsImport") continue;
      for (const n of [imp.defaultName, imp.namespace, ...imp.named.map((x) => x.alias ?? x.name)]) {
        if (n && [...fromImports.keys()].some((k) => k.startsWith(`${n.name}.`))) add({ label: n.name, kind: "module", detail: `import ${imp.namespace === n ? "* as " : ""}${n.name} from '${imp.module}'` });
      }
    }
    return [...items.values()];
  }

  /** Classes and typedefs this file can name: its package, its imports, the prelude, its own file-private ones. */
  private visibleTypes(a: Analysis, ast: A.XenonFile): { classes: ClassInfo[]; typedefs: TypedefInfo[] } {
    const pkg = ast.packageName.map((n) => n.name).join(".");
    const imported = new Set(ast.imports.flatMap((i) => (i.kind === "JsImport" ? [] : [i.path.map((p) => p.name).join(".")])));
    const visible = (t: { filePrivate: boolean; file: A.XenonFile; pkg: string; qname: string }, name: string) =>
      !name.startsWith("__") && (t.filePrivate ? t.file === ast : t.pkg === pkg || t.pkg === "xenon" || imported.has(t.qname) || imported.has(t.pkg));
    return {
      classes: [...a.result.check.classes.values()].filter((c) => visible(c, c.decl.name.name)),
      typedefs: [...a.result.check.typedefs.values()].filter((t) => visible(t, t.decl.name.name)),
    };
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
    const bindings = (pattern: A.Pattern): { name: A.Ident; type?: Type }[] => {
      switch (pattern.kind) {
        case "BindingName":
          return [{ name: pattern.name, type: check.bindingTypes.get(pattern.name) }];
        case "Target":
          return [];
        case "ArrayPattern":
          return [...pattern.elements.flatMap((p) => p ? bindings(p) : []), ...(pattern.rest ? bindings(pattern.rest) : [])];
        case "ObjectPattern":
          return [...pattern.props.flatMap((p) => bindings(p.value)), ...(pattern.rest ? bindings(pattern.rest) : [])];
      }
    };
    const chain = nodesAt(ast, offset);
    // Locals: declarations before the cursor in the enclosing blocks, and the enclosing functions' parameters.
    for (const node of [...chain].reverse()) {
      const declaredHere: { name: A.Ident; type?: Type }[] = [];
      if (node.kind === "Block" || node.kind === "SwitchCase") {
        for (const s of (node.body as A.Stmt[] | undefined) ?? []) {
          if (s.span.start >= offset) break;
          if (s.kind === "VarDecl") declaredHere.push({ name: s.name, type: s.type ? check.typeNodeTypes.get(s.type) : s.init && check.exprTypes.get(s.init) });
          if (s.kind === "DestructDecl") declaredHere.push(...bindings(s.pattern));
          if (s.kind === "FuncDecl" && s.fn.name) declaredHere.push({ name: s.fn.name });
        }
      }
      if (node.kind === "Method" || node.kind === "Function") {
        for (const p of (node.params as A.Param[])) declaredHere.push({ name: p.name, type: p.type && check.typeNodeTypes.get(p.type) });
      }
      const variable = (node as { variable?: A.LoopVar }).variable;
      if (variable?.pattern) declaredHere.push(...bindings(variable.pattern));
      else if (variable?.name) declaredHere.push({ name: variable.name, type: variable.type && check.typeNodeTypes.get(variable.type) });
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
    for (const c of this.visibleTypes(a, ast).classes) add(classItem(c));
    for (const f of a.result.asts.filter((f) => f.file.prelude).flatMap((f) => f.functions)) {
      add({ label: f.name.name, kind: "function", documentation: docComment(f.span.file, f.span.start) });
    }
    for (const imp of ast.imports) {
      if (imp.kind !== "JsImport") continue;
      for (const n of [imp.defaultName, imp.namespace, ...imp.named.map((x) => x.alias ?? x.name)]) if (n) add({ label: n.name, kind: "value", detail: `import from '${imp.module}'` });
    }
    for (const [name, qname] of TYPED_GLOBALS) {
      const info = a.result.check.classes.get(qname);
      if (info) add({ label: name, kind: "variable", detail: `${name}:${classText(info)}` });
    }
    add({ label: "trace", kind: "function", detail: "function trace(...values:Array<*>):void" });
    for (const k of KEYWORDS) add({ label: k, kind: "keyword" });
    for (const k of CONTEXTUAL_KEYWORDS) add({
      label: k,
      kind: "keyword",
      detail: k === "defer" ? "run the following statement when this block ends"
        : k === "nameof" ? "checked compile-time name of a symbol as String"
        : undefined,
    });
    for (const t of ["Int", "UInt", "Float", "String", "Bool"]) add({ label: t, kind: "class" });
    return [...items.values()];
  }
}

/**
 * Whether a name starting at `at` is written where a type goes: after `var x:`, a parameter's `x:`,
 * a return type's `):`, a shape member's `x:`, `<`, `->`, `as`, `is`, `new`, `extends` or
 * `implements`. An object literal's `{ key: …` and `a ? b : …` are values.
 */
export function isTypePosition(text: string, at: number): boolean {
  const before = text.slice(0, at);
  if (/(?:<|->|\bas|\bis|\bnew|\bextends|\bimplements|\)\s*:)\s*$/.test(before)) return true;
  if (/\b(?:var|const|final)\s+[A-Za-z_$][\w$]*\s*:\s*$/.test(before)) return true;
  // A destructuring pattern's annotation: `var [key, value]:` / `final { x, y }:`.
  if (/\b(?:var|const|final)\s*[[{][^=;]*[\]}]\s*:\s*$/.test(before)) return true;
  // `(a:int, b:` is a parameter list, `{ ?a:int, b:` a shape, `{ a: 1, b:` an object literal:
  // the innermost open bracket decides; a `{` opens a shape after `typedef X =` or in a type.
  // `Tuple<String, |`: the next type argument, when that `<` follows a type name in a type position.
  if (/,\s*$/.test(before)) {
    const open = openAngle(text, at);
    const name = open !== undefined ? /[A-Za-z_$][\w$.]*\s*$/.exec(text.slice(0, open)) : null;
    if (name && isTypePosition(text, name.index)) return true;
  }
  const member = /[(,{]\s*(?:\.\.\.|\?|final\s+)?[A-Za-z_$][\w$]*\s*:\s*$/.exec(before);
  if (!member) return false;
  const open = innermostOpen(text, member.index + 1);
  if (open === undefined) return false;
  if (text[open] === "(") return true;
  if (text[open] !== "{") return false;
  return /\btypedef\s+[A-Za-z_$][\w$]*\s*(?:<[^>]*>)?\s*=\s*$/.test(text.slice(0, open)) || isTypePosition(text, open);
}

/**
 * The `<` of the type-argument list `at` is in (`Map<String, |`), skipping closed `<…>` pairs; undefined
 * if a bracket or anything that can't be in a type comes first.
 */
function openAngle(text: string, at: number): number | undefined {
  let depth = 0;
  for (let i = at - 1; i >= 0; i--) {
    const c = text[i]!;
    if (c === ">" && text[i - 1] !== "-") depth++;
    else if (c === "<") {
      if (depth === 0) return i;
      depth--;
    } else if (!/[\w$.,\s?*|'():>-]/.test(c)) return undefined;
  }
  return undefined;
}

/** The position of the innermost bracket still open at `at` (scanning back, skipping strings roughly). */
function innermostOpen(text: string, at: number): number | undefined {
  let depth = 0;
  for (let i = at - 1; i >= 0; i--) {
    const c = text[i]!;
    if (")]}".includes(c)) depth++;
    else if ("([{".includes(c)) {
      if (depth === 0) return i;
      depth--;
    }
  }
  return undefined;
}

/** The number of top-level commas between `from` and `to`: the argument the cursor is in. */
function commasBefore(text: string, from: number, to: number): number {
  let depth = 0;
  let commas = 0;
  let quote: string | undefined;
  for (let i = from; i < to; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = undefined;
    } else if (c === "'" || c === '"') quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "," && depth === 0) commas++;
  }
  return commas;
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
