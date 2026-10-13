import { zodResolver } from "@hookform/resolvers/zod";
import { useApiErrorMessage } from "@repo/client";
import { useTodoCreateMutation } from "@repo/client/api/todo/create";
import { useTodoDeleteMutation } from "@repo/client/api/todo/delete";
import { useTodoListInfiniteQuery } from "@repo/client/api/todo/list";
import { useTodoSetCompletedMutation } from "@repo/client/api/todo/set-completed";
import { createTodoInput, type Todo } from "@repo/contracts/api";
import { Trash2 } from "lucide-react-native";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { FlatList, RefreshControl, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTranslations } from "use-intl";
import type * as z from "zod";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";

/** The workspace's todos: the same data, rules and hooks as the web dashboard. */
export default function Todos() {
  const t = useTranslations("dashboard.todos");
  const errorMessage = useApiErrorMessage();
  const todos = useTodoListInfiniteQuery();
  const create = useTodoCreateMutation();
  // Here, not in each row: a row gone from the list (deleted elsewhere) must still say why.
  const setCompleted = useTodoSetCompletedMutation();
  const remove = useTodoDeleteMutation();
  const [failure, setFailure] = useState<string>();
  // The same schema the API validates with.
  const form = useForm<z.input<typeof createTodoInput>>({
    resolver: zodResolver(createTodoInput),
    defaultValues: { title: "" },
  });
  const onError = (error: unknown) => setFailure(errorMessage(error));
  const items = todos.data?.pages.flatMap((page) => page.items) ?? [];

  const add = form.handleSubmit((values) => {
    setFailure(undefined);
    return create.mutateAsync(values).then(() => form.reset(), onError);
  });

  return (
    <SafeAreaView className="flex-1 bg-background">
      <FlatList
        data={items}
        keyExtractor={(todo) => todo.id}
        contentContainerClassName="gap-2 p-6"
        refreshControl={
          <RefreshControl refreshing={todos.isRefetching} onRefresh={() => todos.refetch()} />
        }
        // A page already loading is reused, not cancelled and asked for again.
        onEndReached={() => todos.hasNextPage && todos.fetchNextPage({ cancelRefetch: false })}
        ListHeaderComponent={
          <View className="gap-4 pb-2">
            <Text role="heading" variant="h3">
              {t("title")}
            </Text>
            <View className="flex-row items-start gap-2">
              <Controller
                control={form.control}
                name="title"
                render={({ field, fieldState }) => (
                  <View className="flex-1 gap-1">
                    <Input
                      accessibilityLabel={t("title")}
                      placeholder={t("placeholder")}
                      value={field.value}
                      onChangeText={field.onChange}
                      onBlur={field.onBlur}
                      onSubmitEditing={add}
                      aria-invalid={Boolean(fieldState.error)}
                    />
                    {fieldState.error?.message ? (
                      <Text role="alert" className="text-sm text-destructive">
                        {fieldState.error.message}
                      </Text>
                    ) : null}
                  </View>
                )}
              />
              <Button onPress={add} disabled={create.isPending}>
                <Text>{t("add")}</Text>
              </Button>
            </View>
            {failure ? (
              <Text role="alert" className="text-destructive">
                {failure}
              </Text>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          todos.isPending ? null : <Text className="text-muted-foreground">{t("empty")}</Text>
        }
        renderItem={({ item: todo }) => (
          <TodoRow todo={todo} setCompleted={setCompleted} remove={remove} onError={onError} />
        )}
      />
    </SafeAreaView>
  );
}

/** One todo: ticked off, or deleted, in place. */
function TodoRow({
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
    <View className="flex-row items-center gap-3 py-1">
      <Checkbox
        accessibilityLabel={todo.title}
        checked={todo.completed}
        onCheckedChange={(checked: boolean) =>
          setCompleted.mutate(
            { id: todo.id, completed: checked, version: todo.version },
            { onError },
          )
        }
      />
      <Text className={todo.completed ? "flex-1 text-muted-foreground line-through" : "flex-1"}>
        {todo.title}
      </Text>
      <Button
        variant="ghost"
        size="icon"
        accessibilityLabel={t("delete", { title: todo.title })}
        onPress={() => remove.mutate({ id: todo.id }, { onError })}
      >
        <Icon as={Trash2} />
      </Button>
    </View>
  );
}
