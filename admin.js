'use strict';

// GitHub Pages 仅运行管理界面，所有敏感操作仍由云函数鉴权后写入私有 COS。
const CONFIG = { API_BASE_URL: 'https://1447704904-cwscdb1mvx.ap-guangzhou.tencentscf.com/api' };
const state = {
  token: sessionStorage.getItem('terminalAdminToken') || '',
  me: null,
  permissions: [],
  roles: [],
  accounts: [],
  clients: [],
  admins: [],
  auditLogs: [],
  pendingResetId: null,
  pendingAccessId: null,
  currentCredential: null
};

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
  return state.roles.find(item => item.value === role)?.label || role;
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
  roles() { return request('/admin/roles'); },
  listAccounts() { return request('/admin/accounts'); },
  createAccount(email, owner) { return request('/admin/accounts', { method: 'POST', body: { email, owner } }); },
  setAccountEnabled(id, enabled) {
    return request(`/admin/accounts/${encodeURIComponent(id)}/status`, { method: 'PATCH', body: { enabled } });
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
  listAdmins() { return request('/admin/admins'); },
  createAdmin(payload) { return request('/admin/admins', { method: 'POST', body: payload }); },
  setAdminEnabled(id, enabled) {
    return request(`/admin/admins/${encodeURIComponent(id)}/status`, { method: 'PATCH', body: { enabled } });
  },
  setAdminRole(id, role) {
    return request(`/admin/admins/${encodeURIComponent(id)}/role`, { method: 'PATCH', body: { role } });
  },
  resetAdminPassword(id) { return request(`/admin/admins/${encodeURIComponent(id)}/reset`, { method: 'POST' }); },
  changeMyPassword(currentPassword, newPassword) {
    return request('/admin/password/change', { method: 'POST', body: { currentPassword, newPassword } });
  },
  auditLogs() { return request('/admin/audit-logs?limit=100'); }
};

function accountAccessLabel(account) {
  const ids = Array.isArray(account.allowedClientIds) ? account.allowedClientIds : [];
  if (ids.includes('*')) return '全部网站';
  if (!ids.length) return '未授权';
  return ids.map(id => state.clients.find(client => client.id === id)?.name || id).join('、');
}

function renderAccounts() {
  const writable = can('accounts:write');
  $('#open-create').disabled = !writable;
  $('#stat-total').textContent = state.accounts.length;
  $('#stat-enabled').textContent = state.accounts.filter(account => account.enabled).length;
  $('#stat-initial').textContent = state.accounts.filter(account => account.passwordMode === 'initial').length;

  $('#account-rows').innerHTML = state.accounts.length ? state.accounts.map(account => `
    <tr>
      <td><strong>${escapeHtml(account.email)}</strong></td>
      <td>${escapeHtml(account.owner || '—')}</td>
      <td><span class="status-tag ${account.enabled ? 'status-enabled' : 'status-disabled'}">${account.enabled ? '允许登录' : '已停用'}</span></td>
      <td><span class="status-tag ${account.passwordMode === 'initial' ? 'status-initial' : 'status-changed'}">${account.passwordMode === 'initial' ? '首次随机密码' : '用户已修改'}</span></td>
      <td>${escapeHtml(accountAccessLabel(account))}</td>
      <td>${escapeHtml(formatDate(account.passwordUpdatedAt))}</td>
      <td>${escapeHtml(formatDate(account.lastLoginAt))}</td>
      <td>
        <div class="actions">
          ${writable ? `
            <button class="btn btn-small" type="button" data-access-account="${escapeHtml(account.id)}">授权网站</button>
            <button class="btn btn-small" type="button" data-toggle-account="${escapeHtml(account.id)}" data-next-enabled="${String(!account.enabled)}">${account.enabled ? '停用' : '启用'}</button>
            <button class="btn btn-small" type="button" data-reset-account="${escapeHtml(account.id)}">重置密码</button>` : '<span class="meta">只读</span>'}
        </div>
      </td>
    </tr>`).join('') : '<tr><td colspan="8"><div class="empty">暂无可登录账号。</div></td></tr>';
}

