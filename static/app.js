'use strict';

// Redirect to /login on any 401 from /api/* (expired or missing session cookie)
(function () {
  const _orig = window.fetch;
  window.fetch = async function (input, init) {
    const res = await _orig.call(this, input, init);
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (res.status === 401 && url.startsWith('/api/')) {
      window.location.href = '/login';
    }
    return res;
  };
})();

// ============================================================
// Data model
// ============================================================

function makeEndpoint(overrides = {}) {
  return {
    id: crypto.randomUUID(),
    name: t('editor.default_name'),
    serverUrl: 'http://127.0.0.1:8080',
    useRawUrl: false,
    model: '',
    apiKey: '',
    systemPrompt: '',
    temperature: 0.7,
    top_p: 0.9,
    max_tokens: 1024,
    repeat_penalty: 1.1,
    ...overrides,
  };
}

// ============================================================
// Persisted state
// ============================================================

let endpoints = [];
let layout = { count: 1, slots: [null, null, null, null], broadcastMode: false };
let prefs = { fontFamily: 'system', googleFont: '', lang: 'it' };

const FONTS = {
  system: { label: 'Sistema',        css: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', gf: null },
  inter:  { label: 'Inter',          css: '"Inter", sans-serif',               gf: 'Inter' },
  roboto: { label: 'Roboto',         css: '"Roboto", sans-serif',              gf: 'Roboto' },
  source: { label: 'Source Sans 3',  css: '"Source Sans 3", sans-serif',       gf: 'Source+Sans+3' },
  lato:   { label: 'Lato',           css: '"Lato", sans-serif',                gf: 'Lato' },
  mono:   { label: 'JetBrains Mono', css: '"JetBrains Mono", monospace',       gf: 'JetBrains+Mono' },
};

let _saveTimer = null;
function saveState() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    fetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoints, layout, prefs }),
    }).catch((err) => console.error('[llm-ui] saveState failed:', err));
  }, 300);
}

async function loadState() {
  try {
    const res = await fetch('/api/config');
    if (res.ok) {
      const saved = await res.json();
      endpoints = Array.isArray(saved.endpoints) ? saved.endpoints : [];
      layout = saved.layout || { count: 1, slots: [null, null, null, null], broadcastMode: false };
      if (layout.broadcastMode === undefined) layout.broadcastMode = false;
      prefs = saved.prefs || { fontFamily: 'system', googleFont: '', lang: 'it' };
      if (!prefs.fontFamily) prefs.fontFamily = 'system';
      if (!prefs.lang) prefs.lang = 'it';
    }
  } catch { /* use defaults */ }

  if (endpoints.length === 0) {
    const ep = makeEndpoint({ name: 'Default' });
    endpoints = [ep];
    layout.slots = [ep.id, null, null, null];
  }

  while (layout.slots.length < 4) layout.slots.push(null);

  const ids = new Set(endpoints.map((e) => e.id));
  layout.slots = layout.slots.map((s) => (s && ids.has(s) ? s : null));
}

// ============================================================
// Per-panel runtime state (not persisted)
// ============================================================

// history entries: { role, content (text-only for API), displayText, displayAttachments }
const panelStates = Array.from({ length: 4 }, () => ({
  history: [],
  isStreaming: false,
  messagesEl: null,
  logs: [],
  showConsole: false,
  consoleEl: null,
  consoleBtnEl: null,
  attachedFiles: [],
  abortController: null,
  inputEl: null,
  attachPreviewEl: null,
  stopBtnEl: null,
  sendBtnEl: null,
  tokenCountEl: null,
  historyCursor: -1,
  promptDraft: '',
  lastUserMsg: null,
  lastAssistantWrapper: null,
  lastRegenRow: null,
}));

/** @type {Array<{name:string, kind:'text'|'image'|'pdf', content:string, dataUrl?:string}>} */
let attachedFiles = [];
let editingEndpointId = null;
let dragSrcIdx = null;
let activeAbortControllers = [];

const promptHistory = [];
let bcastHistoryCursor = -1;
let bcastPromptDraft = '';

// ============================================================
// DOM refs
// ============================================================

const $ = (id) => document.getElementById(id);

const tabBtns           = document.querySelectorAll('.tab-btn');
const panelChatEl       = $('panel-chat');
const panelConfigEl     = $('panel-config');
const panelGuidaEl      = $('panel-guida');
const chatGrid          = $('chat-grid');
const userInput         = $('user-input');
const sendBtn           = $('send-btn');
const stopBtn           = $('stop-btn');
const clearAllBtn       = $('clear-all-btn');
const attachBtn         = $('attach-btn');
const fileInput         = $('file-input');
const attachmentsPreview = $('attachments-preview');
const statusDot         = $('status-dot');
const endpointListEl    = $('endpoint-list');
const addEndpointBtn    = $('add-endpoint-btn');
const globalInputBar    = $('global-input-bar');
const broadcastToggleBtn  = $('broadcast-toggle-btn');
const prefFontSelect      = $('pref-font-select');
const prefFontCustom      = $('pref-font-custom');
const prefFontPreview     = $('pref-font-preview');
const prefLangSelect      = $('pref-lang-select');
const exportConfigBtn     = $('export-config-btn');
const importConfigBtn   = $('import-config-btn');
const configImportInput = $('config-import-input');
const editorSection     = $('endpoint-editor');
const editorTitle       = $('editor-title');
const fName             = $('f-name');
const fServerUrl        = $('f-server-url');
const fModel            = $('f-model');
const fRawUrl           = $('f-raw-url');
const fApiKey           = $('f-api-key');
const fToggleApiKey     = $('f-toggle-api-key');
const fSystemPrompt     = $('f-system-prompt');
const editorCancelBtn   = $('editor-cancel');
const editorSaveBtn     = $('editor-save');
const layoutBtns        = document.querySelectorAll('.layout-btn');
const slotCards         = document.querySelectorAll('.slot-card');
const slotSelectors     = document.querySelectorAll('.slot-selector');

const editorSliders = {
  temperature:    { slider: $('f-slider-temperature'),    val: $('f-val-temperature')    },
  top_p:          { slider: $('f-slider-top_p'),          val: $('f-val-top_p')          },
  max_tokens:     { slider: $('f-slider-max_tokens'),     val: $('f-val-max_tokens')     },
  repeat_penalty: { slider: $('f-slider-repeat_penalty'), val: $('f-val-repeat_penalty') },
};

// ============================================================
// i18n
// ============================================================

let _t = {};

function t(key, vars = {}) {
  let str = _t[key] ?? key;
  for (const [k, v] of Object.entries(vars)) {
    str = str.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(v));
  }
  return str;
}

async function loadTranslations(lang) {
  try {
    const res = await fetch(`i18n/${lang}.json`);
    if (!res.ok) throw new Error();
    _t = await res.json();
  } catch {
    _t = {};
  }
}

