(() => {
  const state = {
    scrollDirection: 1,
  };

  const activities = {
    mousemove() {
      const target = document.body || document.documentElement;
      if (!target) {
        return;
      }
      const x = Math.floor(Math.random() * window.innerWidth);
      const y = Math.floor(Math.random() * window.innerHeight);
      const event = new MouseEvent('mousemove', {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
      });
      target.dispatchEvent(event);
    },
    scroll() {
      const element = document.scrollingElement || document.body || document.documentElement;
      if (!element) {
        return;
      }
      const delta = state.scrollDirection * 2;
      element.scrollBy({ top: delta, behavior: 'smooth' });
      state.scrollDirection *= -1;
    },
    ping() {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);
      fetch(window.location.href, {
        method: 'GET',
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
    console.debug('[Pixel Pulse] Heartbeat executed', {
      ruleId: rule.id,
      activity: actionKey,
    });
  };
})();
