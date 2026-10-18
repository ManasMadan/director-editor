"use client";

import { useApiErrorMessage } from "@repo/client";
import { useBriefPhotoMutation } from "@repo/client/api/director/brief-photo";
import { checkUpload } from "@repo/client/api/files/upload";
import { DIRECTOR_MAX_BRIEF_PHOTOS } from "@repo/contracts/api";
import type { FileId } from "@repo/contracts/ids";
import { GeminiShimmer } from "@repo/ui/components/gemini-loader";
import { CircleAlert, ImagePlus, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

/** A photo for the brief: its preview, and its upload's state (its file once checked). */
export interface BriefPhoto {
  key: string;
  preview: string;
  fileId: FileId | null;
  failed: boolean;
}

/** One photo: its preview, how its check is going, and a way to take it out. */
function PhotoTile({
  photo,
  index,
  onRemove,
}: {
  photo: BriefPhoto;
  index: number;
  onRemove: () => void;
}) {
  const t = useTranslations("create");
  return (
    <li className="relative size-20 overflow-hidden rounded-xl">
      {/* A local preview (an object URL): nothing for Next's optimizer to fetch. */}
      <img
        src={photo.preview}
        alt={t("photoAlt", { index: index + 1 })}
        className="size-full object-cover"
      />
      {photo.fileId === null && !photo.failed ? (
        <GeminiShimmer className="absolute inset-0 rounded-none bg-studio/40" />
      ) : null}
      {photo.failed ? (
        <span className="absolute inset-0 flex items-center justify-center bg-studio/70">
          <CircleAlert className="size-5 text-studio-error" aria-hidden />
        </span>
      ) : null}
      <button
        type="button"
        onClick={onRemove}
        aria-label={t("removePhoto", { index: index + 1 })}
        className="absolute top-0 right-0 flex size-11 items-start justify-end p-1"
      >
        <span className="flex size-6 items-center justify-center rounded-full bg-studio/80">
          <X className="size-4" aria-hidden />
        </span>
      </button>
    </li>
  );
}

type PhotosChange = (update: (photos: BriefPhoto[]) => BriefPhoto[]) => void;

/**
 * Adding a photo: refused before anything is sent when it's of the wrong type or too
 * big, otherwise shown at once and uploaded, its tile following its check.
 */
function usePhotoAdder(onChange: PhotosChange) {
  const errorMessage = useApiErrorMessage();
  const upload = useBriefPhotoMutation();
  const [refused, setRefused] = useState<string | null>(null);
  const previews = useRef(new Set<string>());
  // Each preview is an object URL: let them go with the page.
  useEffect(() => {
    const made = previews.current;
    return () => {
      for (const url of made) {
        URL.revokeObjectURL(url);
      }
    };
  }, []);

  const add = (file: File) => {
    const refusal = checkUpload("director-brief-photo", file);
    if (refusal) {
      setRefused(errorMessage(refusal));
      return;
    }
    const preview = URL.createObjectURL(file);
    previews.current.add(preview);
    const key = preview;
    const settle = (fields: Partial<BriefPhoto>) =>
      onChange((all) => all.map((photo) => (photo.key === key ? { ...photo, ...fields } : photo)));
    onChange((all) => [...all, { key, preview, fileId: null, failed: false }]);
    upload.mutateAsync(file).then(
      (ready) => settle({ fileId: ready.id }),
      () => settle({ failed: true }),
    );
  };
  return { add, refused, clearRefused: () => setRefused(null) };
}

/**
 * Up to four photos for the brief (the member's space, a prop, a look they like), each
 * uploaded and checked as it's added, so writing the shots never waits on them.
 */
export function BriefPhotos({
  photos,
  onChange,
}: {
  photos: BriefPhoto[];
  onChange: PhotosChange;
}) {
  const t = useTranslations("create");
  const input = useRef<HTMLInputElement>(null);
  const { add, refused, clearRefused } = usePhotoAdder(onChange);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-medium text-studio-foreground/80">{t("photos")}</p>
      <ul className="flex flex-wrap gap-2">
        {photos.map((photo, index) => (
          <PhotoTile
            key={photo.key}
            photo={photo}
            index={index}
            onRemove={() => onChange((all) => all.filter((each) => each.key !== photo.key))}
          />
        ))}
        {photos.length < DIRECTOR_MAX_BRIEF_PHOTOS ? (
          <li>
            <button
              type="button"
              onClick={() => input.current?.click()}
              className="flex size-20 flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-studio-foreground/30 text-xs text-studio-foreground/80 hover:bg-studio-foreground/5"
            >
              <ImagePlus className="size-5" aria-hidden />
              {t("addPhoto")}
            </button>
          </li>
        ) : null}
      </ul>
      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple
        hidden
        onChange={(event) => {
          clearRefused();
          const room = DIRECTOR_MAX_BRIEF_PHOTOS - photos.length;
          for (const file of Array.from(event.target.files ?? []).slice(0, room)) {
            add(file);
          }
          event.target.value = "";
        }}
      />
      <p className="text-xs text-studio-foreground/60">
        {t("photosHint", { max: DIRECTOR_MAX_BRIEF_PHOTOS })} {t("rights")}
      </p>
      {photos.some((photo) => photo.failed) ? (
        <p role="alert" className="text-sm text-studio-error">
          {t("photoFailed")}
        </p>
      ) : null}
      {refused ? (
        <p role="alert" className="text-sm text-studio-error">
          {refused}
        </p>
      ) : null}
    </div>
  );
}
