"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useApiErrorMessage } from "@repo/client";
import { useAddDocumentMutation } from "@repo/client/api/ai/add-document";
import { useAssistant } from "@repo/client/api/ai/assistant";
import { useAiDocumentsQuery } from "@repo/client/api/ai/documents";
import { useRemoveDocumentMutation } from "@repo/client/api/ai/remove-document";
import {
  type AiDocument,
  DOCUMENT_CONTENT_MAX_LENGTH,
  DOCUMENT_TITLE_MAX_LENGTH,
  QUESTION_MAX_LENGTH,
} from "@repo/contracts/api";
import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import { Field, FieldError, FieldGroup, FieldLabel } from "@repo/ui/components/field";
import { Skeleton } from "@repo/ui/components/skeleton";
import { Spinner } from "@repo/ui/components/spinner";
import { Textarea } from "@repo/ui/components/textarea";
import { useTranslations } from "next-intl";
import { useId } from "react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import * as z from "zod";
import { TextField } from "@/components/form-fields";
import { authClient } from "@/lib/auth-client";
import { useActiveWorkspace } from "@/modules/workspace";

/** Ask the assistant; manage the documents it answers from. */
export function AssistantPage() {
  return (
    <div className="flex flex-col gap-6">
      <AskCard />
      <DocumentsCard />
    </div>
  );
}

function AskCard() {
  const t = useTranslations("assistant");
  const errorMessage = useApiErrorMessage();
  const assistant = useAssistant();
  const questionId = useId();
  const form = useForm({
    resolver: zodResolver(
      z.object({ question: z.string().trim().min(1).max(QUESTION_MAX_LENGTH) }),
    ),
    defaultValues: { question: "" },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h1>{t("title")}</h1>
        </CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <form
          noValidate
          onSubmit={form.handleSubmit(({ question }) => void assistant.ask(question))}
          className="flex flex-col gap-2"
        >
          <Controller
            control={form.control}
            name="question"
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor={questionId}>{t("question")}</FieldLabel>
                <Textarea
                  {...field}
                  id={questionId}
                  rows={2}
                  placeholder={t("placeholder")}
                  aria-invalid={fieldState.invalid}
                  onKeyDown={(event) => {
                    // Enter asks; Shift+Enter starts a new line.
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void form.handleSubmit(({ question }) => assistant.ask(question))();
                    }
                  }}
                />
              </Field>
            )}
          />
          <Button type="submit" className="self-start" disabled={assistant.status === "streaming"}>
            {t("ask")}
          </Button>
        </form>
        {assistant.status === "idle" ? null : (
          <section aria-live="polite" className="flex flex-col gap-2">
            {assistant.status === "streaming" && !assistant.answer ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner role="presentation" aria-hidden="true" aria-label={undefined} />
                {t("thinking")}
              </p>
            ) : null}
            {/* Plain text only: answers can quote documents, which are never trusted as HTML. */}
            {assistant.answer ? (
              <p className="text-sm whitespace-pre-wrap" data-testid="answer">
                {assistant.answer.trim()}
              </p>
            ) : null}
            {assistant.sources.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                {t("sources")}: {assistant.sources.map((source) => source.title).join(", ")}
              </p>
            ) : null}
            {assistant.status === "error" ? (
              <p role="alert" className="text-sm text-destructive">
                {errorMessage(assistant.error)}
              </p>
            ) : null}
          </section>
        )}
      </CardContent>
    </Card>
  );
}

function DocumentsCard() {
  const t = useTranslations("assistant.documents");

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <DocumentList />
        <AddDocumentForm />
      </CardContent>
    </Card>
  );
}

function DocumentList() {
  const t = useTranslations("assistant.documents");
  const errorMessage = useApiErrorMessage();
  const documents = useAiDocumentsQuery();
  // Here, not in each row: the row is gone once its removal lands, and must still say so.
  const remove = useRemoveDocumentMutation();

  if (documents.isPending) {
    return <Skeleton className="h-16" />;
  }
  if (documents.isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {errorMessage(documents.error)}
      </p>
    );
  }
  if (documents.data.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("none")}</p>;
  }
  return (
    <ul className="flex flex-col divide-y">
      {documents.data.map((document) => (
        <DocumentItem key={document.id} document={document} remove={remove} />
      ))}
    </ul>
  );
}

function DocumentItem({
  document,
  remove,
}: {
  document: AiDocument;
  remove: ReturnType<typeof useRemoveDocumentMutation>;
}) {
  const t = useTranslations("assistant.documents");
  const errorMessage = useApiErrorMessage();
  const workspace = useActiveWorkspace();
  const { data: session } = authClient.useSession();
  const mayRemove = workspace.isAdmin || document.createdBy === session?.user.id;

  let detail: string | null = null;
  if (document.status === "ready") {
    detail = t("passages", { count: document.chunkCount });
  } else if (document.status === "failed" && document.error) {
    detail = errorMessage({ code: document.error });
  }

  return (
    <li className="flex items-center justify-between gap-3 py-2">
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium">{document.title}</span>
        <span className="text-xs text-muted-foreground">{detail}</span>
        {document.summary ? (
          <p className="line-clamp-2 text-xs text-muted-foreground">{document.summary}</p>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <Badge variant={document.status === "failed" ? "destructive" : "secondary"}>
          {t(`status.${document.status}`)}
        </Badge>
        {mayRemove ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={remove.isPending}
            aria-label={`${t("remove")}: ${document.title}`}
            onClick={() =>
              remove.mutate(
                { documentId: document.id },
                {
                  onSuccess: () => toast.success(t("removed")),
                  onError: (error) => toast.error(errorMessage(error)),
                },
              )
            }
          >
            {t("remove")}
          </Button>
        ) : null}
      </div>
    </li>
  );
}

function AddDocumentForm() {
  const t = useTranslations("assistant.documents");
  const errorMessage = useApiErrorMessage();
  const add = useAddDocumentMutation();
  const contentId = useId();
  const form = useForm({
    resolver: zodResolver(
      z.object({
        title: z.string().trim().min(1).max(DOCUMENT_TITLE_MAX_LENGTH),
        content: z.string().trim().min(1).max(DOCUMENT_CONTENT_MAX_LENGTH),
      }),
    ),
    defaultValues: { title: "", content: "" },
  });

  return (
    <form
      noValidate
      onSubmit={form.handleSubmit((values) =>
        add.mutateAsync(values).then(
          () => {
            form.reset();
            toast.success(t("added"));
          },
          (error: unknown) => toast.error(errorMessage(error)),
        ),
      )}
    >
      <FieldGroup>
        <TextField control={form.control} name="title" label={t("docTitle")} />
        <Controller
          control={form.control}
          name="content"
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor={contentId}>{t("content")}</FieldLabel>
              <Textarea {...field} id={contentId} rows={6} aria-invalid={fieldState.invalid} />
              {fieldState.error ? <FieldError errors={[fieldState.error]} /> : null}
            </Field>
          )}
        />
        <Button type="submit" className="self-start" disabled={form.formState.isSubmitting}>
          {t("add")}
        </Button>
      </FieldGroup>
    </form>
  );
}
