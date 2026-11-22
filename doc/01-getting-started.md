# Chapter 1: Getting started

XenonScript compiles `.xn` files into JavaScript ES modules or typed TypeScript. A program starts by
constructing its configured main class.

## Requirements

Install [Bun](https://bun.sh), clone this repository, and install the compiler dependencies:

```sh
bun install
```

Try a complete example:

```sh
cd examples/hello
bun ../../src/cli.ts run
```

The program is compiled into `out/` and then run with Bun.

## A project

A minimal project looks like this:

```text
my-app/
  xenon.json
  src/
    Main.xn
```

`xenon.json`:

```json
{
  "main": "Main",
  "sourceMaps": true
}
```

`src/Main.xn`:

```actionscript
public class Main {
  public function Main() {
    trace('Hello, XenonScript!')
  }
}
```

The constructor named like its class is the entry point. Its normal JavaScript equivalent is
`constructor()`. The compiler creates an instance after loading the generated modules.

Run from the project folder:

```sh
bun /path/to/class-lang/src/cli.ts run
```

If `xenon.json` is absent, the defaults are `src/`, `out/`, main class `Main`, and JavaScript output.

## The development loop

```sh
xenon check          # check without writing output
xenon build          # compile
xenon run -- args    # compile and run; arguments follow --
xenon watch --run    # rebuild and restart after source changes
```

Common options:

```sh
xenon check --deny-warnings
xenon build --target ts
xenon run --bundle
xenon build --no-source-maps
xenon check --format json
```

From a repository checkout, replace `xenon` with:

```sh
bun src/cli.ts
```

## One file per class module

Without bundling, generated JavaScript follows the source modules. For example:

```actionscript
public class Greeter {
  public function greet(name:String):String {
    return $'Hello, {name}'
  }
}
```

becomes ordinary, readable JavaScript:

```js
export class Greeter {
  greet(name) {
    return `Hello, ${name}`;
  }
}
```

With `--bundle`, the compiler produces one `out/xenon-main.js` application module. With
`--target ts`, it writes typed TypeScript instead.

## Exercises

1. Add a second `.xn` file and instantiate its class from `Main`.
2. Switch the output target to TypeScript and inspect the inferred annotations.
3. Run `watch --run`, change the greeting, and observe the restart.

See [`examples/hello`](../examples/hello), then continue to [values and syntax](02-values-and-syntax.md).
