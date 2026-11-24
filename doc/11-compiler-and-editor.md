# Chapter 11: Compiler and editor workflow

## Commands

```text
xenon build    [options]           compile the project
xenon check    [options]           type-check only
xenon run      [options] [-- args] build, then run with Bun
xenon watch    [options] [-- args] rebuild on changes
xenon explain  <code>              explain a diagnostic code
xenon lsp                          run the language server
```

From this repository:

```sh
bun src/cli.ts check
bun run xenon -- check
```

`watch --run` restarts the child process after a successful build and stops it before the next
launch. `--no-clear` preserves terminal history.

## `xenon.json`

```json
{
  "src": "src",
  "out": "out",
  "main": "com.example.Main",
  "target": "js",
  "bundle": false,
  "sourceMaps": true,
  "nullSafety": true,
  "semicolons": "any",
  "denyWarnings": false,
  "maxErrors": 50,
  "globals": {
    "pizzip": "PizZip"
  }
}
```

Paths are relative to `xenon.json`. Command-line options override the project file.

### Semicolons

A line break ends a statement, so semicolons are optional; a `;` is only needed between two
statements on one line. `"semicolons"` (or `--semicolons`) makes a project consistent:

- `"always"`: every statement and declaration ends with `;` — a missing one is warning X0884
- `"never"`: a `;` at the end of a line is warning X0885 (between statements on one line it stays)
- `"any"` (the default): both are fine

Both warnings carry a quick fix that adds or removes the `;`; `--deny-warnings` turns them into
errors. The standard library keeps its own style.

## Output targets

### ES-module JavaScript

The default target creates one module per source file, imports only needed prelude code, and writes
source maps.

Visibility is preserved in the output:

- private members become JavaScript `#private`
- readonly/final state cannot be assigned by JavaScript consumers
- ordinary `var` fields remain normal enumerable properties

### Bundled JavaScript

```sh
xenon build --bundle
```

This creates one `xenon-main.js`. Compiled Xenon modules are bundled; npm packages, `node:`/`bun:`
imports, and local JavaScript files remain external where appropriate.

### TypeScript

```sh
xenon build --target ts
```

The compiler emits typed interfaces, aliases, generics, classes, and annotations. Source maps are not
needed for this target. Bun can execute the generated TypeScript directly.

## Diagnostics

Diagnostics use stable codes:

```text
error[X0308]: mismatched types
 --> src/Main.xn:5:21
```

Each diagnostic can include:

- a primary label
- secondary locations
- explanatory notes
- one or more fix-it edits
- a rendered help message

Inspect any documented code:

```sh
xenon explain X0308
xenon explain X0528
```

Use `xenon-allow Xxxxx` in a comment to suppress a specific diagnostic. `--max-errors` prevents a
single cascade from overwhelming the output.

## Source maps and runtime stacks

Source maps point back to `.xn` files. Node can use them with `--enable-source-maps`; `xenon run`
maps stack frames itself.

## VS Code extension

The extension in [`../packages/vscode-xenon`](../packages/vscode-xenon) provides:

- syntax and semantic highlighting
- live diagnostics and quick fixes
- completion that knows its context (types in annotations, the expected shape's keys in an object literal, members after `.`), also inside half-typed code
- hover and signature help
- go to definition
- references and rename
- document outline
- typed `.d.ts` awareness

Install it from this repository:

```sh
cd packages/vscode-xenon
bun install
bun run package
code --install-extension xenon.vsix
```

Two settings are important:

- `xenon.bunPath`: Bun executable
- `xenon.server.path`: a compiler checkout's `src/cli.ts` for extension/compiler development

Each open file finds its nearest project through `xenon.json`.

## Testing the compiler

```sh
bun test
bun run typecheck
UPDATE=1 bun test tests/errors.test.ts
```

Tests include:

- lexer/parser and diagnostics snapshots
- end-to-end execution of every example
- standard-library runtime conformance
- JS/TS interop and generated TypeScript checks
- source maps
- language server and VS Code grammar
- watch mode

When changing language behavior, add one focused runtime test and/or one diagnostic fixture that
would fail without the change.
