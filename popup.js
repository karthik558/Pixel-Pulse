const STORAGE_KEYS = {
  GLOBAL_ENABLED: 'globalEnabled',
  RULES: 'rules',
  THEME: 'theme',
};
const LOCAL_KEYS = {
  LAST_STATUS: 'lastStatus',
};

const DEFAULT_STATE = {
  globalEnabled: true,
  rules: [],
  theme: 'dark',
};

const elements = {};
let state = { ...DEFAULT_STATE };
let statusTimer = null;

document.addEventListener('DOMContentLoaded', () => {
  cacheElements();
  bindGlobalEvents();
  bootstrap();
});

function cacheElements() {
  elements.globalToggle = document.querySelector('#globalToggle');
  elements.statusText = document.querySelector('#statusText');
  elements.rulesContainer = document.querySelector('#rulesContainer');
  elements.addRuleForm = document.querySelector('#addRuleForm');
  elements.addRuleName = document.querySelector('#addRuleName');
  elements.addRulePattern = document.querySelector('#addRulePattern');
  elements.addRuleInterval = document.querySelector('#addRuleInterval');
  elements.addRuleActivity = document.querySelector('#addRuleActivity');
  elements.themeToggle = document.querySelector('#themeToggle');
}

function bindGlobalEvents() {
  elements.globalToggle.addEventListener('change', onGlobalToggleChange);
  elements.addRuleForm.addEventListener('submit', onAddRuleSubmit);

  elements.rulesContainer.addEventListener('change', onRuleChange);
  elements.rulesContainer.addEventListener('click', onRuleClick);

  chrome.storage.onChanged.addListener(handleStorageChange);

  elements.themeToggle.addEventListener('click', onThemeToggleClick);
}

async function bootstrap() {
  await loadState();
  render();
  await updateStatusIndicator();
  if (statusTimer) {
    clearInterval(statusTimer);
  }
  statusTimer = setInterval(updateStatusIndicator, 10000);
}

async function loadState() {
  const stored = await chrome.storage.sync.get([
    STORAGE_KEYS.GLOBAL_ENABLED,
    STORAGE_KEYS.RULES,
    STORAGE_KEYS.THEME,
  ]);
  state = {
    globalEnabled: stored[STORAGE_KEYS.GLOBAL_ENABLED] !== false,
    rules: Array.isArray(stored[STORAGE_KEYS.RULES]) ? stored[STORAGE_KEYS.RULES] : [],
    theme: validateTheme(stored[STORAGE_KEYS.THEME]),
  };
}

function render() {
  elements.globalToggle.checked = state.globalEnabled;
  renderRules();
  applyTheme(state.theme);
  updateThemeToggle();
}

function renderRules() {
  elements.rulesContainer.innerHTML = '';
  if (!state.rules.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'No rules yet. Add a heartbeat below to get started.';
    elements.rulesContainer.appendChild(empty);
    return;
  }

  for (const rule of state.rules) {
    const ruleEl = document.createElement('section');
    ruleEl.className = 'rule';
    ruleEl.dataset.id = rule.id;
    ruleEl.innerHTML = `
      <div class="rule-header">
        <input type="text" class="rule-name" value="${escapeHtml(rule.name || '')}" placeholder="Rule name" />
        <label class="switch">
          <input type="checkbox" class="rule-enabled"${rule.enabled === false ? '' : ' checked'} />
          <span class="slider"></span>
        </label>
      </div>
      <input type="text" class="rule-pattern" value="${escapeHtml(rule.pattern || '')}" placeholder="URL pattern (supports *)" />
      <div class="rule-grid">
        <label class="rule-field">
          <span>Interval (min)</span>
          <input type="number" class="rule-interval" min="1" value="${Number(rule.intervalMinutes) || 1}" />
        </label>
        <label class="rule-field">
          <span>Activity</span>
          <select class="rule-activity">
            ${renderActivityOptions(rule.activity)}
          </select>
        </label>
      </div>
      <div class="rule-actions">
        <button type="button" class="rule-save">Save</button>
        <button type="button" class="rule-delete">Delete</button>
      </div>
    `;
    elements.rulesContainer.appendChild(ruleEl);
  }
}

