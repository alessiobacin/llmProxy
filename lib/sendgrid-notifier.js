"use strict";

const os = require("node:os");
const DEFAULT_MIN_INTERVAL_MS = 5 * 60 * 1000;

function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return "unknown";
}

function buildSystemContextHtml() {
  const hostname = os.hostname();
  const localIp = getLocalIp();
  const cwd = process.cwd ? process.cwd() : "unknown";
  return `<hr><p style="font-size:0.85em;color:#888;">
    <strong>Host:</strong> ${hostname} | <strong>IP locale:</strong> ${localIp}<br>
    <strong>Directory:</strong> ${cwd}<br>
    <strong>PID:</strong> ${process.pid}
  </p>`;
}
const DEFAULT_MESSAGE_TYPES = [
  "service_unreachable",
  "service_recovered",
  "provider_error",
  "auto_escalation",
  "provider_credit_exhausted",
  "service_update",
];

function normalizeMessageTypes(value) {
  // Explicit empty string → nessun tipo di messaggio abilitato
  if (typeof value === "string" && !String(value).trim()) {
    return new Set();
  }
  // Non impostato → default (tutti i tipi)
  if (value === null || value === undefined) {
    return new Set(DEFAULT_MESSAGE_TYPES);
  }
  const raw = String(value).trim().toLowerCase();
  if (raw === "*" || raw === "all") {
    return new Set(DEFAULT_MESSAGE_TYPES);
  }
  const items = raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return new Set(items);
}

function createSendGridNotifier({ apiKey, fromEmail, toEmail, messageTypes, minIntervalMs } = {}) {
  const interval = Number.isFinite(minIntervalMs) && minIntervalMs > 0 ? minIntervalMs : DEFAULT_MIN_INTERVAL_MS;
  const state = {
    apiKey: String(apiKey || "").trim(),
    fromEmail: String(fromEmail || "").trim(),
    toEmail: String(toEmail || "").trim(),
    messageTypes: normalizeMessageTypes(messageTypes),
  };

  let sgMail = null;
  function getSgMail() {
    if (!sgMail) {
      sgMail = require("@sendgrid/mail");
      sgMail.setApiKey(state.apiKey);
    }
    return sgMail;
  }

  const lastNotification = new Map();
  function isConfigured() {
    return Boolean(state.apiKey && state.fromEmail && state.toEmail);
  }

  function isEnabled(messageType) {
    return state.messageTypes.has(String(messageType || "").trim().toLowerCase());
  }

  function shouldThrottle(key) {
    const last = lastNotification.get(key);
    if (!last) return false;
    return Date.now() - last < interval;
  }

  async function sendAlert(subject, htmlContent) {
    if (!isConfigured()) return;
    const mail = getSgMail();
    await mail.send({
      to: state.toEmail,
      from: state.fromEmail,
      subject,
      html: htmlContent + buildSystemContextHtml(),
    });
  }

  async function sendTypedAlert({ messageType, throttleKey, subject, html }) {
    if (!isConfigured() || !isEnabled(messageType) || shouldThrottle(throttleKey)) return;
    lastNotification.set(throttleKey, Date.now());
    await sendAlert(subject, html);
  }

  return {
    get name() {
      return isConfigured() ? "sendgrid" : "sendgrid-noop";
    },

    async notifyUnreachable(service, url, error) {
      const errorText = error ? String(error.message || error).slice(0, 500) : "nessun dettaglio";
      await sendTypedAlert({
        messageType: "service_unreachable",
        throttleKey: `service_unreachable:${service}`,
        subject: `[llmProxy] ${service} unreachable`,
        html: `<p>Il servizio <strong>${service}</strong> non è raggiungibile.</p>
         <p><strong>URL tentato:</strong> ${url}</p>
         <p><strong>Errore:</strong> ${errorText}</p>
         <p><em>llmProxy continuerà a usare il fallback locale.</em></p>`,
      });
    },

    async notifyRecovered(service, url) {
      await sendTypedAlert({
        messageType: "service_recovered",
        throttleKey: `service_recovered:${service}`,
        subject: `[llmProxy] ${service} recovered`,
        html: `<p>Il servizio <strong>${service}</strong> è tornato raggiungibile.</p>
         <p><strong>URL:</strong> ${url}</p>`,
      });
    },

    async notifyProviderError({ provider, model, reason, requestId, projectPath } = {}) {
      const providerLabel = String(provider || "unknown").trim() || "unknown";
      const modelLabel = String(model || "unknown").trim() || "unknown";
      const reasonText = String(reason || "unknown error").trim() || "unknown error";
      const requestLabel = String(requestId || "").trim();
      const projectLabel = String(projectPath || "").trim();
      await sendTypedAlert({
        messageType: "provider_error",
        throttleKey: `provider_error:${providerLabel}:${modelLabel}`,
        subject: `[llmProxy] provider error: ${providerLabel}/${modelLabel}`,
        html: `<p>Il provider <strong>${providerLabel}</strong> ha restituito un errore.</p>
         <p><strong>Model:</strong> ${modelLabel}</p>
         <p><strong>Reason:</strong> ${reasonText}</p>
         <p><strong>Request ID:</strong> ${requestLabel || "n/a"}</p>
         <p><strong>Project:</strong> ${projectLabel || "n/a"}</p>`,
      });
    },

    reconfigure({ apiKey: newKey, fromEmail: newFrom, toEmail: newTo, messageTypes } = {}) {
      if (newKey !== undefined) {
        const key = String(newKey || "").trim();
        state.apiKey = key;
        if (key && sgMail) sgMail.setApiKey(key);
      }
      if (newFrom !== undefined) state.fromEmail = String(newFrom || "").trim();
      if (newTo !== undefined) state.toEmail = String(newTo || "").trim();
      if (messageTypes !== undefined) state.messageTypes = normalizeMessageTypes(messageTypes);
    },
  };
}

module.exports = { createSendGridNotifier };
