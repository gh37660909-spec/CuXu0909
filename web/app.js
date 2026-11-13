/* Nalo Code client: rails, history, chat streaming, workspace, account, settings. */

import { LANGUAGES, apply as applyI18n, getLanguage, setLanguage, t } from './i18n.js';

const $ = (id) => document.getElementById(id);

const state = {
  config: null,
  models: [],
  sessions: [],
  sessionId: null,
  app: null,
  profile: null,
  usage: null,
  attachments: [],
  runId: null,
  busy: false,
  live: null,
  openFile: null,
  editing: false,
  authMode: 'login',
  authChannel: 'account',
  captchaId: '',
  runStarted: 0,
  timer: null,
  paused: false,
  autoScroll: true,
  pendingMessage: null,
  abortController: null,
  stopped: false,
  automations: [],
  automationRuns: [],
  automationTimer: null,
  automationChatPoll: null,
  automationWatchSession: null,
  automationSessionsTimer: null,
  maintenance: { enabled: false, message: '' },
  maintenanceShown: false
};

/* --------------------------------------------------------------- helpers */

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { 'content-type': 'application/json' }, ...options });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok && data.maintenance) showMaintenance(data);
  if (!response.ok) {
    const error = new Error(data.error || `HTTP ${response.status}`);
    error.data = data;
    if (data.banned && typeof showBanNotice === 'function') showBanNotice(data.error);
    throw error;
  }
  return data;
}

function toast(message, ms = 2600) {
  const node = $('toast');
  const dialogs = [...document.querySelectorAll('dialog[open]')];
  const host = dialogs.length ? dialogs[dialogs.length - 1] : document.body;
  if (node.parentElement !== host) host.appendChild(node);
  node.textContent = message;
  node.hidden = false;
  node.style.zIndex = '2147483647';
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { node.hidden = true; }, ms);
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

function formatNumber(value) {
  return (value ?? 0).toLocaleString(getLanguage() === 'zh-CN' ? 'zh-CN' : undefined);
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return url || ''; }
}

/* -------------------------------------------------------------- markdown */

function renderInline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

function codeBlock(language, code) {
  const block = document.createElement('div');
  block.className = 'code-block';
  const head = document.createElement('div');
  head.className = 'code-head';
  const file = document.createElement('span');
  file.className = 'file';
  file.textContent = language || 'code';
  head.appendChild(file);
  const spacer = document.createElement('span');
  spacer.className = 'spacer';
  head.appendChild(spacer);
  const copy = document.createElement('button');
  copy.className = 'mini-btn';
  copy.textContent = t('chat.copy');
  copy.addEventListener('click', async () => {
    await copyText(code);
    copy.textContent = t('common.copied');
    setTimeout(() => { copy.textContent = t('chat.copy'); }, 1400);
  });
  head.appendChild(copy);
  block.appendChild(head);
  const pre = document.createElement('pre');
  pre.textContent = code.replace(/\n$/, '');
  block.appendChild(pre);
  return block;
}

function renderMarkdown(container, text) {
  container.textContent = '';
  const blocks = String(text).split(/```/);
  blocks.forEach((block, index) => {
    if (index % 2 === 1) {
      const firstBreak = block.indexOf('\n');
      const info = firstBreak === -1 ? '' : block.slice(0, firstBreak).trim();
      const code = firstBreak === -1 ? block : block.slice(firstBreak + 1);
      container.appendChild(codeBlock(info, code));
      return;
    }
    if (!block.trim()) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'md';
    for (const paragraph of block.split(/\n{2,}/)) {
      const trimmed = paragraph.trim();
      if (!trimmed) continue;
      const heading = trimmed.match(/^(#{1,3})\s+(.*)$/);
      if (heading) {
        const node = document.createElement(`h${Math.min(3, heading[1].length)}`);
        node.innerHTML = renderInline(heading[2]);
        wrapper.appendChild(node);
        continue;
      }
      if (trimmed.split('\n').every((line) => /^[-*]\s+/.test(line.trim()))) {
        const list = document.createElement('ul');
        for (const line of trimmed.split('\n')) {
          const item = document.createElement('li');
          item.innerHTML = renderInline(line.trim().replace(/^[-*]\s+/, ''));
          list.appendChild(item);
        }
        wrapper.appendChild(list);
        continue;
      }
      const node = document.createElement('p');
      node.innerHTML = renderInline(trimmed);
      wrapper.appendChild(node);
    }
    container.appendChild(wrapper);
  });
}

/* ------------------------------------------------------------- clipboard */

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    area.remove();
    return ok;
  }
}

async function readClipboard() {
  try { return await navigator.clipboard.readText(); } catch { return null; }
}

/* --------------------------------------------------------------- sessions */

function sessionTime(ts) {
  const date = new Date(ts || Date.now());
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const yesterday = new Date(now.getTime() - 86400000).toDateString() === date.toDateString();
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  if (sameDay) return `${hh}:${mm}`;
  if (yesterday) return `${t('history.yesterday')} ${hh}:${mm}`;
  return `${date.getMonth() + 1}/${date.getDate()} ${hh}:${mm}`;
}

function sessionGroup(ts) {
  const date = new Date(ts || Date.now());
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return t('history.today');
  if (new Date(now.getTime() - 86400000).toDateString() === date.toDateString()) return t('history.yesterday');
  return t('history.earlier');
}

function appendSessionRows(container, items, grouped = true) {
  let group = '';
  for (const session of items) {
    if (grouped) {
      const label = sessionGroup(session.updatedAt);
      if (label !== group) {
        group = label;
        const heading = document.createElement('div');
        heading.className = 'session-group';
        heading.textContent = label;
        container.appendChild(heading);
      }
    }
    const row = document.createElement('div');
    row.className = 'session-item' + (session.id === state.sessionId ? ' active' : '');
    row.tabIndex = 0;
    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'session-main';
    const title = document.createElement('span');
    title.className = 'session-title';
    title.textContent = session.title || t('history.newChat');
    const meta = document.createElement('span');
    meta.className = 'session-meta';
    const count = session.messageCount ?? (session.messages || []).length;
    const toolCount = session.toolCount ?? Object.keys(session.tools || {}).length;
    meta.textContent = `${sessionTime(session.updatedAt)} · ${count} ${t('history.msgUnit')}${toolCount ? ` · ${toolCount} ${t('history.toolUnit')}` : ''}`;
    main.append(title, meta);
    main.addEventListener('click', () => openSession(session.id));
    main.addEventListener('dblclick', () => startRename(session, title));
    const pin = document.createElement('button');
    pin.type = 'button';
    pin.className = 'session-pin' + (session.pinned ? ' on' : '');
    pin.dataset.tip = session.pinned ? t('history.unpin') : t('history.pin');
    pin.textContent = session.pinned ? '★' : '☆';
    pin.addEventListener('click', async (event) => {
      event.stopPropagation();
      await api('/api/session/pin', { method: 'POST', body: JSON.stringify({ id: session.id, pinned: !session.pinned }) });
      session.pinned = !session.pinned;
      renderSessions();
    });
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'session-del';
    del.dataset.tip = t('history.delete');
    del.textContent = '×';
    del.addEventListener('click', async (event) => { event.stopPropagation(); await deleteSession(session.id); });
    row.append(main, pin, del);
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      showContextMenu(event.clientX, event.clientY, [
        { label: t('history.rename'), action: () => startRename(session, title) },
        { label: session.pinned ? t('history.unpin') : t('history.pin'), action: async () => {
          await api('/api/session/pin', { method: 'POST', body: JSON.stringify({ id: session.id, pinned: !session.pinned }) });
          session.pinned = !session.pinned;
          renderSessions();
        } },
        { label: t('history.share'), action: async () => {
          const { url } = await api('/api/share', { method: 'POST', body: JSON.stringify({ sessionId: session.id }) });
          await copyText(url);
          toast(t('history.shared'));
        } },
        { label: t('history.export'), action: () => window.open(`/api/session/export?id=${encodeURIComponent(session.id)}`, '_blank') },
        '-',
        { label: t('history.delete'), action: () => deleteSession(session.id) }
      ]);
    });
    container.appendChild(row);
  }
}

function renderSessions() {
  const query = ($('search').value || '').trim().toLowerCase();
  const list = $('sessionList');
  const autoList = $('automationSessionList');
  list.textContent = '';
  autoList.textContent = '';
  const items = state.sessions.filter((session) => {
    if (!query) return true;
    const haystack = [session.title, ...(session.messages || []).map((message) => String(message.content || ''))]
      .join(' ').toLowerCase();
    return haystack.includes(query);
  }).sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || (b.updatedAt || 0) - (a.updatedAt || 0));
  const normal = items.filter((session) => !session.automationId);
  const auto = items.filter((session) => session.automationId);
  if (!normal.length) {
    const empty = document.createElement('div');
    empty.className = 'session-empty';
    empty.textContent = query ? t('history.noMatch') : t('history.empty');
    list.appendChild(empty);
  } else appendSessionRows(list, normal, true);
  if (!auto.length) {
    const empty = document.createElement('div');
    empty.className = 'session-empty';
    empty.textContent = t('automation.emptyChats');
    autoList.appendChild(empty);
  } else appendSessionRows(autoList, auto, false);
}

function startRename(session, titleNode) {
  const input = document.createElement('input');
  input.className = 'session-rename';
  input.value = session.title || '';
  titleNode.replaceWith(input);
  input.focus();
  input.select();
  const commit = async () => {
    const value = input.value.trim();
    if (value && value !== session.title) {
      await api('/api/session/rename', { method: 'POST', body: JSON.stringify({ id: session.id, title: value }) });
      session.title = value;
    }
    renderSessions();
  };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); input.blur(); }
    if (event.key === 'Escape') { input.value = session.title || ''; input.blur(); }
  });
}

function resetWorkspaceUi() {
  state.toolUsage = {};
  renderToolUsage({});
  if ($('activityList')) $('activityList').textContent = '';
  if ($('activityNow')) $('activityNow').textContent = '空闲';
  if ($('activityTimer')) $('activityTimer').textContent = '00:00';
  if ($('tree')) $('tree').textContent = '';
  if ($('viewerPath')) $('viewerPath').textContent = '—';
  if ($('viewerMeta')) $('viewerMeta').textContent = '';
  if ($('viewerCode')) $('viewerCode').innerHTML = '<span class="placeholder">—</span>';
  if ($('viewerEditor')) $('viewerEditor').hidden = true;
  if ($('saveFile')) $('saveFile').hidden = true;
  if ($('viewerOpen')) $('viewerOpen').hidden = true;
  if ($('viewerDownload')) $('viewerDownload').hidden = true;
  if ($('viewerForward')) $('viewerForward').hidden = true;
  if ($('viewerEdit')) $('viewerEdit').hidden = true;
}

async function deleteSession(id) {
  if (!(await askConfirm('删除这条聊天记录？删除后无法恢复。', '删除聊天记录'))) return;
  await abortCurrentRun();
  await api(`/api/session?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
  state.sessions = state.sessions.filter((item) => item.id !== id);
  if (state.sessionId === id) {
    state.sessionId = null;
    clearThread();
    resetWorkspaceUi();
    loadTree('.');
  }
  renderSessions();
}

function askConfirm(message, title = '确认操作') {
  return new Promise((resolve) => {
    const dialog = $('confirmDialog');
    $('confirmTitle').textContent = title;
    $('confirmMessage').textContent = message;
    $('confirmOk').onclick = () => { dialog.close(); resolve(true); };
    $('confirmCancel').onclick = () => { dialog.close(); resolve(false); };
    dialog.showModal();
  });
}

async function clearAllSessions() {
  if (!(await askConfirm('清空全部聊天记录？删除后无法恢复。', '清空聊天记录'))) return;
  await abortCurrentRun();
  await api('/api/sessions', { method: 'DELETE' });
  await refreshState();
  state.sessionId = null;
  state.live = null;
  clearThread();
  resetWorkspaceUi();
  renderSessions();
  await newSession();
  toast(t('history.cleared'));
}

async function newSession() {
  if (state.busy) await abortCurrentRun();
  const { session } = await api('/api/sessions', { method: 'POST' });
  state.sessions.unshift({ id: session.id, title: session.title, updatedAt: session.updatedAt });
  state.sessionId = session.id;
  resetWorkspaceUi();
  state.toolUsage = session.tools || {};
  clearThread();
  renderSessions();
  loadTree('.');
  renderToolUsage(state.toolUsage);
  $('prompt').focus();
}

async function openSession(id) {
  if (state.busy) await abortCurrentRun();
  const { session } = await api(`/api/session?id=${encodeURIComponent(id)}`);
  state.sessionId = session.id;
  const summary = {
    id: session.id, title: session.title, updatedAt: session.updatedAt,
    createdAt: session.createdAt || session.updatedAt, pinned: Boolean(session.pinned),
    automationId: session.automationId || (/^自动化：/.test(String(session.title || '')) ? 'legacy-auto' : ''),
    messageCount: (session.messages || []).length,
    toolCount: Object.keys(session.tools || {}).length
  };
  const known = state.sessions.findIndex((item) => item.id === session.id);
  if (known >= 0) state.sessions[known] = { ...state.sessions[known], ...summary };
  else state.sessions.unshift(summary);
  renderSessions();
  clearThread();
  resetWorkspaceUi();
  $('automationSessionTag').hidden = !session.automationId;
  if (session.automationId) $('automationSessionTag').textContent = t('automation.badge');
  if ($('automationPause')) $('automationPause').hidden = true;
  if (session.automationId) {
    refreshAutomationPause(session.id);
    watchAutomationChat(session.id);
  }
  state.toolUsage = session.tools || {};
  loadTree('.');
  renderToolUsage(state.toolUsage);
  const target = $('messages');
  for (const message of session.messages || []) {
    if (message.role === 'user') target.appendChild(userTurn(message.content));
    else if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      const line = document.createElement('div');
      line.className = 'history-tool';
      line.textContent = `执行：${message.tool_calls.map((call) => call.function?.name || 'tool').join('、')}`;
      target.appendChild(line);
    }
    else if (message.role === 'assistant' && message.content) {
      const turn = assistantTurn();
      turn.processDetails.remove();
      renderMarkdown(turn.body, message.content);
      turn.typing.remove();
      setStatus(turn, '', true);
      const time = turn.status.querySelector('.run-time');
      if (time) time.textContent = '';
      target.appendChild(turn.wrapper);
    }
  }
  if (session.plan?.length) {
    renderPlan(session.plan, target);
    const block = target.querySelector('.plan-block');
    const userTurns = target.querySelectorAll('.turn.user');
    if (block && userTurns.length) userTurns[userTurns.length - 1].after(block);
  }
  if (session.draft) {
    const turn = assistantTurn();
    turn.processDetails.remove();
    renderMarkdown(turn.body, session.draft);
    turn.typing.remove();
    setStatus(turn, '已暂停', true);
    target.appendChild(turn.wrapper);
  }
  $('welcome').hidden = (session.messages || []).length > 0 || Boolean(session.draft);
  if (session.openFile) {
    switchPane(session.pane || 'viewer');
    openFile(session.openFile);
  }
}

function resetViewer() {
  state.openFile = null;
  state.editing = false;
  if ($('viewerPath')) $('viewerPath').textContent = '未打开文件';
  if ($('viewerMeta')) $('viewerMeta').textContent = '';
  if ($('viewerCode')) { $('viewerCode').textContent = ''; $('viewerCode').hidden = false; }
  if ($('viewerEditor')) { $('viewerEditor').hidden = true; $('viewerEditor').value = ''; }
  if ($('saveFile')) $('saveFile').hidden = true;
  if ($('toggleEdit')) $('toggleEdit').hidden = true;
}

function clearThread() {
  $('messages').textContent = '';
  if ($('automationSessionTag')) $('automationSessionTag').hidden = true;
  if ($('automationPause')) $('automationPause').hidden = true;
  $('welcome').hidden = false;
  state.live = null;
  state.treeEntries = [];
  renderTreeEntries();
  resetViewer();
}

/* ------------------------------------------------------------------ turns */

function userTurn(text) {
  const wrapper = document.createElement('div');
  wrapper.className = 'turn user';
  const bubble = document.createElement('div');
  bubble.className = 'user-bubble';
  bubble.textContent = text;
  wrapper.appendChild(bubble);
  return wrapper;
}

function assistantTurn() {
  const wrapper = document.createElement('div');
  wrapper.className = 'turn assistant';
  const body = document.createElement('div');
  body.className = 'assistant-body';
  const typing = document.createElement('span');
  typing.className = 'typing';
  const processDetails = document.createElement('details');
  processDetails.className = 'process';
  const processSummary = document.createElement('summary');
  processSummary.innerHTML = '<span class="process-label"></span><span class="process-count"></span>';
  processSummary.querySelector('.process-label').textContent = t('chat.process');
  const processBody = document.createElement('div');
  processBody.className = 'process-body';
  processDetails.append(processSummary, processBody);
  processDetails.addEventListener('toggle', () => {
    if (!processDetails.open) return;
    processBody.querySelectorAll('details.think').forEach((node) => { node.open = true; });
  });
  const runLog = document.createElement('div');
  runLog.className = 'run-log';
  processBody.appendChild(runLog);
  const status = document.createElement('div');
  status.className = 'run-status';
  status.innerHTML = '<span class="spinner"></span><span class="run-label">' + t('phase.thinking') + '</span><span class="run-time">00:00</span><button type="button" class="run-think-btn" hidden>思考过程</button>';
  wrapper.append(processDetails, body, status);
  return { wrapper, body, typing, status, runLog, processDetails, processSummary, processBody };
}


function renderPlan(steps, container) {
  if (!Array.isArray(steps) || !steps.length) return;
  const block = document.createElement('details');
  block.className = 'plan-block';
  block.open = true;
  const title = document.createElement('summary');
  title.className = 'plan-title';
  const label = document.createElement('span');
  label.textContent = t('chat.plan');
  const stateLabel = document.createElement('em');
  stateLabel.className = 'plan-state';
  stateLabel.textContent = t('run.executing');
  title.append(label, stateLabel);
  block.appendChild(title);
  steps.forEach((step, index) => {
    const row = document.createElement('div');
    row.className = 'plan-step';
    const num = document.createElement('span');
    num.className = 'plan-num';
    num.textContent = String(index + 1);
    const text = document.createElement('span');
    text.textContent = step;
    row.append(num, text);
    block.appendChild(row);
  });
  container.appendChild(block);
}

function completePlan(live) {
  const block = live?.wrapper?.querySelector('.plan-block');
  if (!block) return;
  const stateLabel = block.querySelector('.plan-state');
  if (stateLabel) stateLabel.textContent = t('run.done');
  block.open = false;
  if (block.nextElementSibling?.classList.contains('plan-complete')) return;
  const count = block.querySelectorAll('.plan-step').length;
  const tools = Object.values(state.toolUsage || {}).reduce((sum, n) => sum + Number(n || 0), 0);
  const note = document.createElement('p');
  note.className = 'plan-complete';
  note.textContent = t('run.completedPlan').replace('{count}', count).replace('{tools}', tools);
  block.after(note);
}

function setStatus(live, label, idle = false) {
  if (!live?.status) return;
  live.status.classList.toggle('idle', Boolean(idle));
  const node = live.status.querySelector('.run-label');
  if (node) node.textContent = label;

}