function applyTranslations() {
  document.documentElement.lang = prefs.lang;
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const vars = {};
    for (const [k, v] of Object.entries(el.dataset)) {
      if (k !== 'i18n' && k.startsWith('i18n')) {
        vars[k[4].toLowerCase() + k.slice(5)] = v;
      }
    }
    el.textContent = t(el.dataset.i18n, vars);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
  });
}

function syncLangUI() {
  if (prefLangSelect) prefLangSelect.value = prefs.lang;
}

// Copy-code button (event delegation — works on dynamically created buttons)
document.addEventListener('click', (e) => {
  if (!e.target.classList.contains('copy-code-btn')) return;
  const code = e.target.nextElementSibling?.innerText ?? '';
  navigator.clipboard.writeText(code).then(() => {
    e.target.textContent = '✓';
    setTimeout(() => { e.target.textContent = '⎘'; }, 1500);
  }).catch(() => {});
});

// ============================================================
// PDF.js worker
// ============================================================

if (typeof pdfjsLib !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

// ============================================================
// Markdown rendering (marked + highlight.js + DOMPurify)
// ============================================================

if (typeof marked !== 'undefined' && typeof hljs !== 'undefined') {
  marked.use({
    gfm: true,
    breaks: true,
    renderer: {
      code(code, lang) {
        const language = hljs.getLanguage(lang) ? lang : 'plaintext';
        const highlighted = hljs.highlight(code, { language }).value;
        return `<pre><button class="copy-code-btn" title="Copia codice">⎘</button><code class="hljs language-${language}">${highlighted}</code></pre>`;
      },
    },
  });
}

function buildThinkBlock(content) {
  const inner = typeof marked !== 'undefined' ? marked.parse(content) : escapeHtml(content).replace(/\n/g, '<br>');
  const safe = typeof DOMPurify !== 'undefined' ? DOMPurify.sanitize(inner) : inner;
  return `<details class="think-block"><summary>${t('think.label')}</summary><div class="think-content">${safe}</div></details>`;
}

function parseMarkdown(text) {
  if (!text) return '';

  // Extract <think>/<thinking> blocks before markdown parsing
  const thinkBlocks = [];
  const processed = text.replace(/<(think|thinking)>([\s\S]*?)<\/\1>/gi, (_, _t, content) => {
    thinkBlocks.push(content.trim());
    return `\n\nLLMUI_THINK_${thinkBlocks.length - 1}\n\n`;
  });

  let html;
  if (typeof marked === 'undefined') {
    html = escapeHtml(processed).replace(/\n/g, '<br>');
  } else {
    html = marked.parse(processed);
    if (typeof DOMPurify !== 'undefined') html = DOMPurify.sanitize(html);
  }

  thinkBlocks.forEach((content, idx) => {
    html = html.replace(`<p>LLMUI_THINK_${idx}</p>`, buildThinkBlock(content));
    html = html.replace(`LLMUI_THINK_${idx}`, buildThinkBlock(content));
  });

  if (typeof DOMPurify !== 'undefined') html = DOMPurify.sanitize(html, { ADD_TAGS: ['details', 'summary'] });
  return html;
}

// ============================================================
// Tab switching
// ============================================================

let _guideLoaded = false;
async function loadGuide() {
  if (_guideLoaded) return;
  const lang = prefs.lang || 'it';
  try {
    let res = await fetch(`guide/${lang}.html`);
    if (!res.ok) res = await fetch('guide/it.html');
    panelGuidaEl.querySelector('.guide').innerHTML = await res.text();
    _guideLoaded = true;
  } catch (err) {
    panelGuidaEl.querySelector('.guide').innerHTML =
      `<p class="text-red-400">${t('guide.error', { msg: escapeHtml(err.message) })}</p>`;
  }
}

function switchTab(name) {
  if (name === 'guida') loadGuide();
  panelChatEl.classList.toggle('hidden', name !== 'chat');
  panelConfigEl.classList.toggle('hidden', name !== 'config');
  panelGuidaEl.classList.toggle('hidden', name !== 'guida');
  tabBtns.forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === name));
}

tabBtns.forEach((btn) => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

// ============================================================
// File handling
// ============================================================

function readAsText(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsText(file); });
}
function readAsDataURL(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
}
function readAsArrayBuffer(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsArrayBuffer(file); });
}

async function extractPdfText(file) {
  if (typeof pdfjsLib === 'undefined') throw new Error(t('pdf.unavailable'));
  const buf = await readAsArrayBuffer(file);
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    pages.push(content.items.map((it) => it.str).join(' '));
  }
  return pages.join('\n\n');
}

async function processFile(file) {
  const name = file.name;
  const isImage = file.type.startsWith('image/');
  const isPdf = file.type === 'application/pdf' || name.toLowerCase().endsWith('.pdf');
  if (isImage) return { name, kind: 'image', content: '', dataUrl: await readAsDataURL(file) };
  if (isPdf)   return { name, kind: 'pdf',   content: await extractPdfText(file) };
  return { name, kind: 'text', content: await readAsText(file) };
}

function renderAttachmentsPreview() {
  attachmentsPreview.innerHTML = '';
  if (attachedFiles.length === 0) { attachmentsPreview.classList.add('hidden'); return; }
  attachmentsPreview.classList.remove('hidden');
  attachedFiles.forEach((att, idx) => {
    const item = document.createElement('div');
    item.className = 'attachment-item';
    if (att.kind === 'image') {
      const img = document.createElement('img');
      img.src = att.dataUrl; img.className = 'attachment-thumb'; img.title = att.name;
      item.appendChild(img);
    } else {
      const label = document.createElement('span');
      label.className = 'attachment-label';
      label.textContent = (att.kind === 'pdf' ? '📄 ' : '📝 ') + att.name;
      item.appendChild(label);
    }
    const rm = document.createElement('button');
    rm.className = 'attachment-remove'; rm.textContent = '✕';
    rm.addEventListener('click', () => { attachedFiles.splice(idx, 1); renderAttachmentsPreview(); });
    item.appendChild(rm);
    attachmentsPreview.appendChild(item);
  });
}

attachBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async () => {
  const files = Array.from(fileInput.files || []);
  fileInput.value = '';
  for (const file of files) {
    try { attachedFiles.push(await processFile(file)); }
    catch (err) { showErrorInPanel(getFirstActivePanel(), t('file.read_error', { name: file.name, msg: err.message })); }
  }
  renderAttachmentsPreview();
});

function getFirstActivePanel() {
  for (let i = 0; i < layout.count; i++) {
    if (panelStates[i].messagesEl) return panelStates[i].messagesEl;
  }
  return null;
}

// ============================================================
// Utilities
// ============================================================

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtTokens(v) {
  const n = parseInt(v, 10);
  if (n === 0) return '∞';
  if (n >= 1000) return `${(n / 1000).toFixed(0)}K`;
  return String(n);
}

