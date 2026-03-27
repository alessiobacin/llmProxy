const { startServer } = require("./lib/app");
const { loadRuntimeEnv } = require("./lib/runtime-env");

process.env = loadRuntimeEnv({ env: process.env, packageRoot: __dirname });

startServer()
  .then(({ host, port }) => {
    process.stdout.write(`llmProxy listening on http://${host}:${port}\n`);
  })
  .catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });