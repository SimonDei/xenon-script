# Chapter 1: Getting started

XenonScript is a statically typed, class-based language in the tradition of ActionScript 3. The
compiler checks a whole project at once and writes plain JavaScript ES modules (or typed
TypeScript) that run on Bun, Node.js or in the browser. There is no runtime library to ship: the
output is the JavaScript you would have written by hand, plus small helpers only where a feature
needs them.

This chapter sets up a project, walks through a small program, shows what the compiler produces,
and introduces the development loop.

## Requirements

Install [Bun](https://bun.sh), clone this repository, and install the compiler's dependencies:

```sh
bun install
```

Try a complete example:

```sh
cd examples/hello
bun ../../src/cli.ts run
```

`run` compiles the program into `out/` and runs it with Bun. In this book, `xenon` stands for
`bun /path/to/class-lang/src/cli.ts`; you can make it a shell alias:

```sh
alias xenon="bun $HOME/class-lang/src/cli.ts"
```

## A project

A project is a folder with an optional `xenon.json` and a source folder:

```text
my-app/
  xenon.json
  src/
    Main.xn
```

`xenon.json`:

```json
{
  "main": "Main"
}
```

Without `xenon.json` the defaults apply: sources in `src/`, output in `out/`, main class `Main`,
JavaScript output with source maps. [Chapter 11](11-compiler-and-editor.md) lists every setting.

`src/Main.xn`:

```actionscript check
public class Main {
  public function Main() {
    trace('Hello, XenonScript!')
  }
}
```

```text output
Hello, XenonScript!
```

A program is a class: the compiler creates one instance of the main class, so its constructor (the
function named like the class) is the entry point. `trace` prints its arguments, separated by
spaces, like `console.log`.

Run it from the project folder:

```sh
xenon run
```

## A small program, step by step

Real programs have more than one class. Each public class lives in its own file, named after it,
and a file in a subfolder belongs to a *package* named after the folder:

```text
src/
  Main.xn
  shop/
    Cart.xn
    Item.xn
```

```actionscript check
import shop.Cart
import shop.Item

public class Main {
  public function Main() {
    var cart = new Cart()
    cart.add(new Item('Tea', 4.5))
    cart.add(new Item('Mug', 12))
    trace(cart.summary())
  }
}
// file: shop/Item.xn
package shop {
  public class Item {
    public final name:String
    public final price:Float

    public function Item(name:String, price:Float) {
      this.name = name
      this.price = price
    }
  }
}
// file: shop/Cart.xn
package shop {
  public class Cart {
    private var items:Array<Item> = []

    public function add(item:Item):Void {
      items.push(item)
    }

    public get total():Float => items.reduce((sum, i) => sum + i.price, 0.0)

    public function summary():String {
      return $'{items.length} items, {total.toFixed(2)} in total'
    }
  }
}
```

```text output
2 items, 16.50 in total
```

A few things to notice:

- **Types are written after names** (`price:Float`), as in ActionScript and TypeScript. Locals can
  leave them out when the value says enough: `var cart = new Cart()` is a `Cart`.
- **`final`** declares a value that is assigned exactly once, here in the constructor. Nobody can
  change an item's price afterwards, not even JavaScript code using the compiled module.
- **`private`** members are only visible inside their class. They compile to real JavaScript
  `#private` fields.
- **`Array<Item>`** is a typed array: `push` only takes `Item`s, and `reduce`'s callback knows that
  `i` is an `Item` without being told.
- **`get total()`** is a getter, used like a field: `total.toFixed(2)`.
- **`$'…'`** is a template string; `{…}` inserts a value.
- **`Main.xn` imports `shop.Cart`**; files in the same package see each other without imports.

## When something is wrong

The compiler checks the whole project before it writes anything. Suppose `Main` passes a price as
text:

```actionscript check
public class Main {
  public function Main() {
    var item = new Item('Tea', '4.50')        // error X0308
  }
}

class Item {
  public function Item(name:String, price:Float) {}
}
```

The error points at the argument, says what was expected and where that expectation comes from,
and suggests a fix:

```text
error[X0308]: mismatched types
 --> src/Main.xn:3:32
  |
3 |     var item = new Item('Tea', '4.50')
  |                                ^^^^^^ expected `Float`, found `String`
...
8 |   public function Item(name:String, price:Float) {}
  |                                           ----- parameter declared here
  |
help: convert the value with `Float()`
  |
3 |     var item = new Item('Tea', Float('4.50'))
  |                                ++++++      +
```

Every diagnostic has a code. `xenon explain X0308` prints a longer explanation with an example. In
VS Code, the suggested fix is a quick fix (see [chapter 11](11-compiler-and-editor.md)).

## What the compiler produces

Without bundling, every source file becomes one ES module in `out/`, with the same folder layout:

```text
out/
  xenon-main.js        the entry: imports Main and runs `new Main()`
  Main.js
  shop/Cart.js
  shop/Item.js
  xenon/Prelude.js     the prelude: `Exception` and small shared helpers
```

The JavaScript stays close to the source. `shop/Cart.xn` becomes:

```js
export class Cart {
  #items = [];
  add(item) {
    this.#items.push(item);
  }
  get total() {
    return this.#items.reduce((sum, i) => sum + i.price, 0.0);
  }
  summary() {
    return `${this.#items.length} items, ${this.total.toFixed(2)} in total`;
  }
}
```

Types are gone: they were checked at compile time. What remains is checked where JavaScript
can't be trusted to behave the same way (for example, an index out of range throws instead of
giving `undefined`; see [chapter 3](03-types-and-null-safety.md)).

Other outputs are one flag away:

- `xenon build --bundle` writes one `out/xenon-main.js` with every compiled module inside.
- `xenon build --target ts` writes typed TypeScript (`.ts`) instead of JavaScript.

## The development loop

```sh
xenon check          # check, write nothing
xenon build          # check and compile
xenon run -- args    # compile and run; arguments for the program follow --
xenon watch --run    # rebuild and restart on every change
```

Useful options:

```sh
xenon check --deny-warnings   # warnings fail the build (for CI)
xenon build --target ts       # TypeScript output
xenon run --bundle            # one bundled module
xenon check --format json     # machine-readable diagnostics
```

Diagnostics show source locations; with source maps (on by default), runtime stack traces do too:
an exception thrown in `Cart.xn` reports `src/shop/Cart.xn:12`, not the generated JavaScript.

## Where to go next

- [Chapter 2](02-values-and-syntax.md): variables, literals, operators, destructuring.
- [Chapter 3](03-types-and-null-safety.md): the type system and null safety.
- [Chapter 5](05-classes-and-objects.md): classes in depth.
- The [`examples/`](../examples) folder: complete programs for every feature, each with its
  expected output (they double as the compiler's end-to-end tests).

## Exercises

1. Add a `remove(name:String)` method to `Cart` and print the summary before and after.
2. Build with `--target ts` and compare `out/shop/Cart.ts` with the JavaScript.
3. Run `xenon watch --run`, change a price, and watch the program restart.
4. Make `items` public, then try `cart.items = []` from `Main`. Why is that allowed, and how would
   `final` change it?
