'use strict';

// ============================================================
// Data model
// ============================================================

function makeEndpoint(overrides = {}) {
  return {
    id: crypto.randomUUID(),
    name: 'Nuovo Endpoint',
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
let layout = { count: 1, slots: [null, null, null, null] };

let _saveTimer = null;
function saveState() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    fetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoints, layout }),
    }).catch((err) => console.error('[llm-ui] saveState failed:', err));
  }, 300);
}

async function loadState() {
  try {
    const res = await fetch('/api/config');
    if (res.ok) {
      const saved = await res.json();
      endpoints = Array.isArray(saved.endpoints) ? saved.endpoints : [];
      layout = saved.layout || { count: 1, slots: [null, null, null, null] };
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
  logs: [],          // { ts, level: 'info'|'warn'|'error', text }
  showConsole: false,
  consoleEl: null,
  consoleBtnEl: null,
}));

/** @type {Array<{name:string, kind:'text'|'image'|'pdf', content:string, dataUrl?:string}>} */
let attachedFiles = [];
let editingEndpointId = null;
let dragSrcIdx = null;
let activeAbortControllers = [];

// ============================================================
// DOM refs
// ============================================================

const $ = (id) => document.getElementById(id);

const tabBtns           = document.querySelectorAll('.tab-btn');
const panelChatEl       = $('panel-chat');
const panelEndpointEl   = $('panel-endpoint');
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
const exportConfigBtn   = $('export-config-btn');
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
        return `<pre><code class="hljs language-${language}">${highlighted}</code></pre>`;
      },
    },
  });
}

function parseMarkdown(text) {
  if (!text) return '';
  if (typeof marked === 'undefined') {
    return escapeHtml(text).replace(/\n/g, '<br>');
  }
  const html = marked.parse(text);
  return typeof DOMPurify !== 'undefined' ? DOMPurify.sanitize(html) : html;
}

// ============================================================
// Tab switching
// ============================================================

function switchTab(name) {
  panelChatEl.classList.toggle('hidden', name !== 'chat');
  panelEndpointEl.classList.toggle('hidden', name !== 'endpoint');
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
  if (typeof pdfjsLib === 'undefined') throw new Error('PDF.js non disponibile');
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
    catch (err) { showErrorInPanel(getFirstActivePanel(), `Errore lettura "${file.name}": ${err.message}`); }
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
  panelStates[idx].logs.push({ ts, level, text });
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
    empty.textContent = 'Nessuna attività registrata.';
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
  }
}

