/**
 * `xenon lsp`: the Language Server Protocol over stdio, on top of `XenonProject` (src/service.ts).
 * Each file belongs to the project found by `locateProject` (a workspace may hold several, like
 * the compiler's `examples/*`); a project is loaded when one of its files is first opened.
 * Open editors override the files on disk; diagnostics are published for every file after each
 * change (debounced), since a change in one file can break another.
 */
import type { SemicolonStyle } from "./parser.ts";
import { dependencyList, resolveDependencies } from "./project.ts";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type CodeAction,
  CodeActionKind,
  CompletionItemKind,
  type Connection,
  createConnection,
  DiagnosticSeverity,
  DiagnosticTag,
  MarkupKind,
  ProposedFeatures,
  LSPErrorCodes,
  ResponseError,
  SemanticTokensBuilder,
  type SemanticTokensLegend,
  SymbolKind,
  TextDocuments,
  TextDocumentSyncKind,
  type WorkspaceEdit as LspWorkspaceEdit,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { type CompletionKind, type DocumentSymbol, type Fix, type Location, type SymbolKind as XenonSymbolKind, XenonProject } from "./service.ts";

/** The semantic token types and modifiers the server reports (see `XenonProject.semanticTokens`). */
const SEMANTIC_LEGEND: SemanticTokensLegend = { tokenTypes: ["property"], tokenModifiers: ["declaration"] };

const KINDS: Record<CompletionKind, CompletionItemKind> = {
  field: CompletionItemKind.Field,
  method: CompletionItemKind.Method,
  property: CompletionItemKind.Property,
  class: CompletionItemKind.Class,
  interface: CompletionItemKind.Interface,
  enum: CompletionItemKind.Enum,
  variable: CompletionItemKind.Variable,
  function: CompletionItemKind.Function,
  keyword: CompletionItemKind.Keyword,
  typedef: CompletionItemKind.Struct,
  value: CompletionItemKind.Value,
  typeParameter: CompletionItemKind.TypeParameter,
  module: CompletionItemKind.Module,
};

const SYMBOLS: Record<XenonSymbolKind, SymbolKind> = {
  class: SymbolKind.Class,
  interface: SymbolKind.Interface,
  enum: SymbolKind.Enum,
  typedef: SymbolKind.TypeParameter,
  field: SymbolKind.Field,
  method: SymbolKind.Method,
  property: SymbolKind.Property,
  constructor: SymbolKind.Constructor,
  constant: SymbolKind.Constant,
};

const SEVERITY = { error: DiagnosticSeverity.Error, warning: DiagnosticSeverity.Warning, info: DiagnosticSeverity.Information };
const COMPLETION_TRIGGERS = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$", ".", ":"];

/** Files a JavaScript or TypeScript project keeps in its `src/`. */
const SCRIPT = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;

/**
 * The Xenon project a file belongs to: the nearest `xenon.json` above it whose source root
 * contains the file, otherwise the nearest folder named `src` (with the main class `Main`).
 * A `src/` with JavaScript or TypeScript files directly in it belongs to a JavaScript project,
 * not Xenon (the compiler's own `src/prelude/*.xn`, for one). Files in no project (the
 * compiler's deliberately broken test files) get no diagnostics.
 */
