# Chapter 2: Values and syntax

## Declarations

XenonScript has three local declaration forms:

```actionscript
var count:Int = 0       // reassignable
final id:String = makeId() // assigned exactly once
const retry:Int = 3     // assigned once here, like a JavaScript const
```

`var`, `final`, and `const` are block-scoped. A local whose type is omitted takes its initializer's
type:

```actionscript
var names = ['Ann', 'Bob'] // Array<String>
var ratio = 1.5            // Float
var n = 3                  // Int
```

A declaration with neither a type nor a useful initializer is untyped (`*`) and produces a warning.
Prefer an explicit type in that case.

`final` without an initializer must be assigned exactly once on every path before it is read.

## Fields and static values

The same declaration keywords describe fields:

```actionscript
public var title:String
public final id:String
public static const VERSION:Int = 3
```

Compile-time inline values are covered in [Chapter 8](08-compile-time-programming.md).

## Strings

Single quotes are the ordinary string syntax:

```actionscript
var message:String = 'hello'
```

Template strings use `$'...'` and interpolate expressions in braces:

```actionscript
var user:String = 'Ann'
trace($'Hello, {user}.')
```

Regular expression literals use `~/pattern/flags`:

```actionscript
var cleaned:String = 'a  b'.replace(~/\s+/g, '-')
```

Double-quoted strings are not XenonScript strings.

## Arrays and objects

```actionscript
var scores:Array<Int> = [3, 5, 8]
var point = { x: 10, y: 20 }
```

Object literals are useful with structural typedefs:

```actionscript
typedef Point = { x:Float, y:Float }
var p:Point = { x: 1, y: 2 }
```

Object spread and array spread are supported:

```actionscript
var moved = { ...p, x: 20 }
var all:Array<Int> = [...scores, 13]
```

An object literal can have methods and accessors, written like a class's with the `function` keyword:

```actionscript
var counter = {
  count: 0,
  function get double():Int { return this.count * 2 },
  function set value(n:Int):Void { this.count = n },
  function get value():Int { return this.count },
  function bump(by:Int):Int { this.count += by; return this.count },
  async function save():Promise<Void> { await store(this.count) }
}
```

They compile to JavaScript methods, getters, and setters. `this` is the object itself (untyped, like
in a `function` expression); an arrow function inside keeps the same `this`. A getter needs a return
type, a setter takes one typed parameter, and neither can be `async`. A getter and a setter with the
same name pair up; any other repeated name is an error. Against a typedef, a getter fits a `final`
member (`final area:Int`); a member that is written also needs a setter. A spread (`{ ...counter }`)
copies a getter's current value, as in JavaScript.

## Destructuring

Array and object destructuring work in declarations, assignments, and `for … of` bindings:

```actionscript
var [first, , third, ...rest]:Array<String> = ['a', 'b', 'c', 'd']
var { name, address: { city } } = user

for (var [key, value]:* of entries) {
  trace(key, value)
}
```

Defaults, holes, rest patterns, and renaming are supported. A method cannot be destructured as a
plain function without preserving the required receiver.

## Operators

XenonScript supports:

- arithmetic: `+ - * / % **`
- comparison: `== != === !== < <= > >=`
- logical/null: `! && || ??`
- bitwise: `& | ^ ~ << >> >>>`
- assignments: `= += -= *= /= %= **= &&= ||= ??= &= |= ^= <<= >>= >>>=`
- updates: `++ --`
- optional/member: `. ?.`
- ternary: `condition ? a : b`
- type/expression operators: `is`, `as`, `typeof`, `delete`, `await`, `nameof`
- object helpers: spread `...`, range `..` and `..=`

`Int`, `UInt`, and integer aliases use 32-bit arithmetic. Checked indexing protects `Array` and
`String` positions; use `.at(index)` when a missing value should become nullable.

## Semicolons

Semicolons are optional. A line boundary ends a statement when JavaScript's automatic-semicolon
rules would do so. Keep a continued expression visibly continued:

```actionscript
var total:Int = first
  + second
  + third
```

A newline immediately after `return` ends that return:

```actionscript
return
  value
```

The first form returns no value and may trigger the compiler's line-break diagnostic.

## Exercises

1. Infer the types of an array, an object literal, and a mixed array.
2. Destructure a `Map` entry inside `for … of`.
3. Use `??=` to provide a fallback for a nullable local.

See [`examples/basics`](../examples/basics) and
[`examples/destructuring`](../examples/destructuring).
