# Chapter 6: Interfaces, generics, and contracts

This chapter is about writing code that works with more than one type: interfaces describe what a
class can do, generics let a class or function work for any type with checks intact, and enums,
iteration, class values and attributes cover the remaining ways types meet at runtime.

## Interfaces

An interface lists members without implementing them. A class `implements` it by providing every
member with a fitting signature:

```actionscript check
interface Shape {
  function area():Float
  function get name():String
}

class Circle implements Shape {
  private final r:Float
  public function Circle(r:Float) { this.r = r }
  public function area():Float => Math.PI * r * r
  public function get name():String => 'circle'
}

class Square implements Shape {
  private final side:Float
  public function Square(side:Float) { this.side = side }
  public function area():Float => side * side
  public function get name():String => 'square'
}

public class Main {
  public function Main() {
    var shapes:Array<Shape> = [new Circle(1), new Square(2)]
    for (var s of shapes) trace(s.name, s.area().toFixed(2))
    var x:* = shapes[0]
    trace(x is Shape, x is Circle)
  }
}
```

```text output
circle 3.14
square 4.00
true true
```

- Interface members are public; implementations are `public` too. Implementing a member doesn't use
  `override` (that is for replacing a superclass's method; writing it here is X0721).
- A class can implement several interfaces (`implements A, B`), and an interface can extend several
  others (`interface C extends A, B`).
- The implementation must match each member: kind (method, getter, setter), parameter types and
  count, a compatible return type, and `const` where the interface says `const`. A mismatch is
  X0788, with a note on what differs; a missing member is X0787, with a quick fix that inserts stubs
  throwing `NotImplementedException`.
- An `abstract` class can leave interface members to its subclasses.
- Interfaces exist at runtime as marker symbols, so `x is Shape` and `x as Shape` work, also for
  values typed `*`. An interface can't be instantiated, and can't declare fields, typedefs or
  static members.

### Value equality: `IEquatable<T>`

`==` compares objects by reference. The built-in `IEquatable<T>` interface gives a class a value
comparison that generic code can rely on:

```actionscript check
class Money implements IEquatable<Money> {
  public final cents:Int
  public final currency:String
  public function Money(cents:Int, currency:String) { this.cents = cents; this.currency = currency }
  public function equals(other:Money):Bool => cents == other.cents && currency == other.currency
}

public class Main {
  public function Main() {
    var a = new Money(100, 'EUR')
    var b = new Money(100, 'EUR')
    trace(a == b, a.equals(b), Main.indexOf([new Money(5, 'EUR'), b], a))
  }

  public static function indexOf<T extends IEquatable<T>>(items:Array<T>, x:T):Int {
    for (var i of 0..items.length) if (items[i].equals(x)) return i
    return -1
  }
}
```

```text output
false true 1
```

JavaScript's `Map`, `Set`, and `Array.includes` still compare objects by identity; they don't call
`equals`. To make `==` itself compare values, define `operator==` (see
[chapter 5](05-classes-and-objects.md#equality-tostring-and-operator-methods)).

### Ordering: `IComparable<T>`

`IComparable<T>` gives a class a natural order. `compareTo` returns a negative number when this
value comes first, `0` when the two are equal in the order, and a positive number when it comes after:

```actionscript check
class Version implements IComparable<Version> {
  public final major:Int
  public final minor:Int
  public function Version(major:Int, minor:Int) { this.major = major; this.minor = minor }
  public function compareTo(other:Version):Int => major != other.major ? major - other.major : minor - other.minor
  override public function toString():String => $'{major}.{minor}'
}

public class Main {
  public function Main() {
    var versions = [new Version(2, 1), new Version(1, 9), new Version(2, 0)]
    var sorted = versions.toSorted((a, b) => a.compareTo(b))
    trace(sorted.join(' '), String(Main.max(versions)))
  }

  public static function max<T extends IComparable<T>>(items:Array<T>):T? {
    var best:T? = null
    for (var item of items) if (best == null || item.compareTo(best) > 0) best = item
    return best
  }
}
```

```text output
1.9 2.0 2.1 2.1
```

A class can implement both interfaces; `equals` then usually agrees with `compareTo(other) == 0`.

## Generics

Classes, interfaces, methods, local functions and typedefs can take *type parameters*, written in
angle brackets after the name. Inside, the parameter is used like any type; each use supplies a
concrete type, and the checks apply to it:

```actionscript check
class Box<T> {
  public final value:T

  public function Box(value:T) {
    this.value = value
  }

  public function map<U>(convert:(T) -> U):Box<U> {
    return new Box(convert(value))
  }
}

public class Main {
  public function Main() {
    var text = new Box('hello')                 // Box<String>: T inferred from the argument
    var length = text.map((s) => s.length)      // Box<Int>: U inferred from the callback's result
    var explicit = new Box<Float>(1)            // T written out: 1 is used as a Float
    trace(length.value, explicit.value)
    var wrong:Box<Int> = text                   // error X0308: a Box<String> isn't a Box<Int>
  }
}
```

- **Inference**: a generic method's or constructor's type arguments are inferred from the
  arguments, from callbacks' results, and from the expected type (`var b:Box<Float> = new Box(1)`).
- **Invariance**: a `Box<Dog>` is not a `Box<Animal>`, even though a `Dog` is an `Animal`.
  Otherwise code holding the `Box<Animal>` could store a `Cat` in it. Variance annotations relax
  this where it is safe (see [generic variance](#generic-variance)).
- **Wildcard**: `Box<*>` accepts a box of anything; what you read from it is `*`.
- **Erasure**: type arguments don't exist at runtime. `x is Box` tests the class; `x is Box<Int>`
  can't be tested.

## Generic constraints

Use `extends` to require every argument for a type parameter to have a particular upper bound;
inside the declaration, `T` then has the members of its bound:

```actionscript check
class Animal {
  public final name:String
  public function Animal(name:String) { this.name = name }
}
class Dog extends Animal {}

class Cage<T extends Animal> {
  public final value:T
  public function Cage(value:T) { this.value = value }
  public function label():String => 'cage of ' + value.name     // `name` comes from Animal
}

public class Main {
  public function Main() {
    var dog = new Cage(new Dog('Rex'))
    trace(dog.label())
    var text = new Cage('hello')              // error X0880: a String isn't an Animal
  }
}
```

The constraint applies to explicit arguments, inferred constructor and call arguments, inherited
generic types, and defaults. Constraints may reference the declaration's other parameters, and may
refer to the parameter itself, as in `T extends IComparable<T>` above. Classes, interfaces,
typedefs, methods, and local functions support constraints.

### Several bounds: `A & B`

When an argument needs several capabilities, list the bounds with `&`. The argument must satisfy
every one of them, and inside the declaration `T` has the members of all of them:

```actionscript check
interface INamed { function get name():String }
interface ISized { function get size():Int }

class Doc implements INamed, ISized {
  public function get name():String => 'notes'
  public function get size():Int => 3
}

public class Main {
  public function Main() {
    trace(Main.describe(new Doc()))
  }

  public static function describe<T extends INamed & ISized>(item:T):String => item.name + ' ' + item.size
}
```

```text output
notes 3
```

A class that implements `INamed` and `ISized` separately fits, with no combined interface needed.
A bound may also be a structural type, such as `T extends INamed & { label:String }`. A `T` fits
wherever one of its bounds fits, so `item` can be passed as an `INamed` or as an `ISized`. When an
argument misses a bound, X0880 names that bound. Implementing or overriding a generic method can
repeat the bounds in any order, but can't add one. In the TypeScript output the bounds become a
TypeScript intersection.

Outside `extends`, `&` combines shapes only (`Attrs & { extra:String }`, see
[chapter 3](03-types-and-null-safety.md#combining-shapes-a--b)). `var x:INamed & ISized` is an
error; a generic parameter `<T extends INamed & ISized>(x:T)` accepts the same values.

### Defaults

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
parameter after one with a default needs a default too (X0878). A parameter can combine variance,
a constraint and a default, in that order: `class Cache<out T extends Resource = DefaultResource>`.

## Generic variance

Generic parameters are invariant unless a declaration marks their direction. `out T` means the
class only *produces* `T`s (returns them, exposes them read-only), so a producer of `Dog`s can stand
in for a producer of `Animal`s. `in T` means it only *consumes* them:

```actionscript check
class Animal {}
class Dog extends Animal {}

class Reader<out T> {
  private final value:T
  public function Reader(value:T) { this.value = value }
  public function get():T => value
}

interface Sink<in T> {
  function accept(value:T):Void
}

class Logger implements Sink<Animal> {
  public function accept(value:Animal):Void {}
}

public class Main {
  public function Main() {
    var animals:Reader<Animal> = new Reader<Dog>(new Dog())    // out: a Reader<Dog> fits
    var dogs:Sink<Dog> = new Logger()                         // in: a Sink<Animal> fits
  }
}
```

The checker validates the declaration itself, so the annotation can't lie:

- `out T` may be returned, read from `final` fields and getters, and nested in other outputs.
- `in T` may be taken as a parameter, or nested in other inputs.
- a `var` field of type `T` is both, so it allows neither annotation:

```actionscript check
class Holder<out T> {                     // error X0799: `value` can be written
  public var value:T
  public function Holder(value:T) { this.value = value }
}
```

Variance is also available on typedefs (`typedef Mapper<in I, out O> = (value:I) -> O`). Function
types already follow the rule: parameters are contravariant, results covariant. Read-only views
make arrays and the standard collections covariant (see
[chapter 5](05-classes-and-objects.md#variance-and-generic-code)). Variance is erased at runtime.

## Type parameters in structural types

```actionscript check
typedef Result<T> = {
  value:T?,
  error:String?
}

public class Main {
  public function Main() {
    var ok:Result<Int> = { value: 42, error: null }
    var failed:Result<Int> = { value: null, error: 'timeout' }
    trace(ok.value ?? 0, failed.error ?? '')
  }
}
```

```text output
42 timeout
```

## Enums

An enum is a fixed set of named values:

```actionscript check
enum Status {
  Pending,
  Active,
  Complete = 10,
  Failed
}

enum Level { Low = 'low', High = 'high' }

public class Main {
  public function Main() {
    var s = Status.Active
    trace(s, Status.Failed, Status.values(), Level.High)
    switch (s) {
      case Status.Pending: trace('waiting'); break
      case Status.Active: trace('running'); break
      default: trace('done')
    }
    var raw:* = 'high'
    trace(raw is Level)
  }
}
```

```text output
1 11 [ 0, 1, 10, 11 ] high
running
true
```

- Members without a value are numbered from 0, or from the previous member's value plus one.
- A string enum gives every member a constant string value.
- `Status.values()` lists the members in order.
- An enum is a nominal type: a `Status` parameter accepts `Status.Active`, not an arbitrary number.
  `x is Status` tests whether a value is one of the members.
- A `switch` over an enum warns about unhandled members when it has no `default` (X0814).

An enum compiles to a frozen JavaScript object (`Object.freeze({ Pending: 0, … })`), so its values
are plain numbers or strings at runtime.

## Iteration protocols

`Iterable<T>` follows JavaScript's iterable protocol: `[Symbol.iterator]()` returns an
`Iterator<T>`. Arrays, strings, `Map`, `Set`, iterators, `NodeList` and `HTMLCollection` implement
it, and any class can:

```actionscript check
class Playlist implements Iterable<String> {
  private final songs:Array<String>
  public function Playlist(songs:Array<String>) { this.songs = songs }
  public function [Symbol.iterator]():Iterator<String> => songs.values()
}

public class Main {
  public function Main() {
    var list = new Playlist(['intro', 'theme'])
    for (var song of list) trace(song)                 // `song` is a String
    trace(Main.count(list), Main.count('abc'), Main.count(new Set([1, 2])))
  }

  public static function count<T>(items:Iterable<T>):Int {
    var n = 0
    for (var item of items) n++
    return n
  }
}
```

```text output
intro
theme
2 3 2
```

An `Iterable<T>` parameter accepts all of them. `Iterator<T>` is iterable too (its
`[Symbol.iterator]()` returns itself), and has the lazy helpers `map`, `filter`, `take`, `drop` and
`flatMap`, plus `toArray`, `forEach`, `reduce`, `some`, `every` and `find`.
`IteratorResult<T>` mirrors the protocol's `done` and `value` properties. Generator functions
(`function*`, `yield`) aren't supported; return an existing iterator or build one from an array.

## `Class<T>`

A class can be used as a value: passed to a function, stored, compared. Its type is `Class<T>`,
which holds `T` or a subclass of it (or, for an interface, a class implementing it):

```actionscript check
class Animal {}
class Dog extends Animal { public function bark():String => 'woof' }
class Cat extends Animal {}

public class Main {
  public function Main() {
    var animals:Array<Animal> = [new Dog(), new Cat(), new Dog()]
    var kind:Class<Animal> = Dog
    trace(kind.name, kind == Dog, Main.count(animals, Dog), Main.count(animals, Cat))
    var d = Main.first(animals, Dog)             // Dog?: T inferred from the class
    trace(d?.bark())
    var make = new kind()                        // error X0831: `new` isn't available
  }

  public static function count(list:Array<Animal>, kind:Class<Animal>):Int {
    var n = 0
    for (var a of list) if (a is kind) n++
    return n
  }

  public static function first<T>(list:Array<Animal>, kind:Class<T>):T? {
    for (var a of list) {
      if (var found = a as kind) return found
    }
    return null
  }
}
```

A `Class<T>` value can be passed on, compared with `==`, used to test values (`x is kind` narrows
`x` to `T`; `x as kind` gives `T?`), and asked for its `name`. Statics and `new` aren't available
through it (X0831): the actual class, and so its constructor's parameters, are only known at
runtime. To create instances, pass a factory function (`() -> T`) instead.

## Attributes

Attributes attach data to classes, methods and fields, to be read at runtime (frameworks, routing,
serialization) or by the compiler. An attribute is a class that implements `IAttribute`:

```actionscript check
[Usage(AttributeTarget.Method, multiple = true)]
class Route implements IAttribute {
  public final path:String
  public var verb:String = 'GET'
  public function Route(path:String) { this.path = path }
}

class Users {
  [Route('/users'), Route('/people')]
  public function list():String => 'all'

  [Route('/users', verb = 'POST')]
  public function create():String => 'created'
}

public class Main {
  public function Main() {
    for (var name of Attributes.members(Users)) {
      for (var r of Attributes.ofMember(Users, name, Route)) trace(r.verb, r.path, '->', name)
    }
  }
}
```

```text output
GET /users -> list
GET /people -> list
POST /users -> create
```

- `[Name(args)]` creates the attribute with its constructor; `name = value` after the arguments
  sets fields. Several attributes can share brackets (`[A, B]`) or use several.
- Arguments must be compile-time constants (literals, `inline` constants, enum members).
- `[Usage(…)]` on the attribute class says where it may be used (`AttributeTarget.Class`, `Method`,
  `Field`; all three without `Usage`) and whether a declaration may carry it more than once
  (`multiple = true`).
- `Attributes.of(Class, Kind)` and `Attributes.first(Class, Kind)` read a class's attributes;
  `Attributes.members(Class)` lists the members that have any, and
  `Attributes.ofMember(Class, name, Kind)` reads one member's. The instances are created when first
  asked for.

An attribute can change the methods it's used on by defining `wrap(method, name)`: when the class is
defined, the method is replaced by what `wrap` returns. This is how logging, timing or
authorization wrappers are written (see [`examples/attributes`](../examples/attributes)). Wrapping
isn't allowed on compile-time methods, whose constant calls may disappear.

### Compiler attributes

Two attributes are read by the compiler:

```actionscript check
class Api {
  [Deprecated('use fetchAll()')]
  public function all():Array<String> => fetchAll()

  public function fetchAll():Array<String> => []

  [NoDiscard('the copy is the result; the list is unchanged')]
  public function sorted(list:Array<String>):Array<String> => list.toSorted()
}

public class Main {
  public function Main() {
    var api = new Api()
    api.all()                              // warning X0873: deprecated, use fetchAll()
    api.sorted(['b', 'a'])                 // warning X0875: the result is dropped
  }
}
```

`[Deprecated]` warns at every use outside the deprecated declaration itself; `[NoDiscard]` warns
when a call's result is ignored. Both are compile time only.

## Exercises

1. Write an interface `Storage` with `get(key:String):String?` and `set(key:String, value:String)`,
   and two implementations (an in-memory `Map`, and one that logs).
2. Write `class Stack<T>` with `push`, `pop():T?` and a `const` getter `size`. Make it `Iterable<T>`.
3. Write `function maxBy<T>(items:Array<T>, key:(T) -> Float):T?` and call it without writing any
   type argument.
4. Make a `Reader<out T>` and check that a `Reader<Dog>` can be used as a `Reader<Animal>`; then add a
   `set(value:T)` method and read the error.
5. Write a `[Column('name')]` attribute and print the column names of a class's fields.

See [`examples/interfaces`](../examples/interfaces),
[`examples/generics`](../examples/generics), [`examples/enums`](../examples/enums),
[`examples/enumerable`](../examples/enumerable), [`examples/class-values`](../examples/class-values),
and [`examples/attributes`](../examples/attributes).
