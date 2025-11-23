const STORAGE_KEYS = {
  GLOBAL_ENABLED: 'globalEnabled',
  RULES: 'rules',
  THEME: 'theme',
};

const DEFAULT_STATE = {
  globalEnabled: true,
  rules: [],
  theme: 'dark',
};

let state = { ...DEFAULT_STATE };

document.addEventListener('DOMContentLoaded', async () => {
  try {
    await loadState();
    initializeUI();
    render();
  } catch (error) {
    console.error('Failed to initialize:', error);
    document.body.innerHTML = `<div style="padding:20px;color:red">Error loading extension: ${error.message}</div>`;
  }
});

async function loadState() {
  const stored = await chrome.storage.sync.get([
    STORAGE_KEYS.GLOBAL_ENABLED,
    STORAGE_KEYS.RULES,
    STORAGE_KEYS.THEME,
  ]);
  state = {
    globalEnabled: stored[STORAGE_KEYS.GLOBAL_ENABLED] !== false,
    rules: Array.isArray(stored[STORAGE_KEYS.RULES]) ? stored[STORAGE_KEYS.RULES] : [],
    theme: stored[STORAGE_KEYS.THEME] || 'dark',
  };
}

function initializeUI() {
  // Global Toggle
  const globalToggle = document.getElementById('globalToggle');
  globalToggle.addEventListener('change', async (e) => {
    state.globalEnabled = e.target.checked;
    await chrome.storage.sync.set({ [STORAGE_KEYS.GLOBAL_ENABLED]: state.globalEnabled });
    renderStatus();
  });

  // Theme Toggle
  const themeToggle = document.getElementById('themeToggle');
  themeToggle.addEventListener('click', async () => {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    await chrome.storage.sync.set({ [STORAGE_KEYS.THEME]: state.theme });
    applyTheme();
  });

  // Add Rule Form
  const addForm = document.getElementById('addRuleForm');
  addForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    await addRule();
  });

  // Rules List Delegation
  const rulesContainer = document.getElementById('rulesContainer');
  rulesContainer.addEventListener('click', handleRuleClick);
  rulesContainer.addEventListener('change', handleRuleChange);
}

function render() {
  applyTheme();
  renderStatus();
  renderRules();

  const globalToggle = document.getElementById('globalToggle');
  globalToggle.checked = state.globalEnabled;
}

function applyTheme() {
  document.documentElement.setAttribute('data-theme', state.theme);
}

function renderStatus() {
  const statusText = document.getElementById('statusText');
  if (state.globalEnabled) {
    statusText.textContent = 'Active';
    statusText.style.color = 'var(--accent)';
  } else {
    statusText.textContent = 'Paused';
    statusText.style.color = 'var(--text-secondary)';
  }
}

function renderRules() {
  const container = document.getElementById('rulesContainer');
  container.innerHTML = '';

  if (state.rules.length === 0) {
    container.innerHTML = '<div class="empty-state">No active rules. Add one below.</div>';
    return;
  }

  state.rules.forEach(rule => {
    const card = document.createElement('div');
    card.className = 'rule-card';
    card.dataset.id = rule.id;

    card.innerHTML = `
      <div class="rule-header">
        <div class="rule-info">
          <div class="rule-icon">
            ${getIcon(rule.activity)}
          </div>
          <div class="rule-details-text">
            <span class="rule-name">${escapeHtml(rule.name)}</span>
            <span class="rule-pattern">${escapeHtml(rule.pattern)}</span>
          </div>
        </div>
        <div class="rule-expand-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
        </div>
      </div>
      <div class="rule-body">
        <div class="input-row">
          <div class="input-wrapper">
            <input type="number" class="edit-interval" value="${rule.intervalMinutes}" min="1">
            <span class="unit">min</span>
          </div>
          <select class="edit-activity">
            <option value="mousemove" ${rule.activity === 'mousemove' ? 'selected' : ''}>Mouse Pulse</option>
            <option value="scroll" ${rule.activity === 'scroll' ? 'selected' : ''}>Scroll Nudge</option>
            <option value="ping" ${rule.activity === 'ping' ? 'selected' : ''}>Network Ping</option>
            <option value="refresh" ${rule.activity === 'refresh' ? 'selected' : ''}>Page Refresh</option>
          </select>
        </div>
        <div class="rule-actions">
          <label class="switch" style="transform:scale(0.8); transform-origin:left;">
            <input type="checkbox" class="edit-enabled" ${rule.enabled ? 'checked' : ''}>
            <span class="slider"></span>
          </label>
          <button class="delete-btn">Delete</button>
        </div>
      </div>
    `;
    container.appendChild(card);
  });
}

async function addRule() {
  const nameInput = document.getElementById('addRuleName');
  const patternInput = document.getElementById('addRulePattern');
  const intervalInput = document.getElementById('addRuleInterval');
  const activityInput = document.getElementById('addRuleActivity');

  const name = nameInput.value.trim();
  const pattern = patternInput.value.trim();

  if (!name || !pattern) return;

  const newRule = {
    id: crypto.randomUUID(),
    name,
    pattern,
    intervalMinutes: parseInt(intervalInput.value) || 5,
    activity: activityInput.value,
    enabled: true
  };

  state.rules.push(newRule);
  await chrome.storage.sync.set({ [STORAGE_KEYS.RULES]: state.rules });

  nameInput.value = '';
  patternInput.value = '';
  renderRules();
}

async function handleRuleClick(e) {
  const card = e.target.closest('.rule-card');
  if (!card) return;

  const ruleId = card.dataset.id;

  // Toggle Expand
  if (e.target.closest('.rule-header')) {
    card.classList.toggle('expanded');
    return;
  }

  // Delete
  if (e.target.classList.contains('delete-btn')) {
    if (confirm('Delete this rule?')) {
      state.rules = state.rules.filter(r => r.id !== ruleId);
      await chrome.storage.sync.set({ [STORAGE_KEYS.RULES]: state.rules });
      renderRules();
    }
  }
}

async function handleRuleChange(e) {
  const card = e.target.closest('.rule-card');
  if (!card) return;

  const ruleId = card.dataset.id;
  const rule = state.rules.find(r => r.id === ruleId);
  if (!rule) return;

  if (e.target.classList.contains('edit-enabled')) {
    rule.enabled = e.target.checked;
  } else if (e.target.classList.contains('edit-interval')) {
    rule.intervalMinutes = parseInt(e.target.value) || 1;
  } else if (e.target.classList.contains('edit-activity')) {
    rule.activity = e.target.value;
  }

  await chrome.storage.sync.set({ [STORAGE_KEYS.RULES]: state.rules });
}

function getIcon(activity) {
  const icons = {
    mousemove: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/></svg>',
    scroll: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="2" width="14" height="20" rx="7"/><line x1="12" y1="6" x2="12" y2="10"/></svg>',
    ping: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><path d="M22 6l-10 7L2 6"/></svg>',
    refresh: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"/></svg>'
  };
  return icons[activity] || icons.mousemove;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
