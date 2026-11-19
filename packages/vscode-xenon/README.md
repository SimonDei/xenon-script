# XenonScript for VS Code

Language support for XenonScript (`.xn` files): syntax highlighting, plus a language server
(`xenon lsp`, bundled) for diagnostics as you type, hover, go to definition and completion.

- **Language server** (`dist/server.js`, built from the compiler's `src/lsp.ts`): Xenon's own
  errors and warnings in every file of the project, and TypeScript's errors where Xenon only knows
  `*` (the types of JavaScript and npm imports come from their `.d.ts`). Hover shows Xenon types and
  `/** … */` comments; go to definition reaches Xenon declarations, the standard library and
  `.d.ts` files; completion after `.` lists the members of the receiver's type. Also signature
  help, find references, rename (overrides together; a public class's file is renamed with it),
  the outline (**Go to Symbol in Editor**) and quick fixes from the compiler's suggestions. The project is the
  workspace folder: its `xenon.json` (`src`, `main`) or `src/` and `Main`. It runs with **Bun**,
  which must be installed (`xenon.bunPath` if it isn't on the `PATH`).
- **Grammar** `syntaxes/xenon.tmLanguage.json`: keywords and modifiers, declarations (classes,
  interfaces, enums, typedefs, functions, getters/setters, `operator+`, destructors `~Name()`,
  `native('JsName')`), types (built-ins, `Int`/`Bool`/… aliases, `*` after `:`, function types
  `(Int) -> Void`), `'…'` strings and `$'…{expr}…'` templates (expressions inside are highlighted,
  nested strings included), `~/regex/flags`, numbers (`1_000`, `0xFF`, `0..10` as a range),
  `for (… of a..b step n)`, `/* xenon-allow X0840 */` comments. `"…"` and `` `…` `` strings and
  reserved words are marked as errors, as the compiler rejects them.
- **Language configuration** `language-configuration.json`: comments, brackets, auto-closing
  single quotes, indentation, `/** … */` continuation, `// #region` folding.

Settings: `xenon.bunPath` (default `bun`), `xenon.server.path` (run a compiler checkout's
`src/cli.ts` as the server instead of the bundled one, for working on the compiler). Command:
**XenonScript: Restart Language Server** (also automatic when `xenon.json` is saved or a setting changes).

## Install

```sh
cd packages/vscode-xenon
bun install
bun run package                       # builds dist/ and writes xenon.vsix
code --install-extension xenon.vsix   # or: Extensions: Install from VSIX…
```

Then reload the window (**Developer: Reload Window**). With VS Code connected to WSL or SSH, run
`code` in the remote terminal: the extension installs on the remote side, next to the project.

## Development

- `bun run build` bundles the client (`dist/extension.js`, CommonJS, `vscode` external) and the
  server (`dist/server.js`, for Bun, with the compiler and TypeScript inside; TypeScript's
  `lib.*.d.ts` are copied next to it, where TypeScript looks for them).
- `tests/lsp.test.ts` (in the repository root) runs an LSP session over stdio against both
  `xenon lsp` and the bundled server; `tests/service.test.ts` tests the service behind it.

- `bun test tests/grammar.test.ts` tokenizes with VS Code's own engine (`vscode-textmate` +
  `vscode-oniguruma`): targeted cases plus every `.xn` file in the repository (no region left
  open, no illegal tokens outside the error test cases).
- `bun packages/vscode-xenon/scripts/tokens.ts "var s:String = \$'Hi {name}'"` prints the scopes
  of each token, for debugging the grammar. In VS Code, **Developer: Inspect Editor Tokens and
  Scopes** shows the same for the open file.
