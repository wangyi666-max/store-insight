/**
 * ============================================================
 * api.js — 数据层（前端唯一数据入口）
 * 数据源：
 *   GET  /api/meta     商圈/门店清单（服务端 seed.json，源自知识库真实数据）
 *   POST /api/diagnose 调用扣子 business_diagnosis 工作流（经服务端代理，PAT 不下发）
 *        { shop_name, district, demo } → { ok, source, elapsedMs, result }
 *        source = 'coze-live' 实时调用 | 'demo-cache' 演示缓存（界面琥珀色明示）
 * 诊断结果缓存在 sessionStorage，刷新页面不丢；所有视图从同一份契约 JSON 渲染。
 * ============================================================
 */

(function (global) {
  'use strict';

  var STORE_KEY = 'insight.diagnosis.v1';
  var META_KEY = 'insight.meta.v1';

  var state = {
    meta: null,        // 商圈/门店清单
    diagnosis: null,   // 契约总 JSON（health/core_metrics/.../data_notes）
    source: null,      // 'coze-live' | 'demo-cache'
    elapsedMs: 0,
    storeName: '',
    district: '',
    generatedAt: ''
  };

  /* ---------- 持久化 ---------- */
  function persist() {
    try {
      sessionStorage.setItem(STORE_KEY, JSON.stringify({
        diagnosis: state.diagnosis, source: state.source, elapsedMs: state.elapsedMs,
        storeName: state.storeName, district: state.district, generatedAt: state.generatedAt
      }));
    } catch (_) {}
  }

  function restore() {
    try {
      var raw = sessionStorage.getItem(STORE_KEY);
      if (!raw) return;
      var s = JSON.parse(raw);
      if (s && s.diagnosis) {
        state.diagnosis = s.diagnosis; state.source = s.source;
        state.elapsedMs = s.elapsedMs || 0; state.storeName = s.storeName || '';
        state.district = s.district || ''; state.generatedAt = s.generatedAt || '';
      }
    } catch (_) {}
  }

  /* ---------- HTTP（自动附带登录 token；401 清登录态并回登录页） ---------- */
  function httpJson(url, options) {
    options = options || {};
    var token = localStorage.getItem('sip_token');
    if (token) {
      options.headers = options.headers || {};
      options.headers['Authorization'] = 'Bearer ' + token;
    }
    return fetch(url, options).then(function (resp) {
      return resp.json().then(function (body) {
        if (resp.status === 401) {
          localStorage.removeItem('sip_token');
          if (!/login\.html$/.test(location.pathname)) {
            var reason = body && body.code === 'SESSION_REPLACED' ? 'replaced' : 'expired';
            location.replace('/login.html?reason=' + reason);
          }
        }
        if (!resp.ok) {
          var err = new Error(body && body.error ? body.error : ('HTTP ' + resp.status));
          err.status = resp.status;
          throw err;
        }
        return body;
      });
    });
  }

  var API = {
    state: state,

    init: function () {
      restore();
      return httpJson('/api/meta').then(function (r) {
        state.meta = r.meta;
        try { sessionStorage.setItem(META_KEY, JSON.stringify(r.meta)); } catch (_) {}
        return state.meta;
      }).catch(function () {
        try {
          var raw = sessionStorage.getItem(META_KEY);
          if (raw) { state.meta = JSON.parse(raw); return state.meta; }
        } catch (_) {}
        throw new Error('无法加载商圈/门店清单（/api/meta）');
      });
    },

    health: function () { return httpJson('/api/health'); },

    /**
     * 默认诊断数据集（功能2）：服务端 data/default_reports.json，
     * 由 gen_default_report.py 基于 03 经营主表 + 真实 UGC 语料确定性生成，非实时调用。
     */
    defaultReport: function (storeName) {
      return httpJson('/api/default-report?store=' + encodeURIComponent(storeName)).then(function (r) {
        state.diagnosis = r.result;
        state.source = 'default-report';
        state.elapsedMs = 0;
        state.storeName = storeName;
        state.district = (r.result.store && r.result.store.district) || state.district;
        state.generatedAt = r.generatedAt || '';
        persist();
        return r;
      });
    },

    /**
     * 只读拉取某店默认报告，不改全局诊断态（门店对比视图用）。
     */
    peekReport: function (storeName) {
      this._peekCache = this._peekCache || {};
      if (this._peekCache[storeName]) return Promise.resolve(this._peekCache[storeName]);
      return httpJson('/api/default-report?store=' + encodeURIComponent(storeName)).then(function (r) {
        API._peekCache[storeName] = r.result;
        return r.result;
      });
    },

    logout: function () {
      return httpJson('/api/auth/logout', { method: 'POST' }).catch(function () {}).then(function () {
        localStorage.removeItem('sip_token');
        localStorage.removeItem('sip_username');
        location.replace('/login.html');
      });
    },

    /**
     * 发起诊断。demo=true 走演示缓存（界面须明示），默认实时调用工作流（约 3 分钟）。
     */
    diagnose: function (shopName, district, demo) {
      return httpJson('/api/diagnose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shop_name: shopName, district: district, demo: demo === true })
      }).then(function (r) {
        state.diagnosis = r.result;
        state.source = r.source;
        state.elapsedMs = r.elapsedMs || 0;
        state.storeName = shopName;
        state.district = district;
        state.generatedAt = new Date().toISOString();
        persist();
        return r;
      });
    },

    clearDiagnosis: function () {
      state.diagnosis = null; state.source = null; state.elapsedMs = 0; state.generatedAt = '';
      try { sessionStorage.removeItem(STORE_KEY); } catch (_) {}
    },

    hasDiagnosis: function () { return Boolean(state.diagnosis); }
  };

  /* ================= 契约 JSON → 视图模型 工具 ================= */

  /** "约55%-65%（推断）" / "40.4%" / 93 → 数值（区间取中点，仅用于图形比例；标签仍显示原文） */
  API.parsePct = function (v) {
    if (v == null) return null;
    if (typeof v === 'number') return v;
    var s = String(v);
    var m = s.match(/([\d.]+)\s*%\s*[-~–]\s*([\d.]+)\s*%/);
    if (m) return (parseFloat(m[1]) + parseFloat(m[2])) / 2;
    var m2 = s.match(/([\d.]+)/);
    return m2 ? parseFloat(m2[1]) : null;
  };

  /** 环比：从 operations 月度数组算最新两月变化（真实计算，非模型文本） */
  API.momFrom = function (trend) {
    if (!trend || trend.length < 2) return null;
    var a = trend[trend.length - 2].value, b = trend[trend.length - 1].value;
    if (!a) return null;
    var pct = (b - a) / a * 100;
    return { pct: pct, text: (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%', direction: pct >= 0 ? 'up' : 'down' };
  };

  API.latestMonth = function (trend) {
    return trend && trend.length ? trend[trend.length - 1].month : '';
  };

  API.wan = function (v) { return (v / 10000).toFixed(1); };

  /** report_markdown 极简渲染（标题/加粗/列表/段落），零依赖 */
  API.renderMarkdown = function (md) {
    if (!md) return '';
    var esc = function (t) {
      return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    };
    var bold = function (t) { return t.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>'); };
    var html = [], inList = false;
    md.split('\n').forEach(function (line) {
      var t = line.trim();
      var closeList = function () { if (inList) { html.push('</ul>'); inList = false; } };
      if (!t) { closeList(); return; }
      var h = t.match(/^(#{1,4})\s+(.*)$/);
      if (h) { closeList(); html.push('<h' + (h[1].length + 1) + '>' + bold(esc(h[2])) + '</h' + (h[1].length + 1) + '>'); return; }
      var li = t.match(/^[-*]\s+(.*)$/) || t.match(/^\d+[.、]\s*(.*)$/);
      if (li) { if (!inList) { html.push('<ul>'); inList = true; } html.push('<li>' + bold(esc(li[1])) + '</li>'); return; }
      closeList();
      html.push('<p>' + bold(esc(t)) + '</p>');
    });
    if (inList) html.push('</ul>');
    return html.join('');
  };

  /** 提取报告章节标题（## 级） */
  API.reportChapters = function (md) {
    if (!md) return [];
    return md.split('\n').map(function (l) { return l.trim(); })
      .filter(function (l) { return /^#{1,2}\s+/.test(l); })
      .map(function (l) { return l.replace(/^#{1,2}\s+/, ''); });
  };

  global.InsightAPI = API;
})(window);
