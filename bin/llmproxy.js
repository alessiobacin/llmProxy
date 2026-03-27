#!/usr/bin/env node

const { runCli } = require("../lib/cli");

Promise.resolve(runCli(process.argv))
  .then((exitCode) => {
    if (typeof exitCode === "number") process.exitCode = exitCode;
  })
  .catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });