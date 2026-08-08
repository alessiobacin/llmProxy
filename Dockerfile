FROM node:22-alpine

WORKDIR /app

ENV PORT=7045 \
    HOST=0.0.0.0 \
    NODE_ENV=production \
    LLMPROXY_ENV=production \
    LLMPROXY_GLOBAL_SERVICE=1

# Install only runtime dependencies
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Copy application sources
COPY api ./api
COPY assets ./assets
COPY bin ./bin
COPY lib ./lib
COPY server.js ./server.js
COPY manifest.json ./manifest.json

# Data root for the non-root runtime user (node).
ENV LLMPROXY_HOME=/home/node/.local/share/llmProxy
RUN mkdir -p /home/node/.local/share/llmProxy \
    && chown -R node:node /home/node/.local/share/llmProxy

USER node

EXPOSE 7045

# Keep the runtime process unprivileged.

CMD ["node", "server.js"]
