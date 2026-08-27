'use strict';

// GitHub Pages 仅运行管理界面，所有敏感操作仍由云函数鉴权后写入私有 COS。
const CONFIG = { API_BASE_URL: 'https://1447704904-cwscdb1mvx.ap-guangzhou.tencentscf.com/api' };
const state = {
  token: sessionStorage.getItem('terminalAdminToken') || '',
  me: null,
  permissions: [],
  accounts: [],
  clients: [],
  auditLogs: [],
  pendingResetId: null,
  pendingAccessId: null,
  accessSelection: new Set(),
  accessView: { query: '', page: 1 },
  pendingClientAccessId: null,
  clientAccessSelection: new Set(),
  clientAccessOriginal: new Set(),
  clientAccessView: { query: '', page: 1 },
  listViews: {
    accounts: { query: '', page: 1 },
    clients: { query: '', page: 1 },
    audits: { query: '', page: 1 }
  },
  currentCredential: null
};

const LIST_PAGE_SIZE = 10;
const DIALOG_PAGE_SIZE = 8;

const $ = selector => document.querySelector(selector);

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[char]);
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function formatDate(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  }).format(new Date(value));
}

function can(permission) {
  return state.permissions.includes(permission);
}

function roleLabel(role) {
  return ({ owner: '终端拥有者', admin: '管理员', user: '用户' })[role] || '用户';
}

function matchesSearch(values, query) {
  const normalized = String(query || '').trim().toLocaleLowerCase('zh-CN');
  if (!normalized) return true;
  return values.some(value => String(value || '').toLocaleLowerCase('zh-CN').includes(normalized));
}

function paginate(items, view, pageSize = LIST_PAGE_SIZE) {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  view.page = Math.max(1, Math.min(totalPages, Number(view.page) || 1));
  const start = (view.page - 1) * pageSize;
  return {
    items: items.slice(start, start + pageSize),
    page: view.page,
    totalPages,
    totalItems: items.length
  };
}

function renderPager(selector, target, pageInfo) {
  const element = $(selector);
  element.innerHTML = `
    <span class="pager-summary">共 ${pageInfo.totalItems} 条 · 第 ${pageInfo.page}/${pageInfo.totalPages} 页</span>
    <button class="btn btn-small" type="button" data-page-target="${escapeHtml(target)}" data-page="${pageInfo.page - 1}" ${pageInfo.page <= 1 ? 'disabled' : ''}>上一页</button>
    <button class="btn btn-small" type="button" data-page-target="${escapeHtml(target)}" data-page="${pageInfo.page + 1}" ${pageInfo.page >= pageInfo.totalPages ? 'disabled' : ''}>下一页</button>`;
}

function showToast(message) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  $('#toast-region').appendChild(toast);
  setTimeout(() => toast.remove(), 2600);
}

function setButtonLoading(button, loading, label) {
  if (!button.dataset.originalText) button.dataset.originalText = button.textContent;
  button.disabled = loading;
  button.innerHTML = loading
    ? `<span class="spinner" aria-hidden="true"></span>${escapeHtml(label)}`
    : escapeHtml(button.dataset.originalText);
}

function openAdminLoginDialog(message = '') {
  $('#admin-key-error').textContent = message;
  $('#admin-key-error').hidden = !message;
  $('#admin-key').value = '';
  $('#admin-email').value = sessionStorage.getItem('terminalAdminEmail') || '';
  if (!$('#admin-key-dialog').open) $('#admin-key-dialog').showModal();
  requestAnimationFrame(() => (sessionStorage.getItem('terminalAdminEmail') ? $('#admin-key') : $('#admin-email')).focus());
}

function clearAdminSession(message = '') {
  state.token = '';
  state.me = null;
  state.permissions = [];
  sessionStorage.removeItem('terminalAdminToken');
  $('#current-admin').textContent = '未登录';
  openAdminLoginDialog(message);
}

async function request(path, options = {}, authenticated = true) {
  const headers = { 'Content-Type': 'application/json' };
  if (authenticated && state.token) headers.Authorization = `Bearer ${state.token}`;
  const response = await fetch(`${CONFIG.API_BASE_URL}${path}`, {
    method: options.method || 'GET',
    headers,
    credentials: 'same-origin',
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (authenticated && response.status === 401) clearAdminSession(data.message || '管理员登录已失效。');
    throw new Error(data.message || `请求失败（${response.status}）`);
  }
  return data;
}

const adminApi = {
  login(email, password) {
    return request('/admin/login', { method: 'POST', body: { email, password } }, false);
  },
  me() { return request('/admin/me'); },
  logout() { return request('/admin/logout', { method: 'POST' }); },
  listAccounts() { return request('/admin/accounts'); },
  createAccount(email, owner) { return request('/admin/accounts', { method: 'POST', body: { email, owner } }); },
  setAccountEnabled(id, enabled) {
    return request(`/admin/accounts/${encodeURIComponent(id)}/status`, { method: 'PATCH', body: { enabled } });
  },
  setAccountRole(id, role) {
    return request(`/admin/accounts/${encodeURIComponent(id)}/role`, { method: 'PATCH', body: { role } });
  },
  setAccountAccess(id, clientIds) {
    return request(`/admin/accounts/${encodeURIComponent(id)}/access`, { method: 'PATCH', body: { clientIds } });
  },
  resetAccountPassword(id) { return request(`/admin/accounts/${encodeURIComponent(id)}/reset`, { method: 'POST' }); },
  listClients() { return request('/admin/clients'); },
  createClient(payload) { return request('/admin/clients', { method: 'POST', body: payload }); },
  setClientEnabled(id, enabled) {
    return request(`/admin/clients/${encodeURIComponent(id)}/status`, { method: 'PATCH', body: { enabled } });
  },
  changeMyPassword(currentPassword, newPassword) {
    return request('/admin/password/change', { method: 'POST', body: { currentPassword, newPassword } });
  },
  auditLogs() { return request('/admin/audit-logs?limit=200'); }
};

function accountAccessLabel(account) {
  const ids = Array.isArray(account.allowedClientIds) ? account.allowedClientIds : [];
  if (ids.includes('*')) return '全部网站';
  if (!ids.length) return '未授权';
  return ids.map(id => state.clients.find(client => client.id === id)?.name || id).join('、');
}

function accountHasClientAccess(account, clientId) {
  const ids = Array.isArray(account.allowedClientIds) ? account.allowedClientIds : [];
  return ids.includes('*') || ids.includes(clientId);
}

function renderAccounts() {
  const writable = can('accounts:write');
  const roleWritable = can('admins:write');
  $('#open-create').disabled = !writable;
  $('#stat-total').textContent = state.accounts.length;
  $('#stat-enabled').textContent = state.accounts.filter(account => account.enabled).length;
  $('#stat-initial').textContent = state.accounts.filter(account => account.passwordMode === 'initial').length;

  const filtered = state.accounts.filter(account => matchesSearch([
    account.email, account.owner, roleLabel(account.role), account.enabled ? '允许登录' : '已停用', accountAccessLabel(account)
  ], state.listViews.accounts.query));
  const pageInfo = paginate(filtered, state.listViews.accounts);
  $('#account-rows').innerHTML = pageInfo.items.length ? pageInfo.items.map(account => `
    <tr>
      <td><strong>${escapeHtml(account.email)}</strong></td>
      <td>${escapeHtml(account.owner || '—')}</td>
      <td>
        <select data-account-role="${escapeHtml(account.id)}" aria-label="${escapeHtml(account.owner || account.email)}的权限角色" ${roleWritable ? '' : 'disabled'}>
          <option value="user" ${account.role !== 'admin' ? 'selected' : ''}>用户</option>
          <option value="admin" ${account.role === 'admin' ? 'selected' : ''}>管理员</option>
        </select>
      </td>
      <td><span class="status-tag ${account.enabled ? 'status-enabled' : 'status-disabled'}">${account.enabled ? '允许登录' : '已停用'}</span></td>
      <td><span class="status-tag ${account.passwordMode === 'initial' ? 'status-initial' : 'status-changed'}">${account.passwordMode === 'initial' ? '首次随机密码' : '用户已修改'}</span></td>
      <td>${escapeHtml(accountAccessLabel(account))}</td>
      <td>${escapeHtml(formatDate(account.passwordUpdatedAt))}</td>
      <td>${escapeHtml(formatDate(account.lastLoginAt))}</td>
      <td>
        <div class="actions">
          ${writable && (account.role !== 'admin' || state.me.role === 'owner') ? `
            <button class="btn btn-small" type="button" data-access-account="${escapeHtml(account.id)}">授权网站</button>
            <button class="btn btn-small" type="button" data-toggle-account="${escapeHtml(account.id)}" data-next-enabled="${String(!account.enabled)}">${account.enabled ? '停用' : '启用'}</button>
            <button class="btn btn-small" type="button" data-reset-account="${escapeHtml(account.id)}">重置密码</button>` : '<span class="meta">只读</span>'}
        </div>
      </td>
    </tr>`).join('') : `<tr><td colspan="9"><div class="empty">${state.accounts.length ? '没有匹配的账号。' : '暂无可登录账号。'}</div></td></tr>`;
  renderPager('#account-pager', 'accounts', pageInfo);
}

function renderClients() {
  const clientWritable = can('clients:write');
  const accessWritable = can('accounts:write');
  $('#open-client-create').disabled = !clientWritable;
  const filtered = state.clients.filter(client => matchesSearch([
    client.id, client.name, ...(client.allowedOrigins || []), client.enabled ? '允许接入' : '已停用'
  ], state.listViews.clients.query));
  const pageInfo = paginate(filtered, state.listViews.clients);
  $('#client-rows').innerHTML = pageInfo.items.length ? pageInfo.items.map(client => `
    <tr>
      <td><code>${escapeHtml(client.id)}</code></td>
      <td><strong>${escapeHtml(client.name)}</strong></td>
      <td><ul class="origin-list">${client.allowedOrigins.map(origin => `<li>${escapeHtml(origin)}</li>`).join('')}</ul></td>
      <td><span class="status-tag ${client.enabled ? 'status-enabled' : 'status-disabled'}">${client.enabled ? '允许接入' : '已停用'}</span></td>
      <td>${state.accounts.filter(account => accountHasClientAccess(account, client.id)).length} 个</td>
      <td><div class="actions">
        ${accessWritable ? `<button class="btn btn-small" type="button" data-client-access="${escapeHtml(client.id)}">配置用户</button>` : ''}
        ${clientWritable ? `<button class="btn btn-small" type="button" data-toggle-client="${escapeHtml(client.id)}" data-next-enabled="${String(!client.enabled)}">${client.enabled ? '停用' : '启用'}</button>` : ''}
        ${!accessWritable && !clientWritable ? '<span class="meta">只读</span>' : ''}
      </div></td>
    </tr>`).join('') : `<tr><td colspan="6"><div class="empty">${state.clients.length ? '没有匹配的接入网站。' : '暂无接入网站。'}</div></td></tr>`;
  renderPager('#client-pager', 'clients', pageInfo);
}

function renderAuditLogs() {
  const filtered = state.auditLogs.filter(log => matchesSearch([
    log.actorName, log.actorEmail, log.action, log.target, log.detail, formatDate(log.createdAt)
  ], state.listViews.audits.query));
  const pageInfo = paginate(filtered, state.listViews.audits);
  $('#audit-rows').innerHTML = pageInfo.items.length ? pageInfo.items.map(log => `
    <tr>
      <td>${escapeHtml(formatDate(log.createdAt))}</td>
      <td>${escapeHtml(log.actorName)}<br><span class="meta">${escapeHtml(log.actorEmail)}</span></td>
      <td>${escapeHtml(log.action)}</td>
      <td>${escapeHtml(log.target)}</td>
      <td>${escapeHtml(log.detail || '—')}</td>
    </tr>`).join('') : `<tr><td colspan="5"><div class="empty">${state.auditLogs.length ? '没有匹配的审计记录。' : '暂无审计记录。'}</div></td></tr>`;
  renderPager('#audit-pager', 'audits', pageInfo);
}

function renderAccessOptions() {
  const filtered = state.clients.filter(client => matchesSearch([
    client.id, client.name, ...(client.allowedOrigins || [])
  ], state.accessView.query));
  const pageInfo = paginate(filtered, state.accessView, DIALOG_PAGE_SIZE);
  const allSelected = state.accessSelection.has('*');
  $('#access-options').innerHTML = `
    <label class="check-item">
      <input type="checkbox" name="client-access" value="*" ${allSelected ? 'checked' : ''}>
      <span><strong>全部接入网站</strong><br><span class="meta">包含以后新增的网站</span></span>
    </label>
    ${pageInfo.items.map(client => `
      <label class="check-item">
        <input type="checkbox" name="client-access" value="${escapeHtml(client.id)}" ${state.accessSelection.has(client.id) ? 'checked' : ''} ${allSelected ? 'disabled' : ''}>
        <span><strong>${escapeHtml(client.name)}</strong><br><span class="meta">${escapeHtml(client.id)} · ${escapeHtml((client.allowedOrigins || []).join('、'))}</span></span>
      </label>`).join('')}
    ${!pageInfo.items.length ? '<div class="empty">没有匹配的接入网站。</div>' : ''}`;
  renderPager('#access-pager', 'access', pageInfo);
}

function renderClientAccessOptions() {
  const filtered = state.accounts.filter(account => matchesSearch([
    account.email, account.owner, account.enabled ? '允许登录' : '已停用'
  ], state.clientAccessView.query));
  const pageInfo = paginate(filtered, state.clientAccessView, DIALOG_PAGE_SIZE);
  $('#client-access-options').innerHTML = pageInfo.items.length ? pageInfo.items.map(account => {
    const manageable = account.role !== 'admin' || state.me.role === 'owner';
    return `
    <label class="check-item">
      <input type="checkbox" name="account-client-access" value="${escapeHtml(account.id)}" ${state.clientAccessSelection.has(account.id) ? 'checked' : ''} ${manageable ? '' : 'disabled'}>
      <span><strong>${escapeHtml(account.owner || '未填写持有人')}</strong><br><span class="meta">${escapeHtml(account.email)} · ${escapeHtml(roleLabel(account.role))}${(account.allowedClientIds || []).includes('*') ? ' · 当前授权全部网站' : ''}${account.enabled ? '' : ' · 账号已停用'}${manageable ? '' : ' · 仅终端拥有者可修改'}</span></span>
    </label>`;
  }).join('') : '<div class="empty">没有匹配的账号。</div>';
  renderPager('#client-access-pager', 'client-access', pageInfo);
}

function renderAll() {
  $('#current-admin').textContent = `${state.me.name} · ${roleLabel(state.me.role)}`;
  renderAccounts();
  renderClients();
  renderAuditLogs();
}

async function refreshAll() {
  const [meResult, accountResult, clientResult, auditResult] = await Promise.all([
    adminApi.me(), adminApi.listAccounts(), adminApi.listClients(), adminApi.auditLogs()
  ]);
  state.me = meResult.admin;
  state.permissions = meResult.permissions;
  state.accounts = accountResult.accounts;
  state.clients = clientResult.clients;
  state.auditLogs = auditResult.logs;
  renderAll();
}

[
  ['#account-search', state.listViews.accounts, renderAccounts],
  ['#client-search', state.listViews.clients, renderClients],
  ['#audit-search', state.listViews.audits, renderAuditLogs]
].forEach(([selector, view, renderer]) => {
  $(selector).addEventListener('input', event => {
    view.query = event.target.value;
    view.page = 1;
    renderer();
  });
});

function goToPage(target, page) {
  const numericPage = Math.max(1, Number(page) || 1);
  const routes = {
    accounts: [state.listViews.accounts, renderAccounts],
    clients: [state.listViews.clients, renderClients],
    audits: [state.listViews.audits, renderAuditLogs],
    access: [state.accessView, renderAccessOptions],
    'client-access': [state.clientAccessView, renderClientAccessOptions]
  };
  const route = routes[target];
  if (!route) return;
  route[0].page = numericPage;
  route[1]();
}

function showCredential(email, password, title = '初始密码已生成') {
  state.currentCredential = password;
  $('#credential-title').textContent = title;
  $('#credential-email').textContent = email;
  $('#credential-password').textContent = password;
  $('#credential-dialog').showModal();
}

$('#admin-key-form').addEventListener('submit', async event => {
  event.preventDefault();
  const email = $('#admin-email').value.trim();
  const password = $('#admin-key').value;
  const button = $('#admin-key-submit');
  $('#admin-key-error').hidden = true;
  if (!email || !password) return;
  setButtonLoading(button, true, '正在登录');
  try {
    const result = await adminApi.login(email, password);
    state.token = result.token;
    state.me = result.admin;
    state.permissions = result.permissions;
    sessionStorage.setItem('terminalAdminToken', result.token);
    sessionStorage.setItem('terminalAdminEmail', email);
    await refreshAll();
    $('#admin-key-dialog').close();
  } catch (error) {
    $('#admin-key-error').textContent = error.message;
    $('#admin-key-error').hidden = false;
  } finally {
    setButtonLoading(button, false, '');
  }
});

$('#admin-key-dialog').addEventListener('cancel', event => event.preventDefault());
$('#change-admin-key').addEventListener('click', () => clearAdminSession());
$('#admin-logout').addEventListener('click', async () => {
  await adminApi.logout().catch(() => null);
  clearAdminSession('已退出管理员登录。');
});

$('#change-admin-password').addEventListener('click', () => {
  $('#admin-password-form').reset();
  $('#admin-password-error').hidden = true;
  $('#admin-password-dialog').showModal();
});

$('#admin-password-form').addEventListener('submit', async event => {
  event.preventDefault();
  const currentPassword = $('#admin-current-password').value;
  const newPassword = $('#admin-new-password').value;
  const confirmPassword = $('#admin-confirm-password').value;
  const error = $('#admin-password-error');
  error.hidden = true;
  if (newPassword.length < 10 || !/[A-Za-z]/.test(newPassword) || !/\d/.test(newPassword)) {
    error.textContent = '新密码需至少 10 位，且同时包含字母与数字。';
    error.hidden = false;
    return;
  }
  if (newPassword !== confirmPassword) {
    error.textContent = '两次输入的新密码不一致。';
    error.hidden = false;
    return;
  }
  const button = $('#admin-password-submit');
  setButtonLoading(button, true, '正在修改');
  try {
    await adminApi.changeMyPassword(currentPassword, newPassword);
    $('#admin-password-dialog').close();
    showToast('管理员密码已修改');
    await refreshAll();
  } catch (requestError) {
    error.textContent = requestError.message;
    error.hidden = false;
  } finally {
    setButtonLoading(button, false, '');
  }
});

$('#open-create').addEventListener('click', () => {
  if (!can('accounts:write')) return;
  $('#create-form').reset();
  ['create-email-error', 'create-owner-error'].forEach(id => { document.getElementById(id).hidden = true; });
  $('#create-dialog').showModal();
  requestAnimationFrame(() => $('#create-email').focus());
});

$('#create-form').addEventListener('submit', async event => {
  event.preventDefault();
  const email = $('#create-email').value.trim();
  const owner = $('#create-owner').value.trim();
  const emailError = $('#create-email-error');
  const ownerError = $('#create-owner-error');
  emailError.hidden = true;
  ownerError.hidden = true;
  let valid = true;
  if (!email || !isEmail(email)) {
    emailError.textContent = email ? '请输入有效的账号格式。' : '请输入账号。';
    emailError.hidden = false;
    valid = false;
  }
  if (!owner) {
    ownerError.textContent = '请输入账号持有人。';
    ownerError.hidden = false;
    valid = false;
  }
  if (!valid) return;
  const button = $('#create-submit');
  setButtonLoading(button, true, '正在生成');
  try {
    const result = await adminApi.createAccount(email, owner);
    $('#create-dialog').close();
    await refreshAll();
    showCredential(result.account.email, result.initialPassword);
  } catch (error) {
    emailError.textContent = error.message;
    emailError.hidden = false;
  } finally {
    setButtonLoading(button, false, '');
  }
});

$('#account-rows').addEventListener('change', async event => {
  const select = event.target.closest('[data-account-role]');
  if (!select) return;
  select.disabled = true;
  try {
    await adminApi.setAccountRole(select.dataset.accountRole, select.value);
    await refreshAll();
    showToast(select.value === 'admin' ? '该账号已设为管理员' : '该账号已恢复为普通用户');
  } catch (error) {
    showToast(error.message);
    await refreshAll().catch(() => null);
  }
});

$('#account-rows').addEventListener('click', async event => {
  const accessButton = event.target.closest('[data-access-account]');
  if (accessButton) {
    const account = state.accounts.find(item => item.id === accessButton.dataset.accessAccount);
    if (!account) return;
    state.pendingAccessId = account.id;
    state.accessSelection = new Set(account.allowedClientIds || []);
    state.accessView = { query: '', page: 1 };
    $('#access-search').value = '';
    $('#access-account').textContent = `${account.owner}（${account.email}）`;
    renderAccessOptions();
    $('#access-error').hidden = true;
    $('#access-dialog').showModal();
    return;
  }

  const toggleButton = event.target.closest('[data-toggle-account]');
  if (toggleButton) {
    toggleButton.disabled = true;
    try {
      await adminApi.setAccountEnabled(toggleButton.dataset.toggleAccount, toggleButton.dataset.nextEnabled === 'true');
      await refreshAll();
      showToast('账号权限已更新');
    } catch (error) {
      toggleButton.disabled = false;
      showToast(error.message);
    }
    return;
  }

  const resetButton = event.target.closest('[data-reset-account]');
  if (resetButton) {
    const account = state.accounts.find(item => item.id === resetButton.dataset.resetAccount);
    if (!account) return;
    state.pendingResetId = account.id;
    $('#reset-email').textContent = `${account.owner}（${account.email}）`;
    $('#reset-dialog').showModal();
  }
});

$('#access-options').addEventListener('change', event => {
  const checkbox = event.target.closest('input[type="checkbox"]');
  if (!checkbox) return;
  if (checkbox.value === '*') {
    state.accessSelection = checkbox.checked ? new Set(['*']) : new Set();
  } else if (checkbox.checked) {
    state.accessSelection.delete('*');
    state.accessSelection.add(checkbox.value);
  } else {
    state.accessSelection.delete(checkbox.value);
  }
  renderAccessOptions();
});

$('#access-search').addEventListener('input', event => {
  state.accessView.query = event.target.value;
  state.accessView.page = 1;
  renderAccessOptions();
});

$('#access-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!state.pendingAccessId) return;
  const clientIds = [...state.accessSelection];
  const button = $('#access-submit');
  setButtonLoading(button, true, '正在保存');
  try {
    await adminApi.setAccountAccess(state.pendingAccessId, clientIds);
    $('#access-dialog').close();
    state.pendingAccessId = null;
    await refreshAll();
    showToast('网站授权已更新');
  } catch (error) {
    $('#access-error').textContent = error.message;
    $('#access-error').hidden = false;
  } finally {
    setButtonLoading(button, false, '');
  }
});

$('#confirm-reset').addEventListener('click', async event => {
  if (!state.pendingResetId) return;
  const button = event.currentTarget;
  setButtonLoading(button, true, '正在重置');
  try {
    const result = await adminApi.resetAccountPassword(state.pendingResetId);
    $('#reset-dialog').close();
    state.pendingResetId = null;
    await refreshAll();
    showCredential(result.account.email, result.initialPassword);
  } catch (error) {
    showToast(error.message);
  } finally {
    setButtonLoading(button, false, '');
  }
});

$('#open-client-create').addEventListener('click', () => {
  if (!can('clients:write')) return;
  $('#client-form').reset();
  $('#client-error').hidden = true;
  $('#client-dialog').showModal();
});

$('#client-form').addEventListener('submit', async event => {
  event.preventDefault();
  const payload = {
    clientId: $('#client-id').value.trim(),
    name: $('#client-name').value.trim(),
    allowedOrigin: $('#client-origin').value.trim()
  };
  const error = $('#client-error');
  error.hidden = true;
  if (!payload.clientId || !payload.name || !payload.allowedOrigin) {
    error.textContent = '请完整填写客户端 ID、网站名称与 Origin。';
    error.hidden = false;
    return;
  }
  const button = $('#client-submit');
  setButtonLoading(button, true, '正在保存');
  try {
    await adminApi.createClient(payload);
    $('#client-dialog').close();
    await refreshAll();
    showToast('接入网站已登记');
  } catch (errorValue) {
    error.textContent = errorValue.message;
    error.hidden = false;
  } finally {
    setButtonLoading(button, false, '');
  }
});

$('#client-rows').addEventListener('click', async event => {
  const accessButton = event.target.closest('[data-client-access]');
  if (accessButton) {
    const client = state.clients.find(item => item.id === accessButton.dataset.clientAccess);
    if (!client) return;
    state.pendingClientAccessId = client.id;
    state.clientAccessSelection = new Set(
      state.accounts.filter(account => accountHasClientAccess(account, client.id)).map(account => account.id)
    );
    state.clientAccessOriginal = new Set(state.clientAccessSelection);
    state.clientAccessView = { query: '', page: 1 };
    $('#client-access-search').value = '';
    $('#client-access-name').textContent = `${client.name}（${client.id}）`;
    $('#client-access-error').hidden = true;
    renderClientAccessOptions();
    $('#client-access-dialog').showModal();
    return;
  }

  const button = event.target.closest('[data-toggle-client]');
  if (!button) return;
  button.disabled = true;
  try {
    await adminApi.setClientEnabled(button.dataset.toggleClient, button.dataset.nextEnabled === 'true');
    await refreshAll();
    showToast('网站接入状态已更新');
  } catch (error) {
    button.disabled = false;
    showToast(error.message);
  }
});

$('#client-access-options').addEventListener('change', event => {
  const checkbox = event.target.closest('input[type="checkbox"]');
  if (!checkbox) return;
  if (checkbox.checked) state.clientAccessSelection.add(checkbox.value);
  else state.clientAccessSelection.delete(checkbox.value);
});

$('#client-access-search').addEventListener('input', event => {
  state.clientAccessView.query = event.target.value;
  state.clientAccessView.page = 1;
  renderClientAccessOptions();
});

$('#client-access-form').addEventListener('submit', async event => {
  event.preventDefault();
  const clientId = state.pendingClientAccessId;
  if (!clientId) return;
  const changedAccounts = state.accounts.filter(account =>
    state.clientAccessOriginal.has(account.id) !== state.clientAccessSelection.has(account.id)
  );
  const button = $('#client-access-submit');
  const error = $('#client-access-error');
  error.hidden = true;
  setButtonLoading(button, true, `正在保存（0/${changedAccounts.length}）`);
  try {
    for (let index = 0; index < changedAccounts.length; index += 1) {
      const account = changedAccounts[index];
      const shouldAllow = state.clientAccessSelection.has(account.id);
      const currentIds = Array.isArray(account.allowedClientIds) ? account.allowedClientIds : [];
      let nextIds;
      if (shouldAllow) {
        nextIds = currentIds.includes('*') ? ['*'] : [...new Set([...currentIds, clientId])];
      } else if (currentIds.includes('*')) {
        nextIds = state.clients.filter(client => client.id !== clientId).map(client => client.id);
      } else {
        nextIds = currentIds.filter(id => id !== clientId);
      }
      await adminApi.setAccountAccess(account.id, nextIds);
      button.textContent = `正在保存（${index + 1}/${changedAccounts.length}）`;
    }
    $('#client-access-dialog').close();
    state.pendingClientAccessId = null;
    await refreshAll();
    showToast(changedAccounts.length ? '网站用户权限已更新' : '权限没有变化');
  } catch (requestError) {
    error.textContent = `部分权限可能已保存：${requestError.message}`;
    error.hidden = false;
    await refreshAll().catch(() => null);
  } finally {
    setButtonLoading(button, false, '');
  }
});

