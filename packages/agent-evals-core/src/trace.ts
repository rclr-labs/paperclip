/**
 * Normalized trace of one agent attempt. Both tiers (headless `claude -p` and
 * Paperclip heartbeat runs) produce this shape, so the same assertions and the
 * same judge apply to both. Scorers never scrape raw logs.
 */
export interface EvalToolCall {
  readonly name: string;
  /** JSON-serialized tool input, used for `input_match` regexes. */
  readonly input: string;
}

export interface EvalTrace {
  readonly tier: "headless" | "heartbeat";
  /** Concatenated assistant text, in order. */
  readonly assistantText: string;
  /** Final result text when the runtime reports one; falls back to the last assistant message. */
  readonly finalText: string;
  readonly toolCalls: readonly EvalToolCall[];
  /** Skills the agent loaded (Skill tool calls or SKILL.md reads). */
  readonly skillsUsed: readonly string[];
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly costUsd: number | null };
  readonly exit: { readonly ok: boolean; readonly error?: string };
  readonly runRef?: string;
}

interface StreamContentBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
}

const SKILL_FILE_RE = /(?:^|\/)skills\/([^/]+)\/SKILL\.md$/;

function skillFromToolCall(name: string, input: unknown): string | null {
  if (input === null || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  if (name === "Skill" && typeof record.skill === "string") {
    // Plugin-qualified names ("plugin:skill") are reduced to the skill slug.
    const parts = record.skill.split(":");
    return parts[parts.length - 1] ?? null;
  }
  if (name === "Read" && typeof record.file_path === "string") {
    return SKILL_FILE_RE.exec(record.file_path)?.[1] ?? null;
  }
  return null;
}

/**
 * Build an EvalTrace from Claude Code `--output-format stream-json` output
 * (one JSON object per line). Unparseable lines are ignored, not fatal: the
 * CLI can interleave non-JSON diagnostics on the same stream.
 */
export function traceFromClaudeStreamJson(ndjson: string, exitCode: number | null = 0): EvalTrace {
  const textParts: string[] = [];
  const toolCalls: EvalToolCall[] = [];
  const skills = new Set<string>();
  let finalText: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd: number | null = null;
  let resultError: string | undefined;

  for (const line of ndjson.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type === "assistant") {
      const message = event.message as { content?: StreamContentBlock[] } | undefined;
      for (const block of message?.content ?? []) {
        if (block.type === "text" && typeof block.text === "string") textParts.push(block.text);
        if (block.type === "tool_use" && typeof block.name === "string") {
          toolCalls.push({ name: block.name, input: JSON.stringify(block.input ?? {}) });
          const skill = skillFromToolCall(block.name, block.input);
          if (skill) skills.add(skill);
        }
      }
    } else if (event.type === "result") {
      if (typeof event.result === "string") finalText = event.result;
      if (typeof event.total_cost_usd === "number") costUsd = event.total_cost_usd;
      const usage = event.usage as Record<string, unknown> | undefined;
      if (usage) {
        inputTokens =
          Number(usage.input_tokens ?? 0) +
          Number(usage.cache_read_input_tokens ?? 0) +
          Number(usage.cache_creation_input_tokens ?? 0);
        outputTokens = Number(usage.output_tokens ?? 0);
      }
      if (event.is_error === true || (typeof event.subtype === "string" && event.subtype !== "success")) {
        // An API failure arrives as is_error with subtype "success": the reason is in `result`, not in the subtype.
        resultError =
          typeof event.subtype === "string" && event.subtype !== "success" ? event.subtype
          : typeof event.result === "string" && event.result.trim() ? event.result.trim().slice(0, 300)
          : "error";
      }
    }
  }

  return buildTrace(textParts, finalText, toolCalls, skills, { inputTokens, outputTokens, costUsd }, exitCode, resultError);
}

