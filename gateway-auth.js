(function (global) {
  'use strict';

  const STYLE_ID = 'terminal-login-sdk-style';
  let active = null;

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
        background: #fff; border: 1px solid #8b8b8b; box-shadow: 0 16px 48px rgba(0,0,0,.24);
      }
      .terminal-login-close {
        position: absolute; top: 8px; right: 8px; z-index: 2; width: 34px; height: 34px;
        display: grid; place-items: center; padding: 0; color: #333; background: #fff;
        border: 1px solid #aaa; font: 22px/1 sans-serif; cursor: pointer;
      }
      .terminal-login-frame { display: block; width: 100%; height: 500px; border: 0; background: #fff; }
      .terminal-login-status { padding: 32px; color: #333; font: 14px/1.55 sans-serif; text-align: center; }
      @media (max-width: 480px) {
        .terminal-login-overlay { padding: 0; align-items: end; }
        .terminal-login-dialog { width: 100%; max-height: 94vh; }
      }
    `;
    document.head.appendChild(style);
  }

  function close() {
    if (!active) return;
    global.removeEventListener('message', active.onMessage);
    document.removeEventListener('keydown', active.onKeyDown);
    active.overlay.remove();
    active.restoreFocus?.focus?.();
    active = null;
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
        <div class="terminal-login-status">正在连接终端登录服务…</div>
      </section>`;
    document.body.appendChild(overlay);

    const dialog = overlay.querySelector('.terminal-login-dialog');
    const closeButton = overlay.querySelector('.terminal-login-close');
    const onKeyDown = event => { if (event.key === 'Escape') close(); };
    const onMessage = event => {
      // 只接收刚刚创建的登录 iframe 从 GitHub Pages 发回的消息。
      if (!active?.loginOrigin || event.origin !== active.loginOrigin ||
          event.source !== active.frame?.contentWindow || !event.data) return;
      if (event.data.type === 'terminal-login-resize') {
        const frame = overlay.querySelector('.terminal-login-frame');
        if (frame) frame.style.height = `${Math.max(360, Math.min(720, Number(event.data.height) || 500))}px`;
      }
      if (event.data.type === 'terminal-login-success') {
        const result = event.data.result;
        options.onSuccess?.(result);
        overlay.dispatchEvent(new CustomEvent('terminal-login-success', { detail: result }));
        close();
      }
    };

    active = { overlay, onMessage, onKeyDown, restoreFocus, frame: null, loginOrigin: '' };
    global.addEventListener('message', onMessage);
    document.addEventListener('keydown', onKeyDown);
    closeButton.addEventListener('click', close);
    overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
    closeButton.focus();

    try {
      const ticketResponse = await fetch(`${terminalOrigin}/api/embed-ticket?client_id=${encodeURIComponent(options.clientId)}`, {
        method: 'GET',
        mode: 'cors',
        credentials: 'omit'
      });
      const ticketData = await ticketResponse.json().catch(() => ({}));
      if (!ticketResponse.ok) throw new Error(ticketData.message || '终端拒绝了该网站的接入请求。');

      const loginUrl = new URL(ticketData.loginUrl, terminalOrigin);
      const frame = document.createElement('iframe');
      frame.className = 'terminal-login-frame';
      frame.title = options.title || '统一登录';
      frame.src = loginUrl.href;
      frame.referrerPolicy = 'strict-origin-when-cross-origin';
      frame.setAttribute('allow', 'clipboard-write');
      if (!active || active.overlay !== overlay) return { close, element: overlay };
      active.frame = frame;
      active.loginOrigin = loginUrl.origin;
      dialog.querySelector('.terminal-login-status').replaceWith(frame);
      return { close, element: overlay };
    } catch (error) {
      dialog.querySelector('.terminal-login-status').innerHTML = `
        <strong>无法打开登录</strong><br>${String(error.message || error)}<br><br>
        请确认终端服务已启动，且当前网站已加入接入白名单。`;
      throw error;
    }
  }

  async function introspect(options) {
    const baseUrl = new URL(options.baseUrl, global.location.href);
    const response = await fetch(`${baseUrl.origin}/api/auth/introspect`, {
      method: 'POST',
      mode: 'cors',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: options.token })
    });
    if (!response.ok) throw new Error('终端令牌复核失败。');
    return response.json();
  }

  global.TerminalLogin = Object.freeze({ open, close, introspect });
})(window);
