#!/usr/bin/env node

const path = require("node:path");
const { runCli } = require("../lib/cli");

if (path.basename(process.argv[1] || "") === "llmproxy") {
  process.env.LLMPROXY_RUNTIME_PROFILE = process.env.LLMPROXY_RUNTIME_PROFILE || "production";
}

Promise.resolve(runCli(process.argv))
  .then((exitCode) => {
    if (typeof exitCode === "number") process.exitCode = exitCode;
  })
  .catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });