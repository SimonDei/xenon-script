# XenonScript

A class-based, statically typed language in the style of ActionScript 3 that compiles to readable,
vanilla ES-module JavaScript and can import any JavaScript/npm library.

```actionscript
// a file in the source root may leave out `package { … }`; in folders: `package com.zoo { … }`
import { basename } from 'node:path'

public class Main {
  private var count:int
  public static const GREETING:String = 'Hello'

  public function Main() {
    count += 2
    trace($'{GREETING}, count is {count}')   // template strings: $'…{expr}…'
    trace(~/^ma/i.test(basename('/x/Main.xn')))
  }
}
```

## Nullable types

`int?` (or `Null<int>`) is an `int` that may be `null`; `String`, arrays and class types can always
be null. Results that may be missing are typed that way (`map.get(key)` is `V?`), and using one
needs a value: `map.get(key) ?? 0`, `if (var n:int = map.get(key)) …`, or `n?.toFixed(2)`. A null
check narrows a local or parameter: after `if (n != null)`, `if (n == null) return`, `n != null && …`
or `n ??= 0`, `n` is an `int`.
`examples/nullable` shows the rules.

## Standard library

The built-in types are declared in XenonScript itself, in `src/prelude/std/*.xn` (no import needed), and
checked against the JavaScript runtime by `tests/std.test.ts`:
`String`, `Float`/`int`/`uint`, `Boolean`, `Array<T>`, `Map<K, V>`, `Set<T>`, `Iterator<T>`, `Promise<T>`,
`RegExp`, `Date`, `JSON`, `Math`, `Object`, `Function` and `console`,
plus the global functions `setTimeout`/`setInterval`/`clearTimeout`/`clearInterval`, `queueMicrotask`,
`structuredClone`, `fetch`, `encodeURIComponent` & co. and `atob`/`btoa`. `examples/std` shows each of them in use.
JavaScript globals without a declaration yet (`process`, `URL`, `WeakMap`, …) are untyped `*`.
Iteration is C#-style: `IEnumerable<T>` (`getEnumerator()`) and `IEnumerator<T>` (`moveNext()`,
`current`). Arrays, strings, `Set`, `Map` and `Iterator` are enumerable, and a class implementing
`IEnumerable<T>` works with `for … of` (also from JavaScript); see `examples/enumerable`.

## Usage

```bash
bun install
bun src/cli.ts run   --src examples/basics/src --out /tmp/out   # build + run
bun src/cli.ts build                                            # uses xenon.json if present
bun src/cli.ts check                                            # type-check only
bun src/cli.ts watch --run                                      # rebuild + restart on every change
bun src/cli.ts explain X0308                                    # explain an error code
bun src/cli.ts lsp                                              # language server (stdio), for editors
bun test                                                        # unit, end-to-end and diagnostic snapshot tests
UPDATE=1 bun test tests/errors.test.ts                          # rewrite diagnostic snapshots
```

Builds write a source map (`.js.map`) next to every module, so debuggers, browsers and
`node --enable-source-maps` show the `.xn` files; `xenon run` maps stack traces itself (Bun ignores
maps of plain `.js`). `--no-source-maps` turns them off.

`--target ts` (or `"target": "ts"` in `xenon.json`) writes typed TypeScript instead: annotations,
generics, `private`/`protected`, interfaces as TypeScript interfaces, typedefs as `type`, enums as
union types. TypeScript accepts the output of every example (`tests/tsemit.test.ts`), and Bun runs it
directly (`xenon run --target ts`). `compileProject(…, { target: "ts" })` also returns token mappings
between each `.xn` file and its `.ts` module.

`xenon lsp` is a language server (LSP over stdio) for editors: diagnostics as you type, hover with
Xenon types and doc comments, go to definition (also into the standard library and `.d.ts` files),
and completion. Xenon's checker answers for Xenon code; TypeScript runs over the virtual `.ts`
files and adds the types of JavaScript and npm imports (and errors in their use) where Xenon only
knows `*`. The VS Code extension in `packages/vscode-xenon` bundles it (with syntax highlighting):
`cd packages/vscode-xenon && bun install && bun run package && code --install-extension xenon.vsix`.

Project layout: `src/` (compiler), `examples/<name>/src` + `expected.txt` (golden end-to-end tests),
`tests/errors/*.xn` + `*.stderr` (rendered diagnostics snapshots).
