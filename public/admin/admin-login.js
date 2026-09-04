/* 后台登录页逻辑：POST /api/admin/login，仅 admin/operator/viewer 角色可入 */
(function () {
  'use strict';

  var TOKEN_KEY = 'sip_admin_token';

  // 已登录且角色有效则直接进后台
  if (localStorage.getItem(TOKEN_KEY)) {
    fetch('/api/admin/me', { headers: { 'Authorization': 'Bearer ' + localStorage.getItem(TOKEN_KEY) } })
      .then(function (r) { if (r.ok) location.replace('/admin/'); else localStorage.removeItem(TOKEN_KEY); })
      .catch(function () {});
  }

  var form = document.getElementById('al-form');
  var submitBtn = document.getElementById('al-submit');
  var errBox = document.getElementById('al-error');
  var noticeBox = document.getElementById('al-notice');

  var reason = new URLSearchParams(location.search).get('reason');
  if (reason === 'replaced') {
    noticeBox.textContent = '该账号刚在其他设备登录后台，当前设备已被退出。如非本人操作请联系管理员重置密码。';
    noticeBox.hidden = false;
  } else if (reason === 'expired') {
    noticeBox.textContent = '登录态已失效，请重新登录。';
    noticeBox.hidden = false;
  } else if (reason === 'disabled') {
    noticeBox.textContent = '账号已被禁用，请联系管理员。';
    noticeBox.hidden = false;
  }

  function showError(msg) {
    errBox.textContent = msg;
    errBox.hidden = false;
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var username = document.getElementById('username').value.trim();
    var password = document.getElementById('password').value;
    errBox.hidden = true;
    if (!username || !password) { showError('请输入账号和密码'); return; }

    submitBtn.disabled = true;
    submitBtn.textContent = '登录中…';
    var navigated = false;
    fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username, password: password })
    })
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); })
      .then(function (res) {
        if (!res.body.ok) { showError(res.body.error || '登录失败，请重试'); return; }
        localStorage.setItem(TOKEN_KEY, res.body.token);
        navigated = true;
        location.replace('/admin/');
      })
      .catch(function () { showError('网络异常，请稍后重试'); })
      .finally(function () {
        if (navigated) return;
        submitBtn.disabled = false;
        submitBtn.textContent = '登录后台';
      });
  });
})();
