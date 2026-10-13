import { afterEach, describe, expect, it, vi } from "vitest";
import { useObjectUrl } from "@/modules/director/hooks/use-object-url";
import { renderHook } from "./support";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useObjectUrl", () => {
  it("gives each blob a URL to read it by, and revokes the one it no longer shows", async () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    let blob: Blob | null = null;
    const hook = await renderHook(() => useObjectUrl(blob));
    expect(hook.current).toBeNull();

    blob = new Blob(["first take"]);
    hook.rerender();
    await expect.poll(() => hook.current).toMatch(/^blob:/);
    const first = hook.current ?? "";
    expect(await (await fetch(first)).text()).toBe("first take");

    blob = new Blob(["second take"]);
    hook.rerender();
    await expect.poll(() => hook.current).not.toBe(first);
    const second = hook.current ?? "";
    expect(await (await fetch(second)).text()).toBe("second take");
    expect(revoke).toHaveBeenCalledWith(first);

    blob = null;
    hook.rerender();
    await expect.poll(() => hook.current).toBeNull();
    expect(revoke).toHaveBeenCalledWith(second);
  });

  it("revokes its URL when the component goes", async () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const blob = new Blob(["take"]);
    const hook = await renderHook(() => useObjectUrl(blob));
    await expect.poll(() => hook.current).toMatch(/^blob:/);
    const url = hook.current;
    hook.unmount();
    expect(revoke).toHaveBeenLastCalledWith(url);
  });
});
