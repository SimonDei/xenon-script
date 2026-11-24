/** `const T` read-only views (transitive const: T1 the type and its assignability, T2 read-only access). */
import { afterAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { compileProject } from "../src/compiler.ts";
import { typeCheck } from "./tsemit.ts";

const errors = (result: ReturnType<typeof compileProject>) =>
  result.diagnostics.items.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.labels[0]?.message ?? d.message}`);

const program = (body: string, extra = "") => compileProject([{ path: "Main.xn", text: `public class Main {
  public function Main() {}
  public static function run():Void {
${body}
  }
}
class Cart {
  public var total:Int = 0
  private var _label:String = ''
  public function get label():String const => _label
  public function set label(v:String):Void { _label = v }
  public function get cheap():Bool const => total < 10
  public function get expensive():Bool => total > 10
  public function count():Int const => total
  public function add(n:Int):Void { total += n }
}
class Animal {}
class Dog extends Animal { public function bark():String => 'woof' }
class Box<T> { public var value:T; public function Box(value:T) { this.value = value } }
class Util {
  public static function id<T>(x:T):T => x
  public static function keep<T>(x:const T):const T => x
}
${extra}` }], { main: "Main" });

test("a value fits its const view, a const view fits only const views", () => {
  expect(errors(program(`
    var cart = new Cart()
    var view:const Cart = cart
    var maybe:const Cart? = view
    var any:* = view
    var views:Array<const Cart> = [view, cart]
    var arr:const Array<Int> = [1, 2]
    var tuple:const Tuple<String, Int> = ['a', 1]
    var shape:const { total:Int } = cart
    trace(maybe, any, views, arr, tuple, shape)`))).toEqual([]);
  expect(errors(program(`
    var view:const Cart = new Cart()
    var a:Cart = view
    var b:{ total:Int } = view
    var c:Array<Cart> = [view]
    var list:Array<const Cart> = []
    var d:Array<Cart> = list
    var e:Box<Cart> = new Box<const Cart>(view)
    trace(a, b, c, d, e)`))).toEqual([
    "X0308 expected `Cart`, found `const Cart`",
    "X0308 expected `{ total:Int }`, found `const Cart`",
    "X0308 expected `Cart`, found `const Cart`",
    "X0308 expected `Array<Cart>`, found `Array<const Cart>`",
    "X0308 expected `Box<Cart>`, found `Box<const Cart>`",
  ]);
});

test("type arguments carry const: inference, `const T` substitution, narrowing", () => {
  const result = program(`
    var view:const Cart = new Cart()
    var same = Util.id(view)
    var kept = Util.keep(new Cart())
    var a:const Animal = new Dog()
    var narrowed:Dog? = null
    if (a is Dog) narrowed = a
    var x:Cart = same
    var y:Cart = kept
    trace(x, y, narrowed)`);
  expect(errors(result)).toEqual([
    "X0308 expected `Dog?`, found `const Dog`",
    "X0308 expected `Cart`, found `const Cart`",
    "X0308 expected `Cart`, found `const Cart`",
  ]);
});

test("`const` on a type that can't change is a warning; the output is the plain type", () => {
  const result = compileProject([{ path: "Main.xn", text: `public class Main {
  public function Main() {
    var n:const Int = 1
    var s:const String = 's'
    var view:const Array<Int> = [n]
    trace(s, view)
  }
}` }], { main: "Main", target: "ts" });
  expect(result.diagnostics.items.filter((d) => d.code === "X0889").map((d) => d.message)).toEqual([
    "`const` has no effect on `Int`",
    "`const` has no effect on `String`",
  ]);
  expect(result.outputs.find((o) => o.path === "Main.ts")!.text).toContain("let view: ReadonlyArray<number> = [n];");
});

const codes = (result: ReturnType<typeof compileProject>) =>
  result.diagnostics.items.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.message}`);

test("through a `const` view: fields, setters, `++` and `+=` can't be written", () => {
  expect(codes(program(`
    var view:const Cart = new Cart()
    view.total = 3
    view.total += 1
    view.total++
    view.label = 'x'
    var maybe:const Cart? = view
    if (maybe != null) maybe.total = 1
    var s:const { n:Int } = { n: 1 }
    s.n = 2`))).toEqual([
    "X0904 cannot change `total` through a `const Cart`",
    "X0904 cannot change `total` through a `const Cart`",
    "X0904 cannot change `total` through a `const Cart`",
    "X0904 cannot change `label` through a `const Cart`",
    "X0904 cannot change `total` through a `const Cart`",
    "X0904 cannot change `n` through a `const { n:Int }`",
  ]);
});

