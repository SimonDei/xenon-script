# XenonScript for VS Code

Syntax highlighting for the XenonScript language (`.xn` files). No IntelliSense yet: that comes with
the language server (PLAN.md, Part D).

- **Grammar** `syntaxes/xenon.tmLanguage.json`: keywords and modifiers, declarations (classes,
  interfaces, enums, typedefs, functions, getters/setters, `operator+`, destructors `~Name()`,
  `native('JsName')`), types (built-ins, `Int`/`Bool`/… aliases, `*` after `:`, function types
  `(Int) -> Void`), `'…'` strings and `$'…{expr}…'` templates (expressions inside are highlighted,
  nested strings included), `~/regex/flags`, numbers (`1_000`, `0xFF`, `0..10` as a range),
  `for (… of a..b step n)`, `/* xenon-allow X0840 */` comments. `"…"` and `` `…` `` strings and
  reserved words are marked as errors, as the compiler rejects them.
- **Language configuration** `language-configuration.json`: comments, brackets, auto-closing
  single quotes, indentation, `/** … */` continuation, `// #region` folding.

## Install (local)

Link the folder into your VS Code extensions directory and reload the window
(**Developer: Reload Window**):

```sh
# VS Code on Linux/macOS
ln -s "$PWD/packages/vscode-xenon" ~/.vscode/extensions/xenon.vscode-xenon-0.1.0
# VS Code connected to WSL / SSH (extensions live on the remote side)
ln -s "$PWD/packages/vscode-xenon" ~/.vscode-server/extensions/xenon.vscode-xenon-0.1.0
```

Or build a package and use **Extensions: Install from VSIX…**:

```sh
cd packages/vscode-xenon && bunx @vscode/vsce package --allow-missing-repository
```

## Development

- `bun test tests/grammar.test.ts` tokenizes with VS Code's own engine (`vscode-textmate` +
  `vscode-oniguruma`): targeted cases plus every `.xn` file in the repository (no region left
  open, no illegal tokens outside the error test cases).
- `bun packages/vscode-xenon/scripts/tokens.ts "var s:String = \$'Hi {name}'"` prints the scopes
  of each token, for debugging the grammar. In VS Code, **Developer: Inspect Editor Tokens and
  Scopes** shows the same for the open file.