function formatElapsed(ms) {
  const total = Math.max(0, Math.floor((ms || 0) / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function startRunTimer() {
  state.runStarted = Date.now();
  clearInterval(state.timer);
  state.timer = setInterval(() => {
    const text = formatElapsed(Date.now() - state.runStarted);
    if (state.live?.status) {
      const node = state.live.status.querySelector('.run-time');
      if (node) node.textContent = text;
    }
    const activityTimer = $('activityTimer');
    if (activityTimer) activityTimer.textContent = text;
  }, 500);
}

function stopRunTimer() {
  clearInterval(state.timer);
  state.timer = null;
}

const ACTIVITY_ICONS = {
  thinking: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
  tool: '<path d="M14 7l3 3-7 7H7v-3z"/>',
  write: '<path d="M5 19h14"/><path d="M9 15l7-7 3 3-7 7H9z"/>',
  read: '<path d="M6 4h9l4 4v12H6z"/><path d="M15 4v4h4"/><path d="M9 13h6M9 16h4"/>',
  terminal: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 10l2 2-2 2"/><path d="M12 14h5"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M16 16l4 4"/>',
  image: '<rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="9" cy="10" r="1.4"/><path d="M4 16l5-4 4 3 3-2 4 3"/>',
  doc: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/><path d="M10 12h5M10 15h5"/>',
  open: '<path d="M14 4h6v6"/><path d="M20 4l-8 8"/><path d="M18 14v5H5V6h5"/>',
  ask: '<circle cx="12" cy="12" r="8"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7"/><path d="M12 17h.01"/>',
  plug: '<path d="M9 3v6M15 3v6"/><path d="M6 9h12v3a6 6 0 0 1-12 0z"/><path d="M12 18v3"/>',
  approve: '<path d="M12 3l7 3v5c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6l7-3z"/>'
};

const TOOL_ICON_KEYS = {
  read_file: 'read', list_files: 'read', read_document: 'doc', edit_file: 'write',
  write_file: 'write', create_document: 'doc', edit_document: 'doc',
  run_command: 'terminal', search_files: 'search', glob_files: 'search',
  web_search: 'search', fetch_url: 'search', read_image: 'image',
  convert_image: 'image', look_screen: 'image', open_in_app: 'open', open_url: 'open',
  ask_user: 'ask', remember: 'doc', recall: 'doc'
};

function toolIconKind(name) {
  if (name.startsWith('mcp__')) return 'plug';
  return TOOL_ICON_KEYS[name] || 'tool';
}

function addActivity(label, detail, phase = 'tool', elapsedMs = 0) {
  const list = $('activityList');
  const now = $('activityNow');
  if (now) now.textContent = detail ? `${label} · ${detail}` : label;
  if (!list) return;
  const item = document.createElement('div');
  item.className = 'activity-item';
  item.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ACTIVITY_ICONS[phase] || ACTIVITY_ICONS.tool}</svg>
    <div class="activity-text"><strong></strong><small></small></div>
    <span class="activity-time"></span>`;
  item.querySelector('strong').textContent = label;
  item.querySelector('small').textContent = detail || '';
  item.querySelector('.activity-time').textContent = formatElapsed(elapsedMs || (state.runStarted ? Date.now() - state.runStarted : 0));
  list.prepend(item);
}

function approvalCard(payload) {
  const card = document.createElement('div');
  card.className = 'approval-card';
  card.innerHTML = `<strong></strong><small></small>
    <div class="approval-actions"><button type="button" class="allow">允许访问</button><button type="button" class="deny">拒绝</button></div>`;
  card.querySelector('strong').textContent = `请求访问：${payload.tool}`;
  const detail = [payload.path, payload.drive, payload.workspace].filter(Boolean).join(' · ');
  card.querySelector('small').textContent = detail;
  const finish = (message) => {
    card.textContent = message;
    card.classList.remove('pending');
  };
  card.querySelector('.allow').addEventListener('click', async () => {
    await answerQuestion(payload.id, '允许');
    finish('已允许本次文件访问');
  });
  card.querySelector('.deny').addEventListener('click', async () => {
    await answerQuestion(payload.id, '拒绝');
    finish('已拒绝本次文件访问');
  });
  return card;
}

function ensureLiveTurn() {
  if (!state.live) {
    state.live = { ...assistantTurn(), think: null, thinkBody: null, buffer: '', toolLines: new Map() };
    $('messages').appendChild(state.live.wrapper);
  }
  return state.live;
}

function runLine(text, { kind = 'tool', active = true } = {}) {
  const live = ensureLiveTurn();
  const line = document.createElement('div');
  line.className = `run-line ${active ? 'active' : 'done'}`;
  line.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ACTIVITY_ICONS[kind] || ACTIVITY_ICONS.tool}</svg><span class="run-text"></span>`;
  line.querySelector('.run-text').textContent = text;
  live.runLog.appendChild(line);
  const count = live.processSummary.querySelector('.process-count');
  if (count) count.textContent = `${live.runLog.children.length} ${t('chat.steps')}`;
  scrollThread();
  return line;
}

function finishRunLine(line, file) {
  if (!line) return;
  line.classList.remove('active');
  line.classList.add('done');
  const tick = document.createElement('span');
  tick.className = 'run-tick';
  tick.textContent = '✓';
  line.appendChild(tick);
  if (file) {
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'run-open';
    open.textContent = '打开';
    open.addEventListener('click', () => { switchPane('viewer'); openFile(file); });
    line.appendChild(open);
  }
}

const TOOL_PHASE = {
  list_files: 'phase.reading', read_file: 'phase.reading',
  write_file: 'phase.writing', edit_file: 'phase.writing',
  run_command: 'phase.running',
  search_files: 'phase.searching', glob_files: 'phase.searching',
  web_search: 'phase.searching', fetch_url: 'phase.searching',
  read_image: 'phase.scanning', read_document: 'phase.reading',
  create_document: 'phase.creating', edit_document: 'phase.creating',
  convert_image: 'phase.converting',
  open_in_app: 'phase.opening', open_url: 'phase.opening',
  ask_user: 'phase.waiting',
  look_screen: 'phase.scanning', list_drives: 'phase.scanning'
};

function toolLineText(name, detail) {
  if (name.startsWith('mcp__')) {
    const parts = name.split('__');
    return `${t('phase.calling')} · ${parts[2] || name}${detail ? ` · ${detail}` : ''}`;
  }
  const key = TOOL_PHASE[name];
  if (key) {
    const label = t(key);
    return detail ? `${label} · ${detail}` : label;
  }
  if (name === 'read_file' || name === 'list_files') return `读取中 · ${detail || '/'}`;
  if (name === 'write_file') return `执行命令 · 写入 ${detail || ''}`;
  if (name === 'read_image') return `扫描图片 · ${detail || ''}`;
  if (name === 'read_document') return `读取文档 · ${detail || ''}`;
  if (name === 'convert_image') return `转换图片 · ${detail || ''}`;
  if (name === 'edit_document') return `修改文档 · ${detail || ''}`;
  if (name === 'open_in_app') return `打开 · ${detail || ''}`;
  if (name === 'web_search') return `联网搜索 · ${detail || ''}`;
  if (name === 'fetch_url') return `读取网页 · ${detail || ''}`;
  if (name === 'ask_user') return '等待你的选择';
  return `执行命令 · ${name}`;
}

let scrollQueued = false;
function scrollThread(force = false) {
  if (!force && state.autoScroll === false) return;
  if (scrollQueued) return;
  scrollQueued = true;
  requestAnimationFrame(() => {
    scrollQueued = false;
    const thread = $('thread');
    thread.scrollTop = thread.scrollHeight;
  });
}

function appendThinking(text) {
  const live = ensureLiveTurn();
  live.typing.remove();
  if (!live.think) {
    const panel = document.createElement('details');
    panel.className = 'think-panel';
    const summary = document.createElement('summary');
    summary.textContent = '思考过程';
    const body = document.createElement('div');
    body.className = 'think-panel-body';
    panel.append(summary, body);
    live.processBody.insertBefore(panel, live.processBody.firstChild);
    live.think = panel;
    live.thinkBody = body;
    const button = live.status.querySelector('.run-think-btn');
    if (button) {
      button.hidden = false;
      button.onclick = () => {
        live.processDetails.open = !live.processDetails.open;
        button.classList.toggle('active', live.processDetails.open);
      };
      live.thinkBtn = button;
    }
  }
  live.thinkBody.appendChild(document.createTextNode(text));
  live.thinkBody.scrollTop = live.thinkBody.scrollHeight;
  scrollThread();
}

function showThinkingPeek() {
  const peek = $('thinkingPeek');
  if (peek) peek.hidden = true;
}

function hideThinkingPeek() {
  const peek = $('thinkingPeek');
  if (!peek) return;
  peek.hidden = true;
  peek.classList.remove('active');
}

function finishThinking() {
  const live = state.live;
  if (!live?.think) return;
  live.think.classList.remove('live');
  live.think.open = false;
  if (live.thinkBtn) live.thinkBtn.hidden = true;
  const summary = live.think.querySelector('summary');
  if (summary) {
    for (const node of summary.childNodes) {
      if (node.nodeType === 3) node.nodeValue = '思考过程';
    }
  }
}

let contentTimer = null;
function flushContent() {
  if (!contentTimer) return;
  clearTimeout(contentTimer);
  contentTimer = null;
  const live = state.live;
  if (live) renderMarkdown(live.body, live.buffer);
  scrollThread();
}

function appendContent(text) {
  const live = ensureLiveTurn();
  finishThinking();
  live.typing.remove();
  live.buffer += text;
  if (!contentTimer) {
    contentTimer = setTimeout(() => {
      contentTimer = null;
      if (state.live) renderMarkdown(state.live.body, state.live.buffer);
      scrollThread();
    }, 55);
  }
}

function appendError(message) {
  const live = ensureLiveTurn();
  live.typing.remove();
  const node = document.createElement('div');
  node.className = 'md';
  node.style.color = 'var(--danger)';
  node.style.fontSize = '12.5px';
  node.textContent = message;
  live.body.appendChild(node);
  scrollThread();
}

function toolCard({ name, args, ok, preview, file }) {
  const card = document.createElement('div');
  card.className = 'tool-card' + (ok === true ? ' ok' : ok === false ? ' fail' : '');
  const head = document.createElement('div');
  head.className = 'tool-head';
  const title = document.createElement('span');
  title.className = 'tool-name';
  title.textContent = name;
  head.appendChild(title);
  const argText = document.createElement('span');
  argText.className = 'tool-args';
  argText.textContent = args?.path || args?.question || '';
  head.appendChild(argText);
  const status = document.createElement('span');
  status.className = 'tool-state' + (ok === true ? ' ok' : ok === false ? ' fail' : '');
  status.textContent = ok === true ? '✓' : ok === false ? '✕' : '…';
  head.appendChild(status);
  card.appendChild(head);
  if (preview) {
    const pre = document.createElement('pre');
    pre.className = 'tool-preview';
    pre.textContent = String(preview).slice(0, 300);
    card.appendChild(pre);
  }
  if (file) {
    const open = document.createElement('button');
    open.className = 'mini-btn';
    open.style.margin = '0 11px 9px';
    open.textContent = file;
    open.addEventListener('click', () => { switchPane('viewer'); openFile(file); });
    card.appendChild(open);
  }
  return card;
}

function askCard({ id, question, options }) {
  const card = document.createElement('div');
  card.className = 'ask-card pending';
  const title = document.createElement('div');
  title.className = 'ask-title';
  title.textContent = '需要你选择';
  card.appendChild(title);
  const text = document.createElement('div');
  text.className = 'ask-question';
  text.textContent = question;
  card.appendChild(text);

  const finish = (answer) => {
    card.classList.remove('pending');
    card.textContent = '';
    const done = document.createElement('div');
    done.className = 'ask-answered';
    done.innerHTML = '✓ <b></b>';
    done.querySelector('b').textContent = answer;
    card.appendChild(done);
  };

  if (options?.length) {
    const row = document.createElement('div');
    row.className = 'ask-options';
    for (const option of options) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = option;
      button.addEventListener('click', async () => { await answerQuestion(id, option); finish(option); });
      row.appendChild(button);
    }
    card.appendChild(row);
  }

  const inputRow = document.createElement('div');
  inputRow.className = 'ask-input-row';
  const input = document.createElement('input');
  const submit = document.createElement('button');
  submit.type = 'button';
  submit.className = 'ask-submit';
  submit.textContent = '↵';
  const send = async () => {
    const value = input.value.trim();
    if (!value) return;
    await answerQuestion(id, value);
    finish(value);
  };
  submit.addEventListener('click', send);
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); send(); } });
  inputRow.append(input, submit);
  card.appendChild(inputRow);
  return card;
}

async function answerQuestion(id, value) {
  try { await api('/api/answer', { method: 'POST', body: JSON.stringify({ id, answer: value }) }); }
  catch (error) { toast(error.message); }
}

/* ------------------------------------------------------------------- chat */

async function sendMessage(text) {
  state.autoScroll = true;
  if (!state.app?.authenticated) { openLogin(); return; }
  const message = String(text || '').trim();
  if (!message) return;
  if (state.busy) {
    if (!state.sessionId) return;
    $('welcome').hidden = true;
    $('messages').appendChild(userTurn(message));
    $('prompt').value = '';
    autoGrow();
    scrollThread();
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: state.sessionId, message })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    } catch (error) {
      toast(error.message);
    }
    return;
  }
  state.runCompleted = false;
  const localReady = state.config?.localModelEnabled;
  if (!state.config?.configured && !localReady) { openSettings('model'); return; }
  if (!state.sessionId) await newSession();

  const attachments = state.attachments.slice();
  const suffix = attachments.length
    ? `\n\n已上传到工作区：\n${attachments.map((item) => `- ${item.path}`).join('\n')}`
    : '';

  $('welcome').hidden = true;
  const turn = userTurn(message + (attachments.length ? `\n\n[${attachments.map((item) => item.name).join(', ')}]` : ''));
  $('messages').appendChild(turn);
  $('prompt').value = '';
  autoGrow();
  state.attachments = [];
  renderAttachments();
  scrollThread();

  state.busy = true;
  state.paused = false;
  state.stopped = false;
  state.abortController = new AbortController();
  state.live = null;
  $('resumeBar').hidden = true;
  $('stop').hidden = false;
  startRunTimer();
  addActivity('开始运行', message.slice(0, 40), 'thinking', 0);

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: state.sessionId, message: message + suffix }),
      signal: state.abortController.signal
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw new Error(detail.error || `HTTP ${response.status}`);
    }
    await consumeStream(response);
  } catch (error) {
    if (error?.name !== 'AbortError') appendError(error.message);
  } finally {
    if (state.busy) await finishRunUI();
  }
}

function showRunComplete(live) {
  if (!live || live.wrapper.querySelector('.run-complete')) return;
  if (live.wrapper.querySelector('.plan-complete')) return;
  const first = (live.body.textContent || '').trim().split('\n').find((line) => line.trim()) || '';
  const summary = first.replace(/\s+/g, ' ').slice(0, 90);
  const tools = Object.values(state.toolUsage || {}).reduce((sum, n) => sum + Number(n || 0), 0);
  const note = document.createElement('div');
  note.className = 'run-complete';
  note.innerHTML = '<span class="run-complete-check">✓</span><span></span>';
  note.lastElementChild.textContent = summary
    ? `${t('run.completed')}${summary}${summary.length >= 90 ? '…' : ''}`
    : t('run.completedTools').replace('{tools}', tools);
  live.wrapper.appendChild(note);
  if (live.status) live.status.hidden = true;
  if (live.processDetails) live.processDetails.open = false;
  scrollThread();
}

async function finishRunUI() {
  state.busy = false;
  state.paused = false;
  state.pausedFinished = false;
  state.abortController = null;
  state.runId = null;
  state.eventBuffer = [];
  $('send').disabled = false;
  $('stop').hidden = true;
  $('approvalPrompt').hidden = true;
  state.pendingApproval = null;
  stopRunTimer();
  if (state.live) {
    finishThinking();
    state.live.typing.remove();
    setStatus(state.live, '', true);
    if (state.runCompleted) showRunComplete(state.live);
  }
  if ($('activityNow')) $('activityNow').textContent = '空闲';
  await refreshState();
  loadTree().catch(() => {});
  const pending = state.pendingMessage;
  state.pendingMessage = null;
  if (pending) setTimeout(() => sendMessage(pending), 80);
}

async function consumeStream(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n\n')) !== -1) {
      const chunk = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const eventMatch = chunk.match(/^event:\s*(.+)$/m);
      const dataMatch = chunk.match(/^data:\s*(.+)$/m);
      if (!eventMatch) continue;
      let payload = {};
      if (dataMatch) { try { payload = JSON.parse(dataMatch[1]); } catch { payload = {}; } }
      handleEvent(eventMatch[1].trim(), payload);
    }
  }
}

const VIEW_TOOLS = new Set(['read_file', 'list_files', 'read_image', 'read_document', 'read_office', 'browser_read', 'fetch_url', 'recall_memory']);

function handleEvent(event, payload) {
  if (event !== 'content' && event !== 'thinking') flushContent();
  if (state.paused && event !== 'start') {
    (state.eventBuffer ||= []).push([event, payload]);
    return;
  }
  switch (event) {
    case 'start': state.runId = payload.runId; break;
    case 'thinking': appendThinking(payload.text || ''); break;
    case 'content': appendContent(payload.text || ''); break;
    case 'tool-start': {
      const live = ensureLiveTurn();
      finishThinking();
      live.typing.remove();
      const detail = payload.detail || payload.args?.path || '';
      const text = toolLineText(payload.name, detail);
      setStatus(live, VIEW_TOOLS.has(payload.name) ? '查看中' : '执行任务中');
      addActivity(`调取 ${payload.name}`, detail, 'tool', payload.elapsedMs);
      rememberTool(payload.name);
      live.toolLines.set(payload.id, runLine(text, { kind: toolIconKind(payload.name) }));
      break;
    }
    case 'activity': {
      if (payload.phase === 'thinking') setStatus(ensureLiveTurn(), '思考中');
      else if (payload.phase === 'write') setStatus(ensureLiveTurn(), '执行任务中');
      else if (/查看|读取|检查|浏览|搜索/.test(payload.label || '')) setStatus(ensureLiveTurn(), '查看中');
      else if (payload.phase === 'tool') setStatus(ensureLiveTurn(), '执行任务中');
      addActivity(payload.label || '', payload.detail || '', payload.phase || 'tool', payload.elapsedMs);
      break;
    }
    case 'approval': {
      const live = ensureLiveTurn();
      setStatus(live, '等待确认');
      addActivity('请求访问权限', payload.path || '', 'approve', payload.elapsedMs);
      state.pendingApproval = payload;
      const tool = String(payload.tool || '操作');
      const labels = {
        run_command: '运行命令', write_file: '写入文件', edit_file: '修改文件', create_document: '创建文档', edit_document: '修改文档', create_document: '创建文档', edit_document: '修改文档',
        delete_file: '删除文件', remove_file: '删除文件', web_fetch: '访问网页',
        browser: '控制浏览器', read_file: '读取文件', list_files: '浏览文件'
      };
      const actions = {
        run_command: '执行一条命令', write_file: '写入一个文件', edit_file: '修改一个文件',
        delete_file: '删除一个文件', remove_file: '删除一个文件', web_fetch: '访问一个网页',
        browser: '操作浏览器页面', read_file: '查看一个文件', list_files: '浏览一个目录'
      };
      const label = labels[tool] || tool;
      const action = actions[tool] || `执行 ${label}`;
      const rawDetail = String(payload.detail || '').trim();
      const knownLocation = String(payload.location || payload.path || payload.file || payload.target || payload.url || payload.drive || '').trim();
      const looksLikeLocation = /^(?:[A-Za-z]:[\\/]|\\\\|\/|https?:\/\/|\.{0,2}[\\/])/.test(rawDetail);
      const location = knownLocation || (looksLikeLocation ? rawDetail : '');
      const command = String(payload.command || (tool === 'run_command' ? rawDetail : '')).trim();
      const risky = /delete|remove|write|edit|run_command|exec|shell|browser/i.test(tool);
      $('approvalTitle').textContent = '需要你的许可';
      $('approvalTool').textContent = label;
      const summaryText = payload.summary || `Agent 想${action}，请确认这是你需要的操作。`;
      const detailText = payload.detail && !summaryText.includes(payload.detail) ? `${summaryText} ${payload.detail}` : summaryText;
      $('approvalDetail').textContent = detailText;
      $('approvalLocationRow').hidden = !location;
      $('approvalLocation').textContent = location;
      $('approvalPreviewWrap').hidden = !command;
      $('approvalPreview').textContent = command;
      const risk = $('approvalRisk');
      if (risky) { risk.textContent = '高风险'; risk.className = 'approval-risk high'; }
      else if (/fetch|browser|read|list/i.test(tool)) { risk.textContent = '低风险'; risk.className = 'approval-risk low'; }
      else { risk.textContent = '中风险'; risk.className = 'approval-risk medium'; }
      $('approvalPrompt').hidden = false;
      $('approvalDeny').focus();
      scrollThread();
      break;
    }
    case 'tool-end': {
      const live = ensureLiveTurn();
      finishRunLine(live.toolLines.get(payload.id), payload.file);
      live.toolLines.delete(payload.id);
      if (payload.file) {
        loadTree();
        if (!state.openFile) { switchPane('viewer'); openFile(payload.file); }
      }
      setStatus(live, '思考中');
      break;
    }
    case 'ask': {
      const live = ensureLiveTurn();
      setStatus(live, '等待中');
      finishThinking();
      live.wrapper.appendChild(askCard(payload));
      scrollThread();
      break;
    }
    case 'compressing': {
      const live = ensureLiveTurn();
      setStatus(live, t('run.compressing'));
      addActivity(t('run.compressingWork'), '', 'tool');
      break;
    }
    case 'compressed': {
      addActivity(t('run.compressedWork'), `${payload.messageCount || ''}`, 'tool');
      break;
    }
    case 'done':
      state.runCompleted = true;
      if (state.live && payload.text) {
        state.live.buffer = payload.text;
        renderMarkdown(state.live.body, payload.text);
      }
      completePlan(state.live);
      finishThinking();
      hideThinkingPeek();
      if (state.live) {
        state.live.typing.remove();
        setStatus(state.live, t('run.done'), true);
        if (!state.live.body.textContent.trim()) {
          const note = document.createElement('p');
          note.className = 'run-empty';
          note.textContent = payload.limitReached ? t('run.limit') : t('run.retry');
          state.live.body.appendChild(note);
        }
      }
      addActivity('完成本轮', `用时 ${formatElapsed(payload.elapsedMs || 0)}`, 'tool', payload.elapsedMs || 0);
      break;
    case 'plan': {
      const live = ensureLiveTurn();
      finishThinking();
      live.typing.remove();
      renderPlan(payload.steps, live.wrapper);
      scrollThread();
      break;
    }
    case 'compressed':
      toast(t('chat.compressed'));
      addActivity(t('run.compressed'), `${payload.tokenUsage || 0} tokens`, 'thinking', 0);
      break;
    case 'error': appendError(payload.message || t('common.error')); break;
  }
}

