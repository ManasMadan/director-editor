import type { Short } from "@repo/contracts/api";
import Image from "next/image";
import Link from "next/link";
import { useTranslations } from "next-intl";

/** A short in a grid: its picture in portrait, title and views, as on YouTube. */
export function ShortCard({ short }: { short: Short }) {
  const t = useTranslations("shorts");
  return (
    <Link href={`/shorts/${short.videoId}`} className="group flex flex-col gap-1.5">
      <div className="relative aspect-9/16 overflow-hidden rounded-xl bg-studio-foreground/10">
        {/* YouTube's own thumbnails, already sized: nothing for Next's optimizer to do. */}
        <Image
          src={short.thumbnailUrl}
          alt=""
          fill
          unoptimized
          sizes="(max-width: 640px) 50vw, 200px"
          className="object-cover transition-transform group-hover:scale-105"
        />
      </div>
      <p className="line-clamp-2 text-sm font-medium leading-snug">{short.title}</p>
      {short.viewCount !== null ? (
        <p className="text-xs text-studio-foreground/60">
          {t("views", { count: short.viewCount })}
        </p>
      ) : null}
    </Link>
  );
}