function renderClients() {
  const writable = can('clients:write');
  $('#open-client-create').disabled = !writable;
  $('#client-rows').innerHTML = state.clients.length ? state.clients.map(client => `
    <tr>
      <td><code>${escapeHtml(client.id)}</code></td>
      <td><strong>${escapeHtml(client.name)}</strong></td>
      <td><ul class="origin-list">${client.allowedOrigins.map(origin => `<li>${escapeHtml(origin)}</li>`).join('')}</ul></td>
      <td><span class="status-tag ${client.enabled ? 'status-enabled' : 'status-disabled'}">${client.enabled ? '允许接入' : '已停用'}</span></td>
      <td>${writable
        ? `<button class="btn btn-small" type="button" data-toggle-client="${escapeHtml(client.id)}" data-next-enabled="${String(!client.enabled)}">${client.enabled ? '停用' : '启用'}</button>`
        : '<span class="meta">只读</span>'}</td>
    </tr>`).join('') : '<tr><td colspan="5"><div class="empty">暂无接入网站。</div></td></tr>';
}

function renderAdmins() {
  const writable = can('admins:write');
  $('#open-admin-create').disabled = !writable;
  $('#admin-rows').innerHTML = state.admins.length ? state.admins.map(admin => `
    <tr>
      <td><strong>${escapeHtml(admin.name)}</strong>${admin.id === state.me?.id ? '（当前）' : ''}</td>
      <td>${escapeHtml(admin.email)}</td>
      <td>
        <select data-admin-role="${escapeHtml(admin.id)}" aria-label="${escapeHtml(admin.name)}的角色" ${writable ? '' : 'disabled'}>
          ${state.roles.map(role => `<option value="${escapeHtml(role.value)}" ${role.value === admin.role ? 'selected' : ''}>${escapeHtml(role.label)}</option>`).join('')}
        </select>
      </td>
      <td><span class="status-tag ${admin.enabled ? 'status-enabled' : 'status-disabled'}">${admin.enabled ? '正常' : '已停用'}</span></td>
      <td>${escapeHtml(formatDate(admin.lastLoginAt))}</td>
      <td>
        <div class="actions">
          ${writable ? `
            <button class="btn btn-small" type="button" data-toggle-admin="${escapeHtml(admin.id)}" data-next-enabled="${String(!admin.enabled)}">${admin.enabled ? '停用' : '启用'}</button>
            <button class="btn btn-small" type="button" data-reset-admin="${escapeHtml(admin.id)}">重置密码</button>` : '<span class="meta">只读</span>'}
        </div>
      </td>
    </tr>`).join('') : '<tr><td colspan="6"><div class="empty">暂无管理员。</div></td></tr>';
}

function renderAuditLogs() {
  $('#audit-rows').innerHTML = state.auditLogs.length ? state.auditLogs.map(log => `
    <tr>
      <td>${escapeHtml(formatDate(log.createdAt))}</td>
      <td>${escapeHtml(log.actorName)}<br><span class="meta">${escapeHtml(log.actorEmail)}</span></td>
      <td>${escapeHtml(log.action)}</td>
      <td>${escapeHtml(log.target)}</td>
      <td>${escapeHtml(log.detail || '—')}</td>
    </tr>`).join('') : '<tr><td colspan="5"><div class="empty">暂无审计记录。</div></td></tr>';
}

function renderAll() {
  $('#current-admin').textContent = `${state.me.name} · ${roleLabel(state.me.role)}`;
  renderAccounts();
  renderClients();
  renderAdmins();
  renderAuditLogs();
}

