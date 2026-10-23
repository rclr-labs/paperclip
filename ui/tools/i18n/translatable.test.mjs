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
    ["a label with a slash and spaces", "Sign in / Create account"],
    ["placeholder prose", "Add a description..."],
  ])("accepts %s", (_label, value) => {
    expect(isTranslatable(value)).toBe(true);
  });
});
