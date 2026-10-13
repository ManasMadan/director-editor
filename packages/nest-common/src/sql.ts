/**
 * Raw SQL results, parsed. `$queryRaw<T>` only asserts what the columns are, so one
 * renamed or retyped in a migration turns into `undefined` far from the query; parsed
 * here, it fails at the query, naming the column.
 *
 *   const users = await rows(userRow, db.$queryRaw`SELECT id, email FROM ...`);
 *   const { n } = await row(z.object({ n: z.bigint() }), db.$queryRaw`SELECT f() AS n`);
 */
import * as z from "zod";

export async function rows<T>(schema: z.ZodType<T>, query: Promise<unknown>): Promise<T[]> {
  return z.array(schema).parse(await query);
}

/** The single row a query returns: a function call's result, an INSERT … RETURNING. */
export async function row<T>(schema: z.ZodType<T>, query: Promise<unknown>): Promise<T> {
  const [only] = z.tuple([schema]).parse(await query);
  return only;
}
