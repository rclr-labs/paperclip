import { describe, expect, it, vi } from "vitest";
import { createHeartbeatInstructionWorkingCopy } from "./instruction-working-copy.js";
import { AGENT_FILES_CONTRACT } from "../agent-file-store.js";

type Input = Parameters<typeof createHeartbeatInstructionWorkingCopy>[0];

// Proof for the agent-evals design: an issue-level adapter override that blanks
// instructionsFilePath reaches prepare() as runtimeConfig. Does it survive?
describe("issue override of instructionsFilePath vs the per-run instruction working copy", () => {
  it("is replaced by the working copy for a claude_local agent (non-native run)", async () => {
    const run = { id: "run", companyId: "company", agentId: "agent", runnerProfileJson: null, status: "queued" } as ReturnType<Input["readRun"]>;
    const copy = { runId: "run", companyId: "company", agentId: "agent", localRoot: "/ws/copy", executionRoot: "/ws/copy",
      entryFile: "AGENTS.md", state: "prepared", receipt: { schema: AGENT_FILES_CONTRACT }, errorCode: null, errorMessage: null };
    const copies = { prepare: vi.fn().mockResolvedValue(copy), collectStopped: vi.fn(), checkpointWarm: vi.fn(),
      hasChanges: vi.fn().mockResolvedValue(false), canReuseWarm: vi.fn(), reportRetirementUnconfirmed: vi.fn() };
    const controller = createHeartbeatInstructionWorkingCopy({
      db: {} as Input["db"], instructionCopies: copies as unknown as Input["instructionCopies"], readRun: () => run,
      agent: { id: "agent", companyId: "company", adapterType: "claude_local", adapterConfig: {}, runtimeConfig: {} } as unknown as Input["agent"],
      context: {}, session: { taskSession: null, taskSessionForRun: null, sessionConfigMetadata: {} as Input["session"]["sessionConfigMetadata"] },
      workspace: { executionTarget: null, executionWorkspace: { cwd: "/ws" } as Input["workspace"]["executionWorkspace"], persistedExecutionWorkspace: null },
      appendRunEvent: vi.fn().mockResolvedValue(undefined),
    });
    const out = await controller.prepare({ runtimeConfig: { instructionsFilePath: "" }, hasInstructionFilesystem: true,
      nativeRuntimeResolution: { kind: "legacy" } as never });
    expect(copies.prepare).toHaveBeenCalled();
    expect(out.instructionsFilePath).toBe("/ws/copy/AGENTS.md");
  });
});
