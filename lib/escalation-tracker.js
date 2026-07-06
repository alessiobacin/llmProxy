"use strict";

/**
 * EscalationTracker — traccia richieste ripetute sullo stesso problema ed escala
 * automaticamente a provider alternativi dopo N richieste identiche ripetute.
 *
 * Lo stato è tenuto in memoria (Map). Ogni conversazione è identificata da una
 * conversationKey derivata dallo user message corrente.
 */
class EscalationTracker {
  constructor(options = {}) {
    this.enabled = options.enabled === true;
    this.threshold = options.threshold || 2;
    this.store = new Map();
    this.maxEntries = options.maxEntries || 1000;
  }

  /**
   * Hash semplice del testo normalizzato.
   * Pubblica così che copilot-proxy.js possa usarlo per derivare conversationKey.
   */
  hash(text) {
    let hash = 0;
    const normalized = String(text || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
    for (let i = 0; i < normalized.length; i++) {
      hash = ((hash << 5) - hash) + normalized.charCodeAt(i);
      hash |= 0;
    }
    return hash;
  }

  /** Recupera (o crea) lo stato per una conversationKey. */
  _getState(conversationKey) {
    if (!this.store.has(conversationKey)) {
      this._evictIfNeeded();
      this.store.set(conversationKey, {
        level: 0,
        attemptCount: 0,
        lastUserMsgHash: null,
        escalatedOnce: false,
      });
    }
    return this.store.get(conversationKey);
  }

  /** Evict ~75% delle entry più vecchie quando si raggiunge maxEntries. */
  _evictIfNeeded() {
    if (this.store.size >= this.maxEntries) {
      const keys = [...this.store.keys()].slice(0, Math.floor(this.maxEntries / 4));
      for (const key of keys) this.store.delete(key);
    }
  }

  /**
   * Traccia un messaggio utente per una conversazione.
   *
   * @param {string} conversationKey  Identificativo della conversazione
   * @param {string} userMessageText  Testo dell'ultimo messaggio utente
   * @returns {{ escalate: boolean, level: number }}
   */
  track(conversationKey, userMessageText) {
    if (!this.enabled || !userMessageText) {
      return { escalate: false, level: 0 };
    }

    const state = this._getState(conversationKey);
    const hash = this.hash(userMessageText);

    if (state.lastUserMsgHash === hash) {
      state.attemptCount++;
      if (state.attemptCount >= this.threshold) {
        state.level++;
        state.attemptCount = 0;
        state.escalatedOnce = true;
        return { escalate: true, level: state.level };
      }
    } else {
      if (!state.escalatedOnce) {
        state.level = 0;
        state.attemptCount = 0;
      }
    }

    state.lastUserMsgHash = hash;
    return { escalate: false, level: state.level };
  }

  /** Restituisce il livello corrente di escalation per una conversazione. */
  getLevel(conversationKey) {
    const state = this.store.get(conversationKey);
    return state ? state.level : 0;
  }

  /** Rimuove lo stato per una conversazione. */
  cleanup(conversationKey) {
    this.store.delete(conversationKey);
  }
}

module.exports = { EscalationTracker };
