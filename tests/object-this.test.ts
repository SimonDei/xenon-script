/** `this` in an object literal's methods and accessors: the literal's shape, open to members added at runtime. */
import { expect, test } from "bun:test";
import { join } from "node:path";
import { compileProject } from "../src/compiler.ts";
import { XenonProject } from "../src/service.ts";

const errors = (text: string) =>
  compileProject([{ path: "Main.xn", text }], { main: "Main" }).diagnostics.items
    .filter((d) => d.severity === "error")
    .map((d) => `${d.code} ${d.labels.find((l) => l.primary)?.message ?? d.message}`);

const component = `public class Main {
  public function Main() {
    var o = {
      search: '',
      rows: [1, 2, 3],
      get count() => this.rows.length,
      get doubled() => this.count * 2,
      function bump(by:Int):Int { this.rows.push(by); return this.count },
      function init():Void {
        var s:String = this.doubled
        this.search = 5
        this.$store.app.ready = true
        var f = function() { return this.anything }
        trace(s, this.bump(1), f)
      },
    }
    o.init()
  }
}
`;

test("members of the literal are typed through `this`; others are dynamic", () => {
  expect(errors(component)).toEqual([
    "X0308 expected `String`, found `Int`",
    "X0308 expected `String`, found `Int`",
  ]);
});

test("against a typedef, `this` is the typedef's shape", () => {
  const text = `typedef Counter = { count:Int, bump:() -> Void }

public class Main {
  public function Main() {
    var c:Counter = {
      count: 0,
      function bump():Void { this.count = 'x' },
    }
    c.bump()
  }
}
`;
  expect(errors(text)).toEqual(["X0308 expected `Int`, found `String`"]);
});

test("a getter that reads itself through `this` is dynamic, not an endless loop", () => {
  const text = "public class Main {\n  public function Main() {\n    trace({ get loop() => this.loop }.loop)\n  }\n}\n";
  expect(errors(text)).toEqual([]);
});

test("`this.` completes the literal's members", () => {
  const p = new XenonProject(join(import.meta.dir, ".object-this-project", "src"));
  const text = component.replace("this.search = 5", "this.");
  p.set("Main.xn", text);
  const labels = p.completions("Main.xn", text.indexOf("this.\n") + 5).map((i) => i.label);
  expect(labels).toEqual(expect.arrayContaining(["search", "rows", "count", "doubled", "bump", "init"]));
});
