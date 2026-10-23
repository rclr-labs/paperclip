/**
 * Decides whether a JSX text node stands on its own or is part of a sentence
 * split across siblings.
 *
 * The naive reading of "has a sibling" refuses far too much. `<Button><Copy />
 * Copy message</Button>` has an element sibling, but the icon sits BESIDE the
 * label rather than inside the sentence: "Copy message" is already a complete
 * phrase and translates alone safely.
 *
 * A sentence is genuinely split when any of these hold:
 *   - another text run shares the parent (text, element, text)
 *   - an expression shares the parent — the text is then a prefix or suffix
 *     around a value, and only interpolation keeps the clause reorderable
 *   - a sibling element carries text of its own, as in
 *     `<p>Read the <a>docs</a></p>`, where keying the two apart would ask
 *     Portuguese to keep English word order
 *
 * Those cases need `<Trans>` or interpolation and are refused here.
 */

/** True when this element, or anything under it, holds text or an expression. */
export function carriesContent(node) {
  for (const child of node.children ?? []) {
    if (child.type === "JSXText" && child.value.trim()) return true;
    if (child.type === "JSXExpressionContainer") return true;
    if ((child.type === "JSXElement" || child.type === "JSXFragment") && carriesContent(child)) return true;
  }
  return false;
}

/**
 * @returns {"standalone"|"split"} whether `textNode` can be keyed on its own.
 */
export function classifyTextNode(parent, textNode) {
  const siblings = (parent?.children ?? []).filter((c) => c !== textNode);

  for (const sibling of siblings) {
    if (sibling.type === "JSXText") {
      if (sibling.value.trim()) return "split"; // a second text run
      continue; // whitespace between elements is not content
    }
    if (sibling.type === "JSXExpressionContainer") return "split";
    if (sibling.type === "JSXElement" || sibling.type === "JSXFragment") {
      if (carriesContent(sibling)) return "split";
      continue; // a bare icon beside the label
    }
  }
  return "standalone";
}
