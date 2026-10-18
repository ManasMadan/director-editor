/**
 * A shot of a plan as the landing's x-ray prints it: real JSON, laid out the way a person
 * would write it by hand (a small object or list on one line, a big one opened up), and
 * split into tokens so keys, strings and numbers can be told apart at a glance. Each line
 * knows which of the shot's fields it shows, so the panel can light up the field that the
 * phone beside it is drawing.
 */

type JsonToken = {
  kind: "key" | "string" | "number" | "punctuation" | "space";
  text: string;
};

export interface JsonLine {
  /** From 1, as an editor counts them. */
  number: number;
  tokens: JsonToken[];
  /** The top-level field this line belongs to; null for the outer braces. */
  field: string | null;
}

const punctuation = (text: string): JsonToken => ({ kind: "punctuation", text });

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function leaf(value: unknown): JsonToken {
  if (typeof value === "string") {
    return { kind: "string", text: JSON.stringify(value) };
  }
  return { kind: typeof value === "number" ? "number" : "punctuation", text: String(value) };
}

function separated(parts: JsonToken[][]): JsonToken[] {
  return parts.flatMap((part, index) => (index === 0 ? part : [punctuation(", "), ...part]));
}

const keyTokens = (key: string): JsonToken[] => [
  { kind: "key", text: JSON.stringify(key) },
  punctuation(": "),
];

/** The value on a single line. */
function inline(value: unknown): JsonToken[] {
  if (Array.isArray(value)) {
    return [punctuation("["), ...separated(value.map(inline)), punctuation("]")];
  }
  if (isObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      return [punctuation("{}")];
    }
    const members = entries.map(([key, member]) => [...keyTokens(key), ...inline(member)]);
    return [punctuation("{ "), ...separated(members), punctuation(" }")];
  }
  return [leaf(value)];
}

const width = (tokens: JsonToken[]) => tokens.reduce((sum, token) => sum + token.text.length, 0);

/** A member (`key` is null in a list) on one line if it fits, opened up if it doesn't. */
function member(
  key: string | null,
  value: unknown,
  depth: number,
  comma: boolean,
  maxWidth: number,
): JsonToken[][] {
  const indent: JsonToken[] = depth > 0 ? [{ kind: "space", text: "  ".repeat(depth) }] : [];
  const head = [...indent, ...(key === null ? [] : keyTokens(key))];
  const tail = comma ? [punctuation(",")] : [];
  const flat = [...head, ...inline(value), ...tail];
  const children: [string | null, unknown][] = Array.isArray(value)
    ? value.map((item) => [null, item])
    : Object.entries(isObject(value) ? value : {});
  if (width(flat) <= maxWidth || children.length === 0) {
    return [flat];
  }
  const [open, close] = Array.isArray(value) ? ["[", "]"] : ["{", "}"];
  return [
    [...head, punctuation(open)],
    ...children.flatMap(([childKey, child], index) =>
      member(childKey, child, depth + 1, index < children.length - 1, maxWidth),
    ),
    [...indent, punctuation(close), ...tail],
  ];
}

/** `shot`'s lines, none wider than `maxWidth` characters unless one value is longer. */
export function jsonLines(shot: Record<string, unknown>, maxWidth: number): JsonLine[] {
  const entries = Object.entries(shot);
  const body = entries.flatMap(([field, value], index) =>
    member(field, value, 1, index < entries.length - 1, maxWidth).map((tokens) => ({
      tokens,
      field,
    })),
  );
  const lines = [
    { tokens: [punctuation("{")], field: null },
    ...body,
    { tokens: [punctuation("}")], field: null },
  ];
  return lines.map((line, index) => ({ number: index + 1, ...line }));
}
