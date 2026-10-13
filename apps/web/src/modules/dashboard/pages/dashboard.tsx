"use client";

import { useMeQuery } from "@repo/client/api/user/me";
import { Skeleton } from "@repo/ui/components/skeleton";
import { useTranslations } from "next-intl";
import { SentimentCard } from "../components/sentiment-card";
import { TodoList } from "../components/todo-list";

export function DashboardPage() {
  const t = useTranslations("dashboard");
  const { data: me } = useMeQuery();
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">
        {me ? t("greeting", { name: me.name }) : <Skeleton className="h-8 w-40" />}
      </h1>
      <div className="grid gap-6 md:grid-cols-2">
        <TodoList />
        <SentimentCard />
      </div>
    </div>
  );
}
