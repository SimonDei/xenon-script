# Chapter 9: Packages and JavaScript interoperability

A program grows into folders of files, and it uses JavaScript: npm packages, Node's and Bun's
modules, the browser, code you already have. This chapter covers how XenonScript organizes files
into packages, and how it meets JavaScript in both directions.

## Packages

A file's package is its folder below the source root: `src/shop/Cart.xn` is in package `shop`,
`src/com/example/model/User.xn` in `com.example.model`. A file in a subfolder says so with a package
block; files directly in `src/` belong to the top-level package and may leave the block out:

```actionscript check
import shop.Cart

public class Main {
  public function Main() {
    trace(new Cart().label())
  }
}
// file: shop/Cart.xn
package shop {
  public class Cart {
    public function label():String => Format.money(3)
  }
}

// File-private: only Cart.xn can use it.
class Format {
  public static function money(n:Float):String => n.toFixed(2)
}
```

```text output
3.00
```

The package must match the folder (X0020), and a subfolder file without a package block is X0010
(with a fix that adds it).

### One shared declaration per file

A file shares exactly one declaration with other files: the class, interface, enum or typedef
named after the file (`User.xn` holds `User`). In a package block it is the block's only
definition. Everything else in the file is **file-private**: declarations after the package block
or, in a root file without one, every declaration besides the one named after the file. Other
files can't see or import them, and they take no visibility modifier (X0025).

```actionscript check
typedef Options = { verbose:Bool }   // file-private: only Main.xn can use it

public class Main {
  public typedef Config = { name:String }   // shared as `Main.Config`

  public function Main() {
    var o:Options = { verbose: true }
    var c:Config = { name: 'app' }
    trace(o.verbose, c.name)
  }
}
```

