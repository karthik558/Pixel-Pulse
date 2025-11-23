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

// Register listener immediately
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'PING') {
    sendResponse('PONG');
    return false;
  }
  if (request.action === 'FORCE_HEARTBEAT') {
    handleHeartbeat().then(() => sendResponse({ success: true }));
    return true; // Keep channel open
  }
  if (request.action === 'RUN_RULE') {
    runSingleRule(request.ruleId).then((result) => sendResponse(result));
    return true;
  }
});

chrome.runtime.onStartup.addListener(() => {
  initialize().catch(e => console.error('[Pixel Pulse] Startup failed', e));
});

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
    updateActionIcon(theme).catch(() => { });
  }
});

async function runSingleRule(ruleId) {
  const settings = await chrome.storage.sync.get([STORAGE_KEYS.RULES]);
  const rules = settings[STORAGE_KEYS.RULES] || [];
  const rule = rules.find(r => r.id === ruleId);
  if (!rule) return { success: false, error: 'Rule not found' };

  const tabs = await chrome.tabs.query({});
  const httpTabs = tabs.filter((t) => t && isHttpUrl(t.url));
  const matchingTabs = httpTabs.filter((t) => matchesPattern(t.url, rule.pattern));

  if (matchingTabs.length === 0) return { success: false, error: 'No matching tabs' };

  let executed = 0;
  let lastError = null;

  for (const tab of matchingTabs) {
    try {
      await runActivity(tab.id, rule);
      executed++;

      // Update last execution time immediately
      const now = Date.now();
      const localState = await chrome.storage.local.get([LOCAL_KEYS.LAST_EXECUTIONS]);
      const lastExecMap = localState[LOCAL_KEYS.LAST_EXECUTIONS] || {};
      lastExecMap[rule.id] = now;
      await chrome.storage.local.set({ [LOCAL_KEYS.LAST_EXECUTIONS]: lastExecMap });

    } catch (e) {
      console.error('Manual run failed', e);
      lastError = e.message;
    }
  }

  if (executed === 0) {
    return { success: false, error: lastError || 'Execution failed on all matching tabs' };
  }

  return { success: true, executedCount: executed };
}

async function initialize() {
  await ensureDefaults();
  await primeAlarm();
  try {
    const { [STORAGE_KEYS.THEME]: theme } = await chrome.storage.sync.get([STORAGE_KEYS.THEME]);
    await updateActionIcon(theme === 'light' ? 'light' : 'dark');
  } catch (e) { }
  try {
    await chrome.action.setBadgeBackgroundColor({ color: '#0ea5e9' });
  } catch (e) { }
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
  // Clear existing to ensure update
  await chrome.alarms.clear(HEARTBEAT_ALARM);
  await chrome.alarms.create(HEARTBEAT_ALARM, {
    periodInMinutes: 0.5, // Check every 30 seconds
    delayInMinutes: 0.1,
  });
}

// Fallback interval for more reliable timing if alarm sleeps
setInterval(() => {
  handleHeartbeat().catch(e => console.error('Interval heartbeat failed', e));
}, 30000);

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

  const tabs = await chrome.tabs.query({});
  const httpTabs = tabs.filter((t) => t && isHttpUrl(t.url));
  const now = Date.now();

  const localState = await chrome.storage.local.get([LOCAL_KEYS.LAST_EXECUTIONS]);
  const lastExecMap = localState[LOCAL_KEYS.LAST_EXECUTIONS] || {};
  let anyActive = false;

  // Check every rule against every tab
  for (const rule of rules) {
    if (!rule || rule.enabled === false || !rule.pattern) continue;

    const matchingTabs = httpTabs.filter((t) => matchesPattern(t.url, rule.pattern));

    for (const tab of matchingTabs) {
      anyActive = true;
      const ruleIntervalMs = Math.max(1, Number(rule.intervalMinutes) || 1) * 60_000;
      const lastRun = lastExecMap[rule.id];
      const due = !lastRun || now - lastRun >= ruleIntervalMs;

      if (due) {
        // Skip refresh if user is active
        if ((rule.activity || '').toLowerCase() === 'refresh') {
          const idleState = await queryIdleState();
          if (idleState === 'active') continue;
        }

        try {
          await runActivity(tab.id, rule);
          console.log('[Pixel Pulse] Pulse sent', { tabId: tab.id, url: tab.url, rule: rule.name });

          // Update last execution time
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
          console.error('[Pixel Pulse] Execution failed', error);
        }
      } else {
        // Just update status to show it's tracking
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
  }

  if (!anyActive) {
    await writeStatus({ state: 'inactive', reason: 'no-match', timestamp: Date.now() });
  }
}

function flashBadge() {
  try {
    chrome.action.setBadgeText({ text: '•' });
    setTimeout(() => {
      chrome.action.setBadgeText({ text: '' });
    }, 2500);
  } catch (e) { }
}

async function runActivity(tabId, rule) {
  try {
    await ensureContentScript(tabId);
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: (payload) => {
        if (typeof window.pixelPulseRun === 'function') {
          window.pixelPulseRun(payload);
          return true;
        }
        return false;
      },
      args: [{ rule, timestamp: Date.now() }],
    });

    // If the function returned false (pixelPulseRun not found), force re-injection
    if (result && result[0] && result[0].result === false) {
      console.warn('[Pixel Pulse] Re-injecting content script for tab', tabId);
      injectedTabs.delete(tabId);
      await ensureContentScript(tabId);
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (payload) => {
          if (window.pixelPulseRun) window.pixelPulseRun(payload);
        },
        args: [{ rule, timestamp: Date.now() }],
      });
    }
  } catch (e) {
    console.error('[Pixel Pulse] Failed to run activity', e);
    throw e;
  }
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
  try {
    const cleanPattern = pattern.trim();
    const cleanUrl = url.trim();

    // If pattern has no wildcards, perform a simple case-insensitive substring match
    // This is often what users expect (e.g. "google.com" matches "https://www.google.com/...")
    if (!cleanPattern.includes('*')) {
      return cleanUrl.toLowerCase().includes(cleanPattern.toLowerCase());
    }

    // Otherwise, use glob matching
    let normalizedPattern = cleanPattern;

    // 1. Handle missing protocol
    if (!/^[a-zA-Z0-9+.-]+:\/\//.test(normalizedPattern) && !normalizedPattern.startsWith('*://')) {
      normalizedPattern = '*://' + normalizedPattern;
    }

    // 2. Handle missing path wildcard
    const protocolIndex = normalizedPattern.indexOf('://');
    const afterProtocol = normalizedPattern.substring(protocolIndex + 3);
    if (!afterProtocol.includes('/')) {
      normalizedPattern += '/*';
    }

    const escaped = normalizedPattern
      .split('*')
      .map((segment) => segment.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');

    return new RegExp(`^${escaped}$`, 'i').test(cleanUrl);
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
