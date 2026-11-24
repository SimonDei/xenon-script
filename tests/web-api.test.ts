/** CustomEvent, URL and URLSearchParams (Bun and browsers), DOMTokenList and FileReader (browsers). */
import { afterAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Window } from "happy-dom";
import { compileProject } from "../src/compiler.ts";
import { typeCheck } from "./tsemit.ts";

const errors = (r: ReturnType<typeof compileProject>) => r.diagnostics.items.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.message}`);
const out = join(import.meta.dir, ".web-api-out");
afterAll(() => Promise.all([rm(out, { recursive: true, force: true }), rm(join(import.meta.dir, ".web-api-ts"), { recursive: true, force: true })]));

const code = `typedef Mail = { to:String, subject:String }

public class Main {
  public function Main() {}

  /** A typed \`detail\` from dispatch to listener. */
  public static function events():Array<String> {
    var bus:EventTarget = new EventTarget()
    var seen:Array<String> = []
    bus.addEventListener('preview', (e:CustomEvent<Mail>):Void => { seen.push(e.detail.to + '/' + e.detail.subject) })
    bus.dispatchEvent(new CustomEvent('preview', { detail: { to: 'ann@x.de', subject: 'Hi' } }))
    var plain:CustomEvent = new CustomEvent('ping')
    seen.push(String(plain.detail))
    return seen
  }

  public static function urls():Array<String> {
    var url:URL = new URL('api/mail?x=1', 'https://example.org/app/')
    url.searchParams.set('page', '2')
    url.hash = '#top'
    var params:URLSearchParams = new URLSearchParams({ q: 'xenon lang', tag: 'a' })
    params.append('tag', 'b')
    var pairs:Array<String> = []
    for (var [name, value] of params) pairs.push($'{name}={value}')
    return [url.href, url.pathname, url.origin, url.searchParams.get('x') ?? '-', params.toString(), params.getAll('tag').join('|'),
      pairs.join(','), String(URL.canParse('nope')), URL.parse('https://a.org/b')?.hostname ?? '-', String(params.size)]
  }

  public static function classes(el:Element):String {
    el.classList.add('a', 'b')
    el.classList.toggle('a')
    var replaced:Boolean = el.classList.replace('b', 'c')
    var all:Array<String> = []
    for (var c:String of el.classList) all.push(c)
    el.classList = 'x y'
    return $'{all.join(' ')}:{replaced}:{el.classList.length}:{el.classList.contains('y')}'
  }

  public static function read(file:Blob, done:(text:String) -> Void):Void {
    var reader:FileReader = new FileReader()
    reader.onload = (e) => {
      var r:String | ArrayBuffer | null = reader.result
      if (r is String) done(r)
    }
    reader.readAsText(file)
  }
}
`;

test("CustomEvent, URL and URLSearchParams run in Bun; DOMTokenList and FileReader in a DOM", async () => {
  const result = compileProject([{ path: "Main.xn", text: code }], { main: "Main" });
  expect(errors(result)).toEqual([]);
  await rm(out, { recursive: true, force: true });
  for (const o of result.outputs) await Bun.write(join(out, o.path), o.text);
  const { Main } = await import(join(out, "Main.js"));
  expect(Main.events()).toEqual(["ann@x.de/Hi", "null"]);
  expect(Main.urls()).toEqual([
    "https://example.org/app/api/mail?x=1&page=2#top", "/app/api/mail", "https://example.org", "1",
    "q=xenon+lang&tag=a&tag=b", "a|b", "q=xenon lang,tag=a,tag=b", "false", "a.org", "3",
  ]);
  const window = new Window();
  try {
    expect(Main.classes(window.document.createElement("div"))).toBe("c:true:2:true");
    // FileReader is global in a browser; here happy-dom's, made global for the run.
    (globalThis as Record<string, unknown>).FileReader = window.FileReader;
    const text = await new Promise<string>((resolve) => Main.read(new window.Blob(["hello"]), resolve));
    expect(text).toBe("hello");
  } finally {
    delete (globalThis as Record<string, unknown>).FileReader;
    await window.happyDOM.close();
  }
});

test("misuse of the new web APIs is reported", () => {
  const bad = `typedef Mail = { to:String }
public class Main {
  public function Main() {}
  public static function f(el:Element):Void {
    new CustomEvent<Mail>('x', { detail: { to: 1 } })
    var u:URL = new URL('a', 'b')
    u.origin = 'x'
    var n:Int = new URLSearchParams().get('a')
    el.classList.add(1)
  }
}
`;
  expect(errors(compileProject([{ path: "Main.xn", text: bad }], { main: "Main" }))).toEqual([
    "X0308 mismatched types",
    "X0504 `origin` is read-only",
    "X0308 mismatched types",
    "X0308 mismatched types",
  ]);
});

test("the TypeScript output of the new web APIs type-checks", () => {
  const result = compileProject([{ path: "Main.xn", text: code }], { main: "Main", target: "ts" });
  expect(errors(result)).toEqual([]);
  expect(typeCheck(result.outputs, join(import.meta.dir, ".web-api-ts"))).toEqual([]);
});
