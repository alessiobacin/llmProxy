"use strict";
// V11 gateway bootstrap — typed composition root for Module 45.
// Thin typed wrapper around the Express app factory.
// Serves as the seam for a future Fastify/Next.js shell swap.
Object.defineProperty(exports, "__esModule", { value: true });
exports.createGatewayApp = createGatewayApp;
exports.startGateway = startGateway;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const jsApp = require("../../lib/app");
function createGatewayApp(options = {}) {
    return jsApp.createApp(options);
}
async function startGateway(options = {}) {
    return jsApp.startServer(options);
}