async function refreshAll() {
  const [meResult, roleResult, accountResult, clientResult, adminResult, auditResult] = await Promise.all([
    adminApi.me(), adminApi.roles(), adminApi.listAccounts(), adminApi.listClients(), adminApi.listAdmins(), adminApi.auditLogs()
  ]);
  state.me = meResult.admin;
  state.permissions = meResult.permissions;
  state.roles = roleResult.roles;
  state.accounts = accountResult.accounts;
  state.clients = clientResult.clients;
  state.admins = adminResult.admins;
  state.auditLogs = auditResult.logs;
  renderAll();
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
    emailError.textContent = email ? '请输入有效的邮箱格式。' : '请输入飞书邮箱号。';
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

$('#account-rows').addEventListener('click', async event => {
  const accessButton = event.target.closest('[data-access-account]');
  if (accessButton) {
    const account = state.accounts.find(item => item.id === accessButton.dataset.accessAccount);
    if (!account) return;
    state.pendingAccessId = account.id;
    $('#access-account').textContent = `${account.owner}（${account.email}）`;
    const selected = new Set(account.allowedClientIds || []);
    $('#access-options').innerHTML = `
      <label class="check-item"><input type="checkbox" name="client-access" value="*" ${selected.has('*') ? 'checked' : ''}><span><strong>全部接入网站</strong><br><span class="meta">包含以后新增的网站</span></span></label>
      ${state.clients.map(client => `<label class="check-item"><input type="checkbox" name="client-access" value="${escapeHtml(client.id)}" ${selected.has(client.id) ? 'checked' : ''}><span><strong>${escapeHtml(client.name)}</strong><br><span class="meta">${escapeHtml(client.id)}</span></span></label>`).join('')}`;
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
  if (!checkbox || !checkbox.checked) return;
  const all = [...document.querySelectorAll('input[name="client-access"]')];
  if (checkbox.value === '*') all.filter(item => item.value !== '*').forEach(item => { item.checked = false; });
  else all.find(item => item.value === '*').checked = false;
});

$('#access-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!state.pendingAccessId) return;
  const clientIds = [...document.querySelectorAll('input[name="client-access"]:checked')].map(input => input.value);
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

$('#open-admin-create').addEventListener('click', () => {
  if (!can('admins:write')) return;
  $('#admin-create-form').reset();
  $('#admin-create-error').hidden = true;
  $('#new-admin-role').innerHTML = state.roles.map(role => `<option value="${escapeHtml(role.value)}">${escapeHtml(role.label)}</option>`).join('');
  $('#admin-create-dialog').showModal();
});

$('#admin-create-form').addEventListener('submit', async event => {
  event.preventDefault();
  const payload = {
    name: $('#new-admin-name').value.trim(),
    email: $('#new-admin-email').value.trim(),
    role: $('#new-admin-role').value
  };
  const error = $('#admin-create-error');
  error.hidden = true;
  if (!payload.name || !isEmail(payload.email) || !payload.role) {
    error.textContent = '请填写姓名、有效邮箱并选择角色。';
    error.hidden = false;
    return;
  }
  const button = $('#admin-create-submit');
  setButtonLoading(button, true, '正在创建');
  try {
    const result = await adminApi.createAdmin(payload);
    $('#admin-create-dialog').close();
    await refreshAll();
    showCredential(result.admin.email, result.initialPassword, '管理员初始密码已生成');
  } catch (requestError) {
    error.textContent = requestError.message;
    error.hidden = false;
  } finally {
    setButtonLoading(button, false, '');
  }
});

$('#admin-rows').addEventListener('change', async event => {
  const select = event.target.closest('[data-admin-role]');
  if (!select) return;
  select.disabled = true;
  try {
    await adminApi.setAdminRole(select.dataset.adminRole, select.value);
    await refreshAll();
    showToast('管理员角色已更新');
  } catch (error) {
    showToast(error.message);
    await refreshAll().catch(() => null);
  }
});

$('#admin-rows').addEventListener('click', async event => {
  const toggle = event.target.closest('[data-toggle-admin]');
  if (toggle) {
    toggle.disabled = true;
    try {
      await adminApi.setAdminEnabled(toggle.dataset.toggleAdmin, toggle.dataset.nextEnabled === 'true');
      await refreshAll();
      showToast('管理员状态已更新');
    } catch (error) {
      toggle.disabled = false;
      showToast(error.message);
    }
    return;
  }
  const reset = event.target.closest('[data-reset-admin]');
  if (!reset) return;
  reset.disabled = true;
  try {
    const result = await adminApi.resetAdminPassword(reset.dataset.resetAdmin);
    await refreshAll();
    showCredential(result.admin.email, result.initialPassword, '管理员密码已重置');
  } catch (error) {
    reset.disabled = false;
    showToast(error.message);
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
  const closeButton = event.target.closest('[data-close-dialog]');
  if (!closeButton) return;
  const dialog = document.getElementById(closeButton.dataset.closeDialog);
  dialog.close();
  if (dialog.id === 'credential-dialog') {
    state.currentCredential = null;
    $('#credential-password').textContent = '—';
  }
  if (dialog.id === 'reset-dialog') state.pendingResetId = null;
  if (dialog.id === 'access-dialog') state.pendingAccessId = null;
});

if (state.token) {
  refreshAll().catch(error => {
    if (state.token) showToast(error.message);
  });
} else {
  openAdminLoginDialog();
}