function setStatus(state) {
  statusDot.className = 'ml-auto w-2 h-2 rounded-full transition-colors ';
  if (state === 'ok') statusDot.className += 'bg-emerald-400';
  else if (state === 'err') statusDot.className += 'bg-red-500';
  else statusDot.className += 'bg-slate-600';
}

// ============================================================
// Console per panel
// ============================================================

function logToPanel(idx, level, text) {
  const ts = new Date().toLocaleTimeString('it-IT', { hour12: false });
  const logs = panelStates[idx].logs;
  logs.push({ ts, level, text });
  if (logs.length > 500) logs.shift();
  renderConsoleEl(idx);
}

function renderConsoleEl(idx) {
  const el = panelStates[idx].consoleEl;
  if (!el) return;
  el.innerHTML = '';
  const logs = panelStates[idx].logs;
  if (logs.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'console-empty';
    empty.textContent = t('console.empty');
    el.appendChild(empty);
    return;
  }
  logs.forEach(({ ts, level, text }) => {
    const line = document.createElement('div');
    line.className = `console-line console-${level}`;
    line.innerHTML = `<span class="console-ts">${escapeHtml(ts)}</span><span class="console-text">${escapeHtml(text)}</span>`;
    el.appendChild(line);
  });
  el.scrollTop = el.scrollHeight;
}

function toggleConsole(idx) {
  const state = panelStates[idx];
  state.showConsole = !state.showConsole;
  state.consoleEl?.classList.toggle('hidden', !state.showConsole);
  state.consoleBtnEl?.classList.toggle('active', state.showConsole);
  if (state.showConsole) renderConsoleEl(idx);
}

// ============================================================
// Layout & panel rendering
// ============================================================

function applyLayout() {
  const { count } = layout;
  chatGrid.className = `flex-1 min-h-0 layout-${count}`;

  layoutBtns.forEach((btn) =>
    btn.classList.toggle('active', parseInt(btn.dataset.count) === count)
  );
  slotCards.forEach((card, i) =>
    card.classList.toggle('disabled', i >= count)
  );

  renderChatPanels();
  applyBroadcastMode();
}

function renderChatPanels() {
  chatGrid.innerHTML = '';
  for (let i = 0; i < layout.count; i++) {
    const panelEl = buildPanelEl(i);
    chatGrid.appendChild(panelEl);
    const state = panelStates[i];
    state.messagesEl  = panelEl.querySelector('.messages');
    state.consoleEl   = panelEl.querySelector('.console-drawer');
    state.consoleBtnEl = panelEl.querySelector('.console-toggle-btn');

    // Per-panel input wiring
    state.tokenCountEl   = panelEl.querySelector('.token-counter');
    state.inputEl        = panelEl.querySelector('.panel-textarea');
    state.attachPreviewEl = panelEl.querySelector('.panel-attach-preview');
    state.stopBtnEl      = panelEl.querySelector('.panel-stop-btn');
    state.sendBtnEl      = panelEl.querySelector('.panel-send-btn');

    const pFileInput = panelEl.querySelector('.panel-file-input');
    panelEl.querySelector('.panel-attach-btn').addEventListener('click', () => pFileInput.click());
    pFileInput.addEventListener('change', async () => {
      const files = Array.from(pFileInput.files || []);
      pFileInput.value = '';
      for (const f of files) {
        try { panelStates[i].attachedFiles.push(await processFile(f)); }
        catch (err) { showErrorInPanel(panelStates[i].messagesEl, t('file.read_error', { name: f.name, msg: err.message })); }
      }
      renderPanelAttachmentsPreview(i);
    });
    state.sendBtnEl.addEventListener('click', () => sendFromPanel(i));
    state.stopBtnEl.addEventListener('click', () => { panelStates[i].abortController?.abort(); });
    state.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendFromPanel(i); return; }
      if (e.key === 'ArrowUp' && state.inputEl.selectionStart === 0 && promptHistory.length > 0) {
        e.preventDefault();
        if (state.historyCursor === -1) { state.promptDraft = state.inputEl.value; state.historyCursor = promptHistory.length - 1; }
        else state.historyCursor = Math.max(0, state.historyCursor - 1);
        state.inputEl.value = promptHistory[state.historyCursor];
        state.inputEl.dispatchEvent(new Event('input'));
        return;
      }
      if (e.key === 'ArrowDown' && state.historyCursor !== -1) {
        e.preventDefault();
        if (state.historyCursor < promptHistory.length - 1) { state.historyCursor++; state.inputEl.value = promptHistory[state.historyCursor]; }
        else { state.historyCursor = -1; state.inputEl.value = state.promptDraft; }
        state.inputEl.dispatchEvent(new Event('input'));
      }
    });
    state.inputEl.addEventListener('input', () => {
      state.inputEl.style.height = 'auto';
      state.inputEl.style.height = Math.min(state.inputEl.scrollHeight, 96) + 'px';
    });

    // Restore console visibility
    if (state.showConsole) {
      state.consoleEl.classList.remove('hidden');
      state.consoleBtnEl.classList.add('active');
    }
    renderConsoleEl(i);

    // Re-render history
    state.history.forEach((msg) => {
      if (msg.role === 'user') {
        appendUserMessageToEl(state.messagesEl, msg.displayText, msg.displayAttachments || []);
      } else {
        appendAssistantMessageToEl(state.messagesEl, msg.content);
      }
    });
  }
  // Clear refs for inactive slots
  for (let i = layout.count; i < 4; i++) {
    panelStates[i].messagesEl = null;
    panelStates[i].consoleEl = null;
    panelStates[i].consoleBtnEl = null;
    panelStates[i].inputEl = null;
    panelStates[i].attachPreviewEl = null;
    panelStates[i].stopBtnEl = null;
    panelStates[i].sendBtnEl = null;
    panelStates[i].tokenCountEl = null;
  }
}

