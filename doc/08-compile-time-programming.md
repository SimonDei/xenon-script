# Chapter 8: Compile-time programming

Some values are known before the program runs: sizes, limits, lookup tables, names. XenonScript can
compute them while compiling and paste the result into the output, so the program doesn't pay for
them at runtime, and mistakes in them become compile errors. This chapter covers `inline`
constants, `constexpr` and `consteval` functions, and `nameof`.

## Inline constants

An `inline` constant is computed by the compiler and pasted wherever it is used:

```actionscript check
public class Main {
  public static inline final WIDTH:Int = 640
  public static inline final AREA:Int = WIDTH * 480

  public function Main() {
    inline const greeting = 'hi ' + 'there'
    trace(WIDTH, AREA, greeting)
  }
}
```

```text output
640 307200 hi there
```

The generated JavaScript has no `WIDTH` property and no multiplication:

```js
console.log(640, 307200, 'hi there');
```

- `inline final` (fields) and `inline const` (locals) take a constant expression: literals, enum
  members, other inline constants, operators, `?:`, the conversions `Int()`, `UInt()`, `Float()`,
  `String()`, `Bool()`, and calls of `constexpr` functions (below). Anything else is X0523.
- The value must fit the declared type (`inline final B:Byte = 300` is an error), and constants that
  refer to each other in a circle are reported.
- A `private` inline constant doesn't exist at runtime at all; a public one is also emitted as a
  property, so JavaScript code can read it.
- The result must be a primitive (a number, string or `Bool`). Objects can be used *while*
  computing it (see `constexpr` constructors), but not stored.

## `constexpr` functions

A `constexpr` function is an ordinary function that the compiler *can* also run. When every
argument is a constant, the call is replaced by its result; otherwise it runs at runtime as usual:

```actionscript check
public class Main {
  public function Main() {
    var n = Main.readCount()
    trace(Main.twice(21), Main.twice(n), Main.factorial(10))
  }

  public static constexpr function twice(n:Int):Int => n * 2

  public static constexpr function factorial(n:Int):Int {
    var result = 1
    for (var i of 2..=n) result *= i
    return result
  }

  public static function readCount():Int => 3
}
```

```text output
42 6 3628800
```

```js
console.log(42, Main.twice(n), 3628800);
```

A `constexpr` body can use parameters and locals, literals, operators and `?:`, conversions, inline
constants, other `constexpr` functions (including the standard library's), and the statements
`if`, `while`, `do … while`, `for` (C-style and ranges), `switch`, `return`, `break` and `continue`.
Calling anything else is an error at the call (X0526) that lists what's allowed. `try`, `throw`,
closures, destructuring and `for … of` aren't available, and neither is anything with side effects
(I/O, randomness, the clock).

### `constexpr` methods and constructors

Instance methods and constructors can be `constexpr` too. A `constexpr` constructor builds an
object at compile time, whose `constexpr` methods can then be folded, the way C++ does it:

```actionscript check
class Size {
  public final w:Int
  public final h:Int
  public constexpr function Size(w:Int, h:Int) {
    this.w = w
    this.h = h
  }
  public constexpr function area():Int => w * h
}

public class Main {
  public static inline final HD:Int = new Size(1280, 720).area()

  public function Main() {
    trace(HD, new Size(2, 3).area())
  }
}
```

```text output
921600 6
```

`constexpr` methods are implicitly `const` (they can't change the object) and `final` (an override
couldn't be folded, so overriding one is an error, X0723). Their class's fields must be `final`.
At runtime they are ordinary methods.

### The standard library at compile time

Standard-library members marked `constexpr` run in the compiler with constant arguments: `Math`
functions and constants, string methods without side effects (`toUpperCase`, `replace`, `trim`,
`split`'s length, …), `Float` formatting (`toFixed`, `toString(radix)`) and parsing, and the
conversions:

```actionscript check
public class Main {
  public static inline final SLUG:String = 'Hello World'.replace(~/ /g, '-').toLowerCase()
  public static inline final MAX:Float = Math.max(3, 8, 5)

  public function Main() {
    trace(SLUG, MAX)
  }
}
```

```text output
hello-world 8
```

Locale-dependent, random and clock functions, and those returning arrays, always run at runtime.

## `consteval` functions

A `consteval` function *must* run at compile time: every call needs constant arguments, and the
function doesn't exist in the output at all:

```actionscript check
public class Main {
  public function Main() {
    trace(Main.square(12))
    var n = 3
    trace(Main.square(n))                 // error X0528: `n` isn't a constant
  }

  public static consteval function square(n:Int):Int => n * n
}
```

Use it for things that should never cost anything at runtime, or that would be wrong to compute
then: lookup tables, checked configuration, hashes of constant strings. A `consteval` function can't
be used as a value, and its result must be a primitive. `consteval` functions can call each other
and `constexpr` functions; constructors can't be `consteval`.

`constexpr` and `consteval` are written after `static` (or the visibility) and before `function`.
On a field, `constexpr` is an error that points to `inline final` (X0526).

## `nameof`

`nameof(x)` is the name of a local, parameter, member, class or enum member, as a string constant.
The compiler checks that the name exists, and renaming the symbol in the editor renames it too:

```actionscript check
class User {
  public var email:String = ''
  public function save():Void {}
}

public class Main {
  public function Main() {
    var user = new User()
    var count = 1
    trace(nameof(user.email), nameof(User.save), nameof(User::email), nameof(count), nameof(User))
    trace(nameof(user.emial))             // error X0426: no member `emial`
  }
}
```

The first line prints `email save email count User`.

Use it wherever an API wants a property or parameter name as text: change notifications, error
messages (`throw new ArgumentException(nameof(count))`), `Object.defineProperty`, serialization
keys. Members of `*` values can't be checked; use a string literal there.

`nameof` is reserved at expression level, so it can't be used as the name of a local or a bare
function; as a member name (`service.nameof()`) it is fine.

## Limits

Compile-time evaluation is bounded, so a runaway loop or recursion can't hang the compiler: there
are limits on call depth, the total number of calls, the number of statements executed and the size
of generated strings. Exceeding one is X0527, at the call that started the evaluation. `X0528`
reports a `consteval` call that can't be completed at compile time.

## Exercises

1. Declare `inline final` constants for a grid (`COLS`, `ROWS`, `CELLS = COLS * ROWS`) and check the
   generated JavaScript.
2. Write `constexpr function fib(n:Int):Int` and use it both in an `inline final` and with a runtime
   argument.
3. Make a `constexpr` class `Rgb` with a `constexpr` method `hex():String` and compute a color
   constant from it.
4. Use `nameof` in an `ArgumentException` message, then rename the parameter in the editor.

See [`examples/inline`](../examples/inline) and
[`tests/constexpr.test.ts`](../tests/constexpr.test.ts).
