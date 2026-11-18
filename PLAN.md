# Plan: Klass — an ActionScript-3-style language that compiles to JavaScript

## Progress
- [x] Steps 0–2: scaffolding, CLI (`build`/`check`/`run`), Rust-style diagnostics, lexer, parser, hello world
- [x] Step 3: type checker core (also covers method signatures, arity, static vs instance, `final`/`const`/getter writes from step 5)
- [x] Step 4: control flow — `for`, `for…in`, `for…of`, range loops, `switch`, `if`/`while` bindings, `break`/`continue` checks, missing-return and unreachable-code analysis
- [x] Step 5: static blocks, definite assignment for `final` locals/fields/static fields (assign exactly once, no reads before assignment, not in loops, every constructor path)
- [x] Step 5b: `inline` constants — constant folder (`src/consteval.ts`), cycle detection, value-based fitting, pasted at use sites, private ones not emitted
- [x] Step 6: packages & multi-file — import priority (explicit > package > wildcard), clashes, ambiguous wildcard names, unused/duplicate/redundant import warnings, file-private import errors, qualified type names, module cycles
- [x] Step 7: JS interop — `is`/`as` (Klass classes, JS classes, primitives) as plain JS with hoisted temporaries, `delete` only on dynamic objects, npm (`lodash`) + Node built-ins example, plain JS importing/subclassing compiled classes
- [x] Step 8: inheritance & super — `super(...)` (first statement, no `this` before it, implicit `super()`), `super.member`, mandatory `override` (K0720–K0726), `final` classes/methods, cycles, extending JS classes, accessor-half delegation, inherited statics addressed via the declaring class
- [x] Step 9: visibility — `public`/`internal` (default)/`protected`/`private` on members and constructors (incl. implicit `super()`), `internal` classes across packages, "use the public getter" hints
- [x] Step 10: getters/setters polish (void setters, setter-only reads, matching visibility) and method closures — bound and cached per instance under `Symbol.for('klass.bound.<name>')`, so `this.handle` keeps its identity (`dynamic` classes deferred)
- [x] Step 11: exceptions — prelude `klass/Exception.kl` (written in Klass, one module), `Exception.from`, JS `Error` classes hidden with hints, `throw` only Exceptions (`*` normalized), typed multi-catch/finally with original-value rethrow, catch reachability; codegen now emits one module per source file; classes without a constructor inherit their parent's
- [x] Step 12: functions — `function(){}` expressions (dynamic `this`; bare member names reach the instance via `$self`), arrows (lexical `this`, expression bodies infer their type), hoisted local functions, named function expressions, async methods/functions/arrows with `Promise<T>`, `await` checks with fix-its, closures can't assign outer `final`s
- [x] Step 13: modern syntax — destructuring declarations/assignments/`for…of` patterns (renaming, defaults, nesting, holes, rest; binding types from the source, methods can't be destructured), plus `??=`/`&&=`/`||=`/`**=`, object spread, optional calls
- [ ] Step 14: skipped → standard library (Later)
- [x] Step 15: interfaces — `interface … extends …`, `implements`, member rules, implementation check with a multi-line stubs fix-it, signature/visibility/accessor-half matching, interface types and subtyping, `new` on interfaces rejected, runtime `is`/`as` via `Symbol` markers on prototypes (inherited by subclasses)
- [x] Step 15a: abstract classes — `abstract` classes/members (rules K0710–K0718), missing implementations with an `override` stubs fix-it, abstract classes may defer interface members, `new.target` guard (synthesized constructor when needed) and `NotImplementedException` stubs in the output; bodiless non-abstract methods are now an error; `new` on a local holding a class gives `*`
- [x] Step 15b: typedefs — aliases, structural shapes (optional/`final` members, recursion through members, class instances fit structurally), function types (contravariant params, covariant return, contextual typing of arrows), inline `{…}`/`(…) -> T` types, excess/missing-member checks on literals, unchecked `as`, `is` rejected; typedef files emit nothing
- [x] Step 15c: destructors — `~Name()` / `async ~Name()` → `[Symbol.dispose]`/`[Symbol.asyncDispose]` with a once-only `#disposed` flag and the parent destructor chained in `finally`, implicit `dispose()`, prelude `IDisposable`/`IAsyncDisposable` (implemented automatically, manual implementation rejected), `using` declarations and `using (…)` blocks (type optional: inferred from the value), K0801 for disposables that are never disposed or handed on; prelude file is now `src/prelude/Prelude.kl` (module `klass/Prelude.js`)
- [x] Step 15d: const methods — `:T const` on methods and getters, no writes through `this` (K0901), only const members used on `this`/`super` (K0902), arrows inherit the restriction, `function` expressions don't, overrides and interface implementations must stay const, invalid placements K0903; static fields remain writable
- [x] Step 15e: `operator+` — instance method `['operator+']`, static dispatch on the left operand (strings still concatenate), right operand checked against the parameter, `+=` lowered with object/index evaluated once, inherited/overridable/abstract/interface, visibility and const rules at the use site, K0371–K0373; also `Vector<T>[i]` is now typed `T`
- [x] Step 16: enums — `enum Name { A, B = 2 }` / string enums → `Object.freeze({…})`, auto-numbering, constant values (K0811–K0817), nominal typing, `values()` → `Object.values(E)`, `x is/as Enum` checks raw values, switch exhaustiveness warning (K0814), enum members in `inline` constants; enums and interface symbols are emitted before classes in a module
- [x] Step 17: error quality — unused locals (K0861, `_name` exempt) and private members (K0862), `=` as a condition (K0322), `return`⏎ hints, `--max-errors` cap, `klass-allow` suppression comments, parser recovery that keeps broken declarations/returns (no cascades), error code catalog (`src/codes.ts`, every code covered by a test) and `klass explain <code>`
- [x] Step 17b: watch mode — `klass watch [--run] [--no-clear] [-- args]`: debounced rebuilds, files re-read only when changed, whole-project re-check (fast; signature-based incremental checking deferred until projects need it), only changed outputs written, stale outputs removed, `--run` restarts after successful builds and stops on errors, `klass.json` reload, clean Ctrl+C
- [x] G1: generics — type parameters on classes, interfaces, methods, local functions and typedefs (no bounds), substitution through inheritance and interfaces, invariant type arguments, inference of method/constructor type arguments from arguments (arrows: from their return type) and the expected type, raw types for `is`/`as`, erased output
- [x] G2: native declarations — `native` / `native('JsName')` classes (no output, referenced by JS name, no imports), bodiless public members, statics and constructors, overloads with first-match selection (K0604), closed member sets with the `(x as *)` escape hatch, primitive members from natives named `String`/`Float`/`Boolean`, Klass classes extending natives (K0820/K0821 for code in natives)
- [~] G3: std library — infrastructure done (`src/prelude/std/*.kl` loaded with the prelude, no output; conformance test `tests/std.test.ts` checks every member against Bun incl. return types on sample values; `examples/std`). Types declared: `Boolean`, `Float` (JS `Number`; members shared by `int`/`uint`; overloads where JS has no real default, e.g. `toPrecision()`; `parseInt`/`MAX_SAFE_INTEGER` are `Float`; `is…` tests take `*`; the `Number` global is hidden with a fix-it to `Float`), `int`, `uint` (separate files; AS3-style `MAX_VALUE`/`MIN_VALUE` as `inline` constants — compile-time literals, no runtime object; `native('Number') … extends Float` so they keep the number members, `valueOf()` returns `int`/`uint`; inherited statics like `int.parseInt` stay `Float`), `JSON` (namespace: hidden constructor, `new JSON()` is K0415; overloaded `stringify` with function/key-list replacer and int/String indent; `rawJSON`/`isRawJSON` left out as not yet portable). Fixes along the way: `Boolean(x)`/`String(x)`/`Float(x)` stay casts when a std class has that name; method closures on primitives emit `x.m.bind(x)`; `new Boolean(…)` explains wrapper objects; overload notes print signatures as declared; integer literals before `.` are parenthesized in JS (`(255).toString(16)`); the conformance test also checks static constants' values against their types; `inline` constants allowed in natives; a typedef naming a class (or a primitive with a std class) works as a value: `Int.MAX_VALUE`, `Int(x)`, `Bool(x)`; `Int`/`UInt`/`Bool`/`Any`/`Void` moved from the compiler's built-in table to prelude typedefs
- [x] Part D (partial): VS Code syntax highlighting only — `packages/vscode-klass` (TextMate grammar, language configuration, README with install steps), tested with VS Code's tokenizer (`tests/grammar.test.ts`); no language server / IntelliSense yet
- [ ] Part G: rest of G3 (`String`, `Array`/`Vector<T>`, `Math`, `RegExp`, `Promise<T>`, `Map`, `Set`, `Date`, `console`), G4 migration
- [ ] Part D (VS Code extension) and Later items

## Context
`/home/simon/projects/class-lang` is a fresh Bun + TypeScript project (only `index.ts`, `package.json`, `tsconfig.json`). Goal: build, step by step, a **class-based, statically typed language in the style of ActionScript 3** that compiles to readable ES-module JavaScript and can **natively import and use any JavaScript / npm library** (and be imported from JS).

Decisions so far:
- AS3 syntax & semantics: `package {}`, `public class`, `var`/`const`, `function`, postfix `:Type`, constructor named like the class, `override`, getters/setters, `trace()`.
- Deviations from AS3: generics written `Vector<T>` (no dot), `Float` instead of `Number`, `final` usable on classes, methods, fields, locals and parameters, an `inline` modifier for compile-time constants that are substituted at every use site, and `typedef` (Haxe-style aliases, structural shapes and function types).
- Static types from day one. Priority class features: inheritance + `super`, visibility, static members. Plus **enums**.
- Modern JS additions: **async/await, arrow functions, `?.` / `??`, destructuring & spread**. Strings use single quotes only; template strings are written `$'Hi {name}'`.
- **Optional semicolons** (JS-style automatic semicolon insertion).
- `function(){}` expressions keep **dynamic `this`** (JS/AS3 semantics); arrow functions have lexical `this`. Method references (`btn.onClick = this.handle`) auto-bind, like AS3 method closures.
- JS imports are typed `*` (dynamic); `.d.ts` typing is a later step.
- Imports: `import com.game.Player;` for own code, `import _ from 'lodash';` for JS.
- Entry point: document class — compiler emits `new Main()`.

Working name **Klass**, extension `.kl`.

---

## Part A — Language design reference

### A0. Keywords
**Reserved keywords** (cannot be used as identifiers):
| Group | Keywords |
|---|---|
| Structure | `package` `import` `class` `interface` `enum` `typedef` `extends` `implements` |
| Declarations | `function` `var` `const` `final` (`final` is also a modifier) `using` |
| Modifiers | `public` `private` `protected` `internal` `static` `final` `inline` `abstract` `override` `dynamic` `async` (`const` is also a method suffix) |
| Control flow | `if` `else` `switch` `case` `default` `while` `do` `for` `in` `break` `continue` `return` |
| Exceptions | `throw` `try` `catch` `finally` |
| Expressions | `new` `this` `super` `is` `as` `typeof` `delete` `await` |
| Literals | `true` `false` `null` `undefined` (compatibility only — every use produces warning K0840, see A2) |
| Types | `void` |
| Reserved for future use | `namespace` `use` `with` `yield` `let` `goto` |

**Contextual keywords** (special only in one position, usable as normal identifiers elsewhere):
| Keyword | Special in |
|---|---|
| `get`, `set` | between `function` and a member name: `function get name()` |
| `operator` | after `function`: `function operator+(…)` |
| `from` | JS import clause: `import x from 'pkg'` |
| `of` | value loop: `for (var v:T of coll)` (as in JS, `of` stays usable as a name) |
| `step` | after a range in a loop header: `0..n step 2` |
| `static` block | `static { ... }` inside a class body |

**Built-in type names** (predeclared, not keywords; shadowing is a compile error): `int` `uint` `Float` `String` `Boolean` `Object` `Array` `Vector` `Function` `Promise` `Class` `RegExp`, plus the dynamic type `*`. **Built-in typedefs** (prelude): `Int` `UInt` `Void` `Bool` `Any` (see A2). **Built-in classes** (prelude): `Exception` `ArgumentException` `TypeException` `RangeException` `StateException` `NotImplementedException` (see A6c). `Error` and the JS error classes are hidden.

**Built-in global functions**: `trace` (→ `console.log`), cast functions `int()` `uint()` `Float()` `String()` `Boolean()`.

### A1. File & package structure
```actionscript
package com.zoo {                       // dotted package = directory com/zoo/
  import com.zoo.util.Logger;           // own class
  import com.zoo.util.*;                // whole package
  import _ from 'lodash';               // JS default import  → *
  import { readFile } from 'node:fs/promises';
  import * as path from 'node:path';

  public class Dog extends Animal { ... }   // exactly one public definition per file, name = file name
}

class DogHelper { ... }                 // after the package block: file-private helper (AS3 rule)
```
JS output: `out/com/zoo/Dog.js`, an ES module with `export class Dog`, relative imports between classes, JS imports emitted as-is.

### A2. Types
| Klass | Meaning | JS |
|---|---|---|
| `int`, `uint` | integers (checker-enforced; `int(x)` cast) | number (`int(x)` → `x \| 0`, `uint(x)` → `x >>> 0`) |
| `Float` | floating-point number (replaces AS3's `Number`) | number |
| `String`, `Boolean` | | string, boolean |
| `void` | return type only | — |
| `*` | dynamic/untyped; anything goes, no checks; may be `undefined` | any |
| `Object` | any non-null object, member access unchecked | object |
| `Array` | untyped array (elements `*`) | Array |
| `Vector<T>` | typed array | Array |
| `Function` | any callable (untyped) | function |
| `Promise<T>` | result of `async` functions / JS promises | Promise |
| `Class` | a class reference | constructor |
| `ClassName`, `EnumName` | user types | class / frozen object |
| `{ x:Float, ?label:String }` | structural object type (usually named via `typedef`) | plain object, erased |
| `(Float, Float) -> Float` | function type (usually named via `typedef`) | function, erased |
| `TypedefName` | alias for any of the above (see A6b) | erased |

**Built-in typedefs** (A6b): every compile-time primitive also gets a capitalized alias, so code can use one consistent naming style. They are ordinary transparent typedefs in the prelude (package `klass`, visible in every file without an import), each next to the class it aliases; the compiler itself only knows the lowercase names:
```actionscript
public typedef Int  = int        // src/prelude/std/int.kl
public typedef UInt = uint       // src/prelude/std/uint.kl
public typedef Bool = Boolean    // src/prelude/std/Boolean.kl
public typedef Any  = *          // src/prelude/Prelude.kl
public typedef Void = void       // src/prelude/Prelude.kl (only the prelude may alias `void`)
```
`Int` and `int` are the same type everywhere (messages print the underlying type, `int`). `Void` is only valid where `void` is (return types, function types, `Promise<Void>`; elsewhere K0421). As values they stand for their class like any typedef: `Int.MAX_VALUE`, `Int(x)`, `Bool(x)`. User code cannot redeclare these names (K0028).

Generic syntax is `Name<T>` with no dot (unlike AS3's `Vector.<T>`). Type arguments only appear in type positions (after `:`, `new`, `as`, `is`, and inside other type arguments), so the parser never confuses `<` with less-than. Nested generics like `Vector<Vector<int>>` are handled by splitting `>>` into two `>` tokens in type positions.

**`null` vs `undefined`**: Klass has one "no value", `null`. The `undefined` literal exists only for JS compatibility (e.g. passing it to a library that distinguishes the two) and every use produces **warning K0840**:
```
warning[K0840]: `undefined` is only supported for JavaScript compatibility
  --> src/Main.kl:12:13
   |
12 |   if (x == undefined) return
   |            ^^^^^^^^^ use `null` instead
   |
help: `x == null` matches both null and undefined
   |
12 |   if (x == null) return
   |            ~~~~
```
- The fix-it depends on context: comparisons → `== null` / `!= null` (covers both values, see A5 — while `x == undefined` compiles to strict `x === undefined` and only matches `undefined`); assignments, arguments, returns and initializers → `null`.
- Values that are `undefined` at runtime without being written (missing optional members, JS return values, `*` reads) produce no warning. The null checks Klass generates (`if (var …)`, `?.`, `??`) always use `!= null` so they treat both the same.
- `--deny-warnings` turns it into an error. A single intentional use can be marked with `/* klass-allow K0840 */` directly before it (a general per-line suppression comment usable for any warning code).

Default values (AS3 semantics, emitted explicitly): `int`/`uint` → `0`, `Float` → `NaN`, `Boolean` → `false`, `*` → `null` (Klass never emits `undefined` as a default), everything else → `null`.

Conversions / checks (all plain JS expressions): `int(x)` → `x | 0`, `uint(x)` → `x >>> 0`, `Float(x)` → `Number(x)`, `String(x)`, `Boolean(x)` unchanged; `x as Dog` → `(x instanceof Dog ? x : null)`; `x is Dog` → `x instanceof Dog`; `x is String` → `typeof x === 'string'`, `x is int` → `Number.isInteger(x)`; interfaces see A6. When `x` is not a simple name it's stored in a temp first. AS3's throwing class cast `Dog(x)` is **not supported** (it would need a helper, because JS has no throw expressions); use `as` with `if (var d:Dog = x as Dog)`. `Dog(x)` is K0380 with that fix-it.

### A3. Variables
```actionscript
var a:int = 1               → let a = 1;
const MAX:int = 10          → const MAX = 10;
final id:String             → let id; checker allows exactly one assignment before use (definite assignment)
final id:String = make()    → const id = make();
var x                       → typed * (compiler warning "untyped variable")
var {name, age}:* = obj     → let { name, age } = obj;
var [first, ...rest]:Array = list
```
`var`, `const` and `final` are the three declaration keywords; `final` replaces `var` (never `final var`). Difference: `const` must be initialized where declared; `final` may be assigned later, but exactly once. Parsing `final`: followed by an identifier → declaration; followed by a modifier, `class` or `function` → modifier.
Block-scoped (`let`/`const` in output) — a deliberate break from AS3's function-scoped hoisting, so behavior matches modern JS.

### A4. Control structures (complete list)
| Construct | Klass syntax | JS output |
|---|---|---|
| Block | `{ ... }` | same |
| If / else-if / else | `if (c) {...} else if (d) {...} else {...}` | same |
| If with binding (Swift-style) | `if (var user:User = repo.find(id)) {...} else {...}` — see below | `{ let user = repo.find(id); if (user != null) {...} else {...} }` |
| While with binding | `while (var line:String = reader.readLine()) {...}` | `for (let line; (line = reader.readLine()) != null; ) {...}` |
| Ternary | `c ? a : b` | same |
| Switch | `switch (v) { case 1: case 2: ...; break; default: ... }` — fall-through allowed, strict `===` matching, any expression as case | same |
| While | `while (c) {...}` | same |
| Do-while | `do {...} while (c)` | same |
| C-style for | `for (var i:int = 0; i < n; i++) {...}` | `for (let i = 0; ...)` |
| For-in (keys) | `for (var k:String in obj) {...}` | `for (const k in obj)` (arrays: index strings, like AS3) |
| For-of (values) | `for (var v:T of coll) {...}`, `for (var [k, v]:* of map) {...}` — replaces AS3's `for each` (`for each (...)` is a parse error with a hint to use `of`) | `for (const v of coll)` — always plain `for...of`. The source must be iterable (Array, Vector, String, Map, Set, any JS iterable, `*`). A source typed `Object` is K0390 with the fix-it `Object.values(obj)` |
| Range loop | `for (var i:int of 0..10) {...}` — see below | `for (let i = 0; i < 10; i++)` |
| Break / continue | `break;` `continue;` (no labels for now; `ident:` at statement start is a parse error with a "labels are not supported yet" hint) | same |
| Return | `return expr;` | same |
| Throw | `throw new ArgumentException('x')` — operand must be an `Exception` (see A6c) | same |
| Try / catch / finally with **typed catches** | `try {...} catch (e:TypeException) {...} catch (e:RangeException) {...} catch (e:Exception) {...} finally {...}` | one `catch (e)`, `e = Exception.from(e)` (prelude method, see A6c), then `if (e instanceof TypeException) {...} else if ... else throw e` |
| Await | `var r:* = await fetch(url)` (inside `async` functions) | same |
| Using block | `using (r:Res = open()) {...}`, `await using (...) {...}` (see A6 destructors) | `{ using r = open(); ... }` |

**Ranges in loops** (Rust-style):
```actionscript
for (var i:int of 0..10) { }              // 0,1,…,9      (exclusive end)
for (var i:int of 0..=10) { }             // 0,1,…,10     (inclusive end)
for (var i:int of 0..n step 2) { }        // 0,2,4,…  < n
for (var i:int of 0..items.length) { }    // indices
for (var i:int of 10..0) { }              // runs 0 times: ranges never count down

for (var n:int of 2..) {                  // open range: counts forever, leave with break/return
  if (s.has('value')) break
  s.add($'value_{n}')
}
```
JS output (no allocation, plain counting loops):
```js
for (let i = 0; i < 10; i++) { }
for (let i = 0, $end = n; i < $end; i += 2) { }
for (let n = 2; ; n++) { ... }
```
Rules:
- Bounds are `int` or `uint` expressions, evaluated **once** before the loop (cached in `$end` when not a constant).
- **Ranges only count up.** The loop always tests `i < end` (`..`) or `i <= end` (`..=`), so a range whose start is greater than its end runs **zero times**, as in Rust. When both bounds are constants and the range is empty, the checker warns (K0331: "range `10..0` is empty and runs 0 times"). To count down, use a C-style `for` or `while`.
- `step` (contextual keyword) must be a **positive** compile-time constant (literal or `inline` constant); default `1`. `step 0` or a negative step → error K0330 ("ranges can't count down; use a C-style `for`").
- The loop variable is read-only inside the body (assigning it is K0332), so the range can't be skipped around by accident.
- Ranges are only valid as the source of a `for (… of …)` loop for now. Elsewhere (`var r = 0..10`) the error says "ranges are only supported in loops". First-class `Range` values are a possible later extension.
- Lexer: `..` and `..=` are new tokens, distinct from spread `...`. A number followed by `..` stops before the dot (`0..10` is `0` `..` `10`, not `0.` `.10`).

**If with inline declaration** (like Swift's `if let`):
```actionscript
if (var user:User = repo.find(id)) {
  trace(user.name)                          // user is non-null here
} else {
  trace('not found')                        // user is not in scope here
}

if (var a:Dog = x as Dog, var b:Dog = y as Dog, a.age > b.age) {   // several bindings + extra conditions
  trace(a.name + ' is older')
}

if (var cfg:Config = load() as Config) { ... }
else if (var fallback:Config = defaults()) { ... }
```
Rules:
- The block runs only if every bound value is **not `null`/`undefined`**; this is a null check, not a truthiness check, so `''` passes. Items are evaluated left to right and stop at the first failure. Plain Boolean conditions can be mixed in after the bindings they use.
- Bindings are visible only in the `then` block (and in later items of the same header), not in `else`.
- Binding types must be nullable (class types, `String`, `Object`, `*`, typedef shapes…). `if (var n:int = …)` is an error (K0320: "`int` can never be null; use a normal `if`").
- The binding is a normal mutable `var` inside the block.
- JS output:
  ```js
  { let a, b;
    if ((a = x instanceof Dog ? x : null) != null && (b = y instanceof Dog ? y : null) != null && a.age > b.age) { ... } }
  ```
  The whole thing is wrapped in a block so bindings don't leak; `!= null` covers both `null` and `undefined`.

**While with inline declaration** — same header rules as the `if` form, re-evaluated before every iteration; the loop ends as soon as a binding is `null`/`undefined` or a condition is false:
```actionscript
while (var line:String = reader.readLine()) {
  trace(line)                                        // line is non-null here
}

while (var job:Job = queue.poll(), !stopped) { job.run() }   // binding + extra condition

while (var next:TreeNode = queue.next()) { depth++ }  // a binding can't refer to an outer variable of the same name (K0321)
```
Rules: bindings are visible only in the loop body, are fresh for every iteration (closures created in the body capture that iteration's value), and must have nullable types (K0320 as for `if`). `do … while (var …)` is not supported (the body would run before the binding exists).

JS output uses a `for` with an empty update so each iteration gets its own `let` binding:
```js
for (let line; (line = reader.readLine()) != null; ) { console.log(line); }
for (let job; (job = queue.poll()) != null && !stopped; ) { job.run(); }
```

Deliberately excluded: labels (for now), `with` (breaks static typing), `goto`, E4X/XML literals, `#include`, `use namespace`. `delete obj.key` only allowed on `*`/`Object` values (and `dynamic` instances once they exist).

### A5. Operators & expressions
- Arithmetic `+ - * / % **`, increment/decrement `++ --` (prefix/postfix), unary `- + ! ~`
- Comparison `== != < <= > >=`. **`==` and `!=` are always strict**: compiled to `===` / `!==`, so there is no type coercion (`'1' == 1` is `false`). The one exception is comparing with the `null` literal: `x == null` / `x != null` compile to JS's loose `x == null` / `x != null`, so they match both `null` and `undefined` (consistent with Klass having a single "no value").
  - `===` / `!==` are accepted for JS familiarity but produce warning K0841 ("`===` is the same as `==` in Klass") with a fix-it to the short form.
  - Comparing values whose static types can never be equal (`int == String`, `Dog == Cat` for unrelated classes) is **error K0309** ("this comparison is always false"); comparisons involving `*` or `Object` are unchecked.
  - Loose JS equality is not available; use explicit conversions (`String(n) == s`).
- Logical `&& || !`, nullish `??`, optional chaining `a?.b`, `a?.[i]`, `a?.()`
- Bitwise `& | ^ << >> >>>`
- Assignment `= += -= *= /= %= **= &= |= ^= <<= >>= >>>= &&= ||= ??=`
- Type operators `is`, `as`, `typeof`, `in`, `delete`
- Literals: numbers (`0xFF`, `1_000`, `1e3`), strings `'…'` and template strings `$'Hi {name}'` (see below), regex `~/ab+c/gi` (see below), arrays `[1, 2, ...rest]`, objects `{ a: 1, b, [key]: v, ...other }`, typed vectors from context `var v:Vector<int> = [1, 2, 3]` or explicitly `new Vector<int>([1, 2, 3])`
- Calls with spread `f(...args)`, `new Foo(...)`, indexing `a[i]`, `super(...)`, `super.m()`
- Function expressions `function(x:int):int { return x * 2 }` (dynamic `this`) and arrows `(x:int):int => x * 2`, `async (u:String):Promise<*> => await fetch(u)` (lexical `this`)
- Local named functions inside methods: `function helper(n:int):int {...}`

**Strings**: there is exactly one quote character, the single quote. Template strings use the same quote with a leading `$`, and interpolate with `{expr}`:
```actionscript
var name:String = 'Rex'
var msg:String = 'It\'s a dog\n'                       // escapes: \' \\ \n \r \t \0 \xFF \u{1F600}
var info:String = $'my age is {person.age}.'          // template string
var calc:String = $'{a} + {b} = {a + b}'               // any expression inside {}
var nested:String = $'Hello {user?.name ?? 'guest'}!'  // strings may appear inside an interpolation
var braces:String = $'set: \{1, 2\}'                   // \{ and \} for literal braces
```
- `"…"` and `` `…` `` are not strings in Klass: the lexer reports K0360 with a fix-it converting `"…"` to `'…'` and `` `Hi ${x}` `` to `$'Hi {x}'`.
- Plain `'…'` strings treat `{` and `}` as normal characters; only `$'…'` interpolates.
- `$` must touch the quote (`$'…'`); `$` stays a valid identifier character elsewhere.
- Strings can't span lines (use `\n`); an unterminated string is reported at its opening quote. Multi-line strings may come later.
- The lexer handles interpolation by switching modes: inside `{…}` it lexes normal tokens (tracking nested braces), and at the matching `}` it returns to string mode.
- Tagged templates (JS `` sql`…` ``) are not supported; call the tag function explicitly if a library needs one.
- JS output: `'…'` → a JS string literal; `$'a {x} b'` → `` `a ${x} b` `` (backticks and `${` in the literal text are escaped).

**Regular expressions**: JavaScript regex syntax, prefixed with `~` so the lexer never has to guess whether `/` means division:
```actionscript
var expr:RegExp = ~/[A-Z]+/g
if (~/^\d{4}-\d{2}-\d{2}$/.test(date)) { ... }            // methods directly on the literal
var parts:Array = line.split(~/\s*,\s*/)
var clean:String = name.replace(~/[^a-z0-9]/gi, '_')
for (var m:* of text.matchAll(~/(?<key>\w+)=(?<val>\w+)/g)) trace(m.groups.key)
var dyn:RegExp = new RegExp('^' + prefix, 'i')             // runtime-built patterns
```
- Lexer: `~` immediately followed by `/` (no whitespace) starts a regex literal; it runs to the next unescaped `/` outside a `[...]` class, followed by flags. `~/` can't mean anything else, because `/` can't start an expression. A plain `/` is always division; something like `var r = /abc/` gets a parse error with the hint "regex literals start with `~`: `~/abc/`".
- Flags `d g i m s u v y`. Unknown or duplicate flags are error K0350, pointing at the flag.
- The pattern is validated at compile time (the compiler constructs `new RegExp(pattern, flags)`); syntax errors are reported as K0351 with the caret inside the pattern.
- Type `RegExp` is a built-in class with typed members: `test(s:String):Boolean`, `exec(s:String):Array` (null when no match), `source:String`, `flags:String`, `lastIndex:int`, `global:Boolean`… `String` methods `match`, `matchAll`, `replace`, `replaceAll`, `split`, `search` accept `RegExp`.
- JS output: the literal without the `~` (`/[A-Z]+/g`). Regex literals are not compile-time constants (not allowed in `inline`).

### A6. Class features (complete list)
**Class declaration modifiers**: `public` | `internal` (default; package-visible), `final` (no subclassing). `dynamic` (instances accept arbitrary new properties, typed `*`) is **deferred** — the keyword stays reserved; until then use `*`/`Object` values for open-ended data.

**Inheritance**: `extends` one class (Klass class *or* an imported JS class, then inherited members are `*`); `implements` any number of interfaces.

**Constructor**: `public function Dog(name:String, age:int = 1) { super(name) }` — exactly one per class; `super(...)` must be the first statement; implicit `super()` inserted if omitted and the parent's constructor needs no arguments. A class **without** a constructor inherits its parent's constructor (like a JS default constructor), so `class SaveException extends Exception {}` accepts a message; the inherited constructor is as visible as the class (a `protected` parent constructor is fine). → JS `constructor`.

**Fields**: `var` / `const` / `final`, `static` or instance, with initializers or AS3 default values (emitted as JS class fields).
```actionscript
public static const MAX_SPEED:Float = 9.5     // compile-time constant, initialized at declaration
public final id:String                        // read-only after construction
private var _name:String
protected var legs:int = 4
```
- `const` — must be initialized where declared.
- `final` — may be initialized at the declaration **or assigned exactly once in the constructor** (static: in the declaration or `static {}` block); any later assignment is a compile error. Emitted as a normal field (compile-time enforcement).

**The `final` keyword, everywhere it applies**:
| On | Meaning |
|---|---|
| class `public final class Dog` | cannot be extended |
| method `final public function speak()` | cannot be overridden |
| getter/setter | cannot be overridden |
| field `final id:String` | assign once (declaration or constructor) |
| local `final r:* = await load()` | assign once |
| parameter `function f(final n:int)` | parameter cannot be reassigned |

**Inline constants** (`inline`): the compiler evaluates the value at compile time and pastes the literal result wherever the name is used.
```actionscript
private static inline final MAX_HP:int = 100
private static inline final HALF_HP:int = MAX_HP / 2          // may reference other inline constants
public static inline final VERSION:String = 'v' + 1 + '.' + 2
public static inline final START:Direction = Direction.Up    // enum members allowed

if (hp > HALF_HP) trace(VERSION)   →   if (this.hp > 50) console.log('v1.2');
```
Rules:
- Allowed on `static final` and `static const` fields, and on local `final` / `const`; the initializer is mandatory. Not allowed on instance fields, methods or parameters (inline functions are a possible later extension).
- `inline` requires `final` or `const`: the value can never change.
- The initializer must be a **compile-time constant expression**: number/string/boolean/`null` literals, other `inline` constants (from any class, across files), enum members, and the operators `+ - * / % ** << >> >>> & | ^ ~ ! && || ?: == != < <= > >=` (with Klass's strict `==`) and casts `int()` `uint()` `Float()` `String()` `Boolean()` applied to those. Calls, `new`, object/array literals and non-inline variables are errors ("inline initializer is not a compile-time constant").
- The checker evaluates the expression with a constant folder (`src/consteval.ts`) using exact JS semantics (so `7 / 2` → `3.5`, `int(7 / 2)` → `3`), checks the result fits the declared type, and detects cycles (`A = B + 1; B = A`).
- Codegen replaces every reference with the folded literal. A `private` inline constant is **not emitted at all**; `public`/`internal`/`protected` ones are still emitted as a static field so plain JS code importing the class can read them.
- An `inline` constant can be used in `switch` `case` labels and other inline initializers, which is where folding matters most.

**Methods**: instance or `static`; default parameter values; rest parameters `...args:Array`; return types incl. `void`; `async` methods; modifiers `override` (required when overriding, see below), `final` (cannot be overridden).

**`override` is mandatory**:
```
error[K0720]: `speak` overrides a method of `Animal` but is not marked `override`
  --> src/com/zoo/Dog.kl:6:19
   |
 6 |   public function speak():String { return 'woof' }
   |                   ^^^^^ overrides `Animal.speak`
   |
  ::: src/com/zoo/Animal.kl:9:19
   |
 9 |   public function speak():String { ... }
   |                   ----- original declared here
   |
help: add `override`
   |
 6 |   override public function speak():String { return 'woof' }
   |   +++++++++
```
- Every instance method, getter or setter that has the same name as an inherited member must be marked `override`; otherwise it's **error K0720** (with the fix-it above). Accidental shadowing is impossible.
- This includes implementing `abstract` members and redefining built-in inherited methods (`toString()`, which every class inherits from `Object`).
- `override` on a member that overrides nothing is **error K0721**, with "did you mean" when a parent member has a similar name (`override function speek()` → "did you mean `speak`?"). This catches typos and parents that renamed a method.
- The override must match the original: same parameter types and count, same return type (or a subclass of it), same visibility, same `async`, and a getter overrides a getter (K0722 lists the differences). It can't override a `final` member (K0723), and an override of a `const` method must be `const`.
- Fields can't be overridden; redeclaring an inherited field is K0724.
- `static` members are never overridden: a static with the same name as a parent static simply hides it, and `override static` is an error.
- Implementing an **interface** method does *not* use `override` (nothing is being replaced); `override` there is K0721. If the method also overrides a parent class member, `override` is required as usual.
- Parent classes imported from JS (typed `*`) have unknown members, so `override` can't be checked against them. It is optional there and only becomes enforced once `.d.ts` typing exists (Part D).

**Getters / setters** (instance or static, overridable):
```actionscript
public function get name():String { return _name }
public function set name(v:String):void { _name = v }
```
→ JS `get name()` / `set name(v)`. Checker: getter/setter types must agree; assigning to getter-only property is an error.

**Visibility** (compile-time enforcement, emitted as normal JS members):
| Modifier | Accessible from |
|---|---|
| `public` | everywhere |
| `internal` (default) | same package |
| `protected` | the class and subclasses |
| `private` | the class only |
Overrides must keep the same visibility.

**Implicit member access**: inside a class, `name`, `speak()`, `MAX_SPEED` resolve to instance or static members (incl. inherited) and compile to `this.name` / `Dog.MAX_SPEED`. Locals shadow members.

**Method closures**: a method referenced without calling it (`timer.onTick = tick`, `arr.map(this.format)`) compiles to a bound function, so `this` stays correct — the AS3 behavior. The bound function is cached on the instance (`obj[Symbol.for('klass.bound.tick')] ??= obj.tick.bind(obj)`), so the same method reference is always the same function and `removeEventListener(handle)` works; symbol keys keep it out of `JSON.stringify`/`Object.keys`.

**Static initialization**: static field initializers + optional `static { ... }` block → JS static block. Static members are inherited for lookup via the class name.

**super**: `super(...)` in constructor, `super.method()`, `super.prop` (getter/setter) in instance members.

**Interfaces**:
```actionscript
public interface IShape extends IDrawable {
  function area():Number
  function get name():String
}
public class Circle implements IShape { ... }
```
Compile-time contracts. For runtime checks each interface is emitted as a symbol, `export const IShape = Symbol('IShape')`; implementing classes mark their prototype, `Circle.prototype[IShape] = true` (including all super-interfaces); and `x is IShape` → `x?.[IShape] === true`. Subclasses inherit the marks through the prototype chain. Plain JS, no helper.

**Enums** (Klass extension):
```actionscript
public enum Direction { Up, Down, Left, Right }
public enum Status { Ok = 200, NotFound = 404 }
public enum Level { Low = 'low', High = 'high' }
```
→ `export const Direction = Object.freeze({ Up: 0, Down: 1, ... })`. Typed: `var d:Direction = Direction.Up`; switch over enum values (a `switch` without `default` that misses members warns, K0814); `Direction.values()` compiles inline to `Object.values(Direction)`. Members auto-number from the previous `int`; `String` enums need explicit values; values are unique compile-time constants. Enums are nominal (no mixing with numbers or other enums; `int(d)`/`String(d)` convert); `raw is Direction` / `raw as Direction` test raw values against the members (`Object.values(Direction).includes(raw)`).

**Abstract classes**:
```actionscript
public abstract class Shape {
  protected final name:String
  public function Shape(name:String) { this.name = name }
  public abstract function area():Float                 // no body
  public abstract function get sides():int
  public function describe():String { return $'{name}: area {area()}' }   // template method
}
public class Circle extends Shape {
  override public function area():Float { ... }
  override public function get sides():int { return 0 }
}
```
Rules:
- `new Shape(...)` is an error (K0710); abstract types are fine as variable/parameter types and with `is`/`as`.
- Only `abstract class` may declare `abstract` members (methods, getters, setters); they have no body and can't be `private`, `static`, `final` or `inline`. `abstract final class` is an error.
- Concrete subclasses must implement every inherited abstract member using `override`; one error (K0711) lists all missing members, with a fix-it that inserts stubs throwing `NotImplementedException`. Abstract subclasses may leave members unimplemented.
- `super.m()` on an abstract method is an error. Constructors may be `protected`.
- JS output (runtime guards for plain-JS consumers): the constructor starts with `if (new.target === Shape) throw new StateException("Shape is abstract")`, and each abstract member is emitted as a stub throwing `NotImplementedException("Shape.area")`.

**Const methods** (C++-style, shallow for now):
```actionscript
public class Inventory {
  private var items:Vector<Item> = []
  private var total:Float = 0

  public function count():int const { return items.length }

  public function report():String const {
    total = 0                                           // error[K0901]: cannot assign `total` in const method `report`
    add(new Item())                                     // error[K0902]: cannot call non-const method `add` from const method
    items.push(x)                                       // allowed (shallow): mutates the array, not the field
    return $'{count()} items, empty: {isEmpty}'         // ok: count() and the getter are const
  }

  public function get isEmpty():Boolean const { return items.length == 0 }   // getters can be const too
}
```
Rules:
- `const` goes after the return type, for methods and getters alike (`function name(...):T const { }`, `function get x():T const { }`); interface/abstract declarations put it in the same place (`function count():int const`).
- In a const method, assigning to any field of `this` (`=`, compound assignment, `++`/`--`, inherited fields, setters on `this`, implicit member access) is an error, with no exceptions (a const method can't cache into a field).
- A const method can only call const methods and const getters on `this`. Calls on other objects aren't restricted (shallow).
- An override of a const method must be const. Interfaces and abstract classes can declare const methods. `static ... const` is an error.
- Arrow functions inside a const method inherit the restriction; `function(){}` expressions (dynamic `this`) aren't checked.
- Purely compile-time: nothing is emitted to JS.
- Later (transitive const): fields read in a const method become `const T` read-only views, `const T` becomes usable as a parameter/variable type, and built-in mutators (`push`, `splice`, `Set.add`…) are marked non-const. The `const T` type syntax is reserved for this now.

**Operator overloading (experimental, only `+` for now)**:
```actionscript
public class Vec2 {
  public final x:Float
  public final y:Float
  public function Vec2(x:Float, y:Float) { this.x = x; this.y = y }

  public function operator+(other:Vec2):Vec2 const { return new Vec2(x + other.x, y + other.y) }
}

var a:Vec2 = new Vec2(1, 2)
var b:Vec2 = a + new Vec2(3, 4)      // → a['operator+'](new Vec2(3, 4))
b += a                               // → b = b['operator+'](a)
trace('pos: ' + b)                   // String on the left: normal concatenation (calls toString)
```
Rules:
- Declared as an instance method `function operator+(name:Type):ReturnType` with exactly one parameter and a non-`void` return type. The return type doesn't have to be the class itself. At most one `operator+` per class (no overloading on the parameter type).
- Can be `const` (recommended), `final`, `abstract`, declared in interfaces, and is inherited. A subclass redefining it needs `override`, as with any method.
- Not `static`. Visibility is checked at the use site like a normal call.
- **Dispatch is static** and based on the left operand: if its static type is a class with `operator+` (own or inherited), `a + b` becomes a method call and the right operand must match the parameter type (K0308 otherwise). There is no reverse lookup: `1 + vec` is an error.
- `+` on a class that has no `operator+` is error K0370 ("`+` is not defined for `Dog`"). In plain JS that would silently concatenate `[object Object]`. Exception: if either side is `String`, `+` is string concatenation as usual.
- `*` or `Object` on the left → plain JS `+` (no dispatch, unchecked).
- `a += b` → `a = a['operator+'](b)`; with a member or index target, the object/index is evaluated once (`(t = obj).pos = t.pos['operator+'](v)`).
- Any other `operator<symbol>` declaration is K0371 ("only `operator+` is supported for now"). Later candidates: `- * / ==` and unary `-`.
- JS output: the method is emitted with the computed name `['operator+'](other) { … }`, so JS code can call it as `a['operator+'](b)`.

**Destructors**:
```actionscript
public class User {
  private final conn:Connection
  public function User(id:String) { conn = Db.open(id) }
  public ~User() { conn.close(); trace('user released') }        // async variant: public async ~User() { await conn.end() }
}

function save():void {
  using u:User = new User('42')      // destructor runs when the block exits, also on exceptions
  using cache:Cache = new Cache()    // multiple usings are destroyed in reverse order
  ...
}                                    // ← cache.~Cache(), then u.~User()

var u2:User = new User('7')
u2.dispose()                         // explicit early destruction
```

**`using` block (C# style)**: scopes the resource to an explicit block. Both forms exist:
```actionscript
using (u:User = new User('42')) {                       // declaration form
  u.save()
}                                                       // ← u destroyed here

using (a:File = File.open('a'), b:File = File.open('b')) { ... }   // several resources, destroyed b then a

using (existingUser) { ... }                            // expression form: dispose an existing value at block end

using (conn:Connection = connect()) trace(conn.ping())  // single statement body, like if/while

await using (c:Connection = await Db.connect()) {       // async destructors, inside an async function
  await c.query('...')
}
```
JS output: a plain block containing `using` declarations:
```js
{ using u = new User("42"); u.save(); }
{ using a = File.open("a"), b = File.open("b"); ... }
{ using $r1 = existingUser; ... }
{ await using c = await Db.connect(); await c.query("..."); }
```
Parsing: `using` followed by `(` is the block statement; otherwise it's the declaration form shown above. The variables in a block's header are `final` and only visible inside the block. The checker requires every resource to be disposable (K0802 otherwise, with a hint when the type has no destructor).
JavaScript is garbage-collected and never destroys objects at a predictable moment, so destructors use JS **explicit resource management** (`using`, `Symbol.dispose`; supported by Bun and TypeScript 5.2+). They are deterministic: they run when a `using` scope ends or when `dispose()` is called, **not** when the GC collects the object.

Rules:
- At most one destructor per class, named `~ClassName`, no parameters, no return type, `public` (default) or `protected` (then only `using` and subclasses can trigger it). Not `static`, `abstract`, `final` or `inline`.
- `async ~User()` makes an async destructor. Such values must be held with `await using` inside an `async` function, and explicit disposal is `await u.dispose()`.
- A class with a destructor gets an implicit `public function dispose():void` (or `Promise<void>`), so `dispose` can't be declared as a normal member there. Classes with destructors are assignable to the built-in interfaces `IDisposable` / `IAsyncDisposable`.
- **Inheritance**: subclass destructors automatically call the parent destructor *after* their own body (C++ order: derived, then base). A subclass without its own destructor inherits the parent's.
- **Runs at most once**: a second `dispose()` or scope exit is a no-op.
- `using x:T = expr` requires `T` to be disposable; the type annotation is optional (inferred from the value). The variable is implicitly `final`. `null` is allowed (nothing to dispose).
- Warning K0801: a disposable created into a plain `var` local that is never disposed, returned or stored ("use `using` or call `dispose()`").
- Exceptions thrown in destructors during unwinding are combined, as in JS: `SuppressedError` is normalized by `Exception.from` into an `Exception` with both errors in `cause`.

JS output:
```js
export class User {
  #disposed = false;
  constructor(id) { this.conn = Db.open(id); }
  [Symbol.dispose]() {
    if (this.#disposed) return; this.#disposed = true;
    this.conn.close(); console.log("user released");
    // super[Symbol.dispose]?.() emitted here in subclasses
  }
  dispose() { this[Symbol.dispose](); }
}
// using u:User = new User("42")  →  using u = new User("42");
```
Plain JS can dispose Klass objects with `using` or by calling `dispose()`. `using` is passed through to JS directly (Bun supports it), so no lowering is needed.

**Not included** (decided): method overloading (except in `native` declarations, Part G), operator overloading beyond `operator+`, inner/nested classes (use file-private helpers), custom namespaces, metadata tags.

### A6b. Typedefs
`typedef` gives a name to a type. It is purely compile-time: nothing is emitted to JS.
```actionscript
package geom {
  public typedef Point = { x:Float, y:Float, ?label:String }   // structural shape, ?field = optional
  typedef Id = String                                           // simple alias (file-private helper)
}

package events {
  public typedef Handler = (e:*) -> void                        // function type
  public typedef Reducer = (acc:int, value:int) -> int          // parameter names are documentation only
  public typedef Config = {
    url:String,
    retries:int,
    final timeoutMs:Float,                                      // read-only member
    onDone:Handler,                                             // typedefs can reference typedefs
    headers:Object
  }
}
```
Usage:
```actionscript
var p:Point = { x: 1, y: 2 }                 // object literal checked against the shape
function dist(a:Point, b:Point):Float { ... }
var add:Reducer = (acc:int, v:int):int => acc + v
button.onClick = (e:*):void => trace(e)      // checked against Handler
var cfg:Config = await loadConfig() as Config  // give shape to an untyped JS value
```
Rules:
- **Transparent**: a typedef is interchangeable with the type it names (`Id` and `String` are the same type).
- **Structural assignability** for shapes: any value whose static type has all required members with compatible types fits — object literals, class instances, other shapes. Extra members are allowed except in a fresh object literal (catches typos like `{ x: 1, yy: 2 }`). Missing `?optional` members are fine; reading one yields `T` or `undefined`.
- **Function types**: parameter types contravariant, return type covariant; a method closure (A6) or `function(){}`/arrow expression is assignable if it matches. `Function` remains the untyped callable.
- Shapes can be used to type JS imports and dynamic data: `import cfg from './config.json'` then `cfg as Config` (unchecked cast; no runtime check because shapes are erased). `x is Point` is a compile error — shapes have no runtime identity.
- Placement follows the class file rules: one `public typedef` per file named after it (e.g. `geom/Point.kl`), any number of file-private typedefs after the package block. Imported like classes: `import geom.Point;`.
- Recursive typedefs are allowed through members (`typedef Node = { value:int, ?next:Node }`); a direct cycle (`typedef A = B; typedef B = A`) is an error.
- Type parameters come with generics (Part G): `typedef Pair<A, B> = { first:A, second:B }`.

New token: `->` (function type arrow), and `?` before a member name inside a shape type.

### A6c. Built-in `Exception` class
Klass code always uses `Exception` instead of JS's `Error`. It is defined in the prelude (written in Klass itself, the only file allowed to touch `Error`) and auto-imported:
```actionscript
package {
  public class Exception extends Error {
    public final cause:*                                   // underlying error / thrown value, if any
    public function Exception(message:String = '', cause:* = null) {
      super(message, { cause: cause })
      this.cause = cause
      name = <runtime class name>                          // emitted as new.target.name → "ArgumentException" etc.
    }
    // inherited from Error: message:String, name:String, stack:String
    public static function from(value:*):Exception { ... }  // normalize anything thrown
    override public function toString():String { ... }      // "ArgumentException: bad id (caused by …)"
  }

  public class ArgumentException extends Exception {}      // invalid argument
  public class TypeException extends Exception {}          // JS TypeError
  public class RangeException extends Exception {}         // index/value out of range, JS RangeError
  public class StateException extends Exception {}         // object in wrong state for the call
  public class NotImplementedException extends Exception {}
}
```
User exceptions extend it: `public class SaveException extends Exception { public final path:String; ... }`.

Rules ("always Exception, never Error"):
- `Error` and its JS subclasses (`TypeError`, `RangeError`, `SyntaxError`, …) are **not visible** in Klass code: using them is a compile error with the hint "use Exception / TypeException …". (Escape hatch: `globalThis.Error` via `*` for rare interop.)
- `throw` only accepts expressions whose static type is `Exception` or a subclass (or `*`, checked at runtime: non-Exception values are wrapped).
- Catch clause types must be `Exception` or subclasses; `catch (e)` without a type means `catch (e:Exception)`. `catch (e:*)` is not allowed.
- **Everything caught is an `Exception`**: generated code passes the raw value through `Exception.from()`:
  - already an `Exception` → unchanged
  - JS `TypeError` → `TypeException`, `RangeError` → `RangeException`, any other `Error` → `Exception`; message and stack copied, original kept in `cause`
  - non-Error value (`throw "oops"` from a JS lib) → `Exception("Non-error value thrown: oops", cause = value)`
  
  So errors from npm libraries and rejected promises (`await`) are caught as typed `Exception`s. The original JS error is always in `e.cause`.
- Compiler-generated failures throw the built-in classes: abstract instantiation → `StateException`, abstract stubs → `NotImplementedException`.
- Because `Exception` really extends JS `Error`, exceptions thrown from Klass into plain JS code behave as normal errors (stack traces, `instanceof Error`, `cause`).

### A7. Semicolons (ASI)
Statements end with `;` or a newline, following JS's ASI rules: restricted productions (`return`, `break`, `continue`, `throw`, postfix `++`/`--` cannot be followed by a line break before their operand), and a statement continues onto the next line when the next token can't start a new statement. The lexer records "newline before token" on each token so the parser can apply this.

---

## Part A8 — Output principle: vanilla JavaScript first

The generated code should look like what a person would write by hand in modern JS:
- **Vanilla first.** Every construct compiles to standard ES2022+ syntax (`using` from explicit resource management, which Bun supports). The current design needs no helpers (see the table below).
- **Runtime helpers only as a last resort.** A helper may be added only after showing that the feature can't be compiled to plain JS expressions/statements, not even with temporaries, an extra block, or a different lowering. Each helper:
  - is recorded in `docs/runtime-helpers.md` with the feature it serves, the vanilla lowerings that were considered and why they fail, and its JS source;
  - is a small named export in `out/klass/runtime.js`, imported only by modules that actually use it (`import { castOrThrow } from '../klass/runtime.js'`), never a global and never inlined boilerplate;
  - has its own unit test.
  The first candidate if wanted later is AS3's throwing cast `Dog(x)`, because JS has no throw expressions.
- Besides any justified helpers, the only runtime code Klass ships is the **prelude** (the `Exception` family, A6c). These are ordinary classes written in Klass, emitted as `out/klass/Exception.js` etc., and imported only by modules that use them.
- Names are preserved (classes, methods, fields, locals). Generated temporaries (`$t1`, `$end`) appear only where an expression must be evaluated once, and are declared with `let`/`const` in the nearest scope.
- Compile-time-only features leave nothing behind: types, typedefs, visibility, `final`, `const` methods, `override`, `inline` constants (folded).

| Klass feature | Vanilla JS output |
|---|---|
| class, fields, getters/setters, statics, static block | `class`, class fields, `get`/`set`, `static`, `static {}` |
| `int(x)` / `uint(x)` / `Float(x)` | `x \| 0` / `x >>> 0` / `Number(x)` |
| `x as Dog` / `x is Dog` | `x instanceof Dog ? x : null` / `x instanceof Dog` |
| `x is IShape` | `x?.[IShape] === true` (interface symbol) |
| `==` / `!=` (`== null`) | `===` / `!==` (`== null`) |
| method closure `this.handle` | `this[Symbol.for('klass.bound.handle')] ??= this.handle.bind(this)` (cached → stable identity) |
| `if (var x:T = e)` / `while (var …)` | block + `if ((x = e) != null)` / `for (let x; (x = e) != null; )` |
| range loop `0..n step 2` | `for (let i = 0, $end = n; i < $end; i += 2)` |
| for-of / for-in | `for…of` / `for…in` |
| typed catches | one `catch` + `instanceof` chain |
| destructor / `using (…) {}` | `[Symbol.dispose]()` + `dispose()` / `{ using x = …; }` |
| abstract class | `new.target` check + stub methods |
| enum | `Object.freeze({ … })` |
| `operator+` | method `['operator+']` + call `a['operator+'](b)` |
| `$'…{x}…'` / `~/re/g` | `` `…${x}…` `` / `/re/g` |
| `trace(…)` | `console.log(…)` |

## Part B — Compiler architecture
```
.kl files → lexer → parser → AST → resolver (packages/imports) → checker → codegen → .js ESM → bun run
```
Files under `src/`:
- `lexer.ts` – tokens with line/col + `newlineBefore` flag; `'…'` strings, `$'…'` template strings with nested `{expr}` lexing, `~/…/flags` regex literals (no regex-vs-divide guessing needed); keyword table from A0
- `ast.ts` – AST node types (discriminated unions)
- `parser.ts` – recursive-descent with precedence climbing; ASI
- `types.ts` – type representations and assignability rules
- `project.ts` – package path ↔ file mapping, loading all source files
- `resolver.ts` – imports, symbol tables per package/class
- `checker.ts` – type checking, visibility, override/interface rules, implicit member resolution
- `consteval.ts` – compile-time constant folding for `inline` constants
- `codegen.ts` – AST → JS ESM (substitutes inline constants)
- `globals.ts` – JS globals (`console`, `Math`, `JSON`, `fetch`, `process`, `document`, …) typed `*`; `trace` → `console.log`
- `diagnostics.ts` – `Diagnostic` data model + Rust-style renderer (Part E)
- `suggest.ts` – "did you mean" (edit distance over names in scope/members/imports), fix-it suggestions
- `compiler.ts` – `compileProject(srcRoot, mainClass, outDir)`
- `cli.ts` + `watch.ts` – the `klass` command line tool (Part F)

Tests: `tests/*.test.ts` (unit per stage), golden e2e over `examples/<name>/` (compile → run with Bun → compare to `expected.txt`), negative tests in `examples/errors/` with expected messages.

---

## Part C — Milestones (each ends with passing tests + a runnable example)

0. **Scaffolding** – CLI skeleton (`build`/`run`/`check`), `compileProject` stub, golden-test runner, and the `Diagnostic` model + Rust-style renderer (Part E) — so every later step reports errors in the final format from day one.
1. **Lexer** – all keywords from A0, tokens from A4–A5, comments, `'…'` strings and `$'…{expr}…'` template strings, `~/regex/` literals with flag + pattern validation, newline flags.
2. **Hello world e2e** – `package { public class Main { public function Main() { trace('hi') } } }` → `export class Main {...}` + `new Main()`.
3. **Expressions & locals** – literals, all operators from A5 (except functions), `var`/`const`, primitive types, casts; checker core with scopes and mismatches. ASI.
4. **Control flow** – everything in A4 except typed catch, await and `using`; includes range loops (`..`, `..=`, `step`, open ranges) and if/while-with-binding.
5. **Fields, methods, statics** – A6 fields/methods/static blocks, default + rest params, implicit member access, `final` fields/locals/params (definite assignment).
5b. **Inline constants** – `inline` modifier, constant folder, use-site substitution, cycle detection, private inline constants omitted from output; extended to cross-file use in step 6 and to enum values in step 16.
6. **Packages & multi-file** – `package`, own imports, file-private classes, one ESM per class, entry file.
7. **JS interop** – JS imports typed `*`, globals table, object/array literals, `is`/`as`, example using `lodash` + `node:fs`.
8. **Inheritance & super** – `extends` (Klass and JS classes), mandatory `override` with K0720–K0724, `final` classes/methods, implicit `super()`, `super.x`.
9. **Visibility** – public/internal/protected/private rules.
10. **Getters/setters, method closures** (`dynamic` classes deferred to "Later").
11. **Exceptions** – prelude `Exception` hierarchy compiled from Klass, `Exception.from` normalization, hiding `Error`, `throw` type rule, typed multi-catch, finally, catching errors thrown by an npm library as `Exception`.
12. **Functions** – function expressions, arrows, local functions, `Function` type, async/await, `Promise.<T>`.
13. **Modern syntax** – `?.`, `??`, `??=`, `$'…{expr}…'` template strings, destructuring, spread.
14. ~~**Collections**~~ – the language parts are done (`Vector<T>` literals typed from context, `for…of`/`for…in`, destructuring); typed members for built-in types moved to the **standard library** (see Later).
15. **Interfaces** – `interface`, `implements`, runtime `is` support.
15e. **Operator `+` overloading** – `function operator+(…)`, static dispatch, `+=` lowering, K0370/K0371.
15d. **Const methods** – `const` suffix on methods and getters, override/interface rules, K0901/K0902.
15c. **Destructors** – `~Name()` / `async ~Name()`, `using` / `await using` declarations and C#-style `using (...) { }` blocks, implicit `dispose()`, base-destructor chaining, once-only guard, `IDisposable`, K0801 warning.
15a. **Abstract classes** – `abstract` classes/members, instantiation and unimplemented-member checks with stub fix-it, `new.target` guard and `NotImplementedException` stubs in output.
15b. **Typedefs** – `typedef` aliases, structural shapes with optional/final members, function types, structural assignability, excess-property check on object literals, typedef imports, and the auto-imported prelude with `Int` `UInt` `Void` `Bool` `Any`.
16. **Enums**.
17. **Error quality pass** – parser recovery everywhere, secondary labels on all type errors, "did you mean", fix-it `help:` suggestions, unclosed-delimiter tracking, warnings (unused, untyped, `===` usage, `undefined`), always-false comparison errors, error codes + `klass explain`.
17b. **Watch mode** – `klass watch` with incremental recompilation (Part F).

Later: the **standard library and generics** are planned in Part G. `dynamic` classes, first-class `Range` values, a `while` clause on range loops (`for (var n:int of 2.. while !s.has(x))`), labels, `Bun.serve()` playground, and the VS Code extension in Part D (which also brings `.d.ts` typing and source maps). From step 1 on, follow the "what the compiler must do now" list in Part D.

---

## Part E — Diagnostics (Rust-style error reporting)

### Output format
```
error[K0308]: mismatched types
  --> src/com/zoo/Dog.kl:14:24
   |
 9 |     private var age:int
   |                     --- field declared as `int` here
...
14 |         age = 'three'
   |               ^^^^^^^ expected `int`, found `String`
   |
help: convert the value with `int()`
   |
14 |         age = int('three')
   |               ++++      +

error[K0425]: cannot find `spek` in this scope
  --> src/Main.kl:7:11
   |
 7 |     trace(dog.spek())
   |               ^^^^ no method `spek` on `Dog`
   |
help: a method with a similar name exists: `speak`

error[K0603]: `_name` is private to `Animal`
  --> src/Main.kl:8:15
   |
 8 |     trace(dog._name)
   |               ^^^^^ private field
   |
  ::: src/com/zoo/Animal.kl:4:17
   |
 4 |     private var _name:String
   |                 ----- declared private here
   |
help: use the public getter `name`

error: aborting due to 3 previous errors; 1 warning emitted
```
Elements: severity + error code, `-->` location, gutter with line numbers, **primary span** underlined with `^^^` and a label, **secondary spans** with `---` and labels (possibly in other files, with `:::`), `...` for skipped lines, multi-line spans drawn with `/` and `|_` bracket lines, `note:` and `help:` lines, and **fix-it suggestions** rendered as a patched line with `+`/`~` markers. Colors (red errors, yellow warnings, blue gutter/secondary, green suggestions) when stdout is a TTY; `--color=never|always`. Tab characters are expanded so carets line up; wide/unicode characters measured by display width.

### Data model (`src/diagnostics.ts`)
```ts
interface Diagnostic {
  severity: "error" | "warning" | "note";
  code: string;                       // "K0308"
  message: string;
  labels: { span: Span; message?: string; primary: boolean }[];
  notes: string[];
  help: { message: string; edits?: { span: Span; text: string }[] }[];
}
```
The same data feeds the terminal renderer, `--format json` (for scripts/CI) and later the language server (Part D) — edits become VS Code quick fixes.

### Making the compiler smart about *where* the bug is
- **Point at the cause, not the symptom**: type errors carry the origin of the expected type (declaration of the variable/parameter/return type) as a secondary label; argument errors point at the specific argument and the parameter in the signature.
- **Unclosed delimiters**: the lexer keeps a stack of open `{ ( [`; on a mismatch or EOF it reports the *unclosed opener* (primary) and where the parser gave up (secondary), and uses indentation to guess where the missing `}` belongs ("this `}` probably closes the `if` on line 12").
- **Parser recovery**: synchronize at `;`, newline-ended statements, `}` and member keywords so one typo yields one error, not a cascade. Expressions that failed to type become an `error` type that silently satisfies all later checks (no follow-up noise).
- **"Did you mean"**: Levenshtein/Damerau over locals, members (incl. inherited), imports, and package classes; also suggests a missing `import com.zoo.Dog;` when a class exists elsewhere in the project.
- **Targeted hints**: `Number` → "use `Float`", `final var` → "remove `var`", `Error` → "use `Exception`", `catch (e:*)`, missing `override` (with fix-it), calling an instance member from a static context, `==` vs `=` in conditions, ASI pitfalls (`return` followed by newline), `async` missing when `await` is used (fix-it adds `async`).
- **Limits**: deduplicate identical diagnostics; cap at `--max-errors` (default 50).
- **Warnings**: unused locals/imports/private members, untyped declarations, unreachable code, `===`/`!==` (K0841), any use of `undefined` (K0840). Comparisons that are always false (K0309) are errors. `--deny-warnings` turns them into errors; `/* klass-allow Kxxxx */` suppresses one occurrence.
- **Error codes catalog** (`src/diagnostics/codes.ts`): each code has a long explanation with a wrong and corrected example; `klass explain K0308` prints it.

Tests: snapshot tests over `examples/errors/*.kl` comparing the full rendered output (colors off) to `*.stderr` files, so formatting regressions are caught.

---

## Part F — Command line tool

Installed as `klass` (`bin` entry in `package.json`, runnable via `bunx klass` or `bun link`).

| Command | What it does |
|---|---|
| `klass init [dir]` | create `klass.json`, `src/Main.kl`, `.gitignore` |
| `klass build` | compile the project to `outDir` |
| `klass check` | type-check only, no output |
| `klass run [-- args]` | build, then run the entry with Bun |
| `klass watch` | rebuild on every change; `--run` restarts the program after each successful build |
| `klass explain <code>` | long explanation of an error code |

Common flags: `--project klass.json`, `--src src`, `--out out`, `--main Main`, `--sourcemap`, `--format pretty|json`, `--color auto|always|never`, `--max-errors N`, `--deny-warnings`, `--quiet`.

**Project file `klass.json`** (all optional, CLI flags override):
```json
{ "src": "src", "out": "out", "main": "Main", "sourcemap": true, "denyWarnings": false }
```

**Exit codes**: `0` success, `1` compile errors, `2` invalid usage/config, program's own exit code for `run`.

### Watch mode (`src/watch.ts`)
- Watches `src` recursively with `fs.watch` (Bun supports it), plus `klass.json`; changes debounced (~50 ms) so editor save-bursts compile once.
- **Incremental**: a per-file cache of `{ text hash, AST, exported signatures }`. A change re-parses only that file; files are re-checked if they changed or if a dependency's *public signature* changed (dependency graph from imports). Only output files whose content changed are rewritten.
- Output per cycle: clear screen (unless `--no-clear`), the diagnostics, then a status line like `✓ built 3 of 42 files in 18 ms — watching for changes` or `✗ 2 errors — watching for changes`.
- `--run`: kills the previous child process (via `Bun.spawn`) and starts the new build; if the build fails, the old process is stopped and nothing is started.
- Deleted/renamed files: their outputs are removed and dependents re-checked (so "cannot find `Dog`" appears immediately).
- `Ctrl+C` exits cleanly, stopping any child process.
- The same incremental core is later reused by the language server (Part D).

---

## Part G — Generics and the standard library

Decided 2026-11-18: the standard library is **hand-written Klass declarations** of the JS built-ins (curated types: `int` vs `Float`, nullability, `Vector<T>`), not generated from `lib.d.ts` (TS unions/overloads/`undefined` map poorly; `.d.ts` stays the source for the long tail — DOM, Node, npm — in Part D). This needs **full generics**, which user code gets too (reversing the earlier "no user generics" decision).

### G1. Generics
```actionscript
public class Box<T> {
  private var value:T
  public function Box(value:T) { this.value = value }
  public function get():T { return value }
  public function map<U>(f:(value:T) -> U):Box<U> { return new Box<U>(f(value)) }
}

public interface IComparable<T> { function compareTo(other:T):int }
typedef Pair<A, B> = { first:A, second:B }

var b:Box<int> = new Box<int>(5)
var s:Box<String> = b.map((n) => 'n=' + n)             // U inferred as String
var c:Box<int> = new Box(5)                            // T inferred from the constructor argument
```
- Type parameters on classes, interfaces, methods, local functions and typedefs. **No bounds** (decided 2026-11-18: `T extends X` is skipped for now), so inside a generic body a `T` value can only be stored, passed on, compared with `==` and assigned to `Object`/`*`.
- Member types are substituted per use (`Box<int>.get()` is `int`); method type arguments are **inferred** from the arguments (and from the expected type for arrows); explicit type arguments at call sites are not supported at first (`<` stays unambiguous: type arguments only appear in type positions, after `new`, and in declarations).
- Generic types are **invariant** (`Vector<Dog>` is not a `Vector<Animal>`).
- **Erased at runtime** (JS has no generics): `x is Box` works, `x is Box<int>` is an error; no code changes in the output.
- `Vector<T>` and `Promise<T>` stop being special: they become ordinary generic native classes from the std library.

### G2. Native declarations
```actionscript
public native class String {
  function get length():int
  function indexOf(search:String, from:int = 0):int
  function split(separator:String):Vector<String>
  function split(separator:RegExp):Vector<String>      // overloads: native declarations only
}
```
- `native` classes/interfaces/members describe existing JS objects: no bodies, **no generated code**, member names map 1:1 to JS.
- **Overloads** are allowed in native declarations only (they replace TS unions); the first matching signature wins.
- Native classes are **closed**: an undeclared member is an error (typos are caught); the escape hatch is `(x as *).newApi()`.
- Primitive types get their members from native classes (`'abc'.toUpperCase()` → `String`, numbers → `Float`/`int` methods like `toFixed`).
- Globals (`Math`, `JSON`, `console`, …) become typed by their declarations; JS globals without a declaration stay `*`.

### G3. The standard library
- Files in `src/prelude/std/*.kl`, auto-imported like the prelude: `String`, `Boolean`, `Number` methods, `Array` and `Vector<T>`, `Math`, `JSON`, `RegExp`, `Promise<T>`, `Map<K, V>`, `Set<T>`, `Date`, `console`.
- Typing rules: **`int` where the result is always whole** (`length`, `indexOf`, `charCodeAt`, `getFullYear`, …); `Math.floor/round/ceil` stay `Float` (results can exceed the `int` range); JS `T | undefined` results become nullable `T` (`find`, `Map.get`, `pop`).
- A **conformance test** checks that every declared member exists at runtime in Bun.
- One file per type (`std/Boolean.kl`, package `klass`), each listed in `PRELUDE` (`src/compiler.ts`); the test fails if a file isn't loaded. Users can't declare a class with a std name (K0028).
- Constructors that would create JS wrapper objects (`new Boolean`, `new String`, `new Number`) are hidden; the cast functions `Boolean(x)`, `String(x)`, `Float(x)` keep working.
- Methods of primitives used as values compile to `x.m.bind(x)` (a primitive can't hold the cached-identity property used for Klass method closures, and has no identity to keep).

### G4. Migration
- Examples and tests updated where typed built-ins now catch mistakes; `globals.ts` shrinks to the globals that have no declaration yet.

Milestones: G1 generics → G2 native declarations → G3 std library → G4 migration. Later: generate further declarations from `.d.ts` (Part D) in the same `native` form.

## Part D — Later: VS Code extension with IntelliSense via the TypeScript 5 API

**Approach (same idea as Vue/Svelte tooling):** for each `.kl` file the compiler produces a *virtual TypeScript file* — typed TS equivalent of the Klass code — plus a position map between `.kl` and the virtual `.ts`. A TypeScript 5 `LanguageService` runs over these virtual files together with the project's real `node_modules` `.d.ts` files. Every editor request is translated `.kl` position → `.ts` position, answered by TypeScript, and mapped back.

This also delivers real types for npm imports inside the editor (completion on `_.` from `@types/lodash`), and the same mechanism can later replace the `*` typing of JS imports in the compiler itself.

Features: diagnostics (Klass checker errors + mapped TS errors), completion, hover, signature help, go to definition (into `.kl` and into `.d.ts`), find references, rename, document symbols/outline, semantic highlighting; plus a TextMate grammar for syntax highlighting and a language configuration (brackets, comments, auto-indent).

Structure:
- `packages/klass-compiler` – the compiler (`src/` above), exposing an API, not just a CLI
- `packages/klass-language-server` – LSP server built on **Volar.js** (`@volar/language-server`, `@volar/typescript`), which provides the virtual-file + TS LanguageService + position-mapping plumbing
- `packages/vscode-klass` – thin VS Code client: starts the server, registers `.kl`, grammar, snippets

Klass-specific features TS can't provide (keyword completion for modifiers, `override` quick-fix, "add missing interface members", package path ↔ file checks) come from the Klass checker in the same server.

### What the compiler must do *now* so this is possible later
These are cheap if built in from step 1 and painful to retrofit:
1. **Precise spans** on every token and AST node (start/end offsets, not just line/col).
2. **Error-tolerant parser**: recovers at statement/member boundaries and produces a partial AST with error nodes, so half-typed code still gets completions.
3. **Mapping-aware emitter**: codegen writes through a `CodeWriter` that records `(klassSpan → outputSpan)` mappings; used for JS source maps (milestone) and for the virtual TS file.
4. **Second emit target `ts`**: same codegen with type annotations kept (`int`/`Float` → `number`, `Vector<T>` → `T[]`, typedefs → `type`, shapes → object types, `*` → `any`, visibility → TS `private`/`protected`). Add once the JS backend is stable (after milestone 15b).
5. **Compiler as a library**: `compileProject` works on in-memory files (`Map<path, text>`), incremental per-file re-checking, no `process.exit` in the core.
6. Checker results queryable by position (symbol at offset, type of expression) for Klass-only features.

Milestones (after Part C):
18. Source maps for the JS output (uses the mapping writer).
19. `ts` emit target + position map; test: TS compiler reports no errors on the virtual TS of all examples.
20. Language server on Volar.js: diagnostics, hover, completion, go-to-definition.
21. VS Code extension: TextMate grammar, language config, client; package as `.vsix`.
22. Rename, references, signature help, outline, quick fixes.
23. Use `.d.ts` types for JS imports in the compiler too (replacing `*`).

## Verification
- `bun test` – unit tests + golden e2e + negative tests.
- Diagnostics: snapshot tests of rendered error output (Part E); manually check colors and caret alignment in a terminal.
- Watch: `klass watch --run` in `examples/zoo`, edit a file → only it is rebuilt and the program restarts; introduce a type error → error shown and process stopped; fix it → recovers.
- `klass run examples/zoo` prints the expected output; `klass build examples/zoo --out out` yields readable ESM that plain JS can `import { Dog } from "./out/com/zoo/Dog.js"`.
- Interop example importing an npm package (installed via `bun install`) and `node:fs/promises` with `await` runs correctly.
- Exception tests: a JS `TypeError` from a library is caught by `catch (e:TypeException)` with the original in `e.cause`; `throw "x"` from JS becomes an `Exception`; using `Error` in Klass code is a compile error; a Klass exception caught in plain JS is `instanceof Error`.
- String tests: `$'{a} + {b} = {a + b}'` output, nested quotes inside `{}`, `\{` escapes, a literal backtick inside a template; `"x"` and `` `x` `` give K0360 with the right fix-its.
- Regex tests: `a / b / c` stays division; `~/a\/b[/]/g.test(s)` lexes correctly; bad flag (K0350) and invalid pattern (K0351) point into the literal; plain `/abc/` gives the `~` hint.
- Equality tests: `'1' == 1` doesn't compile (K0309); `*`-typed `'1' == 1` is `false` at runtime; `x == null` is true for a JS `undefined`; `===` gives K0841.
- Operator tests: `Vec2 + Vec2` and `+=` (including `obj.pos += v` evaluating `obj` once), inherited/overridden `operator+`, `'s' + vec` concatenates, `Dog + Dog` → K0370, `operator-` → K0371, wrong right-operand type → K0308.
- Range tests: printed sequences for `0..5`, `0..=5`, `0..10 step 3`, `5..0` and runtime `a..b` with `a > b` running 0 times, open range with `break`; `step 0`, `step -1`, assigning the loop variable and a range outside a loop fail with their codes.
- Const method tests: field assignment, `++`, setter use and non-const calls on `this` in a const method fail; calls on other objects and const getters pass; a non-const override of a const method fails.
- Destructor tests: output order for nested `using` blocks (reverse order, derived before base), destructor runs when an exception leaves the block, double `dispose()` runs once, `await using` with an async destructor.
- Abstract tests: `new Shape()` and a subclass missing `area()` fail with K0710/K0711; a plain JS file doing `new Shape()` against the build output gets a `StateException`.
- Typedef tests: shapes accept matching literals/class instances and reject missing or mistyped members; built output contains no trace of typedefs.
- Inline test: an example whose built output contains the folded literals and no `private static inline` field, plus negative tests (non-constant initializer, missing `final`, cyclic constants).
- Each class rule (private access, missing `override`, unimplemented interface member, wrong enum type, …) has a failing example with its expected error message.

We'll implement one milestone at a time and confirm each works before moving on.
