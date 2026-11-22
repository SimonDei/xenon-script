# Chapter 5: Classes and objects

## A class

```actionscript
public class Counter {
  private var value:Int = 0

  public function Counter(start:Int = 0) {
    value = start
  }

  public function increment():Int {
    return ++value
  }
}
```

Constructors have the class name, no return type, and compile to JavaScript constructors.

## Fields and definite assignment

`final` fields are assigned exactly once. A constructor that leaves one unassigned on a path is an
error.

```actionscript
public final id:String

public function User(id:String) {
  this.id = id
}
```

With null safety, a non-null `var` field without an initializer must also be assigned on every
constructor path.

## Visibility

Members and constructors support:

- `public`
- `protected`
- `private`
- `internal` (the default), visible inside the package

Private JavaScript output uses `#private` fields and methods.

## Properties

```actionscript
private var storedName:String = ''

public function get name():String {
  return storedName
}

public function set name(value:String):Void {
  storedName = value.trim()
}
```

The setter name and its type can differ from the getter's writable type. A setter without a getter
cannot be read.

## Static members and blocks

```actionscript
public class Registry {
  private static final ids:Array<Int>

  static {
    ids = []
    trace('initialized')
  }

  public static function add(id:Int):Void {
    ids.push(id)
  }
}
```

Static fields, methods, accessors, blocks, generic methods, and abstract member rules participate in
the same type checking as instance members.

## Inheritance

```actionscript
public class Animal {
  protected final name:String

  public function Animal(name:String) {
    this.name = name
  }

  public function speak():String {
    return name
  }
}

public final class Dog extends Animal {
  public function Dog(name:String) {
    super(name)
  }

  override public function speak():String {
    return $'{super.speak()} says woof'
  }
}
```

Rules:

- `super(...)` must occur before using `this`.
- Overriding requires `override`.
- Parameter and return compatibility is checked.
- `final` classes cannot be extended.
- `final` methods cannot be overridden.
- Accessors delegate the matching inherited half where appropriate.

`dynamic` is reserved but not currently implemented.

## Abstract classes and members

```actionscript
public abstract class Shape {
  public abstract function area():Float
}
```

An abstract class cannot be constructed. Concrete subclasses must implement every abstract member,
and the `abstract` implementation check produces missing-member stubs where possible.

## Const methods

```actionscript
public function getArea():Float const {
  return width * height
}
```

A const method cannot write through `this` and can call only const getters/methods on the same object.
Arrow functions inherit the const restriction; ordinary function expressions do not. Fields and
static state outside the method still follow their normal rules.

`constexpr` and `consteval` instance methods are implicitly const; see
[Chapter 8](08-compile-time-programming.md).

## Operator methods

Classes can overload arithmetic operators and equality:

```actionscript
public function operator+(other:Vector):Vector {
  return new Vector(x + other.x, y + other.y)
}

public function operator==(other:Vector):Bool {
  return x == other.x && y == other.y
}
```

Supported operator methods are `+`, `-`, `*`, `/`, and `==`; `!=` negates `==`. Compound assignment
evaluates its receiver and index once. Static dispatch begins with the left operand's type.

## Method identity

Taking a method as a function value produces a bound, cached function:

```actionscript
var handler:() -> Void = button.click
var again:() -> Void = button.click

trace(handler == again) // true
```

The cache is per instance and preserves `this`.

See [`examples/inheritance`](../examples/inheritance), [`examples/abstract`](../examples/abstract),
[`examples/const-methods`](../examples/const-methods), and
[`examples/operators`](../examples/operators).