async function abortCurrentRun() {
  const runId = state.runId;
  const sessionId = state.sessionId;
  try { state.abortController?.abort(); } catch { }
  state.abortController = null;
  state.busy = false;
  state.paused = false;
  state.pausedFinished = false;
  state.eventBuffer = [];
  state.pendingMessage = null;
  state.runId = null;
  if (typeof $('resumeBar') !== 'undefined' && $('resumeBar')) $('resumeBar').hidden = true;
  if (runId || sessionId) {
    await api('/api/stop', { method: 'POST', body: JSON.stringify({ runId, sessionId }) }).catch(() => {});
  }
  stopRunTimer();
  if ($('stop')) $('stop').hidden = true;
  if ($('send')) $('send').disabled = false;
}

async function stopRun() {
  const live = state.live;
  state.stopped = true;
  if (live) {
    live.typing?.remove();
    setStatus(live, t('run.stopped'), true);
  }
  await abortCurrentRun();
  await finishRunUI();
  if (live) {
    const note = document.createElement('div');
    note.className = 'run-stopped';
    note.textContent = t('run.stoppedNote');
    live.wrapper.appendChild(note);
  }
}

/* ---------------------------------------------------------------- upload */

async function uploadFiles(files) {
  for (const file of files) {
    if (!file) continue;
    if (file.size > 8 * 1024 * 1024) { toast(`${file.name}: > 8MB`); continue; }
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    try {
      const result = await api('/api/upload', {
        method: 'POST',
        body: JSON.stringify({ name: file.name, type: file.type, data: base64, session: state.sessionId })
      });
      state.attachments.push(result);
      renderAttachments();
      loadTree();
    } catch (error) { toast(error.message); }
  }
  $('fileInput').value = '';
}

function renderAttachments() {
  const box = $('attachments');
  box.textContent = '';
  box.hidden = !state.attachments.length;
  state.attachments.forEach((item, index) => {
    const chip = document.createElement('div');
    chip.className = 'attachment';
    const label = document.createElement('span');
    label.textContent = `${item.name} · ${Math.max(1, Math.round(item.size / 1024))}K`;
    label.dataset.tip = item.path;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '✕';
    remove.addEventListener('click', () => {
      state.attachments.splice(index, 1);
      renderAttachments();
    });
    chip.append(label, remove);
    box.appendChild(chip);
  });
}

/* ------------------------------------------------------------- workspace */