function buildPanelEl(idx) {
  const epId = layout.slots[idx];
  const ep = endpoints.find((e) => e.id === epId);
  const name = ep ? ep.name : t('panel.no_endpoint');

  const div = document.createElement('div');
  div.className = 'chat-panel';

  const header = document.createElement('div');
  header.className = 'flex items-center gap-2 px-3 py-1.5 border-b border-slate-700 bg-slate-800 flex-shrink-0';
  header.innerHTML = `
    <span class="text-xs font-semibold truncate flex-1 ${ep ? 'text-indigo-300' : 'text-slate-500'}">${escapeHtml(name)}</span>
    <span class="token-counter text-xs font-mono text-slate-600" title="Token stimati nella cronologia"></span>
    <button class="console-toggle-btn font-mono text-slate-500 hover:text-emerald-400 transition-colors text-xs px-1 leading-none" title="${t('panel.console.title')}">&gt;_</button>
    <details class="export-details relative">
      <summary class="text-slate-500 hover:text-slate-300 transition-colors text-xs px-1 leading-none cursor-pointer" title="${t('panel.export.title')}">⬇</summary>
      <div class="export-menu absolute right-0 top-5 z-20 bg-slate-700 border border-slate-600 rounded-lg shadow-xl py-1 min-w-[90px]">
        <button class="export-md-btn block w-full text-left px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-600 transition-colors">${t('panel.export.md')}</button>
        <button class="export-json-btn block w-full text-left px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-600 transition-colors">${t('panel.export.json')}</button>
      </div>
    </details>
    <button class="clear-panel-btn text-slate-500 hover:text-slate-300 transition-colors text-sm" title="${t('panel.clear.title')}">↺</button>
  `;
  header.querySelector('.clear-panel-btn').addEventListener('click', () => clearPanel(idx));
  header.querySelector('.console-toggle-btn').addEventListener('click', () => toggleConsole(idx));
  const exportDetails = header.querySelector('.export-details');
  header.querySelector('.export-md-btn').addEventListener('click', () => {
    exportPanel(idx, 'md'); exportDetails.open = false;
  });
  header.querySelector('.export-json-btn').addEventListener('click', () => {
    exportPanel(idx, 'json'); exportDetails.open = false;
  });

  const messages = document.createElement('div');
  messages.className = 'messages flex-1 overflow-y-auto px-3 py-3 space-y-3';

  const consoleDrw = document.createElement('div');
  consoleDrw.className = 'console-drawer hidden';

  const panelFooter = document.createElement('div');
  panelFooter.className = 'panel-input-footer flex-shrink-0 border-t border-slate-700 bg-slate-800';
  if (layout.broadcastMode) panelFooter.classList.add('hidden');
  panelFooter.innerHTML = `
    <div class="panel-attach-preview hidden flex-wrap gap-1 px-2 pt-1.5"></div>
    <div class="flex gap-1.5 items-end p-2">
      <input type="file" multiple class="panel-file-input hidden"
        accept=".txt,.md,.json,.csv,.xml,.yaml,.yml,.html,.js,.ts,.py,.java,.c,.cpp,.go,.rs,.pdf,image/*" />
      <button class="panel-attach-btn flex-shrink-0 bg-slate-700 hover:bg-slate-600 text-slate-300 px-2 py-1.5 rounded-lg text-sm transition-colors h-8" title="${t('input.attach.title')}">📎</button>
      <textarea rows="1" class="panel-textarea flex-1 resize-none bg-slate-700 text-slate-100 placeholder-slate-400 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500 max-h-24 min-h-[2rem]" placeholder="${t('panel.input.placeholder')}"></textarea>
      <button class="panel-send-btn flex-shrink-0 bg-indigo-600 hover:bg-indigo-500 text-white px-2.5 py-1.5 rounded-lg text-sm font-medium transition-colors h-8" title="${t('input.send')}">➤</button>
      <button class="panel-stop-btn hidden flex-shrink-0 bg-red-700 hover:bg-red-600 text-white px-2.5 py-1.5 rounded-lg text-sm font-medium transition-colors h-8" title="${t('input.stop')}">⏹</button>
    </div>
  `;

  div.appendChild(header);
  div.appendChild(messages);
  div.appendChild(consoleDrw);
  div.appendChild(panelFooter);
  return div;
}

// ============================================================
// Endpoint list & slot selectors
// ============================================================

function renderEndpointList() {
  dragSrcIdx = null;
  endpointListEl.innerHTML = '';
  if (endpoints.length === 0) {
    endpointListEl.innerHTML = `<p class="text-slate-500 text-sm">${t('endpoint.empty')}</p>`;
    return;
  }
  endpoints.forEach((ep, idx) => {
    const div = document.createElement('div');
    div.className = 'ep-item flex items-center gap-3 px-4 py-3 bg-slate-800 rounded-lg border border-slate-700';
    div.draggable = true;
    div.innerHTML = `
      <span class="drag-handle select-none" title="${t('endpoint.drag.hint')}">⠿</span>
      <div class="flex-1 min-w-0">
        <div class="text-sm font-medium text-slate-200 truncate">${escapeHtml(ep.name)}</div>
        <div class="text-xs text-slate-500 truncate">${escapeHtml(ep.serverUrl)}${ep.model ? ' · ' + escapeHtml(ep.model) : ''}</div>
      </div>
      <button class="edit-btn text-xs text-slate-400 hover:text-indigo-400 px-2 py-1 rounded hover:bg-slate-700 transition-colors">${t('endpoint.edit')}</button>
      <button class="clone-btn text-xs text-slate-400 hover:text-emerald-400 px-2 py-1 rounded hover:bg-slate-700 transition-colors" title="${t('endpoint.clone')}">⎘</button>
      <button class="del-btn text-xs text-slate-400 hover:text-red-400 px-2 py-1 rounded hover:bg-slate-700 transition-colors">${t('endpoint.delete')}</button>
    `;

    div.addEventListener('dragstart', (e) => {
      dragSrcIdx = idx;
      e.dataTransfer.effectAllowed = 'move';
      setTimeout(() => div.classList.add('opacity-40'), 0);
    });
    div.addEventListener('dragend', () => {
      div.classList.remove('opacity-40');
      endpointListEl.querySelectorAll('.ep-item').forEach((el) => el.classList.remove('drag-over'));
      dragSrcIdx = null;
    });
    div.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      endpointListEl.querySelectorAll('.ep-item').forEach((el) => el.classList.remove('drag-over'));
      if (dragSrcIdx !== null && dragSrcIdx !== idx) div.classList.add('drag-over');
    });
    div.addEventListener('dragleave', () => div.classList.remove('drag-over'));
    div.addEventListener('drop', (e) => {
      e.preventDefault();
      if (dragSrcIdx === null || dragSrcIdx === idx) return;
      const moved = endpoints.splice(dragSrcIdx, 1)[0];
      endpoints.splice(idx, 0, moved);
      saveState();
      renderEndpointList();
      renderSlotSelectors();
    });

    div.querySelector('.edit-btn').addEventListener('click', () => openEditor(ep.id));
    div.querySelector('.clone-btn').addEventListener('click', () => cloneEndpoint(ep.id));
    div.querySelector('.del-btn').addEventListener('click', () => deleteEndpoint(ep.id));
    endpointListEl.appendChild(div);
  });
}

function renderSlotSelectors() {
  slotSelectors.forEach((sel, i) => {
    sel.innerHTML = `<option value="">${t('slot.none')}</option>`;
    endpoints.forEach((ep) => {
      const opt = document.createElement('option');
      opt.value = ep.id;
      opt.textContent = ep.name;
      sel.appendChild(opt);
    });
    sel.value = layout.slots[i] || '';
  });
}

