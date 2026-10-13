/**
 * `cn` merges class names and resolves Tailwind conflicts (`cn("p-2", "p-4")` → "p-4").
 * Re-exported from shadcn's compiled `cn` package (a faster clsx + tailwind-merge) so
 * components can import it from `@repo/ui/lib/utils` as well as from "cn".
 */
export { cn } from "cn";
