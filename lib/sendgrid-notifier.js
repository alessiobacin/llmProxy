"use strict";

const DEFAULT_MIN_INTERVAL_MS = 5 * 60 * 1000;

function createSendGridNotifier({ apiKey, fromEmail, toEmail, minIntervalMs } = {}) {
  const effectiveApiKey = String(apiKey || "").trim();
  const effectiveFrom = String(fromEmail || "").trim();
  const effectiveTo = String(toEmail || "").trim();
  const interval = Number.isFinite(minIntervalMs) && minIntervalMs > 0 ? minIntervalMs : DEFAULT_MIN_INTERVAL_MS;

  if (!effectiveApiKey || !effectiveFrom || !effectiveTo) {
    return {
      name: "sendgrid-noop",
      async notifyUnreachable() {},
      async notifyRecovered() {},
      reconfigure() {},
    };
  }

  let sgMail = null;
  function getSgMail() {
    if (!sgMail) {
      sgMail = require("@sendgrid/mail");
      sgMail.setApiKey(effectiveApiKey);
    }
    return sgMail;
  }

  const lastNotification = new Map();

  function shouldThrottle(service) {
    const last = lastNotification.get(service);
    if (!last) return false;
    return Date.now() - last < interval;
  }

  async function sendAlert(subject, htmlContent) {
    const mail = getSgMail();
    await mail.send({
      to: effectiveTo,
      from: effectiveFrom,
      subject,
      html: htmlContent,
    });
  }

  return {
    name: "sendgrid",

    async notifyUnreachable(service, url, error) {
      if (shouldThrottle(service)) return;
      lastNotification.set(service, Date.now());
      const errorText = error ? String(error.message || error).slice(0, 500) : "nessun dettaglio";
      await sendAlert(
        `[llmProxy] ${service} unreachable`,
        `<p>Il servizio <strong>${service}</strong> non è raggiungibile.</p>
         <p><strong>URL:</strong> ${url}</p>
         <p><strong>Errore:</strong> ${errorText}</p>
         <p><em>llmProxy continuerà a usare il fallback locale.</em></p>`,
      );
    },

    async notifyRecovered(service, url) {
      if (shouldThrottle(service)) return;
      lastNotification.set(service, Date.now());
      await sendAlert(
        `[llmProxy] ${service} recovered`,
        `<p>Il servizio <strong>${service}</strong> è tornato raggiungibile.</p>
         <p><strong>URL:</strong> ${url}</p>`,
      );
    },

    reconfigure({ apiKey: newKey, fromEmail: newFrom, toEmail: newTo }) {
      if (newKey !== undefined) {
        const key = String(newKey || "").trim();
        if (key && sgMail) sgMail.setApiKey(key);
      }
    },
  };
}

module.exports = { createSendGridNotifier };