test("through a `const` view: only const methods and getters; reads and the object itself are fine", () => {
  expect(codes(program(`
    var cart = new Cart()
    var view:const Cart = cart
    trace(view.total, view.count(), view.label, view.cheap, view.toString())
    cart.total = 5
    cart.add(1)
    view.add(1)
    trace(view.expensive)
    var fn = view.add
    var maybe:const Cart? = view
    maybe?.add(2)
    trace(fn)`))).toEqual([
    "X0905 cannot use non-const method `add` through a `const Cart`",
    "X0905 cannot use non-const getter `expensive` through a `const Cart`",
    "X0905 cannot use non-const method `add` through a `const Cart`",
    "X0905 cannot use non-const method `add` through a `const Cart`",
  ]);
});

test("a `const T` is read-only through its bound", () => {
  expect(codes(program("", `class Tools {
  public static function poke<T extends Cart>(x:const T):Int {
    x.total = 1
    x.add(1)
    return x.count() + x.total
  }
}`))).toEqual([
    "X0904 cannot change `total` through a `const T`",
    "X0905 cannot use non-const method `add` through a `const Cart`",
  ]);
});

test("TypeScript output: `Readonly<…>` for classes and shapes", () => {
  const result = compileProject([{ path: "Main.xn", text: `public class Main {
  public function Main() {
    var view:const Cart = new Cart()
    var s:const { n:Int } = { n: 1 }
    trace(view.count(), s.n, Main.read(new Cart()))
  }
  public static function read<T extends Cart>(x:const T):Int => x.count()
}
class Cart {
  private var secret:Int = 1
  public function count():Int const => secret
}` }], { main: "Main", target: "ts" });
  expect(codes(result)).toEqual([]);
  const main = result.outputs.find((o) => o.path === "Main.ts")!.text;
  expect(main).toContain("let view: Readonly<Cart> = new Cart();");
  expect(main).toContain("let s: Readonly<{ n: number }> = { n: 1 };");
  expect(main).toContain("static read<T extends Cart>(x: T): number"); // `const T` stays `T` in TypeScript
  expect(typeCheck(result.outputs, join(import.meta.dir, ".const-types-ts"))).toEqual([]);
});

afterAll(() => rm(join(import.meta.dir, ".const-types-ts"), { recursive: true, force: true }));

test("in a const method `this` is a `const Self`: it can't leave as a changeable object", () => {
  expect(codes(program("", `class Doc {
  public var title:String = ''
  public function get self():Doc const => this
  public function view():const Doc const => this
  public function leak():Void const {
    var me:Doc = this
    var ok:const Doc = this
    Doc.edit(this)
    Doc.read(this)
    var arrow = () => { var again:Doc = this }
    trace(me, ok, arrow)
  }
  public static function edit(d:Doc):Void { d.title = 'x' }
  public static function read(d:const Doc):Void {}
}`))).toEqual([
    "X0308 mismatched types",
    "X0308 mismatched types",
    "X0308 mismatched types",
    "X0308 mismatched types",
  ]);
});

test("const-method messages stay as they were (X0901/X0902), also implicit, through `super` and in arrows", () => {
  const result = program("", `class Base {
  public function touch():Void {}
}
class Doc extends Base {
  public var title:String = ''
  public function bump():Void {}
  public function report():String const {
    title = 'a'
    this.title = 'b'
    bump()
    this.bump()
    super.touch()
    var f = () => { this.title = 'c' }
    trace(f)
    return title
  }
}`);
  expect(codes(result)).toEqual([
    "X0901 cannot change `title` in const method `report`",
    "X0901 cannot change `title` in const method `report`",
    "X0902 cannot use non-const method `bump` in const method `report`",
    "X0902 cannot use non-const method `bump` in const method `report`",
    "X0902 cannot use non-const method `touch` in const method `report`",
    "X0901 cannot change `title` in const method `report`",
  ]);
});

