"use strict";

const VALID_CRITERIA = ["price", "power", "speed"];

function parseReorderingCriteria(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return [];
  const tokens = raw.split("-").map((token) => token.trim()).filter(Boolean);
  const seen = new Set();
  const criteria = [];
  for (const token of tokens) {
    if (!VALID_CRITERIA.includes(token)) {
      throw new Error(`LLMPROXY_REORDERING: criterio non valido "${token}" (ammessi: ${VALID_CRITERIA.join(", ")})`);
    }
    if (seen.has(token)) {
      throw new Error(`LLMPROXY_REORDERING: criterio duplicato "${token}"`);
    }
    seen.add(token);
    criteria.push(token);
  }
  return criteria;
}

function resolveReorderingCriteria(envSource) {
  const source = envSource || process.env;
  return parseReorderingCriteria(source.LLMPROXY_REORDERING);
}

function resolveReorderingMinutes(override, envSource) {
  if (typeof override === "number" && override > 0) return override;
  const source = envSource || process.env;
  const criteria = parseReorderingCriteria(source.LLMPROXY_REORDERING);
  if (criteria.length === 0) return 0;
  const raw = String(source.LLMPROXY_REORDERING_MINUTES || "").trim();
  const num = Number(raw);
  if (Number.isFinite(num) && num > 0) return num;
  return 5;
}

module.exports = {
  VALID_CRITERIA,
  parseReorderingCriteria,
  resolveReorderingCriteria,
  resolveReorderingMinutes,
};
