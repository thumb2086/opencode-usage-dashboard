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

const I18N = {
  en: {
    title: 'opencode-statboard v{version}  TUI',
    keys: '[1]Overview [2]Projects [3]Models [4]Trend [5]Heatmap [W]Web [R]Refresh [Q]Quit',
    footer: 'Last update: {time}  |  View: {view}  |  W:Web R:Refresh Q:Quit',
    loading: 'Loading data...',
    error: 'Error: {error}',
    overview: 'OVERVIEW',
    projects: 'PROJECTS',
    models: 'MODELS',
    trend: 'TREND (90 days)',
    heatmap: 'HEATMAP',
    noData: 'No data',
    sessions: 'Sessions',
    main: 'main',
    total: 'total',
    projectsLabel: 'Projects',
    days: 'Days',
    messages: 'Messages',
    tokens: 'Tokens',
    input: 'Input',
    output: 'Output',
    reasoning: 'Reasoning',
    cacheRead: 'Cache Read',
    cacheWrite: 'Cache Write',
    total: 'Total',
    cost: 'Cost',
    marketValue: 'Market Value',
    saved: 'Saved',
    avgCostDay: 'Avg Cost/Day',
    avgTokensDay: 'Avg Tokens/Day',
    projectHeader: '{Project:<45} {Sessions:>10} {Tokens:>18} {Cost:>14}',
    modelHeader: '{Model:<40} {Provider:<14} {Tokens:>18} {Cost:>12} {Speed:>10}',
    unknown: 'unknown',
    today: 'Today',
    version: 'Version'
  },
  zh: {
    title: 'opencode-statboard v{version}  TUI',
    keys: '[1]總覽 [2]專案 [3]模型 [4]趨勢 [5]熱力 [W]網頁 [R]重整 [Q]離開 [L]語言',
    footer: '上次更新: {time}  |  視圖: {view}  |  W:網頁 R:重整 Q:離開',
    loading: '載入資料中...',
    error: '錯誤: {error}',
    overview: '總覽',
    projects: '專案',
    models: '模型',
    trend: '趨勢 (90 天)',
    heatmap: '熱力圖',
    noData: '無資料',
    sessions: '會話',
    main: '主',
    total: '總計',
    projectsLabel: '專案數',
    days: '天數',
    messages: '訊息',
    tokens: 'Token',
    input: '輸入',
    output: '輸出',
    reasoning: '推理',
    cacheRead: '快取讀取',
    cacheWrite: '快取寫入',
    total: '總計',
    cost: '成本',
    marketValue: '市場價值',
    saved: '節省',
    avgCostDay: '日均成本',
    avgTokensDay: '日均Token',
    projectHeader: '{專案:<45} {會話:>10} {Token:>18} {成本:>14}',
    modelHeader: '{模型:<40} {供應商:<14} {Token:>18} {成本:>12} {速度:>10}',
    unknown: '未知',
    today: '今天',
    version: '版本',
    sun: '日', mon: '一', tue: '二', wed: '三', thu: '四', fri: '五', sat: '六'
  },
  en: {
    title: 'opencode-statboard v{version}  TUI',
    keys: '[1]Overview [2]Projects [3]Models [4]Trend [5]Heatmap [W]Web [R]Refresh [Q]Quit [L]Lang',
    footer: 'Last update: {time}  |  View: {view}  |  W:Web R:Refresh Q:Quit',
    loading: 'Loading data...',
    error: 'Error: {error}',
    overview: 'OVERVIEW',
    projects: 'PROJECTS',
    models: 'MODELS',
    trend: 'TREND (90 days)',
    heatmap: 'HEATMAP',
    noData: 'No data',
    sessions: 'Sessions',
    main: 'main',
    total: 'total',
    projectsLabel: 'Projects',
    days: 'Days',
    messages: 'Messages',
    tokens: 'Tokens',
    input: 'Input',
    output: 'Output',
    reasoning: 'Reasoning',
    cacheRead: 'Cache Read',
    cacheWrite: 'Cache Write',
    total: 'Total',
    cost: 'Cost',
    marketValue: 'Market Value',
    saved: 'Saved',
    avgCostDay: 'Avg Cost/Day',
    avgTokensDay: 'Avg Tokens/Day',
    projectHeader: '{Project:<45} {Sessions:>10} {Tokens:>18} {Cost:>14}',
    modelHeader: '{Model:<40} {Provider:<14} {Tokens:>18} {Cost:>12} {Speed:>10}',
    unknown: 'unknown',
    today: 'Today',
    version: 'Version',
    sun: 'Sun', mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat'
  }
};

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
    this.lang = 'zh'; // Default to Chinese
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

      // Handle overview.sessions being a number or object
      const sessionsValue = overview.sessions;
      const sessionsObj = typeof sessionsValue === 'number' 
        ? { main: sessionsValue, total: sessionsValue } 
        : (sessionsValue || { main: 0, total: 0 });
      // Projects count from agents in report
      const projectsCount = projects.length;

      this.data = {
        overview: {
          sessions: sessionsObj,
          projects: projectsCount,
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
      autoPadding: false
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
    this.screen.key(['l'], () => this.toggleLang());

    this.createLayout();
    this.render();
  }

  toggleLang() {
    this.lang = this.lang === 'zh' ? 'en' : 'zh';
    this.createLayout();
    this.render();
  }

  t(key) {
    return I18N[this.lang][key] || key;
  }

  createLayout() {
    // Remove old layout if exists
    if (this.layout.header) this.screen.remove(this.layout.header);
    if (this.layout.main) this.screen.remove(this.layout.main);
    if (this.layout.footer) this.screen.remove(this.layout.footer);

    const t = this.t.bind(this);

    this.layout.header = blessed.box({
      top: 0,
      left: 0,
      width: '100%',
      height: 2,
      tags: true,
      border: { type: 'line' },
      style: { border: { fg: 'cyan' } },
      content: '{center}{bold}' + t('title').replace('{version}', pkg.version) + '{/bold}  |  ' + t('keys') + '  [L]Lang{/center}'
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
      content: '{center}' + t('footer').replace('{time}', this.lastUpdate ? this.lastUpdate.toLocaleTimeString() : 'never').replace('{view}', t(this.currentView)) + '{/center}'
    });

    this.screen.append(this.layout.header);
    this.screen.append(this.layout.main);
    this.screen.append(this.layout.footer);
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
    const t = this.t.bind(this);
    const time = this.lastUpdate ? this.lastUpdate.toLocaleTimeString() : 'never';
    this.layout.footer.setContent(
      '{center}' + t('footer').replace('{time}', time).replace('{view}', t(this.currentView)) + '{/center}'
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
    if (typeof mainHeight === 'number') return mainHeight - 2;
    return this.screen.height - 6; // header(2) + footer(2) + borders(2)
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
    const t = this.t.bind(this);
    if (!ov || ov.loading) return '{center}{bold}' + t('loading') + '{/bold}{/center}';

    const tokens = ov.tokens || {};
    const cost = ov.cost || {};

    const lines = [
      '{center}{bold}\u2501\u2501\u2501 ' + t('overview') + ' \u2501\u2501\u2501{/bold}{/center}',
      '',
      '{bold}' + t('sessions') + ':{/bold} ' + (ov.overview?.sessions?.main || 0) + ' ' + t('main') + ' / ' + (ov.overview?.sessions?.total || 0) + ' ' + t('total'),
      '{bold}' + t('projectsLabel') + ':{/bold} ' + (ov.overview?.projects || 0),
      '{bold}' + t('days') + ':{/bold} ' + (ov.overview?.days || 0),
      '{bold}' + t('messages') + ':{/bold} ' + (ov.overview?.messages || 0),
      '',
      '{bold}' + t('tokens') + ':{/bold}',
      '  ' + t('input') + ':        ' + this.formatNumber(tokens.input || 0),
      '  ' + t('output') + ':       ' + this.formatNumber(tokens.output || 0),
      '  ' + t('reasoning') + ':    ' + this.formatNumber(tokens.reasoning || 0),
      '  ' + t('cacheRead') + ':   ' + this.formatNumber(tokens.cacheRead || 0),
      '  ' + t('cacheWrite') + ':  ' + this.formatNumber(tokens.cacheWrite || 0),
      '  {bold}' + t('total') + ':        ' + this.formatNumber(tokens.total || 0) + '{/bold}',
      '',
      '{bold}' + t('cost') + ':{/bold} ' + this.formatCost(cost.total || 0),
      '{bold}' + t('marketValue') + ':{/bold} ' + this.formatCost(cost.marketValue || 0),
      '{bold}' + t('saved') + ':{/bold} ' + this.formatCost(cost.saved || 0) + (cost.savedPct ? ' (' + cost.savedPct + '%)' : ''),
      '',
      '{bold}' + t('avgCostDay') + ':{/bold} ' + this.formatCost(cost.avgCostPerDay || 0),
      '{bold}' + t('avgTokensDay') + ':{/bold} ' + this.formatNumber(cost.avgTokensPerDay || 0)
    ];
    return lines.join('\n');
  }

  renderProjects() {
    const projects = this.data.projects || [];
    const t = this.t.bind(this);
    if (projects.length === 0) return '{center}' + t('noData') + '{/center}';

    const lines = ['{center}{bold}\u2501\u2501\u2501 ' + t('projects') + ' \u2501\u2501\u2501{/bold}{/center}', ''];
    lines.push('{bold}' + t('projectHeader') + '{/bold}');
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
      lines.push('{gray}... ' + t('noData') + ' ' + (projects.length - 50) + ' ' + t('projects') + '{/gray}');
    }

    return lines.join('\n');
  }

  renderModels() {
    const models = this.data.models || [];
    const t = this.t.bind(this);
    if (models.length === 0) return '{center}' + t('noData') + '{/center}';

    const lines = ['{center}{bold}\u2501\u2501\u2501 ' + t('models') + ' \u2501\u2501\u2501{/bold}{/center}', ''];
    lines.push('{bold}' + t('modelHeader') + '{/bold}');
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
    const t = this.t.bind(this);
    if (!trend || !trend.labels || !trend.labels.length) {
      return '{center}' + t('noData') + '{/center}';
    }

    const labels = trend.labels;
    const input = trend.input || [];
    const output = trend.output || [];
    const cost = trend.cost || [];

    const maxVal = Math.max(...input, ...output, 1);
    const height = this.getContentHeight() - 4;
    const width = this.getContentWidth();

    let out = '{center}{bold}\u2501\u2501\u2501 ' + t('trend') + ' \u2501\u2501\u2501{/bold}{/center}\n\n';
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
    out += '\n{bold}' + t('today') + ':{/bold} Input: ' + this.formatNumber(input[lastIdx] || 0) + ' | Output: ' + this.formatNumber(output[lastIdx] || 0) + ' | Cost: ' + this.formatCost(cost[lastIdx] || 0);

    return out;
  }

  renderHeatmap() {
    const trend = this.data.trend;
    const t = this.t.bind(this);
    if (!trend || !trend.dates || !trend.dates.length) {
      return '{center}' + t('noData') + '{/center}';
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

    let out = '{center}{bold}\u2501\u2501\u2501 ' + t('heatmap') + ' \u2501\u2501\u2501{/bold}{/center}\n\n';
    
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

    const dow = [t('sun') || 'Sun', t('mon') || 'Mon', t('tue') || 'Tue', t('wed') || 'Wed', t('thu') || 'Thu', t('fri') || 'Fri', t('sat') || 'Sat'];
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