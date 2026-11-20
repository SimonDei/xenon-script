# XenonScript

**Classes and static types in the style of ActionScript 3, compiled to plain ES-module JavaScript.**

XenonScript (`.xn`) gives you packages, classes, interfaces, generics and nullable types, checked
by a strict compiler with readable error messages. The output is the JavaScript you would have
written by hand, one module per class, with source maps back to your code. Any JavaScript or npm
library can be imported, and is typed from its `.d.ts` files where they exist.

```actionscript
import { basename } from 'node:path'

typedef User = { name:String, ?email:String }

public class Main {
  public static inline final GREETING:String = 'Hello'

  public function Main() {
    var users:Array<User> = [{ name: 'Ann', email: 'ann@example.com' }, { name: 'Bob' }]
    for (var user:User of users) {
      trace($'{GREETING}, {user.name} <{user.email ?? 'no email'}>')
    }
    var best:int? = [3, 8, 5].find((n:int):Boolean => n > 4)   // `T?`: may be null
    trace(best ?? 0, basename('/src/Main.xn'))
    size('https://example.com').then(bytes => trace(bytes, 'bytes'))
  }

  private static async function size(url:String):Promise<int> {
    var res:Response = await fetch(url)
    if (!res.ok) throw new Exception($'{res.status} {res.statusText}')
    var body:Blob = await res.blob()
    return body.size
  }
}
```

## Highlights

- **A real type system.** `int`, `uint` and `Float` are distinct number types. Generics work on
  classes and functions, typedefs describe object shapes, and union, literal and tuple types
  (`int | String`, `'utf8' | 'ascii'`, `Tuple<String, int>`) describe what JavaScript APIs really
  take. `T?` marks a value that may be `null`, and null checks and `is` narrow it. Mixing in
  untyped JavaScript is explicit, through `*`.
- **Errors that explain themselves.** More than 200 error codes, each with a label on the code,
  notes, suggested fixes and `xenon explain <code>`:
  ```
  error[X0308]: mismatched types
   --> src/Main.xn:5:21
    |
  5 |     var lines:int = readFileSync('notes.txt', 'utf8')
    |               ---   ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ expected `int`, found `String`
    |               |
    |               expected because of this type
    |
  help: convert the value with `int()`
  ```
- **JavaScript in, JavaScript out.** Imports of npm packages and `node:`/`bun:` modules are typed
  from their `.d.ts` files. The output is readable ES modules, so a single bundled file or typed
  TypeScript are equally possible.
- **A full editor experience.** The VS Code extension provides diagnostics as you type, quick fixes,
  hover, go to definition, completion, signature help, references, rename and the outline.

## Quick start

