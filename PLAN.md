# Plan: XenonScript — an ActionScript-3-style language that compiles to JavaScript

## Progress
- [x] Steps 0–2: scaffolding, CLI (`build`/`check`/`run`), Rust-style diagnostics, lexer, parser, hello world
- [x] Step 3: type checker core (also covers method signatures, arity, static vs instance, `final`/`const`/getter writes from step 5)
- [x] Step 4: control flow — `for`, `for…in`, `for…of`, range loops, `switch`, `if`/`while` bindings, `break`/`continue` checks, missing-return and unreachable-code analysis
- [x] Step 5: static blocks, definite assignment for `final` locals/fields/static fields (assign exactly once, no reads before assignment, not in loops, every constructor path)
- [x] Step 5b: `inline` constants — constant folder (`src/consteval.ts`), cycle detection, value-based fitting, pasted at use sites, private ones not emitted
- [x] Step 6: packages & multi-file — import priority (explicit > package > wildcard), clashes, ambiguous wildcard names, unused/duplicate/redundant import warnings, file-private import errors, qualified type names, module cycles
- [x] Step 7: JS interop — `is`/`as` (XenonScript classes, JS classes, primitives) as plain JS with hoisted temporaries, `delete` only on dynamic objects, npm (`lodash`) + Node built-ins example, plain JS importing/subclassing compiled classes
- [x] Step 8: inheritance & super — `super(...)` (first statement, no `this` before it, implicit `super()`), `super.member`, mandatory `override` (X0720–X0726), `final` classes/methods, cycles, extending JS classes, accessor-half delegation, inherited statics addressed via the declaring class
- [x] Step 9: visibility — `public`/`internal` (default)/`protected`/`private` on members and constructors (incl. implicit `super()`), `internal` classes across packages, "use the public getter" hints
- [x] Step 10: getters/setters polish (void setters, setter-only reads, matching visibility) and method closures — bound and cached per instance under `Symbol.for('xenon.bound.<name>')`, so `this.handle` keeps its identity (`dynamic` classes deferred)
- [x] Step 11: exceptions — prelude `xenon/Exception.xn` (written in XenonScript, one module), `Exception.from`, JS `Error` classes hidden with hints, `throw` only Exceptions (`*` normalized), typed multi-catch/finally with original-value rethrow, catch reachability; codegen now emits one module per source file; classes without a constructor inherit their parent's
- [x] Step 12: functions — `function(){}` expressions (dynamic `this`; bare member names reach the instance via `$self`), arrows (lexical `this`, expression bodies infer their type), hoisted local functions, named function expressions, async methods/functions/arrows with `Promise<T>`, `await` checks with fix-its, closures can't assign outer `final`s
- [x] Step 13: modern syntax — destructuring declarations/assignments/`for…of` patterns (renaming, defaults, nesting, holes, rest; binding types from the source, methods can't be destructured), plus `??=`/`&&=`/`||=`/`**=`, object spread, optional calls
- [ ] Step 14: skipped → standard library (Later)
- [x] Step 15: interfaces — `interface … extends …`, `implements`, member rules, implementation check with a multi-line stubs fix-it, signature/visibility/accessor-half matching, interface types and subtyping, `new` on interfaces rejected, runtime `is`/`as` via `Symbol` markers on prototypes (inherited by subclasses)
- [x] Step 15a: abstract classes — `abstract` classes/members (rules X0710–X0718), missing implementations with an `override` stubs fix-it, abstract classes may defer interface members, `new.target` guard (synthesized constructor when needed) and `NotImplementedException` stubs in the output; bodiless non-abstract methods are now an error; `new` on a local holding a class gives `*`
- [x] Step 15b: typedefs — aliases, structural shapes (optional/`final` members, recursion through members, class instances fit structurally), function types (contravariant params, covariant return, contextual typing of arrows), inline `{…}`/`(…) -> T` types, excess/missing-member checks on literals, unchecked `as`, `is` rejected; typedef files emit nothing
- [x] Step 15c: destructors — `~Name()` / `async ~Name()` → `[Symbol.dispose]`/`[Symbol.asyncDispose]` with a once-only `#disposed` flag and the parent destructor chained in `finally`, implicit `dispose()`, prelude `IDisposable`/`IAsyncDisposable` (implemented automatically, manual implementation rejected), `using` declarations and `using (…)` blocks (type optional: inferred from the value), X0801 for disposables that are never disposed or handed on; prelude file is now `src/prelude/Prelude.xn` (module `xenon/Prelude.js`)
- [x] Step 15d: const methods — `:T const` on methods and getters, no writes through `this` (X0901), only const members used on `this`/`super` (X0902), arrows inherit the restriction, `function` expressions don't, overrides and interface implementations must stay const, invalid placements X0903; static fields remain writable
- [x] Step 15e: `operator+` — instance method `['operator+']`, static dispatch on the left operand (strings still concatenate), right operand checked against the parameter, `+=` lowered with object/index evaluated once, inherited/overridable/abstract/interface, visibility and const rules at the use site, X0371–X0373; also `Vector<T>[i]` is now typed `T`
- [x] Step 16: enums — `enum Name { A, B = 2 }` / string enums → `Object.freeze({…})`, auto-numbering, constant values (X0811–X0817), nominal typing, `values()` → `Object.values(E)`, `x is/as Enum` checks raw values, switch exhaustiveness warning (X0814), enum members in `inline` constants; enums and interface symbols are emitted before classes in a module
- [x] Step 17: error quality — unused locals (X0861, `_name` exempt) and private members (X0862), `=` as a condition (X0322), `return`⏎ hints, `--max-errors` cap, `xenon-allow` suppression comments, parser recovery that keeps broken declarations/returns (no cascades), error code catalog (`src/codes.ts`, every code covered by a test) and `xenon explain <code>`
- [x] Step 17b: watch mode — `xenon watch [--run] [--no-clear] [-- args]`: debounced rebuilds, files re-read only when changed, whole-project re-check (fast; signature-based incremental checking deferred until projects need it), only changed outputs written, stale outputs removed, `--run` restarts after successful builds and stops on errors, `xenon.json` reload, clean Ctrl+C
- [x] G1: generics — type parameters on classes, interfaces, methods, local functions and typedefs (no bounds), substitution through inheritance and interfaces, invariant type arguments, inference of method/constructor type arguments from arguments (arrows: from their return type) and the expected type, raw types for `is`/`as`, erased output
- [x] G2: native declarations — `native` / `native('JsName')` classes (no output, referenced by JS name, no imports), bodiless public members, statics and constructors, overloads with first-match selection (X0604), closed member sets with the `(x as *)` escape hatch, primitive members from natives named `String`/`Float`/`Boolean`, XenonScript classes extending natives (X0820/X0821 for code in natives)
- [~] G3: std library — infrastructure done (`src/prelude/std/*.xn` loaded with the prelude, no output; conformance test `tests/std.test.ts` checks every member against Bun incl. return types on sample values; `examples/std`). Types declared: `Boolean`, `Float` (JS `Number`; members shared by `int`/`uint`; overloads where JS has no real default, e.g. `toPrecision()`; `parseInt`/`MAX_SAFE_INTEGER` are `Float`; `is…` tests take `*`; the `Number` global is hidden with a fix-it to `Float`), `int`, `uint` (separate files; AS3-style `MAX_VALUE`/`MIN_VALUE` as `inline` constants — compile-time literals, no runtime object; `native('Number') … extends Float` so they keep the number members, `valueOf()` returns `int`/`uint`; inherited statics like `int.parseInt` stay `Float`), `Array<T>` (the type stays built into the compiler; a std native class `Array<T>` supplies its members, `T` = the element type: mutators, copies (`toSorted`, `with`, …), typed callbacks with `map<U>`/`reduce<U>` inference, `sort` with and without comparator, `Array.from`/`of`/`isArray`; `length` is an assignable `int`; positions `int`; `flat()` returns `Array<*>`; `copyWithin` and `fromAsync` left out; untyped `Function` values no longer pass as callbacks, give them a function type), `String` (members of the primitive; positions/counts `int`; overloads instead of fake defaults (`lastIndexOf`, `endsWith`, `slice`, `split` with limit); `replace`/`replaceAll` take text or regex with a text or `Function` replacement; `match`/`matchAll` return `Array<String>`/`Iterator<Array<String>>`; hidden constructor; deprecated HTML methods, `substr`, `trimLeft`/`trimRight` and `String.raw` left out; local `native class String` declarations now clash with it (X0028); fixes: member writes on primitives are checked (`s.length = 3` is X0504) and string indexes must be ints), `Map<K, V>` (constructors from nothing/pairs/map, `groupBy`, get/set/has/delete/clear/size/forEach, `keys`/`values`/`entries` as iterators; `for (var [k, v]:* of map)` types `k` as `K` and `v` as `V`; `get` is typed `V` though a missing key is `undefined` at runtime, so primitives need `has()` first (XenonScript has no nullable `int`); `getOrInsert*` left out as too new; the `Map` global is no longer untyped, and the natives/inheritance examples now use it), `RegExp` (a std native class instead of a compiler built-in, also the type of `~/…/` literals; constructor overloads, `test`, `exec` returning `Array<String>` — the match extras `index`/`input`/`groups` stay untyped, reachable via `(m as *)` —, flag getters, assignable `lastIndex`; legacy statics, `compile`, `RegExp.escape` left out), `Iterator<T>` (what `values()`/`keys()`/`entries()` return; hidden constructor, `Iterator.from` overloads, `next():IteratorResult<T>` with `typedef IteratorResult<T> = { done:Boolean, value:T }`, the lazy ES2025 helpers `map`/`filter`/`take`/`drop`/`flatMap`, and `toArray`/`forEach`/`reduce`/`some`/`every`/`find`; `for (… of iterator)` is typed; `Iterator.concat` left out as too new; the conformance test also checks members against sample objects, since `next` lives on concrete iterators), `Set<T>` (constructors from nothing/array/set with `T` inferred, add/has/delete/clear/size/forEach and the ES2025 algebra methods; `for (… of set)` types the loop variable `T`, also for subclasses of `Set<T>`; `values()`/`keys()`/`entries()` return `Iterator`; the `Set` global is no longer untyped), `Date` (constructor overloads for now/ms/text/copy/local parts; getters `int`, time values `Float`; setters as overloads because an omitted part means "keep"; `new Date()` comparisons go through `getTime()`; invalid dates make getters NaN at runtime, documented; deprecated `getYear`/`setYear`/`toGMTString` left out), `Math` (namespace; all results `Float` incl. `floor`/`round`/`ceil`/`trunc`/`sign`, only `clz32`/`imul` are `int`; `max`/`min`/`hypot` take `...values:Array<Float>`; `f16round`/`sumPrecise` left out as too new; the `Math` global is no longer untyped), `console` (namespace like `JSON`: hidden constructor, typed static methods with `...data:Array` rest parameters, shared Bun/Node/browser members only; the `console` global is no longer untyped), `JSON` (namespace: hidden constructor, `new JSON()` is X0415; overloaded `stringify` with function/key-list replacer and int/String indent; `rawJSON`/`isRawJSON` left out as not yet portable). Fixes along the way: `Boolean(x)`/`String(x)`/`Float(x)` stay casts when a std class has that name; method closures on primitives emit `x.m.bind(x)`; `new Boolean(…)` explains wrapper objects; overload notes print signatures as declared; generic typedef names keep substituted arguments in messages (`IteratorResult<int>`, not `<T>`); integer literals before `.` are parenthesized in JS (`(255).toString(16)`); the conformance test also checks static constants' values against their types; `inline` constants allowed in natives; a typedef naming a class (or a primitive with a std class) works as a value: `Int.MAX_VALUE`, `Int(x)`, `Bool(x)`; `Int`/`UInt`/`Bool`/`Any`/`Void` moved from the compiler's built-in table to prelude typedefs
- [x] Root files may leave out `package { … }` (top-level package only; subfolders keep it, X0010 with a wrapping fix-it)
- [x] Part D (partial): VS Code syntax highlighting only — `packages/vscode-xenon` (TextMate grammar, language configuration, README with install steps), tested with VS Code's tokenizer (`tests/grammar.test.ts`); no language server / IntelliSense yet
- [x] One array type (decided 2026-11-18): `Vector<T>` removed, `Array<T>` is the typed array and a bare `Array` is `Array<*>`; `*` as a type argument is a wildcard (`Box<int>` fits `Box<*>` and back); `Vector` is X0424 with a fix-it; `is Array<int>` is X0394 (`is Array` works)
- [x] `Promise<T>` is a std native class (`src/prelude/std/Promise.xn`, written by the user) instead of a compiler built-in; `async`/`await` use it; reserved words are allowed as member names (`function catch(…)`, `p.finally(…)`)
- [x] G4: migration — examples typed where they were only untyped for lack of built-in types (`Map<String, int>` in destructuring/interop, `Array<String>` from parsed JSON in enums); `globals.ts` holds only the JS globals without a declaration, and the coercing global functions/values (`parseInt`, `parseFloat`, `isNaN`, `isFinite`, `NaN`, `Infinity`) are hidden with `Float.…` fix-its (`tests/errors/globals`); README gains a standard-library section
- [x] G5.1: `Object` statics — std native class `Object` (`src/prelude/std/Object.xn`) supplies `keys`/`values`/`entries`/`getOwnPropertyNames`/`hasOwn`/`getOwnPropertyDescriptor`/`is`, `assign`/`fromEntries`/`create`/`groupBy`/`defineProperty`, `getPrototypeOf`/`setPrototypeOf`, and `freeze`/`seal`/`preventExtensions` with their `is…` tests; the `Object` type stays built in and `new Object()` still works; `assign`/`freeze` & co. are generic and return their argument's type; an object literal passed for a bare type parameter is now decided after the expected type (`var p:Point = Object.freeze({ x: 1, y: 2 })`), like array literals; `Object` is no longer an untyped global
- [x] G5.2: global functions — `native function` at package level, only in the standard library (user code gets X0029: functions belong to classes); `src/prelude/std/globals.xn` declares the timers (`setTimeout`/`setInterval`/`clear…` with `Float` delays and `*` handles), `queueMicrotask`, `structuredClone<T>` (+ `{ transfer }`), `fetch` (with a `RequestInit` shape typedef, resolving to `Promise<*>`), the URI functions and `atob`/`btoa`; identifiers resolve to them after locals, members, classes and JS imports, calls go through the usual overload/generic path, and the output calls them by their JS name; the conformance test also checks package-level functions; fixes: async block arrows passed for a `() -> Void` callback are typed `() -> Promise<void>` (were X0763 at the wrong place), X0763 for async arrows points at the arrow, overload errors name the called function
- [x] `Object` instance members — `toString`/`toLocaleString`/`valueOf`/`hasOwnProperty`/`isPrototypeOf`/`propertyIsEnumerable` declared in `Object.xn` and inherited by every class instance, interface, native class and shape (`Object` values: declared members typed, the rest stays `*`); the override rule (`override` needed, matching parameters, a return type that fits) reads these declarations instead of a built-in table, and now also rejects a wrong return type (`toString():int`); `Object.assign` returns `*`, `fromEntries`/`groupBy` take iterators and sets, overload choice binds generic parameters from the argument (nested `Array<Array<V>>`)
- [x] Hard-coded member knowledge moved to declarations: `Function.xn` gives every function value (typed or `Function`) `call`/`apply`/`bind`/`length`/`name` plus `Object`'s members, unknown members are X0426 with a `(f as *)` hint, `name`/`length` are read-only, `new Function(…)` is X0415 (eval), reading a method's `name`/`length` doesn't bind it; destructuring a primitive (`var { length } = text`) uses its std class (typos and methods reported, was `*`); writes to an inherited `Object` member (`dog.toString = …`) are X0505; duplicate `JS_GLOBALS` entries removed. (The hard-coded `for … of` list was replaced by `IEnumerable<T>`, see below.)
- [x] G5.4: nullable types — `T?` and `Null<T>` (one type; `T?` is built in, `Null<T>` is the prelude's `typedef Null<T> = T?`; `nullable` wraps `int`/`uint`/`Float`/`Boolean` and type parameters, other types already include `null` and stay as they are, also after substitution: `Map<String, Dog>.get()` is `Dog`); assignability (`int` and `null` fit `int?`, an `int?` fits only nullable types), `??` gives the non-null type, `?.` on an `int?` works and gives a nullable result, `.`/operators/`++` on one are X0398 with `??`/`if (var …)` fix-its (parenthesized as operands); `if (var x:int = maybe)` narrows (X0320 now means the value can never be null); `as int?` is the checked cast (X0393 suggests it), `is int?` is X0395; optional shape members read as `T?` and take `null`; std: `Map.get` → `V?`, `Array.pop`/`shift`/`at`/`find`/`findLast` and `Iterator.find` → `T?`, `String.codePointAt` → `int?`; parser reads `?` after a type only before a token that can end one, so `x is int ? a : b` stays a conditional; `examples/nullable`, `tests/errors/nullable.xn`. Fixes: `d?.bark()` was X0607 (a `?.` call counted as taking the method as a value), conversion hints for `int?` values, `if (flag)` with `Boolean?` suggests `== true`
- [x] Null-check narrowing — locals and parameters of type `T?` are `T` where a check proves it: `if`/`else` branches of `x != null` / `x == null` (also through `!`, `&&`, `||`), the right side of `&&`/`||`, both arms of `?:`, `while` bodies, the rest of a block after `if (x == null) return/throw/break/continue` (and after `while (x == null) …` without `break`), and after assigning a non-null value (`x ??= 0`, `x = 5`); assigning an `int?` ends it up to where the check was. Sound limits: fields aren't narrowed, narrowing doesn't reach into function expressions unless the local is `final`/`const`, and a variable assigned anywhere in a loop isn't narrowed by checks outside it; each gets its own X0398 note. Narrowing lives in the checker's scopes (reads use the narrowed type, writes the declared one)
- [x] Enumerables (C#-style; symbols stay out of `.xn`) — prelude interfaces `IEnumerator<T>` (`moveNext():Boolean`, `get current():T`) and `IEnumerable<T>` (`getEnumerator():IEnumerator<T>`), with markers like other interfaces; the std `Array`, `String`, `Set`, `Map` and `Iterator` declare `implements IEnumerable<…>` without the member (JavaScript iterates them), and their subclasses needn't add it; a class implementing `IEnumerable<T>` gets a generated `*[Symbol.iterator]()` walking `getEnumerator()`, so `for … of` works on it in Xenon and in plain JS; `x.getEnumerator()` that resolves to the interface's declaration (built-ins, `IEnumerable`-typed values) compiles to the prelude's `Enumerable.enumerate(x)`, which uses the object's own method or wraps a JS iterator (`Iterator.from`); `for … of` takes the element type from `IEnumerable<T>` instead of a hard-coded list (a class without it is X0391 with a hint); `is IEnumerable` tests `typeof x?.[Symbol.iterator] == 'function'`; arrays and strings fit `IEnumerable<…>` and infer its `T`, array literals take their element type from it. `Symbol` is an untyped JS global again. Fix: interface stubs (X0787 fix-it) substitute the class's type arguments (`IEnumerator<int>`, was `IEnumerator<T>`). `examples/enumerable`, `tests/errors/enumerable.xn`
- [ ] Part G follow-ups (G5.5 on): overload choice by array-literal elements, a `RegExp` match type. Open: non-null class types (`Dog` vs `Dog?`), members on type parameters, generators (`yield`) for enumerators
- [x] Part D milestone 18, source maps (line level): every generated line maps to the start of the Xenon statement or declaration it came from (`Writer` records an origin per line; function bodies built in their own writer carry theirs as line-start markers, `\u0001n\u0002`); `build`/`run`/`watch` write a `.js.map` per module with `sources` pointing at the real `.xn` file and the text in `sourcesContent` (the prelude's too), `//# sourceMappingURL` at the end; `--no-source-maps` / `"sourceMaps": false` turn them off; `compileProject` emits them only when asked (`sourceMaps: { sourceRoot }`). Node (`--enable-source-maps`), browsers and debuggers apply them; Bun 1.4 ignores input maps, so `xenon run` / `watch --run` preload `src/runtime/stacktrace.ts`, which maps `err.stack` through `Error.prepareStackTrace` and reports uncaught errors and rejections with an `.xn` code frame. Maps aren't counted as outputs in watch messages (a map-only change doesn't restart). Names and literals map column-exact since milestone 19. Known: JavaScriptCore attributes some errors to the previous line (e.g. a property read on a variable it knows is `null`)
- [x] Part D milestone 19, `ts` emit target + position map: `generate(…, { target: "ts" })` / `--target ts` / `"target": "ts"` writes `.ts` modules (imports still name `.js`; TypeScript and Bun resolve them) with types printed from the checker's resolved types (`CheckResult.typeNodeTypes`, every annotation): `int`/`uint`/`Float` → `number`, `String` → `string`, `*` → `any`, `T?` → `T | null`, `Object` → `Record<string, any>`, `Iterator<T>` → `IteratorObject<T>`, function types and shapes structurally, typedefs as (exported) `type` aliases imported with `import type` (typedef-only files get a module; the standard library's typedefs use TypeScript's names: `IteratorResult<T>`, `RequestInit`), enums as `const` + `type E = (typeof E)[keyof typeof E]`, interfaces as `interface` next to their marker symbol (`IEnumerable<T>` adds `[Symbol.iterator]`), `implements`/type parameters/`private`/`protected` kept, `new Box<number>()` keeps its arguments. Built-in enumerables get `getEnumerator()` through a `declare global` block in `xenon/Prelude.ts`. Glue TypeScript can't type goes through `as any` (interface markers, method-closure caches, prototype marks) and casts TypeScript can't see as downcasts through `as unknown as T`; temporaries are `any`; an abstract class's implicit constructor takes the parent constructor's parameters as a tuple. Token mappings: the code generator wraps every name, literal and type annotation in markers (`\u0003n\u0004…\u0005`), resolved into `{ source, sourceLength, generated, generatedLength }` per module (`OutputFile.mappings`, lookups `sourceOffsetAt` / `generatedOffsetAt`); the same markers make JS source maps column-exact (a segment per name and literal). Checked with the TypeScript API, `strict: false` (Xenon references may be `null`): zero errors on every example; Bun runs the output with the same results. A TypeScript error on a typed JS import (`var n:int = readFileSync(…)`: `*` to Xenon, `string` to TypeScript) maps back to the `.xn` position.
- [x] Part D milestone 20, language server: `xenon lsp` speaks LSP over stdio (`src/lsp.ts`, on `vscode-languageserver`) on top of a protocol-independent service (`src/service.ts`, `XenonProject`): each file's project is found from its location (see the follow-up under milestone 22); open editors override the disk; every change recompiles the project in editor mode (`compileProject(…, { target: "ts", tolerant: true })`: generates TypeScript even with errors, file by file, `Error` nodes as `(undefined as any)`; results carry `asts` and `check`) and publishes diagnostics for all files (debounced 150 ms). **Diagnostics**: Xenon's (notes and help appended, secondary labels as related information) plus TypeScript's errors on the virtual files where they map to a token and Xenon reported nothing there, e.g. `var n:int = readFileSync(…)` (TS2322 on `n`). **Hover**: Xenon terms first (`function Map.get(key:String):int?` with the receiver's type arguments substituted, `x:Animal`, `class zoo.Animal`, typedefs) with the `/** … */` comment before the declaration; where Xenon only knows `*`, TypeScript's quick info. **Go to definition**: locals (resolutions now carry the declaration: `{ kind: "local", decl }`), members, classes, typedefs, native functions; the standard library's sources are written to a temp directory so editors can open them; JavaScript imports into their `.d.ts` (or back into `.xn` through the mappings). **Completion**: after `.` the members of the receiver's type (instance or static, visibility-filtered, plus `Object`'s / `Function`'s), with a placeholder name when nothing is typed yet; `*` receivers get TypeScript's members (`path.` → `basename`, …); elsewhere locals declared before the cursor and parameters, the class's members, visible classes, standard-library functions, JS imports and keywords. Queries by position use `nodesAt` (a generic walk over the AST's spans). Deviation from the plan: no Volar.js; Volar maps one virtual file per source file, while Xenon checks the whole project at once, so the service runs a TypeScript `LanguageService` directly over the generated files (virtual paths under `<project>/.xenon/ts/`, resolving `node_modules` from the project). Tests: `tests/service.test.ts` (in memory) and `tests/lsp.test.ts` (a stdio session).
- [x] Part D milestone 21, VS Code extension: `packages/vscode-xenon` is now a full client (`src/extension.ts`, `vscode-languageclient` 9, VS Code ≥ 1.82): it starts the language server for `.xn` files with Bun, forwards `**/*.xn` file events, restarts on **XenonScript: Restart Language Server**, on saving `xenon.json` and on setting changes (`xenon.bunPath`, `xenon.server.path` to run a compiler checkout's `src/cli.ts lsp` instead), and explains a server that doesn't start (no Bun). The server is bundled into the extension (`src/server.ts` → `dist/server.js`, compiler and TypeScript included; TypeScript's `lib.*.d.ts` copied beside it, where it looks for them), so the extension works without a compiler checkout. `bun run build` / `bun run package` (`@vscode/vsce`, `--no-dependencies`) → `xenon.vsix` (≈2 MB); grammar and language configuration as before. `tests/lsp.test.ts` runs its stdio session against both `xenon lsp` and the bundled server (built by the test), including a TypeScript error that needs the bundled `lib` files. Fix found on the way: a Xenon *warning* (e.g. unused variable) no longer hides TypeScript's error at the same spot (only Xenon errors do). Installed in place of the earlier symlinked folder (syntax highlighting only).
- [x] Part D milestone 22, rename, references, signature help, outline, quick fixes (service + LSP, so the VS Code extension gets them as is). Names resolve to symbols (`describe` → `Sym`: the declaration, plus the member or class); every name kind is covered: expression names, `obj.member`, declaration names (fields, methods, classes, typedefs, parameters, locals, loop/catch variables, destructured names), the last part of type names and `import a.b.C`, shorthand properties `{ name }`. **References** walk every user file for names with the same symbol; members are one symbol with what they override or implement (they share a topmost declaration: `Dog.speak` and `Cat.speak` both overriding `Animal.speak` are renamed together). **Rename** (with prepare): edits every occurrence, keeps shorthand properties' keys (`{ label }` → `{ label: title }`), renames a public class's file (`Dog.xn` → `Puppy.xn`, as a file operation when the editor supports it); refuses the standard library (also members overriding it, like `toString`), keywords and invalid names. **Signature help** inside `(…)` of calls and `new`: parameters with their label ranges, the active argument (top-level commas; a placeholder fills `f(1, |)`), standard-library overloads as separate signatures with the receiver's type arguments, doc comments; callees Xenon types as `*` (JavaScript imports) get TypeScript's signatures. **Outline**: classes/interfaces/enums with fields, constants, constructor, methods, accessors (with types), and typedefs. **Quick fixes**: every `help:` with edits from the checker becomes a code action (carried in the diagnostic's `data`; the first is preferred), e.g. `===` → `==`, missing interface members, `override`. Not checked yet: a rename that collides with an existing name. Follow-up fix (opening the compiler repository itself reported the prelude's sources as a broken project): the server no longer takes the workspace folder as the one project; each file finds its own (`locateProject`: the nearest `xenon.json` whose source root contains it, else the nearest `src/` without JavaScript/TypeScript files in it), several projects per workspace (each example is one), loaded when a file of it is first opened; files in no project (the compiler's `src/prelude`, `tests/errors`) get no diagnostics.
- [x] Part D milestone 23, `.d.ts` types for JavaScript imports in the compiler (`src/dts.ts`; `CompileOptions.typeRoot`, set by `build`/`run`/`watch` and the language server to the source root): a probe file repeating every `.xn` file's JavaScript imports goes through TypeScript (`esModuleInterop`, bundler resolution, default `@types`), so `export =`, re-exports and default imports resolve as TypeScript sees them. Each typed binding is written out as Xenon native declarations, one generated file per importing file (`__js/F<n>.xn`, a `SourceFile` flagged `generated`: checked, never emitted, not visible elsewhere, its own diagnostics dropped into `CompileResult.declarationErrors`): a module namespace (or default export that is a plain object) → a native class named after the local binding with the exports as statics (`path.join` emits `path.join`); an exported class, or a variable holding a constructor (`declare var URL: typeof _URL`) → a native class under the local name (`new`, `is`, statics; constructors and overloads kept); a function or value → a static of the file's holder class, bound to the local name (`scope.jsMembers`; overloads go through the usual overload choice: `readFileSync(f, 'utf8')` → `String`). Types: `string` → `String`, `number` → `Float`, `T | null` → `T` / `Float?`, string-literal unions → `String`, arrays → `Array<T>`, `Promise`/`Map`/`Set`/iterators/`RegExp`/`Date`/`Function`/`Object` → the standard library's, callable types → function types, classes and interfaces with methods → native classes keyed by symbol (so `NonSharedBuffer` is `Buffer`; extending their first non-library base and declaring only own members; an instance member wins over a same-named static), other object types → typedef shapes (recursive ones too), with the JSDoc as doc comments (hover shows them). Everything else is `*`, member by member: other unions, intersections, tuples, enums, type parameters, typed arrays and other library types, overloaded methods inside shapes (`Function`); at most 400 declarations per file. A typed JavaScript parent is a real parent (subclasses are assignable to it, inherited members typed), but `override` stays optional and signatures aren't compared against `.d.ts` members. Diagnostics: secondary labels pointing into generated files are removed; fix-its never suggest a type only the declarations know. The TypeScript output types generated declarations as `any` unless bound to a local import name (TypeScript reads the originals). Results are cached per project and import set (TypeScript loads lazily, only for projects with JavaScript imports; a build with typed imports takes ~0.5 s, without them unchanged). Language server: hover/completion/signature help answer typed imports in Xenon terms; go to definition still opens the `.d.ts`; rename refuses `.d.ts` members; TypeScript's errors remain for what Xenon types as `*`, except on lines where Xenon reports an error. Tests: `tests/dts.test.ts` (errors, untyped fallbacks, classes and subclasses, no emitted declarations, fix-its, 23 Node/Bun modules generating cleanly), golden examples compile with typed imports and assert no declaration errors, new `examples/declarations` (fs overloads, `URL`, `crypto` chains, an `EventEmitter` subclass, `bun:sqlite`). Not yet: generic signatures (type parameters are `*`), typing JS globals (`process`) from `.d.ts`, refreshing declarations after `npm install` in a running watch/server (restart). Follow-up (a library kept in the source folder, like `xlsx.js` + `xlsx.d.ts`): relative imports are resolved from the importing file's folder (they were resolved from the source root, so `'../lib/x.js'` in a subfolder stayed `*`); `build`/`watch` copy the source folder's `.js`/`.mjs`/`.cjs`/`.json`/`.d.ts` files to the output (`CompileOptions.assets`, `readAssets`; tracked by the output manifest, so deleted ones are removed; X0030 when one has a compiled module's path); a namespace import's exported types are nameable as `Ns.Type` (classes as native classes whose JavaScript name is `Ns.Type`, so `new`/`is` work; interfaces and aliases as typedefs; `JsBinding` kind `typedef`, `Ns.Type` entries in the file scope). Not yet: importing a type by name (`import { WorkBook } from …` would also be a runtime import of a name that doesn't exist). `examples/vendor`.
- [x] `--bundle` for `build`/`run`/`watch` (and `"bundle": true` in `xenon.json`; not with `--target ts`): `src/bundle.ts` bundles the compiled modules from memory with `Bun.build` (`files`, `root` = the output folder, `target: "node"`: plain ESM — with `"bun"` its `// @bun` header made Bun bypass the stack-trace mapping of uncaught errors) into one `xenon-main.js`, so `run` and the entry name are unchanged. Vendor code stays outside: `packages: "external"` keeps npm packages and `node:`/`bun:` modules as imports; a plugin turns relative imports of non-compiled files (the source folder's copied JavaScript, `OutputFile.asset`) into external imports by their path from the bundle. Unused prelude code is tree-shaken. Bun's module comments are shortened to output-relative paths. Source maps: Bun's map points at the intermediate modules, so it is composed with their maps (`composeMap`; per segment the module's last segment at or before that column; segments in a line's indentation dropped, Bun maps them to the previous line) into a multi-source map of the `.xn` files (`encodeMappings`); the stack-trace preload now handles maps with several sources. The output manifest removes the per-module files a previous unbundled build left. Tests: `tests/bundle.test.ts` (externals, copied JavaScript, tree-shaking, the composed map's sources, running the bundle, `build --bundle` replacing modules, the `--target ts` usage error), a bundled run in `tests/sourcemap.test.ts` (same code frame and `.xn` frames). `examples/bundle` (`"bundle": true` in its `xenon.json`: three packages, `lodash`, `node:os`, a JavaScript file in `src/vendor`); the golden runner bundles examples whose `xenon.json` asks for it.
- [x] `Promise<T>` complete (`src/prelude/std/Promise.xn` rewritten, with doc comments): the constructor; `resolve` (no value → `Promise<void>`, a promise → itself, a value), `reject`, `try`, `withResolvers` (`PromiseWithResolvers<T>` shape); `all`/`allSettled` (`PromiseSettledResult<T>` shape)/`any`/`race` over any `IEnumerable<Promise<T>>`; `then`/`catch` overloads for callbacks returning a value or a promise (flattened: `p.then(id => load(id))` is a `Promise<User>`), `catch(e => log(e))` → `Promise<T?>`, `finally`. Checker support: overloads that differ only in a callback's result are chosen by trying each function literal against them in order (`DiagnosticBag.speculate` discards the trial's diagnostics; an untyped result fits only a bare `U` or a concrete type; `-> Void` there means "returns nothing"); a trailing `void` parameter may be left out (`resolve()` for a `Promise<void>`, as in TypeScript); array literals passed for `IEnumerable<X>` infer `X` from their elements, and elements of unrelated types make it `*` (`Promise.all([user, posts])`); function arguments of a generic call get the expected type's bindings as context (`var p:Promise<void> = new Promise((resolve, reject) => resolve())`); the TypeScript output casts standard-library calls whose result has a nullable type argument (`CheckResult.tsResultCasts`). `examples/std` runs every member; `tests/errors/std-promise.xn`.
- [x] `Response` and `ArrayBuffer` in the standard library (`std/Response.xn`, `std/ArrayBuffer.xn`): `fetch` resolves to a `Promise<Response>` (was `Promise<*>`); `Response` has its constructor (`ResponseInit` shape), `error`/`redirect`, the status getters (`status:int`, `ok`, …) and the body readers (`json():Promise<*>`, `text()`, `arrayBuffer():Promise<ArrayBuffer>`, `clone()`), with `headers`, `body`, `blob()`, `formData()`, `bytes()` as `*` until those types exist; the static `Response.json(data)` isn't declared (a class can't have a static and an instance member of the same name). `ArrayBuffer`: fixed and resizable buffers, `slice`, `resize`, `transfer`/`transferToFixedLength`, `detached`, `isView`. The conformance test allows Bun's `Response.prototype.clone.length` of 1; the TypeScript output also casts standard-library results of type `Response` (Node's types make `clone()` undici's `Response`). `examples/std` exercises both.
- [x] `Blob` in the standard library (`std/Blob.xn`): constructor from `Array<*>` parts with a `BlobOptions` shape (`type`, `endings`), `size`, `type`, `slice` (with a content type), `text()`, `arrayBuffer()`, and `bytes()`/`stream()` as `*`; Bun's own `Blob` additions (`json`, `formData`, the `BunFile` methods) aren't declared. `Response.blob()` is a `Promise<Blob>`. The conformance test allows Bun's `Blob.prototype.stream.length` of 1.
- [x] `FormData` in the standard library (`std/FormData.xn`, `IEnumerable<Array<*>>`): `append`/`set` with text or a `Blob` (and a file name), `delete`, `has`, `get(name):*`, `getAll`, `forEach`, `keys`/`values`/`entries`; `Response.formData()` is a `Promise<FormData>`. The TypeScript output casts `FormData` results like `Response` (undici's class under Node's types) and iterates a `FormData` through `as unknown as Iterable<any>` (TypeScript's global `FormData` declares no iterator).
- [x] `File` in the standard library (`std/File.xn`): a native subclass of `Blob` (the first native `extends` in `std/`) with `name`, `lastModified:Float` and a constructor from parts, a name and `FileOptions`; what `FormData` hands back for a file (`if (value is File) …`). `File` is now a built-in name (X0028), so `examples/destructors` calls its own class `FileHandle`.
- [x] Semantic tokens (`XenonProject.semanticTokens`, `textDocument/semanticTokens/full`): object literal keys (`property`) and the members of shape types (`property` + `declaration`), found in the parsed code, so `{a:1}` and `{ method: 'POST' }` are keys and `x:int` stays an annotation whatever the spacing; the grammar no longer guesses keys from the spacing. The extension turns `editor.semanticHighlighting.enabled` on for Xenon files (many themes leave it off); themes without semantic rules colour `property` like `variable.other.property`.
- [x] Fields in JavaScript: private fields (`var`/`const`/`final`) compile to `#private` fields (really private: invisible to JavaScript code, `JSON.stringify`, spread and `Object.keys`); other `final`/`const` fields to a `#private` field behind a getter (JavaScript code can read them, assigning throws a `TypeError`; a static getter names its class, so it works through subclasses). Plain `var` fields stay plain properties, and enums, native classes and the prelude are unchanged. Writes inside the class use `#name` (`writeTargets`: assignments, `++`/`--`, destructuring targets); reads of non-private fields go through the getter. The `#` stays outside the mapped token, so source maps and the TypeScript output's token mappings cover the same name. X0772: a private field can't be destructured (`var { pin } = this`). Costs to know: `final`/`const` and private fields aren't in `JSON.stringify`, and private fields throw when their object is wrapped in a `Proxy`.
- [x] A setter may be less visible than its getter (`public function get color()` + `private function set color(…)`), never more (X0212, reworded). Reads are checked against the getter, writes against the setter (X0603 "the setter of `color` is private"); completion lists a property where it can be read. A private setter of a readable property compiles to a JavaScript private accessor `set #color(v)`, with `get #color()` reading through the public getter (so `this.color += …` and `Player.count++` work inside the class); JavaScript code gets a `TypeError` when assigning. Other narrower setters (`protected`, `internal`) are checked by the compiler only.
- [x] Expression bodies for methods, getters and setters: `public function get area():Float => width * height`, `function set width(v:Float):void => _width = v`, `static function of(n:int):Box => new Box(n)`, also with `const` and `async`. `=>` (not `->`, which belongs to function types: `function counter():() -> int => () => n++` stays unambiguous). The parser turns `=> expr` into a block with one statement (`A.Method.exprBody`): `return expr`, or the expression alone for `void`/`Void`/`Promise<void>` and setters; so checking, codegen, source maps and the language server need nothing new. The return type stays required. X0108: a constructor needs a block body. `examples/functions`, `tests/errors/expression-bodies.xn`.
- [x] Operator overloading for `-`, `*` and `/` next to `+`: `public function operator-(other:Vec2):Vec2`, `operator*(factor:Float)`, `operator/(divisor:Float)`; the same rules (one required parameter, a return value, instance methods, statically dispatched on the left operand) and compound assignments (`-=`, `*=`, `/=`, the target evaluated once). X0370 for a missing operator now covers all four and says what to declare; X0371 names the overloadable operators (`%`, `==` and unary `-` aren't). Fix: compound assignments with an operator method on a member (`this.pos += v`) now use the `#private` name of a private field (they wrote `this.pos`).
- [x] `operator==` (and so `!=`): `public function operator==(other:Point):Boolean const => x == other.x && y == other.y`. `a == b` is true for the same object, false when exactly one side is null, and otherwise `a['operator=='](b)` — the method never sees `null`; each operand is evaluated once (temporaries), left first. `a != b` is its negation, `===`/`!==` behave like `==`/`!=` (as before), `== null` stays a plain null check, `Object.is(a, b)` tests identity. Dispatched statically on the left operand's class (`*` operands compare by identity). `operator==` must return a `Boolean` (X0372); `operator!=` can't be declared (X0371: it is `!(a == b)`). JavaScript's own searches (`indexOf`, `includes`, `Map`/`Set` keys) still compare identity.
- [x] `constexpr` functions: `public static constexpr function kib(n:int):int => n * 1024`. A call with constant arguments is evaluated at compile time and its value pasted into the output (`kib(64)` → `65536`); it also counts as a constant where one is required (`inline final` values, enum members, `case` labels, "does the literal fit" checks). With runtime arguments it is an ordinary call (the function is emitted). Rules (X0526, at the declaration): `static`, parameters and result of a constant type (numbers, `String`, `Boolean`), and a body using only parameters, literals, operators, `?:`, conversions, inline constants, `Math`'s pure functions and constants, and other `constexpr` functions (recursion included). Evaluation stops at 1000 calls deep or 100000 calls (X0527). `inline` stays the keyword for constants (they are pasted); `constexpr` is for functions only (X0526 suggests `static inline final` for `static constexpr NAME:T = …`). The evaluator (`consteval.ts`) now passes calls to its lookup with their argument values, knows `Math`'s pure functions and constants, and evaluates only the chosen branch of `?:`.
- [x] Literal types (A6b) and `.d.ts` overloads chosen as TypeScript chooses them: `true`/`false`/`'text'`/numbers (`1`, `-1`, `0.5`; TypeScript's number literals too, not enum members) as types (`prim` with a `literal`; a `LiteralType` type node; printed `true`/`'buffer'`, emitted to TypeScript as `true`/`"buffer"`), object literal arguments matched structurally when choosing an overload. The generator (`src/dts.ts`) keeps boolean and string literal types (several of one kind stay their base: `BufferEncoding` is `String`), turns intersections of object types into one shape (`ObjectEncodingOptions & { withFileTypes: true }`), and splits a union parameter Xenon can't write (a shape among other types: `options: {…} | BufferEncoding | null`) into one overload per member (at most 4), so `fs.readdir(dir, { withFileTypes: true })` is a `Promise<Array<Dirent>>`. Imported classes and interfaces (`import { Dirent }`, `import { ChildProcessWithoutNullStreams }`) are declared under the imported name before other signatures use them, so both name one class; a callback with parameters fits a rest-parameter function type (`(chunk:String) => …` for `(...args:Array<*>) -> void`).
- [x] Union types (A6b): `A | B` and `null` members (`types.ts` `union` kind built by `unionOf`; `UnionType`/`NullType` nodes, `|` not parsed after `is`/`as`/`new`), assignability, members common to all members (X0426/X0428), narrowing generalized from non-null facts to narrowed types (`is`, literal `==`, `!= null`, assignment), completion lists the common members, TypeScript output `A | B`. The `.d.ts` generator writes TypeScript unions as unions (instead of `*`, or of splitting a parameter into overloads): named ones become typedefs (`BufferEncoding`, `PathLike`), kept whole inside larger unions (TypeScript's `origin`), `true | false` is `Boolean`, more than 30 literals of one kind their base type, function members `Function`; so `readdir(dir, 'buffer')` is the `Buffer` overload and `readFileSync(true)` a Xenon error.
- [ ] Part D (VS Code extension) and Later items

## Context
`/home/simon/projects/class-lang` is a fresh Bun + TypeScript project (only `index.ts`, `package.json`, `tsconfig.json`). Goal: build, step by step, a **class-based, statically typed language in the style of ActionScript 3** that compiles to readable ES-module JavaScript and can **natively import and use any JavaScript / npm library** (and be imported from JS).

Decisions so far:
- AS3 syntax & semantics: `package {}`, `public class`, `var`/`const`, `function`, postfix `:Type`, constructor named like the class, `override`, getters/setters, `trace()`.
- Deviations from AS3: generics written `Array<T>` (no dot, unlike AS3's `Vector.<T>`; XenonScript has one array type), `Float` instead of `Number`, `final` usable on classes, methods, fields, locals and parameters, an `inline` modifier for compile-time constants that are substituted at every use site, and `typedef` (Haxe-style aliases, structural shapes and function types).
- Static types from day one. Priority class features: inheritance + `super`, visibility, static members. Plus **enums**.
- Modern JS additions: **async/await, arrow functions, `?.` / `??`, destructuring & spread**. Strings use single quotes only; template strings are written `$'Hi {name}'`.
- **Optional semicolons** (JS-style automatic semicolon insertion).
- `function(){}` expressions keep **dynamic `this`** (JS/AS3 semantics); arrow functions have lexical `this`. Method references (`btn.onClick = this.handle`) auto-bind, like AS3 method closures.
- JS imports are typed `*` (dynamic); `.d.ts` typing is a later step.
- Imports: `import com.game.Player;` for own code, `import _ from 'lodash';` for JS.
- Entry point: document class — compiler emits `new Main()`.

Working name **XenonScript**, extension `.xn`.

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
| Literals | `true` `false` `null` `undefined` (compatibility only — every use produces warning X0840, see A2) |
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

**Built-in type names** (predeclared, not keywords; shadowing is a compile error): `int` `uint` `Float` `String` `Boolean` `Object` `Array` `Function` `Class` `RegExp`, plus the dynamic type `*`. **Built-in typedefs** (prelude): `Int` `UInt` `Void` `Bool` `Any` (see A2). **Built-in classes** (prelude): `Exception` `ArgumentException` `TypeException` `RangeException` `StateException` `NotImplementedException` (see A6c). `Error` and the JS error classes are hidden.

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
**Files in the source root** (the top-level package) may leave out the package block:
```actionscript
// src/Main.xn
import _ from 'lodash';

public class Main { ... }               // the declaration named after the file: visible to other files
class Helper { ... }                    // any other declaration: file-private, as after a package block
```
A second `public` declaration in such a file is X0025 (with "move it to its own file"). Files in folders still need `package com.zoo { … }`: without it X0010 offers a fix-it wrapping the file, and the file is still read as part of that package so files importing it get no follow-up errors.

JS output: `out/com/zoo/Dog.js`, an ES module with `export class Dog`, relative imports between classes, JS imports emitted as-is.

### A2. Types
| XenonScript | Meaning | JS |
|---|---|---|
| `int`, `uint` | integers (checker-enforced; `int(x)` cast) | number (`int(x)` → `x \| 0`, `uint(x)` → `x >>> 0`) |
| `Float` | floating-point number (replaces AS3's `Number`) | number |
| `String`, `Boolean` | | string, boolean |
| `void` | return type only | — |
| `*` | dynamic/untyped; anything goes, no checks; may be `undefined` | any |
| `Object` | any non-null object, member access unchecked | object |
| `Array<T>` | typed array; a bare `Array` is `Array<*>` (any elements) | Array |
| `Function` | any callable (untyped) | function |
| `Promise<T>` | result of `async` functions / JS promises | Promise |
| `Class` | a class reference | constructor |
| `T?`, `Null<T>` | `T` or `null`: `int?`, `Boolean?`, `T?` for a type parameter. `String`, arrays, objects and class types include `null` already (`String?` is `String`). Optional shape members (`?count:int`) read as `int?`; std results that may be missing are `T?` (`Map.get`, `Array.pop`/`find`/`at`). Using one needs a value: `n ?? 0`, `if (var x:int = n)`, `n?.toFixed(2)`, or a null check on a local/parameter (narrowing); arithmetic or `.` on an `int?` is X0398. `x as int?` is a checked cast (null for other values); `is int?` is X0395 | — (erased; JS gives `undefined` for missing values, which `== null`, `??` and `if (var …)` treat as null) |
| `ClassName`, `EnumName` | user types | class / frozen object |
| `{ x:Float, ?label:String }` | structural object type (usually named via `typedef`) | plain object, erased |
| `(Float, Float) -> Float` | function type (usually named via `typedef`) | function, erased |
| `TypedefName` | alias for any of the above (see A6b) | erased |

**Built-in typedefs** (A6b): every compile-time primitive also gets a capitalized alias, so code can use one consistent naming style. They are ordinary transparent typedefs in the prelude (package `xenon`, visible in every file without an import), each next to the class it aliases; the compiler itself only knows the lowercase names:
```actionscript
public typedef Int  = int        // src/prelude/std/int.xn
public typedef UInt = uint       // src/prelude/std/uint.xn
public typedef Bool = Boolean    // src/prelude/std/Boolean.xn
public typedef Any  = *          // src/prelude/Prelude.xn
public typedef Void = void       // src/prelude/Prelude.xn (only the prelude may alias `void`)
```
`Int` and `int` are the same type everywhere (messages print the underlying type, `int`). `Void` is only valid where `void` is (return types, function types, `Promise<Void>`; elsewhere X0421). As values they stand for their class like any typedef: `Int.MAX_VALUE`, `Int(x)`, `Bool(x)`. User code cannot redeclare these names (X0028).

Generic syntax is `Name<T>` with no dot (unlike AS3's `Vector.<T>`). Type arguments only appear in type positions (after `:`, `new`, `as`, `is`, and inside other type arguments), so the parser never confuses `<` with less-than. Nested generics like `Array<Array<int>>` are handled by splitting `>>` into two `>` tokens in type positions.

**`null` vs `undefined`**: XenonScript has one "no value", `null`. The `undefined` literal exists only for JS compatibility (e.g. passing it to a library that distinguishes the two) and every use produces **warning X0840**:
```
warning[X0840]: `undefined` is only supported for JavaScript compatibility
  --> src/Main.xn:12:13
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
- Values that are `undefined` at runtime without being written (missing optional members, JS return values, `*` reads) produce no warning. The null checks XenonScript generates (`if (var …)`, `?.`, `??`) always use `!= null` so they treat both the same.
- `--deny-warnings` turns it into an error. A single intentional use can be marked with `/* xenon-allow X0840 */` directly before it (a general per-line suppression comment usable for any warning code).

Default values (AS3 semantics, emitted explicitly): `int`/`uint` → `0`, `Float` → `NaN`, `Boolean` → `false`, `*` → `null` (XenonScript never emits `undefined` as a default), everything else → `null`.

Conversions / checks (all plain JS expressions): `int(x)` → `x | 0`, `uint(x)` → `x >>> 0`, `Float(x)` → `Number(x)`, `String(x)`, `Boolean(x)` unchanged; `x as Dog` → `(x instanceof Dog ? x : null)`; `x is Dog` → `x instanceof Dog`; `x is String` → `typeof x === 'string'`, `x is int` → `Number.isInteger(x)`; interfaces see A6. When `x` is not a simple name it's stored in a temp first. AS3's throwing class cast `Dog(x)` is **not supported** (it would need a helper, because JS has no throw expressions); use `as` with `if (var d:Dog = x as Dog)`. `Dog(x)` is X0380 with that fix-it.

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
| Construct | XenonScript syntax | JS output |
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
| For-of (values) | `for (var v:T of coll) {...}`, `for (var [k, v]:* of map) {...}` — replaces AS3's `for each` (`for each (...)` is a parse error with a hint to use `of`) | `for (const v of coll)` — always plain `for...of`. The source must be iterable (Array, String, Map, Set, any JS iterable, `*`). A source typed `Object` is X0390 with the fix-it `Object.values(obj)` |
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
- **Ranges only count up.** The loop always tests `i < end` (`..`) or `i <= end` (`..=`), so a range whose start is greater than its end runs **zero times**, as in Rust. When both bounds are constants and the range is empty, the checker warns (X0331: "range `10..0` is empty and runs 0 times"). To count down, use a C-style `for` or `while`.
- `step` (contextual keyword) must be a **positive** compile-time constant (literal or `inline` constant); default `1`. `step 0` or a negative step → error X0330 ("ranges can't count down; use a C-style `for`").
- The loop variable is read-only inside the body (assigning it is X0332), so the range can't be skipped around by accident.
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
- Binding types must be nullable (class types, `String`, `Object`, `*`, typedef shapes…). `if (var n:int = …)` is an error (X0320: "`int` can never be null; use a normal `if`").
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

while (var next:TreeNode = queue.next()) { depth++ }  // a binding can't refer to an outer variable of the same name (X0321)
```
Rules: bindings are visible only in the loop body, are fresh for every iteration (closures created in the body capture that iteration's value), and must have nullable types (X0320 as for `if`). `do … while (var …)` is not supported (the body would run before the binding exists).

JS output uses a `for` with an empty update so each iteration gets its own `let` binding:
```js
for (let line; (line = reader.readLine()) != null; ) { console.log(line); }
for (let job; (job = queue.poll()) != null && !stopped; ) { job.run(); }
```

Deliberately excluded: labels (for now), `with` (breaks static typing), `goto`, E4X/XML literals, `#include`, `use namespace`. `delete obj.key` only allowed on `*`/`Object` values (and `dynamic` instances once they exist).

### A5. Operators & expressions
- Arithmetic `+ - * / % **`, increment/decrement `++ --` (prefix/postfix), unary `- + ! ~`
- Comparison `== != < <= > >=`. **`==` and `!=` are always strict**: compiled to `===` / `!==`, so there is no type coercion (`'1' == 1` is `false`). The one exception is comparing with the `null` literal: `x == null` / `x != null` compile to JS's loose `x == null` / `x != null`, so they match both `null` and `undefined` (consistent with XenonScript having a single "no value").
  - `===` / `!==` are accepted for JS familiarity but produce warning X0841 ("`===` is the same as `==` in XenonScript") with a fix-it to the short form.
  - Comparing values whose static types can never be equal (`int == String`, `Dog == Cat` for unrelated classes) is **error X0309** ("this comparison is always false"); comparisons involving `*` or `Object` are unchecked.
  - Loose JS equality is not available; use explicit conversions (`String(n) == s`).
- Logical `&& || !`, nullish `??`, optional chaining `a?.b`, `a?.[i]`, `a?.()`
- Bitwise `& | ^ << >> >>>`
- Assignment `= += -= *= /= %= **= &= |= ^= <<= >>= >>>= &&= ||= ??=`
- Type operators `is`, `as`, `typeof`, `in`, `delete`
- Literals: numbers (`0xFF`, `1_000`, `1e3`), strings `'…'` and template strings `$'Hi {name}'` (see below), regex `~/ab+c/gi` (see below), arrays `[1, 2, ...rest]`, objects `{ a: 1, b, [key]: v, ...other }`, typed arrays from context `var v:Array<int> = [1, 2, 3]`
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
- `"…"` and `` `…` `` are not strings in XenonScript: the lexer reports X0360 with a fix-it converting `"…"` to `'…'` and `` `Hi ${x}` `` to `$'Hi {x}'`.
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
- Flags `d g i m s u v y`. Unknown or duplicate flags are error X0350, pointing at the flag.
- The pattern is validated at compile time (the compiler constructs `new RegExp(pattern, flags)`); syntax errors are reported as X0351 with the caret inside the pattern.
- Type `RegExp` is a built-in class with typed members: `test(s:String):Boolean`, `exec(s:String):Array` (null when no match), `source:String`, `flags:String`, `lastIndex:int`, `global:Boolean`… `String` methods `match`, `matchAll`, `replace`, `replaceAll`, `split`, `search` accept `RegExp`.
- JS output: the literal without the `~` (`/[A-Z]+/g`). Regex literals are not compile-time constants (not allowed in `inline`).

### A6. Class features (complete list)
**Class declaration modifiers**: `public` | `internal` (default; package-visible), `final` (no subclassing). `dynamic` (instances accept arbitrary new properties, typed `*`) is **deferred** — the keyword stays reserved; until then use `*`/`Object` values for open-ended data.

**Inheritance**: `extends` one class (XenonScript class *or* an imported JS class, then inherited members are `*`); `implements` any number of interfaces.

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
- The initializer must be a **compile-time constant expression**: number/string/boolean/`null` literals, other `inline` constants (from any class, across files), enum members, and the operators `+ - * / % ** << >> >>> & | ^ ~ ! && || ?: == != < <= > >=` (with XenonScript's strict `==`) and casts `int()` `uint()` `Float()` `String()` `Boolean()` applied to those. Calls, `new`, object/array literals and non-inline variables are errors ("inline initializer is not a compile-time constant").
- The checker evaluates the expression with a constant folder (`src/consteval.ts`) using exact JS semantics (so `7 / 2` → `3.5`, `int(7 / 2)` → `3`), checks the result fits the declared type, and detects cycles (`A = B + 1; B = A`).
- Codegen replaces every reference with the folded literal. A `private` inline constant is **not emitted at all**; `public`/`internal`/`protected` ones are still emitted as a static field so plain JS code importing the class can read them.
- An `inline` constant can be used in `switch` `case` labels and other inline initializers, which is where folding matters most.

**Methods**: instance or `static`; default parameter values; rest parameters `...args:Array`; return types incl. `void`; `async` methods; modifiers `override` (required when overriding, see below), `final` (cannot be overridden).

**`override` is mandatory**:
```
error[X0720]: `speak` overrides a method of `Animal` but is not marked `override`
  --> src/com/zoo/Dog.xn:6:19
   |
 6 |   public function speak():String { return 'woof' }
   |                   ^^^^^ overrides `Animal.speak`
   |
  ::: src/com/zoo/Animal.xn:9:19
   |
 9 |   public function speak():String { ... }
   |                   ----- original declared here
   |
help: add `override`
   |
 6 |   override public function speak():String { return 'woof' }
   |   +++++++++
```
- Every instance method, getter or setter that has the same name as an inherited member must be marked `override`; otherwise it's **error X0720** (with the fix-it above). Accidental shadowing is impossible.
- This includes implementing `abstract` members and redefining built-in inherited methods (`toString()`, which every class inherits from `Object`).
- `override` on a member that overrides nothing is **error X0721**, with "did you mean" when a parent member has a similar name (`override function speek()` → "did you mean `speak`?"). This catches typos and parents that renamed a method.
- The override must match the original: same parameter types and count, same return type (or a subclass of it), same visibility, same `async`, and a getter overrides a getter (X0722 lists the differences). It can't override a `final` member (X0723), and an override of a `const` method must be `const`.
- Fields can't be overridden; redeclaring an inherited field is X0724.
- `static` members are never overridden: a static with the same name as a parent static simply hides it, and `override static` is an error.
- Implementing an **interface** method does *not* use `override` (nothing is being replaced); `override` there is X0721. If the method also overrides a parent class member, `override` is required as usual.
- Parent classes imported from JS (typed `*`) have unknown members, so `override` can't be checked against them. It is optional there. Since milestone 23 a parent typed from its `.d.ts` is a real parent (typed members, subclasses assignable), but `override` stays optional against its members and signatures aren't compared: TypeScript's declarations are often looser than an override would be, and installing `@types` shouldn't break subclasses.

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

**Method closures**: a method referenced without calling it (`timer.onTick = tick`, `arr.map(this.format)`) compiles to a bound function, so `this` stays correct — the AS3 behavior. The bound function is cached on the instance (`obj[Symbol.for('xenon.bound.tick')] ??= obj.tick.bind(obj)`), so the same method reference is always the same function and `removeEventListener(handle)` works; symbol keys keep it out of `JSON.stringify`/`Object.keys`.

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

**Enums** (XenonScript extension):
```actionscript
public enum Direction { Up, Down, Left, Right }
public enum Status { Ok = 200, NotFound = 404 }
public enum Level { Low = 'low', High = 'high' }
```
→ `export const Direction = Object.freeze({ Up: 0, Down: 1, ... })`. Typed: `var d:Direction = Direction.Up`; switch over enum values (a `switch` without `default` that misses members warns, X0814); `Direction.values()` compiles inline to `Object.values(Direction)`. Members auto-number from the previous `int`; `String` enums need explicit values; values are unique compile-time constants. Enums are nominal (no mixing with numbers or other enums; `int(d)`/`String(d)` convert); `raw is Direction` / `raw as Direction` test raw values against the members (`Object.values(Direction).includes(raw)`).

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
- `new Shape(...)` is an error (X0710); abstract types are fine as variable/parameter types and with `is`/`as`.
- Only `abstract class` may declare `abstract` members (methods, getters, setters); they have no body and can't be `private`, `static`, `final` or `inline`. `abstract final class` is an error.
- Concrete subclasses must implement every inherited abstract member using `override`; one error (X0711) lists all missing members, with a fix-it that inserts stubs throwing `NotImplementedException`. Abstract subclasses may leave members unimplemented.
- `super.m()` on an abstract method is an error. Constructors may be `protected`.
- JS output (runtime guards for plain-JS consumers): the constructor starts with `if (new.target === Shape) throw new StateException("Shape is abstract")`, and each abstract member is emitted as a stub throwing `NotImplementedException("Shape.area")`.

**Const methods** (C++-style, shallow for now):
```actionscript
public class Inventory {
  private var items:Array<Item> = []
  private var total:Float = 0

  public function count():int const { return items.length }

  public function report():String const {
    total = 0                                           // error[X0901]: cannot assign `total` in const method `report`
    add(new Item())                                     // error[X0902]: cannot call non-const method `add` from const method
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
- **Dispatch is static** and based on the left operand: if its static type is a class with `operator+` (own or inherited), `a + b` becomes a method call and the right operand must match the parameter type (X0308 otherwise). There is no reverse lookup: `1 + vec` is an error.
- `+` on a class that has no `operator+` is error X0370 ("`+` is not defined for `Dog`"). In plain JS that would silently concatenate `[object Object]`. Exception: if either side is `String`, `+` is string concatenation as usual.
- `*` or `Object` on the left → plain JS `+` (no dispatch, unchecked).
- `a += b` → `a = a['operator+'](b)`; with a member or index target, the object/index is evaluated once (`(t = obj).pos = t.pos['operator+'](v)`).
- Any other `operator<symbol>` declaration is X0371 ("only `operator+` is supported for now"). Later candidates: `- * / ==` and unary `-`.
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
Parsing: `using` followed by `(` is the block statement; otherwise it's the declaration form shown above. The variables in a block's header are `final` and only visible inside the block. The checker requires every resource to be disposable (X0802 otherwise, with a hint when the type has no destructor).
JavaScript is garbage-collected and never destroys objects at a predictable moment, so destructors use JS **explicit resource management** (`using`, `Symbol.dispose`; supported by Bun and TypeScript 5.2+). They are deterministic: they run when a `using` scope ends or when `dispose()` is called, **not** when the GC collects the object.

Rules:
- At most one destructor per class, named `~ClassName`, no parameters, no return type, `public` (default) or `protected` (then only `using` and subclasses can trigger it). Not `static`, `abstract`, `final` or `inline`.
- `async ~User()` makes an async destructor. Such values must be held with `await using` inside an `async` function, and explicit disposal is `await u.dispose()`.
- A class with a destructor gets an implicit `public function dispose():void` (or `Promise<void>`), so `dispose` can't be declared as a normal member there. Classes with destructors are assignable to the built-in interfaces `IDisposable` / `IAsyncDisposable`.
- **Inheritance**: subclass destructors automatically call the parent destructor *after* their own body (C++ order: derived, then base). A subclass without its own destructor inherits the parent's.
- **Runs at most once**: a second `dispose()` or scope exit is a no-op.
- `using x:T = expr` requires `T` to be disposable; the type annotation is optional (inferred from the value). The variable is implicitly `final`. `null` is allowed (nothing to dispose).
- Warning X0801: a disposable created into a plain `var` local that is never disposed, returned or stored ("use `using` or call `dispose()`").
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
Plain JS can dispose XenonScript objects with `using` or by calling `dispose()`. `using` is passed through to JS directly (Bun supports it), so no lowering is needed.

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
- Placement follows the class file rules: one `public typedef` per file named after it (e.g. `geom/Point.xn`), any number of file-private typedefs after the package block. Imported like classes: `import geom.Point;`.
- Recursive typedefs are allowed through members (`typedef Node = { value:int, ?next:Node }`); a direct cycle (`typedef A = B; typedef B = A`) is an error.
- Type parameters come with generics (Part G): `typedef Pair<A, B> = { first:A, second:B }`.
- **Literal types**: `true`, `false`, string and number literals are types with one value each (`typedef Raw = { encoding:'buffer' }`, `{ withFileTypes:true }`, `{ version:2, ?level:-1 }`), as in TypeScript. A literal fits its base type (`true` is a `Boolean`); a number literal's base is `int` for an integer in range (`1`, `-1`), else `Float` (`0.5`, `1.0`), it fits every numeric type its value fits (`1` is also a `uint` and a `Float`), number literals compare by value (`1` fits `1.0`), and arithmetic on them gives their base type; only a constant with that value fits the literal (`var b:true = flag` with `flag:Boolean` is X0308). They can't be tested at runtime (`x is true` is X0394: compare with `==`). Overloads are chosen by them: an object literal argument picks the first overload whose shape it fits structurally (its keys are members, required members given, constant values fit literal and primitive members); when none does, the first overload taking a shape is checked and reports what is wrong.
- **Union types**: `A | B` holds a value of either type (`typedef Id = int | String`, `'utf8' | 'ascii'`, `{ ?level:0 | 1 | 2 }`, `Array<int | String>`). `null` is a type only as a union member (X0798 alone): `int | Boolean | null` is the nullable union (`int | null` is `int?`). Unions are normalized: nested ones flattened, `*` swallows the rest, a member another one takes is dropped (`'a' | String` is `String`, `Dog | Animal` is `Animal`), `true | false` is `Boolean`. A union fits where each member fits; a value fits a union when it fits a member (constants by value: `'utf8'` fits `Encoding`; object, array and function literals against the member of their kind). Members: `x.m` works when every member type has `m` alike (one type; for methods one signature all others fit, giving the union of their results: `toString` on `int | String`), else X0426 (missing on some member) or X0428 (differs), both with a narrowing hint. Narrowing: `x is T`, `x == 'utf8'` (a literal member) and `x != null` narrow union locals in branches, `&&`/`||`/`!` and early exits, and assignment narrows to what the value can be. `x is A | B` can't be written (`|` after `is`/`as` is the operator); a union typedef there is X0394 with a hint testing each member. Emitted to TypeScript as unions. Not yet: recursion through a union member (`typedef Json = String | Array<Json>` is X0790; through a shape member it works), switch exhaustiveness over literal unions.

New token: `->` (function type arrow), and `?` before a member name inside a shape type.

### A6c. Built-in `Exception` class
XenonScript code always uses `Exception` instead of JS's `Error`. It is defined in the prelude (written in XenonScript itself, the only file allowed to touch `Error`) and auto-imported:
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
- `Error` and its JS subclasses (`TypeError`, `RangeError`, `SyntaxError`, …) are **not visible** in XenonScript code: using them is a compile error with the hint "use Exception / TypeException …". (Escape hatch: `globalThis.Error` via `*` for rare interop.)
- `throw` only accepts expressions whose static type is `Exception` or a subclass (or `*`, checked at runtime: non-Exception values are wrapped).
- Catch clause types must be `Exception` or subclasses; `catch (e)` without a type means `catch (e:Exception)`. `catch (e:*)` is not allowed.
- **Everything caught is an `Exception`**: generated code passes the raw value through `Exception.from()`:
  - already an `Exception` → unchanged
  - JS `TypeError` → `TypeException`, `RangeError` → `RangeException`, any other `Error` → `Exception`; message and stack copied, original kept in `cause`
  - non-Error value (`throw "oops"` from a JS lib) → `Exception("Non-error value thrown: oops", cause = value)`
  
  So errors from npm libraries and rejected promises (`await`) are caught as typed `Exception`s. The original JS error is always in `e.cause`.
- Compiler-generated failures throw the built-in classes: abstract instantiation → `StateException`, abstract stubs → `NotImplementedException`.
- Because `Exception` really extends JS `Error`, exceptions thrown from XenonScript into plain JS code behave as normal errors (stack traces, `instanceof Error`, `cause`).

### A7. Semicolons (ASI)
Statements end with `;` or a newline, following JS's ASI rules: restricted productions (`return`, `break`, `continue`, `throw`, postfix `++`/`--` cannot be followed by a line break before their operand), and a statement continues onto the next line when the next token can't start a new statement. The lexer records "newline before token" on each token so the parser can apply this.

---

## Part A8 — Output principle: vanilla JavaScript first

The generated code should look like what a person would write by hand in modern JS:
- **Vanilla first.** Every construct compiles to standard ES2022+ syntax (`using` from explicit resource management, which Bun supports). The current design needs no helpers (see the table below).
- **Runtime helpers only as a last resort.** A helper may be added only after showing that the feature can't be compiled to plain JS expressions/statements, not even with temporaries, an extra block, or a different lowering. Each helper:
  - is recorded in `docs/runtime-helpers.md` with the feature it serves, the vanilla lowerings that were considered and why they fail, and its JS source;
  - is a small named export in `out/xenon/runtime.js`, imported only by modules that actually use it (`import { castOrThrow } from '../xenon/runtime.js'`), never a global and never inlined boilerplate;
  - has its own unit test.
  The first candidate if wanted later is AS3's throwing cast `Dog(x)`, because JS has no throw expressions.
- Besides any justified helpers, the only runtime code XenonScript ships is the **prelude** (the `Exception` family, A6c). These are ordinary classes written in XenonScript, emitted as `out/xenon/Exception.js` etc., and imported only by modules that use them.
- Names are preserved (classes, methods, fields, locals). Generated temporaries (`$t1`, `$end`) appear only where an expression must be evaluated once, and are declared with `let`/`const` in the nearest scope.
- Compile-time-only features leave nothing behind: types, typedefs, visibility, `final`, `const` methods, `override`, `inline` constants (folded).

| XenonScript feature | Vanilla JS output |
|---|---|
| class, fields, getters/setters, statics, static block | `class`, class fields, `get`/`set`, `static`, `static {}` |
| `int(x)` / `uint(x)` / `Float(x)` | `x \| 0` / `x >>> 0` / `Number(x)` |
| `x as Dog` / `x is Dog` | `x instanceof Dog ? x : null` / `x instanceof Dog` |
| `x is IShape` | `x?.[IShape] === true` (interface symbol) |
| `==` / `!=` (`== null`) | `===` / `!==` (`== null`) |
| method closure `this.handle` | `this[Symbol.for('xenon.bound.handle')] ??= this.handle.bind(this)` (cached → stable identity) |
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
.xn files → lexer → parser → AST → resolver (packages/imports) → checker → codegen → .js ESM → bun run
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
- `cli.ts` + `watch.ts` – the `xenon` command line tool (Part F)

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
8. **Inheritance & super** – `extends` (XenonScript and JS classes), mandatory `override` with X0720–X0724, `final` classes/methods, implicit `super()`, `super.x`.
9. **Visibility** – public/internal/protected/private rules.
10. **Getters/setters, method closures** (`dynamic` classes deferred to "Later").
11. **Exceptions** – prelude `Exception` hierarchy compiled from XenonScript, `Exception.from` normalization, hiding `Error`, `throw` type rule, typed multi-catch, finally, catching errors thrown by an npm library as `Exception`.
12. **Functions** – function expressions, arrows, local functions, `Function` type, async/await, `Promise.<T>`.
13. **Modern syntax** – `?.`, `??`, `??=`, `$'…{expr}…'` template strings, destructuring, spread.
14. ~~**Collections**~~ – the language parts are done (`Vector<T>` literals typed from context, `for…of`/`for…in`, destructuring); typed members for built-in types moved to the **standard library** (see Later).
15. **Interfaces** – `interface`, `implements`, runtime `is` support.
15e. **Operator `+` overloading** – `function operator+(…)`, static dispatch, `+=` lowering, X0370/X0371.
15d. **Const methods** – `const` suffix on methods and getters, override/interface rules, X0901/X0902.
15c. **Destructors** – `~Name()` / `async ~Name()`, `using` / `await using` declarations and C#-style `using (...) { }` blocks, implicit `dispose()`, base-destructor chaining, once-only guard, `IDisposable`, X0801 warning.
15a. **Abstract classes** – `abstract` classes/members, instantiation and unimplemented-member checks with stub fix-it, `new.target` guard and `NotImplementedException` stubs in output.
15b. **Typedefs** – `typedef` aliases, structural shapes with optional/final members, function types, structural assignability, excess-property check on object literals, typedef imports, and the auto-imported prelude with `Int` `UInt` `Void` `Bool` `Any`.
16. **Enums**.
17. **Error quality pass** – parser recovery everywhere, secondary labels on all type errors, "did you mean", fix-it `help:` suggestions, unclosed-delimiter tracking, warnings (unused, untyped, `===` usage, `undefined`), always-false comparison errors, error codes + `xenon explain`.
17b. **Watch mode** – `xenon watch` with incremental recompilation (Part F).

Later: the **standard library and generics** are planned in Part G. `dynamic` classes, first-class `Range` values, a `while` clause on range loops (`for (var n:int of 2.. while !s.has(x))`), labels, **explicit type arguments on calls** (see Part G1), `Bun.serve()` playground, and the VS Code extension in Part D (which also brings `.d.ts` typing and source maps). From step 1 on, follow the "what the compiler must do now" list in Part D.

---

## Part E — Diagnostics (Rust-style error reporting)

### Output format
```
error[X0308]: mismatched types
  --> src/com/zoo/Dog.xn:14:24
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

error[X0425]: cannot find `spek` in this scope
  --> src/Main.xn:7:11
   |
 7 |     trace(dog.spek())
   |               ^^^^ no method `spek` on `Dog`
   |
help: a method with a similar name exists: `speak`

error[X0603]: `_name` is private to `Animal`
  --> src/Main.xn:8:15
   |
 8 |     trace(dog._name)
   |               ^^^^^ private field
   |
  ::: src/com/zoo/Animal.xn:4:17
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
  code: string;                       // "X0308"
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
- **Warnings**: unused locals/imports/private members, untyped declarations, unreachable code, `===`/`!==` (X0841), any use of `undefined` (X0840). Comparisons that are always false (X0309) are errors. `--deny-warnings` turns them into errors; `/* xenon-allow Kxxxx */` suppresses one occurrence.
- **Error codes catalog** (`src/diagnostics/codes.ts`): each code has a long explanation with a wrong and corrected example; `xenon explain X0308` prints it.

Tests: snapshot tests over `examples/errors/*.xn` comparing the full rendered output (colors off) to `*.stderr` files, so formatting regressions are caught.

---

## Part F — Command line tool

Installed as `xenon` (`bin` entry in `package.json`, runnable via `bunx xenon` or `bun link`).

| Command | What it does |
|---|---|
| `xenon init [dir]` | create `xenon.json`, `src/Main.xn`, `.gitignore` |
| `xenon build` | compile the project to `outDir` |
| `xenon check` | type-check only, no output |
| `xenon run [-- args]` | build, then run the entry with Bun |
| `xenon watch` | rebuild on every change; `--run` restarts the program after each successful build |
| `xenon explain <code>` | long explanation of an error code |

Common flags: `--project xenon.json`, `--src src`, `--out out`, `--main Main`, `--sourcemap`, `--format pretty|json`, `--color auto|always|never`, `--max-errors N`, `--deny-warnings`, `--quiet`.

**Project file `xenon.json`** (all optional, CLI flags override):
```json
{ "src": "src", "out": "out", "main": "Main", "sourcemap": true, "denyWarnings": false }
```

**Exit codes**: `0` success, `1` compile errors, `2` invalid usage/config, program's own exit code for `run`.

### Watch mode (`src/watch.ts`)
- Watches `src` recursively with `fs.watch` (Bun supports it), plus `xenon.json`; changes debounced (~50 ms) so editor save-bursts compile once.
- **Incremental**: a per-file cache of `{ text hash, AST, exported signatures }`. A change re-parses only that file; files are re-checked if they changed or if a dependency's *public signature* changed (dependency graph from imports). Only output files whose content changed are rewritten.
- Output per cycle: clear screen (unless `--no-clear`), the diagnostics, then a status line like `✓ built 3 of 42 files in 18 ms — watching for changes` or `✗ 2 errors — watching for changes`.
- `--run`: kills the previous child process (via `Bun.spawn`) and starts the new build; if the build fails, the old process is stopped and nothing is started.
- Deleted/renamed files: their outputs are removed and dependents re-checked (so "cannot find `Dog`" appears immediately).
- `Ctrl+C` exits cleanly, stopping any child process.
- The same incremental core is later reused by the language server (Part D).

---

## Part G — Generics and the standard library

Decided 2026-11-18: the standard library is **hand-written XenonScript declarations** of the JS built-ins (curated types: `int` vs `Float`, nullability, `Array<T>`), not generated from `lib.d.ts` (TS unions/overloads/`undefined` map poorly; `.d.ts` stays the source for the long tail — DOM, Node, npm — in Part D). This needs **full generics**, which user code gets too (reversing the earlier "no user generics" decision).

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
- **Later: explicit type arguments on calls**, `Promise.reject<int>('boom')`, `Box.of<Float>(1)`, `parse<Config>(text)`. Needed when nothing determines a type parameter: no argument mentions it and there's no expected type (today such a call is X0797, and the workaround is a typed variable: `var p:Promise<int> = Promise.reject('boom')`).
  - Parsing: `name<…>(` after an identifier or member access is ambiguous with `<` comparisons (`a < b > (c)`). Use the TypeScript/C# rule: speculatively parse a type-argument list and accept it only if it closes with `>` directly followed by `(`; otherwise backtrack and parse a comparison.
  - Checking: explicit arguments replace inference for that call (count must match the method's type parameters, X0422/X0423); partial lists are not allowed.
  - Output: erased, nothing changes in the JS.
  - Until then: give `name<…>(` a clear error instead of today's `<`-comparison cascade ("type arguments can't be written on calls yet; give the result a type: `var p:Promise<int> = …`").
- Generic types are **invariant** (`Array<Dog>` is not an `Array<Animal>`), except that `*` as a type argument is a **wildcard** on either side: any `Box<T>` fits a `Box<*>` and back (writes through it are unchecked, as with `*` everywhere). So a bare `Array` (= `Array<*>`) accepts every typed array.
- **Erased at runtime** (JS has no generics): `x is Box` works, `x is Box<int>` is an error; no code changes in the output.
- `Promise<T>` is no longer special: it's an ordinary generic native class from the std library (done). `Array<T>` follows with the std `Array` declaration.

### G2. Native declarations
```actionscript
public native class String {
  function get length():int
  function indexOf(search:String, from:int = 0):int
  function split(separator:String):Array<String>
  function split(separator:RegExp):Array<String>      // overloads: native declarations only
}
```
- `native` classes/interfaces/members describe existing JS objects: no bodies, **no generated code**, member names map 1:1 to JS.
- **Overloads** are allowed in native declarations only (they replace TS unions); the first matching signature wins.
- Native classes are **closed**: an undeclared member is an error (typos are caught); the escape hatch is `(x as *).newApi()`.
- Primitive types get their members from native classes (`'abc'.toUpperCase()` → `String`, numbers → `Float`/`int` methods like `toFixed`).
- Globals (`Math`, `JSON`, `console`, …) become typed by their declarations; JS globals without a declaration stay `*`.

### G3. The standard library
- Files in `src/prelude/std/*.xn`, auto-imported like the prelude: `String`, `Boolean`, `Number` methods, `Array<T>`, `Math`, `JSON`, `RegExp`, `Promise<T>`, `Map<K, V>`, `Set<T>`, `Date`, `console`.
- Typing rules: **`int` where the result is always whole** (`length`, `indexOf`, `charCodeAt`, `getFullYear`, …); `Math.floor/round/ceil` stay `Float` (results can exceed the `int` range); JS `T | undefined` results become nullable `T` (`find`, `Map.get`, `pop`).
- A **conformance test** checks that every declared member exists at runtime in Bun.
- One file per type (`std/Boolean.xn`, package `xenon`), each listed in `PRELUDE` (`src/compiler.ts`); the test fails if a file isn't loaded. Users can't declare a class with a std name (X0028).
- Constructors that would create JS wrapper objects (`new Boolean`, `new String`, `new Number`) are hidden; the cast functions `Boolean(x)`, `String(x)`, `Float(x)` keep working.
- Methods of primitives used as values compile to `x.m.bind(x)` (a primitive can't hold the cached-identity property used for XenonScript method closures, and has no identity to keep).

### G4. Migration
- Examples and tests updated where typed built-ins now catch mistakes; `globals.ts` shrinks to the globals that have no declaration yet.

Milestones: G1 generics → G2 native declarations → G3 std library → G4 migration. Later: generate further declarations from `.d.ts` (Part D) in the same `native` form.

### G5. Follow-ups (not started)
Left over from G3/G4, roughly in the order they pay off:

1. **`Object` statics. (Done.)** `Object.keys/values/entries/assign/freeze/isFrozen/seal/fromEntries/hasOwn/getPrototypeOf` are the most used untyped global. Declare a std native class `Object` for the statics only (the `Object` *type* stays built in, its instance members stay unchecked), like `Array` supplies the members of the built-in array type. `Object.keys(o):Array<String>`, `Object.entries(o):Array<Array<*>>`, `fromEntries(pairs:Array<Array<*>>):Object`.
2. **Top-level native functions. (Done; user code still can't declare package-level functions — import rules for them would be needed first.)** `setTimeout`, `setInterval`, `clearTimeout`, `fetch`, `structuredClone`, `queueMicrotask`, `encodeURIComponent`/`decodeURIComponent`/`encodeURI`/`decodeURI`, `atob`/`btoa` are free functions, and XenonScript has no top-level functions to declare them with. Sketch: a `native function` declaration at package level in a std file (no body, emitted as nothing, referenced by its JS name, overloads allowed as in native classes), auto-visible like the other prelude names. `setTimeout(callback:() -> Void, ms:int = 0):*` (the timer handle is a `Timeout` object in Node/Bun and an int in browsers, so it stays `*` until the platform is chosen), `fetch(url:String, options:* = null):Promise<*>` (typing `Response` is the `.d.ts` question below).
3. **Platform APIs through `.d.ts`.** `process`, `Bun`, `URL`, `TextEncoder`, streams, `WebSocket`, `crypto`, `performance`, the DOM: too many and too platform-specific for hand-written declarations. (Partly done in milestone 23: imported modules — `node:url`, `node:crypto`, `bun:sqlite`, npm packages — are typed from their `.d.ts` in the `native` form; globals like `process` are still `*`.)
4. **Nullable primitives. (Done: `T?` / `Null<T>`.)** `Map<String, int>.get` and `Array<int>.pop()` return `undefined` when empty, but `int` can't be null, so the checker refuses `== null` on them and the declaration can't say "maybe absent" (documented in `Map.xn` and `Array.xn`: check `has`/`length` first). Options: an `int?` type (nullable form of any type), or `Optional<T>`-style return types in the std declarations. Needs a language decision.
5. **Overload choice by array-literal elements.** Today every array literal matches the first array-typed overload, so typed and wildcard overloads can't coexist (`Promise.all<T>(Array<Promise<T>>)` next to `all(Array<Promise<*>>)` for mixed lists). Match literals on their element types instead.
6. ~~**Tuple types**~~ (done: `Tuple<A, B, …>`, see below) would type `Promise.all` exactly, `Map` pairs and `new Map([['a', 1]])` (inferring `K` and `V`), `entries()`, and `Array.entries()` (today `Array<*>`). A larger feature; see also variadic generics.
7. **Match type for `RegExp.exec` / `String.match`.** The array with `index`, `input` and `groups` is `Array<String>` with untyped extras. A built-in array-with-properties type, or a native class extending `Array<String>`, would type `match.groups.year`.
8. **Small diagnostics:** a hint for `Math.min([1, 2])` (spread it: `Math.min(...values)`); a clear error for `name<…>(…)` until explicit call type arguments exist (see G1).
9. **`Function` and typed callbacks.** An untyped `Function` value can't be passed where a typed callback is expected (`nums.map(fn)` with `fn:Function` is an error; declare `fn:(int) -> int`). Decide whether `Function` should convert implicitly like `*` or stay strict; strict is the current, deliberate behavior.
10. **Declarations not yet written:** `Object` instance members (`hasOwnProperty`, …), `Symbol`, `BigInt`, `WeakMap`/`WeakSet`/`WeakRef`, typed arrays, `Intl`, `Iterator.concat`, `RegExp.escape`, `Map.getOrInsert*`, `Array.copyWithin`/`fromAsync` — each as it's needed, in the existing style (`src/prelude/std/<Name>.xn` + the conformance test + a section in `examples/std`).

## Part D — Later: VS Code extension with IntelliSense via the TypeScript 5 API

**Approach (same idea as Vue/Svelte tooling):** for each `.xn` file the compiler produces a *virtual TypeScript file* — typed TS equivalent of the XenonScript code — plus a position map between `.xn` and the virtual `.ts`. A TypeScript 5 `LanguageService` runs over these virtual files together with the project's real `node_modules` `.d.ts` files. Every editor request is translated `.xn` position → `.ts` position, answered by TypeScript, and mapped back.

This also delivers real types for npm imports inside the editor (completion on `_.` from `@types/lodash`), and the same mechanism can later replace the `*` typing of JS imports in the compiler itself.

Features: diagnostics (XenonScript checker errors + mapped TS errors), completion, hover, signature help, go to definition (into `.xn` and into `.d.ts`), find references, rename, document symbols/outline, semantic highlighting; plus a TextMate grammar for syntax highlighting and a language configuration (brackets, comments, auto-indent).

Structure:
- `packages/xenon-compiler` – the compiler (`src/` above), exposing an API, not just a CLI
- `packages/xenon-language-server` – LSP server built on **Volar.js** (`@volar/language-server`, `@volar/typescript`), which provides the virtual-file + TS LanguageService + position-mapping plumbing
- `packages/vscode-xenon` – thin VS Code client: starts the server, registers `.xn`, grammar, snippets

XenonScript-specific features TS can't provide (keyword completion for modifiers, `override` quick-fix, "add missing interface members", package path ↔ file checks) come from the XenonScript checker in the same server.

### What the compiler must do *now* so this is possible later
These are cheap if built in from step 1 and painful to retrofit:
1. **Precise spans** on every token and AST node (start/end offsets, not just line/col).
2. **Error-tolerant parser**: recovers at statement/member boundaries and produces a partial AST with error nodes, so half-typed code still gets completions.
3. **Mapping-aware emitter**: codegen writes through a `CodeWriter` that records `(xenonSpan → outputSpan)` mappings; used for JS source maps (milestone) and for the virtual TS file.
4. **Second emit target `ts`**: same codegen with type annotations kept (`int`/`Float` → `number`, `Array<T>` → `T[]`, typedefs → `type`, shapes → object types, `*` → `any`, visibility → TS `private`/`protected`). Add once the JS backend is stable (after milestone 15b).
5. **Compiler as a library**: `compileProject` works on in-memory files (`Map<path, text>`), incremental per-file re-checking, no `process.exit` in the core.
6. Checker results queryable by position (symbol at offset, type of expression) for XenonScript-only features.

Milestones (after Part C):
18. Source maps for the JS output (uses the mapping writer). Done (line level, column-exact for names and literals since 19).
19. `ts` emit target + position map; test: TS compiler reports no errors on the virtual TS of all examples. Done.
20. Language server: diagnostics, hover, completion, go-to-definition. Done (directly on the TypeScript API, not Volar.js; see above).
21. VS Code extension: TextMate grammar, language config, client; package as `.vsix`. Done.
22. Rename, references, signature help, outline, quick fixes. Done.
23. Use `.d.ts` types for JS imports in the compiler too (replacing `*`). Done.

## Verification
- `bun test` – unit tests + golden e2e + negative tests.
- Diagnostics: snapshot tests of rendered error output (Part E); manually check colors and caret alignment in a terminal.
- Watch: `xenon watch --run` in `examples/zoo`, edit a file → only it is rebuilt and the program restarts; introduce a type error → error shown and process stopped; fix it → recovers.
- `xenon run examples/zoo` prints the expected output; `xenon build examples/zoo --out out` yields readable ESM that plain JS can `import { Dog } from "./out/com/zoo/Dog.js"`.
- Interop example importing an npm package (installed via `bun install`) and `node:fs/promises` with `await` runs correctly.
- Exception tests: a JS `TypeError` from a library is caught by `catch (e:TypeException)` with the original in `e.cause`; `throw "x"` from JS becomes an `Exception`; using `Error` in XenonScript code is a compile error; a XenonScript exception caught in plain JS is `instanceof Error`.
- String tests: `$'{a} + {b} = {a + b}'` output, nested quotes inside `{}`, `\{` escapes, a literal backtick inside a template; `"x"` and `` `x` `` give X0360 with the right fix-its.
- Regex tests: `a / b / c` stays division; `~/a\/b[/]/g.test(s)` lexes correctly; bad flag (X0350) and invalid pattern (X0351) point into the literal; plain `/abc/` gives the `~` hint.
- Equality tests: `'1' == 1` doesn't compile (X0309); `*`-typed `'1' == 1` is `false` at runtime; `x == null` is true for a JS `undefined`; `===` gives X0841.
- Operator tests: `Vec2 + Vec2` and `+=` (including `obj.pos += v` evaluating `obj` once), inherited/overridden `operator+`, `'s' + vec` concatenates, `Dog + Dog` → X0370, `operator-` → X0371, wrong right-operand type → X0308.
- Range tests: printed sequences for `0..5`, `0..=5`, `0..10 step 3`, `5..0` and runtime `a..b` with `a > b` running 0 times, open range with `break`; `step 0`, `step -1`, assigning the loop variable and a range outside a loop fail with their codes.
- Const method tests: field assignment, `++`, setter use and non-const calls on `this` in a const method fail; calls on other objects and const getters pass; a non-const override of a const method fails.
- Destructor tests: output order for nested `using` blocks (reverse order, derived before base), destructor runs when an exception leaves the block, double `dispose()` runs once, `await using` with an async destructor.
- Abstract tests: `new Shape()` and a subclass missing `area()` fail with X0710/X0711; a plain JS file doing `new Shape()` against the build output gets a `StateException`.
- Typedef tests: shapes accept matching literals/class instances and reject missing or mistyped members; built output contains no trace of typedefs.
- Inline test: an example whose built output contains the folded literals and no `private static inline` field, plus negative tests (non-constant initializer, missing `final`, cyclic constants).
- Each class rule (private access, missing `override`, unimplemented interface member, wrong enum type, …) has a failing example with its expected error message.

We'll implement one milestone at a time and confirm each works before moving on.
- [x] `constexpr` functions with block bodies: local variables, assignments to them (`=`, `+=`, `++`, …), `if`, `while`, `do … while`, C-style `for`, range loops, `switch` (falling through as in JavaScript), `return`, `break` and `continue` run at compile time (`consteval.run`, a small statement interpreter with JavaScript semantics); fields, `try`/`throw`, `for … of`, closures and destructuring are rejected at the declaration (X0526). A budget of 1000000 steps catches endless loops, and ending without a value is reported (X0527).
- [x] `constexpr` methods and constructors, as in C++: a `constexpr` constructor builds an immutable object at compile time (its class has no superclass and only `final`/`const` instance fields; it may assign them), and a `constexpr` instance method must be `const` (X0526, with a fix that adds `const`) — it reads its object (`this`, bare field names, `other.x`) and calls only `constexpr` methods, constructors and operators. Objects are compile-time values (`ConstObject`: class and fields) during evaluation; methods are looked up on the object's own class; an operator on an object calls its `constexpr` `operator+`/`-`/`*`/`/`/`==` (`==` without one compares identity). Only primitive results reach the output: `new Size(320, 200).area()` → `64000`, `new V(1, 2) == new V(1, 2)` → `true`, `(a + b).width` → a number; an object result stays a runtime `new` (X0523 for an `inline` constant holding an object). `this.x = …` in a constructor always means the field, also when a parameter is named `x`. Parameters and results of `constexpr` code may be objects. `examples/inline` (`Size`), `tests/errors/constexpr-objects.xn`.
- [x] `constexpr` methods are implicitly `const` (the parser sets `isConst`), so writing `const` is optional; the "must be `const`" error is gone, and the usual `const` rules (X0901/X0902) apply either way.
- [x] Calls of the class's own `constexpr` methods (`fact(10)`, `this.fact(10)` inside the class, where `this` is a runtime object) are folded when no subclass can override the method — it is `private` or `final`, or the class is `final` — and the method doesn't use `this`; otherwise they stay calls (a public method might be overridden, so the runtime `this` could run other code). `tests/constexpr.test.ts`.
- [x] `constexpr` methods are implicitly `final` (X0723 "`Base.size` is `constexpr` and can't be overridden"), so calls of them on the class's own object (`fact(10)`) are computed at compile time whatever their visibility; only one using `this` stays a call.
- [x] The standard library declares what runs at compile time: `constexpr` on native members means "the JavaScript built-in runs with the constant arguments" (`consteval.callNative`). Marked: every `Math` function but `random` (its constants are `static inline const`), the `String` methods with a primitive result (`trim`, `replace`/`replaceAll` with a string or regex and a string replacement, `padStart`, `slice`, `toUpperCase`, `indexOf`, …), the getter `length` and `String.fromCharCode`/`fromCodePoint`. Not: methods returning arrays (`split`, `match`), locale-dependent ones, `at` (`undefined` past the end), overloads taking a function. Native `constexpr` may be a getter or have a rest parameter (`Math.max`). Constant calls fold everywhere (`'ab'.toUpperCase()` → `'AB'`), overloads by the one the checker chose; regex literals are compile-time values (`RegExp`, never pasted); strings over 1000000 characters (`repeat`, `padStart`) aren't built. Hover shows `constexpr` and `inline`. Replaces the compiler's `PURE_MATH`, `PURE_STRING` and `MATH_CONSTANTS` lists.
- [x] Tuple types: `Tuple<A, B, …>` (a built-in type, `builtin` named `Tuple` with the element types as arguments; a plain array at runtime, `[A, B]` in the TypeScript output). An array literal takes it from context, one element per position (X0323 for a wrong length or a spread); a constant index has its position's type, another index the union of them, an out-of-range one is X0324 (writes check the position's type); destructuring types each name and `...rest` keeps the remaining positions as a tuple (X0773 for more names than positions); `for … of`, members (`length`, `join`, …) and `Array<T>` patterns see the union of the elements. Assignable: a tuple of the same length position by position (exactly, `*` as a wildcard, also nested in type arguments: `IEnumerable<Tuple<String, int>>` fits `IEnumerable<Tuple<*, V>>`), and to `Array<*>` or an `Array<T>` all its elements are; never an array to a tuple. Inference reads tuple literals position by position (`new Map([['a', 1]])` is a `Map<String, int>`). Standard library: `Object.entries` → `Array<Tuple<String, *>>`, `Map<K, V>` implements `IEnumerable<Tuple<K, V>>` (so `for (var [k, v] of map)` needs no special case: `mapArgs` is gone), `entries()` of `Map`/`Set`/`Array`/`FormData`, `new Map(pairs)` and `Object.fromEntries` take tuples (plus an untyped `IEnumerable<Array<*>>` overload for pairs built at runtime). `.d.ts` tuples of fixed length are `Tuple<…>`. Hover shows destructured names' types (`CheckResult.bindingTypes`). `examples/tuples`, `tests/errors/tuples.xn`.
- [x] Type checks `(expr : Type)` (as in Haxe; the parentheses are part of the syntax): no runtime effect (the JavaScript is `expr`; TypeScript gets `(expr as T)` so it types the value as Xenon does). `expr` is checked top-down against `Type` (`checkAssign`: literals take their type from it, `(['a', 1] : Tuple<String, int>)`, `([] : Array<int>)`, `({ x: 1 } : Point)` with X0792 for a missing member), and the expression's type is `Type` from then on. Mismatches are X0308 labelled "expected because of this type check". `(a:int) => …` stays an arrow (only `(…)` followed by `=>` or `: Type =>` is a parameter list); `(c ? a : b)` is a conditional. Folds in constants and is allowed in `constexpr` code. `var x = (… : T)` is still untyped (unannotated locals are `*`). `tests/errors/type-check.xn`, `examples/types`.
- [x] Private methods are JavaScript `#private` methods (`#step() {}`, `static #fresh()`, `get #value()` for a property private on both sides), like private fields: JavaScript code can't call them and they aren't on the prototype. Calls, `other.#step()`, method closures (`var f = step`) and `$self.#step()` in `function` expressions go through `#`. Not constructors, destructors, operator methods, enums, native classes or the prelude. A private method's `name` is `#step` (JavaScript's). `tests/interop.test.ts`.
- [x] Null safety, opt-in (`"nullSafety": true`, `--null-safety`, `CompileOptions.nullSafety`; the language server reads it from `xenon.json`): object types (`String`, classes, shapes, arrays, tuples, functions, `Object`) exclude `null` and `T?`/`Null<T>` adds it, as for `int` (`types.nullSafety`, set by `compileProject` for one compile: `nullableOf` wraps every type, `isNullable` is true only for `T?`, `null`, `*` and unions holding one). The existing machinery applies: X0398 for members, calls and arithmetic on a `T?`, `?.`/`??`, narrowing by null checks and `if (var x:T = …)`. New: `as T` gives `T?` (no X0393 for object types); `a?.m()`/`f?.()` call the non-null part; a nullable function called directly is X0398; `c ? s : null` is a `String?`; a literal checked against `T?` is checked against `T`; `x == null` on a non-null value is a warning (X0818), not X0309. Definite assignment: a `var` field whose type excludes `null` and has no value must be assigned on every path through the constructor (static ones in `static { }` blocks), else X0819 (with a fix adding `?`); such a `var` local must be assigned before it's read (X0510/X0511). Standard library audited: `String.at`, `String.match`, `RegExp.exec`, `Object.getPrototypeOf`, `Date.toJSON` return `T?`, `Object.create` and `JSON.stringify`'s replacer take `null` (`?` on object types changes nothing without null safety). `.d.ts` types `T | null`/`T | undefined` become `T?` (`Null<…>` for function types). Not yet: smart casts after `x is T` for non-union locals (`(x as Shape).name`), narrowing of `local.member` paths, a non-null assertion operator, generics' `T` (treated like a value type). `examples/null-safety`, `tests/errors/null-safety/`.
- [x] The browser DOM, first part (`src/prelude/std/dom/`, loaded as `xenon/dom/*.xn`, still `package xenon`): `Node` (node-type constants as `static inline const`, tree links as `T?`, `textContent`/`nodeValue` as `String?`, tree changes, comparisons), `Element extends Node` (names, attributes with `getAttribute(…):String?`, `getElementsByTagName`/`…NS`/`…ClassName` → `HTMLCollection`, `querySelector(…):Element?`, `querySelectorAll` → `NodeList<Element>`, `closest`, element children and siblings, `append`/`before`/`remove`/`insertAdjacent…`, `innerHTML`/`outerHTML`), `NodeList<T>` and `HTMLCollection` (both `IEnumerable`, so `for … of`; `Array.from` gained `IEnumerable<T>` overloads). Browser-only (Bun has no DOM: `x is Element` throws there). DOM names aren't reserved (X0028 skips `std/dom`): a program's own `Node`/`Element` class or typedef shadows the DOM's (a typedef now also wins over a prelude class of the same name). The prelude's files are exempt from the package/folder check (X0020). `tests/std.test.ts` checks the DOM declarations against happy-dom (a dev dependency; `HAPPY_DOM_GAPS` lists standard members it lacks: `lookupPrefix`, `lookupNamespaceURI`, `isDefaultNamespace`); `tests/dom.test.ts` compiles DOM code and runs it on a happy-dom XML document. Not yet: `Document`, `DOMParser`, `Text`, `Attr`, `DOMTokenList`, HTML element subclasses.
- [x] Events: `EventTarget` (constructible and extendable: `class Store extends EventTarget`; `addEventListener`/`removeEventListener` with a capture flag or `AddEventListenerOptions` `{ capture, once, passive, signal }`, `dispatchEvent`) and `Event` (`new Event(type, EventInit)`, phase constants as `static inline const`, `target`/`currentTarget` as `EventTarget?`, `preventDefault`, `stopPropagation`, `composedPath`) in `std/` (Bun has both, so the conformance test checks them against Bun); `Node extends EventTarget`. Listeners take an `Event` (`as` for specific event classes). `tests/dom.test.ts` runs a `Store extends EventTarget` in Bun and a listener on a happy-dom element. Not yet: specific event classes (`MouseEvent`, `KeyboardEvent`, `CustomEvent`), listener objects with `handleEvent`, `AbortSignal`.
- [x] `Document extends Node` (`new Document()`; `documentElement`/`body`/`head` as `Element?`, `getElementById`, `getElementsByTagName`/`…NS`/`…ClassName`, `querySelector`/`All`, `createElement`/`createElementNS` (with `{ is }`), `createTextNode`/`createComment`/`createDocumentFragment` returning `Node` until `Text` exists, `importNode`, `adoptNode`, element children, `append`/`prepend`/`replaceChildren`) and `DOMParser` (`parseFromString(text, type:DOMParserSupportedType):Document`, the type a literal union `'text/html' | 'application/xml' | …`; malformed XML gives a `<parsererror>` document, documented). `Node.ownerDocument` is `Document?`. `tests/dom.test.ts` parses Word-style XML from Xenon code, adds a namespaced paragraph and reads it back, in happy-dom (whose `getElementsByTagNameNS` finds no namespaced elements: the test uses the qualified name), and type-checks the TypeScript output. Not yet: `Text`, `Comment`, `DocumentType`, `DocumentFragment` as classes.
- [x] `XMLSerializer` (`serializeToString(node:Node):String`), the reverse of `DOMParser`; `tests/dom.test.ts` parses Word-style XML, edits the text runs and checks the serialized text exactly (in happy-dom), and type-checks the TypeScript output.
