/**
 * Parse a boolean-like value from various input formats.
 * Returns true for "1", "true", "yes", "on"
 * Returns false for "0", "false", "no", "off"
 * Returns null for empty/undefined/null
 * Returns the value as-is if already boolean.
 */
function parseBooleanLike(value) {
  if (typeof value === "boolean") return value;
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return null;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return null;
}

module.exports = { parseBooleanLike };
