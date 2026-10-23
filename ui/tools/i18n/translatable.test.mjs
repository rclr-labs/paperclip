import { describe, expect, it } from "vitest";
import { isTranslatable } from "./translatable.mjs";

describe("isTranslatable", () => {
  it.each([
    ["a filename", "TOOLS.md"],
    ["a git ref", "origin/main"],
    ["a shell command", "pkill -f vite || true"],
    ["a function call", "createServerAdapter()"],
    ["a camelCase identifier", "feedbackDataSharingPreference"],
    ["a code expression", 'deploymentMode === "authenticated"'],
    ["a scoped permission", "audit:view_agent_actions"],
    ["a ticket id", "PAP-10114"],
    ["a PascalCase symbol", "CloudAccessGate"],
    ["an email", "jane@appliance.local"],
    ["an absolute route", "/costs"],
    ["a posix path", "/absolute/path/to/workspace"],
    ["a windows path", "E:\\Projects\\my-adapter"],
    ["a quoted literal", '"prompt"'],
    ["the product name", "Paperclip"],
    ["a vendor name", "GitHub"],
    ["an interpolated string", "Invite {{name}}"],
    ["a bare number", "42"],
    ["avatar initials", "LG"],
    ["a two-letter label", "OK"],
    ["an acronym", "SSH"],
    ["a screaming short token", "KEY"],
    ["a comma-led fragment", ", click"],
    ["a bullet-led fragment", "\u00b7 agent"],
    ["a JSON snippet", '{"x-custom-header": "value"}'],
    ["a shell invocation", "bash ./scripts/provision-worktree.sh"],
    ["a placeholder token", "<timestamp>"],
    ["a required-field marker", "Agent *"],
    ["a middot label", "API key \u00b7 x-api-key"],
    ["a middot route label", "Anthropic Messages \u00b7 Claude"],
    ["a screaming diagnostic marker", "SOURCE-RESOLVED FOLD"],
    ["a numbered wizard step", "2. Adapter"],
    ["a numbered fixture label", "2 Connection"],
    ["a vendor product name", "Grok Bot"],
    ["a single-word product name", "Arcade"],
    ["a relative path in prose position", "./scripts/teardown.sh"],
  ])("refuses %s", (_label, value) => {
    expect(isTranslatable(value)).toBe(false);
  });

  it.each([
    ["a button label", "Cancel"],
    ["a retry prompt", "Try again"],
    ["a loading label", "Loading…"],
    ["a chart title", "Tasks by Status"],
    ["an empty state", "No runs yet."],
    ["a relative time", "2m ago"],
    ["prose naming a vendor", "Latest on npm"],
    ["a single common noun", "Package"],
    ["a full sentence", "npm packages will be cleaned up from disk."],
    ["a section heading", "Danger zone"],
    ["prose that happens to end in a period after a middot phrase", "Production renderers \u00b7 synthetic data stay local."],
    ["a label with a slash and spaces", "Sign in / Create account"],
    ["placeholder prose", "Add a description..."],
  ])("accepts %s", (_label, value) => {
    expect(isTranslatable(value)).toBe(true);
  });
});
