/**
 * Checks for what TypeScript types more loosely than the code knows it to be, instead of
 * casts. `Object.keys` says `string[]`, because an object may have more keys than its
 * type names, so `keysOf` checks each key; `fieldOf` reads a field of a thrown value;
 * `required` is a value the code knows is there, and says which when it isn't.
 */

/** Whether `key` is one of the object's own keys. */
export function hasKey<T extends object>(object: T, key: PropertyKey): key is keyof T {
  return Object.hasOwn(object, key);
}

/** The object's own keys, typed as its keys. */
export function keysOf<T extends object>(object: T): (keyof T & string)[] {
  return Object.keys(object).filter((key): key is keyof T & string => hasKey(object, key));
}

/** The object's own entries, typed by its keys. */
export function entriesOf<T extends object>(object: T): [keyof T & string, T[keyof T & string]][] {
  return keysOf(object).map((key) => [key, object[key]]);
}

/**
 * A field of a value whose type isn't known, like a thrown error's `code`: undefined when
 * the value isn't an object or has no such field.
 */
export function fieldOf(value: unknown, key: string): unknown {
  return hasField(value, key) ? value[key] : undefined;
}

function hasField<K extends string>(value: unknown, key: K): value is Record<K, unknown> {
  return typeof value === "object" && value !== null && key in value;
}

/**
 * A value the code knows is present (the first of a list it just checked, a field a
 * library types as optional but always sets, a variable the environment's schema
 * requires when its feature is on). Throws, naming it, if it isn't.
 */
export function required<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`${what} is missing`);
  }
  return value;
}
