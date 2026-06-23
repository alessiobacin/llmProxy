const { createLaunchdServiceManager } = require("./service/launchd");
const { createSystemdServiceManager } = require("./service/systemd");
const { createWindowsServiceManager } = require("./service/windows");

function createServiceManager(options = {}) {
  const platform = options.platform || process.platform;
  if (platform === "darwin") return createLaunchdServiceManager(options);
  if (platform === "linux") return createSystemdServiceManager(options);
  if (platform === "win32") return createWindowsServiceManager(options);

  return {
    kind: "unsupported",
    renderServiceDefinition() {
      throw new Error(`Unsupported platform: ${platform}`);
    },
    install() {
      throw new Error(`Unsupported platform: ${platform}`);
    },
    stop() {
      throw new Error(`Unsupported platform: ${platform}`);
    },
    status() {
      return { ok: false, active: false, stdout: "", stderr: `Unsupported platform: ${platform}` };
    },
  };
}

module.exports = {
  createServiceManager,
};