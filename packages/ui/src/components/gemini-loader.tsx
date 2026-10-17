import { cn } from "cn";
import { SparkleIcon } from "lucide-react";
import { useId } from "react";

/** Announced when the caller has no caption of its own to show. */
const DEFAULT_LABEL = "Loading";

const SIZE_CLASSES = {
  sm: "size-6",
  md: "size-10",
  lg: "size-16",
} as const;

/**
 * The feel of Gemini's own loading state: an aurora glow turning behind a four-point
 * sparkle that gently pulses. `label` doubles as the caption under it and its accessible
 * name; without one, a visually-hidden default still gives screen readers something to
 * announce. Respects `prefers-reduced-motion`: the glow and sparkle hold still, gradient
 * and all, instead of animating.
 */
function GeminiLoader({
  label,
  size = "md",
  className,
  ...props
}: React.ComponentProps<"div"> & { label?: string; size?: "sm" | "md" | "lg" }) {
  const gradientId = useId();
  return (
    <div
      data-slot="gemini-loader"
      data-size={size}
      role="status"
      aria-live="polite"
      aria-label={label ?? DEFAULT_LABEL}
      className={cn("inline-flex flex-col items-center gap-2", className)}
      {...props}
    >
      <span className={cn("relative block", SIZE_CLASSES[size])}>
        {/* Nothing to look at itself: the sparkle below fills from this gradient by id. */}
        <svg aria-hidden width={0} height={0} className="absolute">
          <defs>
            <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="var(--aurora-1)" />
              <stop offset="50%" stopColor="var(--aurora-2)" />
              <stop offset="100%" stopColor="var(--aurora-3)" />
            </linearGradient>
          </defs>
        </svg>
        <span
          aria-hidden
          className="absolute inset-0 rounded-full bg-[conic-gradient(from_0deg,var(--aurora-1),var(--aurora-2),var(--aurora-3),var(--aurora-1))] opacity-70 blur-md motion-safe:animate-[gemini-orbit_3s_linear_infinite]"
        />
        <SparkleIcon
          aria-hidden
          fill={`url(#${gradientId})`}
          stroke="none"
          className="relative size-full motion-safe:animate-[gemini-pulse_2.2s_ease-in-out_infinite]"
        />
      </span>
      {label ? <span className="text-sm text-muted-foreground">{label}</span> : null}
    </div>
  );
}

/** A skeleton block with the same aurora shimmer sweeping across it, instead of a flat pulse. */
function GeminiShimmer({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="gemini-shimmer"
      className={cn("relative overflow-hidden rounded-md bg-muted", className)}
      {...props}
    >
      <span
        aria-hidden
        className="absolute inset-0 -translate-x-full bg-linear-to-r from-transparent via-[color-mix(in_oklch,var(--aurora-2)_45%,transparent)] to-transparent motion-safe:animate-[gemini-sweep_1.8s_ease-in-out_infinite]"
      />
    </div>
  );
}

export { GeminiLoader, GeminiShimmer };
