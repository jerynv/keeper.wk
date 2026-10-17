/*
 * One queue message is one unit of work: ingest one source calendar, or
 * reconcile one destination calendar. Messages carry no state, only which calendar, so a
 * duplicate or a retry is harmless: every run reads the current state from D1.
 */
type SyncMessage =
  | { kind: "ingest"; calendarId: string }
  | { kind: "push"; calendarId: string };

const QUEUE_SEND_BATCH_LIMIT = 100;

const sendMessages = async (queue: Queue<SyncMessage>, messages: SyncMessage[]): Promise<void> => {
  for (let offset = 0; offset < messages.length; offset += QUEUE_SEND_BATCH_LIMIT) {
    await queue.sendBatch(
      messages.slice(offset, offset + QUEUE_SEND_BATCH_LIMIT).map((body) => ({ body })),
    );
  }
};

export { sendMessages };
export type { SyncMessage };
