FROM node:22-alpine

WORKDIR /app

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

EXPOSE 7045

CMD ["node", "server.js"]
