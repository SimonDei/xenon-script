/** The browser's DOM (src/prelude/std/dom): typed use, compiled code running against happy-dom, and own classes named like DOM ones. */
import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { compileProject } from "../src/compiler.ts";

const main = `public class Main {
  public function Main() {}

  /** Paragraphs of a Word document without a page break, as in a letter template. */
  public static function keep(root:Element):Array<String> {
    var kept:Array<String> = []
    for (var p:Element of root.getElementsByTagName('w:p')) {
      var breaks:Array<Element> = Array.from(p.getElementsByTagName('w:br'))
      if (breaks.some((br:Element):Boolean => br.getAttribute('w:type') == 'page')) continue
      var text:String = p.textContent ?? ''
      kept.push($'{p.localName}:{text}:{p.parentElement?.tagName ?? '-'}:{p.childNodes.length}')
    }
    return kept
  }

  public static function isElement(n:Node):Boolean => n.nodeType == Node.ELEMENT_NODE
}
`;

test("DOM code type-checks and runs against a DOM", async () => {
  const result = compileProject([{ path: "Main.xn", text: main }], { main: "Main" });
  expect(result.diagnostics.items.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
  const js = result.outputs.find((o) => o.path === "Main.js")!.text;
  expect(js).toContain("n.nodeType === 1"); // `Node.ELEMENT_NODE` is pasted

  const window = new Window();
  try {
    const xml = new window.DOMParser().parseFromString(
      `<w:body xmlns:w="urn:w"><w:p>Hello</w:p><w:p>skip<w:br w:type="page"/></w:p><w:p>Bye<w:br/></w:p></w:body>`, "application/xml");
    // The compiled class, with the DOM's classes as globals (as in a browser).
    const run = new Function("Node", "Element", `${js.replace(/^export /m, "").replace(/\/\/# sourceMappingURL.*$/m, "")}; return Main;`);
    const Main = run(window.Node, window.Element);
    expect(Main.keep(xml.documentElement)).toEqual(["p:Hello:w:body:1", "p:Bye:w:body:2"]);
    expect(Main.isElement(xml.documentElement)).toBe(true);
  } finally {
    await window.happyDOM.close();
  }
});

test("an empty array can be a DOM fallback through IEnumerable", () => {
  const result = compileProject([{ path: "Main.xn", text: `public class Main {
  public function Main() {}
  public static function children(parent:Node?):Array<Node> {
    return Array.from(parent?.childNodes ?? ([] : IEnumerable<Node>))
  }
}
` }], { main: "Main", nullSafety: true });
  expect(result.diagnostics.items.filter((d) => d.severity === "error").map((d) => [d.code, d.message])).toEqual([]);
});

test("Element.attributes is an iterable collection of Attr values", () => {
  const result = compileProject([{ path: "Main.xn", text: `public class Main {
  public function Main() {}
  public static function attributes(element:Element):Array<String> {
    return [...element.attributes].map(attr => $'{attr.name}={attr.value}')
  }
}
` }], { main: "Main", nullSafety: true });
  expect(result.diagnostics.items.filter((d) => d.severity === "error").map((d) => [d.code, d.message])).toEqual([]);
});

test("Element.style is dynamic for CSS property assignment", () => {
  const result = compileProject([{ path: "Main.xn", text: `public class Main {
  public static function style(element:Element):Void {
    Object.assign(element.style, { position: 'absolute', width: '10pt' })
    element.style.display = 'none'
  }
}
` }], { main: "Main", nullSafety: true });
  expect(result.diagnostics.items.filter((d) => d.severity === "error").map((d) => [d.code, d.message])).toEqual([]);
});

test("HTMLElement.style exposes CSSStyleProperties and CSSStyleDeclaration methods", () => {
  const result = compileProject([{ path: "Main.xn", text: `public class Main {
  public static function style(element:HTMLElement):Void {
    var styles:CSSStyleProperties = element.style
    styles.display = 'none'
    styles.backgroundColor = 'red'
    styles.setProperty('margin-top', '1rem', 'important')
    trace(styles.getPropertyValue('border-top'), styles.cssText, styles.item(0), styles.length)
    element.style.cssText = 'position: absolute'
  }
}
` }], { main: "Main", nullSafety: true });
  expect(result.diagnostics.items.filter((d) => d.severity === "error").map((d) => [d.code, d.message])).toEqual([]);
});

test("HTMLElement exposes MDN properties and interaction methods", () => {
  const result = compileProject([{ path: "Main.xn", text: `public class Main {
  public static function use(doc:Document):Void {
    var element:HTMLElement = doc.createElement('div')
    element.accessKey = 'x'
    element.autocapitalize = 'words'
    element.autofocus = true
    element.contentEditable = 'true'
    element.dataset.previewId = 'frame'
    element.dir = 'ltr'
    element.hidden = 'until-found'
    element.inert = true
    element.innerText = 'preview'
    element.popover = 'manual'
    element.tabIndex = 0
    element.focus({ preventScroll: true })
    element.showPopover({ source: element })
    trace(element.offsetParent, element.togglePopover(false))
  }
}
` }], { main: "Main", nullSafety: true });
  expect(result.diagnostics.items.filter((d) => d.severity === "error").map((d) => [d.code, d.message])).toEqual([]);
});

test("document is typed and creates a TreeWalker", () => {
  const result = compileProject([{ path: "Main.xn", text: `public class Main {
  public static function walk(root:Node):Node? {
    var walker:TreeWalker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, node => node.nodeValue != '' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP)
    var next:Node? = walker.nextNode()
    if (next != null) walker.currentNode = next
    return walker.parentNode()
  }
}
` }], { main: "Main", nullSafety: true });
  expect(result.diagnostics.items.filter((d) => d.severity === "error").map((d) => [d.code, d.message])).toEqual([]);
});

test("Text inherits CharacterData text mutation", () => {
  const result = compileProject([{ path: "Main.xn", text: `public class Main {
  public static function change(document:Document):String {
    var text:Text = document.createTextNode('hello')
    var data:CharacterData = text
    data.replaceData(0, 5, 'world')
    data.appendData('!')
    return data.substringData(0, data.length)
  }
}
` }], { main: "Main", nullSafety: true });
  expect(result.diagnostics.items.filter((d) => d.severity === "error").map((d) => [d.code, d.message])).toEqual([]);
});

test("a stable value keeps a guard's narrowing inside a callback", () => {
  const safe = compileProject([{ path: "Main.xn", text: `public class Main {
  public static function has(data:Object?, key:String):Boolean {
    if (data == null || typeof data != 'object') return false
    return [key].some(item => item in data)
  }
}
` }], { main: "Main", nullSafety: true });
  expect(safe.diagnostics.items.filter((d) => d.severity === "error").map((d) => d.code)).toEqual([]);

  const changedLater = compileProject([{ path: "Main.xn", text: `public class Main {
  public static function has(data:Object?, key:String):Boolean {
    if (data == null) return false
    var read:() -> Boolean = () => key in data
    data = null
    return read()
  }
}
` }], { main: "Main", nullSafety: true });
  expect(changedLater.diagnostics.items.filter((d) => d.severity === "error").map((d) => d.code)).toEqual(["X0398"]);
});

test("a matching optional member narrows its receiver", () => {
  const result = compileProject([{ path: "Main.xn", text: `typedef Frame = { key:String, count:int }
public class Main {
  public static function increment(current:Frame?, key:String):Frame? {
    if (current?.key == key) {
      current.count++
    }
    return current
  }
}
` }], { main: "Main", nullSafety: true });
  expect(result.diagnostics.items.filter((d) => d.severity === "error").map((d) => [d.code, d.message])).toEqual([]);
});

test("Element.textContent is non-null and writable; Document.textContent stays nullable", () => {
  const result = compileProject([{
    path: "Main.xn",
    text: `public class Main {
  public function Main() {}
  public static function text(element:Element):int {
    element.textContent = ''
    return element.textContent.length
  }
  public static function documentText(document:Document):int => document.textContent.length
}
`,
  }], { main: "Main", nullSafety: true });
  expect(result.diagnostics.items.filter((d) => d.severity === "error").map((d) => d.code)).toEqual(["X0398"]);
});

test("a DOM result that may be missing is T? with null safety; the DOM's names are free for own classes", () => {
  const nullSafe = compileProject([{ path: "Main.xn", text: `public class Main {
  public function Main() {}
  public static function type(e:Element):int => e.getAttribute('w:type').length
}
` }], { main: "Main", nullSafety: true });
  expect(nullSafe.diagnostics.items.filter((d) => d.severity === "error").map((d) => d.code)).toEqual(["X0398"]);

  // A program's own `Element` and `Node` shadow the DOM's (unlike `Map` or `Exception`, which are reserved).
  const own = compileProject([
    { path: "Main.xn", text: "public class Main {\n  public function Main() { trace(new Element('a').name, Node.count) }\n}\n" },
    { path: "Element.xn", text: "public class Element {\n  public var name:String\n  public function Element(name:String) { this.name = name }\n}\n" },
    { path: "Node.xn", text: "public class Node {\n  public static var count:int = 0\n}\n" },
  ], { main: "Main" });
  expect(own.diagnostics.items.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
});

test("EventTarget: Node extends it; own classes can extend it; listeners get an Event", async () => {
  const sources = [
    { path: "Main.xn", text: `public class Main {
  public function Main() {
    var store:Store = new Store()
    var seen:Array<String> = []
    store.addEventListener('saved', (e:Event):Void => { seen.push(e.type + ':' + (e.target == store)) })
    store.addEventListener('saved', (e:Event):Void => { seen.push('once') }, { once: true })
    store.addEventListener('delete', (e:Event):Void => { e.preventDefault() })
    store.save()
    store.save()
    trace(seen.join(','), store.dispatchEvent(new Event('delete', { cancelable: true })))
  }

  /** Listens on a DOM node: \`Node\` is an \`EventTarget\`. */
  public static function count(node:Node, type:String):Array<int> {
    var n:Array<int> = [0]
    node.addEventListener(type, (e:Event):Void => { n[0] = n[0] + e.eventPhase })
    return n
  }
}
` },
    { path: "Store.xn", text: `public class Store extends EventTarget {
  public function Store() { super() }
  public function save():void { dispatchEvent(new Event('saved')) }
}
` },
  ];
  const result = compileProject(sources, { main: "Main" });
  expect(result.diagnostics.items.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
  // Run in Bun, which has EventTarget and Event.
  const { mkdir, rm } = await import("node:fs/promises");
  const { dirname, join } = await import("node:path");
  const out = join(import.meta.dir, ".events-out");
  await rm(out, { recursive: true, force: true });
  try {
    for (const o of result.outputs) {
      await mkdir(dirname(join(out, o.path)), { recursive: true });
      await Bun.write(join(out, o.path), o.text);
    }
    await Bun.write(join(out, "run.mjs"), "import { Main } from './Main.js';\nnew Main();\n");
    const proc = Bun.spawn(["bun", join(out, "run.mjs")], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect(stderr).toBe("");
    expect(stdout).toBe("saved:true,once,saved:true false\n");
  } finally {
    await rm(out, { recursive: true, force: true });
  }
  // A DOM node in happy-dom: the listener runs at the target (phase 2).
  const window = new Window();
  try {
    const js = result.outputs.find((o) => o.path === "Main.js")!.text;
    const Main = new Function("Store", `${js.replace(/^import .*$/gm, "").replace(/^export /m, "").replace(/\/\/# sourceMappingURL.*$/m, "")}; return Main;`)(class {});
    const el = window.document.createElement("div");
    const n = Main.count(el, "ping");
    el.dispatchEvent(new window.Event("ping"));
    expect(n).toEqual([2]);
  } finally {
    await window.happyDOM.close();
  }
});

test("DOM code's TypeScript output type-checks (TypeScript's DOM library)", async () => {
  const { typeCheck } = await import("./tsemit.ts");
  const { join } = await import("node:path");
  const code = `public class Main {
  public function Main() {}
  public static function texts(root:Element):Array<String> {
    var out:Array<String> = []
    for (var p:Element of root.getElementsByTagName('w:p')) out.push(p.textContent ?? '')
    var all:NodeList<Element> = root.querySelectorAll('w\\\\:br')
    for (var br:Element of all) out.push(br.getAttribute('w:type') ?? '')
    var first:Node? = root.firstChild
    if (first != null && first.nodeType == Node.TEXT_NODE) out.push(first.nodeValue ?? '')
    root.addEventListener('click', (e:Event):Void => e.preventDefault())
    return out
  }
}
`;
  const result = compileProject([{ path: "Main.xn", text: code }], { main: "Main", target: "ts" });
  expect(result.diagnostics.items.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
  expect(typeCheck(result.outputs, join(import.meta.dir, ".dom-ts"))).toEqual([]);
});

test("DOMParser and Document: parse Word XML, change it, read it back (and the TypeScript output checks)", async () => {
  const code = `public class Main {
  public function Main() {}
  private static inline final W:String = 'urn:w'

  /** The paragraphs' text, after appending one more paragraph. */
  public static function paragraphs(xml:String):Array<String> {
    var doc:Document = new DOMParser().parseFromString(xml, 'application/xml')
    if (doc.getElementsByTagName('parsererror').length > 0) return ['invalid']
    var body:Element? = doc.documentElement?.firstElementChild
    if (body == null) return []
    var p:Element = doc.createElementNS(W, 'w:p')
    p.append(doc.createTextNode('added'))
    body.append(p)
    // (\`getElementsByTagNameNS(W, 'p')\` would do too in a browser; happy-dom doesn't find namespaced elements that way.)
    return Array.from(doc.getElementsByTagName('w:p'), (e:Element, i:int):String => $'{i}:{e.textContent ?? ''}:{e.ownerDocument == doc}')
  }
}
`;
  const xml = `<w:document xmlns:w="urn:w"><w:body><w:p>Hello</w:p><w:p>World</w:p></w:body></w:document>`;
  const js = compileProject([{ path: "Main.xn", text: code }], { main: "Main" });
  expect(js.diagnostics.items.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
  const source = js.outputs.find((o) => o.path === "Main.js")!.text;
  const window = new Window();
  try {
    const Main = new Function("DOMParser", `${source.replace(/^export /m, "").replace(/\/\/# sourceMappingURL.*$/m, "")}; return Main;`)(window.DOMParser);
    expect(Main.paragraphs(xml)).toEqual(["0:Hello:true", "1:World:true", "2:added:true"]);
    expect(Main.paragraphs("<w:document")).toEqual(["invalid"]);
  } finally {
    await window.happyDOM.close();
  }
  const { typeCheck } = await import("./tsemit.ts");
  const { join } = await import("node:path");
  const ts = compileProject([{ path: "Main.xn", text: code }], { main: "Main", target: "ts" });
  expect(typeCheck(ts.outputs, join(import.meta.dir, ".dom-ts"))).toEqual([]);
});

test("XMLSerializer: a parsed and changed document back to XML text (and the TypeScript output checks)", async () => {
  const code = `public class Main {
  public function Main() {}

  /** Removes the placeholder from every text run and serializes the document again. */
  public static function clean(xml:String, placeholder:String):String {
    var doc:Document = new DOMParser().parseFromString(xml, 'application/xml')
    for (var t:Element of doc.getElementsByTagName('w:t')) {
      var text:String = t.textContent ?? ''
      if (text.includes(placeholder)) t.textContent = text.replaceAll(placeholder, '')
    }
    return new XMLSerializer().serializeToString(doc)
  }
}
`;
  const result = compileProject([{ path: "Main.xn", text: code }], { main: "Main" });
  expect(result.diagnostics.items.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
  const source = result.outputs.find((o) => o.path === "Main.js")!.text;
  const window = new Window();
  try {
    const Main = new Function("DOMParser", "XMLSerializer", `${source.replace(/^export /m, "").replace(/\/\/# sourceMappingURL.*$/m, "")}; return Main;`)(window.DOMParser, window.XMLSerializer);
    const xml = `<w:document xmlns:w="urn:w"><w:p><w:t>Dear ~</w:t></w:p></w:document>`;
    expect(Main.clean(xml, "~")).toBe(`<w:document xmlns:w="urn:w"><w:p><w:t>Dear </w:t></w:p></w:document>`);
  } finally {
    await window.happyDOM.close();
  }
  const { typeCheck } = await import("./tsemit.ts");
  const { join } = await import("node:path");
  const ts = compileProject([{ path: "Main.xn", text: code }], { main: "Main", target: "ts" });
  expect(typeCheck(ts.outputs, join(import.meta.dir, ".dom-ts"))).toEqual([]);
});
