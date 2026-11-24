# Chapter 2: Values and syntax

This chapter covers the building blocks inside a method body: declarations, literals, operators,
destructuring and how statements end. XenonScript's expression syntax is close to JavaScript's; the
differences are mostly where JavaScript is loose (truthiness, `==` coercion, numbers that silently
become fractions) and XenonScript asks you to be explicit.

## Comments

```actionscript check
// a line comment
/* a block comment */

/**
 * A doc comment: shown by hover and completion in the editor.
 */
var answer = 42
```

Doc comments (`/** … */`) belong to the declaration that follows them: classes, members, typedefs,
shape members, enum members.

## Declarations

A local is declared with one of three words:

```actionscript check
var count:Int = 0            // can be reassigned
final id:String = 'a-17'     // assigned exactly once
const retries:Int = 3        // assigned once, right here

count += 1
id = 'b-2'                   // error X0501
retries = 4                  // error X0501
```

- **`var`** is an ordinary variable (it compiles to JavaScript `let`).
- **`final`** is assigned exactly once, but not necessarily where it is declared. The compiler
  follows every path and checks that the value is assigned before it is read and never twice:

  ```actionscript check
  var score = 72
  final grade:String
  if (score >= 90) {
    grade = 'A'
  } else if (score >= 50) {
    grade = 'B'
  } else {
    grade = 'C'
  }
  trace(grade)
  ```

  ```text output
  B
  ```

- **`const`** is assigned once *at its declaration* (like JavaScript `const`). Leaving the value out
  is an error (X0503) that suggests `final`.

All three are block-scoped. Fields use the same words (`public final id:String`, see
[chapter 5](05-classes-and-objects.md)), and `inline final` declares a compile-time constant (see
[chapter 8](08-compile-time-programming.md)).

### Type inference

A local without a type takes the type of its initializer:

```actionscript check
var names = ['Ann', 'Bob']        // Array<String>
var ratio = 1.5                   // Float
var n = 3                         // Int
var point = { x: 1, y: 2 }        // { x:Int, y:Int }
var greeting = 'hi'               // String, not the literal type 'hi'
```

Literal values are widened to their base type (`'hi'` gives `String`, `3` gives `Int`), so the
variable can take other values of that type later. Write a type when you want a different one:
`var total:Float = 0` starts an `Int`-looking value as a `Float`.

A declaration with neither a type nor a value that says one is *untyped* (`*`, see
[chapter 3](03-types-and-null-safety.md)), and the compiler warns:

```actionscript check
var later                         // warning X0850: no type and no value
var nothing = null                // warning X0850: its value is `null`
var anything:*                    // fine: explicitly untyped
```

## Numbers

XenonScript has five number types. All of them are JavaScript numbers at runtime; the type decides
which values fit and how arithmetic behaves.