function renderActivityOptions(selected) {
  const options = [
    { value: 'mousemove', label: 'Mouse Pulse' },
    { value: 'scroll', label: 'Scroll Nudge' },
    { value: 'ping', label: 'Network Ping' },
    { value: 'refresh', label: 'Page Refresh (idle only)' },
  ];
  return options
    .map(
      (option) =>
        `<option value="${option.value}"${option.value === selected ? ' selected' : ''}>${option.label}</option>`,
    )
    .join('');
}

async function onGlobalToggleChange(event) {
  const enabled = event.target.checked;
  await chrome.storage.sync.set({ [STORAGE_KEYS.GLOBAL_ENABLED]: enabled });
}

async function onAddRuleSubmit(event) {
  event.preventDefault();
  const name = elements.addRuleName.value.trim();
  const pattern = elements.addRulePattern.value.trim();
  const interval = parseInt(elements.addRuleInterval.value, 10) || 1;
  const activity = elements.addRuleActivity.value;

  if (!name || !pattern) {
    showStatus('Please provide both a name and pattern to add a rule.');
    return;
  }

  const newRule = {
    id: createRuleId(),
    name,
    pattern,
    intervalMinutes: Math.max(1, interval),
    enabled: true,
    activity,
  };

  const nextRules = [...state.rules, newRule];
  await chrome.storage.sync.set({ [STORAGE_KEYS.RULES]: nextRules });
  elements.addRuleForm.reset();
}

async function onRuleChange(event) {
  const target = event.target;
  const ruleEl = target.closest('.rule');
  if (!ruleEl) {
    return;
  }
  const ruleId = ruleEl.dataset.id;
  if (!ruleId) {
    return;
  }

  if (target.classList.contains('rule-enabled')) {
    const enabled = target.checked;
    await updateRule(ruleId, { enabled });
  }
}

async function onRuleClick(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  const ruleEl = target.closest('.rule');
  if (!ruleEl) {
    return;
  }
  const ruleId = ruleEl.dataset.id;
  if (!ruleId) {
    return;
  }

  if (target.classList.contains('rule-save')) {
    const updated = readRuleFromElement(ruleEl);
    if (!updated.name || !updated.pattern) {
      showStatus('Rule requires both a name and URL pattern.');
      return;
    }
    await updateRule(ruleId, updated);
  }

  if (target.classList.contains('rule-delete')) {
    await deleteRule(ruleId);
  }
}

function readRuleFromElement(root) {
  const name = root.querySelector('.rule-name')?.value.trim() || '';
  const pattern = root.querySelector('.rule-pattern')?.value.trim() || '';
  const interval = parseInt(root.querySelector('.rule-interval')?.value, 10) || 1;
  const activity = root.querySelector('.rule-activity')?.value || 'mousemove';
  const enabled = root.querySelector('.rule-enabled')?.checked !== false;
  return {
    name,
    pattern,
    intervalMinutes: Math.max(1, interval),
    activity,
    enabled,
  };
}

async function updateRule(ruleId, updates) {
  const nextRules = state.rules.map((rule) => {
    if (rule.id === ruleId) {
      return { ...rule, ...updates };
    }
    return rule;
  });
  await chrome.storage.sync.set({ [STORAGE_KEYS.RULES]: nextRules });
}

async function deleteRule(ruleId) {
  const nextRules = state.rules.filter((rule) => rule.id !== ruleId);
  await chrome.storage.sync.set({ [STORAGE_KEYS.RULES]: nextRules });
}

