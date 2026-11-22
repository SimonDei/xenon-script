# Chapter 7: Asynchrony, errors, and resources

## Async functions

An async function returns `Promise<T>` and can use `await`:

```actionscript
public static async function load(url:String):Promise<String> {
  var response:Response = await fetch(url)
  if (!response.ok) {
    throw new Exception($'HTTP {response.status}')
  }
  return await response.text()
}
```

Async methods, arrows, and local functions are supported. The compiler checks:

- `await` is only used in async code.
- the declared result matches `Promise<T>`.
- dropped promises produce a warning with await/keep/discard suggestions.

`Promise.all`, `Promise.any`, `then`, `catch`, and the other standard Promise APIs are typed.

## Exceptions

XenonScript throws `Exception` and its subclasses:

```actionscript
throw new ArgumentException('expected an id')
```

JavaScript values thrown across an interop boundary are normalized with `Exception.from`. The common
classes include:

- `Exception`
- `TypeException`
- `RangeException`
- `StateException`
- `ArgumentException`
- `NotImplementedException`

Use typed catches:

```actionscript
try {
  save()
} catch (e:StateException) {
  trace('state: ' + e.message)
} catch (e:Exception) {
  trace('failed: ' + e.message)
} finally {
  trace('finished')
}
```

Catch order is checked for reachability. Rethrown original JavaScript values retain their original
identity after typed dispatch.

## Scoped destructors

Declare a destructor with `function ~ClassName()`:

```actionscript
class FileHandle {
  public function FileHandle(name:String) {}

  public function ~FileHandle() {
    trace('closed')
  }
}
```

A class with a destructor is scoped. Values owned by the current scope are destroyed automatically
when the scope ends, including normal completion, `return`, `throw`, `break`, `continue`, and an
exception from deferred cleanup.

```actionscript
function use():Void {
  var file:FileHandle = new FileHandle('data.txt')
  read(file)
  return
} // destroyed here
```

Destruction is last-created first, and subclass destructors run before parent destructors.

Scoped ownership rules reject escaping values through:

- fields
- closures
- arrays, unions, object containers, and untyped locals
- `using` (which would double-dispose the value)
- borrowed returns

A function may return a scoped value it owns, transferring ownership to the caller. An async
function cannot hold a scoped value beyond the promised lifetime.

### Destructor errors

The runtime preserves both errors. If body cleanup throws while leaving because of an earlier error,
the runtime combines them in a `SuppressedError`.

An async destructor is awaited:

```actionscript
public async function ~Connection() {
  await socket.close()
}
```

Async-destructor values can only be owned in async scopes.

## Manual disposal

A non-scoped class can implement `IDisposable` or `IAsyncDisposable` and declare `using`:

```actionscript
using connection:Connection = open()

trace('work')
// dispose() is called here
```

A using block limits the lifetime:

```actionscript
using (reader:Reader = open(path)) {
  trace(reader.readLine())
}
```

Manual resources call `dispose()` through a generated forwarder. A destructor and
`IDisposable` cannot be combined on the same class.

## Cleanup order with `defer`

`defer`, scoped destruction, and `using` all unwind structurally. Registration order matters:

```actionscript
var resource:ScopedResource = open()
defer trace('after resource block body')
```

Prefer one ownership mechanism for a resource. Scoped destructors and `using` are not interchangeable:
destructors express ownership and automatic destruction; `using` represents explicit disposable
protocol use.

See [`examples/exceptions`](../examples/exceptions), [`examples/destructors`](../examples/destructors),
and [`tests/scoped.test.ts`](../tests/scoped.test.ts).
