import { describe, expect, it } from "vitest";
import { isExcludedFile, isExcludedKey } from "./excluded.mjs";

describe("isExcludedFile", () => {
  it.each([
    "pages/DesignGuide.tsx",
    "pages/InviteUxLab.tsx",
    "pages/SystemNoticeUxLab.tsx",
    "artifact-directions/frames/KindsSheet.tsx",
    "pages/TaskChatLab.tsx",
    "components/SmokeLabDashboardCard.tsx",
  ])("excludes %s", (path) => {
    expect(isExcludedFile(path)).toBe(true);
  });

  it.each([
    "pages/CompanySettings.tsx",
    "pages/StatusCards/StatusCardTile.tsx",
    "components/RunnerInspector.tsx",
    "pages/apps/chat/ChatEndpointSetup.tsx",
  ])("keeps %s", (path) => {
    expect(isExcludedFile(path)).toBe(false);
  });
});

describe("isExcludedKey", () => {
  it.each([
    "pages.designGuide.someLabel",
    "pages.inviteUxLab.someLabel",
    "pages.systemNoticeUxLab.someLabel",
    "artifactdirections.frames.someLabel",
    "pages.taskChatLab.someLabel",
    "pages.tools.smokeLabTab.someLabel",
  ])("excludes %s", (key) => {
    expect(isExcludedKey(key)).toBe(true);
  });

  it.each([
    "pages.statusCards.someLabel",
    "components.runnerInspector.someLabel",
    "pages.companySettings.someLabel",
  ])("keeps %s", (key) => {
    expect(isExcludedKey(key)).toBe(false);
  });
});
