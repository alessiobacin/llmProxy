FROM node:22-alpine

WORKDIR /app

ENV PORT=7045 \
    HOST=0.0.0.0 \
    NODE_ENV=production \
    LLMPROXY_ENV=production \
    LLMPROXY_GLOBAL_SERVICE=1

# Install only runtime dependencies
COPY package.json package-lock.json pnpm-lock.yaml ./
RUN npm ci --omit=dev --no-audit --no-fund

# Copy application sources
COPY api ./api
COPY assets ./assets
COPY bin ./bin
COPY lib ./lib
COPY server.js ./server.js
COPY manifest.json ./manifest.json

EXPOSE 7045

CMD ["node", "server.js"]
