/**
 * `xenon lsp`: the Language Server Protocol over stdio, on top of `XenonProject` (src/service.ts).
 * One project per workspace: its `xenon.json` (or `src/` and `Main`) decides the source root.
 * Open editors override the files on disk; diagnostics are published for every file after each
 * change (debounced), since a change in one file can break another.
 */
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CompletionItemKind,
  type Connection,
  createConnection,
  DiagnosticSeverity,
  MarkupKind,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { type CompletionKind, type Location, XenonProject } from "./service.ts";

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
        })),
      });
    }
  };
  const schedule = (delay = 150) => {
    clearTimeout(timer);
    timer = setTimeout(publish, delay);
  };

  connection.onInitialize(async (params) => {
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

  documents.listen(connection);
  connection.listen();
}
