# Chapter 10: The standard library

The standard library is declared in XenonScript under `src/prelude/std/`. These declarations provide
types to the checker while normal JavaScript runtime objects remain the implementation.

## Primitive and collection types

### Numbers and Bool

```actionscript
var i:Int = 42
var u:UInt = 4
var f:Float = 3.5
var ok:Bool = true
```

`Int`/`UInt` and aliases use integer wrapping. `Float` exposes Number methods, parsing, precision
formatting, and static constants. `Bool` exposes Bool behavior.

### Strings and regular expressions

```actionscript
var text:String = '  XenonScript  '.trim()
text.startsWith('Xenon')
text.replace(~/Script$/, 'language')
```

String operations are typed, positions/counts use `Int`, and methods that may fail return nullable
values where appropriate.

```actionscript
var ch:Int? = text.codePointAt(10)
var matched:Array<String>? = text.match(~/\w+/g)
```

`RegExp.exec` exposes the standard match and extras required by JavaScript. Match-specific dynamic
extras remain reachable through `(match as *)`.

### Arrays

```actionscript
var names:Array<String> = ['Ann', 'Bob']
names.push('Cy')

var upper:Array<String> = names.map((name:String):String => name.toUpperCase())
```

Arrays support mutation, copying, sorting, searching, `with`, `toSorted`, `flat`, typed callbacks,
and fixed `length` assignments where the JavaScript API permits them. The modern copy methods and
async `from` forms included by the runtime are declared where type-safe.

### Maps and sets

```actionscript
var scores:Map<String, Int> = new Map()
scores.set('Ann', 8)

var found:Int? = scores.get('Ann')
```

`Map.get` is nullable. Check `has` before assuming a primitive result exists.

```actionscript
var tags:Set<String> = new Set(['xenon', 'typed'])
for (var tag:String of tags) trace(tag)
```

Set algebra methods and typed `forEach` callbacks are included.

### Iterators

`Iterator<T>` exposes `next`, plus map/filter/take/drop/flatMap and terminal operations available in
the supported runtime. Iterators can be consumed by `for … of`.

## Dates and JSON

```actionscript
var now:Date = new Date()
var parsed:Date = new Date('2026-11-22')
var stamp:Int = Int(now.getTime())

var text:String = JSON.stringify({ ok: true })
var value:* = JSON.parse(text)
```

Date constructors and setters are represented as overloads rather than fake defaults. Invalid dates
can produce `NaN` getters at runtime.

## Objects and classes

`Object` supplies `keys`, `values`, `entries`, `hasOwn`, copying, freezing, and prototype operations.
Generic static methods such as `Object.freeze(value)` preserve the input type.

`Symbol` models JavaScript's primitive symbol factory: `Symbol('description')`, registry methods
`Symbol.for`/`Symbol.keyFor`, well-known protocol symbols such as `Symbol.iterator`, and primitive
members such as `description`, `toString()` and `valueOf()`.

Instance members including `toString`, `valueOf`, and property tests are available on ordinary
XenonScript classes, interfaces, shapes, natives, and Object-like values.

## Promises, web types, and binary data

The standard library includes:

- `Promise<T>` and resolver helpers
- `fetch` and `RequestInit`
- `Response`, `Blob`, `File`
- `FormData`
- `ArrayBuffer`
- `URL`-related/global operations

Use the checked nullable and generic signatures rather than an untyped dynamic value where a
declaration exists.

## Events

```actionscript
public class Store extends EventTarget {
  public function publish():Void {
    dispatchEvent(new Event('changed'))
  }
}
```

`EventTarget.addEventListener`, `removeEventListener`, and `dispatchEvent` are typed. A listener
receives an `Event`, and the type argument says what its `target` and `currentTarget` are:

```actionscript
input.addEventListener('input', (e:Event<HTMLInputElement>):Void => {
  var field:HTMLInputElement? = e.target
  if (field != null) {
    trace(field.value)
  }
})
```

`Event<T = EventTarget>`: a bare `Event` is `Event<EventTarget>`. `T` states what you expect (the
checker can't know which element the listener was added to). The two properties are `T?`, because
they are `null` before and after dispatch, and on an event you create yourself. Listeners are
declared as `(event:Event<*>) -> Void`, so a listener can take any `Event<T>`; an untyped
`e => …` has a dynamic `e.target`.

`Event` exposes phases, target/currentTarget, cancellation, propagation, and `composedPath`.

## DOM

The browser DOM subset is globally available and remains shadowable: a project may declare its own
`Node` or `Element`.

```actionscript
var doc:Document = new DOMParser().parseFromString(xml, 'application/xml')
var root:Element? = doc.documentElement

if (var element:Element = root) {
  element.setAttribute('source', 'xenon')
}
```

Declared DOM families include:

- `Node`
- `Element`, and `HTMLElement` and `HTMLInputElement` below it
- `Document`
- `NodeList<T>`
- `HTMLCollection`
- `FileList`
- `DOMParser`
- `XMLSerializer`
- `EventTarget` and `Event<T>`

`HTMLElement.dataset` is a `DOMStringMap`, a `Record<String, String>`: `el.dataset.userId` reads a
`String?` and writing sets the `data-user-id` attribute.

`HTMLInputElement` covers `value`, `checked`, `files` (a `FileList?`), the constraint properties
(`min`, `max`, `required`, `validity`, …) and the selection methods. `form`, `list` and `validity` are
loosely typed until their classes exist.

```actionscript
function chosen(input:HTMLInputElement):Array<File> {
  if (var files:FileList = input.files) {
    return Array.from(files)
  }
  return []
}
```

The DOM is browser-only. Constructing/testing the available DOM classes in a runtime without the DOM
can fail even though XenonScript type checking succeeds.

## Runtime globals

Available declarations include:

- `console`
- `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval`
- `queueMicrotask`
- `structuredClone`
- `fetch`
- URI/encoding functions
- `atob` and `btoa`
- `NaN`, `Infinity`, parsing and numeric tests through `Float`

JavaScript globals without declarations remain untyped (`*`) until the standard library adds them.

See [`examples/std`](../examples/std) and
[`tests/dom.test.ts`](../tests/dom.test.ts).
