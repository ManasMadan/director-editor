"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useApiErrorMessage } from "@repo/client";
import { useTodoCreateMutation } from "@repo/client/api/todo/create";
import { useTodoDeleteMutation } from "@repo/client/api/todo/delete";
import { useTodoListInfiniteQuery } from "@repo/client/api/todo/list";
import { useTodoSetCompletedMutation } from "@repo/client/api/todo/set-completed";
import { createTodoInput, type Todo } from "@repo/contracts/api";
import { Button } from "@repo/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import { Checkbox } from "@repo/ui/components/checkbox";
import { Field, FieldError } from "@repo/ui/components/field";
import { Input } from "@repo/ui/components/input";
import { Skeleton } from "@repo/ui/components/skeleton";
import { Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import type * as z from "zod";

export function TodoList() {
  const t = useTranslations("dashboard.todos");
  const errorMessage = useApiErrorMessage();
  const todos = useTodoListInfiniteQuery();
  const create = useTodoCreateMutation();
  // Here, not in each row: a row gone from the list (deleted elsewhere) must still say why.
  const setCompleted = useTodoSetCompletedMutation();
  const remove = useTodoDeleteMutation();
  // The same schema the API validates with; limits can't drift between client and server.
  const form = useForm<z.input<typeof createTodoInput>>({
    resolver: zodResolver(createTodoInput),
    defaultValues: { title: "" },
  });
  const onError = (error: unknown) => toast.error(errorMessage(error));
  const items = todos.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <form
          className="flex items-start gap-2"
          noValidate
          onSubmit={form.handleSubmit((values) =>
            create.mutateAsync(values).then(() => form.reset(), onError),
          )}
        >
          <Controller
            control={form.control}
            name="title"
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid} className="flex-1">
                <Input
                  aria-label={t("title")}
                  placeholder={t("placeholder")}
                  aria-invalid={fieldState.invalid}
                  {...field}
                />
                <FieldError errors={[fieldState.error]} />
              </Field>
            )}
          />
          <Button type="submit" disabled={create.isPending}>
            {t("add")}
          </Button>
        </form>

        {todos.isPending ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-9" />
            <Skeleton className="h-9" />
          </div>
        ) : null}
        {!todos.isPending && items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        ) : null}
        {items.length > 0 ? (
          <ul className="flex flex-col divide-y">
            {items.map((todo) => (
              <TodoItem
                key={todo.id}
                todo={todo}
                setCompleted={setCompleted}
                remove={remove}
                onError={onError}
              />
            ))}
          </ul>
        ) : null}
        {todos.hasNextPage ? (
          <Button
            variant="outline"
            onClick={() => todos.fetchNextPage()}
            disabled={todos.isFetchingNextPage}
          >
            {t("loadMore")}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** One todo: ticked off, or deleted, in place. */
function TodoItem({
  todo,
  setCompleted,
  remove,
  onError,
}: {
  todo: Todo;
  setCompleted: ReturnType<typeof useTodoSetCompletedMutation>;
  remove: ReturnType<typeof useTodoDeleteMutation>;
  onError: (error: unknown) => void;
}) {
  const t = useTranslations("dashboard.todos");
  return (
    <li className="flex items-center gap-3 py-2">
      <Checkbox
        id={`todo-${todo.id}`}
        checked={todo.completed}
        onCheckedChange={(checked) =>
          setCompleted.mutate(
            { id: todo.id, completed: checked === true, version: todo.version },
            { onError },
          )
        }
      />
      <label
        htmlFor={`todo-${todo.id}`}
        className={todo.completed ? "flex-1 text-muted-foreground line-through" : "flex-1"}
      >
        {todo.title}
      </label>
      <Button
        variant="ghost"
        size="icon"
        aria-label={t("delete", { title: todo.title })}
        onClick={() => remove.mutate({ id: todo.id }, { onError })}
      >
        <Trash2 />
      </Button>
    </li>
  );
}
