# opencode Usage Dashboard

Real-time dashboard for your [opencode](https://opencode.ai) token usage and cost statistics, built with zero dependencies (pure Node.js + vanilla HTML/CSS/JS).

## Features

- Live-updating overview: sessions, messages, total cost, tokens per session
- Token statistics: Input / Output / Cache Read / Cache Write
- Tool usage breakdown with percentage bars
- Per-model usage (messages, input, output, cache read, cost)
- Daily trend chart for the last 7 days (tokens per day and cost per day)
- Polls `/api/stats` every 5 seconds in the browser; the server re-runs `opencode stats` every 10 seconds
- **i18n**: English (default) + Traditional Chinese, auto-detects browser language, manual toggle with localStorage

## Requirements

- Node.js (tested on v24)
- [opencode](https://opencode.ai) CLI installed globally via npm
- No npm packages required

## Usage

### Install globally (recommended)

```bash
npm install -g github:thumb2086/opencode-usage-dashboard
opencode-dashboard
```

### Or run directly

```bash
git clone https://github.com/thumb2086/opencode-usage-dashboard.git
cd opencode-usage-dashboard
npm start
```

### Windows PowerShell

```powershell
.\start.ps1
```

Then open http://127.0.0.1:4868 in your browser.

## How it works

The server shells out to the `opencode stats` CLI at a fixed interval, parses the text-table output, and exposes it as JSON at `/api/stats`. The dashboard page polls that endpoint and re-renders. The daily trend is computed by diffing cumulative `opencode stats --days N` windows.

The opencode executable path is auto-detected from `%APPDATA%\npm\node_modules\opencode-ai\bin\opencode.exe`, falling back to `opencode` on PATH.

## Configuration (top of server.js)

| Constant | Default | Description |
|---|---|---|
| `PORT` | `4868` | HTTP port |
| `REFRESH_MS` | `10000` | How often to re-run `opencode stats` |
| `TREND_MS` | `180000` | How often to regenerate the 7-day trend |
| `TREND_DAYS` | `8` | Trend window (today + N-1 days back) |

## License

MIT