function switchPane(node) {
  document.querySelectorAll('.ws-tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.pane === node));
  document.querySelectorAll('.ws-pane').forEach((pane) => pane.classList.toggle('active', pane.dataset.pane === node));
}

function saveSessionState() {
  if (!state.sessionId) return;
  const pane = document.querySelector('.ws-tab.active')?.dataset.pane || 'tree';
  api('/api/session/state', { method: 'POST', body: JSON.stringify({ id: state.sessionId, openFile: state.openFile || '', pane }) }).catch(() => {});
}

function sessionQuery() {
  return state.sessionId ? `&session=${encodeURIComponent(state.sessionId)}` : '';
}


const TOOL_LABELS = {
  list_files: '查看文件', read_file: '读取文件', write_file: '写入文件',
  read_image: '扫描图片', read_document: '读取文档', create_document: '创建文档',
  convert_image: '转换图片', edit_document: '修改文档', open_in_app: '打开程序',
  open_url: '打开浏览器', list_drives: '查看磁盘', look_screen: '查看屏幕',
  web_search: '联网搜索', fetch_url: '抓取网页', ask_user: '询问你',
  run_command: '执行命令', search_files: '搜索代码', glob_files: '查找文件',
  edit_file: '修改文件', edit_pdf: '修改 PDF', edit_scanned_pdf: '修改扫描件', remember: '记住', recall: '读取记忆', set_plan: '制定计划',
  office_edit: '编辑 Office', verify_project: '运行测试', analyze_image: '看图片', media_info: '媒体信息',
  transcribe_audio: '转写语音', service_start: '启动进程', service_list: '查看进程', service_stop: '停止进程',
  service_logs: '进程日志', browser_wait: '等待页面', browser_press: '按键', browser_scroll: '滚动页面',
  browser_upload: '上传文件', browser_open: '打开网页', browser_read: '读取网页', browser_click: '点击页面',
  browser_type: '填写页面', browser_screenshot: '页面截图', run_code: '编译运行', list_runtimes: '检查运行时'
};

function toolLabel(name) {
  if (TOOL_LABELS[name]) return TOOL_LABELS[name];
  if (name.startsWith('mcp__')) {
    const parts = name.split('__');
    return `MCP · ${parts[2] || name}`;
  }
  return name;
}

function renderToolUsage(tools) {
  const box = $('wsToolChips');
  if (!box) return;
  box.textContent = '';
  const entries = Object.entries(tools || {});
  if (!entries.length) {
    const empty = document.createElement('span');
    empty.className = 'ws-tools-empty';
    empty.textContent = '还没有调用工具';
    box.appendChild(empty);
    return;
  }
  for (const [name, count] of entries.sort((a, b) => b[1] - a[1])) {
    const chip = document.createElement('span');
    chip.className = 'ws-tool-chip';
    chip.textContent = toolLabel(name);
    if (count > 1) {
      const badge = document.createElement('b');
      badge.textContent = `×${count}`;
      chip.appendChild(badge);
    }
    chip.dataset.tip = name;
    box.appendChild(chip);
  }
}

function rememberTool(name) {
  state.toolUsage = state.toolUsage || {};
  state.toolUsage[name] = (state.toolUsage[name] || 0) + 1;
  renderToolUsage(state.toolUsage);
}

const WS_ICONS = {
  dir: '<path d="M3 7h6l2 3h10v9H3z"/>',
  code: '<path d="M9 8l-4 4 4 4"/><path d="M15 8l4 4-4 4"/>',
  doc: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/><path d="M10 12h5M10 15h5"/>',
  image: '<rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="9" cy="10" r="1.4"/><path d="M4 16l5-4 4 3 3-2 4 3"/>',
  pdf: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/><path d="M9 16h6"/>',
  sheet: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 10h16M4 15h16M10 4v16"/>',
  archive: '<path d="M4 7h16v13H4z"/><path d="M4 7l2-3h12l2 3"/><path d="M10 11h4"/>',
  file: '<path d="M6 4h8l4 4v12H6z"/><path d="M14 4v4h4"/>'
};

function wsIconKind(entry) {
  if (entry.dir) return 'dir';
  const ext = (entry.name.split('.').pop() || '').toLowerCase();
  if (['js','ts','py','java','c','cpp','cs','go','rs','php','rb','lua','pl','ps1','bat','sh','json','html','css','md'].includes(ext)) return 'code';
  if (['png','jpg','jpeg','webp','gif','bmp','svg','ico'].includes(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (['docx','doc','wps','pptx','ppt','txt','rtf'].includes(ext)) return 'doc';
  if (['xlsx','xls','csv'].includes(ext)) return 'sheet';
  if (['zip','rar','7z','tar','gz'].includes(ext)) return 'archive';
  return 'file';
}

function wsTime(ms) {
  if (!ms) return '';
  const date = new Date(ms);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return sameDay ? `${hh}:${mm}` : `${date.getMonth() + 1}/${date.getDate()}`;
}

function renderTreeEntries() {
  const tree = $('tree');
  if (!tree) return;
  tree.textContent = '';
  const filter = ($('wsFilter')?.value || '').trim().toLowerCase();
  const entries = (state.treeEntries || []).filter((entry) => !filter || entry.name.toLowerCase().includes(filter));
  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'tree-empty';
    empty.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h6l2 3h10v9H3z"/></svg><span></span>';
    empty.querySelector('span').textContent = filter ? t('ws.noMatch') : t('ws.empty');
    tree.appendChild(empty);
    return;
  }
  for (const entry of entries) {
    const row = document.createElement('div');
    row.className = 'tree-row' + (entry.dir ? ' dir' : '') + (entry.path === state.openFile ? ' active' : '');
    row.dataset.path = entry.path;
    row.dataset.dir = String(entry.dir);

    const icon = document.createElement('span');
    icon.className = 'tree-icon';
    icon.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${WS_ICONS[wsIconKind(entry)]}</svg>`;

    const name = document.createElement('span');
    name.className = 'tree-name';
    name.textContent = entry.name;
    name.dataset.tip = entry.name;

    const meta = document.createElement('span');
    meta.className = 'tree-meta';
    meta.textContent = entry.dir ? '' : `${entry.size > 1024 ? `${Math.round(entry.size / 1024)}K` : `${entry.size}B`} · ${wsTime(entry.mtime)}`;

    const actions = document.createElement('span');
    actions.className = 'tree-actions';
    if (!entry.dir) {
      const download = document.createElement('button');
      download.type = 'button';
      download.dataset.tip = t('history.export');
      download.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v10"/><path d="M8 11l4 4 4-4"/><path d="M5 19h14"/></svg>';
      download.addEventListener('click', (event) => {
        event.stopPropagation();
        window.open(`/api/download?path=${encodeURIComponent(entry.path)}${sessionQuery()}`, '_blank');
      });
      actions.appendChild(download);
    }
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.dataset.tip = t('history.delete');
    remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M6 7l1 13h10l1-13"/></svg>';
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      deleteWorkspaceEntry(entry.path).catch((error) => toast(error.message));
    });
    actions.appendChild(remove);

    row.append(icon, name, meta, actions);
    row.addEventListener('click', () => {
      if (entry.dir) { loadTree(entry.path); return; }
      switchPane('viewer');
      openFile(entry.path);
    });
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      showContextMenu(event.clientX, event.clientY, [
        { label: t('ws.open'), action: () => { switchPane('viewer'); openFile(entry.path); } },
        { label: t('history.export'), action: () => window.open(`/api/download?path=${encodeURIComponent(entry.path)}${sessionQuery()}`, '_blank') },
        '-',
        { label: t('history.delete'), action: () => deleteWorkspaceEntry(entry.path) }
      ]);
    });
    tree.appendChild(row);
  }
}

async function loadTree(path = '.') {
  if (!state.sessionId) {
    state.treeEntries = [];
    renderTreeEntries();
    return;
  }
  const requestedSession = state.sessionId;
  try {
    const data = await api(`/api/tree?path=${encodeURIComponent(path)}${sessionQuery()}`);
    if (requestedSession !== state.sessionId) return;
    state.treePath = path;
    state.treeEntries = data.entries || [];
    renderTreeEntries();
  } catch (error) {
    state.treeEntries = [];
    renderTreeEntries();
    console.warn(error.message);
  }
}

async function openFile(path) {
  try {
    if (/\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(path)) {
      state.openFile = path;
      state.editing = false;
      $('viewerPath').textContent = path;
      if ($('viewerMeta')) $('viewerMeta').textContent = t('viewer.imagePreview');
      $('viewerCode').innerHTML = `<img class="viewer-image" src="/api/raw?path=${encodeURIComponent(path)}${sessionQuery()}" alt="">`;
      $('viewerEditor').hidden = true;
      $('viewerCode').hidden = false;
      $('saveFile').hidden = true;
      $('toggleEdit').hidden = true;
      setDocActions(path, false);
      switchPane('viewer');
      saveSessionState();
      return;
    }
    if (/\.(docx|xlsx|pptx|doc|xls|ppt|pdf)$/i.test(path)) {
      state.openFile = path;
      state.editing = false;
      $('viewerPath').textContent = path;
      $('viewerMeta').textContent = '正在加载原文档…';
      $('viewerCode').innerHTML = `<div class="viewer-loading"><span class="spinner"></span>${t('viewer.loading')}</div>`;
      $('viewerEditor').hidden = true;
      $('viewerCode').hidden = false;
      $('saveFile').hidden = true;
      $('toggleEdit').hidden = true;
      setDocActions(path, true);
      switchPane('viewer');
      $('viewerCode').innerHTML = `<iframe class="viewer-doc" src="/api/render?path=${encodeURIComponent(path)}${sessionQuery()}"></iframe>`;
      saveSessionState();
      return;
    }
    if (/\.(html?|pdf)$/i.test(path)) {
      state.openFile = path;
      state.editing = false;
      $('viewerPath').textContent = path;
      $('viewerMeta').textContent = t('viewer.browserPreview');
      $('viewerCode').innerHTML = `<iframe class="viewer-doc" src="/api/raw?path=${encodeURIComponent(path)}${sessionQuery()}"></iframe>`;
      $('viewerEditor').hidden = true;
      $('viewerCode').hidden = false;
      $('saveFile').hidden = true;
      $('toggleEdit').hidden = true;
      setDocActions(path, true);
      switchPane('viewer');
      saveSessionState();
      return;
    }
    if (/\.(mp4|webm|mov|mkv|mp3|wav|ogg|m4a)$/i.test(path)) {
      state.openFile = path;
      state.editing = false;
      $('viewerPath').textContent = path;
      $('viewerMeta').textContent = t('viewer.mediaPreview');
      const video = /\.(mp4|webm|mov|mkv)$/i.test(path);
      $('viewerCode').innerHTML = video
        ? `<video class="viewer-doc" controls src="/api/raw?path=${encodeURIComponent(path)}${sessionQuery()}"></video>`
        : `<audio controls style="width:100%;margin:20px" src="/api/raw?path=${encodeURIComponent(path)}${sessionQuery()}"></audio>`;
      $('viewerEditor').hidden = true;
      $('viewerCode').hidden = false;
      $('saveFile').hidden = true;
      $('toggleEdit').hidden = true;
      setDocActions(path, true);
      switchPane('viewer');
      saveSessionState();
      return;
    }
    if (/\.(zip|7z|rar|exe|dll|bin|mp3|wav|mp4|mov|avi|mkv)$/i.test(path)) {
      state.openFile = path;
      state.editing = false;
      $('viewerPath').textContent = path;
      if ($('viewerMeta')) $('viewerMeta').textContent = '二进制 / 文档文件';
      $('viewerCode').innerHTML = `<div class="viewer-binary"><div class="viewer-binary-icon">▣</div><p>这是文档或二进制文件，不能当文本直接打开。</p><p class="muted">${escapeHtml(path)}</p><button type="button" id="openExternalFile" class="primary-btn">用默认程序打开</button></div>`;
      $('viewerCode').hidden = false;
      $('viewerEditor').hidden = true;
      $('saveFile').hidden = true;
      $('toggleEdit').hidden = true;
      $('openExternalFile').onclick = () => openExternalFile(path);
      saveSessionState();
      return;
    }
    const data = await api(`/api/file?path=${encodeURIComponent(path)}${sessionQuery()}`);
    state.openFile = path;
    state.editing = false;
    $('viewerPath').textContent = path;
    if ($('viewerMeta')) $('viewerMeta').textContent = `${data.size} B · ${data.content.split('\n').length} 行`;
    const lines = data.content.split('\n');
    const limit = Math.min(lines.length, 4000);
    let html = '';
    for (let index = 0; index < limit; index += 1) {
      html += `<span class="ln">${index + 1}</span>${escapeHtml(lines[index])}\n`;
    }
    $('viewerCode').innerHTML = html;
    $('viewerEditor').hidden = true;
    $('viewerCode').hidden = false;
    $('saveFile').hidden = true;
    $('toggleEdit').textContent = '✎';
    $('toggleEdit').hidden = false;
    setDocActions(path, false);
    switchPane('viewer');
    saveSessionState();
  } catch (error) { toast(error.message); }
}

function setDocActions(path, visible) {
  for (const id of ['viewerOpen', 'viewerDownload', 'viewerForward', 'viewerEdit']) $(id).hidden = !visible;
  if (visible) {
    $('viewerOpen').onclick = () => openExternalFile(path);
    $('viewerDownload').onclick = () => {
      const a = document.createElement('a');
      a.href = `/api/raw?path=${encodeURIComponent(path)}&download=1${sessionQuery()}`;
      a.download = path.split('/').pop();
      a.click();
    };
    $('viewerForward').onclick = async () => {
      await copyText(path);
      toast('路径已复制，可以发给同事');
    };
    $('viewerEdit').onclick = async () => {
      await openExternalFile(path);
      toast('已用本机 Office 打开，保存后预览会自动刷新');
      let last = 0;
      for (let i = 0; i < 60; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        try {
          const info = await api(`/api/file-stat?path=${encodeURIComponent(path)}${sessionQuery()}`);
          if (last && info.mtime !== last) { await openFile(path); break; }
          last = info.mtime;
        } catch { break; }
      }
    };
  }
}

async function openExternalFile(path) {
  try {
    await api('/api/open', { method: 'POST', body: JSON.stringify({ path, session: state.sessionId }) });
  } catch (error) { toast(error.message); }
}

function toggleEdit() {
  if (!state.openFile) return;
  state.editing = !state.editing;
  if (state.editing) {
    $('viewerEditor').value = $('viewerCode').textContent.replace(/^\s*\d+\s/gm, '');
    $('viewerEditor').hidden = false;
    $('viewerCode').hidden = true;
    $('saveFile').hidden = false;
    $('viewerEditor').focus();
  } else {
    $('viewerEditor').hidden = true;
    $('viewerCode').hidden = false;
    $('saveFile').hidden = true;
  }
}

async function saveFile() {
  if (!state.openFile) return;
  await api('/api/file', { method: 'POST', body: JSON.stringify({ path: state.openFile, content: $('viewerEditor').value }) });
  toast(t('common.saved'));
  state.editing = true;
  toggleEdit();
  await openFile(state.openFile);
  loadTree();
}

/* -------------------------------------------------------------- settings */


function renderLocalModel() {
  const block = $('localModelBlock');
  const local = state.app?.localModel;
  const admin = state.app?.role === 'admin' || state.profile?.role === 'admin';
  if (!block) return;
  block.hidden = !admin;
  if (!admin) return;
  const toggle = $('localModelToggle');
  toggle.checked = Boolean(local?.enabled);
  const status = $('localModelStatus');
  if (!local) { status.textContent = '未检测到本地模型'; return; }
  if (!local.available) status.textContent = `本地推理未启动 · ${local.label || local.name}`;
  else status.textContent = `${local.enabled ? '已启用' : '可用'} · ${local.label || local.name} · ${local.url}`;
}


function renderProviders() {
  const box = $('providerList');
  if (!box) return;
  const list = state.config?.providers || [];
  const active = state.config?.activeProviderId || '';
  box.textContent = '';
  const count = document.createElement('p');
  count.className = 'providers-hint providers-count';
  count.textContent = `已保存 ${list.length} / 5 个 API · 模型 ${state.models?.length || 0} 个`;
  box.appendChild(count);
  if (!list.length) {
    const empty = document.createElement('p');
    empty.className = 'providers-hint';
    empty.textContent = t('providers.empty');
    box.appendChild(empty);
    return;
  }
  for (const provider of list) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'provider-row' + (provider.id === active ? ' active' : '');
    const dot = document.createElement('span');
    dot.className = 'provider-dot';
    const meta = document.createElement('div');
    meta.className = 'provider-meta';
    const title = document.createElement('strong');
    title.textContent = provider.name || provider.model;
    const small = document.createElement('small');
    small.textContent = `${provider.model || ''} · ${provider.baseUrl || ''}`;
    meta.append(title, small);
    const badge = document.createElement('span');
    badge.className = 'provider-badge';
    badge.textContent = provider.id === active ? t('providers.active') : '';
    row.append(dot, meta, badge);
    row.addEventListener('click', async () => {
      await api('/api/providers/active', { method: 'POST', body: JSON.stringify({ id: provider.id }) });
      await refreshState();
      renderProviders();
      toast(t('providers.switched'));
    });
    row.addEventListener('contextmenu', async (event) => {
      event.preventDefault();
      await api(`/api/providers?id=${encodeURIComponent(provider.id)}`, { method: 'DELETE' });
      await refreshState();
      renderProviders();
      toast(t('providers.deleted'));
    });
    box.appendChild(row);
  }
}

function markPlanCards() {
  const plan = state.config?.plan || state.app?.plan || 'free';
  document.querySelectorAll('.plan-card[data-plan]').forEach((card) => {
    card.classList.toggle('selected', card.dataset.plan === plan);
  });
  if ($('currentPlanName')) $('currentPlanName').textContent = ({ free: '免费版', pro: 'Pro 版', max: 'Max 版' })[plan] || '免费版';
}

async function saveCurrentProvider() {
  const baseUrl = $('setBaseUrl').value.trim();
  const apiKey = $('setApiKey').value.trim();
  const model = $('setModel').value.trim();
  if (!baseUrl || !apiKey || !model) { toast(t('settings.error')); return; }
  await api('/api/config', { method: 'POST', body: JSON.stringify({ baseUrl, apiKey, model, protocol: $('setProtocol').value, thinkingLevel: $('setThinkingLevel').value }) });
  await api('/api/providers', { method: 'POST', body: JSON.stringify({ name: model }) });
  await refreshState();
  renderProviders();
  toast(t('providers.saved'));
}

function openSettings(tab = 'appearance') {
  if (!state.app?.authenticated) { openLogin(); return; }
  $('setBaseUrl').value = state.config?.baseUrl || '';
  $('setApiKey').value = '';
  $('setModel').value = state.config?.model || '';
  if ($('setProtocol')) $('setProtocol').value = state.config?.protocol || 'openai';
  if ($('setThinkingLevel')) $('setThinkingLevel').value = state.config?.thinkingLevel || 'medium';
  if ($('aboutVersion')) $('aboutVersion').textContent = state.app?.version || '—';
  markPlanCards();
  const planName = { free: '免费版', pro: 'Pro 版', max: 'Max 版' }[state.app?.plan || 'free'] || '免费版';
  if ($('currentPlanName')) $('currentPlanName').textContent = planName;
  if ($('aboutVersion')) $('aboutVersion').textContent = state.app?.version || '—';
  $('setTemp').value = state.config?.temperature ?? 0.7;
  $('setMaxTokens').max = String(state.app?.planLimits?.context || 1000000);
  $('setMaxTokens').value = state.config?.maxTokens ?? 1000000;
  $('setCompressAfter').value = state.config?.compressAfterTokens ?? 100000000;
  if ($('setVisionUrl')) {
    $('setVisionUrl').value = state.config?.vision?.baseUrl || '';
    $('setVisionModel').value = state.config?.vision?.model || '';
    $('setTranscribeUrl').value = state.config?.transcribe?.baseUrl || '';
    $('setTranscribeModel').value = state.config?.transcribe?.model || '';
  }
  $('setWorkspace').value = state.config?.workspace || '';
  $('settingsError').hidden = true;
  renderLocalModel();
  renderProviders();
  const lang = $('languageSelect');
  lang.textContent = '';
  for (const [code, label] of LANGUAGES) {
    const option = document.createElement('option');
    option.value = code;
    option.textContent = label;
    if (code === getLanguage()) option.selected = true;
    lang.appendChild(option);
  }
  selectSettingsTab(tab);
  openPage('settings');
}

function selectSettingsTab(tab) {
  document.querySelectorAll('.settings-nav button').forEach((button) => {
    button.classList.toggle('active', button.dataset.tab === tab);
  });
  document.querySelectorAll('.settings-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.dataset.panel === tab);
  });
}

async function saveSettings(event) {
  event.preventDefault();
  const body = {
    baseUrl: $('setBaseUrl').value.trim(),
    model: $('setModel').value.trim(),
    temperature: Number($('setTemp').value),
    maxTokens: Number($('setMaxTokens').value),
    compressAfterTokens: Number($('setCompressAfter').value) || 100000000,
    vision: {
      baseUrl: $('setVisionUrl').value.trim(),
      model: $('setVisionModel').value.trim(),
      apiKey: $('setVisionKey').value.trim()
    },
    transcribe: {
      baseUrl: $('setTranscribeUrl').value.trim(),
      model: $('setTranscribeModel').value.trim(),
      apiKey: $('setTranscribeKey').value.trim()
    },
    workspace: $('setWorkspace').value.trim()
  };
  const key = $('setApiKey').value.trim();
  if (key) body.apiKey = key;
  try {
    const { config } = await api('/api/config', { method: 'POST', body: JSON.stringify(body) });
    state.config = config;
    applyConfig(config);
    $('settings').close();
    toast(t('settings.saved'));
    loadTree();
  } catch (error) {
    $('settingsError').textContent = error.message;
    $('settingsError').hidden = false;
  }
}



async function fetchModels() {
  try {
    const { models } = await api('/api/models', {
      method: 'POST',
      body: JSON.stringify({ baseUrl: $('setBaseUrl').value.trim(), apiKey: $('setApiKey').value.trim() })
    });
    state.models = models;
    const list = $('modelOptions');
    list.textContent = '';
    for (const model of models) {
      const option = document.createElement('option');
      option.value = model;
      list.appendChild(option);
    }
    if (!$('setModel').value && models.length) $('setModel').value = models[0];
    toast(`${models.length}`);
  } catch (error) { toast(error.message); }
}

async function changePassword() {
  const errorNode = $('securityError');
  try {
    await api('/api/account/password', {
      method: 'POST',
      body: JSON.stringify({ current: $('pwCurrent').value, next: $('pwNext').value })
    });
    $('pwCurrent').value = '';
    $('pwNext').value = '';
    errorNode.hidden = true;
    toast(t('security.changed'));
  } catch (error) {
    errorNode.textContent = error.message;
    errorNode.hidden = false;
  }
}



function versionParts(value) {
  return String(value || '0').split('.').map((part) => Number(part) || 0);
}

function compareVersion(a, b) {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] || 0) - (right[index] || 0);
    if (diff) return diff;
  }
  return 0;
}

async function loadUpdates() {
  try {
    const data = await api('/api/updates');
    state.updates = data;
    const newer = compareVersion(data.latest, data.current) > 0;
    const dismissed = localStorage.getItem('nalo.updateDismissed') === data.latest;
    $('railUpdate').classList.toggle('has-update', newer && !dismissed);
    renderUpdateNotes();
  } catch { /* ignore */ }
}

function renderUpdateNotes() {
  const data = state.updates;
  if (!data) return;
  const box = $('updateNotes');
  box.textContent = '';
  for (const release of data.notes || []) {
    const version = document.createElement('div');
    version.className = 'update-version';
    version.textContent = `v${release.version} · ${release.date || ''}`;
    box.appendChild(version);
    for (const item of release.items || []) {
      const row = document.createElement('div');
      row.className = 'update-item';
      row.textContent = item;
      box.appendChild(row);
    }
  }
  $('updateCurrent').textContent = data.current;
  const newer = compareVersion(data.latest, data.current) > 0;
  $('updateLatest').textContent = newer ? `最新版本 v${data.latest}` : '已是最新版本';
  const button = $('updateDownload');
  const target = data.download || data.site || '';
  button.hidden = !newer || !target;
  button.textContent = data.download ? t('update.download') : '打开官网';
  button.onclick = () => {
    if (!target) return;
    localStorage.setItem('nalo.updateDismissed', data.latest);
    $('railUpdate').classList.remove('has-update');
    startInAppUpdate().catch((error) => {
      if (!$('updateProgress').open) $('updateProgress').showModal();
      updateFail(error.message);
    });
  };
  if (newer && !target) {
    $('updateLatest').textContent = `最新 v${data.latest} · 请在设置里配置更新地址，或到官网下载`;
  }
}



let licenseCaptchaId = '';

async function loadLicenseCaptcha() {
  const data = await api('/api/license/captcha');
  licenseCaptchaId = data.id;
  $('licenseCaptchaQ').textContent = data.question;
}

async function sendLicenseSms() {
  const phone = $('licensePhone').value.trim();
  const answer = $('licenseCaptchaA').value.trim();
  if (!/^1\d{10}$/.test(phone)) { $('licenseMsg').textContent = '请输入 11 位手机号'; return; }
  if (!answer) { $('licenseMsg').textContent = '请先完成人机验证'; return; }
  const button = $('licenseSendSms');
  button.disabled = true;
  try {
    const data = await api('/api/license/sms', { method: 'POST', body: JSON.stringify({ phone, captchaId: licenseCaptchaId, captchaAnswer: answer }) });
    $('licenseMsg').textContent = data.devCode ? `测试验证码：${data.devCode}` : t('license.codeSent');
    let left = 60;
    const timer = setInterval(() => {
      left -= 1;
      button.textContent = left > 0 ? `${left}s` : t('license.sendSms');
      if (left <= 0) { clearInterval(timer); button.disabled = false; }
    }, 1000);
  } catch (error) {
    $('licenseMsg').textContent = error.message;
    button.disabled = false;
    loadLicenseCaptcha().catch(() => {});
  }
}

async function registerLicense(event) {
  if (event) event.preventDefault();
  const phone = $('licensePhone').value.trim();
  const code = $('licenseSmsCode').value.trim();
  if (!/^1\d{10}$/.test(phone)) { $('licenseMsg').textContent = '请输入 11 位手机号'; return; }
  if (!code) { $('licenseMsg').textContent = '请输入短信验证码'; return; }
  const button = $('licenseRegisterBtn');
  button.disabled = true;
  $('licenseMsg').textContent = '正在注册…';
  try {
    const info = await api('/api/license/register', { method: 'POST', body: JSON.stringify({ phone, code }) });
    if (info.licensed) {
      $('licenseGate').hidden = true;
      toast(t('license.success'));
      await refreshState();
    } else {
      $('licenseMsg').textContent = info.reason || t('license.failed');
    }
  } catch (error) {
    $('licenseMsg').textContent = error.message;
  } finally {
    button.disabled = false;
  }
}


let updatePollTimer = null;

function updateManualLink() {
  const target = state.updates?.download || state.updates?.site || '';
  $('updateRetry').hidden = false;
}

function updateFail(message) {
  clearTimeout(updatePollTimer);
  $('updateProgressText').textContent = message || '更新失败';
  $('updateProgressBar').style.width = '0%';
  $('updateProgressPercent').textContent = '0%';
  $('updateProgressClose').hidden = false;
  $('updateRetry').hidden = false;
}

function pollUpdate() {
  clearTimeout(updatePollTimer);
  updatePollTimer = setTimeout(async () => {
    try {
      const s = await api('/api/update/status');
      const percent = Math.max(0, Math.min(100, Number(s.percent) || 0));
      $('updateProgressBar').style.width = `${percent}%`;
      $('updateProgressPercent').textContent = `${percent}%`;
      if (s.total) {
        $('updateProgressSize').textContent = `${(s.received / 1048576).toFixed(1)} / ${(s.total / 1048576).toFixed(1)} MB`;
      } else if (s.received) {
        $('updateProgressSize').textContent = `${(s.received / 1048576).toFixed(1)} MB`;
      }
      if (s.status === 'downloading') {
        $('updateProgressText').textContent = '正在下载更新，请保持窗口打开…';
        pollUpdate();
      } else if (s.status === 'ready') {
        $('updateProgressText').textContent = '正在安装，应用会自动重启…';
        $('updateProgressBar').style.width = '100%';
        $('updateProgressPercent').textContent = '100%';
        await api('/api/update/install', { method: 'POST', body: '{}' });
      } else if (s.status === 'error') {
        updateFail(s.error || '下载失败');
      } else {
        pollUpdate();
      }
    } catch (error) {
      updateFail(error.message);
    }
  }, 350);
}

async function startInAppUpdate() {
  const dialog = $('updateProgress');
  if (!dialog.open) dialog.showModal();
  $('updateProgressBar').style.width = '0%';
  $('updateProgressPercent').textContent = '0%';
  $('updateProgressSize').textContent = '';
  $('updateProgressText').textContent = '正在连接更新服务器…';
  $('updateRetry').hidden = true;
  $('updateProgressClose').hidden = true;
  try {
    await api('/api/update/start', { method: 'POST', body: '{}' });
    pollUpdate();
  } catch (error) {
    updateFail(error.message);
  }
}

async function checkLicense() {
  try {
    let info = await api('/api/license');
    if (info.required && !info.licensed && info.autoActivate) {
      try {
        info = await api('/api/license/auto', { method: 'POST', body: '{}' });
        if (info.licensed) toast(t('license.autoSuccess') || '已自动激活');
      } catch { /* fall back to manual activation */ }
    }
    state.license = info;
    const gate = $('licenseGate');
    const blocked = info.required && !info.licensed;
    gate.hidden = !blocked;
    if (blocked) {
      $('licenseMsg').textContent = info.reason || '';
      $('licenseDevice').textContent = `设备 ${String(info.device || '').slice(0, 10)}…`;
      const maintenance = Boolean(info.maintenance);
      $('licenseGate').classList.toggle('maintenance-mode', maintenance);
      $('licenseMaintenance').hidden = !maintenance;
      if (maintenance) $('licenseMsg').textContent = '';
      $('licenseRegisterForm').hidden = maintenance || !info.phoneRegister;
      $('licenseManual').hidden = maintenance || Boolean(info.phoneRegister);
      $('licenseToggleManual').hidden = maintenance || !info.phoneRegister;
      if (maintenance) $('licenseAdminForm').hidden = true;
      else if (info.phoneRegister) loadLicenseCaptcha().catch(() => {});
    }
    return info;
  } catch {
    return null;
  }
}

async function activateLicense() {
  const key = $('licenseKey').value.trim();
  if (!key) return;
  const button = $('licenseActivate');
  button.disabled = true;
  $('licenseMsg').textContent = '正在验证…';
  try {
    const info = await api('/api/license/activate', { method: 'POST', body: JSON.stringify({ key }) });
    if (info.licensed) {
      $('licenseGate').hidden = true;
      toast(t('license.success'));
      await refreshState();
    } else {
      $('licenseMsg').textContent = info.reason || t('license.failed');
    }
  } catch (error) {
    $('licenseMsg').textContent = error.message || t('license.failed');
  } finally {
    button.disabled = false;
  }
}

function openPage(id) {
  const dialog = $(id);
  if (!dialog || dialog.open) return;
  if (id === 'updates') { renderUpdateNotes(); loadUpdates(); }
  dialog.showModal();
  const fields = [...dialog.querySelectorAll('input:not([type=hidden]):not([readonly]), select, textarea')];
  const target = fields.find((field) => field.offsetParent !== null);
  if (target) {
    setTimeout(() => target.focus(), 40);
  } else {
    dialog.tabIndex = -1;
    dialog.focus();
  }
}

function closePages() {
  document.querySelectorAll('dialog[open]').forEach((dialog) => dialog.close());
}

/* --------------------------------------------------------------- account */

function renderAccount() {
  const profile = state.profile;
  const authed = Boolean(state.app?.authenticated);
  $('settingsLogout').hidden = !authed;
  const hasAvatar = authed && Boolean(profile?.avatar);
  const avatar = $('settingsAvatarImg');
  avatar.hidden = !hasAvatar;
  $('settingsAvatarText').hidden = hasAvatar;
  if (hasAvatar) avatar.src = profile.avatar;
  $('settingsAvatarText').textContent = authed
    ? (profile?.nickname || profile?.username || '?').slice(0, 1).toUpperCase()
    : '?';
  const railAvatar = $('railAvatar');
  const railIcon = $('railUserIcon');
  const railInitial = $('railInitial');
  railAvatar.hidden = !hasAvatar;
  railIcon.style.display = (hasAvatar || authed) ? 'none' : '';
  railInitial.hidden = !authed || hasAvatar;
  if (hasAvatar) railAvatar.src = profile.avatar;
  if (authed) railInitial.textContent = (profile?.nickname || profile?.username || '?').slice(0, 1).toUpperCase();
  const railLabel = authed ? (profile?.nickname || profile?.username || '') : t('common.notLoggedIn');
  $('railProfile').dataset.tip = railLabel;
  $('railProfile').setAttribute('aria-label', railLabel);

  $('accountName').textContent = authed ? (profile?.nickname || profile?.username || '') : t('common.notLoggedIn');
  const meta = [];
  if (authed) {
    if (profile?.username) meta.push(profile.username);
    if (profile?.role === 'admin') meta.push(t('profile.admin'));
    if (profile?.age != null) meta.push(String(profile.age));
  }
  $('accountMeta').textContent = meta.length ? meta.join(' · ') : t('rail.login');
  $('accountName').textContent = authed ? (profile?.nickname || profile?.username || '') : t('common.notLoggedIn');
  const planLabels = { free: '免费版', pro: 'Pro 版', max: 'Max 版' };
  $('accountMeta').textContent = authed
    ? [profile?.email, planLabels[profile?.plan || state.app?.plan] || '免费版', profile?.role === 'admin' ? '管理员' : ''].filter(Boolean).join(' · ')
    : t('rail.login');
  $('railAdmin').hidden = !authed || profile?.role !== 'admin';
  $('changeEmailBtn').hidden = !authed;
  $('deleteAccountBtn').hidden = !authed;
}

async function openProfile() {
  if (!state.app?.authenticated) { openLogin(); return; }
  await loadProfile();
  openPage('profile');
}

async function loadProfile() {
  const data = await api('/api/profile');
  state.profile = data.profile;
  state.usage = data.usage;
  $('profileNickname').value = data.profile.nickname || '';
  $('profileBirth').value = data.profile.birthDate || '';
  $('profileAge').value = data.profile.age ?? '';
  $('profileGender').value = data.profile.gender || 'private';
  const avatar = $('profileAvatar');
  if (data.profile.avatar) { avatar.src = data.profile.avatar; avatar.hidden = false; $('profileInitial').hidden = true; }
  else { avatar.hidden = true; $('profileInitial').hidden = false; $('profileInitial').textContent = (data.profile.nickname || data.profile.username || '?').slice(0, 1).toUpperCase(); }
  const usage = data.usage || {};
  const total = (usage.promptTokens || 0) + (usage.completionTokens || 0);
  $('usageInput').textContent = formatNumber(usage.promptTokens);
  $('usageOutput').textContent = formatNumber(usage.completionTokens);
  $('usageTotal').textContent = formatNumber(total);
  renderAccount();
}

async function saveProfile(event) {
  event.preventDefault();
  try {
    const body = {
      nickname: $('profileNickname').value,
      birthDate: $('profileBirth').value,
      gender: $('profileGender').value
    };
    const avatar = $('profileAvatar').dataset.dirty ? $('profileAvatar').src : undefined;
    if (avatar) body.avatar = avatar;
    const { profile } = await api('/api/profile', { method: 'POST', body: JSON.stringify(body) });
    state.profile = profile;
    delete $('profileAvatar').dataset.dirty;
    $('profileAge').value = profile.age ?? '';
    $('profile').close();
    toast(t('common.saved'));
    renderAccount();
  } catch (error) { toast(error.message); }
}

function pickAvatar() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/png,image/jpeg,image/webp';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    const dataUrl = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsDataURL(file);
    });
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      const size = 128;
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext('2d');
      const scale = Math.max(size / image.width, size / image.height);
      const width = image.width * scale;
      const height = image.height * scale;
      context.drawImage(image, (size - width) / 2, (size - height) / 2, width, height);
      const avatar = $('profileAvatar');
      avatar.src = canvas.toDataURL('image/webp', 0.85);
      avatar.dataset.dirty = '1';
      avatar.hidden = false;
      $('profileInitial').hidden = true;
    };
    image.src = dataUrl;
  };
  input.click();
}

function showMaintenance(data = {}) {
  if (state.maintenanceShown) return;
  state.maintenanceShown = true;
  const message = String(data.message || data.error || t('maintenance.default'));
  state.maintenance = { enabled: true, message };
  $('maintenanceMessage').textContent = message;
  $('maintenanceOverlay').hidden = false;
  $('login').close();
}

function hideMaintenance() {
  $('maintenanceOverlay').hidden = true;
}

async function loadMaintenance() {
  try {
    const data = await api('/api/maintenance');
    state.maintenance = data;
    if (data.enabled && state.app?.role !== 'admin' && state.profile?.role !== 'admin') showMaintenance(data);
  } catch { }
}

async function saveMaintenance(enabled) {
  const message = $('maintenanceMessageInput').value.trim() || t('maintenance.default');
  const { maintenance } = await api('/api/admin/maintenance', { method: 'POST', body: JSON.stringify({ enabled, message }) });
  state.maintenance = maintenance;
  if (!maintenance.enabled) { state.maintenanceShown = false; hideMaintenance(); }
  renderMaintenanceAdmin();
  if (enabled) toast(t('maintenance.enabled')); else toast(t('maintenance.disabled'));
}

function renderMaintenanceAdmin() {
  if (!$('maintenanceToggle')) return;
  const active = Boolean(state.maintenance?.enabled);
  $('maintenanceStatus').textContent = active ? t('maintenance.active') : t('maintenance.inactive');
  $('maintenanceToggle').textContent = active ? t('maintenance.cancel') : t('maintenance.activate');
  if (document.activeElement !== $('maintenanceMessageInput')) $('maintenanceMessageInput').value = state.maintenance?.message || '';
}

function openLogin() {
  state.authMode = state.app?.hasAccount ? 'login' : 'register';
  state.authAdmin = false;
  state.loginMode = 'password';
  $('loginError').hidden = true;
  renderLogin();
  openPage('login');
}

async function loadGateCaptcha() {
  const data = await api('/api/captcha');
  state.gateCaptchaId = data.id;
  $('gateCaptchaImage').src = data.image;
  $('gateCaptchaInput').value = '';
}

function openCaptchaGate(email, mode = 'register') {
  state.pendingCodeEmail = email;
  state.pendingCodeMode = mode;
  $('gateCaptchaError').hidden = true;
  $('captchaGate').showModal();
  loadGateCaptcha().catch((error) => {
    $('gateCaptchaError').textContent = error.message;
    $('gateCaptchaError').hidden = false;
  });
}

async function confirmCaptchaGate() {
  const answer = $('gateCaptchaInput').value.trim();
  const errorNode = $('gateCaptchaError');
  if (!answer) { errorNode.textContent = '请输入图中的字符'; errorNode.hidden = false; return; }
  const button = $('gateCaptchaConfirm');
  button.disabled = true;
  try {
    await api('/api/email/code', { method: 'POST', body: JSON.stringify({ email: state.pendingCodeEmail, captchaId: state.gateCaptchaId, captchaAnswer: answer }) });
    $('captchaGate').close();
    toast('验证码已发送');
    const send = state.pendingCodeMode === 'reset' ? $('resetSendCode') : state.pendingCodeMode === 'delete' ? $('deleteSendCode') : state.pendingCodeMode === 'login' ? $('loginSendCode') : $('regSendCode');
    send.disabled = true;
    let left = 60;
    const timer = setInterval(() => {
      left -= 1;
      send.textContent = left > 0 ? `${left}s` : '获取验证码';
      if (left <= 0) { clearInterval(timer); send.disabled = false; }
    }, 1000);
  } catch (error) {
    errorNode.textContent = error.message;
    errorNode.hidden = false;
    loadGateCaptcha().catch(() => {});
  } finally {
    button.disabled = false;
  }
}

function renderLogin() {
  const register = state.authMode === 'register';
  $('loginTitle').textContent = register ? '注册' : '登录';
  $('loginSubmit').textContent = register ? '注册并登录' : '登录';
  $('loginPane').hidden = register;
  $('registerPane').hidden = !register;
  $('rememberRow').hidden = register;
  $('feedbackLink').hidden = !register;
  const passwordMode = state.loginMode !== 'code';
  $('passwordModeBox').hidden = !passwordMode;
  $('codeModeBox').hidden = passwordMode;
  $('forgotPassword').hidden = register;
  document.querySelectorAll('#authTabs button').forEach((button) => {
    button.classList.toggle('active', button.dataset.auth === state.authMode);
  });
}

async function sendRegCode() {
  const email = $('regEmail').value.trim();
  const errorNode = $('loginError');
  if (!email) { errorNode.textContent = '请输入邮箱'; errorNode.hidden = false; return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { errorNode.textContent = '邮箱格式不正确'; errorNode.hidden = false; return; }
  openCaptchaGate(email);
}

function sendLoginCode() {
  const email = $('loginEmail').value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    $('loginError').textContent = '请输入正确的邮箱';
    $('loginError').hidden = false;
    return;
  }
  openCaptchaGate(email, 'login');
}

async function submitLogin(event) {
  event.preventDefault();
  const errorNode = $('loginError');
  try {
    if (state.authMode === 'register') {
      const username = $('regUser').value.trim();
      const email = $('regEmail').value.trim();
      const code = $('regCode').value.trim();
      const password = $('regPass').value;
      if (!username || username.length < 2) throw new Error('用户名至少 2 个字符');
      if (!email) throw new Error('请输入邮箱');
      if (!code) throw new Error('请输入邮箱验证码');
      if (!password || password.length < 6) throw new Error('密码至少 6 位');
      if (password !== $('regConfirm').value) throw new Error('两次密码不一致');
      const data = await api('/api/account/register', { method: 'POST', body: JSON.stringify({ username, email, password, code }) });
      syncCloudUser({ username, email, role: 'user', plan: 'free', createdAt: Date.now() });
      state.authMode = 'login';
      renderLogin();
      $('loginEmail').value = email;
      $('loginPass').value = '';
      $('loginCode').value = '';
      $('loginError').textContent = '注册成功，请使用新账号登录';
      $('loginError').hidden = false;
      return;
    } else {
      const email = $('loginEmail').value.trim();
      if (!email) throw new Error('请输入邮箱');
      if (state.loginMode === 'code') {
        const code = $('loginCode').value.trim();
        if (!code) throw new Error('请输入邮箱验证码');
        await api('/api/login/email-code', { method: 'POST', body: JSON.stringify({ email, code, remember: $('loginRemember').checked }) });
      } else {
        const password = $('loginPass').value;
        if (!password) throw new Error('请输入密码');
        await api('/api/login', { method: 'POST', body: JSON.stringify({ email, password, remember: $('loginRemember').checked }) });
      }
    }
    $('login').close();
    hideMaintenance();
    state.maintenanceShown = false;
    await refreshState();
    startAutomationSessionPolling();
    syncCloudUser();
    toast('登录成功');
  } catch (error) {
    if (error.data?.maintenance) showMaintenance(error.data);
    errorNode.textContent = error.message;
    errorNode.hidden = false;
    if (String(error.message || '').includes('已被封禁')) showBanNotice(error.message);
  }
}

function postNative(message) {
  try { window.chrome?.webview?.postMessage(message); } catch { }
}

function setMaximizedIcon(maximized) {
  const button = $('winMax');
  if (!button) return;
  button.title = maximized ? '还原' : '最大化';
  button.innerHTML = maximized
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="1"/><path d="M5 16V6a1 1 0 0 1 1-1h10"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="1"/></svg>';
}

function applyHistoryCollapsed() {
  const collapsed = localStorage.getItem('nalo-history-collapsed') === '1';
  $('app').classList.toggle('history-closed', collapsed);
  $('toggleHistory').setAttribute('aria-pressed', String(!collapsed));
}

function toggleHistory() {
  const collapsed = !$('app').classList.contains('history-closed');
  localStorage.setItem('nalo-history-collapsed', collapsed ? '1' : '0');
  applyHistoryCollapsed();
}

async function loadAnnouncements() {
  if (!state.app?.authenticated) return;
  try {
    const data = await api('/api/announcements');
    state.announcements = data.announcements || [];
    const latest = state.announcements[0]?.createdAt || 0;
    const readAt = Number(localStorage.getItem('nalo-announce-read') || 0);
    $('announceDot').hidden = !latest || latest <= readAt;
  } catch { /* ignore */ }
}

function renderAnnouncements() {
  const box = $('announceList');
  box.textContent = '';
  const list = state.announcements || [];
  if (!list.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = t('announce.empty');
    box.appendChild(empty);
    return;
  }
  for (const item of list) {
    const card = document.createElement('div');
    card.className = 'announce-card';
    const title = document.createElement('strong');
    title.textContent = item.title;
    const meta = document.createElement('small');
    meta.textContent = new Date(item.createdAt).toLocaleString();
    const body = document.createElement('p');
    body.textContent = item.content;
    card.append(title, meta, body);
    if (state.profile?.role === 'admin') {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'announce-delete';
      del.textContent = t('common.delete');
      del.onclick = async () => {
        if (!(await askConfirm(t('announce.deleteConfirm'), t('announce.deleteTitle')))) return;
        try {
          await api(`/api/admin/announcements?id=${encodeURIComponent(item.id)}`, { method: 'DELETE' });
          await loadAnnouncements();
          renderAnnouncements();
          toast(t('announce.deleted'));
        } catch (error) { toast(error.message); }
      };
      card.appendChild(del);
    }
    box.appendChild(card);
  }
}

async function openAnnouncements() {
  await loadAnnouncements();
  renderAnnouncements();
  $('announceNew').hidden = state.profile?.role !== 'admin';
  $('announcements').showModal();
  localStorage.setItem('nalo-announce-read', String(Date.now()));
  $('announceDot').hidden = true;
}

function openAnnounceEditor() {
  $('announceTitle').value = '';
  $('announceContent').value = '';
  $('announceError').hidden = true;
  $('announceEditor').showModal();
}

async function publishAnnouncement() {
  try {
    const title = $('announceTitle').value.trim();
    const content = $('announceContent').value.trim();
    if (!title || !content) throw new Error('请填写标题和内容');
    await api('/api/admin/announcements', { method: 'POST', body: JSON.stringify({ title, content }) });
    $('announceEditor').close();
    await loadAnnouncements();
    renderAnnouncements();
    toast(t('announce.published'));
  } catch (error) {
    $('announceError').textContent = error.message;
    $('announceError').hidden = false;
  }
}

function showBanNotice(message) {
  $('banNoticeText').textContent = message || '';
  if (!$('banNotice').open) $('banNotice').showModal();
}

function openDeleteConfirm() {
  $('deleteAccountConfirm').showModal();
}

function startDeleteAccount() {
  $('deleteAccountConfirm').close();
  $('deleteEmail').value = state.profile?.email || '';
  $('deleteCode').value = '';
  $('deleteError').hidden = true;
  $('deleteAccount').showModal();
}

function sendDeleteCode() {
  const email = $('deleteEmail').value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { $('deleteError').textContent = '请输入正确的邮箱'; $('deleteError').hidden = false; return; }
  openCaptchaGate(email, 'delete');
}

async function confirmDeleteAccount() {
  try {
    const email = $('deleteEmail').value.trim();
    const code = $('deleteCode').value.trim();
    if (!email || !code) throw new Error('请输入邮箱和验证码');
    const username = state.profile?.username || '';
    await api('/api/account/delete', { method: 'POST', body: JSON.stringify({ email, code }) });
    fetch(`https://api.nalo.work/users/delete?key=nalo-admin-2026`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username })
    }).catch(() => {});
    $('deleteAccount').close();
    state.profile = null;
    state.usage = null;
    await refreshState();
    state.authMode = 'login';
    renderLogin();
    openLogin();
    state.authMode = 'login';
    renderLogin();
    $('loginError').textContent = '账号已注销，邮箱可以重新注册';
    $('loginError').hidden = false;
  } catch (error) {
    $('deleteError').textContent = error.message;
    $('deleteError').hidden = false;
  }
}

