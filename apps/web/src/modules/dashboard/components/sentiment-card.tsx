"use client";

import { useApiErrorMessage } from "@repo/client";
import { useAiSentimentMutation } from "@repo/client/api/ai/sentiment";
import { useSystemInfoQuery } from "@repo/client/api/system/info";
import { SENTIMENT_TEXT_MAX_LENGTH } from "@repo/contracts/api";
import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import { Textarea } from "@repo/ui/components/textarea";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";

export function SentimentCard() {
  const t = useTranslations("dashboard.ai");
  const errorMessage = useApiErrorMessage();
  const { data: system } = useSystemInfoQuery();
  const sentiment = useAiSentimentMutation();
  const [text, setText] = useState("");
  const enabled = system?.features.ai ?? false;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{enabled ? t("description") : t("disabled")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            sentiment.mutate({ text }, { onError: (error) => toast.error(errorMessage(error)) });
          }}
        >
          <Textarea
            aria-label={t("title")}
            placeholder={t("placeholder")}
            value={text}
            maxLength={SENTIMENT_TEXT_MAX_LENGTH}
            onChange={(event) => setText(event.target.value)}
            disabled={!enabled}
          />
          <Button type="submit" disabled={!enabled || !text.trim() || sentiment.isPending}>
            {t("analyze")}
          </Button>
          {sentiment.data ? (
            <p className="flex items-center gap-2 text-sm" aria-live="polite">
              <Badge>{t(`labels.${sentiment.data.label}`)}</Badge>
              {t("result", {
                score: Math.round(sentiment.data.score * 100),
                model: sentiment.data.model,
              })}
            </p>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}
