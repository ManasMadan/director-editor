"use client";

import { useEffect, useState } from "react";

/**
 * A blob: URL for `blob` while the component shows it (null until the first effect, or
 * with no blob). Made and revoked in one effect, so React's dev double-mount, which runs
 * the cleanup and then the effect again, gets a fresh URL rather than a revoked one.
 */
export function useObjectUrl(blob: Blob | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return;
    }
    const made = URL.createObjectURL(blob);
    setUrl(made);
    return () => URL.revokeObjectURL(made);
  }, [blob]);
  return url;
}
