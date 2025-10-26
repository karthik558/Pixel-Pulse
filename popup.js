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
  elements.brandLogo = document.querySelector('#brandLogo');
}

function bindGlobalEvents() {
  if (elements.globalToggle) {
    elements.globalToggle.addEventListener('change', onGlobalToggleChange);
  }
  elements.addRuleForm.addEventListener('submit', onAddRuleSubmit);

  elements.rulesContainer.addEventListener('change', onRuleChange);
  elements.rulesContainer.addEventListener('click', onRuleClick);
  elements.rulesContainer.addEventListener('keydown', onRuleKeyDown);

  chrome.storage.onChanged.addListener(handleStorageChange);
  if (elements.brandLogo) {
    elements.brandLogo.addEventListener('click', onThemeToggleClick);
    elements.brandLogo.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onThemeToggleClick();
      }
    });
  }
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
  if (elements.globalToggle) {
    elements.globalToggle.checked = state.globalEnabled;
  }
  renderRules();
  applyTheme(state.theme);
  updateBrandLogo();
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
    const collapsibleId = `rule-details-${rule.id}`;
    ruleEl.innerHTML = `
      <div class="rule-header" role="button" tabindex="0" aria-expanded="false" aria-controls="${collapsibleId}">
        <div class="rule-header-main">
          <span class="rule-caret" aria-hidden="true">
            <svg class="rule-caret-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </span>
          <input type="text" class="rule-name" value="${escapeHtml(rule.name || '')}" placeholder="Rule name" />
        </div>
        <label class="switch" title="Enable/disable">
          <input type="checkbox" class="rule-enabled"${rule.enabled === false ? '' : ' checked'} />
          <span class="slider"></span>
        </label>
      </div>
      <div id="${collapsibleId}" class="collapsible" hidden>
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

  // Toggle expand/collapse when clicking the header (but not on inputs/buttons/switch)
  const header = target.closest('.rule-header');
  const isInteractive = target.closest('button, input, select, label');
  if (header && !isInteractive) {
    toggleRuleExpansion(ruleEl);
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

function onRuleKeyDown(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const header = target.closest('.rule-header');
  if (!header) return;
  const isInteractive = target.closest('input, select, button, label');
  if (isInteractive) return;
  const key = event.key;
  if (key === 'Enter' || key === ' ') {
    event.preventDefault();
    const ruleEl = header.closest('.rule');
    if (ruleEl) toggleRuleExpansion(ruleEl);
  }
}

function toggleRuleExpansion(ruleEl) {
  const isExpanded = ruleEl.classList.toggle('expanded');
  const collapsible = ruleEl.querySelector('.collapsible');
  const header = ruleEl.querySelector('.rule-header');
  if (collapsible) {
    if (isExpanded) {
      collapsible.removeAttribute('hidden');
    } else {
      collapsible.setAttribute('hidden', '');
    }
  }
  if (header) {
    header.setAttribute('aria-expanded', String(isExpanded));
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
  if (!elements.statusText) return;

  const [{ lastStatus }, settings] = await Promise.all([
    chrome.storage.local.get([LOCAL_KEYS.LAST_STATUS]),
    chrome.storage.sync.get([STORAGE_KEYS.GLOBAL_ENABLED]),
  ]);

  const globalEnabled = settings[STORAGE_KEYS.GLOBAL_ENABLED] !== false;
  if (!globalEnabled) {
    elements.statusText.textContent = 'Inactive (paused)';
    return;
  }

  const status = lastStatus || {};
  if (status.state === 'active') {
    const suffix = status.lastRunAt ? ` · Last pulse ${formatRelative(status.lastRunAt)}` : '';
    elements.statusText.textContent = `Active: ${status.ruleName || 'Rule'}${suffix}`;
    return;
  }

  if (status.state === 'error') {
    elements.statusText.textContent = 'Error (check console)';
    return;
  }

  if (status.state === 'inactive') {
    if (status.reason === 'user-active') {
      elements.statusText.textContent = 'Inactive (waiting for idle)';
      return;
    }
    if (status.reason === 'no-rules') {
      elements.statusText.textContent = 'Inactive (no rules)';
      return;
    }
    if (status.reason === 'no-match') {
      elements.statusText.textContent = 'Inactive (no matching tab)';
      return;
    }
  }

  elements.statusText.textContent = 'Inactive';
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
      updateBrandLogo();
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
  if (elements.statusText) {
    elements.statusText.textContent = message;
  }
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

// Theme toggle is handled by clicking the brand logo now; no separate toggle button element.

async function onThemeToggleClick() {
  const nextTheme = state.theme === 'dark' ? 'light' : 'dark';
  state.theme = nextTheme;
  applyTheme(nextTheme);
  updateBrandLogo();
  await chrome.storage.sync.set({ [STORAGE_KEYS.THEME]: nextTheme });
}

function updateBrandLogo() {
  const logo = elements.brandLogo;
  if (!logo) return;
  const theme = validateTheme(state.theme);
  const darkSrc = logo.getAttribute('data-src-dark') || 'logo_dark.png';
  const lightSrc = logo.getAttribute('data-src-light') || 'logo_light.png';
  logo.src = theme === 'light' ? lightSrc : darkSrc;
  const nextLabel = theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode';
  logo.setAttribute('aria-label', nextLabel);
}
