# Chapter 5: Classes and objects

Classes are the center of XenonScript: every function is a method, and a program starts by creating
an instance of its main class. A class compiles to a JavaScript class of the same shape, so
XenonScript classes can be used from JavaScript and extend JavaScript classes.

## A class

```actionscript check
class Counter {
  private var value:Int = 0
  public final step:Int

  public function Counter(step:Int = 1) {
    this.step = step
  }

  public function increment():Int {
    value += step
    return value
  }

  public function get current():Int => value
}

public class Main {
  public function Main() {
    var c = new Counter(5)
    c.increment()
    c.increment()
    trace(c.current, c.step)
  }
}
```

```text output
10 5
```

- **Fields** are declared with `var` (changeable), `final` (assigned once) or `const` (a constant
  value), a type and an optional initial value.
- **The constructor** is the function named like the class. It has no return type.
- Inside the class, members are reached by their plain names (`value`, `step`); `this.value` works
  too and is needed where a parameter has the same name (`this.step = step`).
- `new Counter(5)` creates an instance; leaving out an argument with a default is allowed.

## Fields

```actionscript check
class Account {
  public var owner:String = 'nobody'      // changeable, with an initial value
  public final id:Int                     // assigned once, in the constructor
  public const kind:String = 'basic'      // a constant, the same for every instance
  public var note:String? = null          // nullable: may stay null
  public static var created:Int = 0       // one value for the whole class

  public function Account(id:Int) {
    this.id = id
    created++
  }
}
```

