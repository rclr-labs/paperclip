// @vitest-environment jsdom

import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { Trans } from "react-i18next";
import { afterEach, describe, expect, it } from "vitest";
import { i18n, setLocale } from ".";

/**
 * Proves how <Trans> maps a translation's numbered tags onto JSX children,
 * before 256 call sites are rewritten to depend on it.
 *
 * The index is the child's position in the children array — text nodes
 * included — so `Use the <code>x</code> to run` puts the element at 1 and the
 * catalogue must say `<1>`.
 */
async function render(element: React.ReactElement) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(element);
  });
  return { html: host.innerHTML, text: host.textContent ?? "", cleanup: () => act(() => root.unmount()) };
}

afterEach(async () => {
  await setLocale("en");
});

describe("Trans with numbered tags", () => {
  it("swaps the clause around the element and keeps the tag", async () => {
    i18n.addResourceBundle("pt-BR", "translation", {
      __probe: { useTheXToRun: "Rode <1>x</1> usando isto" },
    }, true, true);
    await setLocale("pt-BR");

    const { text, html, cleanup } = await render(
      createElement(
        Trans,
        { i18nKey: "__probe.useTheXToRun" },
        "Use the ",
        createElement("code", null, "x"),
        " to run",
      ),
    );
    expect(text).toBe("Rode x usando isto");
    expect(html).toContain("<code>x</code>");
    cleanup();
  });

  it("falls back to the English children when the key is missing", async () => {
    await setLocale("pt-BR");
    const { text, html, cleanup } = await render(
      createElement(
        Trans,
        { i18nKey: "__probe.absent" },
        "Use the ",
        createElement("code", null, "x"),
        " to run",
      ),
    );
    expect(text).toBe("Use the x to run");
    expect(html).toContain("<code>x</code>");
    cleanup();
  });

  it("renders English from the catalogue when the locale is English", async () => {
    i18n.addResourceBundle("en", "translation", {
      __probe: { useTheXToRun: "Use the <1>x</1> to run" },
    }, true, true);
    const { text, cleanup } = await render(
      createElement(
        Trans,
        { i18nKey: "__probe.useTheXToRun" },
        "Use the ",
        createElement("code", null, "x"),
        " to run",
      ),
    );
    expect(text).toBe("Use the x to run");
    cleanup();
  });
});
