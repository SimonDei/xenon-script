# Chapter 8: Compile-time programming

## Inline constants

```actionscript
public static inline final WIDTH:Int = 640
public static inline final AREA:Int = WIDTH * 480
```

Inline constants must be compile-time values. Their uses are replaced with the literal result, so a
private inline constant is never emitted as a runtime property.

Allowed folds include:

- literals
- enum members
- other inline constants
- numeric/string/Bool operators
- casts/conversions
- eligible standard-library and `constexpr`/`consteval` calls

Cycle detection and constant fitting are checked. An object cannot be stored as an inline constant;
compile-time objects may still participate in evaluating a primitive final result.

## `constexpr`

A `constexpr` function uses a compile-time-safe subset of XenonScript. With constant arguments, the
call folds:

```actionscript
public static constexpr function twice(n:Int):Int => n * 2

trace(twice(21)) // emits console.log(42)
```

With runtime arguments, the ordinary function call remains:

```actionscript
var n:Int = readCount()
trace(twice(n)) // emits Main.twice(n)
```

`constexpr` is therefore “compile time when possible.”

## `consteval`

`consteval` is strict. Every call must fold during compilation:

```actionscript
public static consteval function square(n:Int):Int => n * n

trace(square(12)) // emits console.log(144)
```

This is an error:

```actionscript
var n:Int = readCount()
trace(square(n)) // X0528
```

The function cannot be captured as a function value and is omitted from generated JavaScript and
TypeScript.

`consteval` functions can call one another:

```actionscript
public static consteval function sumSquares(n:Int):Int {
  return square(n) + square(n + 1)
}
```

## Shared restrictions

`constexpr` and `consteval` may use:

- parameters and locals
- literals
- operators and conditional expressions
- allowed casts/conversions
- inline constants
- compile-time class/object members
- `if`, `while`, `do … while`, C-style/range `for`, `switch`
- `return`, `break`, `continue`
- assignments and updates to locals

They cannot perform runtime I/O or call arbitrary functions. `try`/`throw`, closures, destructuring,
and `for … of` are outside the compile-time statement interpreter.

Parameters and returns must be compile-time-capable values. A `consteval` result must be a primitive
that code generation can emit. User-defined functions cannot take rest parameters in this mode.

Instance `constexpr` methods are implicitly `const`; constructors may be `constexpr`, but not
`consteval`.

## Standard-library folds

Selected standard declarations participate:

- `Math` functions and constants
- safe `String`, `Float`, and `Bool` methods
- string length
- conversion functions

For example:

```actionscript
'a b'.replace(~/ /g, '-').toUpperCase()
Math.max(3, 8, 5)
Float.parseInt('42')
```

Locale-dependent, random, or array-returning APIs stay at runtime.

## `nameof`

`nameof` checks a symbol and becomes its source-level name:

```actionscript
nameof(user.email) // 'email'
nameof(User.save)  // 'save'
nameof(User::name) // 'name'
```

`nameof` is a reserved compile-time operator. A typo is an error, and member
renaming/refactoring updates the expression. It accepts ordinary checked names and typed unbound
property references (`Type::member`) through the same member-resolution path. A class may still
declare or call a member named `nameof` through a receiver, such as `service.nameof()`.

Untyped `*` members cannot be checked by `nameof`; use a string literal at that boundary.

## Limits and diagnostics

Compile-time evaluation protects the compiler with:

- a call-depth limit
- a total-call limit
- a statement-step budget
- maximum generated string sizes

`X0527` reports an evaluation limit. `X0528` reports a `consteval` call that cannot be completed
at compile time.

See [`examples/inline`](../examples/inline) and
[`tests/constexpr.test.ts`](../tests/constexpr.test.ts).