const NESTED = `class Person {
  public var name:String = 'ann'
  public function rename(n:String):Void { name = n }
}
class Holder<T> { public var value:T; public function Holder(v:T) { value = v } }
class Shop {
  public var owner:Person = new Person()
  public var holder:Holder<Person> = new Holder(new Person())
  public function get boss():const Person const => owner
  public function makeOwner():Person const => new Person()
}`;

test("transitive: what a field or getter gives through a `const` view is `const` too", () => {
  expect(codes(program(`
    var shop = new Shop()
    var view:const Shop = shop
    trace(view.owner.name, view.boss.name)
    view.owner.name = 'x'
    view.owner.rename('y')
    view.boss.name = 'z'
    view.holder.value.name = 'w'
    var p:Person = view.owner
    var q:Person = view.makeOwner()     // a method's result is as declared
    var { owner } = view
    owner.name = 'v'
    var s:const { inner:{ n:Int } } = { inner: { n: 1 } }
    s.inner.n = 2
    var { inner } = s
    inner.n = 3
    shop.owner.name = 'fine'            // through the plain Shop
    trace(p, q)`, NESTED))).toEqual([
    "X0904 cannot change `name` through a `const Person`",
    "X0905 cannot use non-const method `rename` through a `const Person`",
    "X0904 cannot change `name` through a `const Person`",
    "X0904 cannot change `name` through a `const Person`",
    "X0308 mismatched types",
    "X0904 cannot change `name` through a `const Person`",
    "X0904 cannot change `n` through a `const { n:Int }`",
    "X0904 cannot change `n` through a `const { n:Int }`",
  ]);
});

test("transitive: a const method can't change what its fields point to, nor hand it out", () => {
  expect(codes(program("", `${NESTED}
class Store {
  public var owner:Person = new Person()
  public function touch():Void const {
    owner.name = 'q'
    this.owner.rename('r')
  }
  public function get leak():Person const => owner
  public function get view():const Person const => owner
}`))).toEqual([
    "X0904 cannot change `name` through a `const Person`",
    "X0905 cannot use non-const method `rename` through a `const Person`",
    "X0308 mismatched types",
  ]);
});

test("const arrays: only const members, no element or length writes; elements are read-only too", () => {
  expect(codes(program(`
    var list:Array<Cart> = [new Cart()]
    var view:const Array<Cart> = list
    trace(view.length, view.indexOf(list[0]), view.join(), view.map((c) => c.total), view.includes(list[0]))
    view.push(new Cart())
    view.sort()
    view[0] = new Cart()
    view.length = 0
    view[0].total = 1
    for (var c of view) c.total = 2
    view.forEach((c, i, all) => all.push(c))
    var first:Cart? = view.at(0)
    var copy = view.slice()
    copy.push(list[0])
    copy[0].total = 3
    var [x] = view
    x.total = 4
    var spread = [...view]
    spread[0].total = 5
    list.push(new Cart())
    trace(first, x)`))).toEqual([
    "X0905 cannot use non-const method `push` through a `const Array<Cart>`",
    "X0905 cannot use non-const method `sort` through a `const Array<Cart>`",
    "X0904 cannot change an element through a `const Array<Cart>`",
    "X0904 cannot change `length` through a `const Array<Cart>`",
    "X0904 cannot change `total` through a `const Cart`",
    "X0904 cannot change `total` through a `const Cart`",
    "X0905 cannot use non-const method `push` through a `const Array<const Cart>`",
    "X0308 mismatched types",
    "X0904 cannot change `total` through a `const Cart`",
    "X0904 cannot change `total` through a `const Cart`",
    "X0904 cannot change `total` through a `const Cart`",
  ]);
});

test("const tuples and records: no element writes, values read-only", () => {
  expect(codes(program(`
    var t:const Tuple<String, Cart> = ['a', new Cart()]
    trace(t[0], t.length)
    t[1].total = 1
    t[0] = 'b'
    var r:const Record<String, Cart> = { a: new Cart() }
    r['a'] = new Cart()
    r.a = new Cart()
    var a = r['a']
    if (a != null) a.total = 2`))).toEqual([
    "X0904 cannot change `total` through a `const Cart`",
    "X0904 cannot change an element through a `const Tuple<String, Cart>`",
    "X0904 cannot change an element through a `const Record<String, Cart>`",
    "X0904 cannot change `a` through a `const Record<String, Cart>`",
    "X0904 cannot change `total` through a `const Cart`",
  ]);
});