function buildPanelEl(idx) {
  const epId = layout.slots[idx];
  const ep = endpoints.find((e) => e.id === epId);
  const name = ep ? ep.name : '— Nessun endpoint —';

  const div = document.createElement('div');
  div.className = 'chat-panel';

  const header = document.createElement('div');
  header.className = 'flex items-center gap-2 px-3 py-1.5 border-b border-slate-700 bg-slate-800 flex-shrink-0';
  header.innerHTML = `
    <span class="text-xs font-semibold truncate flex-1 ${ep ? 'text-indigo-300' : 'text-slate-500'}">${escapeHtml(name)}</span>
    <button class="console-toggle-btn font-mono text-slate-500 hover:text-emerald-400 transition-colors text-xs px-1 leading-none" title="Console HTTP">&gt;_</button>
    <details class="export-details relative">
      <summary class="text-slate-500 hover:text-slate-300 transition-colors text-xs px-1 leading-none cursor-pointer" title="Esporta chat">⬇</summary>
      <div class="export-menu absolute right-0 top-5 z-20 bg-slate-700 border border-slate-600 rounded-lg shadow-xl py-1 min-w-[90px]">
        <button class="export-md-btn block w-full text-left px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-600 transition-colors">Markdown</button>
        <button class="export-json-btn block w-full text-left px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-600 transition-colors">JSON</button>
      </div>
    </details>
    <button class="clear-panel-btn text-slate-500 hover:text-slate-300 transition-colors text-sm" title="Pulisci pannello">↺</button>
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

  div.appendChild(header);
  div.appendChild(messages);
  div.appendChild(consoleDrw);
  return div;
}

// ============================================================
// Endpoint list & slot selectors
// ============================================================

function renderEndpointList() {
  dragSrcIdx = null;
  endpointListEl.innerHTML = '';
  if (endpoints.length === 0) {
    endpointListEl.innerHTML = '<p class="text-slate-500 text-sm">Nessun endpoint configurato.</p>';
    return;
  }
  endpoints.forEach((ep, idx) => {
    const div = document.createElement('div');
    div.className = 'ep-item flex items-center gap-3 px-4 py-3 bg-slate-800 rounded-lg border border-slate-700';
    div.draggable = true;
    div.innerHTML = `
      <span class="drag-handle select-none" title="Trascina per riordinare">⠿</span>
      <div class="flex-1 min-w-0">
        <div class="text-sm font-medium text-slate-200 truncate">${escapeHtml(ep.name)}</div>
        <div class="text-xs text-slate-500 truncate">${escapeHtml(ep.serverUrl)}${ep.model ? ' · ' + escapeHtml(ep.model) : ''}</div>
      </div>
      <button class="edit-btn text-xs text-slate-400 hover:text-indigo-400 px-2 py-1 rounded hover:bg-slate-700 transition-colors">Modifica</button>
      <button class="clone-btn text-xs text-slate-400 hover:text-emerald-400 px-2 py-1 rounded hover:bg-slate-700 transition-colors" title="Clona endpoint">⎘</button>
      <button class="del-btn text-xs text-slate-400 hover:text-red-400 px-2 py-1 rounded hover:bg-slate-700 transition-colors">Elimina</button>
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
    sel.innerHTML = '<option value="">— Nessuno —</option>';
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
      if (!Array.isArray(parsed.endpoints)) throw new Error('Formato non valido');
      if (!confirm(`Importare ${parsed.endpoints.length} endpoint? La configurazione attuale verrà sostituita.`)) return;
      endpoints = parsed.endpoints;
      layout = parsed.layout || { count: 1, slots: [null, null, null, null] };
      while (layout.slots.length < 4) layout.slots.push(null);
      const ids = new Set(endpoints.map((e) => e.id));
      layout.slots = layout.slots.map((s) => (s && ids.has(s) ? s : null));
      saveState();
      renderEndpointList();
      renderSlotSelectors();
      applyLayout();
    } catch (err) {
      alert('Errore importazione: ' + err.message);
    }
  };
  reader.readAsText(file);
}

// ============================================================
// Endpoint CRUD
// ============================================================

function openEditor(id = null) {
  editingEndpointId = id;
  editorTitle.textContent = id ? 'Modifica Endpoint' : 'Nuovo Endpoint';
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
    name: fName.value.trim() || 'Endpoint',
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
  if (!confirm('Eliminare questo endpoint?')) return;
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

function clearPanel(idx) {
  panelStates[idx].history = [];
  panelStates[idx].logs = [];
  if (panelStates[idx].messagesEl) panelStates[idx].messagesEl.innerHTML = '';
  renderConsoleEl(idx);
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
    const dateStr = new Date().toLocaleString('it-IT');
    const lines = [`# Chat — ${epName}`, `*Esportata il ${dateStr}*`, '', '---', ''];
    state.history.forEach((msg) => {
      lines.push(`**${msg.role === 'user' ? 'Utente' : 'Assistente'}**`, '', msg.content, '', '---', '');
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
      logToPanel(panelIdx, 'warn', '  ⚠ Backend non raggiungibile — avvia il server con uvicorn');
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

  } catch (err) {
    if (err.name === 'AbortError') {
      logToPanel(panelIdx, 'warn', '⏹ Generazione interrotta');
      if (assistantText) {
        bubble.innerHTML = parseMarkdown(assistantText) +
          '<span class="text-amber-500 text-xs block mt-1">⏹ interrotto</span>';
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
      showErrorInPanel(messagesEl, err.message || 'Errore di connessione.');
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
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
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
editorCancelBtn.addEventListener('click', closeEditor);
editorSaveBtn.addEventListener('click', saveEndpoint);

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
  renderEndpointList();
  renderSlotSelectors();
  applyLayout();
  switchTab('chat');
})();
