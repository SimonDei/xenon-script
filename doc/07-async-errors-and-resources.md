# Chapter 7: Asynchrony, errors, and resources

Three things can interrupt the straight path through a method: waiting (asynchronous code),
failing (exceptions), and owning something that must be released (resources). XenonScript builds
on JavaScript's promises and exceptions, adds typed catches and checks for forgotten promises, and
offers scoped destructors for automatic cleanup.

## Async functions

An `async` function returns a `Promise<T>` and can `await` other promises inside:

```actionscript check
public class Main {
  public function Main() {
    void Main.load()
  }

  public static async function wait(ms:Int):Promise<Int> {
    await new Promise<Void>((resolve, reject) => { setTimeout(() => resolve(), ms) })
    return ms
  }

  public static async function load():Promise<Void> {
    var first = await wait(5)                         // an Int
    var both = await Promise.all([wait(1), wait(2)])  // Array<Int>
    trace('loaded', first, both)
  }
}
```

```text output
loaded 5 [ 1, 2 ]
```

- An async function declares `Promise<T>` and returns a `T` (or `Promise<Void>` and returns
  nothing). `await p` on a `Promise<T>` gives a `T`.
- `await` is only allowed in async functions, methods and arrows (`async (x) => …`).
- `new Promise<T>((resolve, reject) => …)` wraps callback APIs; `Promise.resolve`, `Promise.all`,
  `Promise.allSettled`, `Promise.race`, `Promise.any`, `then`, `catch` and `finally` are all typed
  (see [chapter 10](10-standard-library.md#promises-and-timers)).
- Constructors can't be async. To start async work from one, call an async method and mark the
  promise as intentionally not awaited (below).

### Forgotten promises

Calling an async function without `await` starts it, but nothing waits for it, and an exception
inside it goes unnoticed. The compiler warns about a promise that is neither awaited nor kept:

```actionscript check
public class Main {
  public function Main() {
    Main.save()                  // warning X0874: neither awaited nor kept
    void Main.save()             // fine: deliberately not awaited
    var pending = Main.save()    // fine: kept, to await later
  }

  public static async function save():Promise<Void> {}
}
```

The warning offers the fixes: `await` it (in async code), keep it in a variable, or prefix it with
`void` to say "start it, don't wait".

## Exceptions

`throw` raises an exception; `try`/`catch`/`finally` handles it:

```actionscript check
class NotFound extends Exception {
  public final id:Int
  public function NotFound(id:Int) {
    super('no item ' + id)
    this.id = id
  }
}

public class Main {
  public function Main() {
    try {
      Main.find(7)
    } catch (e:NotFound) {
      trace('missing', e.id)
    } catch (e:Exception) {
      trace('failed:', e.message)
    } finally {
      trace('done')
    }
  }

  public static function find(id:Int):String {
    throw new NotFound(id)
  }
}
```

```text output
missing 7
done
```

- Only `Exception`s (the class or a subclass) can be thrown (X0750; the fix wraps a message in
  `new Exception(…)`).
- The prelude declares `Exception`, `ArgumentException`, `TypeException`, `RangeException`,
  `StateException` and `NotImplementedException`. Your own exceptions extend one of them; they get
  `message`, `name` (the class name), `cause` and a source-mapped `stack`.
- `catch (e:NotFound)` catches that class and its subclasses. Clauses are tried in order, and a
  clause that can never be reached, because an earlier one catches everything it would, is an error
  (X0753). `catch (e)` without a type catches everything, as an `Exception`.
- `finally` runs however the `try` ends: normally, by `return`, or by an exception.

### Errors from JavaScript

JavaScript code can throw anything: `Error`s of various kinds, strings, numbers. XenonScript
converts what it catches into an `Exception` (`Exception.from`), so a `catch` always gets one:

```actionscript check
try {
  JSON.parse('{oops')
} catch (e:Exception) {
  trace(e.name, e.cause is Exception)
}
```

```text output
Exception false
```

A JavaScript `TypeError` becomes a `TypeException` and a `RangeError` a `RangeException`; other
errors become an `Exception` whose `cause` is the original error (here the `SyntaxError`), and a
thrown non-error value becomes an `Exception` that says what was thrown. A rethrown exception
keeps its identity, so JavaScript code further up sees the original error.

## Scoped destructors

Some objects own something outside the program's memory: a file, a lock, a connection, a timer. A
**destructor** releases it, and XenonScript runs it automatically when the owner's scope ends:

```actionscript check
class Handle {
  public final name:String
  public function Handle(name:String) {
    this.name = name
    trace('open', name)
  }
  public function ~Handle() {
    trace('close', name)
  }
}

public class Main {
  public function Main() {
    Main.work()
    var kept = Main.make('report')         // `make` hands its handle over
    trace('using', kept.name)
  }                                        // `kept` is closed here

  public static function work():Void {
    var a = new Handle('a')
    var b = new Handle('b')
    trace('working')
  }                                        // b, then a: last opened, first closed

  public static function make(name:String):Handle {
    var h = new Handle(name)
    return h                               // not closed: the caller owns it now
  }
}
```

```text output
open a
open b
working
close b
close a
open report
using report
close report
```

A class with a destructor (`function ~Name() { … }`) is **scoped**: each instance is owned by the
scope that created it and destroyed when that scope ends, on every way out: the end of the block,
`return`, `throw`, `break`, `continue`. In a loop, each iteration's values are destroyed at the end
of the iteration; a temporary (`new Handle('x').touch()`) is destroyed at the end of its statement.
Destruction runs in reverse order of creation, and a subclass's destructor runs before its parent's.

Ownership can move only one way: a function can **return** a scoped value it owns, and the caller
becomes the owner. Everything that would let the value outlive its owner is an error:

```actionscript check
class Handle {
  public function ~Handle() {}
}

public class Main {
  private var kept:Handle? = null              // error X0822: a field can't hold a scoped value

  public function Main() {
    var h = new Handle()
    var later = () => Main.use(h)              // error X0823: a closure could run too late
    var list = [h]                             // error X0822: an array could outlive it
    Main.use(h)                                // fine: `use` borrows it for the call
  }

  public static function use(h:Handle):Void {}
}
```

Passing a scoped value as an argument *lends* it for the duration of the call; the callee can use
it but can't keep it. An untyped parameter (`*`) could keep it without the compiler knowing, so a
scoped value can't be passed to one (X0824); that includes `trace`. Print one of its fields instead.

### Async destructors and errors

An `async function ~Name()` destructor is awaited when its owner's scope ends, so its values can
only be owned in async code. If a destructor throws while the scope is already leaving because of
an exception, neither error is lost: they are combined in a `SuppressedError`, as JavaScript's
`using` does.

## Manual disposal: `IDisposable` and `using`

When an object's lifetime doesn't follow a scope (it is stored in a field, shared, closed by a
user's action), implement `IDisposable` instead of a destructor, and call `dispose()` yourself, or
let `using` call it at the end of a block:

```actionscript check
class Socket implements IDisposable {
  private final name:String
  private var closed:Bool = false
  public function Socket(name:String) { this.name = name }
  public function dispose():Void {
    if (closed) return
    closed = true
    trace('closed', name)
  }
}

public class Main {
  public function Main() {
    using (a = new Socket('a'), b = new Socket('b')) {
      trace('in block')
    }                                       // b, then a
    var early = new Socket('early')
    using (early) trace('expression form')
    early.dispose()                         // already closed: dispose() makes this a no-op
  }
}
```

```text output
in block
closed b
closed a
expression form
closed early
```

`using` also works as a declaration (`using conn = open()`), disposing at the end of the enclosing
block. `IAsyncDisposable` (`dispose():Promise<Void>`) is the async version, awaited by `using` in
async code. A class can't have both a destructor and `IDisposable` (X0808), and `using` on a
scoped value is an error, since it is destroyed anyway (X0827).

## Choosing a cleanup mechanism

| Mechanism | Use it for |
|---|---|
| `defer` ([chapter 4](04-control-flow-and-functions.md#defer)) | one-off cleanup code at the end of a block: restoring state, logging |
| scoped destructor | a class whose instances always belong to one scope: locks, temporary files, transactions |
| `IDisposable` + `using` | objects that may be kept, shared or closed early: connections, sockets, subscriptions |
| `try`/`finally` | cleanup that depends on how the block ended |

All of them unwind in reverse order of registration, and they combine: a `defer` registered after
a scoped value runs before that value's destructor.

## Exercises

1. Write `async function retry<T>(attempt:() -> Promise<T>, times:Int):Promise<T>` that catches
   failures and tries again.
2. Define `ValidationException` with a `field` property, throw it from a parser, and catch it
   separately from other exceptions.
3. Write a scoped `Timer` that prints how long its scope took, and use it in a loop.
4. Turn the `Timer` into an `IDisposable`, keep it in a field, and dispose of it explicitly.

See [`examples/exceptions`](../examples/exceptions) and
[`examples/destructors`](../examples/destructors).
