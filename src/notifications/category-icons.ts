/**
 * Category icons for claim notifications.
 *
 * Provides a default map of claim category names to emoji icons and a lookup
 * helper `iconForCategory` that returns a fallback icon for unknown or missing
 * categories.
 *
 * Constraints:
 * - All icons must remain strictly free of Telegram MarkdownV2 reserved characters
 *   (`_*[]()~`>#+-=|{}.!\`) so they can be interpolated directly into MarkdownV2
 *   templates without escaping.
 * - Matching is case-insensitive and trims surrounding whitespace.
 */

/** Default fallback icon used for unknown, missing, or empty categories. */
export const DEFAULT_FALLBACK_ICON = "🏷️";
export const FALLBACK_CATEGORY_ICON = DEFAULT_FALLBACK_ICON;

/** Default mapping of normalized (lowercase) category names to emoji icons. */
export const DEFAULT_CATEGORY_ICONS: Readonly<Record<string, string>> = Object.freeze({
  crypto: "🪙",
  sports: "⚽",
  politics: "🏛️",
  science: "🔬",
  culture: "🎭",
  tech: "💻",
  technology: "💻",
  finance: "💰",
  business: "💼",
  economics: "📊",
  entertainment: "🎬",
  music: "🎵",
  weather: "🌦️",
  climate: "🌍",
  world: "🌐",
  news: "📰",
  gaming: "🎮",
  education: "📚",
  health: "🏥",
  ai: "🤖",
});

export const CATEGORY_ICONS = DEFAULT_CATEGORY_ICONS;

/**
 * Returns the category icon for a given category name, or a fallback icon if unknown.
 *
 * Matching is case-insensitive. Surrounding whitespace is trimmed.
 * Non-string, null, undefined, or empty inputs return the fallback icon.
 *
 * @param category Raw category string or unknown value
 * @returns Emoji icon string suitable for MarkdownV2 and plain text
 */
export function iconForCategory(category?: string | null | unknown): string {
  if (typeof category !== "string") {
    return DEFAULT_FALLBACK_ICON;
  }
  const normalized = category.trim().toLowerCase();
  if (!normalized) {
    return DEFAULT_FALLBACK_ICON;
  }
  return DEFAULT_CATEGORY_ICONS[normalized] ?? DEFAULT_FALLBACK_ICON;
}