$('#copy-password').addEventListener('click', async () => {
  if (!state.currentCredential) return;
  try {
    await navigator.clipboard.writeText(state.currentCredential);
    showToast('初始密码已复制');
  } catch (_) {
    showToast('复制失败，请手动选择密码');
  }
});

document.addEventListener('click', event => {
  const pageButton = event.target.closest('[data-page-target]');
  if (pageButton) {
    goToPage(pageButton.dataset.pageTarget, pageButton.dataset.page);
    return;
  }

  const closeButton = event.target.closest('[data-close-dialog]');
  if (!closeButton) return;
  const dialog = document.getElementById(closeButton.dataset.closeDialog);
  dialog.close();
  if (dialog.id === 'credential-dialog') {
    state.currentCredential = null;
    $('#credential-password').textContent = '—';
  }
  if (dialog.id === 'reset-dialog') state.pendingResetId = null;
  if (dialog.id === 'access-dialog') {
    state.pendingAccessId = null;
    state.accessSelection = new Set();
  }
  if (dialog.id === 'client-access-dialog') {
    state.pendingClientAccessId = null;
    state.clientAccessSelection = new Set();
    state.clientAccessOriginal = new Set();
  }
});

if (state.token) {
  refreshAll().catch(error => {
    if (state.token) showToast(error.message);
  });
} else {
  openAdminLoginDialog();
}
