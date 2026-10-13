"use client";

import { useApiErrorMessage } from "@repo/client";
import { useLookupShortMutation } from "@repo/client/api/shorts/lookup";
import { SHORT_URL_MAX_LENGTH } from "@repo/contracts/api";
import { Button } from "@repo/ui/components/button";
import { Input } from "@repo/ui/components/input";
import { Link2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";

/** Open any short from its link: the trend someone wants to copy may not be in the feed. */
export function PasteLink() {
  const t = useTranslations("shorts.paste");
  const errorMessage = useApiErrorMessage();
  const router = useRouter();
  const lookup = useLookupShortMutation();
  const [link, setLink] = useState("");
  const id = useId();
  return (
    <form
      className="flex flex-col gap-1 px-4 pb-4"
      onSubmit={(event) => {
        event.preventDefault();
        lookup.mutate(
          { url: link },
          { onSuccess: (short) => router.push(`/shorts/${short.videoId}`) },
        );
      }}
    >
      <label htmlFor={id} className="text-xs text-studio-foreground/60">
        {t("label")}
      </label>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Link2
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-studio-foreground/50"
            aria-hidden
          />
          <Input
            id={id}
            value={link}
            onChange={(event) => setLink(event.target.value)}
            placeholder={t("placeholder")}
            maxLength={SHORT_URL_MAX_LENGTH}
            inputMode="url"
            className="border-studio-foreground/20 bg-studio-foreground/5 pl-8 text-studio-foreground"
            aria-invalid={lookup.isError || undefined}
          />
        </div>
        <Button type="submit" variant="secondary" disabled={!link.trim() || lookup.isPending}>
          {t("submit")}
        </Button>
      </div>
      {lookup.isError ? (
        <p role="alert" className="text-xs text-studio-error">
          {errorMessage(lookup.error)}
        </p>
      ) : null}
    </form>
  );
}
