/**
 * Serializes a clause that holds an inline element into a <Trans> message.
 *
 * `<p>Use the <code>x</code> to run</p>` becomes
 * `<p><Trans i18nKey="k">Use the <code>x</code> to run</Trans></p>` with the
 * catalogue holding `Use the <1>x</1> to run`.
 *
 * The number is the child's INDEX in the children array, text nodes included —
 * proven by ui/src/i18n/trans.test.tsx, which renders this shape and asserts
 * that a Portuguese message may move the tag within the clause.
 *
 * The children are left exactly as they are; only a wrapper is added. A
 * missing translation therefore falls back to rendering them, which means the
 * worst case of a wrong key is English, not a broken page.
 *
 * Refuses an inline element that holds anything but plain text: serializing
 * nested elements or expressions inside a tag needs judgement about what the
 * translator may move, and that belongs to a person.
 */

const normalize = (raw) => raw.replace(/\s*\n\s*/g, " ");

/** The text an inline element contributes, or null if it holds more than text. */
function innerText(element) {
  const kids = (element.children ?? []).filter((c) => !(c.type === "JSXText" && !c.value.trim()));
  if (kids.length === 0) return "";
  if (kids.length > 1) return null;
  const only = kids[0];
  return only.type === "JSXText" ? normalize(only.value).trim() : null;
}

/** JSX writes a literal space as {" "}; it is punctuation, not a value. */
function isWhitespaceExpression(child) {
  return (
    child.type === "JSXExpressionContainer" &&
    child.expression.type === "StringLiteral" &&
    /^\s*$/.test(child.expression.value)
  );
}

/**
 * @returns {{message: string}|null}
 */
export function buildTrans(children) {
  const parts = [];
  let sawElement = false;
  let sawTextCarryingElement = false;
  let topLevelProse = false;
  let prose = "";

  for (const [index, child] of (children ?? []).entries()) {
    if (child.type === "JSXText") {
      parts.push(normalize(child.value));
      prose += ` ${child.value}`;
      if (/[A-Za-z]{2}/.test(child.value)) topLevelProse = true;
      continue;
    }
    if (isWhitespaceExpression(child)) {
      parts.push(" ");
      continue;
    }
    if (child.type !== "JSXElement") return null; // fragment or expression: not handled

    const text = innerText(child);
    if (text === null) return null;
    parts.push(`<${index}>${text}</${index}>`);
    prose += ` ${text}`;
    sawElement = true;
    if (/[A-Za-z]/.test(text)) sawTextCarryingElement = true;
  }

  if (!sawElement) return null;
  // Without text at THIS level there is no clause — it is a layout container
  // whose children happen to be elements. Wrapping `<div><Label>Name</Label>
  // <Input /></div>` in <Trans> would hand a translator a form row, and
  // wrapping <SelectContent> would break the Select's child contract.
  if (!topLevelProse) return null;
  // Every inline element empty means they are decoration — an icon beside a
  // label — which composite.mjs already keys as plain t(). Wrapping that in
  // <Trans> would add a component and hand the translator an <1></1> they
  // cannot meaningfully move. <Trans> earns its place only when an element
  // carries text that must stay inside the sentence.
  if (!sawTextCarryingElement) return null;
  const message = parts.join("").replace(/\s+/g, " ").trim();
  // A clause worth a key needs words, not just a wrapped token.
  if (!/[A-Za-z]{2}/.test(prose) || message.length < 3) return null;
  return { message };
}