// ============================================================
// Config export / import
// ============================================================

function exportConfig() {
  const data = JSON.stringify({ endpoints, layout }, null, 2);
  const blob = new Blob([data], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), {
    href: url,
    download: `llm-ui-config-${Date.now()}.json`,
  });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function importConfig(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      if (!Array.isArray(parsed.endpoints)) throw new Error(t('import.invalid'));
      if (!confirm(t('import.confirm', { count: parsed.endpoints.length }))) return;
      endpoints = parsed.endpoints;
      layout = parsed.layout || {};
      if (typeof layout.count !== 'number') layout.count = 1;
      if (!Array.isArray(layout.slots)) layout.slots = [null, null, null, null];
      if (layout.broadcastMode === undefined) layout.broadcastMode = false;
      while (layout.slots.length < 4) layout.slots.push(null);
      const ids = new Set(endpoints.map((e) => e.id));
      layout.slots = layout.slots.map((s) => (s && ids.has(s) ? s : null));
      saveState();
      renderEndpointList();
      renderSlotSelectors();
      applyLayout();
    } catch (err) {
      alert(t('import.error', { msg: err.message }));
    }
  };
  reader.readAsText(file);
}

// ============================================================
// Endpoint CRUD
// ============================================================

function openEditor(id = null) {
  editingEndpointId = id;
  editorTitle.textContent = id ? t('editor.edit') : t('editor.new');
  const ep = (id ? endpoints.find((e) => e.id === id) : null) || makeEndpoint();
  fName.value = ep.name;
  fServerUrl.value = ep.serverUrl;
  fRawUrl.checked = !!ep.useRawUrl;
  fModel.value = ep.model;
  fApiKey.value = ep.apiKey;
  fApiKey.type = 'password';
  fToggleApiKey.textContent = '👁';
  fSystemPrompt.value = ep.systemPrompt;
  Object.entries(editorSliders).forEach(([key, { slider, val }]) => {
    slider.value = ep[key];
    val.textContent = key === 'max_tokens' ? fmtTokens(ep[key]) : ep[key];
  });
  editorSection.classList.remove('hidden');
  setTimeout(() => editorSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50);
  fName.focus();
}

function closeEditor() {
  editorSection.classList.add('hidden');
  editingEndpointId = null;
}

function saveEndpoint() {
  const ep = {
    id: editingEndpointId || crypto.randomUUID(),
    name: fName.value.trim() || t('editor.default_name'),
    serverUrl: fServerUrl.value.trim() || 'http://127.0.0.1:8080',
    useRawUrl: fRawUrl.checked,
    model: fModel.value.trim(),
    apiKey: fApiKey.value.trim(),
    systemPrompt: fSystemPrompt.value,
    temperature:    parseFloat($('f-slider-temperature').value),
    top_p:          parseFloat($('f-slider-top_p').value),
    max_tokens:     parseInt($('f-slider-max_tokens').value, 10),
    repeat_penalty: parseFloat($('f-slider-repeat_penalty').value),
  };

  if (editingEndpointId) {
    const idx = endpoints.findIndex((e) => e.id === editingEndpointId);
    if (idx !== -1) endpoints[idx] = ep;
  } else {
    endpoints.push(ep);
    // Auto-assign to first free active slot
    const free = layout.slots.findIndex((s, i) => i < layout.count && !s);
    if (free !== -1) layout.slots[free] = ep.id;
  }

  saveState();
  closeEditor();
  renderEndpointList();
  renderSlotSelectors();
  applyLayout();
}

// ============================================================
// Font preference
// ============================================================

function applyFont() {
  const key = prefs.fontFamily;
  document.getElementById('gf-link')?.remove();

  let css;
  if (key === 'custom') {
    const name = (prefs.googleFont || '').trim();
    if (name) {
      const link = Object.assign(document.createElement('link'), {
        id: 'gf-link', rel: 'stylesheet',
        href: `https://fonts.googleapis.com/css2?family=${name.replace(/ /g, '+')}:wght@400;500&display=swap`,
      });
      document.head.appendChild(link);
      css = `"${name}", sans-serif`;
    } else {
      css = FONTS.system.css;
    }
  } else {
    const def = FONTS[key] || FONTS.system;
    if (def.gf) {
      const link = Object.assign(document.createElement('link'), {
        id: 'gf-link', rel: 'stylesheet',
        href: `https://fonts.googleapis.com/css2?family=${def.gf}:wght@400;500&display=swap`,
      });
      document.head.appendChild(link);
    }
    css = def.css;
  }

  document.documentElement.style.setProperty('--chat-font', css);
  if (prefFontPreview) prefFontPreview.style.fontFamily = css;
}

function syncFontUI() {
  const isKnown = Object.prototype.hasOwnProperty.call(FONTS, prefs.fontFamily);
  prefFontSelect.value = isKnown ? prefs.fontFamily : 'custom';
  const isCustom = prefFontSelect.value === 'custom';
  prefFontCustom.classList.toggle('hidden', !isCustom);
  if (isCustom) prefFontCustom.value = prefs.googleFont || '';
}

let _fontTimer = null;
prefFontSelect.addEventListener('change', () => {
  prefs.fontFamily = prefFontSelect.value;
  const isCustom = prefs.fontFamily === 'custom';
  prefFontCustom.classList.toggle('hidden', !isCustom);
  if (!isCustom) { applyFont(); saveState(); }
});
prefFontCustom.addEventListener('input', () => {
  clearTimeout(_fontTimer);
  _fontTimer = setTimeout(() => {
    prefs.googleFont = prefFontCustom.value.trim();
    applyFont();
    saveState();
  }, 600);
});

// ============================================================
// Broadcast mode toggle
// ============================================================

function applyBroadcastMode() {
  const isBroadcast = layout.broadcastMode;
  globalInputBar.classList.toggle('hidden', !isBroadcast);
  document.querySelectorAll('.panel-input-footer').forEach((el) =>
    el.classList.toggle('hidden', isBroadcast)
  );
  broadcastToggleBtn.textContent = isBroadcast ? t('broadcast.on') : t('broadcast.off');
  broadcastToggleBtn.title = isBroadcast ? t('broadcast.on.title') : t('broadcast.off.title');
}

// ============================================================
// Per-panel attachment preview
// ============================================================

function renderPanelAttachmentsPreview(idx) {
  const state = panelStates[idx];
  const el = state.attachPreviewEl;
  if (!el) return;
  el.innerHTML = '';
  if (state.attachedFiles.length === 0) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  state.attachedFiles.forEach((att, i) => {
    const item = document.createElement('div');
    item.className = 'attachment-item';
    if (att.kind === 'image') {
      const img = document.createElement('img');
      img.src = att.dataUrl; img.className = 'attachment-thumb'; img.title = att.name;
      item.appendChild(img);
    } else {
      const label = document.createElement('span');
      label.className = 'attachment-label';
      label.textContent = (att.kind === 'pdf' ? '📄 ' : '📝 ') + att.name;
      item.appendChild(label);
    }
    const rm = document.createElement('button');
    rm.className = 'attachment-remove'; rm.textContent = '✕';
    rm.addEventListener('click', () => { state.attachedFiles.splice(i, 1); renderPanelAttachmentsPreview(idx); });
    item.appendChild(rm);
    el.appendChild(item);
  });
}

