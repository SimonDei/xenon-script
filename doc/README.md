# The XenonScript Book

This is a practical guide to the XenonScript language and compiler. Read it in order for a
progressive introduction, or jump directly to a topic.

## Part I: The language

1. [Getting started](01-getting-started.md) — projects, the main constructor, build/check/run/watch,
   configuration, and generated output.
2. [Values and syntax](02-values-and-syntax.md) — declarations, constants, strings, arrays, objects,
   operators, destructuring, and semicolon insertion.
3. [Types and null safety](03-types-and-null-safety.md) — primitive types, classes, `*`, unions,
   tuples, typedefs, nullable values, casts, and narrowing.
4. [Control flow and functions](04-control-flow-and-functions.md) — conditions, loops, ranges,
   switch, returns, functions, closures, and `defer`.
5. [Classes and objects](05-classes-and-objects.md) — fields, constructors, accessors, visibility,
   static members, inheritance, abstract classes, const methods, and operator overloading.
6. [Interfaces, generics, and contracts](06-interfaces-and-generics.md) — interfaces, structural
   typedefs, generic classes and methods, enums, iteration, class values, and attributes.

## Part II: The platform

7. [Asynchrony, errors, and resources](07-async-errors-and-resources.md) — promises, `await`,
   exceptions, scoped destructors, `using`, cleanup, and error suppression.
8. [Compile-time programming](08-compile-time-programming.md) — `inline`, `constexpr`, `consteval`,
   `nameof`, constant evaluation, and its boundaries.
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
| Project layout, `xenon.json`, build/run/watch | [1](01-getting-started.md) |
| Variables, `final`, `const`, inference, strings, literals, operators, destructuring, ASI | [2](02-values-and-syntax.md) |
| Primitive classes, arrays, tuples, unions, shapes, `*`, nullable types, `is`, `as`, narrowing | [3](03-types-and-null-safety.md) |
| `if`, loops, ranges, `switch`, `break`, `continue`, functions, arrows, closures, `defer` | [4](04-control-flow-and-functions.md) |
| Classes, constructors, fields, accessors, visibility, `static`, inheritance, abstract/final, const methods, operator methods | [5](05-classes-and-objects.md) |
| Interfaces, generics, typedefs, enums, iteration, `Class<T>`, attributes | [6](06-interfaces-and-generics.md) |
| Async functions, exceptions, catches, `finally`, scoped destructors, `using` | [7](07-async-errors-and-resources.md) |
| Inline constants, `constexpr`, `consteval`, `nameof`, compile-time limits | [8](08-compile-time-programming.md) |
| Packages, Xenon/JS imports, `.d.ts`, vendor code, `native`, global packages | [9](09-packages-and-javascript.md) |
| Built-in types, collections, web APIs, events, DOM, globals | [10](10-standard-library.md) |
| CLI, config, JS/TS output, bundles, source maps, LSP, diagnostics | [11](11-compiler-and-editor.md) |
| Keywords, modifiers, operators, type notation, current limitations | [12](12-reference.md) |
