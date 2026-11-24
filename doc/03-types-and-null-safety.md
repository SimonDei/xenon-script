# Chapter 3: Types and null safety

## Core types

| XenonScript type | Meaning |
|---|---|
| `Int` | signed 32-bit integer (`int` is an alias) |
| `UInt` | unsigned 32-bit integer (`uint` is an alias) |
| `Float` | JavaScript-style number |
| `String` | text |
| `Bool` | Boolean (`Boolean` is an alias) |
| `Void` | no value (`void` is an alias) |
| `Array<T>` | typed mutable array |
| `Tuple<A, B, ...>` | fixed-length array with a type per position |
| `Record<String, V>` | plain object used as a dictionary: any keys, every value a `V` |
| `Object` | object-like base value |
| `Function` | untyped function value |
| `*` | explicitly dynamic/untyped |
| class/interface type | nominal class or interface value |

`null` is a value. With default null safety, `String` excludes `null`; write `String?` to include it.

## Nullable values

```actionscript
var email:String? = null

if (email != null) {
  trace(email.toUpperCase()) // narrowed to String
}

trace(email?.length ?? 0)
```

`?.` stops the whole chain, as in JavaScript: in `order?.customer.name.length`, nothing after the `?.`
runs when `order` is `null`, and the result is `Int?`. Only the `null` that `?.` adds is skipped: if
`customer` itself may be null, it needs its own `?.` (`order?.customer?.name`). Indexing or calling
a value that may be null is an error (X0398); write `list?.[0]` or `f?.()`.

The following constructs cooperate with narrowing:

- `x == null` and `x != null`
- `!`, `&&`, and `||`
- `if` and `else`
- `while`
- conditions that prove a union branch
- non-null assignments
- `if (var item:T = maybe)` binding syntax

Fields are not narrowed through a check because another operation might change them between uses.
Copy a field into a local first:

```actionscript
final current:String? = user.email
if (current != null) trace(current.length)
```

Inside a closure or deferred body, a mutable local may have changed before execution, so an outer
null check does not always carry across that boundary.

## `*`: deliberately untyped

```actionscript
var raw:* = JsonPackage.parse(text)
raw.anyProperty
```

`*` is an escape hatch. It is useful at a JavaScript boundary, but typed declarations should use a
concrete type, shape, interface, or generic.

## Union and literal types

```actionscript
typedef Identifier = Int | String
typedef Encoding = 'utf8' | 'ascii'

function read(id:Identifier):Void {
  if (id is String) {
    trace(id.toUpperCase())
  } else {
    trace(id + 1)
  }
}
```

Use `is` to test runtime-compatible classes and union alternatives. Use `as` for a checked
conversion. A failed runtime cast does not silently pretend to be the target type.

## Object shapes and typedefs

```actionscript
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
```

A `?` member is optional and reads as nullable. `final` makes a structural member read-only.
Typedefs erase at runtime; they check object literals and values without creating a JavaScript class.

Function types are structural too:

```actionscript
typedef Predicate<T> = (value:T) -> Bool
```

Parameters of function types are contravariant and return values are covariant.

## Tuples

```actionscript
var pair:Tuple<String, Int> = ['Ann', 42]
var name:String = pair[0]
var age:Int = pair[1]
```

A tuple is a normal array at runtime. Its length and each fixed position are checked. A non-constant
index gives the union of possible position types.

```actionscript
var [key, value]:Tuple<String, Int> = pair
```

## Records

`Record<String, V>` is a plain object used as a dictionary, as in TypeScript:

```actionscript
var ages:Record<String, Int> = { ann: 31, bob: 40 }
ages['carl'] = 22
ages.dora = 5                       // the same as ages['dora']
var ann:Int? = ages['ann']          // a key may be missing: reading gives Int?
var bob:Int = ages.bob ?? 0

for (var [name, age] of Object.entries(ages)) {
  trace(name, age + 1)              // age is an Int
}
```

Reading a key gives `V?` and writing one takes a `V`. An object literal against a record may have any
keys; each value is checked against `V`. A typedef shape fits `Record<String, V>` when every member
holds a `V`. `Object.values` and `Object.entries` type their results with `V`.

With string literal keys, a record is a shape: `Record<'id' | 'name', String>` is
`{ id:String, name:String }`. Other key types are an error (X0882): JavaScript object keys are strings;
use `Map<K, V>` for other keys.

Element data attributes are a record: `element.dataset` is a `DOMStringMap`
(`Record<String, String>`), so `el.dataset.userId` is a `String?`.

## Checked type expressions

`(value : Type)` checks the expression in the context of a type and has no runtime conversion:

```actionscript
var pair:Tuple<String, Int> = (['a', 1] : Tuple<String, Int>)
```

Use conversion functions when a runtime conversion is intended:

```actionscript
var count:Int = Int('42')
var text:String = String(count)
```

## Exercises

1. Model optional and required configuration with a typedef.
2. Narrow `Int | String` in both branches.
3. Replace an untyped variable with a structural type.

See [`examples/types`](../examples/types), [`examples/nullable`](../examples/nullable),
[`examples/null-safety`](../examples/null-safety), and
[`examples/tuples`](../examples/tuples).
