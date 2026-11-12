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
        resultError = typeof event.subtype === "string" ? event.subtype : "error";
      }
    }
  }

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
