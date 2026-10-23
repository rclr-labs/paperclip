/**
 * Turns a clause split around values into one message with named placeholders.
 *
 * `<p>Sign in to {provider}</p>` becomes `{t("signInTo", { provider })}` with
 * the catalogue holding "Sign in to {{provider}}". Keeping the clause whole is
 * the point: a translator can move the placeholder, which keying the prefix
 * and the value apart would forbid.
 *
 * Refuses anything it cannot name. `{user.name}` is `{{name}}`, but
 * `{a ? b : c}` and `{fmt(x)}` have no honest name, and inventing `value1`
 * hands the translator a message they cannot reason about. Those are left for
 * a human.
 */

/** JSX writes a literal space as {" "}; it is punctuation, not a value. */
function literalWhitespace(expression) {
  if (expression.type !== "StringLiteral") return null;
  return /^\s*$/.test(expression.value) ? expression.value : null;
}

/** A placeholder name that a translator can make sense of, or null. */
export function nameFor(expression) {
  if (expression.type === "Identifier") return expression.name;
  if (
    (expression.type === "MemberExpression" || expression.type === "OptionalMemberExpression") &&
    !expression.computed &&
    expression.property?.type === "Identifier"
  ) {
    return expression.property.name;
  }
  return null;
}

const normalize = (raw) => raw.replace(/\s*\n\s*/g, " ");

/**
 * @returns {{message: string, values: Array<{name: string, expression: object}>}|null}
 *   null when the element is not a pure text+value clause, or when any value
 *   cannot be named.
 */
export function buildInterpolation(children) {
  const parts = [];
  const values = [];
  const used = new Map();
  let sawText = false;
  let sawValue = false;

  for (const child of children) {
    if (child.type === "JSXText") {
      parts.push(normalize(child.value));
      if (child.value.trim()) sawText = true;
      continue;
    }
    if (child.type !== "JSXExpressionContainer") return null; // an element: needs <Trans>

    const expression = child.expression;
    if (expression.type === "JSXEmptyExpression") continue; // a comment

    const whitespace = literalWhitespace(expression);
    if (whitespace !== null) {
      parts.push(whitespace === "" ? "" : " ");
      continue;
    }

    const base = nameFor(expression);
    if (base === null) return null;

    // The same name twice in one message would collapse two different values.
    let name = base;
    if (used.has(name)) {
      let n = 2;
      while (used.has(`${base}${n}`)) n++;
      name = `${base}${n}`;
    }
    used.set(name, true);
    values.push({ name, expression });
    parts.push(`{{${name}}}`);
    sawValue = true;
  }

  if (!sawText || !sawValue) return null; // nothing to interpolate
  const message = parts.join("").replace(/\s+/g, " ").trim();
  if (!message) return null;
  return { message, values };
}
