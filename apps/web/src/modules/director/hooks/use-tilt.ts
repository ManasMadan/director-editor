"use client";

import type { Shot } from "@repo/contracts/api";
import { useCallback, useEffect, useState } from "react";
import { type Tilt, tiltFromOrientation } from "../lib/tilt";

/** iOS Safari asks before a page may read the tilt (a method lib.dom doesn't declare). */
interface PermissionGated {
  requestPermission: () => Promise<"granted" | "denied">;
}

function isPermissionGated(value: object): value is PermissionGated {
  return "requestPermission" in value && typeof value.requestPermission === "function";
}

const needsPermission = () =>
  typeof DeviceOrientationEvent !== "undefined" && isPermissionGated(DeviceOrientationEvent);

/**
 * How the phone is held right now (null until the first reading; it stays null on a
 * computer). `ask` is set when the browser needs a tap to allow it.
 */
export function useTilt(camera: Shot["camera"]) {
  const [tilt, setTilt] = useState<Tilt | null>(null);
  const [allowed, setAllowed] = useState(() => !needsPermission());

  useEffect(() => {
    if (!allowed || typeof window === "undefined") {
      return;
    }
    const read = (event: DeviceOrientationEvent) => {
      if (event.beta !== null && event.gamma !== null) {
        // Whole degrees, and only when they change: the sensor fires about 60 times a
        // second, and every reading would otherwise re-render the camera screen.
        const next = tiltFromOrientation(Math.round(event.beta), Math.round(event.gamma), camera);
        setTilt((current) =>
          current?.pitch === next.pitch && current.roll === next.roll ? current : next,
        );
      }
    };
    window.addEventListener("deviceorientation", read);
    return () => window.removeEventListener("deviceorientation", read);
  }, [allowed, camera]);

  const ask = useCallback(async () => {
    if (!isPermissionGated(DeviceOrientationEvent)) {
      return;
    }
    // A refusal (or a browser that throws) leaves the level asking.
    const answer = await DeviceOrientationEvent.requestPermission().catch(() => "denied");
    setAllowed(answer === "granted");
  }, []);

  return { tilt, ask: allowed ? null : ask };
}