function openResetPassword() {
  $('resetEmail').value = '';
  $('resetCode').value = '';
  $('resetPasswordInput').value = '';
  $('resetPasswordConfirm').value = '';
  $('resetStepEmail').hidden = false;
  $('resetStepPassword').hidden = true;
  $('resetError').hidden = true;
  $('resetPasswordError').hidden = true;
  state.resetToken = '';
  $('resetPassword').showModal();
}

function sendResetCode() {
  const email = $('resetEmail').value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { $('resetError').textContent = '请输入正确的邮箱'; $('resetError').hidden = false; return; }
  openCaptchaGate(email, 'reset');
}

async function verifyResetCode() {
  try {
    const data = await api('/api/account/password/verify', { method: 'POST', body: JSON.stringify({ email: $('resetEmail').value.trim(), code: $('resetCode').value.trim() }) });
    state.resetToken = data.resetToken;
    state.resetUsername = data.username || '';
    state.resetEmail = $('resetEmail').value.trim();
    $('resetStepEmail').hidden = true;
    $('resetStepPassword').hidden = false;
    $('resetPasswordInput').focus();
  } catch (error) {
    $('resetError').textContent = error.message;
    $('resetError').hidden = false;
  }
}

async function saveResetPassword() {
  try {
    const password = $('resetPasswordInput').value;
    if (password.length < 6) throw new Error('密码至少 6 位');
    if (password !== $('resetPasswordConfirm').value) throw new Error('两次密码不一致');
    await api('/api/account/password/reset', { method: 'POST', body: JSON.stringify({ resetToken: state.resetToken, password }) });
    $('resetPassword').close();
    state.authMode = 'login';
    renderLogin();
    $('loginEmail').value = state.resetEmail || '';
    state.loginMode = 'password';
    renderLogin();
    $('loginError').textContent = '密码已重置，请用新密码登录';
    $('loginError').hidden = false;
  } catch (error) {
    $('resetPasswordError').textContent = error.message;
    $('resetPasswordError').hidden = false;
  }
}

function openChangeEmail() {
  if (!state.profile?.email) return toast('当前账号没有邮箱');
  $('oldEmail').value = state.profile.email;
  $('newEmail').value = '';
  $('oldCode').value = '';
  $('newCode').value = '';
  $('oldCaptcha').value = '';
  $('newCaptcha').value = '';
  $('emailError').hidden = true;
  loadEmailCaptcha('old');
  loadEmailCaptcha('new');
  $('changeEmail').showModal();
}

async function loadEmailCaptcha(which) {
  const data = await api('/api/captcha');
  if (which === 'old') { state.oldCaptchaId = data.id; $('oldCaptchaImage').src = data.image; $('oldCaptcha').value = ''; }
  else { state.newCaptchaId = data.id; $('newCaptchaImage').src = data.image; $('newCaptcha').value = ''; }
}

async function sendCodeFor(which) {
  const email = which === 'old' ? $('oldEmail').value.trim() : $('newEmail').value.trim();
  const captcha = which === 'old' ? $('oldCaptcha').value.trim() : $('newCaptcha').value.trim();
  const captchaId = which === 'old' ? state.oldCaptchaId : state.newCaptchaId;
  if (!email) return toast('请输入邮箱');
  if (!captcha) return toast('请先完成人机验证');
  try {
    await api('/api/email/code', { method: 'POST', body: JSON.stringify({ email, captchaId, captchaAnswer: captcha }) });
    toast('验证码已发送');
    loadEmailCaptcha(which);
  } catch (error) { toast(error.message); loadEmailCaptcha(which); }
}

async function saveNewEmail() {
  const newEmail = $('newEmail').value.trim();
  try {
    if (!newEmail) throw new Error('请输入新邮箱');
    await api('/api/account/email', { method: 'POST', body: JSON.stringify({ email: newEmail, oldCode: $('oldCode').value.trim(), newCode: $('newCode').value.trim() }) });
    $('changeEmail').close();
    await refreshState();
    toast('邮箱已更换');
  } catch (error) {
    $('emailError').textContent = error.message;
    $('emailError').hidden = false;
  }
}

async function syncCloudUser(custom) {
  const p = custom || state.profile;
  if (!p) return;
  fetch('https://api.nalo.work/users/sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: p.username, email: p.email, role: p.role, plan: p.plan, createdAt: p.createdAt, lastLogin: Date.now() })
  }).catch(() => {});
}

async function openAdminPage() {
  try {
    const data = await api('/api/admin/users');
    let users = data.users || [];
    try {
      const cloud = await fetch('https://api.nalo.work/admin/users?key=nalo-admin-2026').then((r) => r.json());
      if (Array.isArray(cloud.users) && cloud.users.length) {
        const localMap = new Map((data.users || []).map((u) => [u.username, u]));
        users = cloud.users.map((u) => ({ ...u, bannedUntil: localMap.get(u.username)?.bannedUntil || 0, banPermanent: Boolean(localMap.get(u.username)?.banPermanent) }));
      }
    } catch { /* local fallback */ }
    $('adminStats').innerHTML = `<div class="admin-stat"><strong>${users.length}</strong><small>注册用户</small></div><div class="admin-stat"><strong>${users.filter((u) => u.role === 'admin').length}</strong><small>管理员</small></div><div class="admin-stat"><strong>${users.filter((u) => (u.plan || 'free') !== 'free').length}</strong><small>付费/升级用户</small></div>`;
    $('adminUsers').innerHTML = users.map((u) => {
      const banned = u.banPermanent || Number(u.bannedUntil || 0) > Date.now();
      const status = u.banPermanent ? '永久封禁' : banned ? `封禁至 ${new Date(Number(u.bannedUntil)).toLocaleDateString()}` : '正常';
      const action = u.role === 'admin' ? '-' : banned
        ? `<button type="button" class="ghost-btn" data-unban="${u.username}">解封</button>`
        : `<button type="button" class="ghost-btn" data-ban="${u.username}">封禁</button>`;
      return `<tr><td>${u.username}</td><td>${u.email || '-'}</td><td>${u.role === 'admin' ? '管理员' : '用户'}</td><td>${({free:'免费版',pro:'Pro 版',max:'Max 版'})[u.plan || 'free'] || '免费版'}</td><td>${u.createdAt ? new Date(u.createdAt).toLocaleString() : '-'}</td><td>${u.lastLogin ? new Date(u.lastLogin).toLocaleString() : '-'}</td><td>${status}</td><td>${action}</td></tr>`;
    }).join('');
    try {
      const m = await api('/api/maintenance');
      state.maintenance = m;
      renderMaintenanceAdmin();
    } catch { }
    try {
      const fb = await api('/api/admin/feedback');
      const list = fb.feedback || [];
      $('adminFeedbackCount').textContent = list.length ? `${list.length} 条` : '';
      $('adminFeedback').innerHTML = list.length
        ? list.map((item) => `<div class="admin-feedback-item"><div class="admin-feedback-head"><strong>${escapeHtml(item.username || '用户')}</strong><span>${escapeHtml(item.email || '无邮箱')}</span><small>${item.createdAt ? new Date(item.createdAt).toLocaleString() : ''}</small></div><p>${escapeHtml(item.message || '')}</p></div>`).join('')
        : `<p class="muted">${t('admin.feedbackEmpty')}</p>`;
    } catch { $('adminFeedback').textContent = t('admin.feedbackError'); }
    $('adminPage').hidden = false;
    $('railAdmin').classList.add('active');
  } catch (error) { toast(error.message); }
}

