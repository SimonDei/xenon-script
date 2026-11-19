/** `xenon lsp` and the server bundled into the VS Code extension: a session over stdio, the way an editor drives it. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";
import { buildServer } from "../packages/vscode-xenon/scripts/build.ts";

const dir = join(import.meta.dir, ".lsp-project");
const bundled = join(import.meta.dir, ".lsp-bundle");
beforeAll(() => buildServer(bundled), 30_000);
afterAll(() => Promise.all([rm(dir, { recursive: true, force: true }), rm(bundled, { recursive: true, force: true })]));

const SERVERS: [string, string[]][] = [
  ["xenon lsp", [join(import.meta.dir, "..", "src", "cli.ts"), "lsp", "--stdio"]],
  ["the extension's bundled server", [join(bundled, "server.js"), "--stdio"]],
];

// `path` is typed by TypeScript (`@types/node`); `.toUpperCase()` on its result needs TypeScript's `lib.esnext.d.ts`.
const MAIN = `import * as path from 'node:path'
public class Main {
  public function Main() {
    var greeting:String = 'hi'
    trace(greeting.toUpperCase(), path.basename('a/b').toUpperCase())
  }
}
`;

test.each(SERVERS)("%s: diagnostics, hover, definition and completion over stdio", async (_name, args) => {
  await rm(dir, { recursive: true, force: true });
  await mkdir(join(dir, "app"), { recursive: true });
  await Bun.write(join(dir, "xenon.json"), JSON.stringify({ src: "app" }));
  await Bun.write(join(dir, "app", "Main.xn"), MAIN);

  const server = spawn("bun", args, { cwd: dir });
  const rpc = createMessageConnection(new StreamMessageReader(server.stdout), new StreamMessageWriter(server.stdin));
  const published: { uri: string; diagnostics: { message: string; range: unknown }[] }[] = [];
  const waiting: (() => void)[] = [];
  rpc.onNotification("textDocument/publishDiagnostics", (p) => {
    published.push(p);
    waiting.splice(0).forEach((f) => f());
  });
  /** Waits until the newest diagnostics for `uri` satisfy `ok`. */
  const diagnosticsFor = async (uri: string, ok: (d: { message: string }[]) => boolean) => {
    for (;;) {
      const last = published.findLast((p) => p.uri === uri);
      if (last && ok(last.diagnostics)) return last.diagnostics;
      await new Promise<void>((r) => waiting.push(r));
    }
  };
  rpc.listen();

  try {
    const capabilities = { workspace: { workspaceEdit: { documentChanges: true, resourceOperations: ["rename"] } } };
    const init = await rpc.sendRequest("initialize", { processId: null, rootUri: pathToFileURL(dir).href, capabilities });
    expect(init).toMatchObject({ capabilities: { hoverProvider: true, definitionProvider: true, completionProvider: { triggerCharacters: ["."] } } });
    rpc.sendNotification("initialized", {});

    const uri = pathToFileURL(join(dir, "app", "Main.xn")).href;
    // An unsaved edit with an error: the editor's text counts, not the disk's.
    const broken = MAIN.replace("greeting.toUpperCase()", "greeting.toUpperCase(1)");
    rpc.sendNotification("textDocument/didOpen", { textDocument: { uri, languageId: "xenon", version: 1, text: broken } });
    const errors = await diagnosticsFor(uri, (d) => d.length > 0);
    expect(errors.map((d) => d.message.split("\n")[0])).toEqual(["this call takes 0 arguments but 1 was given"]);

    // TypeScript's error on a JavaScript import, mapped to the Xenon source.
    const typed = MAIN.replace("var greeting:String = 'hi'", "var greeting:String = 'hi'\n    var n:int = path.basename('x')");
    rpc.sendNotification("textDocument/didChange", { textDocument: { uri, version: 2 }, contentChanges: [{ text: typed }] });
    const tsErrors = (await diagnosticsFor(uri, (d) => d.some((x) => x.message.includes("not assignable")))) as { message: string; range: unknown; source?: string }[];
    expect(tsErrors.filter((d) => d.source === "typescript").map((d) => [d.source, d.range])).toEqual([["typescript", { start: { line: 4, character: 8 }, end: { line: 4, character: 9 } }]]);

    rpc.sendNotification("textDocument/didChange", { textDocument: { uri, version: 3 }, contentChanges: [{ text: MAIN }] });
    expect(await diagnosticsFor(uri, (d) => d.length === 0)).toEqual([]);

    const hover = await rpc.sendRequest("textDocument/hover", { textDocument: { uri }, position: { line: 4, character: 22 } });
    expect(hover).toMatchObject({ contents: { kind: "markdown", value: expect.stringContaining("function String.toUpperCase():String") } });

    const def = await rpc.sendRequest("textDocument/definition", { textDocument: { uri }, position: { line: 4, character: 12 } });
    expect(def).toEqual([{ uri, range: { start: { line: 3, character: 8 }, end: { line: 3, character: 16 } } }]);

    const items = (await rpc.sendRequest("textDocument/completion", { textDocument: { uri }, position: { line: 4, character: 19 } })) as { label: string }[];
    expect(items.map((i) => i.label)).toContain("toUpperCase");

    // References: the declaration and the use.
    const refs = (await rpc.sendRequest("textDocument/references", { textDocument: { uri }, position: { line: 4, character: 12 }, context: { includeDeclaration: true } })) as { range: { start: unknown } }[];
    expect(refs.map((r) => r.range.start)).toEqual([{ line: 3, character: 8 }, { line: 4, character: 10 }]);

    // Rename the class: both names, plus the file (the editor supports resource operations).
    const prep = await rpc.sendRequest("textDocument/prepareRename", { textDocument: { uri }, position: { line: 1, character: 14 } });
    expect(prep).toMatchObject({ placeholder: "Main" });
    const edit = (await rpc.sendRequest("textDocument/rename", { textDocument: { uri }, position: { line: 1, character: 14 }, newName: "App" })) as { documentChanges: unknown[] };
    expect(edit.documentChanges).toEqual([
      { textDocument: { uri, version: 3 }, edits: [{ range: { start: { line: 1, character: 13 }, end: { line: 1, character: 17 } }, newText: "App" }, { range: { start: { line: 2, character: 18 }, end: { line: 2, character: 22 } }, newText: "App" }] },
      { kind: "rename", oldUri: uri, newUri: uri.replace("Main.xn", "App.xn") },
    ]);
    await expect(rpc.sendRequest("textDocument/prepareRename", { textDocument: { uri }, position: { line: 4, character: 22 } })).rejects.toThrow("`toUpperCase` is part of the standard library.");

    const sig = await rpc.sendRequest("textDocument/signatureHelp", { textDocument: { uri }, position: { line: 4, character: 48 } });
    expect(sig).toMatchObject({ signatures: [{ label: "basename(path: string, suffix?: string): string" }], activeParameter: 0 });

    const symbols = (await rpc.sendRequest("textDocument/documentSymbol", { textDocument: { uri } })) as { name: string; kind: number; children: { name: string }[] }[];
    expect(symbols.map((x) => [x.name, x.kind, x.children.map((c) => c.name)])).toEqual([["Main", 5, ["constructor"]]]);

    // A quick fix from the diagnostic's suggestion.
    const strict = MAIN.replace("trace(", "trace(1 === 1, ");
    rpc.sendNotification("textDocument/didChange", { textDocument: { uri, version: 4 }, contentChanges: [{ text: strict }] });
    const withFix = await diagnosticsFor(uri, (d) => d.length > 0);
    const actions = (await rpc.sendRequest("textDocument/codeAction", { textDocument: { uri }, range: (withFix[0] as { range: object }).range, context: { diagnostics: withFix } })) as { title: string; isPreferred: boolean; edit: { changes: Record<string, { newText: string }[]> } }[];
    expect(actions.map((a) => [a.title, a.isPreferred, a.edit.changes[uri]!.map((e) => e.newText)])).toEqual([["use ==", true, ["=="]]]);

    await rpc.sendRequest("shutdown");
    rpc.sendNotification("exit");
  } finally {
    rpc.dispose();
    server.kill();
  }
}, 20_000);