// ============================================================
// Per-panel send
// ============================================================

async function sendFromPanel(idx) {
  const state = panelStates[idx];
  if (state.isStreaming || !state.inputEl) return;
  const text = state.inputEl.value.trim();
  const attachments = [...state.attachedFiles];
  if (!text && attachments.length === 0) return;

  const ep = endpoints.find((e) => e.id === layout.slots[idx]);
  if (!ep || !state.messagesEl) return;

  if (text) { promptHistory.push(text); state.historyCursor = -1; state.promptDraft = ''; }
  appendUserMessageToEl(state.messagesEl, text, attachments);
  state.inputEl.value = '';
  state.inputEl.style.height = 'auto';
  state.attachedFiles = [];
  renderPanelAttachmentsPreview(idx);

  state.abortController = new AbortController();
  state.isStreaming = true;
  state.stopBtnEl?.classList.remove('hidden');
  state.sendBtnEl?.classList.add('hidden');

  await streamToPanel(idx, ep, text, attachments, state.abortController.signal);

  state.isStreaming = false;
  state.abortController = null;
  state.stopBtnEl?.classList.add('hidden');
  state.sendBtnEl?.classList.remove('hidden');
  state.inputEl.focus();
}

function cloneEndpoint(id) {
  const src = endpoints.find((e) => e.id === id);
  if (!src) return;
  const idx = endpoints.indexOf(src);
  const clone = { ...src, id: crypto.randomUUID(), name: src.name + ' (copia)' };
  endpoints.splice(idx + 1, 0, clone);
  saveState();
  renderEndpointList();
  renderSlotSelectors();
}

function deleteEndpoint(id) {
  if (!confirm(t('endpoint.delete.confirm'))) return;
  endpoints = endpoints.filter((e) => e.id !== id);
  layout.slots = layout.slots.map((s) => (s === id ? null : s));
  saveState();
  renderEndpointList();
  renderSlotSelectors();
  applyLayout();
}

// ============================================================
// Layout events
// ============================================================

layoutBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    layout.count = parseInt(btn.dataset.count, 10);
    saveState();
    applyLayout();
  });
});

slotSelectors.forEach((sel, i) => {
  sel.addEventListener('change', () => {
    layout.slots[i] = sel.value || null;
    saveState();
    applyLayout();
  });
});

// ============================================================
// Message rendering
// ============================================================

function createBubbleEl(role) {
  const wrapper = document.createElement('div');
  wrapper.className = `msg-${role} flex ${role === 'user' ? 'justify-end' : 'justify-start'}`;
  const bubble = document.createElement('div');
  const roleClass = role === 'user' ? 'whitespace-pre-wrap' : 'markdown-content';
  bubble.className = `bubble ${roleClass} px-3 py-2 max-w-[92%] sm:max-w-[85%] text-sm break-words`;
  wrapper.appendChild(bubble);
  return { wrapper, bubble };
}

