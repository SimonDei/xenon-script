# vite-plugin-xenon

Use XenonScript (`.xn`) in a [Vite](https://vite.dev) project: the dev server compiles and serves
`.xn` files, and `vite build` bundles them with the rest of the app.

```ts
// vite.config.ts
import xenon from "vite-plugin-xenon";

export default {
  plugins: [xenon()],
};
```

```html
<!-- index.html: starts the program (`new Main()`, the main class of xenon.json) -->
<script type="module">import "virtual:xenon";</script>
```

The project is the `xenon.json` in Vite's root (or `xenon({ project: "path/to/folder" })`), with its
`"dependencies"`. Run Vite with Bun, which the compiler needs: `bunx --bun vite`, `bunx --bun vite build`.

## What it does

- **Whole-project compiles.** Xenon checks a project as a whole, so the plugin compiles it at once
  (in about 100 ms for a few dozen files), caches the result, and serves each `.xn` file's module
  from it. Modules import each other by output path (`./ui/H.js`); the plugin points those imports
  at the `.xn` files, including a dependency's in another folder, and at virtual modules for the
  runtime (`xenon/Prelude.js`).
- **JavaScript next to the sources and npm packages** are left to Vite: `import { x } from './util.js'`
  in a `.xn` file finds `src/util.js`, `import 'jszip'` the package.
- **`.xn` files can be imported from JavaScript or TypeScript too:**
  `import { Main } from './src/Main.xn'`. `virtual:xenon` is the shortcut that also starts it.
- **Errors.** A compile error is a Vite error: the overlay in the browser, a failed `vite build`. The
  message is the compiler's, with the place of the first error. Warnings are printed by `vite build`
  (a dependency's warnings are its own project's).
- **Changes reload the page.** A change can alter other modules (an `inline` constant, a type), and
  custom elements can't be defined twice, so an edit, a new or a deleted `.xn` file, or a change to
  `xenon.json` recompiles and reloads instead of swapping modules. Dependencies' folders are watched
  too.
- **Source maps** point at the `.xn` files.

`xenon.json`'s `"bundle"`, `"out"` and `"target"` don't apply: Vite bundles and writes the output.
A library project (`"library": true`) has no program to start, but its modules can still be imported.
