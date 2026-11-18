/** JavaScript globals usable from Klass code, all typed `*` (A0/A7). `Error` and its subclasses are deliberately absent (A6c). */
export const JS_GLOBALS = new Set([
  "console", "Math", "Object", "Array", "Symbol", "Date", "RegExp", "Map", "Set", "WeakMap", "WeakSet",
  "WeakRef", "Proxy", "Reflect", "Intl", "BigInt", "ArrayBuffer", "DataView", "Uint8Array", "Int8Array",
  "Uint16Array", "Int16Array", "Uint32Array", "Int32Array", "Float32Array", "Float64Array", "TextEncoder", "TextDecoder",
  "URL", "URLSearchParams", "AbortController", "AbortSignal", "Blob", "FormData", "Headers", "Request", "Response",
  "fetch", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "queueMicrotask", "structuredClone",
  "globalThis", "process", "Bun", "document", "window", "navigator", "location", "localStorage", "performance",
  "crypto", "atob", "btoa", "encodeURIComponent", "decodeURIComponent", "encodeURI", "decodeURI",
  "isNaN", "isFinite", "parseInt", "parseFloat", "NaN", "Infinity",
  "EventTarget", "Event", "CustomEvent", "MessageChannel", "MessagePort", "BroadcastChannel", "WebSocket", "Worker",
  "ReadableStream", "WritableStream", "TransformStream", "File", "FileReader", "Intl", "WeakRef", "FinalizationRegistry",
  "AsyncDisposableStack", "DisposableStack", "requestAnimationFrame", "cancelAnimationFrame", "alert", "HTMLElement",
]);
