/* 数据资产后台管理系统主逻辑(零依赖原生 JS)
 * 权限:admin 全部;operator 资产/商圈/门店增删改;viewer 只读+导出
 */
(function () {
  'use strict';

  var TOKEN_KEY = 'sip_admin_token';
  var ROLE_NAMES = { admin: '管理员', operator: '运营人员', viewer: '只读人员' };
  var state = {
    token: localStorage.getItem(TOKEN_KEY) || '',
    me: null,
    boards: [],
    districts: [],
    view: 'assets',
    users: { page: 1, size: 10 },
    assets: { page: 1, size: 10 },
    districtsQ: { page: 1, size: 10 },
    stores: { page: 1, size: 10 }
  };

  /* ---------- 工具 ---------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtTime(iso) {
    if (!iso) return '-';
    var d = new Date(iso);
    if (isNaN(d)) return esc(iso);
    var p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function toast(msg, isErr) {
    var t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'toast' + (isErr ? ' err' : '');
    t.hidden = false;
    clearTimeout(t._timer);
    t._timer = setTimeout(function () { t.hidden = true; }, 2600);
  }
  function canEdit() { return state.me && (state.me.role === 'admin' || state.me.role === 'operator'); }
  function isAdmin() { return state.me && state.me.role === 'admin'; }

  function logout(reason) {
    localStorage.removeItem(TOKEN_KEY);
    location.replace('/admin/login.html' + (reason ? '?reason=' + reason : ''));
  }

  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ 'Authorization': 'Bearer ' + state.token }, opts.headers || {});
    if (opts.json !== undefined) {
      opts.method = opts.method || 'POST';
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.json);
      delete opts.json;
    }
    return fetch(path, opts).then(function (r) {
      if (r.status === 401) {
        return r.json().then(function (j) {
          logout(j.code === 'SESSION_REPLACED' ? 'replaced' : 'expired');
          throw new Error('unauthorized');
        });
      }
      if (r.status === 403) {
        return r.json().then(function (j) {
          if (j.code === 'ACCOUNT_DISABLED') { logout('disabled'); throw new Error('disabled'); }
          toast(j.error || '无权限', true);
          throw new Error('forbidden');
        });
      }
      return r.json();
    });
  }

  /* ---------- 通用弹窗 ---------- */
  var mask = document.getElementById('mask');
  function openModal(title, bodyHtml, footButtons) {
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-body').innerHTML = bodyHtml;
    var foot = document.getElementById('modal-foot');
    foot.innerHTML = '';
    footButtons.forEach(function (b) {
      var btn = document.createElement('button');
      btn.className = 'btn ' + (b.cls || '');
      btn.textContent = b.text;
      btn.addEventListener('click', function () { b.onClick && b.onClick(); });
      foot.appendChild(btn);
    });
    mask.hidden = false;
  }
  function closeModal() {
    mask.hidden = true;
    var card = mask.querySelector('.modal');
    if (card) card.classList.remove('modal-guide');
  }
  document.getElementById('modal-close').addEventListener('click', closeModal);
  mask.addEventListener('click', function (e) { if (e.target === mask) closeModal(); });

  function confirmModal(title, text, onOk) {
    openModal(title, '<p style="margin:0;font-size:13px;line-height:1.8">' + text + '</p>', [
      { text: '取消', onClick: closeModal },
      { text: '确认', cls: 'btn-danger', onClick: function () { closeModal(); onOk(); } }
    ]);
  }

  /* ---------- 分页 ---------- */
  function renderPager(el, data, onGo) {
    el.innerHTML = '共 ' + data.total + ' 条 · 第 ' + data.page + '/' + data.pages + ' 页';
    var prev = document.createElement('button');
    prev.className = 'btn'; prev.textContent = '上一页';
    prev.disabled = data.page <= 1;
    prev.addEventListener('click', function () { onGo(data.page - 1); });
    var next = document.createElement('button');
    next.className = 'btn'; next.textContent = '下一页';
    next.disabled = data.page >= data.pages;
    next.addEventListener('click', function () { onGo(data.page + 1); });
    el.appendChild(prev); el.appendChild(next);
  }

  function emptyHtml(text) {
    return '<div class="empty-state"><b>暂无数据</b>' + esc(text || '可点击右上角按钮新增，或调整筛选条件') + '</div>';
  }

  function downloadCsv(path, filename) {
    fetch(path, { headers: { 'Authorization': 'Bearer ' + state.token } })
      .then(function (r) {
        if (!r.ok) throw new Error('export failed');
        return r.blob();
      })
      .then(function (blob) {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        URL.revokeObjectURL(a.href);
      })
      .catch(function () { toast('导出失败', true); });
  }

  // 轻量 CSV 解析(支持引号包裹与转义)
  function parseCsv(text) {
    var rows = [], row = [], cell = '', inQ = false;
    text = text.replace(/^﻿/, '');
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (inQ) {
        if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false; }
        else cell += c;
      } else if (c === '"') inQ = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); cell = '';
        if (row.some(function (x) { return x.trim() !== ''; })) rows.push(row);
        row = [];
      } else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); if (row.some(function (x) { return x.trim() !== ''; })) rows.push(row); }
    return rows;
  }

  // 批量导入弹窗:columns=[{key,label}];template 示例行
  function openImportModal(title, columns, templateRow, submitRows) {
    var header = columns.map(function (c) { return c.label; }).join(',');
    var body =
      '<div class="field span2"><label>第一步:下载模板,按列填写(首行表头须与模板一致)</label>' +
      '<button class="btn btn-sm" id="imp-tpl">下载 CSV 模板</button></div>' +
      '<div class="field span2" style="margin-top:12px"><label>第二步:选择填好的 CSV 文件,或直接粘贴内容</label>' +
      '<input type="file" id="imp-file" accept=".csv,text/csv" style="margin-bottom:8px">' +
      '<textarea id="imp-text" rows="7" placeholder="' + esc(header) + '\n' + esc(templateRow) + '"></textarea></div>' +
      '<div class="import-result" id="imp-result"></div>';
    openModal(title, body, [
      { text: '取消', onClick: closeModal },
      {
        text: '开始导入', cls: 'btn-primary', onClick: function () {
          var text = document.getElementById('imp-text').value.trim();
          var result = document.getElementById('imp-result');
          if (!text) { result.innerHTML = '<span class="bad">请先选择文件或粘贴 CSV 内容</span>'; return; }
          var rows = parseCsv(text);
          if (rows.length < 2) { result.innerHTML = '<span class="bad">未解析到数据行(首行须为表头)</span>'; return; }
          var head = rows[0].map(function (h) { return h.trim(); });
          var idx = columns.map(function (c) { return head.indexOf(c.label); });
          var missing = columns.filter(function (c, i) { return idx[i] < 0; });
          if (missing.length) { result.innerHTML = '<span class="bad">表头缺少列:' + esc(missing.map(function (m) { return m.label; }).join('、')) + '</span>'; return; }
          var dataRows = rows.slice(1).map(function (r) {
            var o = {};
            columns.forEach(function (c, i) { o[c.key] = (r[idx[i]] || '').trim(); });
            return o;
          });
          result.innerHTML = '导入中…';
          submitRows(dataRows).then(function (j) {
            if (!j.ok) { result.innerHTML = '<span class="bad">' + esc(j.error || '导入失败') + '</span>'; return; }
            var html = '<span class="ok">成功导入 ' + j.inserted + ' 条</span>';
            if (j.skipped) html += ',<span class="bad">跳过 ' + j.skipped + ' 条</span>';
            if (j.errors && j.errors.length) {
              html += '<div class="import-err-list">' + j.errors.map(function (e) { return '<div>' + esc(e) + '</div>'; }).join('') + '</div>';
            }
            result.innerHTML = html;
            if (j.inserted > 0) reloadCurrentView();
          }).catch(function () { result.innerHTML = '<span class="bad">网络异常,导入失败</span>'; });
        }
      }
    ]);
    document.getElementById('imp-tpl').addEventListener('click', function () {
      var csv = '﻿' + header + '\r\n' + templateRow + '\r\n';
      var a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      a.download = title + '_导入模板.csv';
      a.click();
      URL.revokeObjectURL(a.href);
    });
    document.getElementById('imp-file').addEventListener('change', function (e) {
      var f = e.target.files[0];
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () { document.getElementById('imp-text').value = reader.result; };
      reader.readAsText(f, 'utf-8');
    });
  }

  /* ==================== 视图切换 ==================== */
  var VIEW_TITLES = { users: '用户管理', assets: '数据资产管理', districts: '商圈管理', stores: '门店管理' };
  function switchView(v) {
    state.view = v;
    document.querySelectorAll('.side-nav-item').forEach(function (el) {
      el.classList.toggle('active', el.getAttribute('data-view') === v);
    });
    document.querySelectorAll('.view').forEach(function (el) {
      el.classList.toggle('active', el.id === 'view-' + v);
    });
    document.getElementById('topbar-title').textContent = VIEW_TITLES[v];
    loadView(v);
  }
  function loadView(v) {
    if (v === 'users') loadUsers();
    else if (v === 'assets') loadAssets();
    else if (v === 'districts') loadDistricts();
    else if (v === 'stores') loadStores();
  }
  function reloadCurrentView() { loadView(state.view); }

  document.querySelectorAll('.side-nav-item').forEach(function (el) {
    el.addEventListener('click', function () { switchView(el.getAttribute('data-view')); });
  });

  /* ==================== 模块1:用户管理 ==================== */
  function roleTag(r) { return '<span class="tag tag-' + r + '">' + (ROLE_NAMES[r] || r) + '</span>'; }
  function statusTag(s) { return s === 'disabled' ? '<span class="tag tag-off">禁用</span>' : '<span class="tag tag-on">启用</span>'; }

  function loadUsers() {
    var s = state.users;
    var qs = 'page=' + s.page + '&size=' + s.size +
      '&q=' + encodeURIComponent(document.getElementById('users-q').value.trim()) +
      '&role=' + document.getElementById('users-role').value +
      '&status=' + document.getElementById('users-status').value;
    api('/api/admin/users?' + qs).then(function (j) {
      var box = document.getElementById('users-table');
      if (!j.list.length) { box.innerHTML = emptyHtml('尚未建立后台账号'); }
      else {
        var html = '<table class="data-table"><thead><tr>' +
          '<th>账号</th><th>用户姓名</th><th>所属角色</th><th>手机号码</th><th>账号状态</th><th>创建时间</th><th>最后登录</th><th>操作</th>' +
          '</tr></thead><tbody>';
        j.list.forEach(function (u) {
          var self = u.username === state.me.username;
          html += '<tr><td class="cell-main">' + esc(u.username) + (self ? ' <span class="tag-mini">当前账号</span>' : '') + '</td>' +
            '<td>' + esc(u.name) + '</td><td>' + roleTag(u.role) + '</td><td>' + esc(u.phone || '-') + '</td>' +
            '<td>' + statusTag(u.status) + '</td><td>' + fmtTime(u.createdAt) + '</td><td>' + fmtTime(u.lastLoginAt) + '</td>' +
            '<td class="row-actions">' +
            '<button class="btn btn-sm" data-act="edit" data-u="' + esc(u.username) + '">编辑</button>' +
            '<button class="btn btn-sm" data-act="pwd" data-u="' + esc(u.username) + '">重置密码</button>' +
            (self ? '' : '<button class="btn btn-sm ' + (u.status === 'disabled' ? '' : 'btn-danger') + '" data-act="status" data-u="' + esc(u.username) + '" data-s="' + u.status + '">' + (u.status === 'disabled' ? '启用' : '冻结') + '</button>') +
            '</td></tr>';
        });
        box.innerHTML = html + '</tbody></table>';
        box.querySelectorAll('button[data-act]').forEach(function (b) {
          b.addEventListener('click', function () { userAction(b.getAttribute('data-act'), b.getAttribute('data-u'), b.getAttribute('data-s')); });
        });
      }
      renderPager(document.getElementById('users-pager'), j, function (p) { state.users.page = p; loadUsers(); });
    }).catch(function () {});
  }

  function userAction(act, username, curStatus) {
    if (act === 'status') {
      var to = curStatus === 'disabled' ? 'enabled' : 'disabled';
      confirmModal(to === 'disabled' ? '冻结账号' : '启用账号',
        '确定' + (to === 'disabled' ? '冻结' : '启用') + '账号「' + esc(username) + '」?' + (to === 'disabled' ? '冻结后该账号将被强制下线。' : ''),
        function () {
          api('/api/admin/users/' + encodeURIComponent(username) + '/status', { json: { status: to } })
            .then(function (j) { if (j.ok) { toast('已' + (to === 'disabled' ? '冻结' : '启用')); loadUsers(); } else toast(j.error, true); })
            .catch(function () {});
        });
    } else if (act === 'pwd') {
      openModal('重置密码 · ' + username,
        '<div class="form-grid"><div class="field span2"><label>新密码<span class="req">*</span></label>' +
        '<input type="password" id="mu-pwd" maxlength="20" placeholder="6-20 位"><div class="hint">重置后该账号所有登录态失效,需重新登录</div></div></div>',
        [{ text: '取消', onClick: closeModal }, {
          text: '确认重置', cls: 'btn-primary', onClick: function () {
            var pwd = document.getElementById('mu-pwd').value;
            if (pwd.length < 6 || pwd.length > 20) { toast('密码长度需为 6-20 位', true); return; }
            api('/api/admin/users/' + encodeURIComponent(username) + '/password', { json: { password: pwd } })
              .then(function (j) { if (j.ok) { closeModal(); toast('密码已重置'); } else toast(j.error, true); })
              .catch(function () {});
          }
        }]);
    } else if (act === 'edit') {
      api('/api/admin/users?q=' + encodeURIComponent(username)).then(function (j) {
        var u = j.list.filter(function (x) { return x.username === username; })[0];
        if (!u) return;
        openUserForm('编辑用户 · ' + username, u, function (v) {
          return api('/api/admin/users/' + encodeURIComponent(username), { method: 'PUT', json: v });
        });
      }).catch(function () {});
    }
  }

  function openUserForm(title, u, submit) {
    var isNew = !u.username;
    var body = '<div class="form-grid">' +
      (isNew ? '<div class="field"><label>账号<span class="req">*</span></label><input id="mu-username" maxlength="20" placeholder="4-20 位字母、数字或下划线"></div>' +
        '<div class="field"><label>密码<span class="req">*</span></label><input id="mu-password" type="password" maxlength="20" placeholder="6-20 位"></div>' : '') +
      '<div class="field"><label>用户姓名<span class="req">*</span></label><input id="mu-name" maxlength="20" value="' + esc(u.name || '') + '"></div>' +
      '<div class="field"><label>所属角色<span class="req">*</span></label><select id="mu-role">' +
      ['admin', 'operator', 'viewer'].map(function (r) { return '<option value="' + r + '"' + (u.role === r ? ' selected' : '') + '>' + ROLE_NAMES[r] + '</option>'; }).join('') +
      '</select></div>' +
      '<div class="field"><label>手机号码</label><input id="mu-phone" maxlength="11" value="' + esc(u.phone || '') + '" placeholder="选填"></div>' +
      '</div>';
    openModal(title, body, [{ text: '取消', onClick: closeModal }, {
      text: isNew ? '创建用户' : '保存', cls: 'btn-primary', onClick: function () {
        var v = {
          name: document.getElementById('mu-name').value.trim(),
          role: document.getElementById('mu-role').value,
          phone: document.getElementById('mu-phone').value.trim()
        };
        if (isNew) {
          v.username = document.getElementById('mu-username').value.trim();
          v.password = document.getElementById('mu-password').value;
        }
        submit(v).then(function (j) {
          if (j.ok) { closeModal(); toast(isNew ? '用户已创建' : '已保存'); loadUsers(); }
          else toast(j.error || '操作失败', true);
        }).catch(function () {});
      }
    }]);
  }

  document.getElementById('users-search').addEventListener('click', function () { state.users.page = 1; loadUsers(); });
  document.getElementById('users-role').addEventListener('change', function () { state.users.page = 1; loadUsers(); });
  document.getElementById('users-status').addEventListener('change', function () { state.users.page = 1; loadUsers(); });
  document.getElementById('users-q').addEventListener('keydown', function (e) { if (e.key === 'Enter') { state.users.page = 1; loadUsers(); } });
  document.getElementById('users-add').addEventListener('click', function () {
    openUserForm('新增用户', {}, function (v) { return api('/api/admin/users', { json: v }); });
  });

  /* ==================== 模块2:数据资产管理 ==================== */
  function boardOptions(selected) {
    return state.boards.map(function (b) {
      return '<option value="' + esc(b.id) + '"' + (b.id === selected ? ' selected' : '') + '>' + esc(b.name) + '</option>';
    }).join('');
  }

  function refreshBoards() {
    return api('/api/admin/assets/boards').then(function (j) {
      state.boards = j.boards || [];
      var sel = document.getElementById('assets-board');
      var cur = sel.value;
      sel.innerHTML = '<option value="">全部板块</option>' + boardOptions(cur);
    }).catch(function () {});
  }

  function loadAssets() {
    var s = state.assets;
    var qs = 'page=' + s.page + '&size=' + s.size +
      '&q=' + encodeURIComponent(document.getElementById('assets-q').value.trim()) +
      '&board=' + document.getElementById('assets-board').value +
      '&status=' + document.getElementById('assets-status').value;
    api('/api/admin/assets?' + qs).then(function (j) {
      var box = document.getElementById('assets-table');
      if (!j.list.length) { box.innerHTML = emptyHtml('暂无数据资产,可点击「新增资产」建档'); }
      else {
        var html = '<table class="data-table"><thead><tr>' +
          '<th>编号</th><th>资产名称</th><th>归属板块</th><th>数据来源</th><th>更新频率</th><th>存储量级</th><th>负责人</th><th>状态</th>' + (canEdit() ? '<th>操作</th>' : '') +
          '</tr></thead><tbody>';
        j.list.forEach(function (a) {
          html += '<tr><td>' + esc(a.id) + '</td>' +
            '<td><div class="cell-main">' + esc(a.name) + '</div>' + (a.intro ? '<div class="cell-sub cell-ellipsis" title="' + esc(a.intro) + '">' + esc(a.intro) + '</div>' : '') + (a.attachment ? '<div class="cell-sub">附件:' + esc(a.attachment) + '</div>' : '') + '</td>' +
            '<td>' + esc(a.boardName) + '</td><td class="cell-ellipsis" title="' + esc(a.source) + '">' + esc(a.source) + '</td>' +
            '<td>' + esc(a.updateCycle || '-') + '</td><td>' + esc(a.scale || '-') + '</td><td>' + esc(a.owner || '-') + '</td>' +
            '<td>' + (a.status === 'archived' ? '<span class="tag tag-arch">已归档</span>' : '<span class="tag tag-on">在册</span>') + '</td>' +
            (canEdit() ? '<td class="row-actions">' +
              '<button class="btn btn-sm" data-act="edit" data-id="' + a.id + '">编辑</button>' +
              '<button class="btn btn-sm ' + (a.status === 'archived' ? '' : 'btn-danger') + '" data-act="arch" data-id="' + a.id + '" data-s="' + a.status + '">' + (a.status === 'archived' ? '恢复' : '归档') + '</button></td>' : '') +
            '</tr>';
        });
        box.innerHTML = html + '</tbody></table>';
        box.querySelectorAll('button[data-act]').forEach(function (b) {
          b.addEventListener('click', function () {
            var id = b.getAttribute('data-id');
            if (b.getAttribute('data-act') === 'arch') {
              var to = b.getAttribute('data-s') === 'archived' ? 'active' : 'archived';
              api('/api/admin/assets/' + id + '/archive', { json: { status: to } })
                .then(function (r) { if (r.ok) { toast(to === 'archived' ? '已归档' : '已恢复'); loadAssets(); } else toast(r.error, true); })
                .catch(function () {});
            } else {
              var item = j.list.filter(function (x) { return x.id === id; })[0];
              openAssetForm('编辑资产 · ' + id, item);
            }
          });
        });
      }
      renderPager(document.getElementById('assets-pager'), j, function (p) { state.assets.page = p; loadAssets(); });
    }).catch(function () {});
  }

  function openAssetForm(title, a) {
    var isNew = !a;
    a = a || {};
    var body = '<div class="form-grid">' +
      '<div class="field span2"><label>资产名称<span class="req">*</span></label><input id="ma-name" maxlength="60" value="' + esc(a.name || '') + '"></div>' +
      '<div class="field"><label>归属板块<span class="req">*</span></label><select id="ma-board">' + boardOptions(a.boardId) + '</select></div>' +
      '<div class="field"><label>更新频率</label><input id="ma-cycle" maxlength="30" value="' + esc(a.updateCycle || '') + '" placeholder="如:月度 / 季度 / 年度"></div>' +
      '<div class="field span2"><label>数据来源</label><input id="ma-source" maxlength="120" value="' + esc(a.source || '') + '" placeholder="须真实可溯源"></div>' +
      '<div class="field"><label>存储量级</label><input id="ma-scale" maxlength="60" value="' + esc(a.scale || '') + '" placeholder="如:206 条 × 31 字段"></div>' +
      '<div class="field"><label>负责人</label><input id="ma-owner" maxlength="30" value="' + esc(a.owner || '') + '"></div>' +
      '<div class="field span2"><label>附件(数据字典 / 说明文档)</label><input id="ma-attach" maxlength="120" value="' + esc(a.attachment || '') + '" placeholder="文件名或路径说明"></div>' +
      '<div class="field span2"><label>资产简介</label><textarea id="ma-intro" maxlength="500">' + esc(a.intro || '') + '</textarea></div>' +
      '</div>';
    openModal(title, body, [{ text: '取消', onClick: closeModal }, {
      text: isNew ? '创建资产' : '保存', cls: 'btn-primary', onClick: function () {
        var v = {
          name: document.getElementById('ma-name').value.trim(),
          boardId: document.getElementById('ma-board').value,
          updateCycle: document.getElementById('ma-cycle').value.trim(),
          source: document.getElementById('ma-source').value.trim(),
          scale: document.getElementById('ma-scale').value.trim(),
          owner: document.getElementById('ma-owner').value.trim(),
          attachment: document.getElementById('ma-attach').value.trim(),
          intro: document.getElementById('ma-intro').value.trim()
        };
        var req = isNew ? api('/api/admin/assets', { json: v }) : api('/api/admin/assets/' + a.id, { method: 'PUT', json: v });
        req.then(function (r) {
          if (r.ok) { closeModal(); toast(isNew ? '资产已建档' : '已保存'); loadAssets(); }
          else toast(r.error || '操作失败', true);
        }).catch(function () {});
      }
    }]);
  }

  document.getElementById('assets-search').addEventListener('click', function () { state.assets.page = 1; loadAssets(); });
  document.getElementById('assets-q').addEventListener('keydown', function (e) { if (e.key === 'Enter') { state.assets.page = 1; loadAssets(); } });
  document.getElementById('assets-board').addEventListener('change', function () { state.assets.page = 1; loadAssets(); });
  document.getElementById('assets-status').addEventListener('change', function () { state.assets.page = 1; loadAssets(); });
  document.getElementById('assets-add').addEventListener('click', function () { openAssetForm('新增资产', null); });
  document.getElementById('assets-export').addEventListener('click', function () { downloadCsv('/api/admin/assets/export', '数据资产台账.csv'); });
  document.getElementById('assets-boards').addEventListener('click', function () {
    api('/api/admin/assets/boards').then(function (j) {
      var body = '<div class="cell-sub" style="margin-bottom:12px">五大一级板块名称可按业务口径调整,资产归属关系不受影响。</div>';
      j.boards.forEach(function (b) {
        body += '<div class="board-row"><span class="board-id">' + esc(b.id) + '</span>' +
          '<input type="text" id="board-' + esc(b.id) + '" maxlength="30" value="' + esc(b.name) + '"' + (canEdit() ? '' : ' disabled') + '>' +
          '<span class="cell-sub">' + b.assetCount + ' 项资产</span></div>';
      });
      var foots = [{ text: '关闭', onClick: closeModal }];
      if (canEdit()) foots.push({
        text: '保存板块名称', cls: 'btn-primary', onClick: function () {
          var reqs = j.boards.map(function (b) {
            var name = document.getElementById('board-' + b.id).value.trim();
            return name && name !== b.name ? api('/api/admin/assets/boards/' + b.id, { method: 'PUT', json: { name: name } }) : null;
          }).filter(Boolean);
          Promise.all(reqs).then(function (rs) {
            var bad = rs.filter(function (r) { return !r.ok; })[0];
            if (bad) { toast(bad.error || '部分板块保存失败', true); return; }
            closeModal(); toast('板块已更新'); refreshBoards(); loadAssets();
          }).catch(function () {});
        }
      });
      openModal('板块设置(五大板块)', body, foots);
    }).catch(function () {});
  });

  /* ==================== 模块3:商圈管理 ==================== */
  function loadDistricts() {
    var s = state.districtsQ;
    var qs = 'page=' + s.page + '&size=' + s.size +
      '&q=' + encodeURIComponent(document.getElementById('districts-q').value.trim());
    api('/api/admin/districts?' + qs).then(function (j) {
      var box = document.getElementById('districts-table');
      if (!j.list.length) { box.innerHTML = emptyHtml('暂无商圈档案'); }
      else {
        var html = '<table class="data-table"><thead><tr>' +
          '<th>编号</th><th>商圈名称</th><th>所在城市</th><th>行政区</th><th>经纬度</th><th>规模</th><th>标签</th><th>开业年限</th><th>门店数</th>' + (canEdit() ? '<th>操作</th>' : '') +
          '</tr></thead><tbody>';
        j.list.forEach(function (d) {
          html += '<tr><td>' + esc(d.code) + '</td>' +
            '<td><div class="cell-main">' + esc(d.name) + '</div>' + (d.remark ? '<div class="cell-sub cell-ellipsis" title="' + esc(d.remark) + '">' + esc(d.remark) + '</div>' : '') + '</td>' +
            '<td>' + esc(d.city || '-') + '</td><td>' + esc(d.region || '-') + '</td>' +
            '<td>' + (d.lng && d.lat ? esc(d.lng) + ',' + esc(d.lat) : '-') + '</td>' +
            '<td>' + esc(d.scale || '-') + '</td>' +
            '<td>' + (d.tags || []).map(function (t) { return '<span class="tag-mini">' + esc(t) + '</span>'; }).join('') + '</td>' +
            '<td>' + esc(d.years || '-') + '</td><td>' + (d.storeCount || 0) + '</td>' +
            (canEdit() ? '<td class="row-actions">' +
              '<button class="btn btn-sm" data-act="edit" data-id="' + d.code + '">编辑</button>' +
              '<button class="btn btn-sm btn-danger" data-act="del" data-id="' + d.code + '" data-n="' + esc(d.name) + '">删除</button></td>' : '') +
            '</tr>';
        });
        box.innerHTML = html + '</tbody></table>';
        box.querySelectorAll('button[data-act]').forEach(function (b) {
          b.addEventListener('click', function () {
            var id = b.getAttribute('data-id');
            if (b.getAttribute('data-act') === 'del') {
              confirmModal('删除商圈', '确定删除商圈「' + esc(b.getAttribute('data-n')) + '」?删除后不可恢复(商圈下有门店时将被拒绝)。', function () {
                api('/api/admin/districts/' + id, { method: 'DELETE' })
                  .then(function (r) { if (r.ok) { toast('已删除'); loadDistricts(); refreshDistrictOptions(); } else toast(r.error, true); })
                  .catch(function () {});
              });
            } else {
              openDistrictForm('编辑商圈 · ' + id, j.list.filter(function (x) { return x.code === id; })[0]);
            }
          });
        });
      }
      renderPager(document.getElementById('districts-pager'), j, function (p) { state.districtsQ.page = p; loadDistricts(); });
    }).catch(function () {});
  }

  function openDistrictForm(title, d) {
    var isNew = !d;
    d = d || {};
    var body = '<div class="form-grid">' +
      '<div class="field"><label>商圈名称<span class="req">*</span></label><input id="md-name" maxlength="30" value="' + esc(d.name || '') + '"></div>' +
      '<div class="field"><label>所在城市</label><input id="md-city" maxlength="20" value="' + esc(d.city || '西安市') + '"></div>' +
      '<div class="field"><label>行政区</label><input id="md-region" maxlength="20" value="' + esc(d.region || '') + '"></div>' +
      '<div class="field"><label>商圈规模</label><input id="md-scale" maxlength="30" value="' + esc(d.scale || '') + '" placeholder="如:中型社区型"></div>' +
      '<div class="field"><label>经度</label><input id="md-lng" maxlength="30" value="' + esc(d.lng || '') + '" placeholder="选填,数字"></div>' +
      '<div class="field"><label>纬度</label><input id="md-lat" maxlength="30" value="' + esc(d.lat || '') + '" placeholder="选填,数字"></div>' +
      '<div class="field"><label>商圈标签</label><input id="md-tags" maxlength="80" value="' + esc((d.tags || []).join(',')) + '"><div class="hint">多个标签用英文逗号分隔</div></div>' +
      '<div class="field"><label>开业年限</label><input id="md-years" maxlength="20" value="' + esc(d.years || '') + '" placeholder="如:3 年"></div>' +
      '<div class="field span2"><label>备注</label><textarea id="md-remark" maxlength="300">' + esc(d.remark || '') + '</textarea></div>' +
      '</div>';
    openModal(title, body, [{ text: '取消', onClick: closeModal }, {
      text: isNew ? '创建商圈' : '保存', cls: 'btn-primary', onClick: function () {
        var v = {
          name: document.getElementById('md-name').value.trim(),
          city: document.getElementById('md-city').value.trim(),
          region: document.getElementById('md-region').value.trim(),
          scale: document.getElementById('md-scale').value.trim(),
          lng: document.getElementById('md-lng').value.trim(),
          lat: document.getElementById('md-lat').value.trim(),
          tags: document.getElementById('md-tags').value,
          years: document.getElementById('md-years').value.trim(),
          remark: document.getElementById('md-remark').value.trim()
        };
        var req = isNew ? api('/api/admin/districts', { json: v }) : api('/api/admin/districts/' + d.code, { method: 'PUT', json: v });
        req.then(function (r) {
          if (r.ok) { closeModal(); toast(isNew ? '商圈已建档' : '已保存'); loadDistricts(); refreshDistrictOptions(); }
          else toast(r.error || '操作失败', true);
        }).catch(function () {});
      }
    }]);
  }

  document.getElementById('districts-search').addEventListener('click', function () { state.districtsQ.page = 1; loadDistricts(); });
  document.getElementById('districts-q').addEventListener('keydown', function (e) { if (e.key === 'Enter') { state.districtsQ.page = 1; loadDistricts(); } });
  document.getElementById('districts-add').addEventListener('click', function () { openDistrictForm('新增商圈', null); });
  document.getElementById('districts-export').addEventListener('click', function () { downloadCsv('/api/admin/districts/export', '商圈信息.csv'); });
  document.getElementById('districts-import').addEventListener('click', function () {
    openImportModal('商圈批量导入',
      [{ key: 'name', label: '商圈名称' }, { key: 'city', label: '所在城市' }, { key: 'region', label: '行政区' },
       { key: 'lng', label: '经度' }, { key: 'lat', label: '纬度' }, { key: 'scale', label: '商圈规模' },
       { key: 'tags', label: '商圈标签' }, { key: 'years', label: '开业年限' }, { key: 'remark', label: '备注' }],
      '小寨,西安市,雁塔区,108.941,34.221,大型商圈,购物中心;高校客群,20年以上,示例行可删除',
      function (rows) { return api('/api/admin/districts/import', { json: { rows: rows } }); });
  });

  /* ==================== 模块4:门店管理 ==================== */
  function refreshDistrictOptions() {
    return api('/api/admin/districts?size=100').then(function (j) {
      state.districts = j.list || [];
      var sel = document.getElementById('stores-district');
      var cur = sel.value;
      sel.innerHTML = '<option value="">全部商圈</option>' + state.districts.map(function (d) {
        return '<option value="' + esc(d.name) + '"' + (d.name === cur ? ' selected' : '') + '>' + esc(d.name) + '</option>';
      }).join('');
    }).catch(function () {});
  }

  function storeStatusTag(s) {
    if (s === '已停业') return '<span class="tag tag-off">已停业</span>';
    if (s === '筹备中') return '<span class="tag tag-prep">筹备中</span>';
    return '<span class="tag tag-on">营业中</span>';
  }

  function loadStores() {
    var s = state.stores;
    var qs = 'page=' + s.page + '&size=' + s.size +
      '&q=' + encodeURIComponent(document.getElementById('stores-q').value.trim()) +
      '&district=' + encodeURIComponent(document.getElementById('stores-district').value) +
      '&status=' + encodeURIComponent(document.getElementById('stores-status').value);
    api('/api/admin/stores?' + qs).then(function (j) {
      var box = document.getElementById('stores-table');
      if (!j.list.length) { box.innerHTML = emptyHtml('暂无门店档案'); }
      else {
        var html = '<table class="data-table"><thead><tr>' +
          '<th>编号</th><th>门店名称</th><th>所属商圈</th><th>业态类型</th><th>面积(㎡)</th><th>营业状态</th><th>入驻时间</th><th>详细地址</th>' + (canEdit() ? '<th>操作</th>' : '') +
          '</tr></thead><tbody>';
        j.list.forEach(function (st) {
          html += '<tr><td>' + esc(st.code) + '</td>' +
            '<td><div class="cell-main">' + esc(st.name) + '</div>' + (st.remark ? '<div class="cell-sub cell-ellipsis" title="' + esc(st.remark) + '">' + esc(st.remark) + '</div>' : '') + '</td>' +
            '<td>' + esc(st.district) + '</td><td>' + esc(st.industry || '-') + '</td><td>' + esc(st.area || '-') + '</td>' +
            '<td>' + storeStatusTag(st.status) + '</td><td>' + esc(st.openedAt || '-') + '</td>' +
            '<td>' + (st.address ? esc(st.address) : '<span class="cell-sub">待补录</span>') + '</td>' +
            (canEdit() ? '<td class="row-actions">' +
              '<button class="btn btn-sm" data-act="edit" data-id="' + st.code + '">编辑</button>' +
              '<button class="btn btn-sm btn-danger" data-act="del" data-id="' + st.code + '" data-n="' + esc(st.name) + '">删除</button></td>' : '') +
            '</tr>';
        });
        box.innerHTML = html + '</tbody></table>';
        box.querySelectorAll('button[data-act]').forEach(function (b) {
          b.addEventListener('click', function () {
            var id = b.getAttribute('data-id');
            if (b.getAttribute('data-act') === 'del') {
              confirmModal('删除门店', '确定删除门店「' + esc(b.getAttribute('data-n')) + '」?删除后不可恢复。', function () {
                api('/api/admin/stores/' + id, { method: 'DELETE' })
                  .then(function (r) { if (r.ok) { toast('已删除'); loadStores(); } else toast(r.error, true); })
                  .catch(function () {});
              });
            } else {
              openStoreForm('编辑门店 · ' + id, j.list.filter(function (x) { return x.code === id; })[0]);
            }
          });
        });
      }
      renderPager(document.getElementById('stores-pager'), j, function (p) { state.stores.page = p; loadStores(); });
    }).catch(function () {});
  }

  function openStoreForm(title, st) {
    var isNew = !st;
    st = st || {};
    var districtOpts = state.districts.map(function (d) {
      return '<option value="' + esc(d.name) + '"' + (d.name === st.district ? ' selected' : '') + '>' + esc(d.name) + '</option>';
    }).join('');
    var statusOpts = ['营业中', '筹备中', '已停业'].map(function (s) {
      return '<option value="' + s + '"' + (s === (st.status || '营业中') ? ' selected' : '') + '>' + s + '</option>';
    }).join('');
    var body = '<div class="form-grid">' +
      '<div class="field"><label>门店名称<span class="req">*</span></label><input id="ms-name" maxlength="40" value="' + esc(st.name || '') + '"></div>' +
      '<div class="field"><label>所属商圈<span class="req">*</span></label><select id="ms-district">' + districtOpts + '</select></div>' +
      '<div class="field"><label>业态类型</label><input id="ms-industry" maxlength="30" value="' + esc(st.industry || '') + '" placeholder="如:餐饮 / 咖啡 / 文创"></div>' +
      '<div class="field"><label>营业面积(㎡)</label><input id="ms-area" maxlength="20" value="' + esc(st.area || '') + '" placeholder="数字"></div>' +
      '<div class="field"><label>营业状态</label><select id="ms-status">' + statusOpts + '</select></div>' +
      '<div class="field"><label>入驻时间</label><input id="ms-opened" maxlength="10" value="' + esc(st.openedAt || '') + '" placeholder="YYYY-MM-DD"></div>' +
      '<div class="field span2"><label>详细地址</label><input id="ms-address" maxlength="120" value="' + esc(st.address || '') + '" placeholder="选填"></div>' +
      '<div class="field"><label>经度</label><input id="ms-lng" maxlength="30" value="' + esc(st.lng || '') + '" placeholder="选填,数字"></div>' +
      '<div class="field"><label>纬度</label><input id="ms-lat" maxlength="30" value="' + esc(st.lat || '') + '" placeholder="选填,数字"></div>' +
      '<div class="field span2"><label>备注</label><textarea id="ms-remark" maxlength="300">' + esc(st.remark || '') + '</textarea></div>' +
      '</div>';
    openModal(title, body, [{ text: '取消', onClick: closeModal }, {
      text: isNew ? '创建门店' : '保存', cls: 'btn-primary', onClick: function () {
        var v = {
          name: document.getElementById('ms-name').value.trim(),
          district: document.getElementById('ms-district').value,
          industry: document.getElementById('ms-industry').value.trim(),
          area: document.getElementById('ms-area').value.trim(),
          status: document.getElementById('ms-status').value,
          openedAt: document.getElementById('ms-opened').value.trim(),
          address: document.getElementById('ms-address').value.trim(),
          lng: document.getElementById('ms-lng').value.trim(),
          lat: document.getElementById('ms-lat').value.trim(),
          remark: document.getElementById('ms-remark').value.trim()
        };
        var req = isNew ? api('/api/admin/stores', { json: v }) : api('/api/admin/stores/' + st.code, { method: 'PUT', json: v });
        req.then(function (r) {
          if (r.ok) { closeModal(); toast(isNew ? '门店已建档' : '已保存'); loadStores(); }
          else toast(r.error || '操作失败', true);
        }).catch(function () {});
      }
    }]);
  }

  document.getElementById('stores-search').addEventListener('click', function () { state.stores.page = 1; loadStores(); });
  document.getElementById('stores-q').addEventListener('keydown', function (e) { if (e.key === 'Enter') { state.stores.page = 1; loadStores(); } });
  document.getElementById('stores-district').addEventListener('change', function () { state.stores.page = 1; loadStores(); });
  document.getElementById('stores-status').addEventListener('change', function () { state.stores.page = 1; loadStores(); });
  document.getElementById('stores-add').addEventListener('click', function () { openStoreForm('新增门店', null); });
  document.getElementById('stores-export').addEventListener('click', function () {
    var d = document.getElementById('stores-district').value;
    downloadCsv('/api/admin/stores/export' + (d ? '?district=' + encodeURIComponent(d) : ''), '门店信息.csv');
  });
  document.getElementById('stores-import').addEventListener('click', function () {
    openImportModal('门店批量导入',
      [{ key: 'name', label: '门店名称' }, { key: 'district', label: '所属商圈' }, { key: 'address', label: '详细地址' },
       { key: 'lng', label: '经度' }, { key: 'lat', label: '纬度' }, { key: 'status', label: '营业状态' },
       { key: 'area', label: '营业面积(㎡)' }, { key: 'industry', label: '业态类型' }, { key: 'openedAt', label: '入驻时间' },
       { key: 'remark', label: '备注' }],
      '示例咖啡(删除本行),粉象Park,西安市碑林区南大街 XX 号,108.945,34.255,营业中,80,咖啡,2026-09-01,示例行',
      function (rows) { return api('/api/admin/stores/import', { json: { rows: rows } }); });
  });

  /* ==================== 使用说明(首登自动弹出,顶栏可重开) ==================== */
  var GUIDE_KEY = 'sip_admin_guide_v1';
  function showGuide() {
    var body = '<div class="guide-body">' +
      '<p class="guide-lead">本后台与「智慧门店运营洞察平台」前台是同一套系统:前台面向商户展示经营诊断,这里负责维护支撑它的账号、数据资产台账、商圈与门店档案。</p>' +
      '<h4>四个模块管什么</h4><ul>' +
      '<li><b>用户管理</b>(仅管理员):维护后台操作人员账号——新增、编辑、冻结/启用、重置密码。前台注册用户不在此列,也无权登录后台。</li>' +
      '<li><b>数据资产管理</b>:五大板块的数据台账,支持新增、编辑、归档、检索与导出台账;板块名称可在「板块设置」中修改。</li>' +
      '<li><b>商圈管理</b>:商圈基础档案(坐标/规模/标签),支持批量导入(CSV)与导出;仍有门店挂靠的商圈不可删除。</li>' +
      '<li><b>门店管理</b>:门店档案,须挂靠在已存在的商圈下,支持按商圈筛选、批量导入导出。</li></ul>' +
      '<h4>三种角色的权限</h4>' +
      '<table class="data-table guide-table"><thead><tr><th>角色</th><th>用户管理</th><th>资产/商圈/门店</th><th>查看与导出</th></tr></thead><tbody>' +
      '<tr><td><span class="tag tag-admin">管理员</span></td><td>√ 全部</td><td>√ 增改/导入/归档</td><td>√</td></tr>' +
      '<tr><td><span class="tag tag-operator">运营人员</span></td><td>—</td><td>√ 增改/导入/归档</td><td>√</td></tr>' +
      '<tr><td><span class="tag tag-viewer">只读人员</span></td><td>—</td><td>—(编辑入口已隐藏)</td><td>√</td></tr>' +
      '</tbody></table>' +
      '<h4>预置演示账号</h4>' +
      '<table class="data-table guide-table"><thead><tr><th>账号</th><th>密码</th><th>角色</th></tr></thead><tbody>' +
      '<tr><td>admin</td><td>admin123456</td><td>管理员</td></tr>' +
      '<tr><td>operator01</td><td>op123456</td><td>运营人员</td></tr>' +
      '<tr><td>viewer01</td><td>view123456</td><td>只读人员</td></tr>' +
      '</tbody></table>' +
      '<p class="guide-note">演示环境默认账号,正式使用前请在「用户管理」中重置密码。后台账号只能由管理员在此创建,登录页不提供注册——防止拿到链接的人自行开通后台权限。</p>' +
      '<h4>常用操作</h4><ul>' +
      '<li>筛选:下拉切换即时生效,关键词输入后回车或点「查询」。</li>' +
      '<li>导出:下载 CSV(带 BOM,Excel 可直接打开)。</li>' +
      '<li>批量导入:弹窗内可下载模板,支持上传 CSV 文件或直接粘贴文本。</li>' +
      '<li>同一账号可同时在线前台与后台;同一端内新登录会踢掉旧会话。</li></ul>' +
      '</div>';
    openModal('使用说明', body, [{ text: '我知道了', cls: 'btn-primary', onClick: closeModal }]);
    mask.querySelector('.modal').classList.add('modal-guide');
  }
  document.getElementById('btn-guide').addEventListener('click', showGuide);

  /* ==================== 启动 ==================== */
  document.getElementById('btn-logout').addEventListener('click', function () {
    fetch('/api/auth/logout', { method: 'POST', headers: { 'Authorization': 'Bearer ' + state.token } })
      .finally(function () { logout(); });
  });

  if (!state.token) { logout(); return; }
  api('/api/admin/me').then(function (j) {
    state.me = j;
    document.getElementById('user-name').textContent = (j.name || j.username) + '(' + j.username + ')';
    document.getElementById('user-avatar').textContent = (j.name || j.username).slice(0, 1).toUpperCase();
    var roleEl = document.getElementById('user-role');
    roleEl.textContent = ROLE_NAMES[j.role] || j.role;
    roleEl.className = 'tag tag-' + j.role;
    // 按角色裁剪界面:用户管理仅 admin;只读人员隐藏全部编辑入口
    document.querySelectorAll('.side-nav-item').forEach(function (el) {
      if (el.getAttribute('data-min-role') === 'admin' && !isAdmin()) el.style.display = 'none';
    });
    ['users-add', 'assets-add', 'assets-boards', 'districts-add', 'districts-import', 'stores-add', 'stores-import'].forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      if (id === 'users-add' && !isAdmin()) { el.style.display = 'none'; return; }
      if (id !== 'users-add' && !canEdit()) el.style.display = 'none';
    });
    refreshBoards().then(function () { return refreshDistrictOptions(); }).then(function () {
      switchView(isAdmin() ? 'users' : 'assets');
      if (!localStorage.getItem(GUIDE_KEY)) {
        localStorage.setItem(GUIDE_KEY, '1');
        showGuide();
      }
    });
  }).catch(function () {});
})();
