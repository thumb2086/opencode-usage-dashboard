# opencode-statboard

Real-time dashboard for your [opencode](https://opencode.ai) token usage and cost statistics.

## Features

- Live-updating overview: sessions, messages, total cost, tokens per session
- Token statistics: Input / Output / Reasoning / Cache Read / Cache Write
- Tool usage breakdown with percentage bars (collapsible)
- Per-model usage with cache read stats
- Daily trend chart (7D / 30D / 90D)
- Usage reports: Daily / Weekly / Monthly / All time
- i18n: English + Traditional Chinese, auto-detects browser language
- Gzip compressed API responses
- Auto port fallback if 4868 is in use

## Requirements

- Node.js (tested on v24)
- [opencode](https://opencode.ai) CLI installed globally via npm
- Reads the local `opencode.db`; supports both OpenCode V2 (`session_v2` / `session_message`) and legacy V1 (`session` / `message` / `part`) database schemas

## Install

```bash
npm install -g opencode-statboard
```

## Start

```bash
opencode-dashboard
```

Then open http://127.0.0.1:4868

## Update

```bash
npm update -g opencode-statboard
```

## Options

- `OC_PORT` — change the listening port (default: 4868, auto-fallbacks to next available)

## License

MIT
