/**
 * Keeps the screen on until the returned function is called, where the browser lets it:
 * while the shoot screen is open (a phone propped across the room shouldn't lock
 * mid-setup), and while a video renders (it renders as long as it plays). The browser
 * drops the lock whenever the page is hidden, so it's taken again each time the page
 * comes back. Where there's no Wake Lock API, or it's refused, the screen behaves as usual.
 */
export function keepScreenOn(): () => void {
  if (!("wakeLock" in navigator)) {
    return () => undefined;
  }
  let lock: Promise<WakeLockSentinel | null> = Promise.resolve(null);
  const take = () => {
    if (document.visibilityState !== "visible") {
      return;
    }
    // Refused (battery saver, no permission): the screen just locks as it would.
    lock = navigator.wakeLock.request("screen").catch(() => null);
  };
  take();
  document.addEventListener("visibilitychange", take);
  return () => {
    document.removeEventListener("visibilitychange", take);
    // A request still pending is let go of once it's granted.
    void lock.then((sentinel) => sentinel?.release());
  };
}
