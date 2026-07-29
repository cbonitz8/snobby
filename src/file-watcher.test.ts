import { describe, it, expect, vi } from "vitest";
import { FileWatcher } from "./file-watcher";

// duringSyncWrite doesn't touch the plugin/frontmatter/api collaborators, so
// bare stubs suffice; add/remove are the class's own public methods.
function makeWatcher(): FileWatcher {
  return new FileWatcher({} as never, {} as never, {} as never);
}

describe("duringSyncWrite", () => {
  it("suppresses the path before fn runs and releases it after success", async () => {
    const fw = makeWatcher();
    const add = vi.spyOn(fw, "addSyncWritePath");
    const remove = vi.spyOn(fw, "removeSyncWritePath");

    let suppressedDuringFn = false;
    await fw.duringSyncWrite("a.md", async () => {
      // add already called for this path, remove not yet
      suppressedDuringFn = add.mock.calls.length === 1 && remove.mock.calls.length === 0;
    });

    expect(suppressedDuringFn).toBe(true);
    expect(add).toHaveBeenCalledWith("a.md");
    expect(remove).toHaveBeenCalledWith("a.md");
  });

  it("returns fn's result", async () => {
    const fw = makeWatcher();
    await expect(fw.duringSyncWrite("a.md", async () => 42)).resolves.toBe(42);
  });

  it("releases the path even when fn rejects", async () => {
    const fw = makeWatcher();
    const remove = vi.spyOn(fw, "removeSyncWritePath");

    await expect(
      fw.duringSyncWrite("a.md", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(remove).toHaveBeenCalledWith("a.md");
  });
});
