# Chapter 6: Interfaces, generics, and contracts

## Interfaces

```actionscript
public interface Drawable {
  function draw():Void
  function get width():Float
}

public class Box implements Drawable {
  override public function draw():Void {}
  override public function get width():Float { return 10 }
}
```

Interfaces are declared with `interface` and may extend other interfaces. The class implementing an
interface must match:

- member names and kinds
- parameter types and arity
- result compatibility
- visibility
- getter/setter halves
- `const` behavior

Interfaces have runtime marker symbols, so `is Drawable` and checked `as Drawable` work. An interface
cannot be constructed directly.

An abstract class may defer an interface implementation to its concrete subclasses.

### Value equality: `IEquatable<T>`

`==` compares objects by reference. The built-in `IEquatable<T>` interface gives a class a
value comparison, and generic code can require it with a constraint:

```actionscript
class Money implements IEquatable<Money> {
  public final cents:Int
  public final currency:String
  public function Money(cents:Int, currency:String) { this.cents = cents; this.currency = currency }
  public function equals(other:Money):Bool => cents == other.cents && currency == other.currency
}

new Money(100, 'EUR') == new Money(100, 'EUR')        // false: two objects
new Money(100, 'EUR').equals(new Money(100, 'EUR'))   // true: the same value

function indexOf<T extends IEquatable<T>>(items:Array<T>, x:T):Int {
  for (var i:Int = 0; i < items.length; i++) if (items[i].equals(x)) return i
  return -1
}
```

JavaScript's `Map`, `Set`, and `Array.includes` still compare objects by identity; they don't call
`equals`. To make `==` itself compare values, overload `operator==`.

### Ordering: `IComparable<T>`

`IComparable<T>` gives a class a natural order. `compareTo` returns a negative number when this
value comes first, `0` when the two are equal in the order, and a positive number when it comes after:

```actionscript
class Version implements IComparable<Version> {
  public final major:Int
  public final minor:Int
  public function Version(major:Int, minor:Int) { this.major = major; this.minor = minor }
  public function compareTo(other:Version):Int => major != other.major ? major - other.major : minor - other.minor
}

var sorted = versions.toSorted((a, b) => a.compareTo(b))

function max<T extends IComparable<T>>(items:Array<T>):T? {
  var best:T? = null
  for (var item:T of items) if (best == null || item.compareTo(best) > 0) best = item
  return best
}
```

A class can implement both interfaces; `equals` then usually agrees with `compareTo(other) == 0`.

## Generics

Classes, interfaces, methods, local functions, and typedefs accept type parameters:

```actionscript
public class Box<T> {
  public final value:T

  public function Box(value:T) {
    this.value = value
  }

  public function map<U>(convert:(T) -> U):Box<U> {
    return new Box(convert(value))
  }
}
```

Type arguments are invariant. A `Box<Dog>` does not become `Box<Animal>` merely because `Dog` is an
`Animal`.

Method and constructor type arguments are inferred from arguments and expected result context:

```actionscript
var textBox:Box<String> = new Box('hello')
var lengthBox:Box<Int> = textBox.map((text:String):Int => text.length)
```

## Generic constraints

Use `extends` to require every argument for a type parameter to have a particular upper bound:

```actionscript
public class Cage<T extends Animal> {
  public final value:T

  public function Cage(value:T) {
    this.value = value
  }

  public function name():String => value.name
}
```

The constraint applies to explicit arguments, inferred constructor and call arguments, inherited
generic types, and defaults:

```actionscript
var dog:Cage<Dog> = new Cage(new Dog()) // valid
var text:Cage<String>                   // error: String is not an Animal
```

Inside the declaration, `T` exposes the members guaranteed by its bound. Constraints may reference
the declaration's other parameters and may be self-referential inside a concrete generic type:

```actionscript
public interface Comparable<T> {
  function compareTo(other:T):Int
}

function sortItem<T extends Comparable<T>>(value:T):Int => value.compareTo(value)
```

Classes, interfaces, typedefs, methods, and local functions support constraints. A parameter can
combine variance, a constraint, and a default in that order:

```actionscript
class Cache<out T extends Resource = DefaultResource> {}
```

Each parameter currently supports one upper bound. If several capabilities are required, declare
an interface that combines them and use that interface as the bound.

## Generic variance

Generic parameters are invariant unless a declaration marks their direction:

```actionscript
public interface Producer<out T> {
  function produce():T
}

public interface Consumer<in T> {
  function accept(value:T):Void
}
```

