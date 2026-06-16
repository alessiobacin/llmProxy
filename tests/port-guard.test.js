const test = require("node:test");
const assert = require("node:assert/strict");

const {
  assertGlobalServicePortAccess,
  listPortListeners,
  parseLsofListeners,
  reapConflictingPortListeners,
} = require("../lib/port-guard");

test("parseLsofListeners extracts pid, command and endpoint records", () => {
  const listeners = parseLsofListeners([
    "p72678",
    "cCode Helper (Plugin)",
    "n127.0.0.1:7045",
    "p97011",
    "ccom.docke",
    "n*:7045",
    "",
  ].join("\n"));

  assert.deepEqual(listeners, [
    { pid: 72678, command: "Code Helper (Plugin)", endpoint: "127.0.0.1:7045" },
    { pid: 97011, command: "com.docke", endpoint: "*:7045" },
  ]);
});

test("listPortListeners returns empty when lsof reports no listeners", () => {
  const listeners = listPortListeners({
    port: 7045,
    execCommand() {
      return { status: 1, stdout: "", stderr: "" };
    },
  });

  assert.deepEqual(listeners, []);
});

test("assertGlobalServicePortAccess blocks reserved service ports for non-global runtimes", () => {
  assert.throws(
    () => assertGlobalServicePortAccess({ port: 7045, env: {} }),
    /Porta riservata: 7045/
  );
  assert.doesNotThrow(() => assertGlobalServicePortAccess({ port: 7045, env: { LLMPROXY_GLOBAL_SERVICE: "1" } }));
  assert.doesNotThrow(() => assertGlobalServicePortAccess({ port: 5045, env: {} }));
});

test("reapConflictingPortListeners preserves docker listeners and terminates foreign listeners", () => {
  const outputs = [
    [
      "p72678",
      "cCode Helper (Plugin)",
      "n127.0.0.1:7045",
      "p97011",
      "ccom.docke",
      "n*:7045",
    ].join("\n"),
    [
      "p97011",
      "ccom.docke",
      "n*:7045",
    ].join("\n"),
    [
      "p97011",
      "ccom.docke",
      "n*:7045",
    ].join("\n"),
  ];
  const killed = [];

  const result = reapConflictingPortListeners({
    port: 7045,
    allowedCommands: [/docker/i, /com\.docke/i],
    execCommand() {
      return { status: 0, stdout: outputs.shift() || "", stderr: "" };
    },
    killProcess(pid, signal) {
      killed.push({ pid, signal });
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(killed, [{ pid: 72678, signal: "SIGTERM" }]);
});

test("reapConflictingPortListeners escalates to SIGKILL when a listener survives SIGTERM", () => {
  const outputs = [
    [
      "p72678",
      "cnode",
      "n127.0.0.1:7045",
    ].join("\n"),
    [
      "p72678",
      "cnode",
      "n127.0.0.1:7045",
    ].join("\n"),
    "",
  ];
  const killed = [];

  const result = reapConflictingPortListeners({
    port: 7045,
    execCommand() {
      return { status: 0, stdout: outputs.shift() || "", stderr: "" };
    },
    killProcess(pid, signal) {
      killed.push({ pid, signal });
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(killed, [
    { pid: 72678, signal: "SIGTERM" },
    { pid: 72678, signal: "SIGKILL" },
  ]);
});