test("a const method can't change an array field; callbacks get the array as a `const` view", () => {
  expect(codes(program("", `class Bag {
  private var items:Array<Int> = []
  public function add(n:Int):Void { items.push(n) }
  public function count():Int const { return items.length }
  public function bad():Void const { items.push(1) }
}
class Sum {
  public static function total(xs:Array<Int>):Int => xs.reduce((acc:Int, x:Int, i:Int, all:Array<Int>):Int => acc + x)
  public static function ok(xs:Array<Int>):Int => xs.reduce((acc:Int, x:Int, i:Int, all:const Array<Int>):Int => acc + x)
}`))).toEqual([
    "X0905 cannot use non-const method `push` through a `const Array<Int>`",
    "X0308 mismatched types",
  ]);
});

test("TypeScript output: `ReadonlyArray<T>`, `readonly [..]`, `Readonly<Record<..>>`", () => {
  const result = compileProject([{ path: "Main.xn", text: `public class Main {
  public function Main() {
    var a:const Array<Int> = [1]
    var t:const Tuple<String, Int> = ['a', 1]
    var r:const Record<String, Int> = { x: 1 }
    trace(a.map((n) => n * 2), t[0], r['x'])
  }
}` }], { main: "Main", target: "ts" });
  expect(codes(result)).toEqual([]);
  const main = result.outputs.find((o) => o.path === "Main.ts")!.text;
  expect(main).toContain("let a: ReadonlyArray<number> = [1];");
  expect(main).toContain("let t: readonly [string, number] = ['a', 1];");
  expect(main).toContain("let r: Readonly<Record<string, number>> = { x: 1 };");
  expect(typeCheck(result.outputs, join(import.meta.dir, ".const-types-ts"))).toEqual([]);
});

test("const views of standard-library classes: Map, Set, Date, URLSearchParams; values read-only", () => {
  expect(codes(program(`
    var map = new Map<String, Cart>()
    var view:const Map<String, Cart> = map
    trace(view.size, view.has('a'), view.get('a'))
    view.set('a', new Cart())
    view.delete('a')
    view.clear()
    var c = view.get('a')
    if (c != null) c.total = 1
    for (var [k, v] of view) v.total = 2
    view.forEach((v, k, m) => m.clear())
    var set:const Set<Int> = new Set([1])
    trace(set.has(1), set.union(new Set([2])).size)
    set.add(2)
    var day:const Date = new Date()
    trace(day.getTime(), day.toISOString())
    day.setFullYear(2000)
    var params:const URLSearchParams = new URLSearchParams('a=1')
    trace(params.get('a'))
    params.append('b', '2')
    var re:const RegExp = ~/a/g
    trace(re.source, re.toString())
    re.test('a')
    map.set('b', new Cart())`))).toEqual([
    "X0905 cannot use non-const method `set` through a `const Map<String, Cart>`",
    "X0905 cannot use non-const method `delete` through a `const Map<String, Cart>`",
    "X0905 cannot use non-const method `clear` through a `const Map<String, Cart>`",
    "X0904 cannot change `total` through a `const Cart`",
    "X0904 cannot change `total` through a `const Cart`",
    "X0905 cannot use non-const method `clear` through a `const Map<String, const Cart>`",
    "X0905 cannot use non-const method `add` through a `const Set<Int>`",
    "X0905 cannot use non-const method `setFullYear` through a `const Date`",
    "X0905 cannot use non-const method `append` through a `const URLSearchParams`",
    "X0905 cannot use non-const method `test` through a `const RegExp`",
  ]);
});