async function updateStatusIndicator() {
  const [{ lastStatus }, settings, activeTab] = await Promise.all([
    chrome.storage.local.get([LOCAL_KEYS.LAST_STATUS]),
    chrome.storage.sync.get([STORAGE_KEYS.GLOBAL_ENABLED, STORAGE_KEYS.RULES]),
    queryActiveTab(),
  ]);

  const globalEnabled = settings[STORAGE_KEYS.GLOBAL_ENABLED] !== false;
  const rules = Array.isArray(settings[STORAGE_KEYS.RULES]) ? settings[STORAGE_KEYS.RULES] : [];

  if (!globalEnabled) {
    elements.statusText.textContent = 'Inactive (paused)';
    return;
  }

  if (!activeTab || !isHttpUrl(activeTab.url)) {
    elements.statusText.textContent = 'Inactive (no active page)';
    return;
  }

  const matchingRule = findMatchingRule(activeTab.url, rules);
  if (!matchingRule) {
    elements.statusText.textContent = 'Inactive (no matching rule)';
    return;
  }

  const status = lastStatus || {};
  if (status.state === 'error' && status.ruleId === matchingRule.id) {
    elements.statusText.textContent = 'Error (check console)';
    return;
  }

  if (status.state === 'inactive' && status.ruleId === matchingRule.id) {
    if (status.reason === 'user-active') {
      elements.statusText.textContent = 'Inactive (waiting for idle)';
      return;
    }
    elements.statusText.textContent = 'Inactive';
    return;
  }

  const lastRunAt = status.ruleId === matchingRule.id ? status.lastRunAt : undefined;
  const suffix = lastRunAt ? ` · Last pulse ${formatRelative(lastRunAt)}` : '';
  elements.statusText.textContent = `Active: ${matchingRule.name}${suffix}`;
}

function handleStorageChange(changes, area) {
  if (area === 'sync') {
    let needsRender = false;
    if (STORAGE_KEYS.GLOBAL_ENABLED in changes) {
      state.globalEnabled = changes[STORAGE_KEYS.GLOBAL_ENABLED].newValue !== false;
      needsRender = true;
    }
    if (STORAGE_KEYS.RULES in changes) {
      state.rules = Array.isArray(changes[STORAGE_KEYS.RULES].newValue)
        ? changes[STORAGE_KEYS.RULES].newValue
        : [];
      needsRender = true;
    }
    if (STORAGE_KEYS.THEME in changes) {
      state.theme = validateTheme(changes[STORAGE_KEYS.THEME].newValue);
      applyTheme(state.theme);
      updateThemeToggle();
    }
    if (needsRender) {
      render();
    }
  }

  if (area === 'local' && LOCAL_KEYS.LAST_STATUS in changes) {
    updateStatusIndicator();
  }
}

function queryActiveTab() {
  return chrome.tabs.query({ active: true, lastFocusedWindow: true }).then((tabs) => tabs[0]);
}

function findMatchingRule(url, rules) {
  return rules.find((rule) => rule.enabled !== false && rule.pattern && matchesPattern(url, rule.pattern));
}

function matchesPattern(url, pattern) {
  const escaped = pattern
    .split('*')
    .map((segment) => segment.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  try {
    return new RegExp(`^${escaped}$`).test(url);
  } catch (error) {
    return false;
  }
}

function isHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

function formatRelative(timestamp) {
  const deltaMs = Date.now() - timestamp;
  if (deltaMs < 0) {
    return 'just now';
  }
  const deltaMinutes = Math.floor(deltaMs / 60000);
  if (deltaMinutes <= 0) {
    const seconds = Math.max(1, Math.floor(deltaMs / 1000));
    return `${seconds}s ago`;
  }
  if (deltaMinutes < 60) {
    return `${deltaMinutes}m ago`;
  }
  const hours = Math.floor(deltaMinutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function showStatus(message) {
  elements.statusText.textContent = message;
}

function createRuleId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `rule-${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function applyTheme(theme) {
  const nextTheme = validateTheme(theme);
  document.documentElement.setAttribute('data-theme', nextTheme);
}

function validateTheme(theme) {
  return theme === 'light' ? 'light' : 'dark';
}

function updateThemeToggle() {
  if (!elements.themeToggle) {
    return;
  }
  const isDark = state.theme !== 'light';
  elements.themeToggle.setAttribute('aria-pressed', String(isDark));
  elements.themeToggle.classList.toggle('is-dark', isDark);
  elements.themeToggle.classList.toggle('is-light', !isDark);
  const nextLabel = isDark ? 'Switch to light mode' : 'Switch to dark mode';
  elements.themeToggle.setAttribute('aria-label', nextLabel);
  elements.themeToggle.setAttribute('title', nextLabel);
}

async function onThemeToggleClick() {
  const nextTheme = state.theme === 'dark' ? 'light' : 'dark';
  state.theme = nextTheme;
  applyTheme(nextTheme);
  updateThemeToggle();
  await chrome.storage.sync.set({ [STORAGE_KEYS.THEME]: nextTheme });
}