function appendUserMessageToEl(messagesEl, text, attachments = []) {
  if (!messagesEl) return;
  const { wrapper, bubble } = createBubbleEl('user');
  const images    = attachments.filter((a) => a.kind === 'image');
  const textFiles = attachments.filter((a) => a.kind !== 'image');

  if (images.length > 0) {
    const row = document.createElement('div');
    row.className = 'flex flex-wrap gap-1 mb-1';
    images.forEach((img) => {
      const el = document.createElement('img');
      el.src = img.dataUrl; el.className = 'max-h-20 rounded'; el.title = img.name;
      row.appendChild(el);
    });
    bubble.appendChild(row);
  }
  if (textFiles.length > 0) {
    const row = document.createElement('div');
    row.className = 'flex flex-wrap gap-1 mb-1';
    textFiles.forEach((att) => {
      const badge = document.createElement('span');
      badge.className = 'text-xs bg-slate-600 text-slate-200 px-2 py-0.5 rounded';
      badge.textContent = (att.kind === 'pdf' ? '📄 ' : '📝 ') + att.name;
      row.appendChild(badge);
    });
    bubble.appendChild(row);
  }
  if (text) {
    const span = document.createElement('span');
    span.textContent = text;
    bubble.appendChild(span);
  }
  messagesEl.appendChild(wrapper);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function appendAssistantMessageToEl(messagesEl, text) {
  if (!messagesEl) return null;
  const { wrapper, bubble } = createBubbleEl('assistant');
  bubble.innerHTML = parseMarkdown(text);
  messagesEl.appendChild(wrapper);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return bubble;
}

function showErrorInPanel(messagesEl, message) {
  if (!messagesEl) return;
  const wrapper = document.createElement('div');
  wrapper.className = 'msg-error flex justify-center';
  const bubble = document.createElement('div');
  bubble.className = 'bubble px-3 py-2 text-xs text-red-300 max-w-[95%]';
  bubble.textContent = '⚠ ' + message;
  wrapper.appendChild(bubble);
  messagesEl.appendChild(wrapper);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ============================================================
// Clear panel
// ============================================================

function updateTokenCounter(idx) {
  const state = panelStates[idx];
  if (!state.tokenCountEl) return;
  const total = state.history.reduce((sum, m) => {
    const t = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    return sum + Math.ceil(t.length / 4);
  }, 0);
  state.tokenCountEl.textContent = total === 0 ? '' : total >= 1000
    ? `~${(total / 1000).toFixed(1)}K ${t('token.unit')}`
    : `~${total} ${t('token.unit')}`;
}

function clearPanel(idx) {
  const state = panelStates[idx];
  state.history = [];
  state.logs = [];
  state.lastUserMsg = null;
  state.lastAssistantWrapper = null;
  state.lastRegenRow = null;
  if (state.messagesEl) state.messagesEl.innerHTML = '';
  renderConsoleEl(idx);
  updateTokenCounter(idx);
}

async function regeneratePanel(idx) {
  const state = panelStates[idx];
  if (state.isStreaming || !state.lastUserMsg) return;
  const ep = endpoints.find((e) => e.id === layout.slots[idx]);
  if (!ep || !state.messagesEl) return;

  // Remove last exchange from history
  if (state.history.length >= 2 &&
      state.history.at(-1).role === 'assistant' &&
      state.history.at(-2).role === 'user') {
    state.history.splice(-2, 2);
  }
  state.lastAssistantWrapper?.remove();
  state.lastRegenRow?.remove();
  state.lastAssistantWrapper = null;
  state.lastRegenRow = null;

  const { text, attachments } = state.lastUserMsg;

  state.abortController = new AbortController();
  state.isStreaming = true;
  if (layout.broadcastMode) {
    activeAbortControllers = [state.abortController];
    sendBtn.classList.add('hidden');
    stopBtn.classList.remove('hidden');
  } else {
    state.stopBtnEl?.classList.remove('hidden');
    state.sendBtnEl?.classList.add('hidden');
  }

  await streamToPanel(idx, ep, text, attachments, state.abortController.signal);

  state.isStreaming = false;
  state.abortController = null;
  if (layout.broadcastMode) {
    activeAbortControllers = [];
    sendBtn.classList.remove('hidden');
    stopBtn.classList.add('hidden');
  } else {
    state.stopBtnEl?.classList.add('hidden');
    state.sendBtnEl?.classList.remove('hidden');
  }
}

// ============================================================
// Export panel conversation
// ============================================================

function exportPanel(idx, format) {
  const state = panelStates[idx];
  if (state.history.length === 0) return;

  const epId = layout.slots[idx];
  const ep = endpoints.find((e) => e.id === epId);
  const epName = ep ? ep.name : 'chat';
  const safeName = epName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  const stamp = Date.now();

  let content, filename, mime;

  if (format === 'json') {
    const data = {
      endpoint: epName,
      serverUrl: ep?.serverUrl || '',
      model: ep?.model || '',
      exportedAt: new Date().toISOString(),
      messages: state.history.map((m) => ({ role: m.role, content: m.content })),
    };
    content = JSON.stringify(data, null, 2);
    filename = `chat_${safeName}_${stamp}.json`;
    mime = 'application/json';
  } else {
    const dateStr = new Date().toLocaleString(prefs.lang === 'en' ? 'en-GB' : 'it-IT');
    const lines = [`# ${t('export.md.title', { name: epName })}`, `*${t('export.md.date', { date: dateStr })}*`, '', '---', ''];
    state.history.forEach((msg) => {
      lines.push(`**${msg.role === 'user' ? t('export.role.user') : t('export.role.assistant')}**`, '', msg.content, '', '---', '');
    });
    content = lines.join('\n');
    filename = `chat_${safeName}_${stamp}.md`;
    mime = 'text/markdown';
  }

  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ============================================================
// Content builders
// ============================================================

function buildTextContent(userText, attachments) {
  let text = userText;
  for (const att of attachments.filter((a) => a.kind !== 'image')) {
    text += `\n\n[File allegato: ${att.name}]\n${att.content}`;
  }
  return text;
}

function buildUserContent(userText, attachments) {
  const textContent = buildTextContent(userText, attachments);
  const images = attachments.filter((a) => a.kind === 'image');
  if (images.length === 0) return textContent;
  return [
    { type: 'text', text: textContent },
    ...images.map((img) => ({ type: 'image_url', image_url: { url: img.dataUrl } })),
  ];
}

// ============================================================
// Streaming to a single panel
// ============================================================

async function streamToPanel(panelIdx, endpoint, userText, attachments, signal = null) {
  const state = panelStates[panelIdx];
  const messagesEl = state.messagesEl;
  if (!messagesEl) return;

  // Build API messages (history uses text-only content, no base64)
  const messages = [];
  if (endpoint.systemPrompt.trim()) {
    messages.push({ role: 'system', content: endpoint.systemPrompt.trim() });
  }
  state.history.forEach((m) => messages.push({ role: m.role, content: m.content }));
  messages.push({ role: 'user', content: buildUserContent(userText, attachments) });

  // Create streaming bubble (cursor is injected inline via innerHTML)
  const { wrapper, bubble } = createBubbleEl('assistant');
  bubble.innerHTML = '<span class="stream-cursor">▋</span>';
  messagesEl.appendChild(wrapper);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  let assistantText = '';
  let chunkCount = 0;

  logToPanel(panelIdx, 'info',
    `→ POST /api/chat  endpoint:${endpoint.name}  model:${endpoint.model || '(default)'}  msgs:${messages.length}`);
  logToPanel(panelIdx, 'info',
    `  target:${endpoint.serverUrl}  temp:${endpoint.temperature}  top_p:${endpoint.top_p}  max_tokens:${endpoint.max_tokens || '∞'}`);

  try {
    let response;
    try {
      response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          endpointId: endpoint.id,
          messages,
          temperature: endpoint.temperature,
          top_p: endpoint.top_p,
          max_tokens: endpoint.max_tokens,
          repeat_penalty: endpoint.repeat_penalty,
        }),
        signal,
      });
    } catch (netErr) {
      if (netErr.name === 'AbortError') throw netErr;
      logToPanel(panelIdx, 'error', `✗ Rete: ${netErr.name} — ${netErr.message}`);
      logToPanel(panelIdx, 'warn', `  ${t('error.backend_unreachable')}`);
      netErr._logged = true;
      throw netErr;
    }

    const statusLine = `← ${response.status} ${response.statusText}`;

    if (!response.ok) {
      logToPanel(panelIdx, 'error', statusLine);
      const errBody = await response.text().catch(() => '');
      if (errBody) logToPanel(panelIdx, 'error', errBody);
      throw new Error(`HTTP ${response.status}${errBody ? ': ' + errBody.slice(0, 120) : ''}`);
    }

    logToPanel(panelIdx, 'info', statusLine);
    logToPanel(panelIdx, 'info', `  Content-Type: ${response.headers.get('content-type') || '—'}`);
    setStatus('ok');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') continue;
        if (!trimmed.startsWith('data:')) continue;
        try {
          const delta = JSON.parse(trimmed.slice(5).trim()).choices?.[0]?.delta?.content ?? '';
          if (delta) {
            assistantText += delta;
            chunkCount++;
            bubble.innerHTML = parseMarkdown(assistantText) + '<span class="stream-cursor">▋</span>';
            messagesEl.scrollTop = messagesEl.scrollHeight;
          }
        } catch {
          logToPanel(panelIdx, 'warn', `chunk non parseable: ${trimmed.slice(0, 80)}`);
        }
      }
    }

    // Flush remaining buffer
    if (buffer.trim() && buffer.trim() !== 'data: [DONE]') {
      try {
        const delta = JSON.parse(buffer.replace(/^data:\s*/, '')).choices?.[0]?.delta?.content ?? '';
        if (delta) { assistantText += delta; chunkCount++; }
      } catch { /* ignore */ }
    }

    // Final render without cursor
    bubble.innerHTML = parseMarkdown(assistantText);
    logToPanel(panelIdx, 'info', `✓ Stream completato — ${chunkCount} chunk`);

    const textContent = buildTextContent(userText, attachments);
    state.history.push({ role: 'user', content: textContent, displayText: userText, displayAttachments: attachments });
    state.history.push({ role: 'assistant', content: assistantText, displayText: assistantText, displayAttachments: [] });

    // Rigenera button
    state.lastUserMsg = { text: userText, attachments };
    state.lastAssistantWrapper = wrapper;
    const regenRow = document.createElement('div');
    regenRow.className = 'regen-row';
    const regenBtn = document.createElement('button');
    regenBtn.className = 'regen-btn';
    regenBtn.textContent = t('regen.btn');
    regenBtn.addEventListener('click', () => regeneratePanel(panelIdx));
    regenRow.appendChild(regenBtn);
    wrapper.insertAdjacentElement('afterend', regenRow);
    state.lastRegenRow = regenRow;

    updateTokenCounter(panelIdx);

  } catch (err) {
    if (err.name === 'AbortError') {
      logToPanel(panelIdx, 'warn', t('stream.interrupted'));
      if (assistantText) {
        bubble.innerHTML = parseMarkdown(assistantText) +
          `<span class="text-amber-500 text-xs block mt-1">${t('stream.interrupted')}</span>`;
        const textContent = buildTextContent(userText, attachments);
        state.history.push({ role: 'user', content: textContent, displayText: userText, displayAttachments: attachments });
        state.history.push({ role: 'assistant', content: assistantText, displayText: assistantText, displayAttachments: [] });
      } else {
        wrapper.remove();
      }
    } else {
      setStatus('err');
      bubble.innerHTML = '';
      if (!assistantText) wrapper.remove();
      showErrorInPanel(messagesEl, err.message || t('error.connection'));
      if (!err._logged && !err.message?.startsWith('HTTP ')) {
        logToPanel(panelIdx, 'error', `✗ ${err.message}`);
      }
    }
  }
}

