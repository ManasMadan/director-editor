/**
 * A provider's event as a JSON column stores it. Events arrive as JSON, but Prisma's JSON
 * input type can't see that through a library's interfaces, so they're parsed back into
 * JSON rather than cast.
 */
import type { Prisma } from "@repo/db";
import * as z from "zod";

export const jsonObject: z.ZodType<Prisma.InputJsonObject> = z.record(z.string(), z.json());