| Type | Values |
|---|---|
| `Int` | 32-bit signed integers (−2,147,483,648 … 2,147,483,647) |
| `UInt` | 32-bit unsigned integers (0 … 4,294,967,295) |
| `Short` | 16-bit signed integers (−32,768 … 32,767) |
| `Byte` | 8-bit signed integers (−128 … 127) |
| `Float` | 64-bit floating point (JavaScript's `number`) |

Number literals:

```actionscript check
var decimal = 1_000_000      // underscores group digits
var hex = 0xFF               // 255
var binary = 0b1010          // 10
var octal = 0o17             // 15
var fraction = 2.5           // a Float
var exponent = 1e3           // a Float: 1000
trace(decimal, hex, binary, octal, fraction, exponent)
```

```text output
1000000 255 10 15 2.5 1000
```

A literal without a fraction or exponent is an `Int` when it fits; it also fits any other number
type its value fits (`var b:Byte = 100` is fine, `var b:Byte = 300` is an error).

### Arithmetic

The rules are those of Java and C# rather than JavaScript:

- **`+`, `-`, `*`, `%` on integers give an integer** and *wrap* on overflow, like in C. They don't
  silently grow into fractions or past 32 bits:

  ```actionscript check
  var max:Int = 2147483647
  max += 1
  var b:Byte = 127
  b++
  trace(max, b)
  ```

  ```text output
  -2147483648 -128
  ```

- **`/` always gives a `Float`**: `7 / 2` is `3.5`. Convert explicitly when you want an integer:
  `Int(7 / 2)` is `3` (the fraction is cut off).

  ```actionscript check
  var items:Int = 7
  var pages:Int = items / 2                 // error X0308
  var half:Int = Int(items / 2)
  var exact:Float = items / 2
  ```

- Arithmetic on `Byte` and `Short` gives an `Int` (as in Java), and so does mixing integer types;
  `UInt` mixed with `Int` gives a `Float`. Converting back is explicit: `Byte(x)`, `Short(x)`,
  `UInt(x)` wrap the value into range.
- `**` is exponentiation (`2 ** 10` is `1024`); `%` takes the sign of the left operand
  (`-7 % 3` is `-1`), as in JavaScript.
- Bitwise operators (`& | ^ ~ << >> >>>`) work on 32-bit integers, as in JavaScript.

Integers widen to `Float` automatically; everything else needs a conversion:

```actionscript check
var n:Int = 3
var f:Float = n               // fine: an Int is a Float
var back:Int = f              // error X0308: Float to Int needs Int(...)
var text:String = n           // error X0308: use String(n)
var parsed:Float = Float('2.5')
```

Each error comes with a quick fix that inserts the conversion.

## Strings

Strings use single quotes:

```actionscript check
var message = 'hello'
var quoted = 'it\'s'
var lines = 'one\ntwo'
var unicode = 'é \u{1F600}'
```

Escapes: `\n \r \t \0 \b \f \v`, `\'`, `\\`, `\xFF`, `\uFFFF`, `\u{1F600}`. A string can't span
lines; use `\n`. Double quotes and backticks aren't string syntax in XenonScript; the compiler says
so and offers to convert them.

**Template strings** start with `$'` and insert expressions in braces:

```actionscript check
var user = 'Ann'
var count = 3
trace($'Hello, {user}! You have {count} new {count == 1 ? 'message' : 'messages'}.')
trace($'Braces: \{ and \}')
```

```text output
Hello, Ann! You have 3 new messages.
Braces: { and }
```

Any expression can go inside `{…}`, including calls, conditionals and nested templates. They
compile to JavaScript template literals.

`+` concatenates when either side is a `String`: `'n=' + 3` is `'n=3'`.

**Regular expressions** are written `~/pattern/flags`:

```actionscript check
var cleaned = 'a   b  c'.replace(~/\s+/g, '-')
var isDate = ~/^\d{4}-\d{2}-\d{2}$/.test('2024-02-29')
trace(cleaned, isDate)
```

```text output
a-b-c true
```

A regex literal is a `RegExp` (see [chapter 10](10-standard-library.md)).

## Booleans, `null` and `undefined`

`Bool` has the values `true` and `false`. `null` is the one "no value" value; nullable types are
written `T?` (see [chapter 3](03-types-and-null-safety.md)). `undefined` exists for JavaScript
compatibility, and every use warns (X0840) with a fix to use `null`.

### Conditions are `Bool`

JavaScript treats `0`, `''` and `null` as false in a condition ("truthiness"). XenonScript doesn't:
`if`, `while`, `!`, `&&` and `||` need `Bool` values, and the compiler suggests the comparison you
probably meant:

```actionscript check
var name:String? = null
var count = 0
if (name) trace('named')                    // error X0310
if (count) trace('some')                    // error X0310
if (name != null && count > 0) trace('ok')
```

The error for `name` explains the JavaScript behaviour (`''` is false too) and offers
`name != null` or `name != null && name != ''`.

## Operators

| Kind | Operators |
|---|---|
| arithmetic | `+ - * / % **` |
| comparison | `== != < <= > >=` |
| logical | `! && \|\|` |
| null handling | `?? ?. ??=` |
| bitwise | `& \| ^ ~ << >> >>>` |
| assignment | `= += -= *= /= %= **= &= \|= ^= <<= >>= >>>= &&= \|\|= ??=` |
| update | `++ --` |
| conditional | `cond ? a : b` |
| type | `is as typeof` |
| other | `delete await nameof unconst`, spread `...`, ranges `..` `..=` |

Precedence is JavaScript's. The differences in meaning:

- **`==` and `!=` are strict.** They never convert types (JavaScript's `===`). Writing `===` works
  but warns (X0841) that it's the same thing. A class can define what `==` means for its values with
  `operator==` (see [chapter 5](05-classes-and-objects.md#equality-tostring-and-operator-methods)).
- **`??`** gives the right side when the left is `null`; **`?.`** stops a member chain at `null`
  (`order?.customer.name` is `null` when `order` is, and the rest of the chain isn't evaluated);
  **`??=`** assigns only when the target is `null`:

  ```actionscript check
  var name:String? = null
  var length = name?.length ?? 0
  name ??= 'anonymous'
  trace(length, name)
  ```

  ```text output
  0 anonymous
  ```

- **`typeof`** is JavaScript's runtime type tag (`'number'`, `'string'`, …). Prefer `is` for type
  tests (see [chapter 3](03-types-and-null-safety.md#type-tests-and-casts-is-and-as)).
- **`delete`** removes a property, and only from values typed `*` or `Object`. On a typed object it
  is an error (X0316): its shape says the property is there.
- **`is` and `as`** test and cast types ([chapter 3](03-types-and-null-safety.md)); `nameof` and
  `unconst` work at compile time ([chapter 8](08-compile-time-programming.md),
  [chapter 5](05-classes-and-objects.md#read-only-views-const-t)).

## Arrays and objects

```actionscript check
var scores:Array<Int> = [3, 5, 8]
var point = { x: 10, y: 20 }
```

A literal has the type of what it builds: `point` is a `{ x:Int, y:Int }`, so `point.z` is an error
and `point.x` an `Int`. Values are widened (`'a'` gives `String`); shorthands (`{ x }`), spreads of
shapes (`{ ...point, z: 0 }`, later keys win), getters and nested literals count too, also where a
literal is returned or passed on. Arrays work the same way: `[{ n: 1 }, { n: 2 }]` is an
`Array<{ n:Int }>`. An empty `{}` and a literal with a computed key (`{ [key]: 1 }`) stay an open
`Object`, whose members are untyped.

```actionscript check
var point = { x: 10, y: 20 }
trace(point.z)                   // error X0426: no member `z`
var moved = { ...point, x: 20 }
var all:Array<Int> = [...[1, 2], 3]
trace(moved.x, all.length)
```

Object literals are checked against structural types (typedefs, see
[chapter 3](03-types-and-null-safety.md#object-shapes-and-typedefs)): a misspelled or missing member
is an error at the literal.

```actionscript check
typedef Point = { x:Float, y:Float }

public class Main {
  public function Main() {
    var p:Point = { x: 1, y: 2 }
    var q:Point = { x: 1, yy: 2 }     // error X0791
  }
}
```

### Array comprehensions

Comprehensions build an array from one or more loops, with optional filters:

```actionscript check
var scores = [3, 5, 8]
var doubled = [for (score of scores) if (score > 3) score * 2]
var pairs = [for (a of [1, 2]) for (b of ['x', 'y']) a + b]
var evens = [for (i of 0..10 step 2) i]
trace(doubled, pairs, evens)
```

```text output
[ 10, 16 ] [ "1x", "1y", "2x", "2y" ] [ 0, 2, 4, 6, 8 ]
```

Each `for` iterates an iterable and introduces a local binding; later loops, filters and the result
can use earlier bindings. Ranges support `..`, `..=`, and `step` as in `for … of` (see
[chapter 4](04-control-flow-and-functions.md#ranges)); an open-ended range never finishes unless
evaluation throws. Filters must be `Bool`. Bindings may also be destructured or written with `var`,
`final`, or `const` and an optional type, as in `for … of`. The expression builds a new array in
iteration order, with an element type inferred from its result. Comprehensions compile to ordinary
JavaScript loops; they do not depend on browser support for the obsolete syntax. When a
comprehension contains `await`, it runs in an async wrapper, so it can also suspend after the
comprehension even if no iteration reached an `await`.

### Methods and accessors in object literals

An object literal can have methods and accessors, written like a class's with the `function`
keyword:

```actionscript check
var counter = {
  count: 0,
  function get double():Int { return this.count * 2 },
  function set value(n:Int):Void { this.count = n },
  function get value():Int { return this.count },
  function bump(by:Int):Int { this.count += by; return this.count },
  function get label():String => $'count {this.count}'
}
counter.bump(2)
counter.value = 5
trace(counter.double, counter.label)
```

```text output
10 count 5
```

A body can also be one expression, as for class methods. They compile to JavaScript methods,
getters, and setters. `this` is the object itself (untyped, like in a `function` expression); an
arrow function inside keeps the same `this`. A getter needs a return type, a setter takes one typed
parameter, and neither can be `async` (methods can: `async function save():Promise<Void> { … }`). A
getter and a setter with the same name pair up; any other repeated name is an error. Against a
typedef, a getter fits a `final` member (`final area:Int`); a member that is written also needs a
setter. A spread (`{ ...counter }`) copies a getter's current value, as in JavaScript.

## Destructuring

Destructuring takes values out of arrays and objects in one step. It works in declarations,
assignments and `for … of` loops, and every name gets its type from the value:

```actionscript check
typedef User = { name:String, ?email:String, address:{ city:String, zip:String } }

public class Main {
  public function Main() {
    var user:User = { name: 'Ann', address: { city: 'Oslo', zip: '0150' } }

    var { name, email = 'none', address: { city } } = user   // nested, with a default
    var { name: who } = user                                  // renamed
    var { address, ...others } = user                         // the rest as an object
    var [first, , third = 'z', ...rest] = ['a', 'b']          // holes, defaults, rest
    trace(name, email, city, who, address.zip, others.name, first, third, rest.length)

    var a = 1
    var b = 2;
    [a, b] = [b, a]                                           // swap
    trace(a, b)

    var ages = new Map<String, Int>([['ann', 31], ['bob', 27]])
    for (var [key, age] of ages) trace(key, age + 1)          // key:String, age:Int
  }
}
```

```text output
Ann none Oslo Ann 0150 Ann a z 0
2 1
ann 32
bob 28
```

Note the `;` after `var b = 2`: a line that starts with `[` would otherwise continue the previous
line (see [semicolons](#semicolons) below). A default is used when the value is missing; a method
can't be destructured, because it would lose its `this` (X0771).

## Semicolons

Semicolons are optional. A line break ends a statement wherever JavaScript's automatic semicolon
insertion would end it. Two places need care:

- **A line starting with `(`, `[` or a template continues the previous line**, as in JavaScript.
  Put a `;` before it (or at the end of the previous line).
- **A line break right after `return`** ends the `return`. The compiler reports a `return` followed
  by a value on the next line, because it would never be returned.

Keep a continued expression visibly continued by ending the line with the operator, or starting
the next one with it:

```actionscript check
var first = 1
var second = 2
var third = 3
var total:Int = first
  + second
  + third
trace(total)
```

```text output
6
```

On one line, statements are separated with `;`: `if (ok) a = 1; else a = 2` (or use braces). A
project can require or forbid `;` at line ends with the `"semicolons"` setting (see
[chapter 11](11-compiler-and-editor.md#semicolons)).

## Exercises

1. Declare a `final` that is assigned in both branches of a `switch`, then remove one assignment and
   read the error.
2. Compute the average of an `Array<Int>`, first assigning the result to an `Int`, then fixing the
   type error two different ways.
3. Destructure a `Map` entry inside `for … of` and print keys in upper case.
4. Use `??=` to provide a fallback for a nullable local, and `?.` to read its length.
5. Write a comprehension that lists every `(x, y)` pair with `x < y` from `0..4`.

See [`examples/basics`](../examples/basics) and
[`examples/destructuring`](../examples/destructuring).
