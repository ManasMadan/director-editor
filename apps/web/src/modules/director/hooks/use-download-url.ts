"use client";

import { useFileDownloadUrl } from "@repo/client/api/files/download-url";
import { useEffect, useRef, useState } from "react";

/**
 * A short-lived link to read one of the member's files: undefined while it's asked for,
 * null when it can't be had. Asked for once per file: the client's function is a new one
 * each render, so it's held in a ref, where an effect depending on it would ask again on
 * every render and swap the link (and reload a video playing it) each time.
 */
export function useDownloadUrl(fileId: string): string | null | undefined {
  const downloadUrl = useRef(useFileDownloadUrl());
  const [link, setLink] = useState<{ fileId: string; url: string | null } | null>(null);
  useEffect(() => {
    let current = true;
    downloadUrl.current(fileId).then(
      ({ url }) => {
        if (current) {
          setLink({ fileId, url });
        }
      },
      () => {
        if (current) {
          setLink({ fileId, url: null });
        }
      },
    );
    return () => {
      current = false;
    };
  }, [fileId]);
  return link && link.fileId === fileId ? link.url : undefined;
}