Field initializers run in order when an instance is created, before the constructor body. A field
that isn't nullable must have a value when the constructor ends, on every path through it (X0819;
see [chapter 3](03-types-and-null-safety.md#null-safety)).

A `final` field is assigned exactly once: in its declaration, or in the constructor, on every path.
The compiler checks this the same way it checks `final` locals: no read before the assignment, no
second assignment, no assignment outside the constructor:

```actionscript check
class User {
  public final id:String

  public function User(id:String) {
    trace(this.id)              // error X0510: read before it's assigned
    this.id = id
  }

  public function reset():Void {
    id = ''                     // error X0502: only the constructor can assign it
  }
}
```

`final` fields are read-only for JavaScript code too: they compile to getters over private storage.

## Constructors

A class without a constructor gets one: with no parameters, or, in a subclass, with the
parameters of the parent's constructor, which it passes on. A subclass constructor calls the
parent's with `super(…)` before it uses `this`; when the parent's constructor takes no arguments,
the call can be left out.

```actionscript check
class Animal {
  public final name:String
  public function Animal(name:String) { this.name = name }
}

class Dog extends Animal {}              // inherits `Dog(name:String)`

class Cat extends Animal {
  public final indoor:Bool
  public function Cat(name:String, indoor:Bool) {
    super(name)                          // first: the Animal part
    this.indoor = indoor
  }
}

public class Main {
  public function Main() {
    trace(new Dog('Rex').name, new Cat('Tom', true).indoor)
  }
}
```

```text output
Rex true
```

A constructor can be `private` or `protected`: then only the class itself (and its subclasses) can
create instances, which is how factories and singletons are written. The main class's constructor
can't have required parameters, because the program starts with `new Main()`.

## Methods and accessors

Methods are functions that belong to a class (see [chapter 4](04-control-flow-and-functions.md#functions)
for parameters, defaults and rest parameters). A body can be a block or one expression:

```actionscript check
class Rect {
  public var width:Float = 0
  public var height:Float = 0

  public function area():Float => width * height

  public function scale(factor:Float):Void {
    width *= factor
    height *= factor
  }
}
```

**Accessors** (getters and setters) look like fields from outside and run code when read or
written:

```actionscript check
class Temperature {
  private var celsius:Float = 0

  public function get fahrenheit():Float => celsius * 9 / 5 + 32

  public function set fahrenheit(value:Float):Void {
    celsius = (value - 32) * 5 / 9
  }
}

public class Main {
  public function Main() {
    var t = new Temperature()
    t.fahrenheit = 212
    trace(t.fahrenheit)
  }
}
```

```text output
212
```

A getter without a setter is read-only (assigning it is X0504); a setter without a getter can't be
read (X0506). A setter can be less visible than its getter (`public function get width()` with
`private function set width(…)`), never more (X0212).

### Properties with accessors

A property can also carry its accessors, without a separate storage field:

```actionscript check
class Person {
  private var first:String = ''
  private var last:String = ''

  public var label:String = '' {
    set => label = value.trim()          // `value` is the new value
  }

  public var age:Int = 0 {
    set => {
      if (value < 0) throw new ArgumentException('age')
      age = value
    }
  }

  public var fullName:String {
    get => $'{first} {last}'
    set => {
      var parts = value.split(' ')
      first = parts[0]
      last = parts.slice(1).join(' ')
    }
  }
}

public class Main {
  public function Main() {
    var p = new Person()
    p.label = '  admin  '
    p.fullName = 'Ada King Lovelace'
    trace($'[{p.label}]', p.fullName)
  }
}
```

```text output
[admin] Ada King Lovelace
```

Each accessor is `get => expr` / `set => expr`, or `=> { … }` with statements; they are separated by
line breaks or `;`. Inside its own accessors, the property's name is its storage, so `label = value`
assigns the storage instead of calling the setter again. A missing `get` reads the storage, a missing
`set` writes it. When both are given and neither uses the storage (like `fullName`), the property has
none, and an initial value is an error (X0886). The property needs a type and `var`; it compiles to a
private `#$label` field and a JavaScript getter/setter pair.

## Visibility

| Modifier | Visible to |
|---|---|
| `public` | everyone |
| `internal` (the default) | code in the same package |
| `protected` | the class and its subclasses |
| `private` | the class itself |

Visibility applies to fields, methods, accessors, constructors and typedefs inside a class (see
[typedefs inside a class](03-types-and-null-safety.md#typedefs-inside-a-class)). Classes themselves
are `public` or `internal`. Using a member that isn't visible is an error (X0603) that names the
member's visibility, and, for `_name` fields with a public `name` accessor, suggests the accessor.

`private` members compile to JavaScript `#private` fields and methods, so they are private at
runtime too: JavaScript code can't read or change them. `protected` and `internal` exist only at
compile time. One exception: a private field with an attribute read at run time (`[State] private
var draft`, see [attributes](06-interfaces-and-generics.md#attributes)) is a plain property, so
the code reading the attribute can reach the field by its name. Compile-time attributes such as
`[Deprecated]` don't change it.

## Static members

`static` members belong to the class instead of each instance:

```actionscript check
class Registry {
  private static final ids:Array<Int>
  public static var count:Int = 0

  static {
    ids = []                       // a static block initializes static state
    trace('registry ready')
  }

  public static function add(id:Int):Void {
    ids.push(id)
    count++
  }
}

public class Main {
  public function Main() {
    Registry.add(7)
    Registry.add(8)
    trace(Registry.count)
  }
}
```

```text output
registry ready
2
```

Static members are reached through the class name (`Registry.add`); reaching one through an
instance is an error (X0413), and instance members can't be used from static code (X0410). A
`static {}` block runs once, when the class is defined; `static final` fields are checked like
`final` fields, with the static blocks taking the constructor's place.

A **static class** has only static members and can't be instantiated (X0415). It is the place for
utility functions:

```actionscript check
static class Text {
  public static function shout(s:String):String => s.toUpperCase() + '!'
}

public class Main {
  public function Main() {
    trace(Text.shout('hey'))
  }
}
```

```text output
HEY!
```

## Inheritance

A class extends one other class and inherits its members:

```actionscript check
class Animal {
  protected final name:String

  public function Animal(name:String) {
    this.name = name
  }

  public function speak():String => name + ' makes a sound'
}

final class Dog extends Animal {
  override public function speak():String => $'{super.speak()}: woof'
}

public class Main {
  public function Main() {
    var pets:Array<Animal> = [new Animal('Generic'), new Dog('Rex')]
    for (var p of pets) trace(p.speak())
  }
}
```

```text output
Generic makes a sound
Rex makes a sound: woof
```

- **`override`** is required on a method that replaces an inherited one (X0720), and is an error on
  one that doesn't. This includes the members every object has: a class that defines `toString`
  writes `override public function toString()`.
- The override must accept the same parameters and return a compatible type; it can't be less
  visible.
- **`super.speak()`** calls the parent's version.
- Calls are virtual: `p.speak()` runs the `Dog` version for a `Dog`, also through an
  `Array<Animal>`.
- **`final class`** can't be extended; a **`final` method** can't be overridden.
- An accessor can override one half (only the getter, say); the other half is inherited.

A class can also extend a JavaScript class from an import, such as `EventTarget` or a library's
class (see [chapter 9](09-packages-and-javascript.md)).

## Abstract classes

An `abstract` class is a base that can't be instantiated itself; its `abstract` members have no body
and must be implemented by concrete subclasses:

```actionscript check
abstract class Shape {
  public abstract function area():Float

  public function describe():String => $'{area().toFixed(1)} square units'
}

class Circle extends Shape {
  private final r:Float
  public function Circle(r:Float) { this.r = r }
  override public function area():Float => Math.PI * r * r
}

class Square extends Shape {}               // error X0711: `area` isn't implemented

public class Main {
  public function Main() {
    trace(new Circle(1).describe())
    var s = new Shape()                     // error X0710: abstract
  }
}
```

The error for a missing implementation comes with a quick fix that inserts stubs for every missing
member.

## Equality, `toString` and operator methods

`a == b` on objects compares identity: two different objects are never equal, even with the same
contents. A class can define what `==` means for its values, and operators for arithmetic:

```actionscript check
class Vec {
  public final x:Float
  public final y:Float

  public function Vec(x:Float, y:Float) {
    this.x = x
    this.y = y
  }

  public function operator+(o:Vec):Vec => new Vec(x + o.x, y + o.y)
  public function operator-(o:Vec):Vec => new Vec(x - o.x, y - o.y)
  public function operator*(f:Float):Vec => new Vec(x * f, y * f)
  public function operator==(o:Vec):Bool const => x == o.x && y == o.y

  override public function toString():String => $'({x}, {y})'
}

public class Main {
  public function Main() {
    var a = new Vec(1, 2)
    var b = a + new Vec(3, 4)
    b += a                                   // compound assignment uses operator+ too
    trace(String(b), String(b * 2), b == new Vec(5, 8), b != a)
  }
}
```

```text output
(5, 8) (10, 16) true true
```

- `+`, `-`, `*`, `/` and `==` can be defined; `!=` is the negation of `==`. A native class can
  also declare `operator[]`, the type of indexing it (see
  [chapter 9](09-packages-and-javascript.md#native-declarations)).
- An operator is chosen by the type of the **left** operand at compile time, and compiles to a
  method call. `+` with a `String` on either side still concatenates.
- `operator==` should be `const` and is also used by `!=`; `==` against `null` never calls it.
- For value equality that generic code can rely on, implement `IEquatable<T>`; for an ordering,
  `IComparable<T>` (see [chapter 6](06-interfaces-and-generics.md#value-equality-iequatablet)).

## Const methods

A method marked `const` (after its return type) promises not to change its object:

```actionscript check
class Cart {
  private var items:Array<String> = []
  private var total:Float = 0

  public function add(item:String, price:Float):Void {
    items.push(item)
    total += price
  }

  public function count():Int const => items.length

  public function report():String const {
    total = 0                                  // error X0901: a const method can't change `total`
    add('x', 1)                                // error X0902: `add` isn't const
    items.push('y')                            // error X0905: `items` is a read-only view here
    return $'{count()} items, {total}'         // fine: `count` is const
  }
}
```

Inside a const method, `this` is a read-only view of the object (see the next section), so the
rules go all the way down: fields can't be assigned, only const methods and getters can be used,
and what a field holds (`items`) can't be changed through it either. `this` can't leave the method
as a changeable object: returning `this` or passing it on needs a `const` type.

Arrow functions inside a const method inherit the restriction; `function` expressions, which have
their own `this`, don't. An override of a const method must be const too. Getters can be const,
setters and static methods can't. `constexpr` and `consteval` methods are const automatically (see
[chapter 8](08-compile-time-programming.md)).

## Read-only views: `const T`

`const` before a type makes a *read-only view*: a reference through which the object can be read
but not changed. It is the type-level version of a const method, and it works for parameters,
variables, fields and return types:

```actionscript check
class Cart {
  public var total:Float = 0
  public function add(price:Float):Void { total += price }
  public function summary():String const => $'total {total}'
}

public class Main {
  public function Main() {
    var cart = new Cart()
    cart.add(3)
    trace(Main.show(cart))
    var view:const Cart = cart
    var back:Cart = view                     // error X0308: a view can't become changeable again
  }

  public static function show(cart:const Cart):String {
    cart.total = 0                           // error X0904
    cart.add(1)                              // error X0905: `add` isn't const
    return cart.summary()                    // fine: `summary` is const
  }
}
```

A `Cart` fits a `const Cart`, so callers pass their objects as usual. The code that holds the plain
`Cart` can still change it; `const` limits what this one reference allows.

### The rules

- Through a `const` view, fields and setters can't be assigned, also with `++` or `+=` (X0904), and
  only `const` methods and getters can be used (X0905). Both errors offer a quick fix that marks the
  method `const` if it doesn't change anything.
- **The view is transitive**: what a field or getter gives through it is a view too. Reading
  `cart.owner` through a `const Cart` gives a `const Person`, so `cart.owner.name = …` is an error,
  also after `var { owner } = cart`. A method's result is what the method declares, so a `const`
  method that hands out a field returns a `const` type:

  ```actionscript check
  class Person { public var name:String = '' }

  class Shop {
    private var _owner:Person = new Person()
    public function get owner():Person const => _owner          // error X0308: a const Person here
    public function get boss():const Person const => _owner     // fine
  }
  ```

- A `const` view fits only `const` types and `*`. Type arguments keep it apart too: an
  `Array<const Cart>` isn't an `Array<Cart>`.
- `const` survives inference (`var v = view` is a view) and `is` narrowing (a `const Animal` tested
  `is Dog` is a `const Dog`), and a cast keeps it: `view as Dog` is a `const Dog?`.
- `const` on a type that can't change, such as `Int`, `String`, an enum or a function type, has no
  effect and warns (X0889).

### Arrays and the standard library

Arrays, tuples and records follow the same rules. A `const Array<Cart>` can use the members that
don't change the array (`length`, `map`, `filter`, `slice`, `indexOf`, `at`, `join`, `for … of`, …),
but not `push`, `pop`, `shift`, `unshift`, `splice`, `sort`, `reverse` or `fill`, and `view[i] = x`
and `view.length = 0` are errors. Its elements are read-only too:

```actionscript check
class Cart { public var total:Int = 0 }

public class Main {
  public function Main() {
    var list = [new Cart(), new Cart()]
    var view:const Array<Cart> = list
    trace(view.length, view.map((c) => c.total))
    view.push(new Cart())                    // error X0905
    view[0] = new Cart()                     // error X0904
    view[0].total = 1                        // error X0904: elements are `const Cart`
    var copy = view.slice()                  // a new array: it can grow, its Carts are const
    copy.push(list[0])
  }
}
```

Callbacks of `map`, `forEach` and the others receive the array itself as a `const Array<T>` (their
third parameter), so a callback that types it writes `all:const Array<Int>`.

The standard library's `Map`, `Set`, `Date`, `URLSearchParams`, `FormData`, `RegExp`, `Promise`,
`Blob` and `ArrayBuffer` mark their members the same way: a `const Map<String, Cart>` can use `get`,
`has`, `size`, `keys()`, `forEach` and `for … of`, but not `set`, `delete` or `clear`, and the
`Cart`s it gives are `const`. A `const Date` has its getters and `to…String` methods but no setters;
a `const RegExp` can't use `test` or `exec`, which move `lastIndex`. The DOM classes, `Event`,
`EventTarget`, iterators and `Response` aren't checked through `const` yet.

### Variance and generic code

Because nothing can be stored through a read-only view, it is covariant: an `Array<Dog>` (or a
`const Array<Dog>`) fits a `const Array<Animal>`, though not an `Array<Animal>`, which could be
given a `Cat`. This holds for arrays, tuples, records, `Set`, `Promise` and the values of a `Map`
(its keys stay invariant). Generic classes of your own keep their declared variance (`out T`):
their `const` methods may still take a `T`.

Generic code keeps `const` too: `first<T>(xs:const Array<T>):const T?` called with an
`Array<Cart>` returns a `const Cart?`, and inside it, the elements of `xs` are `const T`, so
returning one as a plain `T` is an error.

### Leaving a view: `unconst`

When code really has to change an object it only has a view of, `unconst(view)` removes `const`
from the type (at every level: `unconst(list)` of a `const Array<const Cart>` is an `Array<Cart>`).
It is checked at compile time and emits just `view`; the keyword makes each such place easy to
find:

```actionscript check
class Cart { public var total:Int = 0 }

public class Main {
  public function Main() {
    var view:const Cart = new Cart()
    unconst(view).total = 5                  // deliberate: this code owns the cart after all
    trace(view.total)
  }
}
```

```text output
5
```

Values typed `*` aren't checked at all. TypeScript's read-only types in `.d.ts` files arrive as
`const`: `ReadonlyArray<T>` and `readonly T[]` are `const Array<T>`, `readonly [A, B]` a
`const Tuple<A, B>`, `ReadonlyMap` and `ReadonlySet` `const Map`/`const Set`. In the editor,
completion on a `const` value leaves out what can't be used there.

`const` is compile time only: the JavaScript output doesn't freeze anything. The TypeScript output
writes `Readonly<Cart>`, `ReadonlyArray<T>` and `readonly [..]`.

## Exercises

1. Write a `BankAccount` with a `final` id, a private balance, `deposit` and `withdraw` methods and a
   `const` getter for the balance. Try to change the balance from a `const` method.
2. Give `BankAccount` a `private` constructor and a `static function open(id:String)` factory.
3. Build a small `Shape` hierarchy with an abstract `area()`, then sort an `Array<Shape>` by area.
4. Add `operator+` and `operator==` to a `Money` class (amount and currency), and decide what `+`
   should do with different currencies.
5. Write a function that takes a `const Array<Cart>` and returns the total; check that it accepts an
   `Array<Cart>` and refuses to `push`.

See [`examples/inheritance`](../examples/inheritance), [`examples/abstract`](../examples/abstract),
[`examples/finals`](../examples/finals), [`examples/const-methods`](../examples/const-methods),
and [`examples/operators`](../examples/operators).
