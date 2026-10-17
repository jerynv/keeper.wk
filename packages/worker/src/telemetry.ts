import { widelog, widelogger } from "@keeper.sh/calendar";

// One wide event per unit of work, written to Workers Logs as a single JSON line.
const { context: withWideEvent } = widelogger({ service: "keeper-cf" });

export { widelog, withWideEvent };
