const HEARTBEAT_ALARM = 'pixel-pulse-heartbeat';
const STORAGE_KEYS = {
  GLOBAL_ENABLED: 'globalEnabled',
  RULES: 'rules',
  THEME: 'theme',
};
const LOCAL_KEYS = {
  LAST_EXECUTIONS: 'lastRuleExecutions',
  LAST_STATUS: 'lastStatus',
};
const IDLE_THRESHOLD_SECONDS = 60;

const injectedTabs = new Set();

initialize();

chrome.runtime.onInstalled.addListener(async (details) => {
  await ensureDefaults();
  await primeAlarm();
  await handleHeartbeat();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === HEARTBEAT_ALARM) {
    handleHeartbeat().catch((error) => {
      console.error('[Pixel Pulse] Heartbeat failed', error);
    });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  injectedTabs.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    injectedTabs.delete(tabId);
  }
});

// Update toolbar icon when theme changes
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  if (STORAGE_KEYS.THEME in changes) {
    const theme = changes[STORAGE_KEYS.THEME].newValue === 'light' ? 'light' : 'dark';
    updateActionIcon(theme).catch(() => {});
  }
});

async function initialize() {
  await ensureDefaults();
  await primeAlarm();
  try {
    const { [STORAGE_KEYS.THEME]: theme } = await chrome.storage.sync.get([STORAGE_KEYS.THEME]);
    await updateActionIcon(theme === 'light' ? 'light' : 'dark');
  } catch (e) {}
  try {
    await chrome.action.setBadgeBackgroundColor({ color: '#0ea5e9' });
  } catch (e) {}
  await handleHeartbeat();
}

async function ensureDefaults() {
  const stored = await chrome.storage.sync.get([
    STORAGE_KEYS.GLOBAL_ENABLED,
    STORAGE_KEYS.RULES,
    STORAGE_KEYS.THEME,
  ]);
  const updates = {};

  if (typeof stored[STORAGE_KEYS.GLOBAL_ENABLED] !== 'boolean') {
    updates[STORAGE_KEYS.GLOBAL_ENABLED] = true;
  }

  const rulesMissing = !Array.isArray(stored[STORAGE_KEYS.RULES]);
  if (rulesMissing) {
    updates[STORAGE_KEYS.RULES] = [];
  }

  if (!stored[STORAGE_KEYS.THEME]) {
    updates[STORAGE_KEYS.THEME] = 'dark';
  }

  if (Object.keys(updates).length > 0) {
    await chrome.storage.sync.set(updates);
  }
}

async function primeAlarm() {
  await chrome.alarms.create(HEARTBEAT_ALARM, {
    periodInMinutes: 1,
    delayInMinutes: 0.1,
  });
}

