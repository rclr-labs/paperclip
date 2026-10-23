// Decides whether a source string belongs in the translation catalogue.
// Extracted into its own module so the rule has a regression test: it is the
// riskiest judgement in the pipeline and the one that quietly poisons 40
// locale files when it is wrong.

/** Brand and proper nouns stay literal: a catalogue entry invites 40 bad
 *  "translations" of a name that must not change. */
export const DO_NOT_TRANSLATE = new Set(["Paperclip", "GitHub", "Slack", "npm", "Studio", "JSON", "Markdown"]);

/**
 * A string is translatable when a human reads it as prose. Everything that is
 * actually code — identifiers, paths, shell, expressions, ticket ids, emails,
 * filenames — is refused, because a translation catalogue is the wrong place
 * for it and a human translator will dutifully mangle it.
 */
export function isTranslatable(raw) {
  const s = raw.trim();
  if (s.length < 2) return false;
  if (!/[A-Za-z]{2}/.test(s)) return false;
  if (DO_NOT_TRANSLATE.has(s)) return false;

  if (/^[a-z0-9_.-]+$/.test(s)) return false;                 // lowercase identifier
  if (s.includes("://")) return false;                        // urls
  if (/^[~./]/.test(s) || s.includes("\\")) return false;     // posix and windows paths
  if (/^[A-Za-z]:\\/.test(s)) return false;
  if (/===|!==|=>|&&|\|\|/.test(s)) return false;             // expressions
  if (/\(\)\s*$/.test(s)) return false;                       // fn()
  if (/^[A-Z][A-Z0-9]*-\d+$/.test(s)) return false;           // PAP-10114
  if (/^\S+@\S+\.\S+$/.test(s)) return false;                 // email
  if (/^["\'].*["\']$/.test(s)) return false;                 // "prompt"
  if (/^\d+([.,]\d+)?\s*\S{0,3}$/.test(s)) return false;      // numbers and units
  if (s.includes("{{") || s.includes("${")) return false;     // already interpolated

  // A fragment that opens with punctuation is the tail of a split sentence.
  if (/^[,.;:·—–]/.test(s)) return false;

  if (!/\s/.test(s)) {
    if (s.length < 3) return false;                 // "OK", avatar initials
    if (/^[A-Z0-9]{1,4}$/.test(s)) return false;    // PID, SSH, KEY, LG, DF
  }

  // Single token carrying internal capitals, underscore, colon, slash or a
  // file extension: identifier, path, filename or brand — never a sentence.
  if (!/\s/.test(s)) {
    if (/[a-z][A-Z]/.test(s)) return false;
    if (/[_:/]/.test(s)) return false;
    if (/\.[A-Za-z]{1,4}$/.test(s)) return false;
  }
  return true;
}