function buildTrace(
  textParts: readonly string[],
  finalText: string | null,
  toolCalls: EvalToolCall[],
  skills: ReadonlySet<string>,
  usage: EvalTrace["usage"],
  exitCode: number | null,
  resultError: string | undefined,
): EvalTrace {
  const { inputTokens, outputTokens, costUsd } = usage;
  const assistantText = textParts.join("\n");
  const ok = exitCode === 0 && resultError === undefined;
  return {
    tier: "headless",
    assistantText,
    finalText: finalText ?? textParts[textParts.length - 1] ?? "",
    toolCalls,
    skillsUsed: [...skills],
    usage: { inputTokens, outputTokens, costUsd },
    exit: ok ? { ok } : { ok, error: resultError ?? `exit code ${exitCode}` },
  };
}

/** Runtime skill dirs carry a content hash suffix: `verdict-with-confidence--7d17c7a973`. */
const RUNTIME_SKILL_SUFFIX_RE = /--[0-9a-f]{6,}$/;

function skillFromCommand(command: string): string | null {
  const match = /(?:^|\/)skills\/([^/"'\s]+)\/SKILL\.md\b/.exec(command);
  return match?.[1]?.replace(RUNTIME_SKILL_SUFFIX_RE, "") ?? null;
}

/**
 * Build an EvalTrace from the ACPX engine's NDJSON (`acpx.*` events), which is
 * what a heartbeat run log holds when the host drives Claude through the ACP
 * engine. Text deltas between tool calls form one assistant message; usage and
 * cost come from the last `usage_update` status that reports them.
 */
export function traceFromAcpxNdjson(ndjson: string, exitCode: number | null = 0): EvalTrace {
  const messages: string[] = [];
  let current = "";
  const calls = new Map<string, { name: string; command?: string }>();
  const skills = new Set<string>();
  let usage: EvalTrace["usage"] = { inputTokens: 0, outputTokens: 0, costUsd: null };
  let resultError: string | undefined;
  let sawResult = false;

  const closeMessage = () => {
    if (current.trim()) messages.push(current);
    current = "";
  };

  for (const line of ndjson.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    switch (event.type) {
      case "acpx.text_delta":
        if (event.channel === "output" && typeof event.text === "string") current += event.text;
        break;
      case "acpx.tool_call": {
        closeMessage();
        const id = typeof event.toolCallId === "string" ? event.toolCallId : `call-${calls.size}`;
        const name = typeof event.name === "string" ? event.name : "";
        const call = calls.get(id);
        if (!call) {
          calls.set(id, { name });
        } else if (event.tag === "tool_call_update" && event.status === undefined && name && name !== call.name) {
          // The engine re-sends the call with its concrete command (e.g. `cat ".../SKILL.md"`) as the name.
          call.command = name;
        }
        const skill = skillFromCommand(name);
        if (skill) skills.add(skill);
        break;
      }
      case "acpx.status": {
        const breakdown = event.breakdown as Record<string, unknown> | undefined;
        const cost = event.cost as { amount?: unknown } | undefined;
        if (breakdown) {
          usage = {
            inputTokens: Number(breakdown.inputTokens ?? 0) + Number(breakdown.cachedReadTokens ?? 0) + Number(breakdown.cachedWriteTokens ?? 0),
            outputTokens: Number(breakdown.outputTokens ?? 0),
            costUsd: typeof cost?.amount === "number" ? cost.amount : usage.costUsd,
          };
        }
        break;
      }
      case "acpx.result":
        sawResult = true;
        if (event.summary !== "completed") {
          const stop = typeof event.stopReason === "string" ? ` (${event.stopReason})` : "";
          resultError = `${typeof event.summary === "string" ? event.summary : "error"}${stop}`;
        }
        break;
    }
  }
  closeMessage();
  if (!sawResult && exitCode === 0) resultError = "the run ended without an ACPX result";

  const toolCalls: EvalToolCall[] = [...calls.values()].map((c) => ({
    name: c.name,
    input: JSON.stringify(c.command ? { command: c.command } : {}),
  }));
  return buildTrace(messages, messages[messages.length - 1] ?? null, toolCalls, skills, usage, exitCode, resultError);
}

/** True when the NDJSON holds ACPX engine events rather than Claude stream-json. */
export function isAcpxNdjson(ndjson: string): boolean {
  return /^\{"type":"acpx\./m.test(ndjson);
}
