/**
 * Cursor pagination, the only pagination in this API. Lists are ordered by UUIDv7 id
 * (time-ordered), newest first; `cursor` is the id of the last item already seen.
 * Offset pagination is not offered: it gets slower with depth and skips or repeats rows
 * when data changes between pages.
 */
import * as z from "zod";

const PAGE_SIZE_MAX = 100;

export const pageInput = z.object({
  limit: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(20),
  cursor: z.uuid().optional(),
});
export type PageInput = z.infer<typeof pageInput>;

export const page = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item),
    /** Pass as `cursor` to get the next page; null when there are no more items. */
    nextCursor: z.uuid().nullable(),
  });

/**
 * Builds a page from `limit + 1` rows fetched in order: the extra row only tells us
 * whether another page exists.
 */
export function toPage<T extends { id: string }>(rows: T[], limit: number) {
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null };
}
