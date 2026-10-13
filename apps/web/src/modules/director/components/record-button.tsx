"use client";

import { cn } from "@repo/ui/lib/utils";

/** Director's big red button: a circle to record, a square to stop, a ring for a photo. */
export function RecordButton({
  label,
  mode,
  onClick,
  disabled,
}: {
  label: string;
  mode: "record" | "stop" | "photo";
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="flex size-20 items-center justify-center rounded-full border-4 border-studio-foreground/80 transition-transform active:scale-95 disabled:opacity-40"
    >
      <span
        className={cn(
          "bg-record transition-all",
          mode === "stop" ? "size-8 rounded-md" : "size-16 rounded-full",
          mode === "photo" && "bg-studio-foreground",
        )}
      />
    </button>
  );
}
