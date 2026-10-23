/**
 * Pages that exist to develop Paperclip, not to use it: the design guide, the
 * UX labs, the artifact-direction frames, the perf harnesses.
 *
 * They are developer references that no customer opens, and their strings are
 * fixture labels — "bg-blue-*", "Panel A", "1. Code". Extracting them puts
 * those labels into 40 locale files and asks translators to render a Tailwind
 * class, so they are excluded at the source.
 *
 * The extractor matches on file path and the pruner matches on catalogue key;
 * both live here so the two cannot drift apart.
 */
const PATH_PATTERNS = [
  /(^|\/)DesignGuide(\.|\/)/,
  /(^|\/)DesignSandbox/,
  /UxLab\.tsx$/,
  /(^|\/)artifact-directions\//,
  /(^|\/)TaskChatLab\.tsx$/,
  /PerfHarness/,
  /LongThreadPerf/,
  /(^|\/)SmokeLab/,
];

const KEY_PREFIXES = [
  "pages.designGuide",
  "pages.designSandbox",
  "artifactDirections",
  "artifactdirections",
  "pages.taskChatLab",
  "fixtures.taskChatPerfHarness",
  "pages.issueChatLongThreadPerf",
  "components.smokeLabDashboardCard",
  "components.designsandbox",
];

/** True when this source file is an internal development surface. */
export function isExcludedFile(relativePath) {
  return PATH_PATTERNS.some((pattern) => pattern.test(relativePath));
}

/** True when this catalogue key came from one. Also catches the *UxLab pages,
 *  whose namespace carries "UxLab" rather than a fixed prefix. */
export function isExcludedKey(key) {
  if (KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) return true;
  return /uxlab/i.test(key.split(".").slice(0, 2).join("."));
}