test("variance: a read-only view is covariant; changeable types and user classes keep theirs", () => {
  expect(codes(program(`
    var dogs:Array<Dog> = [new Dog()]
    var a:const Array<Animal> = dogs
    var cd:const Array<Dog> = dogs
    var b:const Array<Animal> = cd
    var c:Array<Animal> = dogs
    var carts:Array<Cart> = []
    var d:const Array<const Cart> = carts
    var e:Array<const Cart> = carts
    var nested:const Array<Array<Dog>> = [dogs]
    var f:const Array<Array<Animal>> = nested
    var t:const Tuple<String, Dog> = ['a', new Dog()]
    var g:const Tuple<String, Animal> = t
    var pair:Tuple<Dog, Dog> = [new Dog(), new Dog()]
    var fromTuple:const Array<Animal> = pair
    var r:const Record<String, Dog> = { x: new Dog() }
    var h:const Record<String, Animal> = r
    var m:Map<String, Dog> = new Map()
    var i:const Map<String, Animal> = m
    var mk:Map<Dog, Int> = new Map()
    var j:const Map<Animal, Int> = mk
    var s:const Set<Animal> = new Set<Dog>()
    var p:const Promise<Animal> = Promise.resolve(new Dog())
    var box:const Box<Animal> = new Box<Dog>(new Dog())
    trace(a, b, c, d, e, f, g, fromTuple, h, i, j, s, p, box)`))).toEqual([
    "X0308 mismatched types",
    "X0308 mismatched types",
    "X0308 mismatched types",
    "X0308 mismatched types",
  ]);
});

test("`const` through type parameters: inference keeps it, a generic body can't drop it", () => {
  const result = compileProject([{ path: "Main.xn", text: `public class Main {
  public function Main() {}
  public static function run():Void {
    var carts:Array<Cart> = [new Cart()]
    var view:const Array<Cart> = carts
    var a = Lists.first(carts)
    var b = Lists.first(view)
    if (a != null) a.total = 1
    if (b != null) b.total = 1
    var c = Lists.mutableFirst(carts)
    if (c != null) c.total = 2
    Lists.mutableFirst(view)
    var d = Lists.id(view)
    d.push(new Cart())
  }
}
class Cart { public var total:Int = 0 }
class Lists {
  public static function first<T>(xs:const Array<T>):const T? => xs.at(0)
  public static function bad<T>(xs:const Array<T>):T? => xs.at(0)
  public static function mutableFirst<T>(xs:Array<T>):T? => xs.at(0)
  public static function id<T>(x:T):T => x
}` }], { main: "Main" });
  expect(codes(result).sort()).toEqual([
    "X0308 mismatched types", // `mutableFirst(view)`: a const array isn't an `Array<T>`
    "X0308 mismatched types", // `bad`: the elements of a `const Array<T>` are `const T`
    "X0904 cannot change `total` through a `const Cart`",
    "X0904 cannot change `total` through a `const Cart`",
    "X0905 cannot use non-const method `push` through a `const Array<Cart>`",
  ]);
});

test("`unconst` removes `const` (deeply) at compile time; `as` keeps it", () => {
  const result = compileProject([{ path: "Main.xn", text: `public class Main {
  public function Main() {}
  public static function run():Int {
    var cart = new Cart()
    var view:const Cart = cart
    unconst(view).total = 5
    var back:Cart = unconst(view)
    var list:const Array<const Cart> = [cart]
    var plain:Array<Cart> = unconst(list)
    plain.push(new Cart())
    var a:const Animal = new Dog()
    var d = a as Dog
    if (d != null) d.name = 'x'
    unconst(cart)
    var n = unconst(1, 2)
    return back.total + plain.length
  }
}
class Cart { public var total:Int = 0 }
class Animal { public var name:String = '' }
class Dog extends Animal {}` }], { main: "Main" });
  expect(result.diagnostics.items.filter((d) => d.code !== "X0861").map((d) => `${d.code} ${d.message}`).sort()).toEqual([
    "X0904 cannot change `name` through a `const Dog`",
    "X0906 `unconst` takes exactly one expression",
    "X0907 `unconst` has no effect: `Cart` isn't `const`",
  ]);
});

test("`unconst` emits only its value", async () => {
  const result = compileProject([{ path: "Main.xn", text: `public class Main {
  public function Main() {}
  public static function run():Int {
    var view:const Cart = new Cart()
    unconst(view).total = 5
    return unconst(view).total
  }
}
class Cart { public var total:Int = 0 }` }], { main: "Main" });
  expect(codes(result)).toEqual([]);
  const main = result.outputs.find((o) => o.path === "Main.js")!.text;
  expect(main).toContain("view.total = 5;");
  expect(main).not.toContain("unconst");
});
