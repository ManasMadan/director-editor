import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import type { ReactNode } from "react";

/** The frame every auth screen uses. */
export function AuthCard({
  title,
  description,
  children,
}: {
  title: string;
  description: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto mt-8 w-full max-w-sm">
      <Card>
        <CardHeader>
          {/* The page's one top heading: the card is all an auth page has. */}
          <CardTitle role="heading" aria-level={1}>
            {title}
          </CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </div>
  );
}