const repo = join(import.meta.dir, "..");

test("files find their project: xenon.json, else the nearest src/ that isn't a JavaScript project's", async () => {
  const { locateProject } = await import("../src/lsp.ts");
  expect(locateProject(join(repo, "examples", "zoo", "src", "com", "zoo", "Animal.xn"))).toEqual({ srcRoot: join(repo, "examples", "zoo", "src"), main: "Main" });
  // The compiler's own sources hold its prelude: not a Xenon project, and neither are the error snapshots.
  expect(locateProject(join(repo, "src", "prelude", "Prelude.xn"))).toBeUndefined();
  expect(locateProject(join(repo, "tests", "errors", "accessors.xn"))).toBeUndefined();
  await mkdir(join(dir, "app"), { recursive: true });
  await Bun.write(join(dir, "xenon.json"), JSON.stringify({ src: "app", main: "app.Main" }));
  expect(locateProject(join(dir, "app", "x", "Y.xn"))).toEqual({ srcRoot: join(dir, "app"), main: "app.Main" });
});

test("a workspace with several projects (the compiler repository): each example on its own, no prelude errors", async () => {
  const server = spawn("bun", [join(repo, "src", "cli.ts"), "lsp", "--stdio"], { cwd: repo });
  const rpc = createMessageConnection(new StreamMessageReader(server.stdout), new StreamMessageWriter(server.stdin));
  const published = new Map<string, number>();
  let notify = () => {};
  rpc.onNotification("textDocument/publishDiagnostics", (p: { uri: string; diagnostics: unknown[] }) => {
    published.set(p.uri, p.diagnostics.length);
    notify();
  });
  rpc.listen();
  try {
    await rpc.sendRequest("initialize", { processId: null, rootUri: pathToFileURL(repo).href, capabilities: {} });
    rpc.sendNotification("initialized", {});
    const open = async (path: string) => {
      const uri = pathToFileURL(join(repo, path)).href;
      rpc.sendNotification("textDocument/didOpen", { textDocument: { uri, languageId: "xenon", version: 1, text: await Bun.file(join(repo, path)).text() } });
      return uri;
    };
    await open("src/prelude/Prelude.xn");
    await open("tests/errors/accessors.xn");
    const zoo = await open("examples/zoo/src/Main.xn");
    // A broken example: its error shows up, in that example only.
    const broken = pathToFileURL(join(repo, "examples/hello/src/Main.xn")).href;
    rpc.sendNotification("textDocument/didOpen", { textDocument: { uri: broken, languageId: "xenon", version: 1, text: "public class Main {\n  public function Main() { trace(nope) }\n}\n" } });
    while (published.get(broken) !== 1) await new Promise<void>((r) => (notify = r));
    expect([...published.keys()].map((u) => u.slice(pathToFileURL(repo).href.length + 1))).toEqual(["examples/hello/src/Main.xn"]);
    // Hover works in each project.
    const hover = await rpc.sendRequest("textDocument/hover", { textDocument: { uri: zoo }, position: { line: 5, character: 16 } });
    expect(hover).toMatchObject({ contents: { value: "```xenon\nclass Main\n```" } });
    await rpc.sendRequest("shutdown");
    rpc.sendNotification("exit");
  } finally {
    rpc.dispose();
    server.kill();
  }
}, 20_000);
