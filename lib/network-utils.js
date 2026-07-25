/**
 * Network utility functions for LLM proxy.
 */

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientNetworkError(errorText) {
  const text = String(errorText || "");
  return /socket connection was closed unexpectedly|socket.*closed|econnreset|econnrefused|etimedout|und_err_socket|network error|fetch failed|timeout|temporar/i.test(text);
}

function makeProxyFetch(baseFetch, proxyUrl) {
  if (!proxyUrl) return baseFetch;
  try {
    const undici = require("undici");
    const proxyAgent = proxyUrl ? new undici.ProxyAgent(proxyUrl) : null;
    if (!proxyAgent) return baseFetch;
    return (url, opts = {}) => undici.fetch(url, { ...opts, dispatcher: proxyAgent });
  } catch {
    return baseFetch;
  }
}

async function fetchWithNetworkRetry(requestFn, options = {}) {
  const maxAttempts = Number(options.maxAttempts || 2);
  const retryDelayMs = Number(options.retryDelayMs || 200);
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await requestFn();
    } catch (error) {
      lastError = error;
      const message = error?.message || String(error || "");
      const canRetry = attempt < maxAttempts && isTransientNetworkError(message);
      if (!canRetry) throw error;
      await delay(retryDelayMs * attempt);
    }
  }

  throw lastError || new Error("network request failed");
}

module.exports = { fetchWithNetworkRetry, makeProxyFetch, delay, isTransientNetworkError };
