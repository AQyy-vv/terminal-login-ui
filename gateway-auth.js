(function (global) {
  'use strict';

  const STYLE_ID = 'terminal-login-sdk-style';
  const DEFAULT_REQUEST_TIMEOUT_MS = 12000;
  const DEFAULT_FRAME_TIMEOUT_MS = 15000;
  let active = null;

  function normalizeTimeout(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.max(1000, parsed) : fallback;
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .terminal-login-overlay {
        position: fixed; inset: 0; z-index: 2147483000; display: grid; place-items: center;
        padding: 20px; background: rgba(0,0,0,.42);
      }
      .terminal-login-dialog {
        position: relative; width: min(430px, calc(100vw - 32px)); overflow: hidden;
        background: #fff; border: 1px solid #c9cdd2; border-radius: 14px;
        box-shadow: 0 18px 52px rgba(18,22,27,.22);
      }
      .terminal-login-close {
        position: absolute; top: 8px; right: 8px; z-index: 2; width: 34px; height: 34px;
        display: grid; place-items: center; padding: 0; color: #333; background: #fff;
        border: 1px solid #b8bdc3; border-radius: 8px; font: 22px/1 sans-serif; cursor: pointer;
      }
      .terminal-login-frame { display: block; width: 100%; height: 500px; border: 0; background: #fff; }
      .terminal-login-status { padding: 32px; color: #333; font: 14px/1.55 sans-serif; text-align: center; }
      .terminal-login-status p { margin: 10px 0 0; }
      .terminal-login-retry {
        min-height: 38px; margin-top: 18px; padding: 7px 16px; color: #fff; background: #303030;
        border: 1px solid #303030; border-radius: 8px; font: 14px/1 sans-serif; cursor: pointer;
      }
      @media (max-width: 480px) {
        .terminal-login-overlay { padding: 0; align-items: end; }
        .terminal-login-dialog { width: 100%; max-height: 94vh; }
      }
    `;
    document.head.appendChild(style);
  }

  function close() {
    if (!active) return;
    active.controller?.abort('closed');
    clearTimeout(active.frameTimer);
    global.removeEventListener('message', active.onMessage);
    document.removeEventListener('keydown', active.onKeyDown);
    active.backgroundElements?.forEach(item => { item.element.inert = item.wasInert; });
    document.body.style.overflow = active.previousBodyOverflow;
    active.overlay.remove();
    active.restoreFocus?.focus?.();
    active = null;
  }

  async function requestJson(url, init = {}, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, controller = new AbortController()) {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort('timeout');
    }, timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      const text = await response.text();
      let data = {};
      if (text) {
        try { data = JSON.parse(text); }
        catch (_) { throw new Error('终端服务返回了无法识别的数据。'); }
      }
      if (!response.ok) throw new Error(data.message || `终端请求失败（${response.status}）。`);
      return data;
    } catch (error) {
      if (timedOut) throw new Error(`终端服务超过 ${Math.round(timeoutMs / 1000)} 秒未响应。`);
      if (controller.signal.aborted) {
        const cancelled = new Error('登录请求已取消。');
        cancelled.code = 'REQUEST_CANCELLED';
        throw cancelled;
      }
      if (error instanceof TypeError) {
        throw new Error(global.navigator?.onLine === false
          ? '当前设备处于离线状态。'
          : '无法连接终端登录服务，请检查网络或服务状态。');
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  function showError(dialog, title, message, onRetry) {
    const status = document.createElement('div');
    status.className = 'terminal-login-status';
    status.setAttribute('role', 'alert');
    const heading = document.createElement('strong');
    heading.textContent = title;
    const detail = document.createElement('p');
    detail.textContent = message;
    status.append(heading, detail);
    if (onRetry) {
      const retry = document.createElement('button');
      retry.className = 'terminal-login-retry';
      retry.type = 'button';
      retry.textContent = '重新连接';
      retry.addEventListener('click', onRetry, { once: true });
      status.appendChild(retry);
    }
    const current = dialog.querySelector('.terminal-login-status, .terminal-login-frame');
    if (current) current.replaceWith(status);
    else dialog.appendChild(status);
  }

  async function open(options) {
    if (!options || !options.baseUrl || !options.clientId) {
      throw new Error('TerminalLogin.open 需要 baseUrl 与 clientId。');
    }
    if (active) close();
    ensureStyles();

    const baseUrl = new URL(options.baseUrl, global.location.href);
    const terminalOrigin = baseUrl.origin;
    const restoreFocus = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'terminal-login-overlay';
    overlay.setAttribute('role', 'presentation');
    overlay.innerHTML = `
      <section class="terminal-login-dialog" role="dialog" aria-modal="true" aria-label="统一登录">
        <button class="terminal-login-close" type="button" aria-label="关闭登录弹窗">×</button>
        <div class="terminal-login-status" role="status" aria-live="polite">正在连接终端登录服务…</div>
      </section>`;
    document.body.appendChild(overlay);

    const dialog = overlay.querySelector('.terminal-login-dialog');
    const closeButton = overlay.querySelector('.terminal-login-close');
    const onKeyDown = event => {
      if (event.key === 'Escape') return close();
      if (event.key !== 'Tab') return;
      const focusable = [...dialog.querySelectorAll('button:not([disabled]), iframe, [href], input:not([disabled])')];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const onMessage = event => {
      // 只接收刚刚创建的登录 iframe 从 GitHub Pages 发回的消息。
      if (!active?.loginOrigin || event.origin !== active.loginOrigin ||
          event.source !== active.frame?.contentWindow || !event.data) return;
      if (event.data.type === 'terminal-login-resize') {
        clearTimeout(active.frameTimer);
        const frame = overlay.querySelector('.terminal-login-frame');
        if (frame) frame.style.height = `${Math.max(360, Math.min(720, Number(event.data.height) || 500))}px`;
      }
      if (event.data.type === 'terminal-login-success') {
        const result = event.data.result;
        try { options.onSuccess?.(result); }
        catch (error) { global.console?.error?.('TerminalLogin onSuccess 回调执行失败：', error); }
        overlay.dispatchEvent(new CustomEvent('terminal-login-success', { detail: result }));
        close();
      }
    };

    const controller = new AbortController();
    const backgroundElements = [...document.body.children]
      .filter(element => element !== overlay)
      .map(element => ({ element, wasInert: element.inert }));
    backgroundElements.forEach(item => { item.element.inert = true; });
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    active = {
      overlay, onMessage, onKeyDown, restoreFocus,
      frame: null, loginOrigin: '', controller, frameTimer: null,
      backgroundElements, previousBodyOverflow
    };
    global.addEventListener('message', onMessage);
    document.addEventListener('keydown', onKeyDown);
    closeButton.addEventListener('click', close);
    overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
    closeButton.focus();

    try {
      const requestTimeoutMs = normalizeTimeout(options.timeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
      const ticketData = await requestJson(`${terminalOrigin}/api/embed-ticket?client_id=${encodeURIComponent(options.clientId)}`, {
        method: 'GET',
        mode: 'cors',
        credentials: 'omit'
      }, requestTimeoutMs, controller);

      const loginUrl = new URL(ticketData.loginUrl, terminalOrigin);
      const frame = document.createElement('iframe');
      frame.className = 'terminal-login-frame';
      frame.title = options.title || '统一登录';
      frame.src = loginUrl.href;
      frame.referrerPolicy = 'no-referrer';
      frame.setAttribute('allow', 'clipboard-write');
      frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox');
      if (!active || active.overlay !== overlay) return { close, element: overlay };
      active.frame = frame;
      active.loginOrigin = loginUrl.origin;
      const frameTimeoutMs = normalizeTimeout(options.frameTimeoutMs, DEFAULT_FRAME_TIMEOUT_MS);
      active.frameTimer = setTimeout(() => {
        if (!active || active.overlay !== overlay || active.frame !== frame) return;
        active.frame = null;
        showError(
          dialog,
          '登录页面加载超时',
          `登录页面超过 ${Math.round(frameTimeoutMs / 1000)} 秒未完成加载，请检查网络后重试。`,
          () => open(options).catch(() => {})
        );
      }, frameTimeoutMs);
      dialog.querySelector('.terminal-login-status').replaceWith(frame);
      return { close, element: overlay };
    } catch (error) {
      if (error.code === 'REQUEST_CANCELLED' || !overlay.isConnected) return { close, element: overlay };
      showError(
        dialog,
        '无法打开登录',
        `${String(error.message || error)} 请确认网络正常，且当前网站已加入接入白名单。`,
        () => open(options).catch(() => {})
      );
      throw error;
    }
  }

  async function introspect(options) {
    const baseUrl = new URL(options.baseUrl, global.location.href);
    const timeoutMs = normalizeTimeout(options.timeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    return requestJson(`${baseUrl.origin}/api/auth/introspect`, {
      method: 'POST',
      mode: 'cors',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'omit',
      body: JSON.stringify({ token: options.token })
    }, timeoutMs);
  }

  global.TerminalLogin = Object.freeze({ open, close, introspect });
})(window);
