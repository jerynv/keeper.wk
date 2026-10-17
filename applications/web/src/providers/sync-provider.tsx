import { useEffect } from "react";
import { useSetAtom } from "jotai";
import { syncStateAtom } from "@/state/sync";

/*
 * Upstream streamed sync progress over a websocket. Here the Worker syncs from a
 * one-minute cron and records when each destination last ran, so the dashboard polls that.
 */
const POLL_INTERVAL_MS = 15_000;

interface SyncStatusResponse {
  lastSyncedAt: string | null;
}

export function SyncProvider() {
  const setSyncState = useSetAtom(syncStateAtom);

  useEffect(() => {
    let disposed = false;
    const poll = async (): Promise<void> => {
      try {
        const response = await fetch("/api/sync/status", { credentials: "include" });
        if (!response.ok || disposed) return;
        const { lastSyncedAt } = (await response.json()) as SyncStatusResponse;
        setSyncState({
          connected: true,
          hasReceivedAggregate: true,
          lastSyncedAt,
          progressPercent: 100,
          seq: 0,
          state: "idle",
          syncEventsProcessed: 0,
          syncEventsRemaining: 0,
          syncEventsTotal: 0,
        });
      } catch {
        if (!disposed) setSyncState((current) => ({ ...current, connected: false }));
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [setSyncState]);

  return null;
}
