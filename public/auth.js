/* 登录/注册页逻辑：调用 /api/auth/*，token 存 localStorage（7 天服务端校验） */
(function () {
  'use strict';

  var TOKEN_KEY = 'sip_token';
  var USER_KEY = 'sip_username';

  // 已登录则直接进入首页
  if (localStorage.getItem(TOKEN_KEY)) {
    fetch('/api/auth/me', { headers: { 'Authorization': 'Bearer ' + localStorage.getItem(TOKEN_KEY) } })
      .then(function (r) { if (r.ok) location.replace('/index.html'); else localStorage.removeItem(TOKEN_KEY); })
      .catch(function () {});
  }

  var mode = 'login';
  var tabLogin = document.getElementById('tab-login');
  var tabRegister = document.getElementById('tab-register');
  var form = document.getElementById('auth-form');
  var submitBtn = document.getElementById('auth-submit');
  var errBox = document.getElementById('auth-error');
  var noticeBox = document.getElementById('login-notice');

  // 被挤下线 / 会话过期的回跳提示
  var reason = new URLSearchParams(location.search).get('reason');
  if (reason === 'replaced') {
    noticeBox.textContent = '该账号刚在其他设备登录，当前设备已被退出。同一账号同一时间仅支持一台设备在线，如非本人操作请及时修改密码。';
    noticeBox.hidden = false;
  } else if (reason === 'expired') {
    noticeBox.textContent = '登录态已失效，请重新登录。';
    noticeBox.hidden = false;
  }

  function setMode(m) {
    mode = m;
    tabLogin.classList.toggle('active', m === 'login');
    tabRegister.classList.toggle('active', m === 'register');
    submitBtn.textContent = m === 'login' ? '登录' : '注册并登录';
    errBox.hidden = true;
  }
  tabLogin.addEventListener('click', function () { setMode('login'); });
  tabRegister.addEventListener('click', function () { setMode('register'); });

  function showError(msg) {
    errBox.textContent = msg;
    errBox.hidden = false;
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var username = document.getElementById('username').value.trim();
    var password = document.getElementById('password').value;
    errBox.hidden = true;

    if (!/^[a-zA-Z0-9_]{4,20}$/.test(username)) { showError('用户名需为 4-20 位字母、数字或下划线'); return; }
    if (password.length < 6 || password.length > 20) { showError('密码长度需为 6-20 位'); return; }

    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span class="btn-spinner"></span>' + (mode === 'login' ? '登录中…' : '注册中…');

    var navigated = false;
    fetch('/api/auth/' + mode, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username, password: password })
    })
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); })
      .then(function (res) {
        if (!res.body.ok) { showError(res.body.error || '操作失败，请重试'); return; }
        localStorage.setItem(TOKEN_KEY, res.body.token);
        localStorage.setItem(USER_KEY, res.body.username);
        navigated = true;
        location.replace('/index.html');
      })
      .catch(function () { showError('网络异常，请稍后重试'); })
      .finally(function () {
        if (navigated) return; // 页面正在跳转，不再触碰旧文档 DOM
        submitBtn.disabled = false;
        submitBtn.textContent = mode === 'login' ? '登录' : '注册并登录';
      });
  });
})();
