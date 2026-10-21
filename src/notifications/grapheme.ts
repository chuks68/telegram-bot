const segmenter: Intl.Segmenter | null =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function codeUnitFallback(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  let end = max;
  // Avoid splitting a surrogate pair: if the last kept code unit is a high
  // surrogate and the next code unit is a low surrogate, drop the high one.
  if (end > 0 && isHighSurrogate(text.charCodeAt(end - 1)) && end < text.length && isLowSurrogate(text.charCodeAt(end))) {
    end -= 1;
  }
  return text.slice(0, end);
}

export function clipGraphemes(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;

  if (segmenter) {
    let count = 0;
    let end = 0;
    for (const { segment, index } of segmenter.segment(text)) {
      if (count >= max) break;
      end = index + segment.length;
      count += 1;
    }
    // Never produce a lone surrogate at the boundary.
    if (end > 0 && end < text.length && isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))) {
      end -= 1;
    }
    return text.slice(0, end);
  }

  return codeUnitFallback(text, max);
}