async function handleHeartbeat() {
  const settings = await chrome.storage.sync.get([STORAGE_KEYS.GLOBAL_ENABLED, STORAGE_KEYS.RULES]);
  const globalEnabled = settings[STORAGE_KEYS.GLOBAL_ENABLED] !== false;
  const rules = Array.isArray(settings[STORAGE_KEYS.RULES]) ? settings[STORAGE_KEYS.RULES] : [];

  if (!globalEnabled) {
    await writeStatus({ state: 'inactive', reason: 'paused', timestamp: Date.now() });
    return;
  }

  if (!rules.length) {
    await writeStatus({ state: 'inactive', reason: 'no-rules', timestamp: Date.now() });
    return;
  }

  // Look across all open http(s) tabs; pick the first tab that matches any rule
  const tabs = await chrome.tabs.query({});
  const httpTabs = tabs.filter((t) => t && isHttpUrl(t.url));

  let selected = null; // { tab, rule }
  for (const rule of rules) {
    if (!rule || rule.enabled === false || !rule.pattern) continue;
    const tab = httpTabs.find((t) => matchesPattern(t.url, rule.pattern));
    if (tab) {
      selected = { tab, rule };
      break;
    }
  }

  if (!selected) {
    await writeStatus({ state: 'inactive', reason: 'no-match', timestamp: Date.now() });
    return;
  }

  const { tab, rule } = selected;
  const now = Date.now();
  const ruleIntervalMs = Math.max(1, Number(rule.intervalMinutes) || 1) * 60_000;
  const localState = await chrome.storage.local.get([LOCAL_KEYS.LAST_EXECUTIONS]);
  const lastExecMap = localState[LOCAL_KEYS.LAST_EXECUTIONS] || {};
  const lastRun = lastExecMap[rule.id];
  const due = !lastRun || now - lastRun >= ruleIntervalMs;

  if (due) {
    if ((rule.activity || '').toLowerCase() === 'refresh') {
      const idleState = await queryIdleState();
      if (idleState === 'active') {
        await writeStatus({
          state: 'inactive',
          reason: 'user-active',
          ruleId: rule.id,
          ruleName: rule.name,
          url: tab.url,
          timestamp: now,
        });
        return;
      }
    }

    try {
      await runActivity(tab.id, rule);
      console.log('[Pixel Pulse] Pulse sent', { tabId: tab.id, url: tab.url, rule: rule.name });
      lastExecMap[rule.id] = now;
      await chrome.storage.local.set({ [LOCAL_KEYS.LAST_EXECUTIONS]: lastExecMap });
      await writeStatus({
        state: 'active',
        ruleId: rule.id,
        ruleName: rule.name,
        lastRunAt: now,
        url: tab.url,
        timestamp: now,
      });
      flashBadge();
    } catch (error) {
      console.error('[Pixel Pulse] Activity execution failed', error);
      await writeStatus({
        state: 'error',
        ruleId: rule.id,
        ruleName: rule.name,
        reason: 'execution-failed',
        error: error.message,
        timestamp: Date.now(),
      });
    }
  } else {
    await writeStatus({
      state: 'active',
      ruleId: rule.id,
      ruleName: rule.name,
      lastRunAt: lastRun,
      url: tab.url,
      timestamp: now,
    });
  }
}

function flashBadge() {
  try {
    chrome.action.setBadgeText({ text: '•' });
    setTimeout(() => {
      chrome.action.setBadgeText({ text: '' });
    }, 2500);
  } catch (e) {}
}

async function runActivity(tabId, rule) {
  await ensureContentScript(tabId);
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (payload) => {
      if (window.pixelPulseRun) {
        window.pixelPulseRun(payload);
      } else {
        console.warn('[Pixel Pulse] Injection incomplete on tab', payload);
      }
    },
    args: [
      {
        rule,
        timestamp: Date.now(),
      },
    ],
  });
}

async function ensureContentScript(tabId) {
  if (injectedTabs.has(tabId)) {
    return;
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });
    injectedTabs.add(tabId);
  } catch (error) {
    injectedTabs.delete(tabId);
    throw error;
  }
}

async function writeStatus(status) {
  await chrome.storage.local.set({
    [LOCAL_KEYS.LAST_STATUS]: {
      ...status,
      timestamp: status.timestamp || Date.now(),
    },
  });
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tabs && tabs.length ? tabs[0] : null;
}

function findMatchingRule(url, rules) {
  for (const rule of rules) {
    if (!rule || rule.enabled === false || !rule.pattern) {
      continue;
    }
    if (matchesPattern(url, rule.pattern)) {
      return rule;
    }
  }
  return null;
}

function matchesPattern(url, pattern) {
  const escaped = pattern
    .split('*')
    .map((segment) => segment.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  const expression = `^${escaped}$`;
  try {
    return new RegExp(expression).test(url);
  } catch (error) {
    console.warn('[Pixel Pulse] Invalid pattern ignored', pattern, error);
    return false;
  }
}

function isHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

async function queryIdleState() {
  return new Promise((resolve) => {
    try {
      chrome.idle.queryState(IDLE_THRESHOLD_SECONDS, (state) => resolve(state));
    } catch (error) {
      console.warn('[Pixel Pulse] idle state unavailable', error);
      resolve('active');
    }
  });
}

async function updateActionIcon(theme) {
  const path = theme === 'light' ? 'logo_light.png' : 'logo_dark.png';
  try {
    await chrome.action.setIcon({ path });
  } catch (e) {
    // ignore if not supported
  }
}
