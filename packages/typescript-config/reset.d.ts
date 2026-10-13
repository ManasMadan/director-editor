// Safer built-in types in every package (@total-typescript/ts-reset): JSON.parse and
// Response.json() return unknown, so their result must be parsed or narrowed; .filter
// (Boolean) narrows; includes/indexOf/has take any value of the element's kind.
import "@total-typescript/ts-reset";
