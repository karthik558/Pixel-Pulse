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
  // Initial render of the list
  renderRulesList();

  const globalToggle = document.getElementById('globalToggle');
  globalToggle.checked = state.globalEnabled;

  // Auto-refresh status every 2 seconds without rebuilding DOM
  setInterval(() => {
    if (state.globalEnabled) {
      updateRuleStatuses();
    }
  }, 2000);
}

function applyTheme() {
  document.documentElement.setAttribute('data-theme', state.theme);
}

function renderStatus() {
  const statusText = document.getElementById('statusText');
  const isEnabled = state.globalEnabled;

  document.body.classList.toggle('global-disabled', !isEnabled);

  if (isEnabled) {
    statusText.textContent = 'Active';
    statusText.style.color = 'var(--accent)';
  } else {
    statusText.textContent = 'Paused';
    statusText.style.color = 'var(--text-secondary)';
  }
}

async function renderRulesList() {
  const container = document.getElementById('rulesContainer');

  if (state.rules.length === 0) {
    container.innerHTML = '<div class="empty-state">No active rules. Add one below.</div>';
    return;
  }

  // Check if we need to rebuild (e.g. rule added/removed)
  // For now, we'll just rebuild if the count differs or if it's empty
  // A more robust diffing could be added, but this suffices for "add/delete" actions
  // which trigger a re-render anyway.

  // We will rebuild the list, but the interval will ONLY call updateRuleStatuses

  const newContent = document.createElement('div');
  newContent.className = 'rules-list-wrapper';

  for (const rule of state.rules) {
    const card = document.createElement('div');
    card.className = 'rule-card';
    card.dataset.id = rule.id;

    // Preserve expanded state if existing card matches
    const existingCard = document.querySelector(`.rule-card[data-id="${rule.id}"]`);
    if (existingCard && existingCard.classList.contains('expanded')) {
      card.classList.add('expanded');
    }

    // Initial status placeholder
    const statusHtml = `
      <div class="rule-status-info">
        <div class="status-item">
          <span class="status-value status-text">Loading...</span>
        </div>
      </div>
    `;

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
        ${statusHtml}
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
          <div style="display:flex; gap:8px;">
            <button class="run-now-btn" title="Run this rule immediately">Run Now</button>
            <button class="delete-btn">Delete</button>
          </div>
        </div>
      </div>
    `;
    newContent.appendChild(card);
  }

  container.innerHTML = '';
  container.appendChild(newContent);

  // Immediately update status after rendering
  updateRuleStatuses();
}

async function updateRuleStatuses() {
  const localData = await chrome.storage.local.get(['lastRuleExecutions']);
  const lastExecutions = localData.lastRuleExecutions || {};
  const now = Date.now();
  const tabs = await chrome.tabs.query({});

  state.rules.forEach(rule => {
    const card = document.querySelector(`.rule-card[data-id="${rule.id}"]`);
    if (!card) return;

    const statusContainer = card.querySelector('.rule-status-info');
    if (!statusContainer) return;

    // Check matches
    const matches = tabs.some(t => {
      try {
        const cleanPattern = rule.pattern.trim();
        const cleanUrl = t.url.trim();
        // Simple substring match if no wildcards
        if (!cleanPattern.includes('*')) {
          return cleanUrl.toLowerCase().includes(cleanPattern.toLowerCase());
        }
        // Glob matching
        let pattern = cleanPattern;
        if (!/^[a-zA-Z0-9+.-]+:\/\//.test(pattern) && !pattern.startsWith('*://')) {
          pattern = '*://' + pattern;
        }
        const protocolIndex = pattern.indexOf('://');
        const afterProtocol = pattern.substring(protocolIndex + 3);
        if (!afterProtocol.includes('/')) {
          pattern += '/*';
        }
        const escaped = pattern.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
        const isMatch = new RegExp(`^${escaped}$`, 'i').test(cleanUrl);
        if (isMatch) console.log('[Pixel Pulse] Match found:', cleanUrl, 'for pattern:', rule.pattern);
        return isMatch;
      } catch (e) {
        console.error('Match error:', e);
        return false;
      }
    });

    const lastRun = lastExecutions[rule.id];

    if (lastRun) {
      const intervalMs = (rule.intervalMinutes || 5) * 60000;
      const nextRun = lastRun + intervalMs;
      // Show "Due now" only if it's overdue by more than 10 seconds, otherwise show time
      // This prevents it from saying "Due now" while the background script is just about to run
      const isOverdue = now >= (nextRun + 10000);

      statusContainer.innerHTML = `
        <div class="status-item">
          <span class="status-label">Last:</span>
          <span class="status-value">${formatTime(lastRun)}</span>
        </div>
        <div class="status-item">
          <span class="status-label">Next:</span>
          <span class="status-value ${isOverdue ? 'status-due' : ''}">${isOverdue ? 'Due now' : formatTime(nextRun)}</span>
        </div>
      `;
    } else {
      statusContainer.innerHTML = `
        <div class="status-item">
          <span class="status-value" style="color: ${matches ? 'var(--text-secondary)' : '#ff3b30'}">
            ${matches ? 'Waiting for first run...' : 'No open tab matches this rule'}
          </span>
        </div>
      `;
    }
  });
}

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

async function addRule() {
  if (!state.globalEnabled) return;

  const nameInput = document.getElementById('addRuleName');
  const patternInput = document.getElementById('addRulePattern');
  const intervalInput = document.getElementById('addRuleInterval');
  const activityInput = document.getElementById('addRuleActivity');

  const name = nameInput.value.trim();
  const pattern = patternInput.value.trim();

  if (!name || !pattern) return;

  try {
    const newRule = {
      id: createRuleId(),
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
    renderRulesList();

    // Trigger immediate check
    chrome.runtime.sendMessage({ action: 'FORCE_HEARTBEAT' });

  } catch (error) {
    console.error('Failed to add rule:', error);
    alert('Failed to add rule. Please try again.');
  }
}

function createRuleId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'rule-' + Date.now() + '-' + Math.floor(Math.random() * 10000);
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
      renderRulesList();
    }
    return;
  }

  // Run Now
  if (e.target.classList.contains('run-now-btn')) {
    const btn = e.target;
    const originalText = btn.textContent;
    btn.textContent = 'Running...';
    btn.disabled = true;

    try {
      // Try to ping first to wake up SW
      try { await chrome.runtime.sendMessage({ action: 'PING' }); } catch (e) { }

      const response = await sendMessageWithRetry({ action: 'RUN_RULE', ruleId });

      if (response && response.success) {
        btn.textContent = 'Done!';
        updateRuleStatuses();
      } else {
        btn.textContent = 'Failed';
        const errorMsg = response ? response.error : 'Unknown error';
        console.error('Run failed:', errorMsg);
        alert('Run failed: ' + errorMsg);
      }
    } catch (err) {
      btn.textContent = 'Error';
      console.error('Run error:', err);
      if (err.message.includes('Receiving end does not exist')) {
        alert('Extension background process is not running. Please reload the extension from chrome://extensions.');
      } else {
        alert('Communication error: ' + err.message);
      }
    }

    setTimeout(() => {
      btn.textContent = originalText;
      btn.disabled = false;
    }, 2000);
  }
}

async function sendMessageWithRetry(message, retries = 2, delay = 100) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    if (retries > 0) {
      await new Promise(resolve => setTimeout(resolve, delay));
      return sendMessageWithRetry(message, retries - 1, delay * 2);
    }
    throw error;
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
    // Update icon immediately
    const iconContainer = card.querySelector('.rule-icon');
    if (iconContainer) {
      iconContainer.innerHTML = getIcon(rule.activity);
    }
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
