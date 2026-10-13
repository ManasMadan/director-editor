"use client";

import { Button } from "@repo/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/ui/components/dialog";
import { useTranslations } from "next-intl";
import { useState } from "react";

/** Shows a secret (a webhook signing secret, an API key) exactly once, with a copy button. */
export function SecretDialog({
  secret,
  onClose,
  labels = "workspace.webhooks.secret",
  testId = "webhook-secret",
}: {
  secret: string | null;
  onClose: () => void;
  labels?: "workspace.webhooks.secret" | "workspace.apiKeys.key";
  testId?: string;
}) {
  const t = useTranslations(labels);
  const [copied, setCopied] = useState(false);
  return (
    <Dialog open={secret !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("once")}</DialogDescription>
        </DialogHeader>
        <code className="rounded-md bg-muted p-3 font-mono text-sm break-all" data-testid={testId}>
          {secret}
        </code>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={async () => {
              // Only reachable while open, that is with a secret to show.
              await navigator.clipboard.writeText(String(secret));
              setCopied(true);
            }}
          >
            {copied ? t("copied") : t("copy")}
          </Button>
          <Button onClick={onClose}>{t("done")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
