"use client";

import { cn } from "@repo/ui/lib/utils";
import { useTranslations } from "next-intl";
import { type RefObject, useEffect, useRef, useState } from "react";
import {
  labelSide,
  type Mark,
  MIN_VISIBLE_SHARE,
  type Size,
  toScreen,
  visibleShare,
} from "../lib/marks";

/**
 * Where the top band's indicator and pills sit: a label goes below its box rather than
 * under them.
 */
const SAFE_TOP_PX = 64;

const LABEL_PLACES = {
  above: "bottom-full mb-1.5",
  below: "top-full mt-1.5",
  inside: "top-1.5 mx-1.5",
} as const;

/** The picture's size on screen and the camera frame's, kept current as either changes. */
function useSizes(
  layer: RefObject<HTMLDivElement | null>,
  video: RefObject<HTMLVideoElement | null>,
) {
  const [element, setElement] = useState<Size | null>(null);
  const [frame, setFrame] = useState<Size | null>(null);
  useEffect(() => {
    const box = layer.current;
    const camera = video.current;
    if (!(box && camera)) {
      return;
    }
    const measure = () => {
      setElement({ width: box.clientWidth, height: box.clientHeight });
      if (camera.videoWidth > 0) {
        setFrame({ width: camera.videoWidth, height: camera.videoHeight });
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    // A flip changes the camera's frame size without changing the element's.
    camera.addEventListener("resize", measure);
    camera.addEventListener("loadedmetadata", measure);
    return () => {
      observer.disconnect();
      camera.removeEventListener("resize", measure);
      camera.removeEventListener("loadedmetadata", measure);
    };
  }, [layer, video]);
  return { element, frame };
}

function MarkBox({
  mark,
  frame,
  element,
  mirrored,
}: {
  mark: Mark;
  frame: Size;
  element: Size;
  mirrored: boolean;
}) {
  const t = useTranslations("director.shoot");
  const rect = toScreen(mark.box, frame, element, mirrored);
  const shown = mark.fadingAt === null && visibleShare(rect, element) >= MIN_VISIBLE_SHARE;
  const side = labelSide(rect, element, SAFE_TOP_PX);
  // The label hangs from the box's side nearer the middle, so it stays on screen.
  const towardsRight = rect.left + rect.width / 2 < element.width / 2;
  return (
    <div
      aria-hidden={!shown}
      className={cn(
        "absolute top-0 left-0 rounded-xl border-2 border-white",
        "shadow-[0_0_0_1.5px_rgb(0_0_0/0.55),0_2px_14px_rgb(0_0_0/0.35)]",
        "transition-[transform,width,height,opacity] duration-200 ease-out motion-reduce:transition-opacity",
        shown ? "opacity-100" : "opacity-0",
      )}
      style={{
        transform: `translate(${rect.left}px, ${rect.top}px)`,
        width: rect.width,
        height: rect.height,
      }}
    >
      <span
        className={cn(
          "absolute max-w-[min(16rem,80vw)] truncate rounded-full bg-black/75 px-3 py-1 text-[0.9375rem] leading-5 font-semibold text-white",
          LABEL_PLACES[side],
          towardsRight ? "left-0" : "right-0",
        )}
      >
        <span aria-hidden>{mark.label}</span>
        <span className="sr-only">{t("mark", { label: mark.label })}</span>
      </span>
    </div>
  );
}

/**
 * Director's marks over the viewfinder: each a thin box on the thing Gemini located, with
 * its label in a pill beside it, moved with the camera and faded when it goes. It sits
 * exactly over the <video> (both fill the viewfinder) and never takes a tap.
 */
export function MarksLayer({
  marks,
  video,
  mirrored,
}: {
  marks: readonly Mark[];
  video: RefObject<HTMLVideoElement | null>;
  /** The front camera's preview is mirrored, so its marks are too. */
  mirrored: boolean;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const { element, frame } = useSizes(layer, video);
  return (
    <div
      ref={layer}
      aria-live="polite"
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      {element && frame
        ? marks.map((mark) => (
            <MarkBox
              key={mark.id}
              mark={mark}
              frame={frame}
              element={element}
              mirrored={mirrored}
            />
          ))
        : null}
    </div>
  );
}
