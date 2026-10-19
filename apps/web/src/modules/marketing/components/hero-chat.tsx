import { cn } from "@repo/ui/lib/utils";
import { getTranslations } from "next-intl/server";
import { HeroLoop } from "./hero-loop";

/*
 * The hero: a conversation with Director over a selfie frame, looping in CSS alone
 * (landing.css), so it costs no JavaScript and nothing to download on a slow network.
 * Director asks for the market, you'd rather stay in, it says "inside it is" and the shot
 * card changes: the whole product in one exchange. The selfie is drawn, not a photo: the
 * frame stands for whoever is watching, and no creator's face plays them.
 *
 * Every line is real text in reading order, so a screen reader reads the exchange once,
 * as a list, and then the shot card as it ends up (the card sits after the exchange in
 * the page, though it's drawn at the top of the frame; the card it changes from is
 * hidden from it, being the past). With reduced motion, the frame rests on the end of the
 * exchange; otherwise a button below it pauses the loop (hero-loop.tsx).
 */

const bubble = "max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-snug shadow-lg";

export async function HeroChat() {
  const t = await getTranslations("home.hero");
  return (
    <HeroLoop pauseLabel={t("pause")}>
      <div className="relative mx-auto aspect-9/16 w-full max-w-72 overflow-hidden rounded-[2rem] border-4 border-studio-foreground/15 bg-live-night text-studio-foreground shadow-2xl">
        {/* The selfie: a head and shoulders by a window's light. */}
        <div aria-hidden className="absolute inset-0">
          <div className="absolute inset-y-0 right-0 w-2/5 bg-linear-to-l from-aurora-1/25 to-transparent" />
          <div className="absolute top-[24%] left-1/2 size-[34%] -translate-x-1/2 rounded-full bg-studio-foreground/20" />
          <div className="absolute top-[52%] left-1/2 h-1/2 w-[78%] -translate-x-1/2 rounded-t-[45%] bg-studio-foreground/15" />
        </div>
        <ol className="absolute inset-x-3 bottom-4 flex flex-col gap-2">
          <li className={cn(bubble, "hero-say-1 self-start bg-studio/85")}>
            <span className="sr-only">{t("director")} </span>
            {t("ask")}
          </li>
          <li className={cn(bubble, "hero-say-2 self-end bg-studio-foreground text-studio")}>
            <span className="sr-only">{t("you")} </span>
            {t("answer")}
          </li>
          <li className={cn(bubble, "hero-say-3 self-start bg-studio/85")}>
            <span className="sr-only">{t("director")} </span>
            {t("adapt")}
          </li>
        </ol>
        <div className="absolute inset-x-3 top-3 flex items-start justify-between gap-2">
          <p className="grid min-w-0 text-xs font-medium">
            <span
              aria-hidden
              className="hero-before col-start-1 row-start-1 rounded-full bg-studio/70 px-2.5 py-1 backdrop-blur"
            >
              {t("cardBefore")}
            </span>
            <span className="hero-after col-start-1 row-start-1 rounded-full bg-studio/70 px-2.5 py-1 backdrop-blur">
              {t("cardAfter")}{" "}
              <span aria-hidden className="text-guide">
                ✓
              </span>
            </span>
          </p>
          <p
            aria-hidden
            className="flex shrink-0 items-center gap-1.5 rounded-full bg-studio/70 px-2 py-1 font-mono text-xs whitespace-nowrap tabular-nums backdrop-blur"
          >
            <span className="hero-rec size-2 rounded-full bg-record motion-safe:animate-pulse" />
            {t("rec")}
          </p>
        </div>
      </div>
      <figcaption className="text-center text-sm text-pretty text-muted-foreground">
        {t("caption")}
      </figcaption>
    </HeroLoop>
  );
}
