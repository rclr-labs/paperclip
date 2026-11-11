import type { Db } from "@paperclipai/db";
import type { LiveEvent } from "@paperclipai/shared";
import { redactCurrentUserValue } from "../log-redaction.js";
import { redactEventPayload } from "../redaction.js";
import { instanceSettingsService } from "./instance-settings.js";
import { createRunSecretRedactionRegistry } from "./run-secret-redaction.js";

export function createLiveRunEventRedactor(db: Db) {
  const settings = instanceSettingsService(db);
  const redactions = createRunSecretRedactionRegistry(db);
  return async (event: LiveEvent): Promise<LiveEvent | null> => {
    const runId = event.payload.runId;
    if (typeof runId !== "string") return null;
    const redacted = redactCurrentUserValue({ ...event,
      payload: redactEventPayload(event.payload) ?? {},
    }, { enabled: (await settings.getGeneral()).censorUsernameInLogs });
    return redactions.redactForRun(event.companyId, runId, redacted);
  };
}

/**
 * Redact stored heartbeat run events for a non-board reader (a plugin), with
 * the same three layers as `GET /api/heartbeat-runs/:runId/events`: secret
 * payload keys, the instance username setting, and the run's registered
 * secret values.
 */
export function createStoredRunEventRedactor(db: Db) {
  const settings = instanceSettingsService(db);
  const redactions = createRunSecretRedactionRegistry(db);
  return async <T extends { payload: Record<string, unknown> | null }>(
    companyId: string,
    runId: string,
    events: T[],
  ): Promise<T[]> => {
    if (events.length === 0) return events;
    const options = { enabled: (await settings.getGeneral()).censorUsernameInLogs };
    const redacted = events.map((event) =>
      redactCurrentUserValue({ ...event, payload: redactEventPayload(event.payload) }, options));
    return redactions.redactForRun(companyId, runId, redacted);
  };
}
