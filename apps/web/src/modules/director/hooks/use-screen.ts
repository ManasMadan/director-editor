"use client";

import { useEffect } from "react";
import { keepScreenOn } from "../lib/wake-lock";

/** Keeps the screen on while the shoot screen is open (lib/wake-lock.ts). */
export function useWakeLock() {
  useEffect(() => keepScreenOn(), []);
}
