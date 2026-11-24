# Chapter 11: Compiler and editor workflow

This chapter describes the tools around the language: the `xenon` command, the project file, the
output targets, diagnostics, and the VS Code extension.

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

| Setting | Option | Meaning |
|---|---|---|
| `src`, `out` | `--src`, `--out` | source and output folders |
| `main` | `--main` | the main class, by qualified name |
| `target` | `--target js\|ts` | JavaScript (default) or TypeScript output |
| `bundle` | `--bundle` | one `xenon-main.js` instead of a module per file |
| `sourceMaps` | `--no-source-maps` | write `.js.map` files (default on) |
| `nullSafety` | `--no-null-safety` | null safety (default on; see [chapter 3](03-types-and-null-safety.md#null-safety)) |
| `semicolons` | `--semicolons` | `always`, `never` or `any` (below) |
| `denyWarnings` | `--deny-warnings` | warnings fail the build |
| `maxErrors` | `--max-errors` | stop listing after this many errors (default 50) |
| `globals` | | packages a page loads with `<script>` ([chapter 9](09-packages-and-javascript.md#script-globals)) |
|  | `--format pretty\|json` | human-readable or JSON diagnostics |
|  | `--color auto\|always\|never`, `--quiet` | terminal output |

### Semicolons

A line break ends a statement, so semicolons are optional; a `;` is only needed between two
statements on one line. `"semicolons"` (or `--semicolons`) makes a project consistent:

- `"always"`: every statement and declaration ends with `;` — a missing one is error X0884
- `"never"`: a `;` at the end of a line is error X0885 (between statements on one line it stays)
- `"any"` (the default): both are fine

Both errors carry a quick fix that adds or removes the `;`. The standard library keeps its own style.

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

A **warning** can be silenced where it occurs, with a comment naming its code, on the line above or
earlier on the same line:

```actionscript check
// xenon-allow X0850
var later
var other = /* xenon-allow X0840 */ undefined
```

Errors can't be silenced. `--max-errors` prevents a single cascade from overwhelming the output, and
`--deny-warnings` turns warnings into failures (for CI).

`--format json` prints the diagnostics as a JSON array, for other tools: each entry has `severity`,
`code`, `message`, `labels` (with file, line, column and offsets), `notes`, and `help` entries with
their `edits`.

## Source maps and runtime stacks

Source maps point back to `.xn` files. Node can use them with `--enable-source-maps`; `xenon run`
maps stack frames itself.

## VS Code extension

The extension in [`../packages/vscode-xenon`](../packages/vscode-xenon) runs the compiler's language
server (`xenon lsp`), which recompiles the project as you type. It provides:

- **diagnostics** as you type, with the compiler's notes; every suggested fix is a **quick fix**
  (`Ctrl+.`): conversions, `override`, missing interface members, `const` on a method, `;`, …
- **completion** that knows its context: members after `.` (typed by the receiver, and leaving out
  what a `const` view can't use), types in annotations, the expected shape's keys in an object
  literal, locals and imports elsewhere, also inside half-typed code
- **hover** with the declaration and its doc comment, for every name, including the standard
  library's and imported JavaScript's
- **signature help** inside calls, with overloads and the active parameter
- **go to definition**, also into the standard library's declarations and `.d.ts` files
- **find references** and **rename**: renaming a public class renames its file too; overriding
  methods are renamed together
- **document outline** and **semantic highlighting** (properties, members, types)

TypeScript's own errors on the generated code are shown too, where XenonScript itself only knows a
value as `*`.

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

- the book: every ```` ```actionscript check ```` example in `doc/` is compiled, its `// error Xnnnn`
  comments are checked, and examples followed by ```` ```text output ```` are run
  (`tests/docs.test.ts`)
- lexer/parser and diagnostics snapshots
- end-to-end execution of every example
- standard-library runtime conformance
- JS/TS interop and generated TypeScript checks
- source maps
- language server and VS Code grammar
- watch mode

When changing language behavior, add one focused runtime test and/or one diagnostic fixture that
would fail without the change.
