/**
 * ============================================================
 * app.js — 长页滚动版（PRD V1.0 优化迭代）
 * 布局：一镜到底长卷，左侧签条导航 scroll-spy 跟随，hash 同步
 * 数据：默认报告（数据资产确定性生成）+ 实时诊断（扣子工作流）双通道
 * 原则：只渲染真实数据与确定性推断（逐处标注"推断"）；缺数据展示"知识库未覆盖"，绝不编造
 * ============================================================
 */

(function () {
  'use strict';

  var API = window.InsightAPI;
  var $ = function (id) { return document.getElementById(id); };

  var ARROW_UP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M6 18 18 6M9 6h9v9"/></svg>';
  var ARROW_DOWN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M6 6l12 12M18 9v9H9"/></svg>';
  var SENTI_COLORS = { pos: '#166534', neu: '#8a93a3', neg: '#c03d34' };
  var CHANNEL_COLORS = ['#166534', '#146d6d', '#2a8c8c', '#c9a86a', '#8a93a3'];

  var NAV = []; // scroll-spy 目标 [{viewId, el, navEl}]
  var current = { district: '', store: '' };
  var spyLock = false;

  function esc(t) {
    if (t == null) return '';
    return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function D() { return API.state.diagnosis; }
  function isDefault() { return API.state.source === 'default-report'; }
  /* 契约 pct 字符串的"（推断）"逐条后缀在卡片级 tag 统一标注，渲染时剥离避免挤压换行 */
  function noInfer(s) { return String(s == null ? '' : s).replace(/（推断）/g, ''); }
  function hasInfer(s) { return String(s == null ? '' : s).indexOf('推断') >= 0; }

  /* ================= 入口 ================= */

  document.addEventListener('DOMContentLoaded', init);

  function init() {
    if (!localStorage.getItem('sip_token')) { location.replace('/login.html'); return; }
    API.init().then(function () {
      var meta = API.state.meta;
      current.district = meta.defaultDistrict;
      current.store = meta.defaultStore;
      $('sidebar-user').textContent = localStorage.getItem('sip_username') || '';
      $('topbar-user').textContent = localStorage.getItem('sip_username') || '';
      buildSelectors();
      buildNavSpy();
      bindEvents();
      setupScrollFx();
      return loadDefaultReport(current.store);
    }).catch(function (e) {
      if (e && e.status === 401) return; // api.js 已跳转登录页
      document.body.innerHTML = '<div style="padding:60px;font-size:15px;color:#c03d34">' + esc(e.message) + '</div>';
    });
  }

  /* ================= V4 动效（数字落笔 + 滚入节奏） ================= */

  var REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function animateNum(el, target) {
    if (REDUCED || !isFinite(target)) return;
    var t0 = null, dur = 600;
    function step(ts) {
      if (t0 == null) t0 = ts;
      var p = Math.min(1, (ts - t0) / dur);
      var e = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(target * e);
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  function animateHeroNumbers(root) {
    if (!root || REDUCED) return;
    var hs = root.querySelector('.health-score');
    if (hs) { var v = parseFloat(hs.textContent); if (isFinite(v)) animateNum(hs, v); }
    root.querySelectorAll('.four-score').forEach(function (el) {
      var v = parseFloat(el.textContent);
      if (isFinite(v)) animateNum(el, v);
    });
  }

  function setupScrollFx() {
    if (REDUCED || !('IntersectionObserver' in window)) return;
    document.body.classList.add('v4-motion');
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
      });
    }, { threshold: 0.04 });
    document.querySelectorAll('.view-anchor').forEach(function (s) { io.observe(s); });
  }

  /* ================= 选择器（双端：左侧边栏 + 右侧主区） ================= */

  function buildSelectors() {
    var meta = API.state.meta;
    var pairs = [
      { d: $('district-select'), s: $('store-select') },
      { d: $('sidebar-district-select'), s: $('sidebar-store-select') }
    ];
    pairs.forEach(function (p) {
      p.d.innerHTML = meta.districts.map(function (d) {
        return '<option value="' + esc(d.name) + '">' + esc(d.name) + '</option>';
      }).join('');
      p.d.value = current.district;
      rebuildStoreOptions(p.s, current.district);
      p.s.value = current.store;
      p.d.addEventListener('change', function () { switchDistrict(p.d.value); });
      p.s.addEventListener('change', function () { switchStore(p.s.value); });
    });
    syncSelectors();
  }

  function rebuildStoreOptions(sel, district) {
    var stores = API.state.meta.stores.filter(function (s) { return s.district === district; });
    sel.innerHTML = stores.map(function (s) {
      return '<option value="' + esc(s.name) + '">' + esc(s.name) + '</option>';
    }).join('');
  }

  function syncSelectors() {
    [$('district-select'), $('sidebar-district-select')].forEach(function (s) { if (s) s.value = current.district; });
    [$('store-select'), $('sidebar-store-select')].forEach(function (s) {
      if (!s) return;
      rebuildStoreOptions(s, current.district);
      s.value = current.store;
    });
    $('sidebar-district').textContent = current.district;
    $('sidebar-store-name').textContent = current.store;
    $('store-sub').textContent = '当前商圈「' + current.district + '」共 ' +
      API.state.meta.stores.filter(function (s) { return s.district === current.district; }).length + ' 家门店入库';
  }

  function switchDistrict(name) {
    if (name === current.district) return;
    current.district = name;
    var first = API.state.meta.stores.find(function (s) { return s.district === name; });
    current.store = first ? first.name : '';
    syncSelectors();
    renderDistrictGrid();
    renderStoreGrid();
    if (current.store) loadDefaultReport(current.store);
  }

  function switchStore(name) {
    if (!name || name === current.store) return;
    current.store = name;
    syncSelectors();
    renderStoreGrid();
    loadDefaultReport(name);
  }

  /* ================= 数据加载 ================= */

  // 默认报告为常态不展示徽标；仅实时/演示缓存两种特殊态显示（诚实性标识）
  function setSourceBadge(source) {
    var b = $('selector-source');
    var map = {
      'coze-live': ['实时诊断 · AI 工作流', 'src-live'],
      'demo-cache': ['演示缓存 · 非实时调用', 'src-demo']
    };
    var m = map[source];
    if (!m) { b.hidden = true; return; }
    b.hidden = false;
    b.textContent = m[0];
    b.className = 'src-badge ' + m[1];
  }

  function loadDefaultReport(store) {
    setBusy(true);
    return API.defaultReport(store).then(function () {
      setSourceBadge('default-report');
      renderAll();
    }).catch(function (e) {
      if (e && e.status === 401) return;
      showError('默认报告加载失败：' + e.message);
    }).finally(function () { setBusy(false); });
  }

  function setBusy(busy) {
    $('btn-diagnose').disabled = busy;
  }

  /* ================= 实时诊断（功能1） ================= */

  var PHASES = ['知识库检索（5 大知识库）', '4 路并行分析（画像/评价/价格/竞品）', '经营诊断汇总'];

  function startLiveDiagnosis() {
    var btn = $('btn-diagnose');
    btn.disabled = true;
    $('run-console').hidden = false;
    $('error-banner').hidden = true;
    $('run-status').textContent = '调用中…（已用 0s / 预计约 180s）';
    $('phase-list').innerHTML = PHASES.map(function (p) {
      return '<div class="phase-item"><span class="phase-dot running"></span>' + esc(p) + '<span class="phase-state">分析中</span></div>';
    }).join('');
    $('progress-fill').style.width = '8%';
    $('run-console').scrollIntoView({ behavior: 'smooth', block: 'start' });

    var t0 = Date.now();
    var timer = setInterval(function () {
      var s = Math.round((Date.now() - t0) / 1000);
      $('run-status').textContent = '调用中…（已用 ' + s + 's / 预计约 180s）';
      // 只做时间进度提示，不伪造节点完成态；上限 92%，完成时才到 100%
      $('progress-fill').style.width = Math.min(8 + s / 2, 92) + '%';
    }, 1000);

    API.diagnose(current.store, current.district, false).then(function () {
      clearInterval(timer);
      $('progress-fill').style.width = '100%';
      $('run-status').textContent = '诊断完成（' + Math.round((Date.now() - t0) / 1000) + 's）';
      $('phase-list').innerHTML = PHASES.map(function (p) {
        return '<div class="phase-item"><span class="phase-dot done"></span>' + esc(p) + '<span class="phase-state">完成</span></div>';
      }).join('');
      setSourceBadge('coze-live');
      renderAll();
      toast('实时诊断完成，页面已更新为实时结果', 'ok');
    }).catch(function (e) {
      clearInterval(timer);
      if (e && e.status === 401) return;
      $('run-status').textContent = '调用失败';
      showError('实时诊断失败：' + e.message + '（当前展示仍为默认报告）');
    }).finally(function () {
      btn.disabled = false;
      setTimeout(function () { $('run-console').hidden = true; }, 2500);
    });
  }

  function showError(msg) {
    var b = $('error-banner');
    b.textContent = msg;
    b.hidden = false;
  }

  /* ================= 长页 scroll-spy ================= */

  function buildNavSpy() {
    NAV = [];
    document.querySelectorAll('#nav-menu .nav-item').forEach(function (a) {
      var viewId = a.getAttribute('data-view');
      var el = $(viewId);
      if (el) NAV.push({ viewId: viewId, el: el, navEl: a });
      a.addEventListener('click', function (e) {
        e.preventDefault();
        spyLock = true;
        setActiveNav(viewId);
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        history.replaceState(null, '', '#' + viewId.replace('view-', ''));
        setTimeout(function () { spyLock = false; }, 800);
      });
    });

    var spy = new IntersectionObserver(function (entries) {
      if (spyLock) return;
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          setActiveNav(en.target.id);
          history.replaceState(null, '', '#' + en.target.id.replace('view-', ''));
        }
      });
    }, { rootMargin: '-30% 0px -60% 0px' });
    NAV.forEach(function (n) { spy.observe(n.el); });

    // 首次进入按 hash 定位
    var h = (location.hash || '').replace(/^#\/?/, '');
    var target = h && $('view-' + h) ? $('view-' + h) : null;
    if (target) setTimeout(function () { target.scrollIntoView({ block: 'start' }); }, 60);
  }

  function setActiveNav(viewId) {
    NAV.forEach(function (n) { n.navEl.classList.toggle('active', n.viewId === viewId); });
  }

  /* ================= 事件绑定 ================= */

  function bindEvents() {
    $('btn-diagnose').addEventListener('click', startLiveDiagnosis);
    $('btn-logout').addEventListener('click', function () { API.logout(); });
    $('btn-export-txt').addEventListener('click', exportReportTxt);
  }

  /* ================= 全量渲染 ================= */

  function renderAll() {
    syncSelectors();
    setSourceBadge(API.state.source);
    renderDistrictGrid();
    renderStoreGrid();
    renderOverview();
    renderCustomer();
    renderProduct();
    renderOperations();
    renderUgc();
    renderIssues();
    renderActions();
    renderReport();
    renderCompare();
  }

  /* ---------- 01/02 选择商圈/门店 ---------- */

  var CHECK_SVG = '<span class="card-check"></span>';

  function renderDistrictGrid() {
    var meta = API.state.meta;
    $('district-grid').innerHTML = meta.districts.map(function (d) {
      var n = meta.stores.filter(function (s) { return s.district === d.name; }).length;
      var isActive = d.name === current.district;
      return '<div class="district-card' + (isActive ? ' active' : '') + '" data-d="' + esc(d.name) + '">' +
        (isActive ? CHECK_SVG : '') +
        '<div class="dc-name">' + esc(d.name) + '</div>' +
        '<div class="dc-meta">' + n + ' 家门店入库</div>' +
        (d.desc ? '<div class="dc-desc">' + esc(d.desc) + '</div>' : '') +
        '</div>';
    }).join('');
    $('district-grid').querySelectorAll('.district-card').forEach(function (c) {
      c.addEventListener('click', function () { switchDistrict(c.getAttribute('data-d')); });
    });
  }

  function renderStoreGrid() {
    var stores = API.state.meta.stores.filter(function (s) { return s.district === current.district; });
    $('store-grid').innerHTML = stores.map(function (s) {
      var isActive = s.name === current.store;
      return '<div class="store-card-item' + (isActive ? ' active' : '') + '" data-s="' + esc(s.name) + '">' +
        (isActive ? CHECK_SVG : '') +
        '<div class="sc-name">' + esc(s.name) + '</div>' +
        '<div class="sc-district">' + esc(s.district) + '</div></div>';
    }).join('');
    $('store-grid').querySelectorAll('.store-card-item').forEach(function (c) {
      c.addEventListener('click', function () { switchStore(c.getAttribute('data-s')); });
    });
  }

  /* ---------- 03 经营状态 ---------- */

  function kpiCardsHtml(kpis) {
    return kpis.map(function (k) {
      var trend = '';
      if (k.change && k.change.text) {
        var cls = k.change.direction === 'up' ? 'up' : 'down';
        var arrow = k.change.direction === 'up' ? ARROW_UP : ARROW_DOWN;
        trend = '<div class="kpi-trend ' + cls + '">' + arrow +
          '<span class="pct">' + k.change.text + '</span><span class="vs">环比上月</span></div>';
      } else if (k.note) {
        trend = '<div class="kpi-trend flat"><span class="vs">' + esc(k.note) + '</span></div>';
      }
      return '<div class="kpi-card"><div class="kpi-label">' + esc(k.label) + '</div>' +
        '<div class="kpi-value">' + esc(k.value) + (k.unit ? '<span class="unit">' + esc(k.unit) + '</span>' : '') + '</div>' +
        trend + '</div>';
    }).join('');
  }

  function fourScoresHtml(four) {
    if (!four) return '';
    return '<div class="card"><div class="card-title">四维评分<span class="card-tag">白盒公式 · 见报告数据说明</span></div>' +
      '<div class="four-grid">' + Object.keys(four).map(function (k) {
        var v = four[k];
        var color = v == null ? '#8a93a3' : v >= 75 ? '#166534' : v >= 55 ? '#e8734a' : '#c03d34';
        return '<div class="four-item"><div class="four-score" style="color:' + color + '">' + (v == null ? '—' : v) + '</div>' +
          '<div class="four-label">' + esc(k) + '</div>' +
          '<div class="four-track"><i style="width:' + (v || 0) + '%;background:' + color + '"></i></div></div>';
      }).join('') + '</div></div>';
  }

  function renderOverview() {
    var d = D();
    if (!d) { $('overview-body').innerHTML = emptyStateHtml('暂无数据'); return; }
    var h = d.health || {};
    $('overview-sub').textContent = (d.store ? d.store.name + ' · ' + d.store.district : '') +
      (API.state.source === 'coze-live' ? ' · 实时诊断结果' : API.state.source === 'demo-cache' ? ' · 演示缓存（非实时调用）' : '') +
      (isDefault() && d.core_metrics && d.core_metrics['数据期间'] ? ' · 数据期间 ' + d.core_metrics['数据期间'] : '');

    var html = '<div class="grid-2col">';
    html += '<div class="card health-card"><div class="card-title">综合健康度</div>' +
      '<div class="health-main"><span class="health-score">' + (h.score != null ? h.score : '—') + '</span>' +
      '<span class="health-grade">' + esc(h.grade || h.status || '') + '</span></div>' +
      (h.basis ? '<div class="mini-note">' + esc(h.basis) + '</div>' : '') +
      (h.mom_change ? '<div class="mini-note">' + esc(h.mom_change) + '</div>' : '') +
      (!isDefault() ? '<div class="mini-note">AI 工作流即时评估（口径：营收趋势40%+满意度25%+竞争力20%+效率15%），与默认报告的确定性公式口径不同，分数偏差属正常</div>' : '') + '</div>';
    if (d.four_scores) html += fourScoresHtml(d.four_scores);
    html += '</div>';

    // KPI
    var kpis = [];
    if (isDefault() && d.core_metrics) {
      var c = d.core_metrics;
      kpis = [
        { label: '月营业额', value: c['月营业额'] != null ? '¥' + Number(c['月营业额']).toLocaleString() : '—',
          change: c['营收环比%'] != null ? { text: (c['营收环比%'] >= 0 ? '+' : '') + c['营收环比%'] + '%', direction: c['营收环比%'] >= 0 ? 'up' : 'down' } : null },
        { label: '月净利润', value: c['月净利润'] != null ? '¥' + Number(c['月净利润']).toLocaleString() : '—', note: c['盈亏状态'] || '' },
        { label: '日均客流', value: c['日均客流'] != null ? String(c['日均客流']) : '—', unit: '人' },
        { label: '客单价', value: c['客单价'] != null ? '¥' + c['客单价'] : '—' },
        { label: '复购率', value: c['复购率%'] != null ? c['复购率%'] + '' : '—', unit: '%', note: c['复购率%'] != null && c['复购率%'] < 40 ? '低于 40% 健康线' : '' },
        { label: '毛利率', value: c['毛利率%'] != null ? c['毛利率%'] + '' : '—', unit: '%' }
      ];
    } else if (d.core_metrics) {
      var cm = d.core_metrics;
      kpis = [
        { label: '客单价', value: cm.avg_order_value != null ? '¥' + cm.avg_order_value : '—' },
        { label: '复购率', value: cm.repurchase_rate || '—' },
        { label: '满意度', value: cm.satisfaction != null ? String(cm.satisfaction) : '—' },
        { label: '客流趋势', value: cm.customer_flow_trend || '—' }
      ];
    }
    html += '<div class="kpi-grid">' + kpiCardsHtml(kpis) + '</div>';

    // 趋势图
    var trend = isDefault()
      ? (d.operations && d.operations.monthly ? d.operations.monthly.map(function (m) { return { month: m.month, value: m.revenue }; }) : [])
      : (d.operations && d.operations.revenue_trend ? d.operations.revenue_trend : []);
    if (trend.length) {
      var maxV = Math.max.apply(null, trend.map(function (t) { return t.value; }));
      html += '<div class="card"><div class="card-title">月营业额走势<span class="card-tag">' +
        (isDefault() ? '03 经营主表' : '实时契约返回') + '</span></div>' +
        '<div class="chart-box" id="ov-rev-chart"></div></div>';
    }
    $('overview-body').innerHTML = html;
    if (trend.length) {
      drawAreaChart($('ov-rev-chart'), {
        values: trend.map(function (t) { return t.value; }),
        xLabels: monthXLabels(trend, 2),
        yAxis: niceYAxis(maxV, 3),
        yFormat: function (v) { return (v / 10000).toFixed(0) + '万'; },
        hoverLabels: trend.map(function (t) { return t.month; })
      });
    }
    animateHeroNumbers($('overview-body'));
  }

  /* ---------- 04 客群分析 ---------- */

  function renderCustomer() {
    var d = D();
    var body = $('customer-body');
    if (!d) { body.innerHTML = emptyStateHtml('暂无数据'); return; }
    var ci = d.customer_insight || {};
    var html = '';

    if (isDefault()) {
      var tags = ci.tags_top5 || [];
      html += '<div class="card"><div class="card-title">客群标签 TOP5<span class="card-tag">基于经营数据与真实UGC推断 · 已标注</span></div>';
      if (tags.length) {
        html += tags.map(function (t, i) {
          var pctNum = API.parsePct(t.pct) || 0;
          return '<div class="tagbar-row"><span class="tagbar-rank">' + (i + 1) + '</span>' +
            '<div class="tagbar-main"><div class="tagbar-head"><b>' + esc(t.name) + '</b><span class="tagbar-pct">' + esc(t.pct) + '</span></div>' +
            '<div class="tb-track"><div class="tb-fill" style="width:' + pctNum + '%"></div></div>' +
            '<div class="tagbar-desc">' + esc(t.desc) + ' <i>依据：' + esc(t.basis) + '</i></div></div></div>';
        }).join('');
      } else html += emptyStateHtml('客群标签缺数据');
      html += '</div>';

      var rt = ci.retention || {};
      html += '<div class="grid-2col">';
      html += '<div class="card"><div class="card-title">复购率（真实记录）</div>' +
        '<div class="health-main"><span class="health-score">' + (rt.repurchase_rate != null ? rt.repurchase_rate : '—') + '</span><span class="health-grade">%</span></div>' +
        '<div class="mini-note">' + esc(rt.repurchase_basis || '') + '</div>' +
        '<div class="chart-box" id="cu-rep-chart"></div></div>';
      html += '<div class="card"><div class="card-title">新老客结构<span class="card-tag">推断</span></div><div id="cu-newold"></div>' +
        '<div class="mini-note">' + esc(rt.new_old && rt.new_old.basis ? rt.new_old.basis : '知识库未覆盖') + '</div></div>';
      html += '</div>';
      if (rt.retention_curve) {
        html += '<div class="card"><div class="card-title">留存曲线<span class="card-tag">推断</span></div>' +
          '<div class="chart-box" id="cu-curve-chart"></div>' +
          '<div class="mini-note">' + esc(rt.retention_curve.basis) + '</div></div>';
      }
      html += '<div class="card"><div class="mini-note">' + esc(rt.notes || '') + '</div></div>';
      body.innerHTML = html;
      if (rt.trend && rt.trend.length) {
        var maxR = Math.max.apply(null, rt.trend.map(function (t) { return t.rate || 0; }).concat([40]));
        drawAreaChart($('cu-rep-chart'), {
          values: rt.trend.map(function (t) { return t.rate || 0; }),
          xLabels: rt.trend.map(function (t, i) { return { index: i, text: t.month.slice(5) }; }).filter(function (_, i) { return i % 2 === 0; }),
          yAxis: niceYAxis(maxR, 3),
          yFormat: function (v) { return v + '%'; },
          hoverLabels: rt.trend.map(function (t) { return t.month; })
        });
      }
      if (rt.new_old) {
        drawDonut($('cu-newold'), [
          { label: '老客（复购）', value: rt.new_old['老客%'], color: '#166534' },
          { label: '新客', value: rt.new_old['新客%'], color: '#d3d8de' }
        ]);
      }
      if (rt.retention_curve) {
        var rc = rt.retention_curve;
        var maxC = Math.max.apply(null, rc.values.concat([10]));
        drawAreaChart($('cu-curve-chart'), {
          values: rc.values,
          xLabels: rc.months.map(function (m, i) { return { index: i, text: m }; }),
          yAxis: niceYAxis(maxC, 3),
          yFormat: function (v) { return v + '%'; },
          hoverLabels: rc.months
        });
      }
    } else {
      // 实时契约形态
      var segs = ci.age_segments || [];
      html += '<div class="grid-2col">';
      html += '<div class="card"><div class="card-title">年龄段分布<span class="card-tag">契约标注"推断"</span></div>';
      html += segs.length
        ? segs.map(function (s) {
            var pctNum = API.parsePct(s.pct) || 0;
            return '<div class="tag-bar-row"><span class="tb-label">' + esc(s.label) + '</span>' +
              '<div class="tb-track"><div class="tb-fill" style="width:' + pctNum + '%"></div></div>' +
              '<span class="tb-value">' + esc(noInfer(s.pct)) + '</span></div>';
          }).join('')
        : emptyStateHtml('年龄段缺数据');
      html += '</div>';
      var genderInfer = ci.gender && (hasInfer(ci.gender.female_pct) || hasInfer(ci.gender.male_pct));
      html += '<div class="card"><div class="card-title">客群概览' +
        (genderInfer ? '<span class="card-tag">性别占比为契约标注"推断"</span>' : '') + '</div><ul class="kv-list">' +
        '<li><span>复购率</span><b>' + esc(ci.repurchase_rate || '—') + '</b></li>' +
        '<li><span>人均消费</span><b>' + (ci.avg_spend != null ? '¥' + ci.avg_spend : '—') + '</b></li>' +
        '<li><span>性别结构</span><b>' + esc((ci.gender ? '女 ' + noInfer(ci.gender.female_pct) + ' / 男 ' + noInfer(ci.gender.male_pct) : '—')) + '</b></li>' +
        '<li><span>高峰时段</span><b>' + esc(ci.peak_hours || '—') + '</b></li></ul></div>';
      html += '</div>';
      body.innerHTML = html;
    }
  }

  /* ---------- 05 商品分析 ---------- */

  function renderProduct() {
    var d = D();
    var body = $('product-body');
    if (!d) { body.innerHTML = emptyStateHtml('暂无数据'); return; }
    var html = '';
    if (isDefault()) {
      var c = d.core_metrics || {};
      html += '<div class="grid-2col"><div class="card"><div class="card-title">主推产品<span class="card-tag">03 主表真实记录</span></div>';
      if (c['主推产品']) {
        html += '<div class="product-hero"><div class="ph-name">' + esc(c['主推产品']) + '</div>' +
          '<div class="ph-price">¥' + esc(String(c['主推产品价格'])) + '</div></div>' +
          '<div class="mini-note">月度菜单结构、SKU 销售明细知识库未覆盖。</div>';
      } else html += emptyStateHtml('主推产品缺数据');
      html += '</div>';
      html += '<div class="card"><div class="card-title">价格带分布</div>' +
        emptyStateHtml('价格带分布缺数据（知识库未覆盖）', '补齐路径：菜单各 SKU 价格与销量结构入库后自动生成') + '</div>';
      html += '</div>';
    } else {
      var pp = d.product_price || {};
      var tops = pp.top_products || [];
      html += '<div class="card"><div class="card-title">热销产品<span class="card-tag">契约返回</span></div>';
      html += tops.length ? '<table class="data-table"><thead><tr><th>产品</th><th>价格</th><th>销售占比</th></tr></thead><tbody>' +
        tops.map(function (t) {
          return '<tr><td>' + esc(t.name) + '</td><td>¥' + esc(String(t.price)) + '</td><td>' + esc(t.sales_share) + '</td></tr>';
        }).join('') + '</tbody></table>' : emptyStateHtml('热销产品缺数据');
      html += '</div>';
      var bands = pp.price_bands || [];
      var bandInfer = bands.some(function (b) { return hasInfer(b.pct); });
      html += '<div class="card"><div class="card-title">价格带分布' +
        (bandInfer ? '<span class="card-tag">占比为契约标注"推断"</span>' : '') + '</div>';
      html += bands.length ? bands.map(function (b) {
        var pctNum = API.parsePct(b.pct) || 0;
        return '<div class="tag-bar-row"><span class="tb-label">' + esc(b.band) + '</span>' +
          '<div class="tb-track"><div class="tb-fill" style="width:' + pctNum + '%"></div></div>' +
          '<span class="tb-value">' + esc(noInfer(b.pct)) + '</span></div>';
      }).join('') : emptyStateHtml('价格带缺数据（契约返回为空，已如实展示）');
      html += '</div>';
      if ((pp.advantages || []).length || (pp.risks || []).length) {
        html += '<div class="grid-2col"><div class="card"><div class="card-title">产品优势</div><ul class="plain-list">' +
          (pp.advantages || []).map(function (a) { return '<li>' + esc(a) + '</li>'; }).join('') + '</ul></div>' +
          '<div class="card"><div class="card-title">产品风险</div><ul class="plain-list">' +
          (pp.risks || []).map(function (a) { return '<li>' + esc(a) + '</li>'; }).join('') + '</ul></div></div>';
      }
    }
    body.innerHTML = html;
  }

  /* ---------- 06 经营数据 ---------- */

  function renderOperations() {
    var d = D();
    var body = $('operations-body');
    if (!d) { body.innerHTML = emptyStateHtml('暂无数据'); return; }
    var html = '';
    if (isDefault()) {
      var monthly = (d.operations && d.operations.monthly) || [];
      if (monthly.length) {
        html += '<div class="card"><div class="card-title">月度经营明细<span class="card-tag">03 经营主表（依据真实锚点模拟）</span></div>' +
          '<div class="table-wrap"><table class="data-table"><thead><tr>' +
          '<th>月份</th><th>月营业额</th><th>日均客流</th><th>客单价</th><th>复购率</th><th>毛利率</th><th>净利润</th><th>盈亏</th></tr></thead><tbody>' +
          monthly.map(function (m) {
            return '<tr><td>' + esc(m.month) + '</td><td>¥' + Number(m.revenue).toLocaleString() + '</td>' +
              '<td>' + esc(String(m.flow)) + '</td><td>¥' + esc(String(m.aov)) + '</td>' +
              '<td>' + (m.repurchase != null ? m.repurchase + '%' : '—') + '</td>' +
              '<td>' + (m.gross != null ? m.gross + '%' : '—') + '</td>' +
              '<td>¥' + Number(m.profit).toLocaleString() + '</td><td>' + esc(m.status || '—') + '</td></tr>';
          }).join('') + '</tbody></table></div></div>';
        var last = monthly[monthly.length - 1];
        var segs = [
          { label: '到店', value: last.dinein || 0 },
          { label: '美团(外卖/团购)', value: last.meituan || 0 },
          { label: '抖音(团购)', value: last.douyin || 0 },
          { label: '小红书(团购)', value: last.xhs || 0 }
        ].filter(function (s) { return s.value > 0; });
        if (segs.length) {
          html += '<div class="grid-2col"><div class="card"><div class="card-title">渠道结构（' + esc(last.month) + '）</div>' +
            '<div class="donut-row"><div id="op-channel-donut"></div><ul class="donut-legend">' +
            donutLegend(segs.map(function (s, i) {
              return { label: s.label, value: s.value, text: s.value + '%', color: CHANNEL_COLORS[i % CHANNEL_COLORS.length] };
            })) + '</ul></div></div>';
          html += '<div class="card"><div class="card-title">高峰时段</div>' +
            emptyStateHtml('分时段客流缺数据（知识库未覆盖）', '补齐路径：POS 分时段流水或客流计数器数据接入') + '</div></div>';
        }
      } else {
        html += '<div class="card">' + emptyStateHtml('该门店暂无经营数据记录') + '</div>';
      }
      body.innerHTML = html;
      if ($('op-channel-donut')) {
        var lastM = monthly[monthly.length - 1];
        drawDonut($('op-channel-donut'), [
          { label: '到店', value: lastM.dinein || 0, color: CHANNEL_COLORS[0] },
          { label: '美团', value: lastM.meituan || 0, color: CHANNEL_COLORS[1] },
          { label: '抖音', value: lastM.douyin || 0, color: CHANNEL_COLORS[2] },
          { label: '小红书', value: lastM.xhs || 0, color: CHANNEL_COLORS[3] }
        ].filter(function (s) { return s.value > 0; }));
      }
    } else {
      var ops = d.operations || {};
      var rev = ops.revenue_trend || [], flow = ops.flow_trend || [];
      html += '<div class="grid-2col">';
      html += '<div class="card"><div class="card-title">月营收走势</div><div class="chart-box" id="op-rev"></div></div>';
      html += '<div class="card"><div class="card-title">客流走势</div><div class="chart-box" id="op-flow"></div></div></div>';
      if ((ops.anomalies || []).length) {
        html += '<div class="card"><div class="card-title">经营异动</div><ul class="plain-list">' +
          ops.anomalies.map(function (a) {
            return '<li><b>' + esc(a['期间'] || '') + '</b> ' + esc(a['指标'] || '') + ' ' + esc(a['幅度'] || '') + '</li>';
          }).join('') + '</ul></div>';
      }
      body.innerHTML = html;
      if (rev.length) {
        drawAreaChart($('op-rev'), {
          values: rev.map(function (t) { return t.value; }),
          xLabels: monthXLabels(rev, 2), yAxis: niceYAxis(Math.max.apply(null, rev.map(function (t) { return t.value; })), 3),
          yFormat: function (v) { return (v / 10000).toFixed(0) + '万'; },
          hoverLabels: rev.map(function (t) { return t.month; })
        });
      }
      if (flow.length) {
        drawAreaChart($('op-flow'), {
          values: flow.map(function (t) { return t.value; }),
          xLabels: monthXLabels(flow, 2), yAxis: niceYAxis(Math.max.apply(null, flow.map(function (t) { return t.value; })), 3),
          hoverLabels: flow.map(function (t) { return t.month; })
        });
      }
    }
  }

  /* ---------- 07 用户满意度（主题分析 + 情感镜像） ---------- */

  function renderUgc() {
    var d = D();
    var body = $('ugc-body');
    if (!d) { body.innerHTML = emptyStateHtml('暂无数据'); return; }
    var ug = d.ugc_feedback || {};
    var html = '';

    if (isDefault() && ug.satisfaction) {
      var sat = ug.satisfaction;
      $('ugc-sub').textContent = ug.basis || '';
      var segs = [
        { label: '好评', value: sat.pos, color: SENTI_COLORS.pos },
        { label: '中立', value: sat.neu, color: SENTI_COLORS.neu },
        { label: '差评', value: sat.neg, color: SENTI_COLORS.neg }
      ];
      html += '<div class="grid-2col">';
      html += '<div class="card"><div class="card-title">满意度三模块分类<span class="card-tag">真实语料 n=' + sat.total + '</span></div>' +
        '<div class="donut-row"><div id="ug-donut"></div><ul class="donut-legend">' + donutLegend(segs.map(function (s) {
          return { label: s.label, value: s.value, text: s.value + '%', color: s.color };
        })) + '</ul></div>' +
        '<div class="mini-note">' + esc(sat.method) + '</div></div>';

      var mir = ug.mirror || {};
      html += '<div class="card"><div class="card-title">词级情感镜像<span class="card-tag">同一文本中的矛盾态度</span></div>' +
        '<div class="mirror-grid">' +
        '<div class="mirror-item"><div class="mirror-num" style="color:#166534">' + (mir.pos_with_concern_pct != null ? mir.pos_with_concern_pct + '%' : '—') + '</div>' +
        '<div class="mirror-label">好评含隐忧</div><div class="mirror-n">' + (mir.pos_with_concern_n || 0) + ' 条好评同时命中负向词</div></div>' +
        '<div class="mirror-item"><div class="mirror-num" style="color:#c03d34">' + (mir.neg_with_praise_pct != null ? mir.neg_with_praise_pct + '%' : '—') + '</div>' +
        '<div class="mirror-label">差评含认可</div><div class="mirror-n">' + (mir.neg_with_praise_n || 0) + ' 条差评同时命中正向词</div></div>' +
        '</div><div class="mini-note">' + esc(mir.method || '') + '</div></div>';
      html += '</div>';

      if (ug.dianping && ug.dianping['评价总数']) {
        html += '<div class="card"><div class="card-title">大众点评摘要<span class="card-tag">真实爬取</span></div><ul class="kv-list">' +
          '<li><span>评价总数</span><b>' + esc(String(ug.dianping['评价总数'])) + ' 条</b></li>' +
          '<li><span>人均消费</span><b>¥' + esc(String(ug.dianping['人均消费'])) + '</b></li></ul></div>';
      }

      // 五大主题：雷达 + 明细 + 热力图
      var themes = ug.themes || [];
      if (themes.length) {
        html += '<div class="grid-2col"><div class="card"><div class="card-title">五大主题维度雷达<span class="card-tag">主题好评率(0-100)</span></div>' +
          '<div id="ug-radar" class="radar-box"></div></div>';
        html += '<div class="card"><div class="card-title">主题明细</div><table class="data-table"><thead><tr>' +
          '<th>主题</th><th>好评率</th><th>好评</th><th>中立</th><th>差评</th><th>高频词</th></tr></thead><tbody>' +
          themes.map(function (t) {
            return '<tr><td>' + esc(t.name) + '</td><td>' + (t.score != null ? t.score + '%' : '—') + '</td>' +
              '<td class="pos-cell">' + t.pos + '</td><td>' + (t.neu || 0) + '</td><td class="neg-cell">' + t.neg + '</td>' +
              '<td class="kw-cell">' + esc((t.keywords || []).join(' / ')) + '</td></tr>';
          }).join('') + '</tbody></table></div></div>';

        html += '<div class="card"><div class="card-title">主题 × 情感热力图<span class="card-tag">评论条数</span></div>' +
          '<div class="heatmap" id="ug-heatmap"></div><div class="mini-note">颜色越深 = 该主题下对应情感的评论越多；好评用墨绿、差评用朱砂。</div></div>';
      }

      // 词云
      var wc = ug.wordcloud || { pos: [], neg: [] };
      if (wc.pos.length || wc.neg.length) {
        html += '<div class="grid-2col">' +
          '<div class="card"><div class="card-title">好评关键词云<span class="card-tag">真实词频</span></div><div class="wordcloud" id="ug-wc-pos"></div></div>' +
          '<div class="card"><div class="card-title">差评关键词云<span class="card-tag">真实词频</span></div><div class="wordcloud" id="ug-wc-neg"></div></div></div>';
      }

      // 典型评论
      var tcs = ug.typical_comments || [];
      if (tcs.length) {
        html += '<div class="card"><div class="card-title">典型评论<span class="card-tag">真实原文 · 已脱敏</span></div>' +
          tcs.map(function (c) {
            var tagMap = { pos: ['好评', '#166534'], neu: ['中立', '#8a93a3'], neg: ['差评', '#c03d34'] };
            var tg = tagMap[c.sentiment] || tagMap.neu;
            return '<div class="comment-item" style="border-left-color:' + tg[1] + '">' +
              '<span class="comment-tag" style="background:' + tg[1] + '">' + tg[0] + '</span>' +
              '<span class="comment-text">' + esc(c.text) + '</span>' +
              '<span class="comment-meta">' + esc(c.source) + ' · 赞 ' + c.likes + '</span></div>';
          }).join('') + '</div>';
      }
      body.innerHTML = html;

      drawDonut($('ug-donut'), segs);
      if (themes.length) { drawRadar($('ug-radar'), themes); drawHeatmap($('ug-heatmap'), themes); }
      renderWordcloud($('ug-wc-pos'), wc.pos, '#166534');
      renderWordcloud($('ug-wc-neg'), wc.neg, '#c03d34');
    } else {
      // 实时契约形态
      $('ugc-sub').textContent = '实时诊断返回的口碑摘要';
      var score = ug.satisfaction_score;
      html += '<div class="grid-2col"><div class="card"><div class="card-title">满意度评分</div>' +
        '<div class="health-main"><span class="health-score">' + (score != null ? score : '—') + '</span></div>' +
        (ug.ai_summary ? '<div class="mini-note">' + esc(ug.ai_summary) + '</div>' : '') + '</div>';
      var sent = ug.sentiment || {};
      var hasSent = (sent.pos_pct || sent.neu_pct || sent.neg_pct);
      html += '<div class="card"><div class="card-title">情感分布</div>' +
        (hasSent
          ? '<ul class="kv-list"><li><span>好评</span><b>' + sent.pos_pct + '%</b></li><li><span>中立</span><b>' + sent.neu_pct + '%</b></li><li><span>差评</span><b>' + sent.neg_pct + '%</b></li></ul>'
          : emptyStateHtml('情感分布缺数据（契约返回为空，已如实展示）', '默认报告通道提供基于真实语料的三分类统计')) + '</div></div>';
      var topics = ug.topics || [];
      if (topics.length) {
        html += '<div class="card"><div class="card-title">评价主题</div><ul class="plain-list">' +
          topics.map(function (t) { return '<li>' + esc(typeof t === 'string' ? t : JSON.stringify(t)) + '</li>'; }).join('') + '</ul></div>';
      }
      body.innerHTML = html;
    }
  }

  function drawRadar(container, themes) {
    if (!container) return;
    var size = 300, cx = size / 2, cy = size / 2 + 6, R = 100;
    var n = themes.length;
    function pt(i, r) {
      var a = -Math.PI / 2 + i * 2 * Math.PI / n;
      return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
    }
    var rings = [0.25, 0.5, 0.75, 1].map(function (f) {
      return '<polygon points="' + themes.map(function (_, i) { var p = pt(i, R * f); return p.x.toFixed(1) + ',' + p.y.toFixed(1); }).join(' ') +
        '" fill="none" stroke="#e3e7ec" stroke-width="1"/>';
    }).join('');
    var axes = themes.map(function (_, i) {
      var p = pt(i, R);
      return '<line x1="' + cx + '" y1="' + cy + '" x2="' + p.x + '" y2="' + p.y + '" stroke="#e3e7ec"/>';
    }).join('');
    var vals = themes.map(function (t, i) { var p = pt(i, R * ((t.score != null ? t.score : 0) / 100)); return p.x.toFixed(1) + ',' + p.y.toFixed(1); }).join(' ');
    var labels = themes.map(function (t, i) {
      var p = pt(i, R + 26);
      var anchor = Math.abs(p.x - cx) < 20 ? 'middle' : (p.x > cx ? 'start' : 'end');
      return '<text class="axis-text" x="' + p.x + '" y="' + p.y + '" text-anchor="' + anchor + '">' + esc(t.name) +
        ' ' + (t.score != null ? t.score : '—') + '</text>';
    }).join('');
    container.innerHTML = '<svg viewBox="0 0 ' + size + ' ' + size + '" width="100%" height="' + size + '">' +
      rings + axes +
      '<polygon points="' + vals + '" fill="rgba(22,101,52,0.18)" stroke="#166534" stroke-width="2"/>' + labels + '</svg>';
  }

  function drawHeatmap(container, themes) {
    if (!container) return;
    var maxV = 1;
    themes.forEach(function (t) { maxV = Math.max(maxV, t.pos, t.neg, t.neu || 0); });
    function cell(v, cls) {
      var a = v ? (0.12 + 0.88 * v / maxV) : 0;
      var bg = cls === 'pos' ? 'rgba(22,101,52,' + a.toFixed(2) + ')' : cls === 'neg' ? 'rgba(192,61,52,' + a.toFixed(2) + ')' : 'rgba(138,147,163,' + a.toFixed(2) + ')';
      var fg = a > 0.5 ? '#fff' : '#3a4354';
      return '<td style="background:' + bg + ';color:' + fg + '">' + v + '</td>';
    }
    container.innerHTML = '<table class="heat-table"><thead><tr><th>主题</th><th>好评</th><th>中立</th><th>差评</th></tr></thead><tbody>' +
      themes.map(function (t) {
        return '<tr><td class="heat-label">' + esc(t.name) + '</td>' + cell(t.pos, 'pos') + cell(t.neu || 0, 'neu') + cell(t.neg, 'neg') + '</tr>';
      }).join('') + '</tbody></table>';
  }

  function renderWordcloud(container, words, color) {
    if (!container) return;
    if (!words || !words.length) { container.innerHTML = emptyStateHtml('词频缺数据'); return; }
    var max = words[0].c || 1;
    container.innerHTML = words.map(function (w) {
      var size = 12 + Math.round((w.c / max) * 22);
      var op = 0.55 + 0.45 * (w.c / max);
      return '<span class="wc-word" style="font-size:' + size + 'px;color:' + color + ';opacity:' + op.toFixed(2) + '" title="出现 ' + w.c + ' 次">' + esc(w.w) + '</span>';
    }).join('');
  }

  /* ---------- 08 AI识别问题（仅客群类别） ---------- */

  function issueCardHtml(p) {
    var prCls = p.priority === 'P1' || p.priority === 'P0' ? 'pr-p1' : p.priority === 'P2' ? 'pr-p2' : 'pr-p3';
    var kindTag = p.kind ? '<span class="kind-tag kind-' + esc(p.kind) + '">' + esc(p.kind) + '</span>' : '';
    return '<div class="issue-card">' +
      '<div class="issue-head"><span class="pr-badge ' + prCls + '">' + esc(p.priority || '—') + '</span>' + kindTag +
      '<b class="issue-title">' + esc(p.title) + '</b></div>' +
      (p.evidence ? '<div class="issue-row"><span class="issue-k">证据</span>' + esc(p.evidence) + '</div>' : '') +
      (p.impact ? '<div class="issue-row"><span class="issue-k">影响</span>' + esc(p.impact) + '</div>' : '') +
      (p.cause_chain ? '<div class="issue-row"><span class="issue-k">归因</span>' + esc(p.cause_chain) + '</div>' : '') +
      (p.confidence ? '<div class="issue-conf">置信度：' + esc(p.confidence) + '</div>' : '') +
      '</div>';
  }

  function customerProblems(d) {
    var problems = (d.ai_diagnosis && d.ai_diagnosis.problems) || [];
    return problems.filter(function (p) { return p.category === '客群'; });
  }

  function renderIssues() {
    var d = D();
    var body = $('issues-body');
    if (!d) { body.innerHTML = emptyStateHtml('暂无数据'); return; }
    var list = customerProblems(d);
    var html = '';
    if (d.ai_diagnosis && d.ai_diagnosis.summary) {
      html += '<div class="card"><div class="mini-note">' + esc(d.ai_diagnosis.summary) + '</div></div>';
    }
    if (!list.length) {
      html += '<div class="card">' + emptyStateHtml('本次诊断未返回「客群」类别问题',
        isDefault() ? 'UGC 语料中未检出显著客群问题信号' : '按需求仅展示客群类别；其他类别问题不在本模块展示') + '</div>';
    } else {
      var order = { P0: 0, P1: 1, P2: 2, P3: 3 };
      list.sort(function (a, b) { return (order[a.priority] != null ? order[a.priority] : 9) - (order[b.priority] != null ? order[b.priority] : 9); });
      html += '<div class="issue-stat">客群类问题 <b>' + list.length + '</b> 项 · 排序：差评 P1 ＞ 中性 P2 ＞ 需求 P3（' +
        (isDefault() ? '基于真实 UGC 主题统计' : '实时契约返回') + '）</div>';
      html += list.map(issueCardHtml).join('');
    }
    body.innerHTML = html;
  }

  /* ---------- 09 行动建议（与客群问题一一映射） ---------- */

  function renderActions() {
    var d = D();
    var body = $('actions-body');
    if (!d) { body.innerHTML = emptyStateHtml('暂无数据'); return; }
    var html = '';
    if (isDefault()) {
      var acts = d.actions || [];
      if (!acts.length) {
        html += '<div class="card">' + emptyStateHtml('暂无行动建议', '客群问题清单为空时同步为空') + '</div>';
      } else {
        html += acts.map(function (a) {
          var prCls = a.priority === 'P1' ? 'pr-p1' : a.priority === 'P2' ? 'pr-p2' : 'pr-p3';
          return '<div class="action-card">' +
            '<div class="action-head"><span class="pr-badge ' + prCls + '">' + esc(a.priority) + '</span><b>' + esc(a.title) + '</b></div>' +
            '<div class="action-ref">对应问题：' + esc(a.issue_ref) + '</div>' +
            '<ol class="action-steps">' + (a.steps || []).map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>' +
            '<div class="action-meta"><span>预期效果：' + esc(a.expected) + '</span>' +
            '<span>周期：' + esc(a.cycle) + '</span><span>难度：' + esc(a.difficulty) + '</span></div></div>';
        }).join('');
      }
    } else {
      var list = customerProblems(d);
      var rows = [];
      list.forEach(function (p) {
        (p.suggestions || []).forEach(function (s) { rows.push({ issue: p.title, text: s, priority: p.priority }); });
      });
      html += rows.length
        ? rows.map(function (r) {
            var prCls = r.priority === 'P1' || r.priority === 'P0' ? 'pr-p1' : r.priority === 'P2' ? 'pr-p2' : 'pr-p3';
            return '<div class="action-card"><div class="action-head"><span class="pr-badge ' + prCls + '">' + esc(r.priority) + '</span><b>' + esc(r.text) + '</b></div>' +
              '<div class="action-ref">对应问题：' + esc(r.issue) + '</div></div>';
          }).join('')
        : '<div class="card">' + emptyStateHtml('实时契约未返回客群类行动建议') + '</div>';
    }
    body.innerHTML = html;
  }

  /* ---------- 10 诊断报告（5 章节 + TXT 导出） ---------- */

  function renderReport() {
    var d = D();
    var body = $('report-body');
    if (!d) { body.innerHTML = emptyStateHtml('暂无数据'); return; }
    $('report-sub').textContent = isDefault()
      ? '当前展示：默认报告（非实时调用）· 生成时间 ' + (API.state.generatedAt || '—')
      : (API.state.source === 'demo-cache'
          ? '当前展示：演示缓存（非实时调用）'
          : '当前展示：实时诊断报告（AI 工作流返回）');
    var html = '';
    if (isDefault()) {
      var rep = d.report || {};
      var four = d.four_scores || {};
      html += '<div class="report-paper">';
      html += '<div class="rp-store">' + esc(d.store.name) + ' · ' + esc(d.store.district) + '</div>';
      html += '<h3 class="rp-h">一、诊断结论摘要</h3><p class="rp-p">' + esc(rep.summary || '—') + '</p>';
      html += '<h3 class="rp-h">二、四维评分</h3><table class="data-table rp-table"><thead><tr><th>维度</th><th>得分</th></tr></thead><tbody>' +
        Object.keys(four).map(function (k) { return '<tr><td>' + esc(k) + '</td><td>' + (four[k] != null ? four[k] : '—') + '</td></tr>'; }).join('') +
        '<tr><td><b>综合健康度</b></td><td><b>' + (d.health && d.health.score != null ? d.health.score : '—') + '（' + esc(d.health && d.health.grade || '') + '）</b></td></tr></tbody></table>';
      html += '<h3 class="rp-h">三、问题诊断清单（客群维度）</h3>';
      var probs = customerProblems(d);
      html += probs.length ? '<ul class="rp-list">' + probs.map(function (p) {
        return '<li><b>[' + esc(p.priority) + '｜' + esc(p.kind || '客群') + '] ' + esc(p.title) + '</b><br><span class="rp-evi">证据：' + esc(p.evidence || '') + '</span></li>';
      }).join('') + '</ul>' : '<p class="rp-p">未识别出客群类问题。</p>';
      html += '<h3 class="rp-h">四、商业行动建议</h3>';
      var acts = d.actions || [];
      html += acts.length ? '<ul class="rp-list">' + acts.map(function (a) {
        return '<li><b>' + esc(a.title) + '</b>（' + esc(a.priority) + ' · 周期 ' + esc(a.cycle) + ' · 难度 ' + esc(a.difficulty) + '）<br>' +
          '<span class="rp-evi">' + esc((a.steps || []).join('；')) + ' → 预期：' + esc(a.expected) + '</span></li>';
      }).join('') + '</ul>' : '<p class="rp-p">—</p>';
      html += '<h3 class="rp-h">五、数据说明</h3>' + dataNotesHtml(d.data_notes);
      html += '</div>';
    } else {
      html += '<div class="report-paper">' + API.renderMarkdown(d.report_markdown || '') + '</div>';
      html += '<div class="card"><div class="card-title">数据说明</div>' + dataNotesHtml(d.data_notes) + '</div>';
    }
    body.innerHTML = html;
  }

  function dataNotesHtml(notes) {
    notes = notes || {};
    return '<ul class="kv-list data-notes">' +
      '<li><span>数据来源</span><b>' + esc((notes.sources || []).join('；') || '—') + '</b></li>' +
      '<li><span>模拟/推断标注</span><b>' + (notes.simulated ? '含模拟与推断数据（逐处标注）' : '全部为真实记录') + '</b></li>' +
      (notes.period ? '<li><span>数据期间</span><b>' + esc(notes.period) + '</b></li>' : '') +
      (notes.scoring ? '<li><span>评分口径</span><b>' + esc(notes.scoring) + '</b></li>' : '') +
      (notes.inference ? '<li><span>推断口径</span><b>' + esc(notes.inference) + '</b></li>' : '') +
      '<li><span>缺失数据</span><b>' + esc((notes.missing || []).join('；') || '无') + '</b></li></ul>';
  }

  /* ---------- 11 门店对比（默认报告数据集，双店并排对照） ---------- */

  var cmp = { a: '', b: '', touched: false };

  function renderCompare() {
    var body = $('compare-body');
    if (!body) return;
    var meta = API.state.meta;
    if (!meta || !meta.stores || !meta.stores.length) { body.innerHTML = emptyStateHtml('暂无门店清单'); return; }
    var names = meta.stores.map(function (s) { return s.name; });
    if (!cmp.touched || names.indexOf(cmp.a) < 0) cmp.a = current.store && names.indexOf(current.store) >= 0 ? current.store : names[0];
    if (!cmp.b || cmp.b === cmp.a || names.indexOf(cmp.b) < 0) {
      cmp.b = names.filter(function (n) { return n !== cmp.a; })
        .sort(function (x, y) { return scoreOf(names, meta, y) - scoreOf(names, meta, x); })[0] || '';
    }
    function scoreOf(_n, _m, name) {
      var s = _m.stores.find(function (t) { return t.name === name; });
      return s && s.district === current.district ? 1 : 0;
    }
    var opts = function (sel) {
      return names.map(function (n) {
        return '<option value="' + esc(n) + '"' + (n === sel ? ' selected' : '') + '>' + esc(n) + '</option>';
      }).join('');
    };
    body.innerHTML =
      '<div class="cmp-picker">' +
        '<div class="cmp-side"><label for="cmp-a">门店 A</label><select id="cmp-a">' + opts(cmp.a) + '</select></div>' +
        '<div class="cmp-vs">VS</div>' +
        '<div class="cmp-side"><label for="cmp-b">门店 B</label><select id="cmp-b">' + opts(cmp.b) + '</select></div>' +
      '</div>' +
      '<div id="cmp-result"></div>';
    $('cmp-a').addEventListener('change', function () { cmp.a = this.value; cmp.touched = true; renderCompareResult(); });
    $('cmp-b').addEventListener('change', function () { cmp.b = this.value; cmp.touched = true; renderCompareResult(); });
    renderCompareResult();
  }

  function renderCompareResult() {
    var box = $('cmp-result');
    if (!box) return;
    if (!cmp.a || !cmp.b || cmp.a === cmp.b) {
      box.innerHTML = '<div class="cmp-note">请选择两家不同的门店开始对照。</div>';
      return;
    }
    box.innerHTML = '<div class="cmp-note">读取两店数据…</div>';
    Promise.all([API.peekReport(cmp.a), API.peekReport(cmp.b)]).then(function (rs) {
      if (!document.body.contains(box)) return;
      box.innerHTML = compareHtml(rs[0], rs[1]);
    }).catch(function (e) {
      if (!document.body.contains(box)) return;
      box.innerHTML = '<div class="cmp-note">' + esc(e && e.message ? e.message : '数据读取失败') + '</div>';
    });
  }

  function ugcNote(r) {
    var miss = (r.data_notes && r.data_notes.missing) || [];
    for (var i = 0; i < miss.length; i++) {
      var m = miss[i];
      if (m.indexOf('UGC') < 0 && m.indexOf('评论语料') < 0) continue;
      if (m.indexOf('跨商圈') >= 0) return '跨商圈参照（非本店语料）';
      if (m.indexOf('同商圈') >= 0) return '同商圈参照（非本店语料）';
      return '参照语料（非本店）';
    }
    return '本店真实评论语料';
  }

  function compareHtml(a, b) {
    var html = '';

    /* 健康度对垒 */
    function duelSide(r) {
      var h = r.health || {}, s = r.store || {};
      return '<div class="cmp-duel-side">' +
        '<div class="cmp-store-name">' + esc(s.name || '') + '</div>' +
        '<div class="cmp-store-meta">' + esc(s.district || '') + (s.type ? ' · ' + esc(s.type) : '') + '</div>' +
        '<div class="cmp-score">' + (h.score != null ? h.score : '—') + '</div>' +
        '<div class="cmp-grade">等级 ' + esc(h.grade || '—') + (h.confidence ? '<span>置信度 ' + esc(h.confidence) + '</span>' : '') + '</div>' +
      '</div>';
    }
    html += '<div class="card"><div class="card-title">综合健康度对垒</div>' +
      '<div class="cmp-duel">' + duelSide(a) + '<div class="cmp-duel-vs">VS</div>' + duelSide(b) + '</div></div>';

    /* 四维评分分组条形 */
    var fa = a.four_scores || {}, fb = b.four_scores || {};
    var nameA = (a.store && a.store.name) || 'A', nameB = (b.store && b.store.name) || 'B';
    function bar(name, v, side) {
      var w = v == null ? 0 : Math.max(0, Math.min(100, v));
      return '<div class="cmp-bar-row"><span class="cmp-bar-name">' + esc(name) + '</span>' +
        '<span class="cmp-bar-track"><i class="cmp-bar-fill ' + side + '" style="width:' + w + '%"></i></span>' +
        '<span class="cmp-bar-val">' + (v == null ? '—' : v) + '</span></div>';
    }
    html += '<div class="card"><div class="card-title">四维评分对照</div>' +
      Object.keys(fa).map(function (k) {
        return '<div class="cmp-dim"><div class="cmp-dim-label">' + esc(k) + '</div>' +
          bar(nameA, fa[k], 'a') + bar(nameB, fb[k], 'b') + '</div>';
      }).join('') + '</div>';

    /* 核心指标对照表 */
    var ca = a.core_metrics || {}, cb = b.core_metrics || {};
    var METRICS = [
      ['月营业额', function (v) { return '¥' + Number(v).toLocaleString(); }],
      ['月净利润', function (v) { return '¥' + Number(v).toLocaleString(); }],
      ['净利率%', function (v) { return v + '%'; }],
      ['日均客流', function (v) { return Number(v).toLocaleString() + ' 人'; }],
      ['客单价', function (v) { return '¥' + v; }],
      ['复购率%', function (v) { return v + '%'; }],
      ['毛利率%', function (v) { return v + '%'; }],
      ['营收环比%', function (v) { return (v >= 0 ? '+' : '') + v + '%'; }]
    ];
    var periodA = ca['数据期间'] || '', periodB = cb['数据期间'] || '';
    var typeA = (a.store && a.store.type) || '', typeB = (b.store && b.store.type) || '';
    var cmpNotes = [];
    if (periodA && periodB && periodA !== periodB) cmpNotes.push('两店数据期间不同（' + periodA + ' vs ' + periodB + '），指标为各自最近可得月份的记录值');
    if (typeA !== typeB) cmpNotes.push('跨业态对照（' + (typeA || '—') + ' vs ' + (typeB || '—') + '），指标含义随业态不同，仅供参考');
    if (/酒店/.test(typeA + typeB)) cmpNotes.push('酒店业态口径：日均客流=间夜数、客单价=ADR');
    html += '<div class="card"><div class="card-title">核心指标对照<span class="card-tag">墨绿点 = 该项较优</span></div>' +
      '<table class="data-table cmp-table"><thead><tr><th>指标</th><th>' + esc(nameA) + (periodA ? '<br><span class="cmp-period">' + esc(periodA) + '</span>' : '') + '</th><th>' + esc(nameB) + (periodB ? '<br><span class="cmp-period">' + esc(periodB) + '</span>' : '') + '</th></tr></thead><tbody>' +
      METRICS.map(function (m) {
        var va = ca[m[0]], vb = cb[m[0]];
        var numA = typeof va === 'number', numB = typeof vb === 'number';
        var betterA = numA && numB && va > vb, betterB = numA && numB && vb > va;
        return '<tr><td>' + m[0] + '</td>' +
          '<td' + (betterA ? ' class="cmp-better"' : '') + '>' + (va != null ? m[1](va) : '—') + '</td>' +
          '<td' + (betterB ? ' class="cmp-better"' : '') + '>' + (vb != null ? m[1](vb) : '—') + '</td></tr>';
      }).join('') + '</tbody></table>' +
      (cmpNotes.length ? '<div class="mini-note">' + cmpNotes.map(esc).join('<br>') + '</div>' : '') + '</div>';

    /* 满意度对照（语料口径如实标注） */
    function satSide(r, cls) {
      var sat = ((r.ugc_feedback || {}).satisfaction) || {};
      var name = (r.store && r.store.name) || '';
      if (sat.pos == null) {
        return '<div class="cmp-sat-side"><div class="cmp-sat-name">' + esc(name) + '</div>' +
          '<div class="cmp-note">满意度缺数据</div></div>';
      }
      return '<div class="cmp-sat-side">' +
        '<div class="cmp-sat-name">' + esc(name) + '</div>' +
        '<div class="cmp-sat-bar">' +
          '<i style="width:' + sat.pos + '%;background:#166534"></i>' +
          '<i style="width:' + sat.neu + '%;background:#c9cfd6"></i>' +
          '<i style="width:' + sat.neg + '%;background:#c03d34"></i></div>' +
        '<div class="cmp-sat-nums"><b style="color:#166534">好评 ' + sat.pos + '%</b><span>中立 ' + sat.neu + '%</span><b style="color:#c03d34">差评 ' + sat.neg + '%</b></div>' +
        '<div class="cmp-sat-n">n=' + sat.total + ' 条 · ' + esc(ugcNote(r)) + '</div></div>';
    }
    var noteA = ugcNote(a), noteB = ugcNote(b);
    var satA = ((a.ugc_feedback || {}).satisfaction) || {}, satB = ((b.ugc_feedback || {}).satisfaction) || {};
    var sameRef = noteA !== '本店真实评论语料' && noteB !== '本店真实评论语料' &&
      satA.total != null && satA.total === satB.total && satA.pos === satB.pos && satA.neu === satB.neu && satA.neg === satB.neg;
    var satNote;
    if (sameRef) {
      satNote = '两店均无本店语料，当前共用同一份商圈参照语料（n=' + satA.total + '），满意度数值相同，本项对比不适用——参照语料反映商圈整体口碑，非任一店的直接评价。';
    } else if (noteA !== noteB || noteA !== '本店真实评论语料') {
      satNote = '两店语料口径已逐店标注；参照语料反映商圈整体口碑，非该店直接评价，对比时请留意。';
    }
    html += '<div class="card"><div class="card-title">满意度对照<span class="card-tag">真实 UGC 确定性统计</span></div>' +
      '<div class="cmp-sat">' + satSide(a) + satSide(b) + '</div>' +
      (satNote ? '<div class="mini-note">' + esc(satNote) + '</div>' : '') +
      '</div>';

    return html;
  }

  function exportReportTxt() {
    var d = D();
    if (!d) { toast('暂无报告可导出', 'err'); return; }
    var lines = [];
    var storeName = d.store ? d.store.name : '门店';
    lines.push('智慧门店运营洞察平台 · 经营诊断报告');
    lines.push('门店：' + storeName + '（' + (d.store ? d.store.district : '') + '）');
    lines.push('报告类型：' + (isDefault() ? '默认报告（非实时调用）' : '实时诊断（AI 工作流）'));
    lines.push('生成时间：' + new Date().toLocaleString('zh-CN'));
    lines.push('='.repeat(46));
    if (isDefault()) {
      var rep = d.report || {};
      var four = d.four_scores || {};
      lines.push('', '一、诊断结论摘要', '', rep.summary || '—', '', '二、四维评分', '');
      Object.keys(four).forEach(function (k) { lines.push('  ' + k + '：' + (four[k] != null ? four[k] : '—')); });
      lines.push('  综合健康度：' + (d.health && d.health.score != null ? d.health.score : '—') + '（' + (d.health && d.health.grade || '') + '）');
      lines.push('', '三、问题诊断清单（客群维度）', '');
      var probs = customerProblems(d);
      if (probs.length) probs.forEach(function (p, i) {
        lines.push('  ' + (i + 1) + '. [' + p.priority + '｜' + (p.kind || '客群') + '] ' + p.title);
        if (p.evidence) lines.push('     证据：' + p.evidence);
        if (p.impact) lines.push('     影响：' + p.impact);
      }); else lines.push('  未识别出客群类问题。');
      lines.push('', '四、商业行动建议', '');
      (d.actions || []).forEach(function (a, i) {
        lines.push('  ' + (i + 1) + '. ' + a.title + '（' + a.priority + ' · 周期 ' + a.cycle + ' · 难度 ' + a.difficulty + '）');
        (a.steps || []).forEach(function (s, j) { lines.push('     措施' + (j + 1) + '：' + s); });
        lines.push('     预期效果：' + a.expected);
      });
      lines.push('', '五、数据说明', '');
      var n = d.data_notes || {};
      lines.push('  数据来源：' + (n.sources || []).join('；'));
      lines.push('  模拟/推断标注：' + (n.simulated ? '含模拟与推断数据（逐处标注）' : '全部为真实记录'));
      lines.push('  缺失数据：' + (n.missing || []).join('；'));
    } else {
      var md = (d.report_markdown || '').replace(/\*\*/g, '').replace(/^#{1,4}\s+/gm, '');
      lines.push(md);
      var n2 = d.data_notes || {};
      lines.push('', '— 数据说明 —');
      lines.push('数据来源：' + (n2.sources || []).join('；'));
      lines.push('缺失数据：' + (n2.missing || []).join('；'));
    }
    var fname = '智慧门店诊断报告_' + storeName.replace(/[\\/:*?"<>|\s]+/g, '_') + '_' +
      new Date().toISOString().slice(0, 10) + '.txt';
    downloadText(fname, lines.join('\n'));
    toast('诊断报告已导出（TXT，保存至浏览器下载目录）', 'ok');
  }

  /* ================= 通用小组件 ================= */

  function renderTable(el, columns, rows) {
    if (!rows || !rows.length) {
      el.innerHTML = '<tbody><tr><td class="empty-cell">缺数据（知识库未覆盖）</td></tr></tbody>';
      return;
    }
    var thead = '<thead><tr>' + columns.map(function (c) { return '<th>' + c.label + '</th>'; }).join('') + '</tr></thead>';
    var tbody = '<tbody>' + rows.map(function (r) {
      return '<tr>' + columns.map(function (c) {
        var v = typeof c.value === 'function' ? c.value(r) : r[c.key];
        var cls = typeof c.cls === 'function' ? c.cls(r) : (c.cls || '');
        return '<td class="' + cls + '">' + v + '</td>';
      }).join('') + '</tr>';
    }).join('') + '</tbody>';
    el.innerHTML = thead + tbody;
  }

  function emptyStateHtml(text, hint) {
    return '<div class="empty-state">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" width="26" height="26">' +
      '<path d="M4 7 6 3h12l2 4M4 7h16v13H4V7z"/><path d="M9 12h6"/></svg>' +
      '<div class="empty-title">' + esc(text) + '</div>' +
      (hint ? '<div class="empty-hint">' + esc(hint) + '</div>' : '') + '</div>';
  }

  function toast(msg, type) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast show ' + (type || '');
    setTimeout(function () { t.className = 'toast'; }, 3200);
  }

  function downloadText(filename, text) {
    var blob = new Blob(['﻿' + text], { type: 'text/plain;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 400);
  }

  /* ================= SVG 图表引擎（复用原版零依赖实现） ================= */

  function smoothPath(pts) {
    if (pts.length < 2) return '';
    var d = 'M ' + pts[0].x.toFixed(2) + ' ' + pts[0].y.toFixed(2);
    for (var i = 0; i < pts.length - 1; i++) {
      var p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
      var c1x = p1.x + (p2.x - p0.x) / 6, c1y = p1.y + (p2.y - p0.y) / 6;
      var c2x = p2.x - (p3.x - p1.x) / 6, c2y = p2.y - (p3.y - p1.y) / 6;
      d += ' C ' + c1x.toFixed(2) + ' ' + c1y.toFixed(2) + ' ' + c2x.toFixed(2) + ' ' + c2y.toFixed(2) + ' ' + p2.x.toFixed(2) + ' ' + p2.y.toFixed(2);
    }
    return d;
  }

  function createChartFrame(container, opts) {
    var w = container.clientWidth || 600;
    var h = opts.height || 220;
    var pad = { l: 46, r: 10, t: 12, b: 26 };
    var innerW = w - pad.l - pad.r, innerH = h - pad.t - pad.b;
    var yMax = opts.yAxis[opts.yAxis.length - 1], yMin = opts.yAxis[0], n = opts.count;
    var x = function (i) { return pad.l + (n === 1 ? 0 : (i / (n - 1)) * innerW); };
    var y = function (v) { return pad.t + innerH - ((v - yMin) / (yMax - yMin || 1)) * innerH; };
    var grid = '';
    opts.yAxis.forEach(function (v) {
      var yy = y(v);
      grid += '<line class="grid-line" x1="' + pad.l + '" y1="' + yy + '" x2="' + (w - pad.r) + '" y2="' + yy + '"/>';
      grid += '<text class="axis-text" x="' + (pad.l - 8) + '" y="' + (yy + 3.5) + '" text-anchor="end">' + (opts.yFormat ? opts.yFormat(v) : v) + '</text>';
    });
    opts.xLabels.forEach(function (xl) {
      grid += '<text class="axis-text" x="' + x(xl.index) + '" y="' + (h - 8) + '" text-anchor="middle">' + xl.text + '</text>';
    });
    return { w: w, h: h, pad: pad, x: x, y: y, grid: grid };
  }

  function monthXLabels(trend, step) {
    return trend.map(function (t, i) { return { index: i, text: String(t.month).slice(2) }; })
      .filter(function (_, i) { return i % (step || 2) === 0; });
  }

  function niceYAxis(max, ticks) {
    var raw = max / (ticks || 3);
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var norm = raw / mag;
    var step = norm >= 5 ? 5 * mag : norm >= 2 ? 2 * mag : mag;
    var top = Math.ceil(max / step) * step;
    var arr = [];
    for (var v = 0; v <= top + 1e-9; v += step) arr.push(Math.round(v * 100) / 100);
    return arr;
  }

  function drawAreaChart(container, data) {
    if (!container) return;
    var f = createChartFrame(container, {
      height: 220, yAxis: data.yAxis, count: data.values.length,
      xLabels: data.xLabels, yFormat: data.yFormat
    });
    var pts = data.values.map(function (v, i) { return { x: f.x(i), y: f.y(v) }; });
    var line = smoothPath(pts);
    var baseline = f.y(data.yAxis[0]);
    var area = line + ' L ' + pts[pts.length - 1].x.toFixed(2) + ' ' + baseline.toFixed(2) +
      ' L ' + pts[0].x.toFixed(2) + ' ' + baseline.toFixed(2) + ' Z';
    var crosshair = data.hoverLabels && data.hoverLabels.length === data.values.length;
    container.innerHTML = '<svg viewBox="0 0 ' + f.w + ' ' + f.h + '" width="' + f.w + '" height="' + f.h + '">' +
      '<defs><linearGradient id="revFill" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="#166534" stop-opacity="0.22"/>' +
      '<stop offset="100%" stop-color="#166534" stop-opacity="0.02"/></linearGradient></defs>' +
      f.grid + '<path d="' + area + '" fill="url(#revFill)"/>' +
      '<path d="' + line + '" fill="none" stroke="#166534" stroke-width="2.2" stroke-linecap="round"/>' +
      (crosshair ?
        '<line class="chart-cross" y1="' + f.pad.t + '" y2="' + (f.h - f.pad.b) + '" visibility="hidden"/>' +
        '<circle class="chart-dot" r="3.5" visibility="hidden"/>' +
        '<rect class="chart-capture" x="' + f.pad.l + '" y="' + f.pad.t + '" width="' + (f.w - f.pad.l - f.pad.r) +
          '" height="' + (f.h - f.pad.t - f.pad.b) + '" fill="transparent"/>' : '') +
      '</svg>' +
      (crosshair ? '<div class="chart-tip" hidden></div>' : '');
    if (crosshair) attachCrosshair(container, f, data);
  }

  /* 趋势图十字读数：HTML 悬浮牌（禁用 title 属性——沙箱 chromium 渲染崩溃教训） */
  function attachCrosshair(container, f, data) {
    var svg = container.querySelector('svg');
    var cross = svg.querySelector('.chart-cross');
    var dot = svg.querySelector('.chart-dot');
    var tip = container.querySelector('.chart-tip');
    var n = data.values.length;
    svg.addEventListener('mousemove', function (evt) {
      var rect = svg.getBoundingClientRect();
      var span = (f.w - f.pad.l - f.pad.r) / Math.max(n - 1, 1);
      var idx = Math.round((evt.clientX - rect.left - f.pad.l) / span);
      idx = Math.max(0, Math.min(n - 1, idx));
      var cx = f.x(idx), cy = f.y(data.values[idx]);
      cross.setAttribute('x1', cx.toFixed(1)); cross.setAttribute('x2', cx.toFixed(1));
      cross.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', cx.toFixed(1)); dot.setAttribute('cy', cy.toFixed(1));
      dot.setAttribute('visibility', 'visible');
      var val = data.yFormat ? data.yFormat(data.values[idx]) : data.values[idx];
      tip.textContent = data.hoverLabels[idx] + ' · ' + val;
      tip.hidden = false;
      tip.style.left = Math.max(44, Math.min(f.w - 44, cx)) + 'px';
      tip.style.top = Math.max(cy - 12, 30) + 'px';
    });
    svg.addEventListener('mouseleave', function () {
      cross.setAttribute('visibility', 'hidden');
      dot.setAttribute('visibility', 'hidden');
      tip.hidden = true;
    });
  }

  function drawDonut(container, segments) {
    if (!container) return;
    var size = 148, r = 56, c = 2 * Math.PI * r, cx = size / 2, cy = size / 2;
    var total = segments.reduce(function (s, d) { return s + d.value; }, 0);
    if (!total) { container.innerHTML = emptyStateHtml('缺数据'); return; }
    var offset = 0;
    container.innerHTML = '<svg viewBox="0 0 ' + size + ' ' + size + '" width="' + size + '" height="' + size + '">' +
      segments.map(function (d) {
        var frac = d.value / total;
        var len = Math.max(frac - 0.008, 0) * c;
        var seg = '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="' + d.color + '" stroke-width="22" ' +
          'stroke-dasharray="' + len.toFixed(2) + ' ' + (c - len).toFixed(2) + '" stroke-dashoffset="' + (-offset * c).toFixed(2) + '" ' +
          'transform="rotate(-90 ' + cx + ' ' + cy + ')"/>';
        offset += frac;
        return seg;
      }).join('') + '</svg>';
  }

  function donutLegend(segments) {
    return segments.map(function (d) {
      return '<li><i class="lg-dot" style="background:' + d.color + '"></i>' +
        '<span class="lg-label">' + esc(d.label) + '</span>' +
        '<span class="lg-value">' + esc(d.text || (d.value + '%')) + '</span></li>';
    }).join('');
  }

  /* ================= 已下线的视图加载器（需求4/6：代码注释保留，数据接入后恢复） =================
  var COMMENTED_LOADERS = {
    'view-inventory': function () { 原库存分析渲染：product_price.slow_products / 库存周转卡片 },
    'view-marketing': function () { 原营销分析渲染：营销日历 / 活动效果 / 渠道 ROI },
    'view-priority':  function () { 原问题优化排序渲染：ai_diagnosis.priority_suggestions 四象限 }
  };
  ================= 下线结束 ================= */

})();
