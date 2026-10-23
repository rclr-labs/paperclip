/**
 * Decides whether a string literal inside a JSX expression is display text.
 *
 * `{ready ? "Ready" : "Not ready"}` renders two complete labels and each
 * deserves its own key. But a literal in an expression is not text by default:
 *
 *   - `className={busy ? "opacity-50" : "opacity-100"}` is CSS
 *   - `aria-live={live ? "polite" : "off"}` is an ARIA value
 *   - `label={mine ? "Assignee" : "Originating"}` is a typed union, the exact
 *     break that stopped the build earlier in this branch
 *   - `cn(a ? "flex gap-2" : "grid")` is CSS again, and `isTranslatable` does
 *     not catch it because it has spaces and letters
 *
 * So position decides, not content. A literal reaching a JSX expression
 * container that is a CHILD is rendered text. One sitting in an attribute, or
 * passed through any call on the way, is refused.
 */

/**
 * @returns {"child"|"attribute"|"call"|"outside"} where the literal lands.
 */
export function jsxPosition(ancestors) {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const node = ancestors[i];
    // A call on the way means the value is an argument, not content: cn(),
    // clsx(), toast(), formatters. What it becomes is the callee's business.
    if (node.type === "CallExpression" || node.type === "NewExpression") return "call";
    if (node.type === "JSXAttribute") return "attribute";
    if (node.type === "JSXExpressionContainer") {
      const parent = ancestors[i - 1];
      return parent?.type === "JSXAttribute" ? "attribute" : "child";
    }
    // Leaving the expression without finding a container: not JSX content.
    if (node.type === "JSXElement" || node.type === "JSXFragment") return "outside";
  }
  return "outside";
}

/** Only an expression that renders its branches is in scope. */
export function isRenderedBranch(ancestors) {
  const parent = ancestors[ancestors.length - 1];
  if (!parent) return false;
  if (parent.type === "ConditionalExpression") return true;
  if (parent.type === "LogicalExpression") return true;
  return false;
}
