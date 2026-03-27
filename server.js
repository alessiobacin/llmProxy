const { startServer } = require("./lib/app");

startServer()
  .then(({ host, port }) => {
    process.stdout.write(`llmProxy listening on http://${host}:${port}\n`);
  })
  .catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });