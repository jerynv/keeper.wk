import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { createCacheStore, createDatabase } from "../src";

const store = createCacheStore(createDatabase(env.DB));
const uniqueKey = (label: string): string => `${label}:${crypto.randomUUID()}`;

describe("D1 cache store", () => {
  it("returns what was stored, and the latest value after an overwrite", async () => {
    const key = uniqueKey("value");
    expect(await store.get(key)).toBeNull();

    await store.setex(key, 60, "first");
    await store.setex(key, 60, "second");

    expect(await store.get(key)).toBe("second");
  });

  it("reads an entry as missing once its time is up", async () => {
    const key = uniqueKey("expiry");
    await store.setex(key, 60, "soon gone");

    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
    try {
      expect(await store.get(key)).toBeNull();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("deletes only the keys it is given", async () => {
    const kept = uniqueKey("kept");
    const dropped = uniqueKey("dropped");
    await store.setex(kept, 60, "a");
    await store.setex(dropped, 60, "b");

    expect(await store.del(dropped)).toBe(1);

    expect(await store.get(dropped)).toBeNull();
    expect(await store.get(kept)).toBe("a");
  });
});
