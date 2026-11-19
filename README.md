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
`String`, `Float`/`int`/`uint`, `Boolean`, `Array<T>`, `Map<K, V>`, `Set<T>`, `Iterator<T>`, `Promise<T>`, `Response`, `Blob`, `ArrayBuffer`,
`RegExp`, `Date`, `JSON`, `Math`, `Object`, `Function` and `console`,
plus the global functions `setTimeout`/`setInterval`/`clearTimeout`/`clearInterval`, `queueMicrotask`,
`structuredClone`, `fetch`, `encodeURIComponent` & co. and `atob`/`btoa`. `examples/std` shows each of them in use.
JavaScript globals without a declaration yet (`process`, `WeakMap`, …) are untyped `*`.

JavaScript imports are typed from their `.d.ts` files (`@types/node`, Bun's types, a package's own
types), found in `node_modules` from the source root: `import { readFileSync } from 'node:fs'`
then `var n:int = readFileSync(f, 'utf8')` is an error (the `'utf8'` overload returns a `String`),
and `path.nope` is unknown. Namespaces become classes of statics, exported classes native classes
(`new`, `is`, subclassing), interfaces with methods native classes, other object types typedef
shapes; whatever has no Xenon equivalent (most unions, intersections, tuples, type parameters) is
`*` member by member, and a package without types stays `*` altogether. See `examples/declarations`.

A JavaScript library can also live in the source folder with its `.d.ts` (say `src/lib/xlsx.js` and
`src/lib/xlsx.d.ts`): `import * as XLSX from './lib/xlsx.js'` (relative to the importing file) is typed
from the `.d.ts`, its exported types are named `XLSX.WorkBook`, and the build copies the folder's
`.js`/`.mjs`/`.cjs`/`.json`/`.d.ts` files to the output, so the import works at run time. See
`examples/vendor`.
Iteration is C#-style: `IEnumerable<T>` (`getEnumerator()`) and `IEnumerator<T>` (`moveNext()`,
`current`). Arrays, strings, `Set`, `Map` and `Iterator` are enumerable, and a class implementing
`IEnumerable<T>` works with `for … of` (also from JavaScript); see `examples/enumerable`.

## Usage

```bash
bun install
bun src/cli.ts run   --src examples/basics/src --out /tmp/out   # build + run
bun src/cli.ts run   --project examples/bundle                  # a project folder (its xenon.json)
bun src/cli.ts build                                            # uses xenon.json if present
bun src/cli.ts check                                            # type-check only
bun src/cli.ts watch --run                                      # rebuild + restart on every change
bun src/cli.ts build --bundle                                   # one out/xenon-main.js (also run/watch)
bun src/cli.ts explain X0308                                    # explain an error code
bun src/cli.ts lsp                                              # language server (stdio), for editors
bun test                                                        # unit, end-to-end and diagnostic snapshot tests
UPDATE=1 bun test tests/errors.test.ts                          # rewrite diagnostic snapshots
```

Builds write a source map (`.js.map`) next to every module, so debuggers, browsers and
`node --enable-source-maps` show the `.xn` files; `xenon run` maps stack traces itself (Bun ignores
maps of plain `.js`). `--no-source-maps` turns them off.

`--bundle` (or `"bundle": true`) writes the compiled `.xn` files as one module, `out/xenon-main.js`,
with Bun's bundler: prelude classes the program doesn't use are left out, and vendor code stays
outside: npm packages and `node:`/`bun:` modules remain imports, the source folder's JavaScript
files are copied next to it and imported by their path. Its source map points at the `.xn` files,
so `xenon run --bundle` reports errors at their Xenon position as usual. See `examples/bundle`
(bundled through its `xenon.json`).

`--target ts` (or `"target": "ts"` in `xenon.json`) writes typed TypeScript instead: annotations,
generics, `private`/`protected`, interfaces as TypeScript interfaces, typedefs as `type`, enums as
union types. TypeScript accepts the output of every example (`tests/tsemit.test.ts`), and Bun runs it
directly (`xenon run --target ts`). `compileProject(…, { target: "ts" })` also returns token mappings
between each `.xn` file and its `.ts` module.

`xenon lsp` is a language server (LSP over stdio) for editors: diagnostics as you type with quick
fixes, hover with Xenon types and doc comments, go to definition (also into the standard library
and `.d.ts` files), completion, signature help, find references, rename (a class's file too) and
the outline. Xenon's checker answers, JavaScript imports included; TypeScript runs over the
virtual `.ts` files and adds what Xenon types as `*` (a parameter typed `string | Buffer`, packages
without types: TypeScript's hover, signatures and errors). The VS Code extension in `packages/vscode-xenon` bundles it (with syntax highlighting):
`cd packages/vscode-xenon && bun install && bun run package && code --install-extension xenon.vsix`.

Project layout: `src/` (compiler), `examples/<name>/src` + `expected.txt` (golden end-to-end tests),
`tests/errors/*.xn` + `*.stderr` (rendered diagnostics snapshots).

## License

Public domain, under [CC0 1.0 Universal](LICENSE): use, change and distribute Xenon, and the
programs you compile with it, for any purpose and without conditions. Where dedicating a work to
the public domain isn't possible, CC0's fallback license grants the same freedoms.
