# Chapter 3: Types and null safety

XenonScript checks types at compile time and erases them from the output. This chapter describes the
types, how they relate to each other, how `null` is kept under control, and how values are tested
and converted.

Two kinds of types work side by side:

- **Nominal types**: classes, interfaces and enums. A value is a `Dog` because it was created with
  `new Dog()` (or a subclass), and `x is Dog` can be tested at runtime.
- **Structural types**: object shapes (`{ name:String }`), function types (`(Int) -> Bool`),
  tuples and records. A value fits a shape when it has the right members, whatever created it.
  Structural types exist only at compile time.

## The built-in types

| Type | Meaning |
|---|---|
| `Int`, `UInt`, `Short`, `Byte` | integers of 32 (signed, unsigned), 16 and 8 bits |
| `Float` | 64-bit floating point number |
| `String` | text |
| `Bool` | `true` or `false` |
| `Void` | "no value": only as a return type |
| `Array<T>` | a typed array; a bare `Array` is `Array<*>` |
| `Tuple<A, B, …>` | a fixed-length array with a type per position |
| `Record<String, V>` | a plain object used as a dictionary |
| `Object` | any object; its members are untyped |
| `Function` | any function, untyped |
| `Class<T>` | a class as a value (see [chapter 6](06-interfaces-and-generics.md#classt)) |
| `*` | deliberately untyped: anything goes, nothing is checked |
| `T?` | `T` or `null` |

The lowercase ActionScript spellings `int`, `uint`, `Boolean` and `void` are accepted aliases; new
code uses the capitalized names. Numbers are described in
[chapter 2](02-values-and-syntax.md#numbers); this chapter adds how their types relate.

## How types fit together

A value of type `A` can be used where a `B` is expected when `A` *fits* `B`:

- a class fits its superclasses and the interfaces it implements (`Dog` fits `Animal`);
- a smaller number type fits a larger one: `Byte` → `Short` → `Int` → `Float`, `UInt` → `Float`;
- anything fits `Object`, and anything fits `*` (and `*` fits anything);
- `null` fits `T?`, and `T` fits `T?`;
- a value fits a shape when it has every required member with a fitting type: an object literal, a
  shape, or an instance of a class with those public members:

```actionscript check
typedef Named = { name:String }

class Dog {
  public var name:String = 'Rex'
  public function bark():String => 'woof'
}

public class Main {
  public function Main() {
    var n:Named = new Dog()          // a Dog has a `name`: it fits
    var m:Named = { name: 'Tom' }
    var d:Dog = m                    // error X0308: a shape isn't a Dog
    trace(n.name, m.name)
  }
}
```

Generic types are invariant by default: an `Array<Dog>` is not an `Array<Animal>` (otherwise you
could put a `Cat` into the dog list). Read-only views and `out` type parameters relax that; see
[chapter 6](06-interfaces-and-generics.md#generic-variance).

## Null safety

`null` is not a value of every type. A `String` is always a string; a `String?` may be `null`:

```actionscript check
var name:String = 'Ann'
var maybe:String? = null
name = null                        // error X0308
trace(maybe.length)                // error X0398: `maybe` may be null
```

`T?` works for every type, including numbers and booleans (`Int?`, `Bool?`). `Null<T>` is another
spelling of `T?`, for code ported from Haxe.

A non-null field must get a value, either where it is declared or in every constructor path:

```actionscript check
class Ticket {
  private var title:String
  private var note:String? = null
  public var seats:Int = 1

  public function Ticket(open:Bool) {
    if (open) title = 'open'
  }                                // error X0819: `title` isn't assigned on every path
}
```

### Getting a non-null value

The compiler *narrows* a nullable local or parameter after a check: where the check proves it isn't
`null`, it has the non-null type.

```actionscript check
public class Main {
  public function Main() {
    trace(Main.describe(null), Main.describe('Ann'))
  }

  public static function describe(name:String?):String {
    if (name == null) return 'nobody'
    return name.toUpperCase()           // `name` is a String here
  }
}
```

```text output
nobody ANN
```

The tools, from the most common:

- **comparisons with `null`**: `x != null`, `x == null`, in `if`, `while`, `&&`, `||`, `!` and early
  `return`s, `break`s and `throw`s;
- **`??`** gives a fallback: `name ?? 'anonymous'` is a `String`;
- **`?.`** stops a member chain at `null`: `order?.customer.name` is `null` when `order` is.
  Everything after the `?.` is skipped, as in JavaScript, and the result is nullable. Only the
  `null` that `?.` itself checks is covered: if `customer` may be null too, it needs its own `?.`.
  Calls and indexes have the same forms: `f?.()`, `list?.[0]`;
- **`??=`** assigns only when the variable is `null`;
- **binding conditions** declare a non-null local when the value isn't `null`:

```actionscript check
var maybe:Int? = null
if (var n:Int = maybe) {
  trace(n + 1)
} else {
  trace('none')
}

var queue = ['x', 'y']
while (var item = queue.pop()) {      // pop() gives String?: the loop ends at null
  trace(item.toUpperCase())
}
```

```text output
none
Y
X
```

There is no `!` "trust me, it's not null" operator. When you know more than the compiler, say so
with a check that throws, or a fallback.

### What isn't narrowed

**Fields** aren't narrowed by a check, because anything called between the check and the use could
change them. Copy the field into a local:

```actionscript check
class Profile {
  public var email:String? = null

  public function domain():String {
    if (email != null) return email.split('@')[1]   // error X0398
    final current = email
    if (current != null) return current.split('@')[1]
    return ''
  }
}
```

Inside a closure or a `defer`, a check outside carries over only if the local can't change before
the code runs: a `var` that is assigned again anywhere in the function loses its narrowing there,
with a note saying why.

```actionscript check
var name:String? = 'Ann'
if (name != null) {
  var size = () => name.length       // error X0398: `name` is reassigned below
  trace(size())
}
name = null
```

### Turning null safety off

`"nullSafety": false` in `xenon.json` (or `--no-null-safety`) makes object types nullable again,
as in ActionScript: a `String` may be `null`, and reading a member of `null` is a runtime error.
`T?` still matters for `Int`, `Float` and `Bool`. Null safety is on by default; turning it off is
meant for porting older code.

## `*`, `Object` and `Function`

`*` turns type checking off for one value: any member can be read, any call made, and the value fits
everywhere. It is the type of untyped JavaScript and of `JSON.parse`'s result:

```actionscript check
var raw:* = JSON.parse('{"a":1}')
trace(raw.a, raw.b)                  // not checked: `raw.b` is undefined at runtime
var n:Int = raw.a                    // fits, unchecked
```

```text output
1 undefined
```

Use it at the edges of a program, then give the data a type (a shape, see below) as soon as
possible. `Object` is any object: everything fits it, its members are untyped, and it can be
indexed (`o['key']`). `Function` is any function: it can be called with anything. Prefer function
types (`(String) -> Int`), which check the call.

## Union and literal types

A union `A | B` is a value of one of several types; a literal type is exactly one value:

```actionscript check
typedef Identifier = Int | String
typedef Encoding = 'utf8' | 'ascii'

public class Main {
  public function Main() {
    trace(Main.show(7), Main.show('ab'))
    var e:Encoding = 'utf8'
    var bad:Encoding = 'latin1'          // error X0308
  }

  public static function show(id:Identifier):String {
    if (id is String) return id.toUpperCase()   // a String here
    return String(id + 1)                       // and an Int here
  }
}
```

A member of a union can be used only when every alternative has it; otherwise the error suggests
narrowing first. `is` narrows a union in both branches of an `if`; `==` against a literal narrows
too. `T | null` is the same as `T?`.

## Type tests and casts: `is` and `as`

`x is T` tests at runtime whether a value is a `T`, and narrows `x` where the test is true. It works
for classes, interfaces, enums, primitives and union alternatives:

```actionscript check
class Animal {}
class Dog extends Animal { public function bark():String => 'woof' }

public class Main {
  public function Main() {
    var a:Animal = new Dog()
    if (a is Dog) trace(a.bark())        // a Dog here
    var d = a as Dog                      // Dog?: null when it isn't one
    trace(d?.bark())
  }
}
```

```text output
woof
woof
```

`x as T` is a *checked* cast: the result is `T?`, `null` when the value isn't a `T`, never a wrong
value pretending to be a `T`. For that reason `as Int` (a type that can't be null) is an error that
suggests `as Int?`, a conversion `Int(x)` or a test `x is Int`:

```actionscript check
var raw:* = 1
var n = raw as Int                       // error X0393
var m = raw as Int?
var k = Int(raw)
```

Structural types can't be tested at runtime, because they don't exist there:

```actionscript check
typedef Named = { name:String }

public class Main {
  public function Main() {
    var raw:* = { name: 'x' }
    if (raw is Named) trace('?')           // error X0794
    var n = raw as Named                   // allowed: an unchecked cast, it's up to you
  }
}
```

`as` to a shape is unchecked: use it to give typed form to data you trust, such as your own JSON.
Generic classes are tested without their arguments (`x is Box`), for the same reason.

### Compile-time type checks

`(expr : Type)` checks an expression against a type, without any runtime effect. It's useful where
there's no annotation to give the context:

```actionscript check
var pair = (['a', 1] : Tuple<String, Int>)     // a tuple, not an Array<String | Int>
var count:Int = pair[1]
```

### Conversions

Converting between types that don't fit is explicit and happens at runtime:

```actionscript check
var count = Int('42')            // parses: 42
var cut = Int(7.9)               // 7
var text = String(count)         // '42'
var ratio = Float('0.5')
var flag = Bool(1)               // true
var small = Byte(200)            // -56: wraps into range
trace(count, cut, text, ratio, flag, small)
```

```text output
42 7 42 0.5 true -56
```

## Object shapes and typedefs

A `typedef` names a type. Most often it names an object shape:

```actionscript check
typedef Address = {
  city:String,
  zip:String,
  ?country:String
}

typedef Person = {
  final id:Int,
  name:String,
  address:Address
}

public class Main {
  public function Main() {
    var p:Person = { id: 1, name: 'Ann', address: { city: 'Oslo', zip: '0150' } }
    trace(p.address.country ?? 'unknown')
    p.name = 'Anna'
    p.id = 2                         // error X0793: `id` is final
  }
}
```

- A `?` member is optional: a literal may leave it out, and reading it gives a nullable value.
- A `final` member is read-only.
- A fresh object literal may not have members the shape doesn't list (a misspelling would otherwise
  go unnoticed), and must have every required member.
- Shapes can refer to themselves through a member: `typedef Node = { value:Int, ?next:Node }`.

Typedefs erase at runtime: they check object literals and values without creating a JavaScript
class. A typedef can also name any other type: `typedef Id = Int | String`,
`typedef Handler = (e:Event) -> Void`.

### Function types

A function type lists parameter types and a return type:

```actionscript check
typedef Predicate<T> = (value:T) -> Bool

public class Main {
  public function Main() {
    var isLong:Predicate<String> = (s) => s.length > 3     // `s` is a String
    var words = ['tea', 'coffee', 'milk']
    trace(words.filter(isLong))
    var twice:(Int) -> Int = (n) => n * 2
    trace(twice(21))
  }
}
```

```text output
[ "coffee", "milk" ]
42
```

Parameter names in function types are documentation only. A function fits a function type when its
parameters accept at least what the type passes (contravariance) and its result is at least as
specific (covariance): a `(Animal) -> Dog` fits where a `(Dog) -> Animal` is expected.

### Combining shapes: `A & B`

`&` combines shapes into one shape with the members of every part. This is the usual way to extend
a shape with a few more members:

```actionscript check
typedef Attrs = { id:String, ?title:String }
typedef Obj = { prop:Attrs & { myProp:String } }

public class Main {
  public function Main() {
    var o:Obj = { prop: { id: 'a', myProp: 'm' } }
    trace(o.prop.id, o.prop.myProp)
    var attrs:Attrs = o.prop   // the combined shape still fits each part
  }
}
```

An intersection can be used anywhere a type can be written, and messages show it as written
(`Attrs & { myProp:String }`). A member that appears in several parts must have the same type in
each (X0887). It is optional only if every part makes it optional, and read-only if any part
declares it `final`. `&` binds tighter than `|`, so `A & B | null` is `(A & B) | null`.

Only shapes combine. Classes, interfaces and primitives can't be parts of an intersection type
(X0888). To require several interfaces, constrain a type parameter instead:
`T extends INamed & ISized` (see [chapter 6](06-interfaces-and-generics.md#several-bounds-a--b)).

### Typedefs inside a class

A file shares only the declaration named after it, so a typedef written above or below the class is
private to that file (see [chapter 9](09-packages-and-javascript.md#one-shared-declaration-per-file)).
To share a typedef that belongs to a class, declare it inside the class body. Outside the class it
is named through the class:

```actionscript check
import shop.Cart
import shop.Cart.Line            // or import the typedef itself

public class Main {
  public function Main() {
    var l:Cart.Line = { sku: 'A1', qty: 2 }
    var m:Line = l
    new Cart().add(m)
  }
}
// file: shop/Cart.xn
package shop {
  public class Cart {
    public typedef Line = { sku:String, qty:Int }
    private typedef Totals = (lines:Array<Line>) -> Int

    private var lines:Array<Line> = []

    public function add(line:Line):Void { lines.push(line) }
  }
}
```

A nested typedef takes a visibility like a member: `public`, `protected` (the class and its
subclasses), `private` (the class only), or `internal`, the default (the package). Inside the class
and its subclasses it is used by its plain name. It can't use the class's type parameters, because
`Cart.Line` means the same type everywhere; give it its own instead: `typedef Entry<T> = { value:T }`.

A field, method or typedef can't use a nested typedef that is less visible than itself (X0443): a
`public` method returning a `private` typedef would hand callers a type they can't name.
Interfaces can't declare typedefs.

## Integer sizes

`Int`, `UInt`, `Short`, and `Byte` are two's complement integers of 32, 32 (unsigned), 16, and 8
bits; at runtime all are JavaScript numbers, and arithmetic wraps instead of growing:

```actionscript check
var b:Byte = 127
b++                      // -128: wraps around
var c:Byte = Byte(200)   // -56: Byte(x) keeps the low 8 bits
var sum:Int = b + c      // arithmetic on Byte and Short computes as Int, as in Java and C#
var d:Byte = Byte(b + c) // back into a Byte explicitly
b += 10                  // compound assignment, ++ and -- keep the type (and wrap)
trace(b, c, sum, d)
```

```text output
-118 -56 -184 72
```

A smaller type widens to a larger one without a conversion: `Byte` → `Short` → `Int` → `Float`
(and `UInt` → `Float`). The other direction needs `Byte(x)`, `Short(x)`, `Int(x)` or `UInt(x)`. A
number literal fits any integer type whose range holds it (`var b:Byte = 100`). `x is Byte` checks
that a value is a whole number in range. `Byte.MIN_VALUE`/`MAX_VALUE` and `Short.MIN_VALUE`/`MAX_VALUE`
are compile-time constants.

## Arrays and checked indexes

`list[i]` on an array, a tuple or a string is checked at runtime: an index outside the array throws
a `RangeException` instead of quietly giving `undefined`. When "no element" is a normal case, use
`at()`, which returns a nullable value (and counts negative indexes from the end):

```actionscript check
var list = [1, 2, 3]
trace(list.at(5) ?? -1, list.at(-1))
try {
  trace(list[5])
} catch (e:RangeException) {
  trace(e.message)
}
```

```text output
-1 3
index 5 is out of range (length 3)
```

The check is a small helper call in the output (`list[$index(list, i)]`), left out where the
compiler can prove the index is in range, such as a constant position of a tuple.

## Tuples

```actionscript check
var pair:Tuple<String, Int> = ['Ann', 42]
var name:String = pair[0]
var age:Int = pair[1]
var [key, value] = pair
trace(name, age, key, value)
```

```text output
Ann 42 Ann 42
```

A tuple is a normal array at runtime. Its length and each fixed position are checked. A non-constant
index gives the union of possible position types. `Map` entries and `Object.entries` are tuples, so
destructuring them gives each part its type.

## Records

`Record<String, V>` is a plain object used as a dictionary, as in TypeScript:

```actionscript check
var ages:Record<String, Int> = { ann: 31, bob: 40 }
ages['carl'] = 22
ages.dora = 5                       // the same as ages['dora']
var ann:Int? = ages['ann']          // a key may be missing: reading gives Int?
var bob:Int = ages.bob ?? 0

for (var [name, age] of Object.entries(ages)) {
  trace(name, age + 1)              // age is an Int
}
```

```text output
ann 32
bob 41
carl 23
dora 6
```

Reading a key gives `V?` and writing one takes a `V`. An object literal against a record may have any
keys; each value is checked against `V`. A typedef shape fits `Record<String, V>` when every member
holds a `V`. `Object.values` and `Object.entries` type their results with `V`.

With string literal keys, a record is a shape: `Record<'id' | 'name', String>` is
`{ id:String, name:String }`. Other key types are an error (X0882): JavaScript object keys are strings;
use `Map<K, V>` for other keys.

Element data attributes are a record: `element.dataset` is a `DOMStringMap`
(`Record<String, String>`), so `el.dataset.userId` is a `String?`.

## Exercises

1. Model a configuration with required and optional settings as a typedef, and read an optional one
   with a default.
2. Write a function taking `Int | String | null` that handles all three cases, and check that the
   compiler knows the type in each branch.
3. Parse a JSON string, cast the result to a shape with `as`, and use it with full checking.
4. Replace an `Array<*>` in your code with a typed array or a tuple.

See [`examples/types`](../examples/types), [`examples/nullable`](../examples/nullable),
[`examples/null-safety`](../examples/null-safety), [`examples/typedefs`](../examples/typedefs) and
[`examples/tuples`](../examples/tuples).
