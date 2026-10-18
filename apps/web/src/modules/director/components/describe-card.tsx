"use client";

import { buttonVariants } from "@repo/ui/components/button";
import { PenLine } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useId } from "react";

/** "Describe your own": the library's door to a template the member describes. */
export function DescribeCard() {
  const t = useTranslations("library.describe");
  const id = useId();
  return (
    <section
      aria-labelledby={id}
      className="flex flex-col gap-4 rounded-3xl border border-studio-foreground/15 p-5"
    >
      <div className="flex flex-col gap-1.5">
        <h2 id={id} className="flex items-center gap-2 text-lg font-semibold">
          <PenLine className="size-5 text-aurora-2" aria-hidden />
          {t("title")}
        </h2>
        <p className="text-sm text-studio-foreground/70">{t("body")}</p>
      </div>
      <Link
        href="/create"
        className={buttonVariants({
          className:
            "h-11 self-start rounded-xl bg-studio-foreground px-5 text-studio hover:bg-studio-foreground/90",
        })}
      >
        {t("start")}
      </Link>
    </section>
  );
}