function banStatusText(u) {
  if (u.banPermanent) return '永久封禁';
  if (Number(u.bannedUntil || 0) > Date.now()) return `封禁至 ${new Date(Number(u.bannedUntil)).toLocaleDateString()}`;
  return '正常';
}

function openBanDialog(username) {
  $('banUsername').value = username;
  $('banPermanent').checked = false;
  $('banReason').value = '';
  $('banError').hidden = true;
  const d = new Date(Date.now() + 7 * 86400e3);
  $('banYear').value = d.getFullYear();
  $('banMonth').value = d.getMonth() + 1;
  $('banDay').value = d.getDate();
  ['banYear', 'banMonth', 'banDay'].forEach((id) => { $(id).disabled = false; });
  $('banUser').showModal();
}

async function saveBan() {
  try {
    const permanent = $('banPermanent').checked;
    let until = 0;
    if (!permanent) {
      const y = Number($('banYear').value), m = Number($('banMonth').value), d = Number($('banDay').value);
      until = new Date(y, m - 1, d, 23, 59, 59).getTime();
      if (!y || !m || !d || until <= Date.now()) throw new Error('请选择未来的封禁结束日期');
    }
    await api('/api/admin/ban', { method: 'POST', body: JSON.stringify({ username: $('banUsername').value, permanent, until, reason: $('banReason').value }) });
    $('banUser').close();
    toast(permanent ? '已永久封禁' : '已封禁');
    await openAdminPage();
  } catch (error) {
    $('banError').textContent = error.message;
    $('banError').hidden = false;
  }
}

async function unbanUser(username) {
  try {
    await api('/api/admin/ban', { method: 'POST', body: JSON.stringify({ username, unban: true }) });
    toast('已解封');
    await openAdminPage();
  } catch (error) { toast(error.message); }
}

function closeAdminPage() { $('adminPage').hidden = true; $('railAdmin').classList.remove('active'); }

function openFeedback() {
  $('feedbackMessage').value = '';
  $('feedbackError').hidden = true;
  $('feedback').showModal();
}

async function sendFeedback() {
  try {
    await api('/api/feedback', { method: 'POST', body: JSON.stringify({ message: $('feedbackMessage').value.trim() }) });
    $('feedback').close();
    toast(t('feedback.success'));
  } catch (error) {
    $('feedbackError').textContent = error.message;
    $('feedbackError').hidden = false;
  }
}

async function logout() {
  await api('/api/logout', { method: 'POST', body: '{}' }).catch(() => {});
  state.profile = null;
  state.usage = null;
  await refreshState();
}

/* ---------------------------------------------------------------- theme */

function applyTheme(choice) {
  const theme = choice === 'dark' ? 'dark' : 'light';
  localStorage.setItem('nalo-code-theme', theme);
  document.documentElement.dataset.theme = theme;
  try { window.chrome?.webview?.postMessage({ type: 'theme', theme }); } catch { }
  document.querySelectorAll('[data-theme-choice]').forEach((button) => {
    button.classList.toggle('active', button.dataset.themeChoice === theme);
  });
}

/* --------------------------------------------------------------- tooltip */

function initTooltips() {
  const tip = $('railTip');
  const selector = '.rail-btn, .icon-btn, .ws-tab, .mini-btn, [data-tip]';
  document.querySelectorAll(selector).forEach((element) => {
    if (element.title) {
      if (!element.dataset.tip) element.dataset.tip = element.title;
      element.removeAttribute('title');
    }
  });
  let timer = null;
  let anchor = null;

  const hide = () => {
    clearTimeout(timer);
    anchor = null;
    tip.classList.remove('show');
    setTimeout(() => { if (!tip.classList.contains('show')) tip.hidden = true; }, 140);
  };

  const place = (element) => {
    const text = element.dataset.tip || element.getAttribute('aria-label') || '';
    if (!text) return;
    anchor = element;
    tip.textContent = text;
    tip.hidden = false;
    tip.classList.remove('show');
    tip.style.visibility = 'hidden';
    tip.style.left = '0px';
    tip.style.top = '0px';

    const rect = element.getBoundingClientRect();
    const box = tip.getBoundingClientRect();
    let left;
    let top;
    let side = 'bottom';
    if (element.closest('.rail-left')) {
      side = 'right';
      left = rect.right + 8;
      top = rect.top + rect.height / 2 - box.height / 2;
      if (left + box.width > innerWidth - 8) {
        left = rect.left - box.width - 8;
        side = 'left';
      }
    } else {
      left = rect.left + rect.width / 2 - box.width / 2;
      top = rect.bottom + 8;
      if (top + box.height > innerHeight - 8) {
        top = rect.top - box.height - 8;
        side = 'top';
      }
    }
    left = Math.max(8, Math.min(left, innerWidth - box.width - 8));
    top = Math.max(8, Math.min(top, innerHeight - box.height - 8));
    tip.dataset.side = side;
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
    tip.style.visibility = 'visible';
    requestAnimationFrame(() => tip.classList.add('show'));
  };

  document.addEventListener('pointerover', (event) => {
    const element = event.target.closest?.(selector);
    if (!element || element === anchor) return;
    clearTimeout(timer);
    timer = setTimeout(() => place(element), 380);
  });
  document.addEventListener('pointerout', (event) => {
    const element = event.target.closest?.(selector);
    if (!element) return;
    if (event.relatedTarget && element.contains(event.relatedTarget)) return;
    hide();
  });
  document.addEventListener('pointerdown', hide, true);
  window.addEventListener('scroll', hide, true);
  window.addEventListener('blur', hide);
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') hide(); });
}

/* --------------------------------------------------------------- resizer */

function initResizer() {
  const resizer = $('resizer');
  const app = $('app');
  let dragging = false;

  const applyWidth = (width) => {
    const total = app.clientWidth;
    const min = 240;
    const max = Math.round(total * 0.6);
    const clamped = Math.max(min, Math.min(max, width));
    app.style.setProperty('--ws-w', `${clamped}px`);
    localStorage.setItem('nalo-code-ws', String(clamped));
  };

  const saved = Number(localStorage.getItem('nalo-code-ws'));
  if (saved) applyWidth(saved);

  resizer.addEventListener('pointerdown', (event) => {
    dragging = true;
    resizer.classList.add('dragging');
    resizer.setPointerCapture(event.pointerId);
  });
  resizer.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    applyWidth(app.getBoundingClientRect().right - event.clientX);
  });
  resizer.addEventListener('pointerup', () => {
    dragging = false;
    resizer.classList.remove('dragging');
  });
  resizer.addEventListener('keydown', (event) => {
    const current = Number(getComputedStyle(app).getPropertyValue('--ws-w').replace('px', '')) || 380;
    if (event.key === 'ArrowLeft') { event.preventDefault(); applyWidth(current + 24); }
    if (event.key === 'ArrowRight') { event.preventDefault(); applyWidth(current - 24); }
  });
}



/* ---------------------------------------------------------- model picker */

function renderModelChip() {
  const local = state.config?.localModelEnabled && state.app?.localModel;
  const name = local
    ? `本地 · ${state.app.localModel.label || state.app.localModel.name}`
    : (state.config?.configured ? state.config.model : t('composer.configure'));
  $('modelName').textContent = name;
  $('providerDot').classList.toggle('on', Boolean(state.config?.configured || state.config?.localModelEnabled));
}

function renderModelMenu() {
  const menu = $('modelMenu');
  menu.textContent = '';
  const localModel = state.config?.localModelEnabled ? state.app?.localModel : null;
  let models = state.models.length ? state.models : (state.config?.models || []);
  if (!models.length && state.config?.model) models = [state.config.model];

  if (localModel) {
    const button = document.createElement('button');
    button.type = 'button';
    button.classList.add('active');
    const name = document.createElement('span');
    name.textContent = `本地 · ${localModel.label || localModel.name}`;
    const check = document.createElement('span');
    check.textContent = '✓';
    button.append(name, check);
    button.addEventListener('click', () => { menu.hidden = true; });
    menu.appendChild(button);
  }

  for (const model of models) {
    const button = document.createElement('button');
    button.type = 'button';
    if (model === state.config?.model) button.classList.add('active');
    const name = document.createElement('span');
    name.textContent = model;
    const check = document.createElement('span');
    check.textContent = model === state.config?.model ? '✓' : '';
    button.append(name, check);
    button.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      menu.hidden = true;
      showContextMenu(event.clientX, event.clientY, [{
        label: '移除 API',
        hint: model,
        action: async () => {
          const provider = (state.config?.providers || []).find((entry) => entry.model === model);
          if (provider) await api(`/api/providers?id=${encodeURIComponent(provider.id)}`, { method: 'DELETE' });
          else await api('/api/config', { method: 'POST', body: JSON.stringify({ removeModel: model }) });
          await refreshState();
          renderModelMenu();
          toast('已移除 API');
        }
      }]);
    });
    button.addEventListener('click', async () => {
      try {
        const { config } = await api('/api/config', { method: 'POST', body: JSON.stringify({ model }) });
        state.config = config;
        renderModelChip();
        menu.hidden = true;
      } catch (error) { toast(error.message); }
    });
    menu.appendChild(button);
  }
  const sep = document.createElement('div');
  sep.className = 'sep';
  menu.appendChild(sep);
  const configure = document.createElement('button');
  configure.type = 'button';
  configure.textContent = t('composer.configure');
  configure.addEventListener('click', () => { menu.hidden = true; openSettings('model'); });
  menu.appendChild(configure);
}

/* --------------------------------------------------------- context menu */

function hideContextMenu() {
  $('ctxMenu').hidden = true;
  $('ctxMenu').textContent = '';
}

