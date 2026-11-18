# Klass

A class-based, statically typed language in the style of ActionScript 3 that compiles to readable,
vanilla ES-module JavaScript and can import any JavaScript/npm library.

```actionscript
package {
  import { basename } from 'node:path'

  public class Main {
    private var count:int
    public static const GREETING:String = 'Hello'

    public function Main() {
      count += 2
      trace($'{GREETING}, count is {count}')   // template strings: $'…{expr}…'
      trace(~/^ma/i.test(basename('/x/Main.kl')))
    }
  }
}
```

## Usage

```bash
bun install
bun src/cli.ts run   --src examples/basics/src --out /tmp/out   # build + run
bun src/cli.ts build                                            # uses klass.json if present
bun src/cli.ts check                                            # type-check only
bun src/cli.ts watch --run                                      # rebuild + restart on every change
bun src/cli.ts explain K0308                                    # explain an error code
bun test                                                        # unit, end-to-end and diagnostic snapshot tests
UPDATE=1 bun test tests/errors.test.ts                          # rewrite diagnostic snapshots
```

Project layout: `src/` (compiler), `examples/<name>/src` + `expected.txt` (golden end-to-end tests),
`tests/errors/*.kl` + `*.stderr` (rendered diagnostics snapshots).