export function locateProject(file: string): { srcRoot: string; main: string; nullSafety?: boolean; semicolons?: SemicolonStyle; sources?: string[]; library?: boolean } | undefined {
  let srcFolder: string | undefined;
  for (let dir = dirname(file); ; ) {
    const config = join(dir, "xenon.json");
    if (existsSync(config)) {
      let json: { src?: string; main?: string; nullSafety?: boolean; semicolons?: SemicolonStyle; sources?: unknown; library?: unknown; dependencies?: unknown } = {};
      try {
        json = JSON.parse(readFileSync(config, "utf8"));
      } catch {
        // a broken xenon.json: the CLI reports it; use the defaults here
      }
      const srcRoot = resolve(dir, json.src ?? "src");
      const semicolons = ["always", "never", "any"].includes(json.semicolons as string) ? { semicolons: json.semicolons } : {};
      // Further source folders (`"sources"`): a library's sources compiled with the project.
      const folders = Array.isArray(json.sources) ? json.sources.filter((s): s is string => typeof s === "string" && s !== "").map((s) => resolve(dir, s)) : [];
      // `"dependencies"`: their source folders too (unresolvable ones are left out; the CLI says why).
      try {
        const deps = resolveDependencies(dir, dependencyList(json.dependencies, config), { nullSafety: json.nullSafety !== false });
        folders.push(...deps.map((d) => d.src));
      } catch {
        // reported by `xenon check`
      }
      const sources = folders.length > 0 ? { sources: folders } : {};
      if (!relative(srcRoot, file).startsWith("..")) return { srcRoot, main: json.main ?? "Main", ...(typeof json.nullSafety === "boolean" ? { nullSafety: json.nullSafety } : {}), ...semicolons, ...sources, ...(json.library === true ? { library: true } : {}) };
    }
    if (!srcFolder && basename(dir) === "src") {
      let scripts = false;
      try {
        scripts = readdirSync(dir).some((f) => SCRIPT.test(f));
      } catch {
        // unreadable: not a source root
        scripts = true;
      }
      if (!scripts) srcFolder = dir;
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return srcFolder ? { srcRoot: srcFolder, main: "Main" } : undefined;
}

export function startServer(connection: Connection = createConnection(ProposedFeatures.all, process.stdin, process.stdout)) {
  const documents = new TextDocuments(TextDocument);
  /** The projects of the files opened so far, by source root (loaded from disk once). */
  const projects = new Map<string, Promise<XenonProject>>();
  /** Files that have diagnostics in the editor (to clear them once they're gone). */
  const published = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  /** The project of a file (created and loaded on first use) and the file's path in it. */
  const projectOf = async (uri: string, create = true): Promise<{ project: XenonProject; path: string } | undefined> => {
    if (!uri.startsWith("file:") || !uri.endsWith(".xn")) return undefined;
    const file = fileURLToPath(uri);
    const found = locateProject(file);
    if (!found) return undefined;
    let p = projects.get(found.srcRoot);
    if (!p) {
      if (!create) return undefined;
      p = (async () => {
        const project = new XenonProject(found.srcRoot, found.main, undefined, { nullSafety: found.nullSafety, semicolons: found.semicolons, sources: found.sources, library: found.library });
        await project.load();
        return project;
      })();
      projects.set(found.srcRoot, p);
    }
    return { project: await p, path: relative(found.srcRoot, file).split(sep).join("/") };
  };
  const toLsp = (l: Location) => ({ uri: pathToFileURL(l.path).href, range: l.range });

  const publish = async () => {
    for (const p of projects.values()) {
      const project = await p;
      for (const [path, diags] of project.diagnostics()) {
        if (!project.isOwn(path)) continue; // a library's file: its own project reports it
        const uri = pathToFileURL(join(project.srcRoot, path)).href;
        if (diags.length === 0 && !published.has(uri)) continue;
        if (diags.length > 0) published.add(uri);
        else published.delete(uri);
        connection.sendDiagnostics({
          uri,
          diagnostics: diags.map((d) => ({
            range: d.range,
            severity: SEVERITY[d.severity],
            message: d.message,
            code: d.code,
            source: d.source,
            relatedInformation: d.related.map((r) => ({ location: toLsp(r.location), message: r.message })),
            // Uses of `[Deprecated]` declarations are shown struck through.
            tags: d.code === "X0873" ? [DiagnosticTag.Deprecated] : undefined,
            // Kept by the editor and handed back with code action requests.
            data: d.fixes.length > 0 ? d.fixes : undefined,
          })),
        });
      }
    }
  };
  const schedule = (delay = 150) => {
    clearTimeout(timer);
    timer = setTimeout(() => void publish(), delay);
  };

  /** Can the editor rename files as part of a workspace edit (a renamed class renames its file)? */
  let fileRenames = false;

  connection.onInitialize(async (params) => {
    fileRenames = !!params.capabilities.workspace?.workspaceEdit?.resourceOperations?.includes("rename");
    return {
      capabilities: {
        textDocumentSync: TextDocumentSyncKind.Incremental,
        hoverProvider: true,
        definitionProvider: true,
        completionProvider: { triggerCharacters: COMPLETION_TRIGGERS },
        referencesProvider: true,
        renameProvider: { prepareProvider: true },
        signatureHelpProvider: { triggerCharacters: ["(", ","], retriggerCharacters: [","] },
        documentSymbolProvider: true,
        codeActionProvider: { codeActionKinds: [CodeActionKind.QuickFix] },
        semanticTokensProvider: { legend: SEMANTIC_LEGEND, full: true },
      },
      serverInfo: { name: "xenon-language-server" },
    };
  });

  /**
   * The other loaded projects that compile this file too: it's in one of their further source
   * folders (`"sources"`, a library used by several programs).
   */
  const usersOf = async (uri: string, owner: XenonProject | undefined) => {
    if (!uri.startsWith("file:") || !uri.endsWith(".xn")) return [];
    const file = fileURLToPath(uri);
    const users: { project: XenonProject; path: string; dir: string }[] = [];
    for (const p of projects.values()) {
      const project = await p;
      const found = project === owner ? undefined : project.pathFor(file);
      if (found && found.dir !== project.srcRoot) users.push({ project, ...found });
    }
    return users;
  };

  // A project's diagnostics appear once one of its files is opened (all its files are checked).
  documents.onDidChangeContent(async ({ document }) => {
    const q = await projectOf(document.uri);
    if (q) q.project.set(q.path, document.getText());
    for (const u of await usersOf(document.uri, q?.project)) u.project.set(u.path, document.getText(), u.dir);
    schedule();
  });

  /** Back to the file on disk (or gone, if it was never saved). */
  const reload = async (uri: string) => {
    const q = await projectOf(uri, false);
    const file = Bun.file(fileURLToPath(uri));
    const text = (await file.exists()) ? await file.text() : undefined;
    const owner: { project: XenonProject; path: string; dir?: string }[] = q ? [q] : [];
    for (const u of [...owner, ...(await usersOf(uri, q?.project))]) {
      if (text === undefined) u.project.remove(u.path);
      else u.project.set(u.path, text, u.dir);
    }
  };

  documents.onDidClose(async ({ document }) => {
    await reload(document.uri);
    schedule();
  });

  connection.onDidChangeWatchedFiles(async ({ changes }) => {
    for (const change of changes) {
      if (!documents.get(change.uri)) await reload(change.uri); // open editors win
    }
    schedule();
  });

  /** The document and project path for a request, with the cursor as an offset. */
  const at = async (uri: string, position: { line: number; character: number }) => {
    const doc = documents.get(uri);
    const q = doc && (await projectOf(uri));
    if (!doc || !q) return undefined;
    q.project.set(q.path, doc.getText()); // the newest text, even inside the debounce window
    return { ...q, offset: doc.offsetAt(position) };
  };

  connection.onHover(async ({ textDocument, position }) => {
    const q = await at(textDocument.uri, position);
    const h = q && q.project.hover(q.path, q.offset);
    return h ? { contents: { kind: MarkupKind.Markdown, value: h.contents }, range: h.range } : null;
  });

  connection.onDefinition(async ({ textDocument, position }) => {
    const q = await at(textDocument.uri, position);
    return q ? q.project.definition(q.path, q.offset).map(toLsp) : null;
  });

  connection.onCompletion(async ({ textDocument, position }) => {
    const q = await at(textDocument.uri, position);
    if (!q) return null;
    return q.project.completions(q.path, q.offset).map((c) => ({
      label: c.label,
      kind: KINDS[c.kind],
      detail: c.detail,
      documentation: c.documentation ? { kind: MarkupKind.Markdown, value: c.documentation } : undefined,
      sortText: c.sortText,
    }));
  });

  connection.onReferences(async ({ textDocument, position, context }) => {
    const q = await at(textDocument.uri, position);
    return q ? q.project.references(q.path, q.offset, context.includeDeclaration).map(toLsp) : null;
  });

  connection.onPrepareRename(async ({ textDocument, position }) => {
    const q = await at(textDocument.uri, position);
    if (!q) return null;
    const r = q.project.prepareRename(q.path, q.offset);
    if ("error" in r) throw new ResponseError(LSPErrorCodes.RequestFailed, r.error);
    return r;
  });

  connection.onRenameRequest(async ({ textDocument, position, newName }): Promise<LspWorkspaceEdit | null> => {
    const q = await at(textDocument.uri, position);
    if (!q) return null;
    const r = q.project.rename(q.path, q.offset, newName);
    if ("error" in r) throw new ResponseError(LSPErrorCodes.RequestFailed, r.error);
    const edits = [...r.changes].map(([path, es]) => {
      const uri = pathToFileURL(path).href;
      return { textDocument: { uri, version: documents.get(uri)?.version ?? null }, edits: es };
    });
    if (!fileRenames) return { changes: Object.fromEntries(edits.map((e) => [e.textDocument.uri, e.edits])) };
    const renames = r.renames.map((x) => ({ kind: "rename" as const, oldUri: pathToFileURL(x.from).href, newUri: pathToFileURL(x.to).href }));
    return { documentChanges: [...edits, ...renames] };
  });

  connection.onSignatureHelp(async ({ textDocument, position }) => {
    const q = await at(textDocument.uri, position);
    return (q && q.project.signatureHelp(q.path, q.offset)) ?? null;
  });

  connection.onDocumentSymbol(async ({ textDocument }) => {
    const q = await projectOf(textDocument.uri);
    const doc = documents.get(textDocument.uri);
    if (!q) return null;
    if (doc) q.project.set(q.path, doc.getText());
    const convert = (s: DocumentSymbol): object => ({ ...s, kind: SYMBOLS[s.kind], children: s.children.map(convert) });
    return q.project.documentSymbols(q.path).map(convert) as never;
  });

  // Object literal keys and shape members: names only the parser can tell apart from annotations.
  connection.languages.semanticTokens.on(async ({ textDocument }) => {
    const q = await projectOf(textDocument.uri);
    const doc = documents.get(textDocument.uri);
    const builder = new SemanticTokensBuilder();
    if (q && doc) {
      q.project.set(q.path, doc.getText());
      for (const t of q.project.semanticTokens(q.path)) {
        const modifiers = t.modifiers.reduce((bits, m) => bits | (1 << SEMANTIC_LEGEND.tokenModifiers.indexOf(m)), 0);
        builder.push(t.line, t.character, t.length, SEMANTIC_LEGEND.tokenTypes.indexOf(t.type), modifiers);
      }
    }
    return builder.build();
  });

  connection.onCodeAction(({ context }) => {
    const actions: CodeAction[] = [];
    for (const d of context.diagnostics) {
      (d.data as Fix[] | undefined)?.forEach((fix, i) => {
        actions.push({
          title: fix.title,
          kind: CodeActionKind.QuickFix,
          diagnostics: [d],
          isPreferred: i === 0,
          edit: { changes: Object.fromEntries(fix.edits.map((e) => [pathToFileURL(e.path).href, e.edits])) },
        });
      });
    }
    return actions;
  });

  documents.listen(connection);
  connection.listen();
}
