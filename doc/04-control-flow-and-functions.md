# Chapter 4: Control flow and functions

## Conditions and binding headers

```actionscript
if (score > 0) {
  trace('positive')
} else if (score == 0) {
  trace('zero')
} else {
  trace('negative')
}
```

An inline binding checks a nullable initializer:

```actionscript
if (var user:User = users.find(id)) {
  trace(user.name)
} else {
  trace('not found')
}
```

The corresponding `while (var line:String = readLine())` form repeats until the initializer is
null.

## Loops

```actionscript
while (more()) step()

do {
  step()
} while (more())

for (var i:Int = 0; i < 10; i++) {
  trace(i)
}

for (var item:String of names) trace(item)
for (var key:String in object) trace(key)
```

`for … in` enumerates keys; `for … of` consumes `Iterable<T>` values.

### Ranges

```actionscript
for (var n:Int of 0..10) {}         // 0 through 9
for (var n:Int of 0..=10) {}        // 0 through 10
for (var n:Int of 0..100 step 5) {} // 0, 5, 10, ...
for (var n:Int of 2..) {}           // open-ended; leave with break/return
```

Ranges count upward only. A positive compile-time `step` is required. Bounds are evaluated once.

## Switch

```actionscript
switch (status) {
  case Status.Ready:
  case Status.Waiting:
    trace('not finished')
    break
  default:
    trace('finished')
}
```

Cases fall through unless `break` leaves the switch. Enum switches receive exhaustiveness warnings.

## Functions

```actionscript
public static function add(a:Int, b:Int):Int {
  return a + b
}

public static function twice(n:Int):Int => add(n, n)
```

Methods belong to classes. Function expressions and arrows can be created locally:

```actionscript
var double:(Int) -> Int = (n:Int):Int => n * 2
var legacy:Function = function(value:Int):Int { return value + 1 }
```

Arrows capture lexical `this`; ordinary `function` expressions have dynamic `this`. Local function
declarations are hoisted within their block.

Default and rest parameters, generics, overloads for native declarations, and async functions are
supported.

## Closures and method values

```actionscript
var callback:() -> Void = () => trace('called')
var action:() -> Void = user.save
```

XenonScript preserves the receiver when a method is taken as a value. The generated JavaScript
returns a stable, cached bound method, so two reads of the same method produce the same identity.

A closure may read outer locals. Outer `final`/`const` values receive special assignment rules, and
null checks crossing a closure boundary are intentionally conservative.

## Unbound property references

`Type::member` creates a typed function without capturing an instance:

```actionscript
var readName:PropertyReference<User, String> = User::name
var save:(User, String) -> Bool = User::save

var names:Array<String> = users.map(User::name)
```

Fields and getters become reader functions whose first parameter is the receiver. Methods become
receiver-first functions followed by the method's parameters. Calls still dispatch virtually through
the supplied value, so an override runs normally.

```actionscript
readName(user)
save(user, 'next value')
```

The reference is checked for visibility and member existence. Static members do not have an instance
receiver and therefore cannot use `::`.

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

```actionscript
nameof(User::name) // 'name'
```

## `defer`

`defer` registers a statement to run when its enclosing block ends:

```actionscript
function process():Void {
  defer trace('finished')
  defer releaseTemporaryState()

  trace('working')
}
```

Deferred actions run last-in, first-out:

```text
working
releaseTemporaryState()
finished
```

They also run on `return`, `throw`, or `break`/`continue` leaving that block:

```actionscript
defer stream.close()
if (!ready) return
```

Use a block when the deferred action needs declarations:

```actionscript
defer {
  var message:String = 'cleanup'
  trace(message)
}
```

`return` and jumps that leave a deferred body are errors. A `defer` written as the final statement
of its block produces a warning because it runs immediately.

See [`examples/control`](../examples/control), [`examples/functions`](../examples/functions), and
[`examples/closures`](../examples/closures).
