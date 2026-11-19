/**
 * The VS Code client: starts the Xenon language server (`xenon lsp`) for `.xn` files.
 * The server is bundled into the extension (`dist/server.js`) and runs with Bun, which XenonScript
 * needs anyway; `xenon.server.path` points it at another `cli.ts` (a checkout of the compiler).
 */
import * as vscode from "vscode";
import { LanguageClient, type LanguageClientOptions, type ServerOptions } from "vscode-languageclient/node";

let client: LanguageClient | undefined;

function serverOptions(context: vscode.ExtensionContext): ServerOptions {
  const config = vscode.workspace.getConfiguration("xenon");
  const bun = config.get<string>("bunPath") || "bun";
  const custom = config.get<string>("server.path");
  const args = custom ? [custom, "lsp"] : [context.asAbsolutePath("dist/server.js")];
  return { command: bun, args: [...args, "--stdio"] };
}

async function start(context: vscode.ExtensionContext) {
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "xenon" }],
    // Files changed outside the editor (git checkout, a code generator) reach the server too.
    synchronize: { fileEvents: vscode.workspace.createFileSystemWatcher("**/*.xn") },
  };
  client = new LanguageClient("xenon", "XenonScript", serverOptions(context), clientOptions);
  try {
    await client.start();
  } catch (e) {
    const message = `XenonScript: the language server didn't start (${(e as Error).message}). Is Bun installed? Set "xenon.bunPath" if it isn't on the PATH.`;
    void vscode.window.showErrorMessage(message);
  }
}

export async function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand("xenon.restartServer", async () => {
      await client?.stop();
      await start(context);
    }),
    // `xenon.json` decides the source root and main class: start over when it changes.
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.uri.path.endsWith("/xenon.json")) void vscode.commands.executeCommand("xenon.restartServer");
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("xenon")) void vscode.commands.executeCommand("xenon.restartServer");
    }),
  );
  await start(context);
}

export async function deactivate() {
  await client?.stop();
}