XenonScript runs on [Bun](https://bun.sh).

```bash
git clone <this repository> xenon && cd xenon
bun install
cd examples/hello && bun ../../src/cli.ts run      # build an example to out/ and run it
```

A project is a folder with a `src/` directory and, optionally, a `xenon.json`:

```
my-app/
  xenon.json        { "main": "Main" }
  src/
    Main.xn         public class Main { public function Main() { trace('hi') } }
```

```bash
bun /path/to/xenon/src/cli.ts run          # in my-app/: build to out/ and run
bun /path/to/xenon/src/cli.ts watch --run  # rebuild and restart on every change
```

## The language at a glance

| Topic | What it looks like | Example |
|---|---|---|
| Packages and classes | `package com.zoo { public class Animal { … } }`; a file's package matches its folder | [`zoo`](examples/zoo) |
| Inheritance | `extends`, `override`, `super`, `abstract`, `final`, `protected` | [`inheritance`](examples/inheritance), [`abstract`](examples/abstract) |
| Properties | `function get color()` / `function set color(v)`; the setter may be narrower (`private set`) | [`interfaces`](examples/interfaces) |
| Interfaces | `interface IShape { function area():Float }`, checked `implements` | [`interfaces`](examples/interfaces) |
| Variables | `var` (compiles to `let`), `final` and `const` (assigned once: `const`), `inline final` (pasted as its value) | [`basics`](examples/basics) |
| Types | `int`, `uint`, `Float`, `String`, `Boolean`, `Array<T>`, `*` (untyped) | [`types`](examples/types) |
| Unions and literals | `int \| String`, `typedef Encoding = 'utf8' \| 'ascii'`; narrowed by `is`, `==` and null checks | [`types`](examples/types) |
| Tuples | `Tuple<String, int>`: one type per position, `var [key, value] = pair`; `Object.entries` and map entries are tuples | [`tuples`](examples/tuples) |
| Type checks | `(expr : Type)`: checked at compile time, gone at runtime; the value is typed against `Type` (`(['a', 1] : Tuple<String, int>)`, `([] : Array<int>)`) | [`types`](examples/types) |
| Nullable types | `int?`, `?.`, `??`, `??=`, narrowing by null checks | [`nullable`](examples/nullable) |
| Null safety (opt-in) | `"nullSafety": true`: object types exclude `null` too (`String` vs `String?`), fields and locals need a value before use, `as` gives `T?` | [`null-safety`](examples/null-safety) |
| Generics | `class Box<T>`, `function first<T>(items:Array<T>):T?` | [`generics`](examples/generics) |
| Typedefs | `typedef Point = { x:Float, y:Float, ?label:String }`, aliases | [`typedefs`](examples/typedefs) |
| Enums | `enum Color { Red, Green }`, string enums | [`enums`](examples/enums) |
| Functions | arrows with lexical `this`, closures, `async`/`await`, function types `(a:int) -> int`, expression bodies `function area():Float => w * h` | [`functions`](examples/functions), [`closures`](examples/closures) |
| Control flow | ranges `for (var n:int of 0..10)`, `0..=10 step 5`, `for … of`, `switch` | [`control`](examples/control) |
| Destructuring | `var [first, , third, ...tail] = list`, `var { name, address: { city } } = user` | [`destructuring`](examples/destructuring) |
| Exceptions | `Exception` and its subclasses; anything JavaScript throws is normalized | [`exceptions`](examples/exceptions) |
| Resources | destructors `~Connection() { … }`, `using` / `await using` | [`destructors`](examples/destructors) |
| Iteration | `IEnumerable<T>` / `IEnumerator<T>`, usable with `for … of` (also from JavaScript) | [`enumerable`](examples/enumerable) |
| Compile time | `inline` constants, `constexpr` functions (the standard library's `Math` and `String` methods too: `'a b'.replace(~/ /g, '')` folds), `const` methods, operator overloading (`operator+`, `-`, `*`, `/`, `==`) | [`inline`](examples/inline), [`const-methods`](examples/const-methods), [`operators`](examples/operators) |
| Strings | `'single quotes'`, templates `$'Hi {name}'`, regex literals `~/^a+/i` | [`basics`](examples/basics) |

Every folder in [`examples/`](examples) is a complete program with its expected output, and the
test suite runs them all.

## Standard library

The built-in types are declared in XenonScript itself ([`src/prelude/std`](src/prelude/std)),
need no import, and are checked against the JavaScript runtime by the tests:

- **Values:** `String`, `int`/`uint`/`Float`, `Boolean`, `Array<T>`, `Map<K, V>`, `Set<T>`,
  `Iterator<T>`, `RegExp`, `Date`, `JSON`, `Math`, `Object`, `Function`
- **Async and the web platform:** `Promise<T>` (including `all`, `any`, `withResolvers`, …), `fetch`,
  `Response`, `Blob`, `File`, `FormData`, `ArrayBuffer`
- **Events:** `EventTarget` (extend it for events of your own), `Event`
- **Browser DOM:** `Node` (extends `EventTarget`), `Element` and `Document` (extend `Node`), `DOMParser`, `XMLSerializer`,
  `NodeList<T>`, `HTMLCollection`; browser-only,
  and their names stay free for your own classes (`class Node` in your program shadows the DOM's)
- **Globals:** `console`, timers, `queueMicrotask`, `structuredClone`, `encodeURIComponent` & co.,
  `atob`/`btoa`

See [`examples/std`](examples/std) for each of them in use. JavaScript globals without a declaration
yet (`process`, `WeakMap`, …) are untyped (`*`).

## Working with JavaScript

```actionscript
import { readFileSync } from 'node:fs'      // typed from @types/node
import * as XLSX from './lib/xlsx.js'       // a library in your source folder, typed by xlsx.d.ts
import _ from 'lodash'                      // no types installed: `*`
```

- **Typed imports.** Declarations are read from `node_modules` (`@types/*`, Bun's types, a
  package's own types). Namespaces become classes with static members, and exported classes
  become classes you can `new`, test with `is` and subclass. Object types become typedef shapes.
  Fixed-length tuples become `Tuple<…>`. Whatever has no XenonScript equivalent, such as most
  unions, is `*` for that member only. See [`examples/declarations`](examples/declarations).
- **Local libraries.** `.js`, `.mjs`, `.cjs`, `.json` and `.d.ts` files in the source folder are
  copied to the output. They are imported relative to the importing file, and their types can be
  named as `XLSX.WorkBook`. See [`examples/vendor`](examples/vendor).
- **Untyped where you choose.** A package without types is `*`, and so is anything cast with
  `as *`. See [`examples/interop`](examples/interop).
- **The other direction.** Compiled classes are plain JavaScript classes, so JavaScript code can
  import and use them, subclasses and `for … of` included.

## Command line

```bash
xenon build    [options]           # compile the project
xenon check    [options]           # type-check only
xenon run      [options] [-- args] # build, then run with Bun
xenon watch    [options] [-- args] # rebuild on every change (--run: restart the program)
xenon explain  <code>              # explain an error code, e.g. xenon explain X0308
xenon lsp                          # language server over stdio
```

Run it as `bun src/cli.ts …` from this repository (or `bun run xenon -- …`).

| Option | `xenon.json` | Meaning |
|---|---|---|
| `--project <path>` | | a `xenon.json`, or a folder containing one (default: `./xenon.json`) |
| `--src <dir>` | `"src"` | source root (default `src`) |
| `--out <dir>` | `"out"` | output directory (default `out`) |
| `--main <name>` | `"main"` | main class, e.g. `Main` or `com.app.Main` |
| `--bundle` | `"bundle": true` | one `xenon-main.js` for all compiled files (vendor code stays outside) |
| `--target ts` | `"target": "ts"` | write typed TypeScript instead of JavaScript |
| `--no-source-maps` | `"sourceMaps": false` | don't write `.js.map` files |
| `--deny-warnings` | `"denyWarnings": true` | treat warnings as errors |
| `--null-safety` | `"nullSafety": true` | object types exclude `null` unless written `T?` |
| `--max-errors <n>` | `"maxErrors"` | stop after `n` errors (default 50) |
| `--format json` | | machine-readable diagnostics |

Paths in `xenon.json` are relative to the file.

## Output

- **JavaScript (default):** one ES module per class, plus the prelude classes that are used, and a
  source map next to each module. Debuggers and `node --enable-source-maps` show the `.xn` files,
  and `xenon run` maps stack traces itself.
  Visibility holds at runtime too: `private` fields and methods become JavaScript `#private` ones, and
  `final`/`const` fields are read through a getter, so JavaScript code can read but not assign them.
  Plain `var` fields stay ordinary properties (for `JSON.stringify`, spread and proxies).
- **Bundle (`--bundle`):** all compiled modules in one `out/xenon-main.js`, built with Bun's
  bundler, with unused prelude classes left out. npm packages, `node:`/`bun:` modules and your
  JavaScript files stay outside as imports. The source map still points at the `.xn` files.
  See [`examples/bundle`](examples/bundle).
- **TypeScript (`--target ts`):** typed `.ts` modules with annotations, generics, interfaces and
  `type` aliases. TypeScript accepts the output of every example, and Bun runs it directly.

## Editor support

[`packages/vscode-xenon`](packages/vscode-xenon) is a VS Code extension with syntax highlighting
and the language server:

- diagnostics as you type, with quick fixes from the compiler's suggestions
- hover with XenonScript types and doc comments (including the overload a call uses)
- go to definition, also into the standard library (built-in types included) and `.d.ts` files
- completion that knows the context: only types in a type annotation (`xlsx.` lists the package's
  types), the expected shape's keys inside an object literal, members after `.`
- signature help, find references, rename (a class's file too) and the outline
- semantic highlighting for object keys and shape members

The XenonScript checker answers all of these, including for typed JavaScript imports. TypeScript
fills in where a value is untyped (`*`). Each file finds its project through the nearest
`xenon.json`, so one workspace can hold several projects.

```bash
cd packages/vscode-xenon && bun install && bun run package && code --install-extension xenon.vsix
```

## Development

```bash
bun test                                # unit, end-to-end, snapshot, language server and grammar tests
bun run typecheck                       # TypeScript check of the compiler
UPDATE=1 bun test tests/errors.test.ts  # rewrite the diagnostic snapshots
```

| Path | Contents |
|---|---|
| [`src/`](src) | the compiler: lexer, parser, checker, code generator, CLI, language server |
| [`src/prelude/`](src/prelude) | runtime classes (`Prelude.xn`) and standard library declarations (`std/`) |
| [`examples/`](examples) | golden end-to-end tests: `src/` and `expected.txt` |
| [`tests/errors/`](tests/errors) | diagnostic snapshots: `*.xn` and the rendered `*.stderr` |
| [`packages/vscode-xenon/`](packages/vscode-xenon) | the VS Code extension |
| [`PLAN.md`](PLAN.md) | the language design and the milestones so far |

## License

Public domain under [CC0 1.0 Universal](LICENSE). Use, change and distribute XenonScript and the
programs you compile with it for any purpose, without conditions. Where dedicating a work to the
public domain isn't possible, CC0's fallback license grants the same freedoms.
