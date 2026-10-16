import { AsyncLocalStorage } from "node:async_hooks";

/*
 * Wide events: one structured record per unit of work (an ingest, a destination push),
 * built up by many call sites and emitted once. Upstream used the widelogger package,
 * which writes through pino's Node streams; on Workers the native sink is console.log
 * of a JSON object, which Workers Logs indexes. This is the subset the engine uses.
 *
 * Calls outside a context are no-ops, so library code can record unconditionally.
 */

type FieldValue = boolean | number | string;
type WideEvent = Record<string, unknown>;
type WideEventTransport = (event: WideEvent) => void;

type Operation =
  | { kind: "count"; key: string; amount: number }
  | { kind: "max"; key: string; value: number }
  | { kind: "set"; key: string; value: FieldValue }
  | { kind: "time"; key: string; durationMs: number };

interface WideEventScope {
  base: WideEvent;
  operations: Operation[];
  transport: WideEventTransport;
}

interface ErrorFieldOptions {
  prefix?: string;
  slug?: string;
}

const storage = new AsyncLocalStorage<WideEventScope>();

const record = (operation: Operation): void => {
  storage.getStore()?.operations.push(operation);
};

const setNested = (target: WideEvent, key: string, value: unknown): void => {
  const parts = key.split(".");
  const last = parts.pop() ?? key;
  let node = target;
  for (const part of parts) {
    const next = node[part];
    if (typeof next === "object" && next !== null && !Array.isArray(next)) {
      node = next as WideEvent;
    } else {
      const created: WideEvent = {};
      node[part] = created;
      node = created;
    }
  }
  node[last] = value;
};

const isFieldValue = (value: unknown): value is FieldValue =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean";

const setFields = (fields: Record<string, unknown>, parentKey?: string): void => {
  for (const [key, value] of Object.entries(fields)) {
    let fullKey = key;
    if (parentKey) {
      fullKey = `${parentKey}.${key}`;
    }
    if (isFieldValue(value)) {
      record({ key: fullKey, kind: "set", value });
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      setFields(value as Record<string, unknown>, fullKey);
    }
  }
};

const MILLISECOND_PRECISION = 100;

const buildEvent = (scope: WideEventScope): WideEvent => {
  const event: WideEvent = { ...scope.base };
  const counters = new Map<string, number>();
  const maxima = new Map<string, number>();
  const timers = new Map<string, number>();
  for (const operation of scope.operations) {
    if (operation.kind === "set") {
      setNested(event, operation.key, operation.value);
    } else if (operation.kind === "count") {
      counters.set(operation.key, (counters.get(operation.key) ?? 0) + operation.amount);
    } else if (operation.kind === "max") {
      maxima.set(operation.key, Math.max(maxima.get(operation.key) ?? operation.value, operation.value));
    } else {
      timers.set(operation.key, (timers.get(operation.key) ?? 0) + operation.durationMs);
    }
  }
  for (const [key, value] of [...counters, ...maxima]) {
    setNested(event, key, value);
  }
  for (const [key, value] of timers) {
    setNested(event, key, Math.round(value * MILLISECOND_PRECISION) / MILLISECOND_PRECISION);
  }
  return event;
};

const measure = async <TResult>(key: string, callback: () => Promise<TResult>): Promise<TResult> => {
  const startedAt = performance.now();
  try {
    return await callback();
  } finally {
    record({ durationMs: performance.now() - startedAt, key, kind: "time" });
  }
};

const widelog = {
  count: (key: string, amount = 1): void => {
    record({ amount, key, kind: "count" });
  },
  errorFields: (error: unknown, options: ErrorFieldOptions = {}): void => {
    const prefix = options.prefix ?? "error";
    if (error instanceof Error) {
      record({ key: `${prefix}.error_name`, kind: "set", value: error.name });
      record({ key: `${prefix}.error_message`, kind: "set", value: error.message });
    } else {
      record({ key: `${prefix}.error_name`, kind: "set", value: "UnknownError" });
      record({ key: `${prefix}.error_message`, kind: "set", value: String(error) });
    }
    if (options.slug) {
      record({ key: `${prefix}.slug`, kind: "set", value: options.slug });
    }
  },
  flush: (): void => {
    const scope = storage.getStore();
    if (!scope || scope.operations.length === 0) {
      return;
    }
    const event = buildEvent(scope);
    scope.operations = [];
    scope.transport(event);
  },
  max: (key: string, value: number): void => {
    record({ key, kind: "max", value });
  },
  set: (key: string, value: FieldValue): void => {
    record({ key, kind: "set", value });
  },
  setFields: (fields: Record<string, unknown>): void => {
    setFields(fields);
  },
  time: { measure },
};

interface WideloggerOptions {
  defaultEventName?: string;
  environment?: string;
  service: string;
  transport?: WideEventTransport;
}

const consoleTransport: WideEventTransport = (event) => {
  console.log(JSON.stringify(event));
};

/*
 * Opens contexts whose flushed events go to the transport. Work recorded but never
 * flushed is dropped when the context ends, as upstream's widelogger did.
 */
const widelogger = (options: WideloggerOptions) => {
  const base: WideEvent = {
    environment: options.environment ?? "production",
    event_name: options.defaultEventName ?? "wide_event",
    service: options.service,
  };
  const transport = options.transport ?? consoleTransport;
  const context = <TResult>(callback: () => TResult): TResult =>
    storage.run({ base, operations: [], transport }, callback);
  return { context };
};

export { widelog, widelogger };
export type { WideEvent, WideEventTransport, WideloggerOptions };