To share a helper type, give it its own file (`Options.xn` with `public typedef Options = …`), or,
when it belongs to a class, declare it inside the class body. See
[typedefs inside a class](03-types-and-null-safety.md#typedefs-inside-a-class).

### Public and internal classes

A class is `public` (usable from every package) or `internal`, the default (only its own package).
An internal class is how a package keeps its implementation details:

```actionscript check
import shop.Cart
import shop.Pricing                          // error X0441: internal to package `shop`

public class Main {
  public function Main() {
    trace(new Cart().total())
  }
}
// file: shop/Cart.xn
package shop {
  public class Cart {
    public function total():Float => Pricing.withTax(10)
  }
}
// file: shop/Pricing.xn
package shop {
  class Pricing {
    public static function withTax(n:Float):Float => n * 1.2
  }
}
```

Members have their own visibility on top of that (see
[chapter 5](05-classes-and-objects.md#visibility)); `internal` members are visible in the package.

## Imports

```actionscript
import com.example.model.User          // one class (or interface, enum, typedef)
import com.example.model.*             // every public declaration of the package
import com.example.model.User.Role     // a typedef declared inside class `User`
```

- Files of the same package see each other without imports.
- An explicit import wins over a same-named class of the own package, which wins over a wildcard
  import. Two wildcard imports offering the same name make it ambiguous (X0433) until one of them is
  imported explicitly.
- Importing the same name twice from different places is an error (X0432); importing a class of
  the own package or the own package's wildcard warns that it's redundant (X0872), and an import
  that isn't used warns (X0870).
- A class can also be named in full without an import: `new com.example.model.User()`.

Imports of classes are module imports in the output: `import { User } from './com/example/model/User.js'`,
written only for what a module really uses.

### Static imports

`import static` makes a class's static members usable by their own names, as in Java:

```actionscript check
import static shop.Format.*            // every visible static member of `Format`
import static shop.Prices.VAT          // just one

public class Main {
  public function Main() {
    trace(money(100 * (1 + VAT)), calls)
  }
}
// file: shop/Format.xn
package shop {
  public class Format {
    public static var calls:Int = 0
    public static function money(n:Float):String {
      calls++
      return n.toFixed(2)
    }
  }
}
// file: shop/Prices.xn
package shop {
  public class Prices {
    public static final VAT:Float = 0.2
  }
}
```

```text output
120.00 1
```

- Inherited static members are imported too; private ones (and internal ones of other packages)
  are not. `import static a.B.member` reports a missing, non-static or hidden member (X0436, X0603).
- An imported name ranks after locals and after the class's own and inherited members, so an
  import never changes what a name already means. One exception makes builders work in
  subclasses of DOM classes: when the name is **called** and the member can't be (a `String` field,
  say), the import is used. In a custom element, `slot('name')` calls an imported `slot` function
  while `slot` alone is still the element's `slot` attribute. A member that can be called always
  wins, even if the call doesn't fit it: write `Class.member(…)` then.
- A name offered by two imports from different classes is an error where it's used (X0433), and a
  single-name import doesn't take precedence over a wildcard one.
- The output uses the class: `money(…)` compiles to `Format.money(…)`, with `Format` imported.

## Importing JavaScript

Imports with a string are JavaScript imports, in JavaScript's forms:

```actionscript check
import { readFileSync } from 'node:fs'
import * as path from 'node:path'

public class Main {
  public function Main() {
    trace(path.basename('/tmp/report.txt'), path.extname('a.json'))
    var size:Int = readFileSync('x', 'utf8')         // error X0308: it returns a String
  }
}
```

The compiler reads the TypeScript declarations of what's imported, as TypeScript finds them: the
package's own `.d.ts`, `@types/…` packages, Bun's and Node's types, and `.d.ts` files next to local
JavaScript files. The imported functions, classes and values then have Xenon types:

| TypeScript | XenonScript |
|---|---|
| `string`, `number`, `boolean` | `String`, `Float`, `Bool` |
| `T \| null`, `T \| undefined` | `T?` |
| `'a' \| 'b'`, `true` | literal types |
| `T[]`, `Array<T>`, `[A, B]` | `Array<T>`, `Tuple<A, B>` |
| `readonly T[]`, `ReadonlyArray<T>`, `ReadonlyMap`, `ReadonlySet` | `const Array<T>`, `const Map`, `const Set` |
| `Promise<T>`, `Map`, `Set`, `Date`, `RegExp` | the standard library's classes |
| function types | function types |
| classes, and interfaces with methods | native classes: `new`, `is`, extending |
| object types, interfaces without methods | typedef shapes |
| overloads | overloads, chosen as TypeScript chooses |
| anything else (generic signatures, complex unions, …) | `*` |

So `readFileSync(file, 'utf8')` is a `String` and `readFileSync(file)` a `Buffer`, a namespace
import's exported types are named `ns.Type`, and hover shows the declarations' documentation. A
package without declarations is untyped: everything it exports is `*`.

```actionscript check
import _ from 'lodash'

public class Main {
  public function Main() {
    var name:String = _.get({ user: { name: 'Ann' } }, 'user.name')   // `*`: not checked
    trace(name)
  }
}
```

```text output
Ann
```

### Local JavaScript files

JavaScript files in the source folder (`.js`, `.mjs`, `.cjs`, `.json`) are copied to the output, so
relative imports keep working; a `.d.ts` beside one gives it types:

```text
src/
  Main.xn
  lib/
    reports.js
    reports.d.ts
```

```actionscript
import { formatTotal } from './lib/reports.js'
```

The import is relative to the importing `.xn` file, as in JavaScript. See
[`examples/vendor`](../examples/vendor).

## Native declarations

`native` describes a JavaScript class or API that already exists, so XenonScript code can use it
with types. Nothing is emitted for it; uses refer to the JavaScript name:

```actionscript check
native('Intl.NumberFormat') class NumberFormat {
  public function NumberFormat(locale:String, options:* = null)
  public function format(n:Float):String
}

public class Main {
  public function Main() {
    var money = new NumberFormat('en-US', { style: 'currency', currency: 'USD' })
    trace(money.format(1234.5))
  }
}
```

```text output
$1,234.50
```

- `native('Intl.NumberFormat')` names the JavaScript object; plain `native` uses the class's name.
- Members have no bodies and are public unless stated. Constructors, statics and overloads (several
  signatures for one name) are allowed.
- Properties are declared as fields, like TypeScript's `.d.ts` files: `var value:String` for one
  that can be written, `final length:Int` for a read-only one (assigning it is X0504).
- `constexpr` on a member says the JavaScript built-in may run at compile time with constant
  arguments (see [chapter 8](08-compile-time-programming.md)).
- `function operator[](index:Int):File?` gives the type of `list[i]` for an object JavaScript
  indexes itself (`FileList`, `NodeList`, …). The index is checked against the parameter, through a
  `const` view the result is `const` too (as an array element is), and `list[i] = …` is X0374. It
  compiles to plain `list[i]`; classes of your own can't declare it (X0371).

Accessors are for the cases fields can't express: a property that takes another type than it
gives, and an override that narrows a type:

```actionscript
native class Widget extends Element {
  var label:String
  final count:Int
  /** Reads the style object; assigning a `String` replaces all inline styles. */
  function get style():CSSStyleProperties
  function set style(cssText:String):Void
  public override function get textContent():String   // never null here (Node's is `String?`)
  public override function set textContent(value:String?):Void
}
```

Only native classes may give a getter and its setter different types; in classes of your own they
must match (X0207). The standard library (see [chapter 10](10-standard-library.md)) is written as
native declarations in [`src/prelude/std`](../src/prelude/std).

## Extending JavaScript classes

A XenonScript class can extend a JavaScript class, whether it is declared natively, comes from the
standard library or from a typed import:

```actionscript check
class Store extends EventTarget {
  public function save():Void {
    dispatchEvent(new Event('saved'))
  }
}

public class Main {
  public function Main() {
    var store = new Store()
    store.addEventListener('saved', (e) => trace('got', e.type))
    store.save()
  }
}
```

```text output
got saved
```

Members inherited from a typed JavaScript parent are typed; from an untyped one they are `*`.
`override` is optional on members that replace ones from `.d.ts` declarations.

## Script globals

A page may load a package with a `<script>` tag instead of importing it as a module. Configure
`xenon.json`:

```json
{
  "globals": {
    "pizzip": "PizZip"
  }
}
```

Then:

```actionscript
import PizZip from 'pizzip'
```

The JavaScript output reads `globalThis.PizZip` and reports a clear error if the script was not
loaded. TypeScript still imports the package's declarations, so the code stays typed. Dotted global
names such as `Vendor.Library` can be configured.

## Using compiled XenonScript from JavaScript

The output is ordinary ES modules, so JavaScript code can import compiled classes, create them,
call their public members and subclass them. What JavaScript sees:

| XenonScript | JavaScript |
|---|---|
| a public class | an exported class of the same name, in `<package path>/<Name>.js` |
| `private` members | `#private` fields and methods: really inaccessible |
| `final` fields, `const` fields, getters without setters | read-only properties |
| `protected`, `internal` | ordinary public properties (the restriction is compile-time only) |
| a method used as a value | a bound function, the same one every time |
| an enum | a frozen object of numbers or strings |
| an interface | a marker symbol; `is` checks it |
| `operator+` & co. | methods named `operator+` (call them as `a['operator+'](b)`) |
| an `Exception` | a subclass of JavaScript's `Error` |

`xenon build --target ts` writes TypeScript instead, with every type spelled out, for TypeScript
projects that want to use the code with full types (see
[chapter 11](11-compiler-and-editor.md#typescript)).

## Exercises

1. Split a program into packages `model` and `ui`; make one `model` class internal and check that
   `ui` can't use it.
2. Import `node:path` and use `join`, `basename` and `extname`; hover over them in the editor.
3. Write a small `.js` file with a `.d.ts`, import it from a `.xn` file, and pass it a wrong
   argument type.
4. Declare `native('Intl.DateTimeFormat') class DateFormat` with a constructor and `format`, and
   print today's date.
5. Compile a class, import the `.js` output from a plain JavaScript file, and try to read one of its
   private fields.

See [`examples/interop`](../examples/interop), [`examples/declarations`](../examples/declarations),
[`examples/vendor`](../examples/vendor), and [`examples/natives`](../examples/natives).
