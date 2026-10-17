import { createDatabase } from "@keeper.sh/database";
import type { Env } from "./env";
import { ingestSourceCalendar } from "./ingest/run-source";
import { sendMessages } from "./messages";
import type { SyncMessage } from "./messages";
import { pushDestinationCalendar } from "./push";
import { planPushesForSource, planScheduledMessages } from "./schedule";
import { handleRequest } from "./http";
import { widelog, withWideEvent } from "./telemetry";

const resolveConfig = (env: Env) => ({
  database: createDatabase(env.DB),
  encryptionKey: env.ENCRYPTION_KEY,
  googleClientId: env.GOOGLE_CLIENT_ID,
  googleClientSecret: env.GOOGLE_CLIENT_SECRET,
});

const processMessage = async (env: Env, body: SyncMessage): Promise<void> => {
  const config = resolveConfig(env);
  if (body.kind === "ingest") {
    const outcome = await ingestSourceCalendar(config, body.calendarId);
    widelog.set("outcome", outcome.status);
    if (outcome.shouldPush) {
      await sendMessages(env.SYNC_QUEUE, await planPushesForSource(config.database, body.calendarId));
    }
    return;
  }
  await pushDestinationCalendar(config, body.calendarId);
  widelog.set("outcome", "pushed");
};

const handler: ExportedHandler<Env, SyncMessage> = {
  fetch: (request, env) => handleRequest(request, env),

  async queue(batch, env) {
    for (const message of batch.messages) {
      await withWideEvent(async () => {
        widelog.set("operation.name", `queue:${message.body.kind}`);
        widelog.set("calendar.id", message.body.calendarId);
        widelog.set("queue.attempt", message.attempts);
        try {
          await processMessage(env, message.body);
          message.ack();
        } catch (error) {
          // Failures the engine records in D1 never reach here; this is infrastructure.
          widelog.set("outcome", "error");
          widelog.errorFields(error);
          message.retry();
        } finally {
          widelog.flush();
        }
      });
    }
  },

  async scheduled(_controller, env) {
    await withWideEvent(async () => {
      widelog.set("operation.name", "cron:plan");
      const messages = await planScheduledMessages(createDatabase(env.DB));
      widelog.set("queue.messages_sent", messages.length);
      await sendMessages(env.SYNC_QUEUE, messages);
      widelog.flush();
    });
  },
};

export default handler;
