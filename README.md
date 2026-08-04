# opencode-statboard

Real-time dashboard for your [opencode](https://opencode.ai) token usage and cost statistics, built with zero dependencies (pure Node.js + vanilla HTML/CSS/JS).

## Features

- Live-updating overview: sessions, messages, total cost, tokens per session
- Token statistics: Input / Output / Cache Read / Cache Write
- Tool usage breakdown with percentage bars (collapsible)
- Per-model usage with cache read stats
- Daily trend chart (7D / 30D / 90D, 90D uses downsampling for speed)
- i18n: English + Traditional Chinese, auto-detects browser language

## Requirements

- Node.js (tested on v24)
- [opencode](https://opencode.ai) CLI installed globally via npm
- No npm packages required

## Install

```bash
npm install -g opencode-statboard
opencode-dashboard
```

Then open http://127.0.0.1:4868

## License

MIT
