# Chapter 12: Language quick reference

## Reserved words

Reserved words always have language meaning and cannot be used as declaration names. Use the
contextual words in the next section when the syntax permits an otherwise valid identifier.

### Declarations and structure

| Word | Meaning |
|---|---|
| `package` | Names the package containing a file. Source files without `package` use the default package. |
| `import` | Imports a XenonScript type or a JavaScript/TypeScript module binding. |
| `class` | Declares a concrete, abstract, final, static, or native class. |
| `interface` | Declares a nominal contract that classes or other interfaces extend/implement. |
| `enum` | Declares a fixed set of named values. |
| `typedef` | Gives a name to a structural shape, function type, union, or other type expression. Inside a class body it is named `Owner.Name` outside the class and takes a member visibility. |
| `extends` | Declares a superclass, or the parent interface of an interface. |
| `implements` | Lists interfaces that a class or enum implements. |
| `function` | Declares a method, accessor, constructor, destructor, local function or function expression. (Package-level functions exist only in the standard library's declarations.) |
| `var` | Declares a mutable local, field, or loop variable. |
| `const` | Declares a constant initialized at its declaration; after a method's return type it makes the method read-only; before a type it makes a read-only view (`const Cart`). |
| `final` | Declares a value assigned once, prevents a class from being extended, or a method from being overridden. |
| `using` | Calls `dispose()` of an `IDisposable` (or awaits that of an `IAsyncDisposable`) when its block ends: `using (r = open()) { … }`, `using r = open()`, `using (existing) …`. |

### Modifiers

| Word | Meaning |
|---|---|
| `public` | Makes a declaration visible from any package. |
| `private` | Limits a member or file-local declaration to its owner. |
| `protected` | Allows access from the declaring class and its subclasses. |
| `internal` | Limits access to the declaring package; this is the default visibility. |
| `static` | Attaches a member to its class. A static class cannot be instantiated and may contain only static members. |
| `inline` | Evaluates an eligible constant initializer at compile time and substitutes its value. |
| `constexpr` | Declares a function or constructor that is evaluated at compile time when all inputs are constant, and may also run normally. |
| `consteval` | Requires every call to be evaluable at compile time. |
| `abstract` | Declares an incomplete class or member. Abstract members have no body and concrete subclasses must implement them. |
| `override` | States explicitly that an instance method or accessor replaces an inherited member. |
| `dynamic` | Reserved for classes with arbitrary runtime members; not currently implemented. |
| `async` | Makes a function asynchronous, so it returns a `Promise` and may use `await`. |
| `native` | Declares an existing JavaScript API; XenonScript does not emit its implementation. |

`const` can also follow a method parameter list (`function read():Int const`) to make the method
read-only with respect to `this`.

### Control flow and exceptions

| Word | Meaning |
|---|---|
| `if` | Executes a statement or expression branch when a `Bool` condition is true. |
| `else` | Selects the alternative branch of an `if`. |
| `switch` | Dispatches to cases according to a value. |
| `case` | Introduces one value-matching branch of a `switch`. |
| `default` | Introduces the fallback branch of a `switch`. |
| `while` | Repeats a body while a `Bool` condition is true. |
| `do` | Starts a loop whose condition is checked after each iteration. |
| `for` | Starts a C-style, `for … of`, `for … in`, or range loop. |
| `in` | Iterates object keys (`for (var k in obj)`), tests whether a property exists (`'a' in obj`), or marks a contravariant type parameter (`Consumer<in T>`). |
| `break` | Leaves the innermost loop or `switch`. |
| `continue` | Starts the next iteration of the innermost loop. |
| `return` | Leaves a function and optionally supplies its result. |
| `throw` | Raises an `Exception` value. |
| `try` | Starts a block whose exceptions may be handled by `catch` or cleaned up by `finally`. |
| `catch` | Handles an exception produced while evaluating a `try` block. |
| `finally` | Runs cleanup after a `try`, regardless of normal or exceptional completion. |

### Expressions and literals

| Word | Meaning |
|---|---|
| `new` | Constructs an instance of a class. Static and abstract classes cannot be constructed. |
| `this` | Refers to the current instance. It is unavailable in static methods. |
| `super` | Refers to the parent class implementation or constructor. |
| `is` | Tests a value against a runtime-compatible type. |
| `as` | Performs a checked runtime cast; incompatible values become `null`. A cast keeps `const`. |
| `typeof` | Produces the JavaScript runtime type tag of a value. |
| `delete` | Deletes a property from a dynamic/`*` or `Object` value. |
| `await` | Pauses an async function until a promise settles and produces its value. |
| `nameof` | Produces the checked source name of a local, parameter, class, member, or enum member as a string constant. |
| `unconst` | `unconst(value)`: the value with `const` removed from its type, at any depth. Compile time only; it emits just `value`. |
| `true` | The true `Bool` literal. |
| `false` | The false `Bool` literal. |
| `null` | The null/no-value literal and the value handled by nullable types. |
| `undefined` | JavaScript's undefined value. Supported for compatibility, but every use warns; use `null`. |
| `void` | The lowercase alias of `Void`. As a statement prefix, `void promise()` starts a promise deliberately without awaiting it. |

### Reserved for later

These words cannot be used as identifiers because XenonScript reserves them for possible future
syntax.

| Word | Intended/reserved meaning |
|---|---|
| `namespace` | Reserved for a possible namespace declaration distinct from packages. |
| `use` | Reserved for possible trait/mixin inclusion or similar reuse syntax. |
| `with` | Reserved for a possible lexical-object or structural-update construct; currently no syntax is planned. |
| `yield` | Reserved for generator functions. Generators are not currently implemented. |
| `let` | Reserved for a possible additional local-binding form; mutable and immutable locals already use `var`/`final`/`const`. |
| `goto` | Reserved for explicit labeled jumps; an addition is intentionally unlikely. |

## Contextual words

| Word | Context |
|---|---|
| `get`, `set` | member accessors, in classes and object literals (`function get name()`) |
| `operator` | operator method names |
| `from` | JavaScript import clause |
| `of` | `for … of` |
| `step` | range-loop stride |
| `defer` | statement scheduled for block end |
| `out` | marks a covariant type parameter: `Producer<out T>` |
| `get`, `set` in a property | accessors of a property: `var x:T { get => …; set => … }` |
| `extends` after a type parameter | constrains the parameter: `T extends Comparable<T>` |

Outside its special position, a contextual word can remain an identifier.

`nameof` and `unconst` are reserved at expression level, so they cannot be declared as a local or
bare function name. Like other keywords, they remain valid as member names (`obj.nameof()`).

## Primitive and built-in type notation

```text
Int, UInt, Short, Byte, Float, String, Bool, Void
Object, Array<T>, Function, Class<T>, RegExp
PropertyReference<Owner, Value>
Tuple<A, B, ...>
Record<String, V>, Record<'a' | 'b', V>
T?
Null<T>
A | B
'literal' | 'other'
(A, B) -> R
(A | B)?, ((A) -> R)?        parentheses group a type
{ field:T, ?optional:T?, final readonly:T }
Shape & { extra:T }          shapes combined into one
const Cart                   a read-only view (see chapter 5)
T extends A & B              a type parameter with several bounds
Producer<out T>
Consumer<in T>
```

Use the uppercase forms in new code. The lowercase spellings `int`, `uint`, `Boolean`, and `void`
remain ActionScript-compatible aliases. The generated runtime uses JavaScript values.

## Declaration patterns

```actionscript
var x:T = value
final y:T
const z:T = value
static inline final LIMIT:Int = 10

public final class Name<T> extends Parent<T> implements Interface<T>
public abstract class Base
public interface Contract<T>
public class Event<T = EventTarget>
public typedef Shape<T> = { value:T }
public class Cart { public typedef Line = { sku:String } }   // Cart.Line
public enum Kind { A, B = 4 }

public function method(a:T):R
public static constexpr function folded(n:Int):Int
public static consteval function compileOnly(n:Int):Int
public function get property():T
public function set property(value:T):Void
public function operator+(other:This):This
public function ~Resource()
public function count():Int const                           // a const method
public function view():const Cart const                     // returning a read-only view
public function apply(final cart:const Cart):Void           // final and read-only parameter
public var label:String = '' { set => label = value.trim() }  // a property with accessors
public function Name(…)                                     // constructor
[Route('/users', verb = 'POST')] public function create():Void  // attributes
```

Methods and accessors of an object literal use the same words:

```actionscript
var component = {
  count: 0,
  function get double():Int { return this.count * 2 },
  function set value(n:Int):Void { this.count = n },
  async function load():Promise<Void> { … }
}
```

## Control-flow patterns

```actionscript
if (condition) statement else statement
if (var value:T = maybe) statement else statement
while (condition) statement
while (var value:T = maybe) statement
do statement while (condition)
for (var i:Int = 0; i < end; i++) statement
for (var value:T of values) statement
for (var key:String in object) statement
for (var n:Int of 2..=10 step 2) statement
switch (value) { case one: ...; break; default: ... }
defer statement
try { ... } catch (e:Exception) { ... } finally { ... }
```

Array comprehensions are expressions with the same loop forms:

```actionscript
[for (value of values) if (condition) result]
[for (a of xs) for (b of ys) [a, b]]
[for (var i:Int of 0..10 step 2) i * i]
```

## Operators

```text
arithmetic     +  -  *  /  %  **
comparison     ==  !=  ===  !==  <  <=  >  >=
logical        !  &&  ||
null           ??  ?.  ??=
bitwise        ~  &  |  ^  <<  >>  >>>
assignment     =  +=  -=  *=  /=  %=  **=  &=  |=  ^=  <<=  >>=  >>>=
logical assign &&= ||= ??=
update         ++  --
member         .  ?.
conditional    ? :
spread/range   ...  ...?  ..  ..=
type           is  as  typeof  (expr : Type)
other          delete  await  nameof  unconst  void
references     Type::member
```

`==` and `!=` are always strict (`===` and `!==` work and warn), conditions must be `Bool`, `/` gives
a `Float`, and integer `+ - *` wrap at 32 bits (see [chapter 2](02-values-and-syntax.md#operators)).

## Common diagnostics

Every diagnostic has a code; `xenon explain <code>` prints a longer explanation with an example.
The ones met most often:

| Code | Meaning | See |
|---|---|---|
| X0308 | mismatched types: a value doesn't fit where it's used | [3](03-types-and-null-safety.md#how-types-fit-together) |
| X0310 | a condition isn't a `Bool` | [2](02-values-and-syntax.md#conditions-are-bool) |
| X0314 | not every path of a function returns a value | [4](04-control-flow-and-functions.md#functions) |
| X0398 | a value that may be `null` is used as if it weren't | [3](03-types-and-null-safety.md#null-safety) |
| X0420, X0425, X0426 | unknown type, name or member | |
| X0501, X0502, X0510 | a `final`/`const` assigned twice, outside its constructor, or read before it's assigned | [2](02-values-and-syntax.md#declarations), [5](05-classes-and-objects.md#fields) |
| X0603 | a member isn't visible here | [5](05-classes-and-objects.md#visibility) |
| X0720, X0721 | `override` missing, or there is nothing to override | [5](05-classes-and-objects.md#inheritance) |
| X0787, X0788 | an interface member is missing or doesn't match | [6](06-interfaces-and-generics.md#interfaces) |
| X0819 | a non-null field isn't assigned on every constructor path | [3](03-types-and-null-safety.md#null-safety) |
| X0822–X0825 | a scoped value could outlive its owner | [7](07-async-errors-and-resources.md#scoped-destructors) |
| X0861, X0870 | an unused variable or import (warnings) | |
| X0874 | a promise is neither awaited nor kept (warning) | [7](07-async-errors-and-resources.md#forgotten-promises) |
| X0880 | a type argument doesn't satisfy a constraint | [6](06-interfaces-and-generics.md#generic-constraints) |
| X0901–X0905 | a change through `const` (a const method or a read-only view) | [5](05-classes-and-objects.md#const-methods) |

## Current boundaries

Not currently implemented:

- dynamic classes and arbitrary instance properties declared with `dynamic`
- explicit type arguments at every call site when inference cannot determine them
- generator functions using `yield`
- labels for nested `break`/`continue`
- first-class `Range` values
- intersections of classes or interfaces as types (`var x:INamed & ISized`); shapes combine anywhere (`Attrs & { extra:String }`), and `T extends INamed & ISized` works
- `new` and statics through a `Class<T>` value
- overloads in XenonScript code (only native declarations have them)
- a non-null assertion operator (`x!`)
- `const` for the DOM classes, `Event`, `EventTarget`, iterators and `Response` (not checked through `const` views yet)
- owned scoped fields and reassignment-time destruction
- closures proved safe to call only before a scoped owner ends
- async functions returning scoped resources
- macro or AST transformation systems
- `comptime`/`constinit` keywords

For implemented behavior and examples, use this book and the
[`examples/`](../examples) directory. For planned work and detailed design decisions, consult
[`PLAN.md`](../PLAN.md).
