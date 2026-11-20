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
