/** `xenon lsp`: a session over stdio, the way an editor drives it. */
import { afterAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";

const dir = join(import.meta.dir, ".lsp-project");
afterAll(() => rm(dir, { recursive: true, force: true }));

const MAIN = `public class Main {
  public function Main() {
    var greeting:String = 'hi'
    trace(greeting.toUpperCase())
  }
}
`;

test("diagnostics, hover, definition and completion over stdio", async () => {
  await rm(dir, { recursive: true, force: true });
  await mkdir(join(dir, "app"), { recursive: true });
  await Bun.write(join(dir, "xenon.json"), JSON.stringify({ src: "app" }));
  await Bun.write(join(dir, "app", "Main.xn"), MAIN);

  const server = spawn("bun", [join(import.meta.dir, "..", "src", "cli.ts"), "lsp", "--stdio"], { cwd: dir });
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
    const init = await rpc.sendRequest("initialize", { processId: null, rootUri: pathToFileURL(dir).href, capabilities: {} });
    expect(init).toMatchObject({ capabilities: { hoverProvider: true, definitionProvider: true, completionProvider: { triggerCharacters: ["."] } } });
    rpc.sendNotification("initialized", {});

    const uri = pathToFileURL(join(dir, "app", "Main.xn")).href;
    // An unsaved edit with an error: the editor's text counts, not the disk's.
    const broken = MAIN.replace("toUpperCase()", "toUpperCase(1)");
    rpc.sendNotification("textDocument/didOpen", { textDocument: { uri, languageId: "xenon", version: 1, text: broken } });
    const errors = await diagnosticsFor(uri, (d) => d.length > 0);
    expect(errors.map((d) => d.message.split("\n")[0])).toEqual(["this call takes 0 arguments but 1 was given"]);

    rpc.sendNotification("textDocument/didChange", { textDocument: { uri, version: 2 }, contentChanges: [{ text: MAIN }] });
    expect(await diagnosticsFor(uri, (d) => d.length === 0)).toEqual([]);

    const hover = await rpc.sendRequest("textDocument/hover", { textDocument: { uri }, position: { line: 3, character: 22 } });
    expect(hover).toMatchObject({ contents: { kind: "markdown", value: expect.stringContaining("function String.toUpperCase():String") } });

    const def = await rpc.sendRequest("textDocument/definition", { textDocument: { uri }, position: { line: 3, character: 12 } });
    expect(def).toEqual([{ uri, range: { start: { line: 2, character: 8 }, end: { line: 2, character: 16 } } }]);

    const items = (await rpc.sendRequest("textDocument/completion", { textDocument: { uri }, position: { line: 3, character: 19 } })) as { label: string }[];
    expect(items.map((i) => i.label)).toContain("toUpperCase");

    await rpc.sendRequest("shutdown");
    rpc.sendNotification("exit");
  } finally {
    rpc.dispose();
    server.kill();
  }
}, 20_000);
