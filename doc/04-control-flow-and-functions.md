# Chapter 4: Control flow and functions

The statements of XenonScript are JavaScript's, with a few additions (binding conditions, ranges,
`defer`) and stricter checks: conditions must be `Bool`, every path of a function must return a
value, and an enum `switch` that misses a case is reported.

## Conditions

```actionscript check
var score = 7
if (score > 0) {
  trace('positive')
} else if (score == 0) {
  trace('zero')
} else {
  trace('negative')
}
var label = score > 5 ? 'high' : 'low'
trace(label)
```

```text output
positive
high
```

A condition must be a `Bool`: `if (count)` is an error that suggests `count != 0` (see
[chapter 2](02-values-and-syntax.md#conditions-are-bool)). On one line, `else` needs a `;` or braces
before it: `if (ok) a = 1; else a = 2`.

### Binding conditions

`if (var name = value)` declares a local and runs the block only when the value isn't `null`. Inside,
the local has the non-null type:

```actionscript check
var users = ['ann', 'bob']
if (var user = users.find((u) => u.startsWith('b'))) {
  trace(user.toUpperCase())              // a String, not String?
} else {
  trace('not found')
}
```

```text output
BOB
```

The type can be written (`if (var user:String = …)`). `while (var line = next())` repeats until the
value is `null`, which makes it the natural loop over a queue or a reader:

```actionscript check
var queue = ['a', 'b', 'c']
while (var item = queue.shift()) {
  trace(item)
}
```

```text output
a
b
c
```

## Loops

```actionscript check
var i = 0
while (i < 3) i++

do {
  i--
} while (i > 0)

for (var n:Int = 0; n < 3; n++) {
  trace(n)
}

for (var name of ['Ann', 'Bob']) trace(name)
for (var key in { a: 1, b: 2 }) trace(key)
```

```text output
0
1
2
Ann
Bob
a
b
```

- **`for … of`** iterates the values of anything iterable: arrays, strings, `Map`, `Set`, iterators,
  and your own classes that implement `Iterable<T>` (see
  [chapter 6](06-interfaces-and-generics.md#iteration-protocols)). The loop variable's type comes
  from the iterable; it can be written, and it can be a destructuring pattern
  (`for (var [key, value] of map)`).
- **`for … in`** iterates the keys of an object, as `String`s.
- **`break`** leaves the innermost loop or `switch`, **`continue`** goes to the next iteration.
  Labels (`outer: for …`) aren't supported; move the loops into a function and `return` instead.

### Ranges

A range counts integers upward, and is the usual way to write a counting loop:

```actionscript check
for (var n of 0..4) trace(n)             // 0 to 3: the end is excluded
for (var n of 1..=3) trace(n * 10)       // 10 to 30: `..=` includes the end
for (var n of 0..10 step 4) trace(n)     // 0, 4, 8
```

```text output
0
1
2
3
10
20
30
0
4
8
```

- `a..b` excludes `b`, `a..=b` includes it. If `b` is less than or equal to `a`, the loop doesn't
  run (ranges never count down; iterate `0..n` and use `n - 1 - i` for that).
- `step` must be a positive constant. With a `Float` step or bounds, the loop variable is a `Float`:
  `for (var x of 0..=1 step 0.25)`.
- The bounds are evaluated once, before the first iteration.
- `a..` has no end: leave it with `break` or `return`.
- The loop variable of a range can't be assigned (X0332); use a C-style `for` to control the
  counter yourself.

Ranges compile to plain counting `for` loops. They also work in array comprehensions
(`[for (i of 0..5) i * i]`, see [chapter 2](02-values-and-syntax.md#array-comprehensions)); they
aren't values that can be stored in a variable.

## `switch`

```actionscript check
var word = 'b'
switch (word) {
  case 'a':
    trace('A')
    break
  case 'b':
  case 'c':
    trace('B or C')
    break
  default:
    trace('something else')
}
```

```text output
B or C
```

Cases are compared with `==` (strict, see [chapter 2](02-values-and-syntax.md#operators)). As in
JavaScript, execution falls through to the next case unless `break` (or `return`, `throw`,
`continue`) leaves the `switch`; that is how several cases share code. On an enum, the compiler
warns when a value isn't handled and there's no `default`:

```actionscript check
enum Light { Red, Yellow, Green }

public class Main {
  public function Main() {
    var light = Light.Green
    switch (light) {                       // warning X0814: `Light.Yellow` isn't handled
      case Light.Red: trace('stop'); break
      case Light.Green: trace('go'); break
    }
  }
}
```

## Functions

Functions are methods of classes (see [chapter 5](05-classes-and-objects.md)); a file can't declare
functions outside a class (X0029). A method's body is a block, or one expression after `=>`:

```actionscript check
public class Main {
  public function Main() {
    trace(Main.add(2, 3), Main.twice(4))
    trace(Main.greet('Ann'), Main.greet('Bob', '!'))
    trace(Main.sum(), Main.sum(1, 2, 3))
  }

  public static function add(a:Int, b:Int):Int {
    return a + b
  }

  public static function twice(n:Int):Int => add(n, n)

  // A default value makes a parameter optional.
  public static function greet(name:String, mark:String = '.'):String => 'Hi ' + name + mark

  // A rest parameter collects the remaining arguments into an array.
  public static function sum(...values:Array<Int>):Int => values.reduce((a, b) => a + b, 0)
}
```

```text output
5 8
Hi Ann. Hi Bob!
0 6
```

- Parameters and the return type are written after `:`. A method that returns nothing has the
  return type `Void`.
- Defaults can be any expression and are evaluated at each call. Parameters with defaults come
  after those without (X0210); a rest parameter comes last.
- Calls are checked: the number of arguments, each argument's type, and that a non-`Void` result is
  returned on every path (X0314).
- Overloads (several signatures for one name) exist only for native declarations of JavaScript APIs
  (see [chapter 9](09-packages-and-javascript.md#native-declarations)). In XenonScript code, use
  default parameters, a union type or differently named methods.

### Local functions

Inside a method, `function name(…) { … }` declares a local function. Local functions are hoisted
within their block, so they can be called before the line that declares them, and they can be
generic:

```actionscript check
trace(square(4), first(['x', 'y']))

function square(n:Int):Int {
  return n * n
}

function first<T>(items:Array<T>):T? {
  return items.at(0)
}
```

```text output
16 x
```

Local function declarations take a block body.

### Function values: arrows and function expressions

Functions are values. An *arrow* creates one inline; its parameter types can be left out when the
context says them:

```actionscript check
var double:(Int) -> Int = (n) => n * 2
var shout = (s:String):String => s.toUpperCase() + '!'
var log = () => {
  trace('several')
  trace('statements')
}
trace(double(21), shout('hey'))
log()
var lengths = ['a', 'bcd'].map((s) => s.length)    // `s` is a String: the array says so
trace(lengths)
```

```text output
42 HEY!
several
statements
[ 1, 3 ]
```

Arrows keep the `this` of the code around them. A `function` expression (`function(x:Int):Int
{ … }`) has a dynamic `this`, decided by how it's called, as in JavaScript; it is mainly useful for
JavaScript APIs that pass `this` to their callbacks. Inside one, members of the enclosing class are
still reachable by their plain names.

### Read-only parameters

Two independent words protect a parameter:

- `final` before the name: the parameter can't be assigned a new value inside the function (X0501).
  The object it holds can still change.
- `const` before the type: the object can't be changed through the parameter (X0904, X0905; see
  [read-only views](05-classes-and-objects.md#read-only-views-const-t)). The parameter itself can
  still be reassigned.

```actionscript check
class Cart { public var total:Int = 0 }
class Rule {}

public class Main {
  public function Main() {}

  public static function apply(final cart:Cart, rules:const Array<Rule>):Void {
    cart = new Cart()       // error X0501: `cart` is final
    cart.total = 0          // ok: the Cart itself may change
    rules.push(new Rule())  // error X0905: `rules` is a read-only view
  }
}
```

Both together (`final cart:const Cart`) make the parameter fully read-only. Callers are not
affected: a plain `Cart` can be passed to a `const Cart` parameter. On `Int`, `String` and other
values that can't change, only `final` has an effect.

## Closures and method values

A function value can use the locals around it; it sees their current values when it runs:

```actionscript check
var count = 0
var next = () => {
  count++
  return count
}
next()
next()
trace(count, next())
```

```text output
2 3
```

A method used without calling it is a value too, and it stays bound to its object, unlike in
JavaScript, where `obj.method` loses `this`:

```actionscript check
class Counter {
  public var count:Int = 0
  public function bump():Void { count++ }
}

public class Main {
  public function Main() {
    var c = new Counter()
    var bump = c.bump              // bound to `c`
    bump()
    [1, 2, 3].forEach((n) => bump())
    trace(c.count, c.bump == c.bump)
  }
}
```

```text output
4 true
```

The bound function is created once per object and method and cached, so the same method of the
same object is always the same function, as the last line shows. That makes
`removeEventListener(c.bump)` work as expected.

## Unbound property references

`Type::member` creates a typed function without capturing an instance:

```actionscript check
class User {
  public var name:String
  public function User(name:String) { this.name = name }
  public function rename(to:String):Bool {
    name = to
    return true
  }
}

public class Main {
  public function Main() {
    var users = [new User('Bob'), new User('Ann')]
    var readName:PropertyReference<User, String> = User::name
    var rename:(User, String) -> Bool = User::rename

    trace(users.map(User::name))
    rename(users[0], 'Rob')
    trace(readName(users[0]))
  }
}
```

```text output
[ "Bob", "Ann" ]
Rob
```

Fields and getters become reader functions whose first parameter is the receiver. Methods become
receiver-first functions followed by the method's parameters. Calls still dispatch virtually through
the supplied value, so an override runs normally. The reference is checked for visibility and member
existence. Static members do not have an instance receiver and therefore cannot use `::`.

A reference carries its owner type, which an arrow's untyped parameter doesn't. That matters for
generic functions whose type parameters only a callback's parameter could decide:

```actionscript
public static function by<T, K>(key:PropertyReference<T, K>):(a:T, b:T) -> Int { … }

dogs.sort(by(Dog::name))        // T = Dog, K = String
dogs.sort(by(Animal::name))     // also fine: `PropertyReference<in Owner, out Value>`
var lost = by(d => d.name)      // warning X0883: `d` has no type, so T is `*`
```

Annotate the arrow's parameter (`(d:Dog) => d.name`), give the result an expected type, or use a
property reference. Callbacks whose parameter types come from elsewhere (`dogs.map(d => d.name)`,
where `T` is the array's) are not affected.

Use `nameof` when an API needs the checked JavaScript property name rather than a reader:
`nameof(User::name)` is `'name'` (see [chapter 8](08-compile-time-programming.md#nameof)).

## `defer`

`defer` registers a statement to run when its enclosing block ends, however it ends:

```actionscript check
public class Main {
  public function Main() {
    Main.process(true)
    Main.process(false)
  }

  public static function process(ready:Bool):Void {
    defer trace('finished')
    defer trace('released')
    if (!ready) {
      trace('not ready')
      return
    }
    trace('working')
  }
}
```

```text output
working
released
finished
not ready
released
finished
```

- Deferred statements run last-in, first-out, so cleanup happens in the reverse order of setup.
- They run on every way out of the block: its end, `return`, `throw`, and `break`/`continue`
  leaving it. A `defer` registered later in the block than the exit doesn't run.
- A `defer` inside a loop body runs at the end of each iteration.
- Use a block when the deferred action needs several statements: `defer { … }`.
- `return` and jumps out of a deferred body are errors, and a `defer` as the last statement of its
  block warns, because it would run immediately.

`defer` compiles to `try … finally`. For objects that clean up after themselves, see scoped
destructors and `using` in [chapter 7](07-async-errors-and-resources.md).

## Exercises

1. Print the first 10 square numbers with a range, then only the odd ones with `continue`.
2. Write `function clamp(n:Float, low:Float = 0, high:Float = 1):Float` and call it with one, two
   and three arguments.
3. Read lines from an array with `while (var line = lines.shift())` and stop at an empty line.
4. Collect `[for (u of users) u.name]` and `users.map(User::name)`; check that both are
   `Array<String>`.
5. Use two `defer`s to print "open" / "close" around some work, and return early from the middle.

See [`examples/control`](../examples/control), [`examples/functions`](../examples/functions), and
[`examples/closures`](../examples/closures).
