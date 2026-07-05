"use strict";

/**
 * LLMLingua-2 prompt compression module.
 * Spawns a persistent Python process and communicates via stdin/stdout JSON.
 */

const { spawn } = require("node:child_process");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

let _process = null;
let _callbacks = new Map();
let _idCounter = 0;
let _ready = false;
let _pendingRequests = [];
let _loadingPromise = null;

/**
 * Resolve the Python venv path relative to the package root.
 */
function findPackageRoot() {
  // Walk up from __dirname (/lib) to find package.json
  let dir = __dirname;
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    dir = path.dirname(dir);
  }
  return __dirname; // fallback
}

const PACKAGE_ROOT = findPackageRoot();
const VENV_PYTHON = path.join(PACKAGE_ROOT, ".venv-llmlingua", "bin", "python3");
const COMPRESS_SCRIPT = path.join(PACKAGE_ROOT, "scripts", "compress_prompt.py");
const DEFAULT_RATE = 0.3;

function getPythonCommand() {
  // Use venv python if it exists, otherwise fall back to system python3
  if (fs.existsSync(VENV_PYTHON)) {
    return VENV_PYTHON;
  }
  // Try common python3 paths
  const candidates = ["/opt/homebrew/bin/python3.13", "/usr/local/bin/python3", "/usr/bin/python3", "python3"];
  for (const cmd of candidates) {
    try {
      const result = require("node:child_process").execSync(`${cmd} --version`, { stdio: "pipe" });
      if (result) return cmd;
    } catch {
      continue;
    }
  }
  return "python3"; // last resort
}

/**
 * Start the persistent Python compression process.
 * Returns a promise that resolves when the process is ready.
 */
function startProcess() {
  if (_loadingPromise) return _loadingPromise;

  _loadingPromise = new Promise((resolve, reject) => {
    const pythonCmd = getPythonCommand();

    _process = spawn(pythonCmd, [COMPRESS_SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        TOKENIZERS_PARALLELISM: "false",
        TRANSFORMERS_VERBOSITY: "error",
        HF_HUB_DISABLE_TELEMETRY: "1",
        HF_HUB_DISABLE_PROGRESS_BARS: "1",
      },
    });

    let stderrBuf = "";

    _process.stdout.on("data", (chunk) => {
      const lines = chunk.toString().trim().split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const response = JSON.parse(line);

          // Handle ping response → process is ready
          if (response.pong) {
            _ready = true;
            // Flush pending requests
            const pending = _pendingRequests;
            _pendingRequests = [];
            resolve();
            for (const { id, text, rate, resolveCb, rejectCb } of pending) {
              sendWithCallbacks(id, text, rate, resolveCb, rejectCb);
            }
            return;
          }

          // Handle compression response
          if (response.id && _callbacks.has(response.id)) {
            const { resolve: res, reject: rej } = _callbacks.get(response.id);
            _callbacks.delete(response.id);
            if (response.error) {
              rej(new Error(response.error));
            } else {
              res(response);
            }
          }
        } catch {
          // Ignore non-JSON output
        }
      }
    });

    _process.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString();
    });

    _process.on("exit", (code) => {
      _process = null;
      _ready = false;
      _loadingPromise = null;

      // Reject all pending callbacks
      const callbacks = _callbacks;
      _callbacks = new Map();
      for (const [, { reject }] of callbacks) {
        reject(new Error(`compression process exited (code=${code})`));
      }
    });

    _process.on("error", (err) => {
      _process = null;
      _ready = false;
      _loadingPromise = null;
      reject(err);
    });

    // Send ping to check readiness (process starts by loading the model)
    setTimeout(() => {
      sendRaw({ command: "ping" });
    }, 100);
  });

  return _loadingPromise;
}

function sendRaw(obj) {
  if (!_process || !_process.stdin.writable) {
    throw new Error("compression process not running");
  }
  _process.stdin.write(JSON.stringify(obj) + "\n");
}

function sendWithCallbacks(id, text, rate, resolveCb, rejectCb) {
  _callbacks.set(id, { resolve: resolveCb, reject: rejectCb });
  sendRaw({ id, text, rate });
}

/**
 * Compress text using LLMLingua-2.
 *
 * @param {string} text - Text to compress
 * @param {number} [rate=0.3] - Compression ratio (0.0-1.0, lower = more compression)
 * @returns {Promise<{compressed: string, original_tokens: number, compressed_tokens: number, rate: number}>}
 */
async function compress(text, rate = DEFAULT_RATE) {
  if (!text || typeof text !== "string") {
    return { compressed: text || "", original_tokens: 0, compressed_tokens: 0, rate };
  }

  const id = String(++_idCounter);

  // If process isn't ready yet, queue the request
  if (!_ready) {
    return new Promise((resolve, reject) => {
      startProcess()
        .then(() => {
          sendWithCallbacks(id, text, rate, resolve, reject);
        })
        .catch(reject);
    });
  }

  return new Promise((resolve, reject) => {
    sendWithCallbacks(id, text, rate, resolve, reject);
  });
}

/**
 * Gracefully shut down the compression process.
 */
function shutdown() {
  if (_process) {
    try {
      sendRaw({ command: "shutdown" });
    } catch {
      // ignore
    }
    setTimeout(() => {
      if (_process) _process.kill();
    }, 2000).unref();
    _process = null;
    _ready = false;
    _loadingPromise = null;
  }
  _callbacks = new Map();
  _pendingRequests = [];
}

module.exports = { compress, shutdown, startProcess };
