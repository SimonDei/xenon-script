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

Generic types erase to ordinary JavaScript classes and functions.

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
