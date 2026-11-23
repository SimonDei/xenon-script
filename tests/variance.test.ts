import { expect, test } from "bun:test";
import { compileProject } from "../src/compiler.ts";

test("class and interface generic variance follows in/out declarations", () => {
  const result = compileProject([
    { path: "Animal.xn", text: "public class Animal {}" },
    { path: "Dog.xn", text: "public class Dog extends Animal {}" },
    { path: "Source.xn", text: "public class Source<out T> { public final value:T?; public function Source(value:T) { this.value = value } public function get():T? => value }" },
    { path: "Sink.xn", text: "public class Sink<in T> { public function accept(value:T):void {} }" },
    { path: "Reader.xn", text: "public interface Reader<out T> { function read():T }" },
    { path: "DogReader.xn", text: "public class DogReader implements Reader<Dog> { public function read():Dog => new Dog() }" },
    { path: "Main.xn", text: `public class Main {
  public function Main() {
    var source:Source<Dog> = new Source(new Dog())
    var animals:Source<Animal> = source
    var sink:Sink<Animal> = new Sink()
    var dogs:Sink<Dog> = sink
    var reader:Reader<Animal> = new DogReader()
    trace(animals.get(), dogs, reader.read())
  }
}` },
  ], { main: "Main" });
  expect(result.diagnostics.items.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
});

test("in/out rejects type parameters on the unsafe side", () => {
  const result = compileProject([
    { path: "BadOut.xn", text: `public class BadOut<out T> {
  public function accept(value:T):void {}
}` },
    { path: "BadIn.xn", text: `public class BadIn<in T> {
  public function produce():T => new Dog()
}` },
    { path: "Dog.xn", text: "public class Dog {}" },
    { path: "Main.xn", text: "public class Main { public function Main() {} }" },
  ], { main: "Main" });
  expect(result.diagnostics.items.filter((d) => d.code === "X0799").map((d) => d.message)).toEqual([
    "type parameter `T` violates its `out` variance",
    "type parameter `T` violates its `in` variance",
  ]);
});

test("mutable properties and invariant nested containers invalidate variance", () => {
  const result = compileProject([
    { path: "BadField.xn", text: `public class BadField<out T> {
  public var value:T?
}` },
    { path: "BadNested.xn", text: `public class BadNested<out T> {
  public function all():Array<T> => []
}` },
    { path: "Main.xn", text: "public class Main { public function Main() {} }" },
  ], { main: "Main" });
  expect(result.diagnostics.items.filter((d) => d.code === "X0799").map((d) => d.message)).toEqual([
    "type parameter `T` violates its `out` variance",
    "type parameter `T` violates its `out` variance",
  ]);
});

test("default generic arguments remain invariant", () => {
  const result = compileProject([
    { path: "Animal.xn", text: "public class Animal {}" },
    { path: "Dog.xn", text: "public class Dog extends Animal {}" },
    { path: "Box.xn", text: "public class Box<T> { public var value:T?; public function Box() {} }" },
    { path: "Main.xn", text: `public class Main {
  public function Main() {
    var dogs:Box<Dog> = new Box()
    var animals:Box<Animal> = dogs
  }
}` },
  ], { main: "Main" });
  expect(result.diagnostics.items.filter((d) => d.code === "X0308").length).toBe(1);
});

test("function typedef variance is checked and emitted in TypeScript", () => {
  const result = compileProject([
    { path: "Main.xn", text: `typedef Mapper<in I, out O> = (value:I) -> O
public class Main {
  public function Main() {}
  public function keep(fn:Mapper<String, Int>):Mapper<String, Int> => fn
}` },
  ], { main: "Main", target: "ts" });
  expect(result.diagnostics.items.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
  const ts = result.outputs.find((f) => f.path === "Main.ts")!.text;
  expect(ts).toContain("type Mapper<in I, out O> = (value: I) => O;");
});

test("class variance annotations reach TypeScript output", () => {
  const result = compileProject([
    { path: "Source.xn", text: "public class Source<out T> { public function read():T? => null }" },
    { path: "Main.xn", text: "public class Main { public function Main() {} }" },
  ], { main: "Main", target: "ts" });
  expect(result.diagnostics.items.filter((d) => d.severity === "error").map((d) => d.message)).toEqual([]);
  expect(result.outputs.find((f) => f.path === "Source.ts")!.text).toContain("class Source<out T>");
});