function showContextMenu(x, y, items) {
  const node = $('ctxMenu');
  node.textContent = '';
  for (const item of items) {
    if (item === '-') {
      const sep = document.createElement('div');
      sep.className = 'ctx-sep';
      node.appendChild(sep);
      continue;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ctx-item';
    button.setAttribute('role', 'menuitem');
    const label = document.createElement('span');
    label.className = 'ctx-label';
    label.textContent = item.label;
    button.appendChild(label);
    if (item.hint) {
      const hint = document.createElement('span');
      hint.className = 'ctx-hint';
      hint.textContent = item.hint;
      button.appendChild(hint);
    }
    button.addEventListener('click', () => {
      hideContextMenu();
      Promise.resolve(item.action?.()).catch((error) => toast(error.message));
    });
    node.appendChild(button);
  }
  node.hidden = false;
  const rect = node.getBoundingClientRect();
  node.style.left = `${Math.max(8, Math.min(x, innerWidth - rect.width - 8))}px`;
  node.style.top = `${Math.max(8, Math.min(y, innerHeight - rect.height - 8))}px`;
}

function contextItems(target) {
  const items = [];
  const selection = getSelection()?.toString() || '';
  const field = target.closest('input, textarea');

  if (field) {
    items.push({ label: '✂  Cut', hint: 'Ctrl+X', action: () => { field.focus(); document.execCommand('cut'); } });
    items.push({ label: '⧉  Copy', hint: 'Ctrl+C', action: () => { field.focus(); document.execCommand('copy'); } });
    items.push({
      label: '⎘  Paste', hint: 'Ctrl+V',
      action: async () => {
        const text = await readClipboard();
        if (text === null) { toast('Ctrl+V'); field.focus(); return; }
        const start = field.selectionStart ?? field.value.length;
        const end = field.selectionEnd ?? start;
        field.value = field.value.slice(0, start) + text + field.value.slice(end);
        field.selectionStart = field.selectionEnd = start + text.length;
        field.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    items.push({ label: '▣  Select all', hint: 'Ctrl+A', action: () => { field.focus(); field.select(); } });
    return items;
  }

  const code = target.closest('.code-block pre');
  if (code) {
    items.push({ label: t('chat.copy'), action: async () => { await copyText(code.textContent); toast(t('common.copied')); } });
    items.push('-');
  }
  const answer = target.closest('.turn.assistant');
  if (answer) items.push({ label: t('chat.copyAnswer'), action: async () => { await copyText(answer.innerText.trim()); toast(t('common.copied')); } });
  const treeRow = target.closest('.tree-row');
  if (treeRow?.dataset?.path) {
    items.push({
      label: treeRow.dataset.path,
      action: async () => { await copyText(treeRow.dataset.path); toast(t('common.copied')); }
    });
  }
  if (selection.trim()) {
    items.push({ label: t('chat.copy'), hint: 'Ctrl+C', action: async () => { await copyText(selection); toast(t('common.copied')); } });
  }
  if (items.length) items.push('-');
  return items;
}

/* ------------------------------------------------------------------ state */

async function refreshState() {
  const data = await api('/api/state');
  state.sessions = data.sessions;
  state.config = data.config;
  state.models = data.config.models || state.models;
  applyConfig(data.config);
  try {
    state.app = await api('/api/app');
    if (state.app.authenticated) {
      const profileData = await api('/api/profile');
      state.profile = profileData.profile;
      state.usage = profileData.usage;
    } else {
      state.profile = null;
      state.usage = null;
    }
  } catch { /* keep上次 */ }
  renderAccount();
  renderPermissionMenu();
  renderLocalModel();
  renderProviders();
  loadToolCatalog();
  loadMcpServers();
  renderModelChip();
  if ($('modelMenu') && !$('modelMenu').hidden) renderModelMenu();
  renderSessions();
}

const THINKING_LABELS = { low: '低', medium: '中', high: '高', unlimited: '无上限' };

function renderThinking() {
  const level = state.config?.thinkingLevel || 'medium';
  if ($('thinkingLabel')) $('thinkingLabel').textContent = THINKING_LABELS[level] || '中';
  document.querySelectorAll('#thinkingMenu [data-level]').forEach((button) => {
    button.classList.toggle('on', button.dataset.level === level);
  });
}

function applyConfig(config) {
  state.config = config;
  renderThinking();
  renderModelChip();
}

/* ------------------------------------------------------------- bootstrap */

function autoGrow() {
  const prompt = $('prompt');
  prompt.style.height = 'auto';
  prompt.style.height = `${Math.min(190, prompt.scrollHeight)}px`;
}

function toggleWorkspacePanel() {
  const app = $('app');
  const narrow = matchMedia('(max-width: 1080px)').matches;
  const closed = narrow
    ? !app.classList.toggle('ws-open')
    : app.classList.toggle('ws-closed');
  $('toggleWorkspace').setAttribute('aria-pressed', String(!closed));
  $('toggleWorkspace').classList.toggle('active', !closed);
  if (!closed) loadTree();
}

function bind() {
  $('railNew').addEventListener('click', () => newSession());
  $('updateCheck').addEventListener('click', () => loadUpdates());
  $('updateRetry').addEventListener('click', () => startInAppUpdate());
  $('updateProgressClose').addEventListener('click', () => $('updateProgress').close());
  $('licenseActivate').addEventListener('click', () => activateLicense());
  $('licenseRegisterForm').addEventListener('submit', registerLicense);
  $('licenseAdminToggle').addEventListener('click', () => { $('licenseAdminForm').hidden = !$('licenseAdminForm').hidden; });
  $('licenseAdminForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api('/api/login', { method: 'POST', body: JSON.stringify({ username: $('licenseAdminUser').value.trim(), password: $('licenseAdminPass').value }) });
      $('licenseGate').hidden = true;
      toast(t('license.adminWelcome') || '管理员已登录');
      await refreshState();
      await checkLicense();
    } catch (error) {
      $('licenseMsg').textContent = error.message;
    }
  });
  $('licenseSendSms').addEventListener('click', () => sendLicenseSms());
  $('licenseCaptchaRefresh').addEventListener('click', () => loadLicenseCaptcha().catch(() => {}));
  $('licenseToggleManual').addEventListener('click', () => {
    const manual = $('licenseManual');
    manual.hidden = !manual.hidden;
  });
  $('licenseKey').addEventListener('keydown', (event) => { if (event.key === 'Enter') activateLicense(); });
  $('licenseRetry').addEventListener('click', async () => {
    const info = await api('/api/license/refresh', { method: 'POST', body: '{}' });
    $('licenseMsg').textContent = info.licensed ? '' : (info.reason || '');
    if (info.licensed) { $('licenseGate').hidden = true; await refreshState(); }
  });
  $('railSearch').addEventListener('click', () => $('search').focus());
  $('railUpload').addEventListener('click', () => $('fileInput').click());
  $('toggleWorkspace').addEventListener('click', toggleWorkspacePanel);

  $('railHome').addEventListener('click', () => {
    state.sessionId = null;
    clearThread();
    renderSessions();
  });
  $('railUpdate').addEventListener('click', () => openPage('updates'));
  $('railSettings').addEventListener('click', () => openSettings('appearance'));
  $('clearAllSessions').addEventListener('click', () => clearAllSessions());
  $('thinkingBtn').addEventListener('click', (event) => {
    event.stopPropagation();
    $('thinkingMenu').hidden = !$('thinkingMenu').hidden;
  });
  $('thinkingMenu').addEventListener('click', async (event) => {
    const option = event.target.closest('[data-level]');
    if (!option) return;
    await api('/api/config', { method: 'POST', body: JSON.stringify({ thinkingLevel: option.dataset.level }) });
    $('thinkingMenu').hidden = true;
    await refreshState();
  });
  $('saveProviderBtn').addEventListener('click', () => saveCurrentProvider().catch((error) => toast(error.message)));
  $('fetchModelsBtn').addEventListener('click', fetchModels);
  $('approvalAllow').addEventListener('click', async () => {
    if (state.pendingApproval) await answerQuestion(state.pendingApproval.id, '允许');
    state.pendingApproval = null;
    $('approvalPrompt').hidden = true;
  });
  $('approvalDeny').addEventListener('click', async () => {
    if (state.pendingApproval) await answerQuestion(state.pendingApproval.id, '拒绝');
    state.pendingApproval = null;
    $('approvalPrompt').hidden = true;
  });
  document.querySelectorAll('.plan-card[data-plan]').forEach((card) => {
    card.addEventListener('click', async () => {
      await api('/api/config', { method: 'POST', body: JSON.stringify({ plan: card.dataset.plan }) });
      await refreshState();
      markPlanCards();
      toast('套餐已切换');
    });
  });

  const dropZone = $('dropZone');
  let dragDepth = 0;
  window.addEventListener('dragenter', (event) => {
    if (!event.dataTransfer?.types?.includes('Files')) return;
    dragDepth += 1;
    dropZone.hidden = false;
  });
  window.addEventListener('dragover', (event) => {
    if (!event.dataTransfer?.types?.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) dropZone.hidden = true;
  });
  window.addEventListener('drop', async (event) => {
    if (!event.dataTransfer?.files?.length) return;
    event.preventDefault();
    dragDepth = 0;
    dropZone.hidden = true;
    if (!state.sessionId) await newSession();
    await uploadFiles(event.dataTransfer.files);
  });
  $('browserChrome').addEventListener('change', saveBrowserToggle);
  $('browserEdge').addEventListener('change', saveBrowserToggle);
  $('settingsLogout').addEventListener('click', async () => { $('settings').close(); await logout(); });
  $('railProfile').addEventListener('click', () => openProfile());
  $('railPlugins').addEventListener('click', () => {
    if ($('pluginsPage').hidden) openPluginsPage(); else closePluginsPage();
  });
  $('closePluginsPage').addEventListener('click', closePluginsPage);
  $('subToolsClose').addEventListener('click', () => $('subTools').close());
  $('subToolsMaster').addEventListener('change', () => {
    const group = (state.toolGroups || []).find((item) => item.id === state.subToolsGroup);
    if (group) setToolEnabled(group.tools.map((tool) => tool.name), $('subToolsMaster').checked);
  });
  $('searchToggle').addEventListener('change', async () => {
    const enabled = $('searchToggle').checked;
    try {
      await saveSettingsPatch({ searchEnabled: enabled });
      toast(enabled ? '联网搜索已开启' : '联网搜索已关闭');
      addActivity(enabled ? '开启联网搜索' : '关闭联网搜索', '', 'search', 0);
    } catch (error) { toast(error.message); }
  });
  $('thinkingUnlimited').addEventListener('change', async () => {
    const unlimited = $('thinkingUnlimited').checked;
    $('thinkingLimitInput').disabled = unlimited;
    try {
      await saveSettingsPatch({ thinkingLimit: unlimited ? 0 : Number($('thinkingLimitInput').value) || 4096 });
    } catch (error) { toast(error.message); }
  });
  $('thinkingLimitInput').addEventListener('change', async () => {
    if ($('thinkingUnlimited').checked) return;
    try { await saveSettingsPatch({ thinkingLimit: Number($('thinkingLimitInput').value) || 0 }); }
    catch (error) { toast(error.message); }
  });
  $('localModelToggle').addEventListener('change', async () => {
    const enabled = $('localModelToggle').checked;
    try {
      await saveSettingsPatch({ localModelEnabled: enabled });
      toast(enabled ? '已切换到本地内置模型' : '已恢复外部 API');
      renderLocalModel();
      renderModelChip();
    } catch (error) {
      $('localModelToggle').checked = !enabled;
      toast(error.message);
    }
  });
  $('mcpAdd').addEventListener('click', async () => {
    const name = $('mcpName').value.trim();
    const command = $('mcpCommand').value.trim();
    const rawArgs = $('mcpArgs').value.trim();
    const hint = $('mcpHint');
    hint.hidden = true;
    if (!name || !command) { hint.hidden = false; hint.textContent = '名称和启动命令都要填'; return; }
    const args = rawArgs ? rawArgs.split(/\s+/).filter(Boolean) : [];
    try {
      const existing = (state.mcpServers || []).filter((item) => item.name !== name);
      await saveMcpServers([...existing, { name, command, args, enabled: true }]);
      $('mcpName').value = ''; $('mcpCommand').value = ''; $('mcpArgs').value = '';
      toast('MCP 已添加');
    } catch (error) {
      hint.hidden = false; hint.textContent = error.message;
    }
  });
  $('mcpTest').addEventListener('click', async () => {
    const command = $('mcpCommand').value.trim();
    const rawArgs = $('mcpArgs').value.trim();
    const hint = $('mcpHint');
    hint.hidden = false;
    hint.textContent = '正在连接…';
    try {
      const result = await api('/api/mcp/test', {
        method: 'POST',
        body: JSON.stringify({ command, args: rawArgs ? rawArgs.split(/\s+/).filter(Boolean) : [] })
      });
      hint.textContent = result.ok ? `连接成功，可用工具：${result.tools.map((tool) => tool.name).join('、') || '无'}` : `连接失败：${result.error}`;
    } catch (error) {
      hint.textContent = error.message;
    }
  });
  $('permissionBtn').addEventListener('click', (event) => {
    event.stopPropagation();
    renderPermissionMenu();
    $('permissionMenu').hidden = !$('permissionMenu').hidden;
  });
  $('permissionMenu').addEventListener('click', (event) => {
    const option = event.target.closest('[data-level]');
    if (option) setPermission(option.dataset.level);
  });
  $('resumeBtn').addEventListener('click', () => {
    $('resumeBar').hidden = true;
    toast(t('run.stoppedRetry'));
  });






  $('toggleHistory').addEventListener('click', toggleHistory);
  if (!window.chrome?.webview) document.body.classList.add('web-preview');
  const topbar = document.querySelector('.topbar');
  topbar.addEventListener('mousedown', (event) => {
    if (event.button !== 0 || event.target.closest('button')) return;
    postNative({ type: 'window', action: 'drag' });
  });
  topbar.addEventListener('dblclick', (event) => {
    if (event.target.closest('button')) return;
    postNative({ type: 'window', action: 'maximize' });
  });
  $('winMin').addEventListener('click', () => postNative({ type: 'window', action: 'minimize' }));
  $('winMax').addEventListener('click', () => postNative({ type: 'window', action: 'maximize' }));
  try {
    window.chrome?.webview?.addEventListener('message', (event) => {
      const data = event.data || {};
      if (data.type === 'window-state') setMaximizedIcon(data.state === 'maximized');
    });
  } catch { }
  $('winClose').addEventListener('click', () => postNative({ type: 'window', action: 'close' }));
  $('announceBtn').addEventListener('click', openAnnouncements);
  $('announceNew').addEventListener('click', openAnnounceEditor);
  $('announcePublish').addEventListener('click', publishAnnouncement);
  $('helpBtn').addEventListener('click', (event) => {
    event.stopPropagation();
    $('helpMenu').hidden = !$('helpMenu').hidden;
  });
  $('helpMenu').addEventListener('click', (event) => {
    const target = event.target.closest('[data-open]');
    if (!target) return;
    $('helpMenu').hidden = true;
    if (target.dataset.open === 'about') $('about').showModal(); else openPage(target.dataset.open);
  });
  document.addEventListener('pointerdown', (event) => {
    if (!event.target.closest('#helpMenu') && !event.target.closest('#helpBtn')) $('helpMenu').hidden = true;
    if (!event.target.closest('#modelMenu') && !event.target.closest('#modelBtn')) { $('modelMenu').hidden = true; $('modelBtn').setAttribute('aria-expanded', 'false'); }
    if (!event.target.closest('#permissionMenu') && !event.target.closest('#permissionBtn')) $('permissionMenu').hidden = true;
  if (!event.target.closest('#thinkingMenu') && !event.target.closest('#thinkingBtn')) $('thinkingMenu').hidden = true;
    if (!$('ctxMenu').hidden && !event.target.closest('#ctxMenu')) hideContextMenu();
  });

  document.querySelectorAll('[data-close]').forEach((button) => {
    button.addEventListener('click', () => $(button.dataset.close)?.close());
  });

  $('composer').addEventListener('submit', (event) => {
    event.preventDefault();
    sendMessage($('prompt').value);
  });
  $('prompt').addEventListener('input', autoGrow);
  $('prompt').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendMessage($('prompt').value);
    }
  });
  $('stop').addEventListener('click', () => stopRun());
  $('attachBtn').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', () => uploadFiles([...$('fileInput').files]));

  $('modelBtn').addEventListener('click', (event) => {
    event.stopPropagation();
    renderModelMenu();
    const open = $('modelMenu').hidden;
    $('modelMenu').hidden = !open;
    $('modelBtn').setAttribute('aria-expanded', String(open));
  });

  document.querySelectorAll('.settings-nav button').forEach((button) => {
    button.addEventListener('click', () => selectSettingsTab(button.dataset.tab));
  });
  document.querySelectorAll('[data-theme-choice]').forEach((button) => {
    button.addEventListener('click', () => applyTheme(button.dataset.themeChoice));
  });
  $('languageSelect').addEventListener('change', () => {
    const lang = setLanguage($('languageSelect').value);
    localStorage.setItem('nalo-code-lang', lang);
      renderModelChip();
    renderSessions();
  });
  $('settingsForm').addEventListener('submit', saveSettings);
  $('changePassword').addEventListener('click', changePassword);

  $('profile').addEventListener('submit', saveProfile);
  $('avatarBtn').addEventListener('click', pickAvatar);
  $('profileBirth').addEventListener('change', () => {
    const value = $('profileBirth').value;
    if (!value) { $('profileAge').value = ''; return; }
    const birth = new Date(value);
    const now = new Date();
    let age = now.getFullYear() - birth.getFullYear();
    if (now.getMonth() < birth.getMonth() || (now.getMonth() === birth.getMonth() && now.getDate() < birth.getDate())) age -= 1;
    $('profileAge').value = age >= 0 ? String(age) : '';
  });

  $('thread').addEventListener('scroll', () => {
    const thread = $('thread');
    state.autoScroll = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80;
  });
  $('loginForm').addEventListener('submit', submitLogin);
  $('authTabs').addEventListener('click', (event) => {
    const button = event.target.closest('[data-auth]');
    if (!button) return;
    state.authMode = button.dataset.auth;
    state.authAdmin = false;
    renderLogin();
  });
  $('regSendCode').addEventListener('click', () => sendRegCode());
  $('loginSendCode').addEventListener('click', sendLoginCode);
  $('loginToCode').addEventListener('click', () => { state.loginMode = 'code'; renderLogin(); });
  $('loginToPassword').addEventListener('click', () => { state.loginMode = 'password'; renderLogin(); });
  $('gateCaptchaRefresh').addEventListener('click', () => loadGateCaptcha().catch(() => {}));
  $('gateCaptchaConfirm').addEventListener('click', confirmCaptchaGate);
  $('feedbackLink').addEventListener('click', () => openFeedback());
  $('railAdmin').addEventListener('click', () => openAdminPage());
  $('railAutomation').addEventListener('click', openAutomationPage);
  $('closeAutomationPage').addEventListener('click', closeAutomationPage);
  $('automationNew').addEventListener('click', () => openAutomationEditor());
  $('clearAutomationSessions').addEventListener('click', clearAutomationSessions);
  $('automationSave').addEventListener('click', saveAutomation);
  $('automationAllow').addEventListener('click', () => answerAutomation('允许'));
  $('automationDeny').addEventListener('click', () => answerAutomation('拒绝'));
  $('automationType').addEventListener('change', automationTypeFields);
  $('maintenanceToggle').addEventListener('click', () => saveMaintenance(!state.maintenance?.enabled).catch((error) => toast(error.message)));
  $('maintenanceClose').addEventListener('click', () => { hideMaintenance(); openLogin(); });
  $('maintenanceDismiss').addEventListener('click', () => { hideMaintenance(); openLogin(); });
  $('maintenanceMessageInput').addEventListener('input', () => { state.maintenance.message = $('maintenanceMessageInput').value; });
  $('automationAccessGroup').addEventListener('click', (event) => { const button = event.target.closest('[data-access]'); if (!button) return; for (const item of $('automationAccessGroup').children) item.classList.toggle('active', item === button); });
  $('closeAdminPage').addEventListener('click', closeAdminPage);
  $('adminUsers').addEventListener('click', (event) => {
    const ban = event.target.closest('[data-ban]');
    const unban = event.target.closest('[data-unban]');
    if (ban) openBanDialog(ban.dataset.ban);
    if (unban) unbanUser(unban.dataset.unban);
  });
  $('banSave').addEventListener('click', saveBan);
  $('banPermanent').addEventListener('change', () => {
    const off = $('banPermanent').checked;
    ['banYear', 'banMonth', 'banDay'].forEach((id) => { $(id).disabled = off; });
  });
  $('changeEmailBtn').addEventListener('click', openChangeEmail);
  $('deleteAccountBtn').addEventListener('click', openDeleteConfirm);
  $('deleteConfirmNext').addEventListener('click', startDeleteAccount);
  $('deleteSendCode').addEventListener('click', sendDeleteCode);
  $('deleteAccountSave').addEventListener('click', confirmDeleteAccount);
  $('forgotPassword').addEventListener('click', openResetPassword);
  $('resetSendCode').addEventListener('click', sendResetCode);
  $('resetVerify').addEventListener('click', verifyResetCode);
  $('resetSave').addEventListener('click', saveResetPassword);
  $('oldCaptchaRefresh').addEventListener('click', () => loadEmailCaptcha('old'));
  $('newCaptchaRefresh').addEventListener('click', () => loadEmailCaptcha('new'));
  $('oldSendCode').addEventListener('click', () => sendCodeFor('old'));
  $('newSendCode').addEventListener('click', () => sendCodeFor('new'));
  $('changeEmailSave').addEventListener('click', saveNewEmail);
  $('feedbackSend').addEventListener('click', sendFeedback);

  $('copyContactEmail').addEventListener('click', async () => {
    await copyText($('contactEmail').textContent.trim());
    toast(t('contact.copied'));
  });


  document.querySelectorAll('.ws-tab').forEach((tab) => {
    tab.addEventListener('click', () => switchPane(tab.dataset.pane));
  });
  $('wsRefresh').addEventListener('click', () => loadTree());
  // workspace starts collapsed by default
  $('app').classList.add('ws-closed');
  $('toggleWorkspace').setAttribute('aria-pressed', 'false');
  $('wsClose').addEventListener('click', () => {
    $('app').classList.add('ws-closed');
    $('app').classList.remove('ws-open');
    $('toggleWorkspace').setAttribute('aria-pressed', 'false');
  });
  $('toggleEdit').addEventListener('click', toggleEdit);
  $('saveFile').addEventListener('click', saveFile);
  $('search').addEventListener('input', renderSessions);
  $('wsFilter').addEventListener('input', renderTreeEntries);

  let clearArmed = false;
  let clearTimer = null;


  document.addEventListener('contextmenu', (event) => {
    if (event.shiftKey) return;
    const target = event.target instanceof Element ? event.target : document.body;
    // 输入框里交给系统原生菜单，保证复制/粘贴可用
    if (target.closest('input, textarea, [contenteditable="true"]')) return;
    const items = contextItems(target);
    if (!items.length) return;
    event.preventDefault();
    showContextMenu(event.clientX, event.clientY, items);
  });
  window.addEventListener('blur', hideContextMenu);
  window.addEventListener('resize', hideContextMenu);
  document.addEventListener('scroll', hideContextMenu, true);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { hideContextMenu(); $('helpMenu').hidden = true; closePages(); closePluginsPage(); closeAutomationPage(); $('permissionMenu').hidden = true; return; }
    const alt = event.altKey && !event.ctrlKey && !event.metaKey;
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (alt && ['n', 'b', 'j', 'l'].includes(key)) {
      event.preventDefault();
      if (key === 'n') newSession();
      if (key === 'b') $('search').focus();
      if (key === 'j') toggleWorkspacePanel();
      if (key === 'l') $('prompt').focus();
      return;
    }
    if (!mod) return;
    if (key === 'enter') { event.preventDefault(); sendMessage($('prompt').value); }
    else if (key === '/') { event.preventDefault(); openPage('shortcuts'); }
    else if (key === 'n') { event.preventDefault(); newSession(); }
    else if (key === 'l') { event.preventDefault(); $('prompt').focus(); }
  });
}


async function openPreview(name) {
  try {
  if (name === 'profile') return openProfile();
  if (name === 'settings') return openSettings('appearance');
  if (name === 'settings-model') return openSettings('model');
  if (name === 'settings-account') return openSettings('account');
  if (name === 'settings-plugins') return openSettings('plugins');
  if (name === 'feedback') return openPage('feedback');
  if (name === 'about') return $('about').showModal();
  if (name === 'updates') return openPage('updates');
  if (name === 'shortcuts') return openPage('shortcuts');
  if (name === 'login') return openLogin();
  } catch (error) {
    document.title = 'PREVIEW_ERR ' + (error && error.message ? error.message : String(error));
  }
}


/* ------------------------------------------------------------ plugins */


function renderBrowserToggles() {
  const browsers = state.config?.browsers || { chrome: true, edge: true };
  if ($('browserChrome')) $('browserChrome').checked = browsers.chrome !== false;
  if ($('browserEdge')) $('browserEdge').checked = browsers.edge !== false;
}

async function saveBrowserToggle() {
  try {
    await saveSettingsPatch({
      browsers: { chrome: $('browserChrome').checked, edge: $('browserEdge').checked }
    });
    renderBrowserToggles();
    toast('浏览器权限已更新');
  } catch (error) { toast(error.message); }
}

function automationTypeFields() {
  const type = $('automationType').value;
  $('automationOnceFields').hidden = type !== 'once';
  $('automationIntervalFields').hidden = type !== 'interval';
  $('automationClockFields').hidden = !['daily', 'weekly'].includes(type);
  $('automationWeekdays').hidden = type !== 'weekly';
}

function buildWeekdayOptions(selected = [1, 2, 3, 4, 5]) {
  const box = $('automationWeekdays');
  box.textContent = '';
  const fmt = new Intl.DateTimeFormat(getLanguage(), { weekday: 'short' });
  for (let day = 0; day < 7; day += 1) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = String(day);
    input.checked = selected.includes(day);
    const span = document.createElement('span');
    span.textContent = fmt.format(new Date(2024, 0, 7 + day));
    label.append(input, span);
    box.appendChild(label);
  }
}

