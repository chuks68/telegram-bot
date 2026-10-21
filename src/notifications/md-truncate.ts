/**
 * Truncate already-formatted MarkdownV2 text without breaking entities or escapes.
 *
 * Telegram's MarkdownV2 parser rejects malformed entities: an unclosed `*`, `_`,
 * `` ` `` or `[`, a dangling `\` escape, or a cut inside a link URL all cause a
 * send to fail. `clip` and `splitTelegramMessage` operate on raw/unescaped text,
 * so callers shortening an already-rendered caption or preview need this helper.
 *
 * The text is scanned code unit by code unit. A backslash escapes the following
 * reserved character (so it never toggles an entity). Outside a code span,
 * unescaped `*`, `_` and `` ` `` toggle their entity on a matching stack; `[`
 * opens a link and the scanner refuses to cut inside the link text or its URL.
 *
 * A cut position is eligible only when no link is open, the trailing backslash
 * run is even (never a lone `\`), and the remaining budget covers the ellipsis
 * plus a closer for every still-open entity. At an eligible cut, open entities
 * are closed in reverse open order, then `ellipsis` is appended. The result is
 * bounded by `max` and balanced: every opened entity is closed.
 *
 * Complexity: O(k) time and O(d) space where k = min(text.length, max) and d is
 * the maximum entity nesting depth. At most three closers (one per entity type)
 * are ever appended, so the closer budget is constant.
 *
 * Limits: `max` must be >= 1. If `max` is smaller than `ellipsis`, the ellipsis
 * is truncated to fit. When the whole text is a single unclosed entity or link,
 * the result may be just the ellipsis.
 */
export function truncateMarkdownV2(text: string, max: number, ellipsis = "…"): string {
  if (!Number.isFinite(max) || max < 1) {
    throw new RangeError(`truncateMarkdownV2 max must be >= 1, got ${max}`);
  }

  if (text.length <= max) return text;

  const effEllipsis = ellipsis.length > max ? ellipsis.slice(0, max) : ellipsis;
  const ellipsisLen = effEllipsis.length;
  const limit = max - ellipsisLen; // largest cut index that can still fit closers

  // Still-open `*` / `_` / `` ` `` entities, in open order.
  const open: string[] = [];
  let codeOpen = false;
  // Link stage: 0 = outside a link, 1 = link text, 2 = after `]` awaiting `(`,
  // 3 = inside the URL (between `(` and `)`).
  let linkStage = 0;
  // Length of the consecutive backslash run immediately before index i.
  let bsRun = 0;
  // True when the previous character was a backslash that escapes this one.
  let escape = false;

  let bestI = 0;
  let bestOpen: string[] = [];

  let i = 0;
  const n = text.length;
  while (i <= limit) {
    // Eligible cut: not inside a link, not mid escape, budget fits closers.
    if (linkStage === 0 && bsRun % 2 === 0 && i + open.length + ellipsisLen <= max) {
      bestI = i;
      bestOpen = open.slice();
    }

    if (i === n) break;

    const cu = text.charCodeAt(i);
    const ch = text[i];

    if (codeOpen) {
      if (ch === "`") {
        open.pop();
        codeOpen = false;
      }
      bsRun = ch === "\\" ? bsRun + 1 : 0;
    } else if (ch === "\\") {
      escape = true;
      bsRun += 1;
    } else if (escape) {
      escape = false;
      bsRun = ch === "\\" ? bsRun + 1 : 0;
    } else {
      bsRun = 0;
      if (linkStage === 0) {
        if (ch === "*" || ch === "_" || ch === "`") {
          const top = open[open.length - 1];
          if (top === ch) {
            open.pop();
            if (ch === "`") codeOpen = false;
          } else {
            open.push(ch);
            if (ch === "`") codeOpen = true;
          }
        } else if (ch === "[") {
          linkStage = 1;
        }
      } else if (linkStage === 1) {
        if (ch === "]") linkStage = 2;
      } else if (linkStage === 2) {
        if (ch === "(") linkStage = 3;
        else linkStage = 0;
      } else if (linkStage === 3) {
        if (ch === ")") linkStage = 0;
      }
    }

    i +=
      cu >= 0xd800 &&
      cu <= 0xdbff &&
      i + 1 < n &&
      text.charCodeAt(i + 1) >= 0xdc00 &&
      text.charCodeAt(i + 1) <= 0xdfff
        ? 2
        : 1;
  }

  const closers = bestOpen.slice().reverse().join("");
  return text.slice(0, bestI) + closers + effEllipsis;
}