// ============================================================
// Send (broadcast to all active panels)
// ============================================================

function isAnyStreaming() {
  return panelStates.some((s, i) => i < layout.count && s.isStreaming);
}

async function sendMessage() {
  if (!layout.broadcastMode) return;
  const text = userInput.value.trim();
  if ((!text && attachedFiles.length === 0) || isAnyStreaming()) return;

  // Collect active panels that have an endpoint assigned
  const activePanels = [];
  for (let i = 0; i < layout.count; i++) {
    const ep = endpoints.find((e) => e.id === layout.slots[i]);
    if (ep && panelStates[i].messagesEl) activePanels.push({ idx: i, ep });
  }
  if (activePanels.length === 0) return;

  const snap = [...attachedFiles];

  // Show user message immediately in all panels
  activePanels.forEach(({ idx }) => {
    appendUserMessageToEl(panelStates[idx].messagesEl, text, snap);
    panelStates[idx].isStreaming = true;
  });

  if (text) { promptHistory.push(text); bcastHistoryCursor = -1; bcastPromptDraft = ''; }
  userInput.value = '';
  userInput.style.height = 'auto';
  attachedFiles = [];
  renderAttachmentsPreview();

  // Create one AbortController per active panel and switch UI to stop mode
  activeAbortControllers = activePanels.map(() => new AbortController());
  sendBtn.classList.add('hidden');
  stopBtn.classList.remove('hidden');

  await Promise.allSettled(
    activePanels.map(({ idx, ep }, i) =>
      streamToPanel(idx, ep, text, snap, activeAbortControllers[i].signal)
    )
  );

  activeAbortControllers = [];
  activePanels.forEach(({ idx }) => { panelStates[idx].isStreaming = false; });
  sendBtn.classList.remove('hidden');
  stopBtn.classList.add('hidden');
  userInput.focus();
}

// ============================================================
// Events
// ============================================================

sendBtn.addEventListener('click', sendMessage);
stopBtn.addEventListener('click', () => activeAbortControllers.forEach((c) => c.abort()));

userInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); return; }
  if (e.key === 'ArrowUp' && userInput.selectionStart === 0 && promptHistory.length > 0) {
    e.preventDefault();
    if (bcastHistoryCursor === -1) { bcastPromptDraft = userInput.value; bcastHistoryCursor = promptHistory.length - 1; }
    else bcastHistoryCursor = Math.max(0, bcastHistoryCursor - 1);
    userInput.value = promptHistory[bcastHistoryCursor];
    userInput.dispatchEvent(new Event('input'));
    return;
  }
  if (e.key === 'ArrowDown' && bcastHistoryCursor !== -1) {
    e.preventDefault();
    if (bcastHistoryCursor < promptHistory.length - 1) { bcastHistoryCursor++; userInput.value = promptHistory[bcastHistoryCursor]; }
    else { bcastHistoryCursor = -1; userInput.value = bcastPromptDraft; }
    userInput.dispatchEvent(new Event('input'));
  }
});

userInput.addEventListener('input', () => {
  userInput.style.height = 'auto';
  userInput.style.height = Math.min(userInput.scrollHeight, 160) + 'px';
});

clearAllBtn.addEventListener('click', () => {
  if (isAnyStreaming()) return;
  for (let i = 0; i < layout.count; i++) clearPanel(i);
  setStatus('idle');
});

addEndpointBtn.addEventListener('click', () => openEditor(null));
exportConfigBtn.addEventListener('click', exportConfig);
importConfigBtn.addEventListener('click', () => configImportInput.click());
configImportInput.addEventListener('change', () => {
  const file = configImportInput.files?.[0];
  configImportInput.value = '';
  if (file) importConfig(file);
});
broadcastToggleBtn.addEventListener('click', () => {
  layout.broadcastMode = !layout.broadcastMode;
  saveState();
  applyBroadcastMode();
});

editorCancelBtn.addEventListener('click', closeEditor);
editorSaveBtn.addEventListener('click', saveEndpoint);

if (prefLangSelect) {
  prefLangSelect.addEventListener('change', async () => {
    prefs.lang = prefLangSelect.value;
    await loadTranslations(prefs.lang);
    applyTranslations();
    renderEndpointList();
    renderSlotSelectors();
    applyLayout();
    _guideLoaded = false;
    if (!panelGuidaEl.classList.contains('hidden')) loadGuide();
    saveState();
  });
}

Object.entries(editorSliders).forEach(([key, { slider, val }]) => {
  slider.addEventListener('input', () => {
    val.textContent = key === 'max_tokens' ? fmtTokens(slider.value) : parseFloat(slider.value);
  });
});

fToggleApiKey.addEventListener('click', () => {
  const isPass = fApiKey.type === 'password';
  fApiKey.type = isPass ? 'text' : 'password';
  fToggleApiKey.textContent = isPass ? '🙈' : '👁';
});

// ============================================================
// Init
// ============================================================

(async () => {
  await loadState();
  await loadTranslations(prefs.lang);
  applyFont();
  syncFontUI();
  syncLangUI();
  applyTranslations();
  renderEndpointList();
  renderSlotSelectors();
  applyLayout();
  switchTab('chat');
})();