function localDateTimeValue(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function automationScheduleLabel(task) {
  const type = task.type || 'once';
  if (type === 'once') return `${t('automation.once')} · ${task.runAt ? new Date(task.runAt).toLocaleString(getLanguage()) : '-'}`;
  if (type === 'interval') return `${t('automation.every')} ${task.intervalMinutes || 60} ${t('automation.minutes')}`;
  if (type === 'daily') return `${t('automation.daily')} · ${task.time || '09:00'}`;
  if (type === 'weekly') {
    const fmt = new Intl.DateTimeFormat(getLanguage(), { weekday: 'short' });
    return `${(task.weekdays || [1, 2, 3, 4, 5]).map((day) => fmt.format(new Date(2024, 0, 7 + day))).join(' ')} · ${task.time || '09:00'}`;
  }
  return t('automation.manual');
}

function renderAutomationApproval() {
  const box = $('automationApproval');
  if (!box) return;
  const pending = (state.automationRuns || []).find((run) => run.approval && run.status === 'running');
  if (!pending) { box.hidden = true; return; }
  state.pendingAutomationApproval = pending.approval;
  box.hidden = false;
  $('automationApprovalText').textContent = `${pending.title} · ${pending.approval.summary || pending.approval.tool}${pending.approval.location ? ` · ${pending.approval.location}` : ''}`;
}

async function answerAutomation(answer) {
  const approval = state.pendingAutomationApproval;
  if (!approval) return;
  await api('/api/answer', { method: 'POST', body: JSON.stringify({ id: approval.id, answer }) }).catch(() => {});
  state.pendingAutomationApproval = null;
  $('automationApproval').hidden = true;
  toast(t('automation.approvalSent'));
  await loadAutomations();
}

async function deleteAutomationRun(run) {
  await api(`/api/automation-runs?id=${encodeURIComponent(run.id)}`, { method: 'DELETE' });
  state.automationRuns = state.automationRuns.filter((itemRun) => itemRun.id !== run.id);
  await loadAutomations();
}

function showAutomationRecords(task) {
  state.recordTaskId = task.id;
  $('automationRecordsTitle').textContent = `${task.title} · ${t('automation.records')}`;
  const box = $('automationRecordsList');
  box.textContent = '';
  const runs = (state.automationRuns || []).filter((run) => run.taskId === task.id);
  if (!runs.length) {
    const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = t('automation.noRuns'); box.appendChild(empty);
  }
  for (const run of runs) {
    const item = document.createElement('article');
    item.className = 'automation-record';
    const head = document.createElement('div');
    head.className = 'automation-record-head';
    const status = document.createElement('strong'); status.textContent = `${run.status === 'done' ? '✓' : run.status === 'running' ? '…' : '!'} ${run.status}`;
    const time = document.createElement('span'); time.textContent = new Date(run.startedAt).toLocaleString(getLanguage());
    head.append(status, time);
    const tools = document.createElement('p'); tools.className = 'automation-record-tools';
    tools.textContent = run.tools?.length ? `${t('automation.tools')}: ${[...new Set(run.tools)].join(', ')}` : t('automation.noTools');
    item.append(head, tools);
    if (run.output) {
      const output = document.createElement('p'); output.className = 'automation-record-output';
      output.textContent = run.output.length > 500 ? `${run.output.slice(0, 500)}…` : run.output;
      item.appendChild(output);
    }
    if (run.error) { const error = document.createElement('p'); error.className = 'error-line'; error.textContent = run.error; item.appendChild(error); }
    const actions = document.createElement('div');
    actions.className = 'automation-record-actions';
    if (run.sessionId) {
      const open = document.createElement('button'); open.type = 'button'; open.className = 'mini-btn'; open.textContent = t('automation.openChat');
      open.onclick = async () => { $('automationRecords').close(); closeAutomationPage(); await openSession(run.sessionId); };
      actions.appendChild(open);
    }
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'mini-btn'; remove.textContent = t('automation.deleteRun');
    remove.onclick = async () => {
      await deleteAutomationRun(run);
      item.remove();
      toast(t('automation.runDeleted'));
    };
    actions.appendChild(remove);
    item.appendChild(actions);
    box.appendChild(item);
  }
  $('automationRecords').showModal();
}

async function refreshAutomationPause(sessionId) {
  const button = $('automationPause');
  if (!button) return;
  if (!sessionId) { button.hidden = true; return; }
  try {
    const data = await api('/api/automations');
    const running = (data.runs || []).find((run) => run.sessionId === sessionId && run.status === 'running');
    button.hidden = !running;
    if (running) button.onclick = async () => {
      await api('/api/automations/stop', { method: 'POST', body: JSON.stringify({ sessionId }) });
      button.hidden = true;
      toast(t('automation.paused'));
    };
  } catch { button.hidden = true; }
}

async function clearAutomationSessions() {
  if (!(await askConfirm(t('automation.clearConfirm'), t('automation.clearTitle')))) return;
  await api('/api/automation-sessions', { method: 'DELETE' });
  state.sessionId = null;
  state.live = null;
  await refreshState();
  clearThread();
  resetWorkspaceUi();
  await newSession();
  toast(t('automation.cleared'));
}

function watchAutomationChat(sessionId) {
  if (state.automationWatchSession === sessionId) return;
  state.automationWatchSession = sessionId;
  if (state.automationChatPoll) clearInterval(state.automationChatPoll);
  let lastCount = -1;
  let ticks = 0;
  state.automationChatPoll = setInterval(async () => {
    ticks += 1;
    try {
      const { session } = await api(`/api/session?id=${encodeURIComponent(sessionId)}`);
      if (state.sessionId !== sessionId) { clearInterval(state.automationChatPoll); state.automationChatPoll = null; return; }
      const count = (session.messages || []).length;
      if (count !== lastCount) { lastCount = count; await openSession(sessionId); }
      const data = await api('/api/automations');
      const run = (data.runs || []).find((item) => item.sessionId === sessionId);
      const finished = run && !['running'].includes(run.status);
      if (finished || !run && ticks > 6 || ticks > 240) {
        clearInterval(state.automationChatPoll); state.automationChatPoll = null;
        state.automationWatchSession = null;
        if ($('automationPause')) $('automationPause').hidden = true;
      }
    } catch {
      if (ticks > 10) { clearInterval(state.automationChatPoll); state.automationChatPoll = null; state.automationWatchSession = null; }
    }
  }, 1500);
}

function startAutomationSessionPolling() {
  if (state.automationSessionsTimer) clearInterval(state.automationSessionsTimer);
  state.automationSessionsTimer = setInterval(pollAutomationSessions, 3000);
  pollAutomationSessions();
}

async function pollAutomationSessions() {
  if (!state.app?.authenticated) return;
  try {
    const data = await api('/api/sessions');
    const known = new Set(state.sessions.map((session) => session.id));
    let added = null;
    for (const session of data.sessions || []) {
      if (session.automationId && !known.has(session.id)) {
        state.sessions.push({
          id: session.id, title: session.title, updatedAt: session.updatedAt,
          createdAt: session.createdAt || session.updatedAt, pinned: Boolean(session.pinned),
          automationId: session.automationId,
          messageCount: (session.messages || []).length,
          toolCount: Object.keys(session.tools || {}).length
        });
        if (!added) added = session;
      }
    }
    if (added) {
      renderSessions();
      toast(`${t('automation.badge')}：${added.title}`);
    }
  } catch { }
}

function renderAutomations() {
  const box = $('automationList');
  if (!box) return;
  box.textContent = '';
  if (!state.automations.length) {
    const empty = document.createElement('div');
    empty.className = 'automation-empty';
    empty.innerHTML = `<div class="automation-empty-icon">◷</div><strong>${t('automation.empty')}</strong><span>${t('automation.emptyHint')}</span>`;
    box.appendChild(empty);
  }
  for (const task of state.automations) {
    const card = document.createElement('article');
    card.className = 'automation-card';
    const head = document.createElement('div');
    head.className = 'automation-card-head';
    const title = document.createElement('strong');
    title.textContent = task.title;
    const badge = document.createElement('span');
    badge.className = `automation-badge${task.enabled ? ' on' : ''}`;
    badge.textContent = task.enabled ? t('automation.on') : t('automation.off');
    const access = document.createElement('span');
    access.className = 'automation-badge';
    access.textContent = task.access === 'confirm' ? t('automation.accessConfirm') : t('automation.accessOpen');
    head.append(title, badge, access);
    const prompt = document.createElement('p');
    prompt.textContent = task.prompt.length > 130 ? `${task.prompt.slice(0, 130)}…` : task.prompt;
    const meta = document.createElement('div');
    meta.className = 'automation-meta';
    const schedule = document.createElement('span');
    schedule.textContent = automationScheduleLabel(task);
    meta.appendChild(schedule);
    if (task.nextRunAt) {
      const next = document.createElement('span');
      next.textContent = `${t('automation.next')}: ${new Date(task.nextRunAt).toLocaleString(getLanguage())}`;
      meta.appendChild(next);
    }
    if (task.lastStatus) {
      const last = document.createElement('span');
      last.textContent = `${t('automation.last')}: ${task.lastStatus}`;
      meta.appendChild(last);
    }
    const actions = document.createElement('div');
    actions.className = 'automation-actions';
    const run = document.createElement('button');
    run.textContent = task.running ? t('automation.pause') : t('automation.runNow');
    run.onclick = async () => {
      if (task.running) {
        await api('/api/automations/stop', { method: 'POST', body: JSON.stringify({ id: task.id }) });
        toast(t('automation.paused'));
        setTimeout(loadAutomations, 700);
        return;
      }
      const started = await api('/api/automations/run', { method: 'POST', body: JSON.stringify({ id: task.id }) });
      toast(t('automation.started'));
      if (started?.sessionId) {
        closeAutomationPage();
        await openSession(started.sessionId);
        watchAutomationChat(started.sessionId);
        refreshAutomationPause(started.sessionId);
      } else {
        setTimeout(loadAutomations, 800);
      }
    };
    const records = document.createElement('button'); records.textContent = t('automation.records');
    records.onclick = () => showAutomationRecords(task);
    const openChat = document.createElement('button'); openChat.textContent = t('automation.openChat');
    const latestRun = (state.automationRuns || []).find((itemRun) => itemRun.taskId === task.id && itemRun.sessionId);
    const chatSessionId = task.lastSessionId || latestRun?.sessionId;
    openChat.onclick = async () => {
      if (!chatSessionId) { toast(t('automation.noChat')); return; }
      closeAutomationPage();
      await openSession(chatSessionId).catch((error) => toast(error.message));
    };
    const toggle = document.createElement('button'); toggle.textContent = task.enabled ? t('automation.disable') : t('automation.enable');
    toggle.onclick = async () => { await api('/api/automations/toggle', { method: 'POST', body: JSON.stringify({ id: task.id, enabled: !task.enabled }) }); await loadAutomations(); };
    const edit = document.createElement('button'); edit.textContent = t('automation.edit');
    edit.onclick = () => openAutomationEditor(task);
    const del = document.createElement('button'); del.textContent = t('common.delete');
    del.onclick = async () => {
      if (!(await askConfirm(t('automation.deleteConfirm'), t('automation.deleteTitle')))) return;
      const result = await api(`/api/automations?id=${encodeURIComponent(task.id)}`, { method: 'DELETE' });
      await refreshState();
      if ((result.removedSessions || []).includes(state.sessionId)) { state.sessionId = null; clearThread(); resetWorkspaceUi(); await newSession(); }
      await loadAutomations(); toast(t('automation.deleted'));
    };
    actions.append(run, records, openChat, toggle, edit, del);
    card.append(head, prompt, meta, actions);
    box.appendChild(card);
  }
  renderAutomationApproval();
  const runsBox = $('automationRuns');
  runsBox.textContent = '';
  for (const run of state.automationRuns || []) {
    const row = document.createElement('div');
    row.className = 'automation-run';
    const title = document.createElement('strong'); title.textContent = run.title || run.taskId;
    const status = document.createElement('span'); status.textContent = run.status;
    const time = document.createElement('span'); time.textContent = new Date(run.startedAt).toLocaleString(getLanguage());
    const del = document.createElement('button'); del.type = 'button'; del.className = 'automation-run-delete'; del.textContent = t('automation.deleteRun');
    del.onclick = async () => { await deleteAutomationRun(run); toast(t('automation.runDeleted')); };
    row.append(title, status, time, del);
    runsBox.appendChild(row);
  }
}

async function loadAutomations() {
  try {
    const data = await api('/api/automations');
    state.automations = data.tasks || [];
    state.automationRuns = data.runs || [];
    renderAutomations();
  } catch (error) { /* ignore */ }
}

function openAutomationEditor(task = null) {
  $('automationEditorTitle').textContent = task ? t('automation.edit') : t('automation.new');
  $('automationTitle').value = task?.title || '';
  $('automationPrompt').value = task?.prompt || '';
  $('automationType').value = task?.type || 'once';
  for (const button of $('automationAccessGroup').querySelectorAll('[data-access]')) button.classList.toggle('active', button.dataset.access === (task?.access || 'open'));
  $('automationRunAt').value = localDateTimeValue(task?.runAt || Date.now() + 10 * 60000);
  $('automationInterval').value = task?.intervalMinutes || 60;
  $('automationTime').value = task?.time || '09:00';
  buildWeekdayOptions(task?.weekdays || [1, 2, 3, 4, 5]);
  $('automationError').hidden = true;
  $('automationEditor').dataset.taskId = task?.id || '';
  automationTypeFields();
  $('automationEditor').showModal();
}

async function saveAutomation() {
  try {
    const type = $('automationType').value;
    const body = {
      id: $('automationEditor').dataset.taskId || undefined,
      title: $('automationTitle').value.trim(),
      prompt: $('automationPrompt').value.trim(),
      type,
      intervalMinutes: Number($('automationInterval').value) || 60,
      time: $('automationTime').value,
      weekdays: [...$('automationWeekdays').querySelectorAll('input:checked')].map((input) => Number(input.value)),
      enabled: true,
      access: $('automationAccessGroup').querySelector('.active')?.dataset.access || 'open'
    };
    if (type === 'once') {
      const ms = new Date($('automationRunAt').value.trim().replace(' ', 'T')).getTime();
      if (!Number.isFinite(ms)) throw new Error(t('automation.needTime'));
      body.runAt = ms;
    }
    if (!body.title || !body.prompt) throw new Error(t('automation.needFields'));
    if (['daily', 'weekly'].includes(type) && !/^\d{2}:\d{2}$/.test(body.time)) throw new Error(t('automation.needTime'));
    await api('/api/automations', { method: 'POST', body: JSON.stringify(body) });
    $('automationEditor').close();
    await loadAutomations();
    toast(t('common.saved'));
  } catch (error) {
    $('automationError').textContent = error.message;
    $('automationError').hidden = false;
  }
}

async function openAutomationPage() {
  $('automationPage').hidden = false;
  $('railAutomation').classList.add('active');
  await loadAutomations();
  if (state.automationTimer) clearInterval(state.automationTimer);
  state.automationTimer = setInterval(loadAutomations, 15000);
}

function closeAutomationPage() {
  $('automationPage').hidden = true;
  $('railAutomation').classList.remove('active');
  if (state.automationTimer) { clearInterval(state.automationTimer); state.automationTimer = null; }
}

function openPluginsPage() {
  const config = state.config || {};
  $('searchToggle').checked = Boolean(config.searchEnabled);
  $('dispatchToggle').checked = true;
  const limit = Number(config.thinkingLimit) || 0;
  $('thinkingUnlimited').checked = limit === 0;
  $('thinkingLimitInput').disabled = limit === 0;
  if (limit) $('thinkingLimitInput').value = limit;
  $('pluginsPage').hidden = false;
  $('railPlugins').classList.add('active');
  loadToolCatalog();
  renderBrowserToggles();
}

function closePluginsPage() {
  $('pluginsPage').hidden = true;
  $('railPlugins').classList.remove('active');
}

async function saveSettingsPatch(patch) {
  const { config } = await api('/api/config', { method: 'POST', body: JSON.stringify(patch) });
  state.config = config;
  applyConfig(config);
  return config;
}

function renderPermissionMenu() {
  const current = state.config?.permission || 'confirm';
  document.querySelectorAll('.permission-option').forEach((option) => {
    option.classList.toggle('selected', option.dataset.level === current);
  });
  const labels = { forbidden: '禁止访问', confirm: '确认访问', open: '开放访问' };
  if ($('permissionLabel')) $('permissionLabel').textContent = labels[current] || '访问权限';
}

async function setPermission(level) {
  try {
    await saveSettingsPatch({ permission: level });
    renderPermissionMenu();
    $('permissionMenu').hidden = true;
    addActivity('访问权限已更新', level === 'forbidden' ? '禁止访问' : level === 'confirm' ? '确认访问' : '开放访问', 'approve', 0);
  } catch (error) {
    toast(error.message);
  }
}


async function loadMcpServers() {
  try {
    const { servers } = await api('/api/mcp');
    state.mcpServers = servers || [];
    renderMcpList();
    return servers;
  } catch (error) {
    toast(error.message);
    return [];
  }
}

function renderMcpList() {
  const list = $('mcpList');
  if (!list) return;
  list.textContent = '';
  const servers = state.mcpServers || [];
  if (!servers.length) {
    const empty = document.createElement('p');
    empty.className = 'settings-note';
    empty.textContent = '还没有连接 MCP 服务。填下面的命令即可接入。';
    list.appendChild(empty);
    return;
  }
  for (const server of servers) {
    const row = document.createElement('div');
    row.className = 'mcp-row';
    const dot = document.createElement('span');
    dot.className = 'mcp-dot' + (server.status === 'connected' ? ' on' : server.status === 'error' ? ' err' : '');
    const meta = document.createElement('div');
    meta.className = 'mcp-meta';
    const title = document.createElement('strong');
    title.textContent = server.name;
    const detail = document.createElement('small');
    const count = server.tools?.length || 0;
    detail.textContent = `${server.command} ${(server.args || []).join(' ')} · ${server.status === 'connected' ? `${count} 个工具` : server.status}`;
    meta.append(title, detail);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '移除';
    remove.addEventListener('click', async () => {
      const servers = (state.mcpServers || []).filter((item) => item.name !== server.name);
      await saveMcpServers(servers);
    });
    row.append(dot, meta, remove);
    list.appendChild(row);
  }
}

async function saveMcpServers(servers) {
  const payload = servers.map((item) => ({
    name: item.name, command: item.command, args: item.args || [], enabled: item.enabled !== false
  }));
  await api('/api/mcp', { method: 'POST', body: JSON.stringify({ servers: payload }) });
  await loadMcpServers();
}


async function loadToolCatalog() {
  try {
    const data = await api('/api/tools');
    state.toolGroups = data.groups || [];
    renderToolGroups();
  } catch { /* keep previous */ }
}

async function saveDisabledTools(list) {
  const unique = [...new Set(list)];
  const { config } = await api('/api/config', { method: 'POST', body: JSON.stringify({ disabledTools: unique }) });
  state.config = config;
  await loadToolCatalog();
}

const GROUP_ICONS = {
  files: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>',
  documents: '<path d="M6 3h7l5 5v13H6z"/><path d="M13 3v5h5"/><path d="M9 13h6M9 16h5"/>',
  pdf: '<path d="M6 3h7l5 5v13H6z"/><path d="M13 3v5h5"/><path d="M9 14h6"/>',
  images: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="M4 17l5-4 4 3 3-2 4 3"/>',
  media: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M10 9l5 3-5 3z"/>',
  browser: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 8h18"/><circle cx="6" cy="6" r=".6" fill="currentColor"/><circle cx="8.5" cy="6" r=".6" fill="currentColor"/>',
  code: '<path d="M9 8l-4 4 4 4M15 8l4 4-4 4"/>',
  services: '<circle cx="12" cy="12" r="3.2"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>',
  office: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 16v-4M11 16V8M15 16v-6M19 16v-2"/>',
  verify: '<circle cx="12" cy="12" r="8"/><path d="M8 12.5l2.5 2.5 5-5.5"/>',
  vision: '<path d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="2.8"/>',
  memory: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  mcp: '<path d="M9 3v5M15 3v5"/><rect x="6" y="8" width="12" height="7" rx="2"/><path d="M12 15v6"/>',
  system: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M9 20h6M12 16v4"/>',
  dev: '<path d="M14.5 4.5a4 4 0 0 1 5 5L10 19l-5-5 9.5-9.5z"/><path d="M4 20l3-3"/>',
};

function renderToolGroups() {
  const box = $('toolGroups');
  if (!box) return;
  box.textContent = '';
  for (const group of state.toolGroups || []) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'plugin-group-btn';

    const icon = document.createElement('span');
    icon.className = 'tool-group-icon';
    icon.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${GROUP_ICONS[group.id] || GROUP_ICONS.system}</svg>`;

    const text = document.createElement('div');
    text.className = 'plugin-group-text';
    const title = document.createElement('strong');
    title.textContent = group.label;
    const meta = document.createElement('small');
    meta.textContent = `${group.tools.length} 个工具`;
    text.append(title, meta);

    const arrow = document.createElement('span');
    arrow.className = 'plugin-group-arrow';
    arrow.textContent = '›';
    card.append(icon, text, arrow);
    card.addEventListener('click', () => openSubTools(group.id));
    box.appendChild(card);
  }
  const count = $('pluginsCount');
  if (count) {
    const total = (state.toolGroups || []).reduce((sum, group) => sum + group.tools.length, 0);
    count.textContent = `${(state.toolGroups || []).length} 组 · ${total} 个工具`;
  }
}

function openSubTools(groupId) {
  state.subToolsGroup = groupId;
  renderSubTools();
  if (!$('subTools').open) $('subTools').showModal();
}

function renderSubTools() {
  const group = (state.toolGroups || []).find((item) => item.id === state.subToolsGroup);
  if (!group) return;
  $('subToolsTitle').textContent = group.label;
  $('subToolsDesc').textContent = group.description || '';
  $('subToolsCount').textContent = `${group.tools.filter((tool) => tool.enabled).length} / ${group.tools.length} 已启用`;
  $('subToolsMaster').checked = group.tools.every((tool) => tool.enabled);
  const list = $('subToolsList');
  list.textContent = '';
  for (const tool of group.tools) {
    const row = document.createElement('div');
    row.className = 'subtools-row';
    const dot = document.createElement('span');
    dot.className = 'subtools-dot' + (tool.enabled ? ' on' : '');
    const info = document.createElement('div');
    info.className = 'subtools-info';
    const name = document.createElement('strong');
    name.textContent = tool.name;
    const desc = document.createElement('small');
    desc.textContent = tool.label || '内置工具';
    info.append(name, desc);
    const sw = document.createElement('label');
    sw.className = 'switch small';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = tool.enabled;
    const track = document.createElement('span');
    track.className = 'switch-track';
    sw.append(cb, track);
    cb.addEventListener('change', () => setToolEnabled([tool.name], cb.checked));
    row.append(dot, info, sw);
    list.appendChild(row);
  }
}

async function setToolEnabled(names, enabled) {
  const disabled = new Set(state.config?.disabledTools || []);
  for (const name of names) {
    if (enabled) disabled.delete(name); else disabled.add(name);
  }
  await saveDisabledTools([...disabled]);
  renderSubTools();
  renderToolGroups();
}

async function boot() {
  applyTheme(localStorage.getItem('nalo-code-theme') || 'light');
  applyHistoryCollapsed();
  const lang = localStorage.getItem('nalo-code-lang') || 'zh-CN';
  setLanguage(lang);
  bind();
  initTooltips();
  initResizer();
  $('stop').textContent = '暂停';
  autoGrow();
  renderAttachments();

  window.addEventListener('pagehide', () => { try { navigator.sendBeacon('/api/session/flush'); } catch { } });

  try {
    await loadMaintenance();
    await refreshState();
    await loadAnnouncements();
    if (state.app?.banned) { showBanNotice(state.app.banMessage); openLogin(); return; }
    if (!state.app?.authenticated) { openLogin(); return; }
    const license = await checkLicense();
    if (license?.required && !license.licensed) return;
    if (!state.sessions.length) await newSession();
    else {
      state.sessionId = state.sessions[0].id;
      await openSession(state.sessionId);
    }
    await loadTree();
    loadUpdates();
    await checkLicense();
    setInterval(() => { if (state.license?.required) checkLicense(); }, 5000);
    setInterval(() => loadUpdates(), 6 * 3600e3);
    startAutomationSessionPolling();
    const params = new URLSearchParams(location.search);
    if (params.get('theme')) applyTheme(params.get('theme'));
    const preview = params.get('page');
    if (preview) setTimeout(() => openPreview(preview), 250);
  } catch (error) {
    toast(error.message);
  }
}

boot();
