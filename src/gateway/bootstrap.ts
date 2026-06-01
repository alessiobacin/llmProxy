// V11 gateway bootstrap — typed composition root for Module 45.
// Thin typed wrapper around the Express app factory.
// Serves as the seam for a future Fastify/Next.js shell swap.

// eslint-disable-next-line @typescript-eslint/no-var-requires
const jsApp: {
  createApp: (opts: Record<string, unknown>) => Record<string, unknown>;
  startServer: (opts: Record<string, unknown>) => Promise<{ server: unknown; port: number; host: string }>;
} = require("../../lib/app");

function createGatewayApp(options: Record<string, unknown> = {}): Record<string, unknown> {
  return jsApp.createApp(options);
}

async function startGateway(options: Record<string, unknown> = {}): Promise<{ server: unknown; port: number; host: string }> {
  return jsApp.startServer(options);
}

export { createGatewayApp, startGateway };
