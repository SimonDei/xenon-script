# Chapter 10: The standard library

The standard library is JavaScript's own: strings, arrays, `Map`, `Date`, `JSON`, `fetch`, the DOM.
XenonScript doesn't replace any of it. It *declares* it, in XenonScript, under
[`src/prelude/std/`](../src/prelude/std), so every call is type-checked while the JavaScript
built-ins do the work at runtime. A conformance test checks every declaration against the real
runtime (Bun, and happy-dom for the DOM).

This chapter tours the most used parts. The declarations themselves are readable XenonScript with
doc comments: in the editor, "go to definition" on `push` or `fetch` opens them.

A few rules hold throughout:

- **Counts and positions are `Int`**: `length`, `indexOf`, `charCodeAt`, `getMonth`.
- **"Maybe nothing" is nullable**: `Map.get` gives `V?`, `Array.find` and `pop` give `T?`,
  `String.match` gives `Array<String>?`. The null checks of
  [chapter 3](03-types-and-null-safety.md#getting-a-non-null-value) apply.
- **Callbacks are typed** from the receiver: in `names.map((n) => …)`, `n` is a `String`.
- **Overloads instead of fake defaults**: where JavaScript behaves differently depending on which
  arguments are given (`Date`'s setters, `lastIndexOf`), each form is declared separately.

## Strings

```actionscript check
var text = '  XenonScript  '.trim()
trace(text.length, text.startsWith('Xenon'), text.indexOf('Script'), text.toLowerCase())
trace(text.slice(0, 5), text.split('S'), text.replace(~/Script$/, ' rocks'), text.padStart(13, '*'))
trace('a,b,,c'.split(',').filter((s) => s != '').join('+'), 'ab'.repeat(3), 'é'.normalize('NFD').length)
var m = 'order 66, item 7'.match(~/\d+/g)
trace(m ?? [], 'x'.codePointAt(0) ?? 0, 'abc'.at(-1) ?? '')
```

```text output
11 true 5 xenonscript
Xenon [ "Xenon", "cript" ] Xenon rocks **XenonScript
a+b+c ababab 2
[ "66", "7" ] 120 c
```

`text[i]` is checked like an array index (an out-of-range index throws); `charAt`, `at` and
`codePointAt` are the forms that tolerate a missing position. A `RegExp` (written `~/…/flags`) has
`test`, `exec` (giving `Array<String>?`), and the flag properties; match extras such as `index` and
`groups` are reachable through `(m as *)`.

## Arrays

```actionscript check
var names = ['Cy', 'ann', 'Bob']
names.push('Di')
var sorted = names.toSorted((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
trace(sorted, names.length, names.includes('Bob'), names.indexOf('Di'))
trace(names.map((n) => n.length), names.filter((n) => n.length > 2), names.find((n) => n.startsWith('B')) ?? '-')
trace(names.reduce((acc, n) => acc + n.length, 0), names.some((n) => n == 'Cy'), names.every((n) => n.length > 1))
var nested = [[1, 2], [3]]
trace(nested.flat().length, [3, 1, 2].toSorted((a, b) => a - b), names.slice(1, 3), names.with(0, 'Zed')[0])
```

```text output
[ "ann", "Bob", "Cy", "Di" ] 4 true 3
[ 2, 3, 3, 2 ] [ "ann", "Bob" ] Bob
10 true true
3 [ 1, 2, 3 ] [ "ann", "Bob" ] Zed
```

- **Changing** members: `push`, `pop`, `shift`, `unshift`, `splice`, `sort`, `reverse`, `fill`,
  index assignment and `length = n`.
- **Copying** members, which leave the array alone: `slice`, `concat`, `toSorted`, `toReversed`,
  `toSpliced`, `with`, `map`, `filter`, `flat`, `flatMap`.
- **Searching**: `indexOf`, `lastIndexOf`, `includes`, `find`, `findIndex`, `findLast`,
  `findLastIndex`, `some`, `every`, `at`.
- `sort()` without a comparator sorts as strings, as in JavaScript; pass `(a, b) => a - b` for
  numbers.
- `Array.from(iterable)`, `Array.from(iterable, mapper)` and `Array.of(…)` create arrays;
  `Array.isArray(x)` tests.
- `keys()`, `values()` and `entries()` give iterators; `entries()` gives `Tuple<Int, T>`s.

A `const Array<T>` allows only the copying and searching members (see
[read-only views](05-classes-and-objects.md#arrays-and-the-standard-library)).

## `Map` and `Set`

```actionscript check
var scores = new Map<String, Int>()
scores.set('ann', 8).set('bob', 5)
trace(scores.size, scores.get('ann') ?? 0, scores.get('zed') ?? 0, scores.has('bob'))
for (var [name, score] of scores) trace(name, score)
var byLength = Map.groupBy(['a', 'bb', 'cc'], (s) => s.length)
trace(byLength.get(2) ?? [])

var tags = new Set(['xenon', 'typed', 'xenon'])
var more = new Set(['typed', 'fast'])
trace(tags.size, tags.has('typed'), [...tags.union(more)], [...tags.intersection(more)])
```

```text output
2 8 0 true
ann 8
bob 5
[ "bb", "cc" ]
2 true [ "xenon", "typed", "fast" ] [ "typed" ]
```

`Map.get` gives `V?`: for a `Map<String, Int>`, a missing key is `null`, not `0`. A map's keys are
compared by identity (objects) or value (strings, numbers), as in JavaScript; they don't use
`equals` or `operator==`. `Set` has the ES2025 algebra: `union`, `intersection`, `difference`,
`symmetricDifference`, `isSubsetOf`, `isSupersetOf`, `isDisjointFrom`.

## Iterators

`values()`, `keys()` and `entries()` give an `Iterator<T>`, which `for … of` consumes and which has
lazy helpers:

```actionscript check
var squares = [1, 2, 3, 4, 5].values()
  .filter((n) => n % 2 == 1)
  .map((n) => n * n)
  .toArray()
trace(squares)
```

```text output
[ 1, 9, 25 ]
```

`map`, `filter`, `take`, `drop` and `flatMap` are lazy; `toArray`, `forEach`, `reduce`, `some`,
`every` and `find` consume the iterator. `Iterator.from(…)` wraps an iterable.

## Numbers and `Math`

```actionscript check
var price = 1234.5678
trace(price.toFixed(2), Math.round(price), Math.floor(-1.5), Math.max(3, 9, 4), Math.sqrt(16))
trace(Float.parseFloat('3.5kg'), Float.isNaN(0 / 0), (255).toString(16), Int.MAX_VALUE, Float.isInteger(4.0))
```

```text output
1234.57 1235 -2 9 4
3.5 true ff 2147483647 true
```

Every `Math` function gives a `Float`, including `floor`, `round` and `ceil`; convert with `Int(…)`
when an integer is needed. `Int.MAX_VALUE`/`MIN_VALUE` (and those of `UInt`, `Short`, `Byte`) are
compile-time constants. The `Number` global is called `Float` in XenonScript.

## Dates

```actionscript check
var d = new Date(Date.UTC(2024, 1, 29, 12, 30))     // months count from 0: 1 is February
trace(d.toISOString(), d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDay())
var later = new Date(d.getTime() + 24 * 60 * 60 * 1000)
trace(later.toISOString().slice(0, 10), later.getTime() - d.getTime())
```

```text output
2024-02-29T12:30:00.000Z 2024 1 4
2024-03-01 86400000
```

The getters give `Int`s, time values (`getTime`, `Date.now`, `Date.UTC`) `Float`s. Dates are
compared through `getTime()`. Without `UTC` in the name, getters and setters use the local time
zone. An invalid date (`new Date('nonsense')`) makes the getters return `NaN`, as in JavaScript.

## JSON

```actionscript check
typedef Settings = { theme:String, ?size:Int }

public class Main {
  public function Main() {
    var text = JSON.stringify({ theme: 'dark', size: 12 })
    var raw:* = JSON.parse(text)                 // untyped
    var settings = JSON.parse(text) as Settings  // unchecked cast to a shape you trust
    trace(text, raw.theme, settings.size ?? 10)
    trace(JSON.stringify(['a', 1], null, 0))
  }
}
```

```text output
{"theme":"dark","size":12} dark 12
["a",1]
```

`JSON.parse` returns `*`. Cast it to a typedef shape with `as` when you know the structure (nothing
is checked at runtime), or check its fields one by one when the data comes from outside.
`JSON.stringify` takes an optional replacer (a function or a list of keys) and indentation.

## `Object`

```actionscript check
var ages:Record<String, Int> = { ann: 31, bob: 27 }
trace(Object.keys(ages), Object.values(ages), Object.entries(ages).length)
var frozen = Object.freeze({ x: 1 })
trace(Object.isFrozen(frozen), Object.hasOwn(ages, 'ann'))
```

```text output
[ "ann", "bob" ] [ 31, 27 ] 2
true true
```

`Object.values` and `Object.entries` keep the value type of records and shapes; `Object.freeze`
returns its argument's type. Every object, including instances of your classes, has `toString`,
`valueOf`, `hasOwnProperty` and the other members of `Object.prototype`.

## Promises and timers

```actionscript check
public class Main {
  public function Main() {
    void Main.run()
  }

  public static function delay(ms:Int):Promise<Void> {
    return new Promise((resolve, reject) => { setTimeout(() => resolve(), ms) })
  }

  public static async function run():Promise<Void> {
    var failing:Promise<Int> = Promise.reject(new Exception('no'))
    var results = await Promise.allSettled([Promise.resolve(1), failing])
    trace(results.map((r) => r.status))
    var fastest = await Promise.race([Main.delay(20).then((v) => 'slow'), Main.delay(1).then((v) => 'fast')])
    trace(fastest)
    var id = setInterval(() => trace('tick'), 1000)
    clearInterval(id)
    queueMicrotask(() => trace('microtask'))
    await Main.delay(0)
  }
}
```

```text output
[ "fulfilled", "rejected" ]
fast
microtask
```

`Promise<T>` has the constructor, `then` (with and without a rejection handler), `catch`,
`finally`, and the statics `resolve`, `reject`, `all`, `allSettled`, `race`, `any` and
`withResolvers`. Timers (`setTimeout`, `setInterval`, their `clear…` functions) take `Float`
delays. See [chapter 7](07-async-errors-and-resources.md#async-functions) for `async`/`await`.

## Fetch, files and binary data

```actionscript
public static async function load(url:String):Promise<Array<String>> {
  var response = await fetch(url, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Exception($'HTTP {response.status}')
  var data:* = await response.json()
  return data.names as Array<String>
}
```

- `fetch(url, init)` gives a `Promise<Response>`; `RequestInit` is a typed shape (`method`,
  `headers`, `body`, …). `Response` has `ok`, `status`, `headers`, `json()`, `text()`, `blob()` and
  `arrayBuffer()`.
- `Blob` (`size`, `type`, `slice`, `text()`, `arrayBuffer()`), `File` (a `Blob` with `name` and
  `lastModified`), `FormData` and `ArrayBuffer` are declared.

## URLs

```actionscript check
var url = new URL('api/mail?page=1', 'https://example.org/app/')
url.searchParams.set('page', '2')
trace(url.href, url.hostname, url.searchParams.get('page') ?? '')
var query = new URLSearchParams({ q: 'xenon', tag: 'a' })
for (var [name, value] of query) trace(name, value)
trace(URL.canParse('not a url'))
```

```text output
https://example.org/app/api/mail?page=2 example.org 2
q xenon
tag a
false
```

`URL`'s parts are writable fields (`origin` and `searchParams` are read-only). `URL.canParse` and
`URL.parse` (which gives `URL?`) avoid the exception the constructor throws on bad input.
`URLSearchParams` takes a query string, a `Record<String, String>` or `[name, value]` pairs.

## Events

`EventTarget` is a class you can create and extend, with typed `addEventListener`,
`removeEventListener` and `dispatchEvent`:

```actionscript check
typedef Saved = { id:Int, title:String }

class Store extends EventTarget {
  public function save(id:Int):Void {
    dispatchEvent(new CustomEvent<Saved>('saved', { detail: { id: id, title: 'Draft' } }))
  }
}

public class Main {
  public function Main() {
    var store = new Store()
    store.addEventListener('saved', (e:CustomEvent<Saved>) => trace('saved', e.detail.id, e.detail.title))
    store.save(7)
  }
}
```

```text output
saved 7 Draft
```

`Event<T = EventTarget>`: a bare `Event` is `Event<EventTarget>`. `T` states what you expect the
target to be (the checker can't know which element a listener was added to), so a listener on an
input writes `(e:Event<HTMLInputElement>) => …` and gets `e.target` as an `HTMLInputElement?`.
`target` and `currentTarget` are nullable, because they are `null` before and after dispatch, and on
an event you create yourself. An untyped listener `e => …` gets an `Event<*>`, whose `target` is
dynamic. `CustomEvent<D>` carries data of your own in `detail`, typed from dispatch to listener.

`Event` also has the phases, `preventDefault`/`defaultPrevented`, `stopPropagation`,
`stopImmediatePropagation` and `composedPath`.

## The DOM

The browser DOM is declared too, in [`std/dom`](../src/prelude/std/dom):

```actionscript
var doc:Document = new DOMParser().parseFromString(xml, 'application/xml')
if (var root:Element = doc.documentElement) {
  root.setAttribute('source', 'xenon')
  for (var item of root.querySelectorAll('item')) trace(item.textContent)
}
var text = new XMLSerializer().serializeToString(doc)
```

Declared:

- `Node` and its constants; `Element`, `HTMLElement`, `HTMLInputElement`, `HTMLSelectElement`,
  `HTMLOptionElement`, `HTMLTemplateElement`; `Text`, `Attr`, `CharacterData`;
  `Document`, `DocumentFragment`
- `NodeList<T>`, `HTMLCollection`, `NamedNodeMap`, `DOMTokenList` (`classList`), `TreeWalker`
- `DOMParser`, `XMLSerializer`, `FileReader`, `FileList`
- `CSSStyleProperties` (`element.style`)

Some details:

- `HTMLElement.dataset` is a `DOMStringMap`, a `Record<String, String>`: `el.dataset.userId` reads a
  `String?` and writing sets the `data-user-id` attribute.
- `HTMLInputElement` covers `value`, `checked`, `files` (a `FileList?`), the constraint properties
  (`min`, `max`, `required`, `validity`, …) and the selection methods.
- `querySelector` gives `Element?`; check it or use `if (var el = …)`.
- The DOM's names (`Node`, `Element`, …) aren't reserved: a program's own `Node` class shadows the
  DOM's.
- The DOM exists only in browsers. Type checking works everywhere, but running DOM code in Bun or
  Node needs a DOM implementation such as happy-dom.

```actionscript
function chosen(input:HTMLInputElement):Array<File> {
  if (var files:FileList = input.files) {
    return Array.from(files)
  }
  return []
}
```

## Other globals

- `console`: `log`, `info`, `warn`, `error`, `debug`, `table`, `time`/`timeEnd`, …
- `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval`, `queueMicrotask`
- `structuredClone<T>(value)`: a deep copy, typed like its argument
- `encodeURIComponent`, `decodeURIComponent`, `encodeURI`, `decodeURI`, `atob`, `btoa`
- `Symbol`: `Symbol('description')`, `Symbol.for`/`Symbol.keyFor`, and the well-known symbols such as
  `Symbol.iterator`

JavaScript globals without declarations remain untyped (`*`) until the standard library adds them.

## Exercises

1. Count the words of a text with a `Map<String, Int>` and print the three most frequent.
2. Parse a JSON array of `{ name, age }` objects into a typed array and sort it by age.
3. Write `async function timeout<T>(p:Promise<T>, ms:Int):Promise<T>` with `Promise.race`.
4. Build a URL with three query parameters from a `Record<String, String>`.

See [`examples/std`](../examples/std) and
[`tests/dom.test.ts`](../tests/dom.test.ts).
