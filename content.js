(() => {
  console.log('[Pixel Pulse] Content script loaded');
  const state = {
    scrollDirection: 1,
  };

  const activities = {
    mousemove() {
      const target = document.body || document.documentElement;
      if (!target) return;

      const x = Math.floor(Math.random() * window.innerWidth);
      const y = Math.floor(Math.random() * window.innerHeight);

      // Simulate a sequence of events to ensure activity is registered
      const events = ['mousemove', 'mouseover', 'mousedown', 'mouseup', 'click'];

      events.forEach(type => {
        const event = new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: x,
          clientY: y,
          screenX: x, // Some sites check screenX/Y
          screenY: y
        });
        target.dispatchEvent(event);
      });
    },
    scroll() {
      const element = document.scrollingElement || document.body || document.documentElement;
      if (!element) {
        console.warn('[Pixel Pulse] No scrolling element found');
        return;
      }
      const delta = state.scrollDirection * 2;
      if (typeof element.scrollBy === 'function') {
        element.scrollBy({ top: delta, behavior: 'smooth' });
      } else {
        element.scrollTop += delta;
      }
      state.scrollDirection *= -1;
    },
    ping() {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);
      // Add cache buster to ensure network request actually goes out
      const url = new URL(window.location.href);
      url.searchParams.set('_pp_ping', Date.now());

      fetch(url.toString(), {
        method: 'HEAD', // HEAD is lighter than GET
        cache: 'no-store',
        mode: 'no-cors',
        signal: controller.signal,
      })
        .catch(() => {
          /* Swallow network errors silently */
        })
        .finally(() => clearTimeout(timeout));
    },
    refresh() {
      window.location.reload();
    },
  };

  window.pixelPulseRun = (payload = {}) => {
    const rule = payload.rule || {};
    const actionKey = typeof rule.activity === 'string' ? rule.activity : 'mousemove';
    const action = activities[actionKey] || activities.mousemove;
    action();
    document.dispatchEvent(
      new CustomEvent('pixel-pulse:heartbeat', {
        detail: {
          ruleId: rule.id,
          ruleName: rule.name,
          activity: actionKey,
          timestamp: payload.timestamp || Date.now(),
        },
      }),
    );
    console.log('[Pixel Pulse] Heartbeat executed', {
      ruleId: rule.id,
      ruleName: rule.name,
      activity: actionKey,
      at: new Date(payload.timestamp || Date.now()).toLocaleTimeString(),
    });
  };
})();
