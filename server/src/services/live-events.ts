import { EventEmitter } from "node:events";
import { LIVE_EVENT_TYPES, type LiveEvent, type LiveEventType } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { serverBootId } from "./server-instance-registry.js";

type LiveEventPayload = Record<string, unknown>;
type LiveEventListener = (event: LiveEvent) => void;

const emitter = new EventEmitter();
emitter.setMaxListeners(0);
// Events received from other replicas. Kept apart so only client delivery
// sees them; see subscribeClientCompanyLiveEvents.
const remoteEmitter = new EventEmitter();
remoteEmitter.setMaxListeners(0);
const allCompanyEvents = Symbol("all-company-live-events");

let nextEventId = 0;

function toLiveEvent(input: {
  companyId: string;
  type: LiveEventType;
  payload?: LiveEventPayload;
}): LiveEvent {
  nextEventId += 1;
  return {
    id: nextEventId,
    companyId: input.companyId,
    type: input.type,
    createdAt: new Date().toISOString(),
    payload: input.payload ?? {},
  };
}

export function publishLiveEvent(input: {
  companyId: string;
  type: LiveEventType;
  payload?: LiveEventPayload;
}) {
  const event = toLiveEvent(input);
  emitCompanyEvent(event);
  forwardToReplicas("company", event);
  return event;
}

function emitCompanyEvent(event: LiveEvent) {
  emitter.emit(event.companyId, event);
  emitter.emit(allCompanyEvents, event);
}

export function publishGlobalLiveEvent(input: {
  type: LiveEventType;
  payload?: LiveEventPayload;
}) {
  const event = toLiveEvent({ companyId: "*", type: input.type, payload: input.payload });
  emitter.emit("*", event);
  return event;
}

export function subscribeCompanyLiveEvents(companyId: string, listener: LiveEventListener) {
  emitter.on(companyId, listener);
  return () => emitter.off(companyId, listener);
}

/**
 * Client delivery (the browser WebSocket): this process's events plus the
 * events other replicas fan out. Internal observers use
 * `subscribeCompanyLiveEvents`/`subscribeAllCompanyLiveEvents`, which see only
 * local events, so a side effect never runs once per replica.
 */
export function subscribeClientCompanyLiveEvents(companyId: string, listener: LiveEventListener) {
  emitter.on(companyId, listener);
  remoteEmitter.on(companyId, listener);
  return () => {
    emitter.off(companyId, listener);
    remoteEmitter.off(companyId, listener);
  };
}

export function subscribeGlobalLiveEvents(listener: LiveEventListener) {
  emitter.on("*", listener);
  return () => emitter.off("*", listener);
}

/**
 * Internal process-wide observation of company-scoped events. This is kept
 * distinct from the public/global `*` stream so company subscriptions and
 * global instance events retain their existing routing semantics.
 */
export function subscribeAllCompanyLiveEvents(listener: LiveEventListener) {
  emitter.on(allCompanyEvents, listener);
  return () => emitter.off(allCompanyEvents, listener);
}

/*
 * Cross-replica fan-out. With several server processes on one database, a
 * browser's WebSocket lands on one replica while the event may be published on
 * another. Each process NOTIFYs its events on one channel and re-emits the
 * events of other processes to its local subscribers. The local emitter stays
 * the delivery path; a single process works the same with fan-out off.
 *
 * NOTIFY is fire-and-forget: a lost notification costs a live update, never
 * state, because clients refetch authoritative data on these events.
 */
export const LIVE_EVENTS_CHANNEL = "paperclip_live_events";
// Postgres rejects NOTIFY payloads of 8000 bytes or more.
const MAX_NOTIFY_PAYLOAD_BYTES = 7_500;

// Only company events fan out: global events have no client subscriber.
type ReplicaEnvelope = { v: 1; origin: string; scope: "company"; event: LiveEvent };
type NotifyClient = {
  listen(channel: string, onNotify: (payload: string) => void): Promise<{ unlisten(): Promise<unknown> }>;
  notify(channel: string, payload: string): PromiseLike<unknown>;
};

let replicaClient: NotifyClient | null = null;
const knownEventTypes = new Set<string>(LIVE_EVENT_TYPES);

function forwardToReplicas(scope: ReplicaEnvelope["scope"], event: LiveEvent) {
  const client = replicaClient;
  if (!client) return;
  let text = JSON.stringify({ v: 1, origin: serverBootId, scope, event } satisfies ReplicaEnvelope);
  if (Buffer.byteLength(text) > MAX_NOTIFY_PAYLOAD_BYTES) {
    // Keep the routing fields so remote clients still refetch.
    text = JSON.stringify({
      v: 1, origin: serverBootId, scope, event: { ...event, payload: { truncated: true } },
    } satisfies ReplicaEnvelope);
  }
  Promise.resolve(client.notify(LIVE_EVENTS_CHANNEL, text)).catch((err: unknown) => {
    logger.warn({ err }, "live event replica fan-out notify failed");
  });
}

function receiveFromReplica(text: string) {
  let envelope: ReplicaEnvelope;
  try {
    envelope = JSON.parse(text) as ReplicaEnvelope;
  } catch {
    return;
  }
  if (envelope?.v !== 1 || envelope.origin === serverBootId) return;
  const remote = envelope.event;
  if (envelope.scope !== "company" || !remote || typeof remote.companyId !== "string" ||
      remote.companyId === "*" || !knownEventTypes.has(remote.type)) return;
  const payload = remote.payload && typeof remote.payload === "object" ? remote.payload : {};
  // Re-number locally: ids are per-process sequence numbers.
  const event: LiveEvent = { ...toLiveEvent({ companyId: remote.companyId, type: remote.type, payload }), createdAt: remote.createdAt };
  remoteEmitter.emit(event.companyId, event);
}

/** Start fan-out on a postgres.js client (it holds LISTEN on its own
 * connection and re-listens after reconnects). */
export async function startLiveEventsReplicaFanout(client: NotifyClient): Promise<{ stop(): Promise<void> }> {
  const subscription = await client.listen(LIVE_EVENTS_CHANNEL, receiveFromReplica);
  replicaClient = client;
  return {
    async stop() {
      if (replicaClient === client) replicaClient = null;
      await subscription.unlisten().catch(() => undefined);
    },
  };
}
