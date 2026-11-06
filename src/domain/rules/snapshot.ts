// One-shot snapshot of rule input (TOCTOU defence). Copies plain data, reading every property
// exactly once through its property descriptor and never invoking getters, so a stateful
// getter or a lying proxy cannot show different values to different rules.
// Anything that is not plain JSON-like data throws, and the caller fails closed.

const MAX_DEPTH = 8;
const MAX_ARRAY_LENGTH = 1000;

function copy(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) throw new Error("input too deeply nested");
  switch (typeof value) {
    case "string":
    case "boolean":
    case "undefined":
      return value;
    case "number":
      return value;
    case "object":
      break;
    default:
      throw new Error("input contains a function, symbol or bigint");
  }
  if (value === null) return null;

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) throw new Error("array subclass");
    const lenDesc = Object.getOwnPropertyDescriptor(value, "length");
    const len: unknown = lenDesc?.value;
    if (typeof len !== "number" || !Number.isInteger(len) || len < 0 || len > MAX_ARRAY_LENGTH) {
      throw new Error("invalid array length");
    }
    const out: unknown[] = new Array<unknown>(len); // holes stay holes; scoring rejects them
    for (let i = 0; i < len; i++) {
      const d = Object.getOwnPropertyDescriptor(value, String(i));
      if (d === undefined) continue;
      if (d.get || d.set) throw new Error("accessor property in input");
      out[i] = copy(d.value, depth + 1);
    }
    return out;
  }

  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new Error("non-plain object");
  if (Object.getOwnPropertySymbols(value).length > 0) throw new Error("symbol keys");
  const out: Record<string, unknown> = {};
  for (const key of Object.getOwnPropertyNames(value)) {
    if (key === "__proto__") throw new Error("__proto__ key");
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (d === undefined) continue;
    if (d.get || d.set) throw new Error("accessor property in input");
    Object.defineProperty(out, key, {
      value: copy(d.value, depth + 1),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

/** Returns a plain, stable deep copy, or throws if the input is not plain data. */
export function snapshotInput<T>(input: T): T {
  return copy(input, 0) as T;
}