`out` is covariance: `Producer<Dog>` fits `Producer<Animal>`. `in` is contravariance:
`Consumer<Animal>` fits `Consumer<Dog>`.

```actionscript
var producer:Producer<Animal> = dogProducer
var dogConsumer:Consumer<Dog> = animalConsumer
```

Variance is erased at runtime. The checker validates declarations recursively:

- `out T` may be returned, read from final/get-only properties, and nested in covariant outputs.
- `in T` may be accepted as a parameter or nested in contravariant inputs.
- mutable properties and unannotated type parameters are invariant.
- nested generic variance composes through inheritance and interfaces.

Variance can be used on generic classes, interfaces, and typedefs:

```actionscript
public typedef Mapper<in I, out O> = (value:I) -> O
```

Function types already follow the same rule: parameter types are contravariant and return types are
covariant.

Generic types erase to ordinary JavaScript classes and functions.

A class or interface type parameter can have a default, used when a type leaves the argument out.
The parameters with defaults come last:

```actionscript
class Event<T = EventTarget> {
  public var target:T?
}

var plain:Event = new Event('saved')                  // Event<EventTarget>
var typed:Event<HTMLInputElement> = new Event('input') // the target is an HTMLInputElement
```

`new Box(5)` still infers `T` from its arguments; the default fills in what the arguments and the
expected type leave open. Methods and typedefs cannot give their type parameters defaults, and a
parameter after one with a default needs a default too (X0878).

## Type parameters in structural types

```actionscript
typedef Result<T> = {
  value:T?,
  error:String?
}
```

`*` can be used as a wildcard type argument when a value should fit many concrete instantiations:

```actionscript
var box:Box<*> = new Box('dynamic element type')
```

Generic bounds are not implemented yet.

## Enums

```actionscript
public enum Status {
  Pending,
  Complete = 10,
  Failed
}
```

Enums emit frozen JavaScript objects. Numeric members automatically continue from the previous
value. String enums are also supported when every value is explicitly constant.

```actionscript
var status:Status = Status.Pending
trace(Status.values())
```

There is no `switch` expression in the current language; use a statement:

```actionscript
switch (status) {
  case Status.Pending:
    trace('pending')
    break
  default:
    trace('other')
}
```

Enum values are nominal in the Xenon type system and can be tested with `is`/`as`.

## Iteration protocols

`Iterable<T>` follows JavaScript's iterable protocol: `[Symbol.iterator]()` returns an
`Iterator<T>`. The standard collections, strings, maps, sets, iterators, `NodeList`, and
`HTMLCollection` implement it.

```actionscript
for (var entry:Tuple<String, Int> of scores) {
  var [name, score] = entry
  trace(name, score)
}
```

Implement it directly with the official JavaScript method:

```actionscript
public class Numbers implements Iterable<Int> {
  public function [Symbol.iterator]():Iterator<Int> {
    return [1, 2, 3].values()
  }
}
```

`Iterator<T>` also implements `Iterable<T>` at runtime, as required for JavaScript's built-in
iterators: its `[Symbol.iterator]()` returns the iterator itself. `IteratorResult<T>` mirrors the
protocol's optional `done` and `value` properties.

## `Class<T>`

`Class<T>` represents a class value:

```actionscript
var kind:Class<Animal> = Dog
var animal:Animal = new kind('Rex')
```

Use class values to construct values through a shared base type and to pass type-related behavior
without relying on an untyped `*`.

## Attributes

An attribute class implements `IAttribute`:

```actionscript
public class Route implements IAttribute {
  public final path:String

  public function Route(path:String) {
    this.path = path
  }
}
```

Use it on classes, methods, or fields:

```actionscript
[Route('/users')]
public class UsersController {}
```

Attribute arguments must be compile-time constants. Named constructor-member assignments are also
supported.

`[Usage(...)]` controls legal targets and whether an attribute can repeat. The prelude provides
helpers through `Attributes`:

```actionscript
var routes:Array<Route> = Attributes.of(UsersController, Route)
var own:Route? = Attributes.first(UsersController, Route)
```

Built-in compiler attributes include:

- `[Deprecated('message')]`
- `[NoDiscard('message')]`

An attribute may optionally define `wrap(method, name)` to replace a method lazily at runtime.
Wrapping is not allowed on compile-time methods because their constant calls may disappear.

See [`examples/interfaces`](../examples/interfaces),
[`examples/generics`](../examples/generics), [`examples/enums`](../examples/enums),
[`examples/enumerable`](../examples/enumerable), [`examples/class-values`](../examples/class-values),
and [`examples/attributes`](../examples/attributes).
