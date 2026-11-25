/** Custom elements: extending `HTMLElement`, shadow roots, constructed style sheets and `customElements`, run against happy-dom. */
import { afterAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Window } from "happy-dom";
import { compileProject } from "../src/compiler.ts";
import { typeCheck } from "./tsemit.ts";

const errors = (r: ReturnType<typeof compileProject>) => r.diagnostics.items.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.message}`);

const main = `public class Main {
  public function Main() {}
  public static function define():Void {
    customElements.define('x-greeting', Greeting)
  }
  /** A \`Class<T>\` may be abstract; TypeScript's \`define\` wants a concrete constructor. */
  public static function defineAs(tag:String, cls:Class<HTMLElement>):Void {
    customElements.define(tag, cls)
  }
}

class Greeting extends HTMLElement {
  public var name:String = 'world'
  private final root:ShadowRoot

  public function Greeting() {
    super()
    root = attachShadow({ mode: 'open' })
    var sheet = new CSSStyleSheet()
    sheet.replaceSync(':host { color: red }')
    root.adoptedStyleSheets = [sheet]
  }

  public static function get observedAttributes():Array<String> => ['name']

  public function attributeChangedCallback(attr:String, old:String?, value:String?):Void {
    name = value ?? 'world'
    render()
  }

  public function connectedCallback():Void => render()

  private function render():Void {
    root.textContent = $'Hello, {name}!'
  }
}
`;

test("a class extending HTMLElement is a custom element", async () => {
  const result = compileProject([{ path: "Main.xn", text: main }], { main: "Main" });
  expect(errors(result)).toEqual([]);
  const js = result.outputs.find((o) => o.path === "Main.js")!.text;
  const window = new Window();
  try {
    const run = new Function("HTMLElement", "CSSStyleSheet", "customElements",
      `${js.replace(/^export /m, "").replace(/\/\/# sourceMappingURL.*$/m, "")}; return Main;`);
    run(window.HTMLElement, window.CSSStyleSheet, window.customElements).define();
    expect(window.customElements.get("x-greeting")).toBeDefined();
    window.document.body.innerHTML = `<x-greeting name="Ada"></x-greeting>`;
    const el = window.document.body.firstElementChild!;
    expect(el.shadowRoot!.textContent).toBe("Hello, Ada!");
    el.setAttribute("name", "Grace");
    expect(el.shadowRoot!.textContent).toBe("Hello, Grace!");
    expect(el.shadowRoot!.adoptedStyleSheets.length).toBe(1);
  } finally {
    await window.happyDOM.close();
  }
});

test("HTMLElement can be extended but not created directly", () => {
  const text = `public class Main {
  public function Main() {
    var el = new HTMLElement()
    trace(el)
  }
}
`;
  expect(errors(compileProject([{ path: "Main.xn", text }], { main: "Main" }))).toEqual([
    "X0603 the constructor of `HTMLElement` is protected in `HTMLElement`",
  ]);
});

test("the TypeScript output of a custom element type-checks, also when its class is a `Class<T>` value", () => {
  const result = compileProject([{ path: "Main.xn", text: main }], { main: "Main", target: "ts" });
  expect(errors(result)).toEqual([]);
  expect(typeCheck(result.outputs, join(import.meta.dir, ".custom-elements-ts"))).toEqual([]);
});

afterAll(() => rm(join(import.meta.dir, ".custom-elements-ts"), { recursive: true, force: true }));
