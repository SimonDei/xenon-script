# Chapter 9: Packages and JavaScript interoperability

## Packages

A package block declares a source namespace:

```actionscript
package com.example.model {
  public class User {}
}
```

The package must match the source folder. A root `src/` file may omit the package block.

The compiler supports:

```actionscript
import com.example.model.User
import com.example.model.*
```

Explicit imports have priority over package names and wildcard imports. Ambiguous, duplicate,
unused, and redundant imports are diagnosed.

## Importing JavaScript

Default, named, and namespace imports follow JavaScript syntax:

```actionscript
import path from 'node:path'
import { readFileSync } from 'node:fs'
import * as archive from './archive.js'
```

Declarations are derived from:

- a package's own `.d.ts`
- `@types/...`
- Bun's types
- local declaration files

Namespaces become accessible static surfaces. Exported classes can be constructed, tested with
`is`, and extended. TypeScript object shapes become Xenon typedef-like types, while unsupported
constructs remain `*` only where necessary.

## Local JavaScript files

Files in `src/` may include:

- `.js`
- `.mjs`
- `.cjs`
- `.json`
- `.d.ts`

Runtime JavaScript files are copied to `out/`. Declaration files provide types but emit nothing.

Imports stay relative to the generated module:

```actionscript
import { formatTotal } from './reports.js'
```

```text
src/
  Main.xn
  reports.js
  reports.d.ts
```

## Untyped boundaries

A package without declaration files is dynamic:

```actionscript
import _ from 'lodash'
var result:* = _.get(data, 'user.name')
```

Use `as *` when an otherwise typed JavaScript value needs an explicit escape hatch.

## Native declarations

`native` declares an existing JavaScript API without emitting a replacement:

```actionscript
native('Intl.DateTimeFormat') class DateFormatter {
  public function DateFormatter(locale:String, options:*)
  public function format(date:Date):String
}
```

Native declarations may have:

- bodiless public members
- constructors
- static members
- overloads
- `constexpr` on members whose JavaScript implementation is safe for constant evaluation

XenonScript classes can extend JavaScript/native classes when the parent accepts that shape.
Implementations in native declarations do not contain executable Xenon code.

## Script globals

A page may load a package with a `<script>` tag. Configure `xenon.json`:

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
loaded. TypeScript still imports the package's declarations.

Dotted global names such as `Vendor.Library` can be configured.

## Output interoperability

Compiled classes are ordinary ES classes, so JavaScript can:

- import them
- instantiate them
- subclass them
- call public members

Private fields/methods remain JavaScript-private. `final`/`const` fields use read-only output
behavior even when accessed from JavaScript.

See [`examples/interop`](../examples/interop), [`examples/declarations`](../examples/declarations),
[`examples/vendor`](../examples/vendor), and [`examples/natives`](../examples/natives).
