/**
 * `xenon lsp`: the Language Server Protocol over stdio, on top of `XenonProject` (src/service.ts).
 * One project per workspace: its `xenon.json` (or `src/` and `Main`) decides the source root.
 * Open editors override the files on disk; diagnostics are published for every file after each
 * change (debounced), since a change in one file can break another.
 */
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type CodeAction,
  CodeActionKind,
  CompletionItemKind,
  type Connection,
  createConnection,
  DiagnosticSeverity,
  MarkupKind,
  ProposedFeatures,
  LSPErrorCodes,
  ResponseError,
  SymbolKind,
  TextDocuments,
  TextDocumentSyncKind,
  type WorkspaceEdit as LspWorkspaceEdit,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { type CompletionKind, type DocumentSymbol, type Fix, type Location, type SymbolKind as XenonSymbolKind, XenonProject } from "./service.ts";

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
  typedef: CompletionItemKind.TypeParameter,
  value: CompletionItemKind.Value,
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

/** Reads `xenon.json` in the workspace root, if any: the source root and the main class. */
async function projectConfig(root: string): Promise<{ src: string; main: string }> {
  const file = Bun.file(join(root, "xenon.json"));
  let json: { src?: string; main?: string } = {};
  if (await file.exists()) {
    try {
      json = await file.json();
    } catch {
      // a broken xenon.json: the CLI reports it; use the defaults here
    }
  }
  return { src: resolve(root, json.src ?? "src"), main: json.main ?? "Main" };
}

export function startServer(connection: Connection = createConnection(ProposedFeatures.all, process.stdin, process.stdout)) {
  const documents = new TextDocuments(TextDocument);
  let project: XenonProject | undefined;
  let srcRoot = "";
  /** Files that have diagnostics in the editor (to clear them once they're gone). */
  const published = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  /** The project-relative path of a document, if it belongs to the project. */
  const pathOf = (uri: string): string | undefined => {
    if (!uri.startsWith("file:")) return undefined;
    const rel = relative(srcRoot, fileURLToPath(uri));
    return rel.startsWith("..") || !rel.endsWith(".xn") ? undefined : rel.split(sep).join("/");
  };
  const uriOf = (path: string) => pathToFileURL(join(srcRoot, path)).href;
  const toLsp = (l: Location) => ({ uri: pathToFileURL(l.path).href, range: l.range });

  const publish = () => {
    if (!project) return;
    for (const [path, diags] of project.diagnostics()) {
      const uri = uriOf(path);
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
          // Kept by the editor and handed back with code action requests.
          data: d.fixes.length > 0 ? d.fixes : undefined,
        })),
      });
    }
  };
  const schedule = (delay = 150) => {
    clearTimeout(timer);
    timer = setTimeout(publish, delay);
  };

  /** Can the editor rename files as part of a workspace edit (a renamed class renames its file)? */
  let fileRenames = false;

  connection.onInitialize(async (params) => {
    fileRenames = !!params.capabilities.workspace?.workspaceEdit?.resourceOperations?.includes("rename");
    const folder = params.workspaceFolders?.[0]?.uri ?? params.rootUri;
    const root = folder ? fileURLToPath(folder) : process.cwd();
    const config = await projectConfig(root);
    srcRoot = config.src;
    project = new XenonProject(srcRoot, config.main);
    await project.load();
    return {
      capabilities: {
        textDocumentSync: TextDocumentSyncKind.Incremental,
        hoverProvider: true,
        definitionProvider: true,
        completionProvider: { triggerCharacters: ["."] },
        referencesProvider: true,
        renameProvider: { prepareProvider: true },
        signatureHelpProvider: { triggerCharacters: ["(", ","], retriggerCharacters: [","] },
        documentSymbolProvider: true,
        codeActionProvider: { codeActionKinds: [CodeActionKind.QuickFix] },
      },
      serverInfo: { name: "xenon-language-server" },
    };
  });

  connection.onInitialized(() => schedule(0));

  documents.onDidChangeContent(({ document }) => {
    const path = pathOf(document.uri);
    if (!path || !project) return;
    project.set(path, document.getText());
    schedule();
  });

  documents.onDidClose(async ({ document }) => {
    const path = pathOf(document.uri);
    if (!path || !project) return;
    // Back to the file on disk (or gone, if it was never saved).
    const file = Bun.file(join(srcRoot, path));
    if (await file.exists()) project.set(path, await file.text());
    else project.remove(path);
    schedule();
  });

  connection.onDidChangeWatchedFiles(async ({ changes }) => {
    if (!project) return;
    for (const change of changes) {
      const path = pathOf(change.uri);
      if (!path || documents.get(change.uri)) continue; // open editors win
      const file = Bun.file(join(srcRoot, path));
      if (await file.exists()) project.set(path, await file.text());
      else project.remove(path);
    }
    schedule();
  });

  /** The document and project path for a request, with the cursor as an offset. */
  const at = (uri: string, position: { line: number; character: number }) => {
    const doc = documents.get(uri);
    const path = pathOf(uri);
    if (!doc || !path || !project) return undefined;
    project.set(path, doc.getText()); // the newest text, even inside the debounce window
    return { project, path, offset: doc.offsetAt(position) };
  };

  connection.onHover(({ textDocument, position }) => {
    const q = at(textDocument.uri, position);
    const h = q && q.project.hover(q.path, q.offset);
    return h ? { contents: { kind: MarkupKind.Markdown, value: h.contents }, range: h.range } : null;
  });

  connection.onDefinition(({ textDocument, position }) => {
    const q = at(textDocument.uri, position);
    return q ? q.project.definition(q.path, q.offset).map(toLsp) : null;
  });

  connection.onCompletion(({ textDocument, position }) => {
    const q = at(textDocument.uri, position);
    if (!q) return null;
    return q.project.completions(q.path, q.offset).map((c) => ({
      label: c.label,
      kind: KINDS[c.kind],
      detail: c.detail,
      documentation: c.documentation ? { kind: MarkupKind.Markdown, value: c.documentation } : undefined,
    }));
  });

  connection.onReferences(({ textDocument, position, context }) => {
    const q = at(textDocument.uri, position);
    return q ? q.project.references(q.path, q.offset, context.includeDeclaration).map(toLsp) : null;
  });

  connection.onPrepareRename(({ textDocument, position }) => {
    const q = at(textDocument.uri, position);
    if (!q) return null;
    const r = q.project.prepareRename(q.path, q.offset);
    if ("error" in r) throw new ResponseError(LSPErrorCodes.RequestFailed, r.error);
    return r;
  });

  connection.onRenameRequest(({ textDocument, position, newName }): LspWorkspaceEdit | null => {
    const q = at(textDocument.uri, position);
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

  connection.onSignatureHelp(({ textDocument, position }) => {
    const q = at(textDocument.uri, position);
    return (q && q.project.signatureHelp(q.path, q.offset)) ?? null;
  });

  connection.onDocumentSymbol(({ textDocument }) => {
    const path = pathOf(textDocument.uri);
    const doc = documents.get(textDocument.uri);
    if (!path || !project) return null;
    if (doc) project.set(path, doc.getText());
    const convert = (s: DocumentSymbol): object => ({ ...s, kind: SYMBOLS[s.kind], children: s.children.map(convert) });
    return project.documentSymbols(path).map(convert) as never;
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
