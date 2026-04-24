# llmProxy

`llmProxy` is a standalone CLI and GitHub Copilot proxy that exposes an Anthropic-compatible `/v1/messages` endpoint, with local login, persistent service management, logs, fallback across multiple Copilot accounts, and bilingual documentation.

## Documentation

- Italian: [README-IT.md](README-IT.md)
- English: [README-EN.md](README-EN.md)
- Runtime CLI via REST (IT): [README-IT.md#endpoint-http](README-IT.md#endpoint-http)
- Runtime CLI via REST (EN): [README-EN.md#http-endpoints](README-EN.md#http-endpoints)

## Quick Links

- Italian install flow: `npm run install:persistent-it` or `llmproxy install:persistent-it`
- English install flow: `npm run install:persistent-en` or `llmproxy install:persistent-en`
- Quick local inference test: `llmproxy test`

## Clone

```bash
git clone https://github.com/alessiobacin/llmProxy.git
cd llmProxy
pnpm install
```