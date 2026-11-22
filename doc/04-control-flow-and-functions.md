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
