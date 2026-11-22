# Chapter 12: Language quick reference

## Reserved words

### Declarations and structure

`package`, `import`, `class`, `interface`, `enum`, `typedef`, `extends`, `implements`,
`function`, `var`, `const`, `final`, `using`

### Modifiers

`public`, `private`, `protected`, `internal`, `static`, `inline`, `constexpr`, `consteval`,
`abstract`, `override`, `dynamic`, `async`, `native`

`dynamic` is reserved but not implemented. `const` can also be a method suffix.

### Control flow and exceptions

`if`, `else`, `switch`, `case`, `default`, `while`, `do`, `for`, `in`, `break`, `continue`,
`return`, `throw`, `try`, `catch`, `finally`

### Expressions and literals

`new`, `this`, `super`, `is`, `as`, `typeof`, `delete`, `await`,
`true`, `false`, `null`, `undefined`, `void`

`undefined` is supported for compatibility, but every use warns; XenonScript uses `null`.

### Reserved for later

`namespace`, `use`, `with`, `yield`, `let`, `goto`

Reservation does not mean implementation. `with` and `goto` are intentionally unlikely additions.

## Contextual words

| Word | Context |
|---|---|
| `get`, `set` | member accessors |
| `operator` | operator method names |
| `from` | JavaScript import clause |
| `of` | `for … of` |
| `step` | range-loop stride |
| `defer` | statement scheduled for block end |
| `static` | block inside a class |
| `nameof` | compile-time symbol-name operator unless shadowed |

Outside its special position, a contextual word can remain an identifier.

## Primitive and built-in type notation

```text
Int, UInt, Float, String, Bool, Void
Object, Array<T>, Function, Class<T>, RegExp
Tuple<A, B, ...>
T?
Null<T>
A | B
'literal' | 'other'
(A, B) -> R
{ field:T, ?optional:T?, final readonly:T }
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
public typedef Shape<T> = { value:T }
public enum Kind { A, B = 4 }

public function method(a:T):R
public static constexpr function folded(n:Int):Int
public static consteval function compileOnly(n:Int):Int
public function get property():T
public function set property(value:T):Void
public function operator+(other:This):This
public function ~Resource()
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
spread/range   ...  ..  ..=
type           is  as  typeof
other          delete  await  nameof
```

## Current boundaries

Not currently implemented:

- dynamic classes and arbitrary instance properties declared with `dynamic`
- explicit type arguments at every call site when inference cannot determine them
- generator functions using `yield`
- labels for nested `break`/`continue`
- first-class `Range` values
- type-parameter bounds
- generic methods with full user-defined constraints
- transitive `const T` read-only types
- owned scoped fields and reassignment-time destruction
- closures proved safe to call only before a scoped owner ends
- async functions returning scoped resources
- macro or AST transformation systems
- `comptime`/`constinit` keywords

For implemented behavior and examples, use this book and the
[`examples/`](../examples) directory. For planned work and detailed design decisions, consult
[`PLAN.md`](../PLAN.md).
