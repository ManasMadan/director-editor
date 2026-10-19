"use client";

import { Drawer as SheetPrimitive } from "@base-ui/react/drawer";
import { cn } from "cn";
import type * as React from "react";

/**
 * A bottom sheet, as phones show one: it rises over the page to about half its height
 * with a grabber, drags up to the full height for more, and a swipe down, Escape or a tap
 * on the page behind it closes it. On a wide screen it's the same sheet, as wide as a
 * phone, centred. Built on Base UI's Drawer, which brings the gestures and the snapping.
 */

/** Where the sheet rests: about half the screen to start, all of it when dragged up. */
const SNAP_POINTS = [0.55, 1];

function Sheet({ ...props }: SheetPrimitive.Root.Props) {
  return (
    <SheetPrimitive.Root
      data-slot="sheet"
      snapPoints={SNAP_POINTS}
      defaultSnapPoint={SNAP_POINTS[0]}
      {...props}
    />
  );
}

function SheetTrigger({ ...props }: SheetPrimitive.Trigger.Props) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

function SheetClose({ ...props }: SheetPrimitive.Close.Props) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />;
}

function SheetContent({ className, children, ...props }: SheetPrimitive.Popup.Props) {
  return (
    <SheetPrimitive.Portal>
      <SheetPrimitive.Backdrop
        data-slot="sheet-overlay"
        className="fixed inset-0 z-50 min-h-dvh bg-black/40 opacity-[calc(1-var(--drawer-swipe-progress))] transition-opacity duration-300 ease-out data-swiping:duration-0 data-starting-style:opacity-0 data-ending-style:opacity-0 motion-reduce:transition-none supports-[-webkit-touch-callout:none]:absolute"
      />
      <SheetPrimitive.Viewport className="fixed inset-0 z-50 flex items-end justify-center">
        <SheetPrimitive.Popup
          data-slot="sheet-content"
          className={cn(
            // Moved by the resting point and the finger; the padding at its foot keeps the
            // end of what scrolls inside reachable while it rests at half height.
            "relative flex max-h-[calc(100dvh-1rem)] min-h-0 w-full max-w-lg touch-none flex-col rounded-t-2xl bg-popover text-sm text-popover-foreground ring-1 ring-foreground/10 outline-none",
            "[padding-bottom:max(0px,calc(var(--drawer-snap-point-offset)+var(--drawer-swipe-movement-y)))] [transform:translateY(calc(var(--drawer-snap-point-offset)+var(--drawer-swipe-movement-y)))]",
            "transition-transform duration-300 ease-out data-swiping:select-none data-starting-style:[transform:translateY(100%)] data-ending-style:[transform:translateY(100%)] motion-reduce:transition-none",
            className,
          )}
          {...props}
        >
          <div
            aria-hidden
            data-slot="sheet-grabber"
            className="mx-auto mt-2.5 mb-1 h-1.5 w-10 shrink-0 rounded-full bg-muted-foreground/40"
          />
          <SheetPrimitive.Content className="flex min-h-0 flex-1 touch-auto flex-col gap-4 overflow-y-auto overscroll-contain px-4 pt-2 pb-[calc(1rem+env(safe-area-inset-bottom))]">
            {children}
          </SheetPrimitive.Content>
        </SheetPrimitive.Popup>
      </SheetPrimitive.Viewport>
    </SheetPrimitive.Portal>
  );
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="sheet-header" className={cn("flex flex-col gap-2", className)} {...props} />
  );
}

function SheetTitle({ className, ...props }: SheetPrimitive.Title.Props) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn("font-heading text-base leading-none font-medium", className)}
      {...props}
    />
  );
}

function SheetDescription({ className, ...props }: SheetPrimitive.Description.Props) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export { Sheet, SheetClose, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger };
