# The XenonScript Book

This is a practical guide to the XenonScript language and compiler. Read it in order for a
progressive introduction, or jump directly to a topic.

The examples are real: every code block marked as checked is compiled by the test suite
(`tests/docs.test.ts`), the errors its comments name (`// error X0308`) must be reported on those
lines and nowhere else, and where a block is followed by its output, the program is run and must
print exactly that.

## Part I: The language

1. [Getting started](01-getting-started.md) — a project, a small program step by step, errors, the
   generated output, and the development loop.
2. [Values and syntax](02-values-and-syntax.md) — declarations and inference, numbers and their
   arithmetic, strings, conditions, operators, arrays and objects, comprehensions, destructuring,
   and semicolons.
3. [Types and null safety](03-types-and-null-safety.md) — how types fit together, null safety and
   narrowing, `*`, unions, `is`/`as`, shapes and typedefs, function types, checked indexes, tuples
   and records.
4. [Control flow and functions](04-control-flow-and-functions.md) — conditions and binding
   conditions, loops, ranges, `switch`, functions, local functions, arrows, closures, method values,
   property references, and `defer`.
5. [Classes and objects](05-classes-and-objects.md) — fields, constructors, accessors and
   properties, visibility, static members, inheritance, abstract classes, operators, const methods,
   and read-only views (`const T`).
6. [Interfaces, generics, and contracts](06-interfaces-and-generics.md) — interfaces, equality and
   ordering, generics, constraints, variance, enums, iteration, class values, and attributes.

## Part II: The platform

7. [Asynchrony, errors, and resources](07-async-errors-and-resources.md) — async functions,
   forgotten promises, exceptions and JavaScript errors, scoped destructors, `IDisposable` and
   `using`, and choosing a cleanup mechanism.
8. [Compile-time programming](08-compile-time-programming.md) — `inline` constants, `constexpr`
   functions, methods and constructors, `consteval`, `nameof`, and evaluation limits.
9. [Packages and JavaScript interoperability](09-packages-and-javascript.md) — packages, imports,
   JavaScript types, `.d.ts`, vendor files, native declarations, and global-script packages.
10. [The standard library](10-standard-library.md) — collections, strings, date/time, JSON, web
    primitives, events, DOM, timers, and other globals.

## Part III: Reference and workflow

11. [Compiler and editor workflow](11-compiler-and-editor.md) — CLI commands, configuration,
    JavaScript/TypeScript targets, bundling, diagnostics, source maps, VS Code, watch mode, and tests.
12. [Language quick reference](12-reference.md) — declaration modifiers, keywords, operators,
    type syntax, diagnostics, and current unsupported features.

## Complete runnable examples

Each chapter points to programs under [`../examples`](../examples). Those programs are also used by
the end-to-end test suite and have checked-in output.

For a compact project overview, see the [root README](../README.md). For the implementation plan and
detailed design notes, see [`PLAN.md`](../PLAN.md).

## Feature map

| Feature | Chapter |
|---|---|
| Project layout, `xenon.json`, build/run/watch, generated output | [1](01-getting-started.md) |
| Variables, `final`, `const`, inference, number types and arithmetic, strings, templates, regex literals, `Bool` conditions, operators, array comprehensions, object literals, destructuring, semicolons | [2](02-values-and-syntax.md) |
| Type compatibility, null safety, `T?`, narrowing, `if (var …)`, `*`, `Object`, unions and literal types, `is`, `as`, `(expr : Type)`, conversions, shapes and typedefs (also inside a class), `A & B`, function types, integer sizes, checked indexes, tuples, records | [3](03-types-and-null-safety.md) |
| `if`, binding conditions, loops, ranges, `switch`, functions, defaults, rest parameters, local functions, arrows, `final`/`const` parameters, closures, method values, `Type::member`, `defer` | [4](04-control-flow-and-functions.md) |
| Classes, fields, constructors, accessors, properties, visibility, `static`, static classes, inheritance, `override`, abstract/final, `toString`, operator methods, const methods, read-only views (`const T`), `unconst` | [5](05-classes-and-objects.md) |
| Interfaces, `IEquatable`, `IComparable`, generics, constraints, `A & B` bounds, defaults, variance, enums, iteration, `Class<T>`, attributes, `[Deprecated]`, `[NoDiscard]` | [6](06-interfaces-and-generics.md) |
| Async functions, `void` for unawaited promises, exceptions, JavaScript errors, `catch`, `finally`, scoped destructors, `IDisposable`, `using` | [7](07-async-errors-and-resources.md) |
| Inline constants, `constexpr` (functions, methods, constructors), `consteval`, `nameof`, compile-time limits | [8](08-compile-time-programming.md) |
| Packages, one shared declaration per file, file-private declarations, Xenon/JS imports, `.d.ts`, vendor code, `native`, global packages | [9](09-packages-and-javascript.md) |
| Built-in types, collections, web APIs, events, DOM, globals | [10](10-standard-library.md) |
| CLI, config, JS/TS output, bundles, source maps, LSP, diagnostics | [11](11-compiler-and-editor.md) |
| Keywords, modifiers, operators, type notation, common diagnostics, current limitations | [12](12-reference.md) |
