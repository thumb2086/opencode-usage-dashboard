#!/usr/bin/env node
/**
 * TUI Dashboard for opencode-statboard
 * Terminal-based dashboard using blessed
 */

const blessed = require('blessed');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const pkg = require('./package.json');

class TUIServer {
  constructor(options = {}) {
    this.port = options.port || 4868;
    this.host = options.host || '127.0.0.1';
    this.serverProcess = null;
    this.screen = null;
    this.layout = {};
    this.data = {
      overview: null,
      projects: [],
      models: [],
      trend: null,
      loading: true,
      error: null
    };
    this.currentView = 'overview';
    this.views = ['overview', 'projects', 'models', 'trend', 'heatmap'];
    this.pollInterval = null;
    this.lastUpdate = null;
    this._earlyLogs = [];
  }

  async start() {
    this.startServer();
    await this.sleep(1500);
    this.initTUI();
    this.startPolling();
    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());
  }

  startServer() {
    const serverPath = path.join(__dirname, 'server.js');
    this.serverProcess = spawn('node', [serverPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, OC_PORT: String(this.port) }
    });

    this.serverProcess.stdout.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) this.log('[SERVER] ' + msg);
    });

    this.serverProcess.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) this.log('[SERVER ERR] ' + msg);
    });

    this.serverProcess.on('close', (code) => {
      this.log('Server exited with code ' + code);
    });
  }

  async fetchData(endpoint) {
    return new Promise((resolve, reject) => {
      http.get('http://' + this.host + ':' + this.port + endpoint, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const raw = res.headers['content-type']?.includes('utf-16') 
              ? Buffer.from(data, 'utf16le').toString('utf8')
              : data;
            resolve(JSON.parse(raw));
          } catch (e) {
            reject(e);
          }
        });
      }).on('error', reject);
    });
  }

  async pollData() {
    try {
      const [stats, report, models, trend] = await Promise.all([
        this.fetchData('/api/stats?days=7'),
        this.fetchData('/api/report?days=7'),
        this.fetchData('/api/stats?days=7').then(r => r.models || []),
        this.fetchData('/api/stats?days=90')
      ]);

      // Parse stats response
      const statsData = stats.data || stats;
      const overview = statsData.overview || {};
      const cost = statsData.cost || {};
      const tools = statsData.tools || [];

      // Parse report for projects (from agents)
      const reportData = report.report || report;
      const agents = reportData.agents || [];
      const projects = (agents || [])
        .filter(a => a.sessions > 0)
        .map(a => ({
          name: a.agent,
          mainSessionCount: a.sessions,
          sessionCount: a.sessions,
          tokens: { total: (a.tok_in || 0) + (a.tok_out || 0) + (a.tok_reasoning || 0) + (a.cache_read || 0) },
          cost: a.cost || 0
        }));

      // Parse trend
      const trendData = trend.trend || trend;

      this.data = {
        overview: {
          sessions: overview.sessions || { main: 0, total: 0 },
          projects: overview.projects || 0,
          days: overview.days || 0,
          messages: overview.messages || 0
        },
        projects: Array.isArray(projects) ? projects : [],
        models: Array.isArray(models) ? models : [],
        trend: trendData,
        tokens: {
          input: cost.input || 0,
          output: cost.output || 0,
          reasoning: cost.reasoning || 0,
          cacheRead: cost.cacheRead || 0,
          cacheWrite: cost.cacheWrite || 0,
          total: (cost.input || 0) + (cost.output || 0) + (cost.reasoning || 0) + (cost.cacheRead || 0) + (cost.cacheWrite || 0)
        },
        cost: {
          total: cost.total || 0,
          marketValue: cost.marketTotal || 0,
          saved: cost.savedTotal || 0,
          savedPct: cost.proxyShare || 0,
          avgCostPerDay: cost.avgDay || 0,
          avgTokensPerDay: cost.avgTokensDay || 0
        },
        loading: false,
        error: null,
        lastUpdate: new Date()
      };
      this.lastUpdate = new Date();
      this.render();
    } catch (e) {
      this.data.error = e.message;
      this.data.loading = false;
      this.render();
    }
  }

  startPolling() {
    this.pollData();
    this.pollInterval = setInterval(() => this.pollData(), 15000);
  }

  initTUI() {
    this.screen = blessed.screen({
      smartCSR: true,
      title: 'opencode-statboard TUI v' + pkg.version,
      fullUnicode: true,
      autoPadding: true
    });

    this.screen.key(['q', 'C-c', 'escape'], () => this.shutdown());
    this.screen.key(['1'], () => this.switchView('overview'));
    this.screen.key(['2'], () => this.switchView('projects'));
    this.screen.key(['3'], () => this.switchView('models'));
    this.screen.key(['4'], () => this.switchView('trend'));
    this.screen.key(['5'], () => this.switchView('heatmap'));
    this.screen.key(['tab'], () => this.nextView());
    this.screen.key(['S-tab'], () => this.prevView());
    this.screen.key(['r'], () => this.pollData());
    this.screen.key(['w'], () => this.openWeb());

    this.createLayout();
    this.render();
  }

  createLayout() {
    this.layout.header = blessed.box({
      top: 0,
      left: 0,
      width: '100%',
      height: 2,
      tags: true,
      border: { type: 'line' },
      style: { border: { fg: 'cyan' } },
      content: '{center}{bold}opencode-statboard v' + pkg.version + '{/bold}  TUI  |  [1]Overview [2]Projects [3]Models [4]Trend [5]Heatmap [W]Web [R]Refresh [Q]Quit{/center}'
    });

    this.layout.main = blessed.box({
      top: 2,
      bottom: 2,
      left: 0,
      width: '100%',
      tags: true,
      border: { type: 'line' },
      style: { border: { fg: 'blue' } },
      scrollable: true,
      alwaysScroll: true,
      keys: true,
      vi: true,
      mouse: true
    });

    this.layout.footer = blessed.box({
      bottom: 0,
      left: 0,
      width: '100%',
      height: 2,
      tags: true,
      border: { type: 'line' },
      style: { border: { fg: 'green' } },
      content: '{center}Last update: {bold}never{/bold}  |  View: {bold}overview{/bold}  |  W:Web R:Refresh Q:Quit{/center}'
    });

    this.screen.append(this.layout.header);
    this.screen.append(this.layout.main);
    this.screen.append(this.layout.footer);

    this.render();
  }

  switchView(view) {
    if (this.views.includes(view)) {
      this.currentView = view;
      this.selectedIndex = 0;
      this.updateFooter();
      this.render();
    }
  }

  nextView() {
    const idx = this.views.indexOf(this.currentView);
    this.currentView = this.views[(idx + 1) % this.views.length];
    this.selectedIndex = 0;
    this.updateFooter();
    this.render();
  }

  prevView() {
    const idx = this.views.indexOf(this.currentView);
    this.currentView = this.views[(idx - 1 + this.views.length) % this.views.length];
    this.selectedIndex = 0;
    this.updateFooter();
    this.render();
  }

  updateFooter() {
    const time = this.lastUpdate ? this.lastUpdate.toLocaleTimeString() : 'never';
    const viewLabels = {
      overview: 'Overview',
      projects: 'Projects',
      models: 'Models',
      trend: 'Trend',
      heatmap: 'Heatmap'
    };
    this.layout.footer.setContent(
      '{center}Last update: {bold}' + time + '{/bold}  |  View: {bold}' + (viewLabels[this.currentView] || this.currentView) + '{/bold}  |  W:Web R:Refresh Q:Quit{/center}'
    );
  }

  openWeb() {
    const url = 'http://' + this.host + ':' + this.port;
    const opener = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    spawn(opener, [url], { detached: true, stdio: 'ignore' }).unref();
  }

  getContentWidth() {
    const mainWidth = this.layout.main.width;
    return typeof mainWidth === 'number' ? mainWidth - 2 : this.screen.width - 4;
  }

  getContentHeight() {
    const mainHeight = this.layout.main.height;
    return typeof mainHeight === 'number' ? mainHeight - 2 : this.screen.height - 6;
  }

  render() {
    if (this.data.loading) {
      this.layout.main.setContent('{center}{bold}Loading data...{/bold}{/center}');
    } else if (this.data.error) {
      this.layout.main.setContent('{center}{red-fg}{bold}Error: ' + this.escape(this.data.error) + '{/bold}{/red-fg}{/center}');
    } else {
      this.layout.main.setContent(this.renderCurrentView());
    }
    this.updateFooter();
    this.screen.render();
  }

  renderCurrentView() {
    switch (this.currentView) {
      case 'overview': return this.renderOverview();
      case 'projects': return this.renderProjects();
      case 'models': return this.renderModels();
      case 'trend': return this.renderTrend();
      case 'heatmap': return this.renderHeatmap();
      default: return '{center}Unknown view{/center}';
    }
  }

  renderOverview() {
    const ov = this.data;
    if (!ov || ov.loading) return '{center}{bold}Loading data...{/bold}{/center}';

    const tokens = ov.tokens || {};
    const cost = ov.cost || {};

    const lines = [
      '{center}{bold}\u2501\u2501\u2501 OVERVIEW \u2501\u2501\u2501{/bold}{/center}',
      '',
      '{bold}Sessions:{/bold} ' + (ov.overview?.sessions?.main || 0) + ' main / ' + (ov.overview?.sessions?.total || 0) + ' total',
      '{bold}Projects:{/bold} ' + (ov.overview?.projects || 0),
      '{bold}Days:{/bold} ' + (ov.overview?.days || 0),
      '{bold}Messages:{/bold} ' + (ov.overview?.messages || 0),
      '',
      '{bold}Tokens:{/bold}',
      '  Input:        ' + this.formatNumber(tokens.input || 0),
      '  Output:       ' + this.formatNumber(tokens.output || 0),
      '  Reasoning:    ' + this.formatNumber(tokens.reasoning || 0),
      '  Cache Read:   ' + this.formatNumber(tokens.cacheRead || 0),
      '  Cache Write:  ' + this.formatNumber(tokens.cacheWrite || 0),
      '  {bold}Total:        ' + this.formatNumber(tokens.total || 0) + '{/bold}',
      '',
      '{bold}Cost:{/bold} ' + this.formatCost(cost.total || 0),
      '{bold}Market Value:{/bold} ' + this.formatCost(cost.marketValue || 0),
      '{bold}Saved:{/bold} ' + this.formatCost(cost.saved || 0) + (cost.savedPct ? ' (' + cost.savedPct + '%)' : ''),
      '',
      '{bold}Avg Cost/Day:{/bold} ' + this.formatCost(cost.avgCostPerDay || 0),
      '{bold}Avg Tokens/Day:{/bold} ' + this.formatNumber(cost.avgTokensPerDay || 0)
    ];
    return lines.join('\n');
  }

  renderProjects() {
    const projects = this.data.projects || [];
    if (projects.length === 0) return '{center}No projects{/center}';

    const lines = ['{center}{bold}\u2501\u2501\u2501 PROJECTS \u2501\u2501\u2501{/bold}{/center}', ''];
    lines.push('{bold}{Project:<45} {Sessions:>10} {Tokens:>18} {Cost:>14}{/bold}');
    lines.push('{gray}\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500{/gray}');

    for (const p of projects.slice(0, 50)) {
      const name = p.name.length > 43 ? p.name.slice(0, 40) + '...' : p.name;
      const tokens = this.formatNumber(p.tokens?.total || 0);
      const cost = this.formatCost(p.cost || 0);
      const sessions = (p.mainSessionCount || 0) + '/' + (p.sessionCount || 0);
      const namePad = name.padEnd(45);
      const sessPad = sessions.padStart(10);
      const tokPad = this.formatNumber(p.tokens?.total || 0).padStart(18);
      const costPad = this.formatCost(p.cost || 0).padStart(14);
      lines.push(namePad + ' ' + sessPad + ' ' + tokPad + ' ' + costPad);
    }

    if (projects.length > 50) {
      lines.push('');
      lines.push('{gray}... and ' + (projects.length - 50) + ' more projects{/gray}');
    }

    return lines.join('\n');
  }

  renderModels() {
    const models = this.data.models || [];
    if (models.length === 0) return '{center}No models{/center}';

    const lines = ['{center}{bold}\u2501\u2501\u2501 MODELS \u2501\u2501\u2501{/bold}{/center}', ''];
    lines.push('{bold}{Model:<40} {Provider:<14} {Tokens:>18} {Cost:>12} {Speed:>10}{/bold}');
    lines.push('{gray}\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500{/gray}');

    for (const m of models.slice(0, 30)) {
      const name = m.name.length > 38 ? m.name.slice(0, 35) + '...' : m.name;
      const provider = (m.provider || 'unknown').slice(0, 12);
      const tokens = this.formatNumber(m.tokens?.total || m.tokens || 0);
      const cost = this.formatCost(m.cost || 0);
      const speed = m.speed ? m.speed.toFixed(1) + ' tok/s' : '\u2014';
      const namePad = name.padEnd(40);
      const provPad = provider.padEnd(14);
      const tokPad = tokens.padStart(18);
      const costPad = cost.padStart(12);
      const speedPad = speed.padStart(10);
      lines.push(namePad + ' ' + provPad + ' ' + tokPad + ' ' + costPad + ' ' + speedPad);
    }

    return lines.join('\n');
  }

  renderTrend() {
    const trend = this.data.trend;
    if (!trend || !trend.labels || !trend.labels.length) {
      return '{center}No trend data{/center}';
    }

    const labels = trend.labels;
    const input = trend.input || [];
    const output = trend.output || [];
    const cost = trend.cost || [];

    const maxVal = Math.max(...input, ...output, 1);
    const height = this.getContentHeight() - 4;
    const width = this.getContentWidth();

    let out = '{center}{bold}\u2501\u2501\u2501 TREND (90 days) \u2501\u2501\u2501{/bold}{/center}\n\n';
    out += '{bold}Input (cyan) / Output (green) / Cost (yellow){/bold}\n\n';

    for (let row = height - 1; row >= 0; row--) {
      let line = '';
      const threshold = (row / height) * maxVal;
      for (let i = 0; i < width; i++) {
        const idx = Math.floor(i * labels.length / width);
        const inVal = input[idx] || 0;
        const outVal = output[idx] || 0;
        if (inVal >= threshold && outVal >= threshold) line += '{magenta-fg}\u2588{/magenta-fg}';
        else if (inVal >= threshold) line += '{cyan-fg}\u2588{/cyan-fg}';
        else if (outVal >= threshold) line += '{green-fg}\u2588{/green-fg}';
        else line += ' ';
      }
      out += line + '\n';
    }

    let xAxis = '';
    const labelStep = Math.max(1, Math.ceil(width / 20));
    for (let i = 0; i < width; i++) {
      if (i % Math.ceil(width / 20) === 0) {
        const idx = Math.floor(i * labels.length / width);
        xAxis += (labels[idx] || ' ').padEnd(Math.ceil(width / 20), ' ').slice(0, Math.ceil(width / 20));
      } else {
        xAxis += ' ';
      }
    }
    out += '\n{gray}' + xAxis + '{/gray}\n';

    const lastIdx = labels.length - 1;
    out += '\n{bold}Today:{/bold} Input: ' + this.formatNumber(input[lastIdx] || 0) + ' | Output: ' + this.formatNumber(output[lastIdx] || 0) + ' | Cost: ' + this.formatCost(cost[lastIdx] || 0);

    return out;
  }

  renderHeatmap() {
    const trend = this.data.trend;
    if (!trend || !trend.dates || !trend.dates.length) {
      return '{center}No heatmap data{/center}';
    }

    const dates = trend.dates;
    const input = trend.input || [];
    const cache = trend.cacheRead || [];
    const vals = dates.map((d, i) => (input[i] || 0) + (cache[i] || 0));
    const max = Math.max(1, ...vals);

    const firstDate = new Date(dates[0]);
    const lead = firstDate.getDay();
    const cells = Array(lead).fill(null);
    dates.forEach((d, i) => cells.push({ date: d, value: vals[i] }));

    const weeks = [];
    for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
    while (weeks[weeks.length - 1]?.length < 7) weeks[weeks.length - 1].push(null);

    const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    let out = '{center}{bold}\u2501\u2501\u2501 HEATMAP (90 days) \u2501\u2501\u2501{/bold}{/center}\n\n';
    
    let monthHeader = '      ';
    let lastMonth = -1;
    for (let w = 0; w < weeks.length; w++) {
      const firstCell = weeks[w].find(c => c);
      if (firstCell) {
        const m = new Date(firstCell.date).getMonth();
        if (m !== lastMonth) {
          monthHeader += monthNames[m].padStart(7, ' ');
          lastMonth = m;
        } else {
          monthHeader += '       ';
        }
      } else {
        monthHeader += '       ';
      }
    }
    out = '{gray}' + monthHeader + '{/gray}\n';

    const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    for (let d = 0; d < 7; d++) {
      let line = '{bold}' + dow[d].padEnd(4) + '{/bold} ';
      for (let w = 0; w < weeks.length; w++) {
        const cell = weeks[w][d];
        if (!cell) {
          line += '  \u00B7  ';
        } else {
          const level = this.getHeatLevel(cell.value, max);
          const color = this.getHeatColor(level);
          const char = level === 0 ? '\u00B7' : level <= 4 ? '\u2591' : level <= 8 ? '\u2592' : level <= 12 ? '\u2593' : '\u2588';
          line += '{' + color + '-fg}' + char + '  {/}';
        }
      }
      out += line + '\n';
    }

    out += '\n{gray}Less  \u2591\u2591\u2592\u2592\u2593\u2593\u2588\u2588  More  (max: ' + this.formatNumber(max) + '){/gray}';
    return out;
  }

  getHeatLevel(value, max) {
    if (!value || value <= 0) return 0;
    const r = value / max;
    if (r >= 0.95) return 20;
    if (r >= 0.90) return 19;
    if (r >= 0.85) return 18;
    if (r >= 0.80) return 17;
    if (r >= 0.75) return 16;
    if (r >= 0.70) return 15;
    if (r >= 0.65) return 14;
    if (r >= 0.60) return 13;
    if (r >= 0.55) return 12;
    if (r >= 0.50) return 11;
    if (r >= 0.45) return 10;
    if (r >= 0.40) return 9;
    if (r >= 0.35) return 9;
    if (r >= 0.30) return 8;
    if (r >= 0.25) return 7;
    if (r >= 0.20) return 6;
    if (r >= 0.15) return 5;
    if (r >= 0.10) return 4;
    if (r >= 0.05) return 3;
    if (r >= 0.02) return 2;
    return 1;
  }

  getHeatColor(level) {
    if (level === 0) return 'gray';
    if (level <= 4) return 'blue';
    if (level <= 8) return 'cyan';
    if (level <= 12) return 'green';
    if (level <= 16) return 'yellow';
    return 'red';
  }

  formatNumber(n) {
    if (n >= 1e12) return (n / 1e12).toFixed(2) + 'T';
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(2) + 'K';
    return String(n);
  }

  formatCost(c) {
    if (c == null) return '\u2014';
    if (c >= 1e6) return '$' + (c / 1e6).toFixed(2) + 'M';
    if (c >= 1e3) return '$' + (c / 1e3).toFixed(2) + 'K';
    return '$' + c.toFixed(2);
  }

  escape(str) {
    return String(str).replace(/[{}]/g, '');
  }

  log(msg) {
    const time = new Date().toLocaleTimeString();
    console.log('[' + time + '] ' + this.escape(msg));
  }

  getContentWidth() {
    const mainWidth = this.layout.main.width;
    return typeof mainWidth === 'number' ? mainWidth - 2 : this.screen.width - 4;
  }

  getContentHeight() {
    const mainHeight = this.layout.main.height;
    return typeof mainHeight === 'number' ? mainHeight - 2 : this.screen.height - 6;
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  shutdown() {
    if (this.pollInterval) clearInterval(this.pollInterval);
    if (this.serverProcess) this.serverProcess.kill();
    this.screen.destroy();
    process.exit(0);
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const port = parseInt(process.env.OC_PORT || '4868', 10);
  
  const webOnly = args.includes('--web') || args.includes('-w');
  const bothMode = args.includes('--both') || args.includes('-b');
  
  if (webOnly) {
    require('./server.js');
  } else if (bothMode) {
    const tui = new TUIServer({ port });
    tui.start();
  } else {
    const tui = new TUIServer({ port });
    tui.start();
  }
}

module.exports = { TUIServer };