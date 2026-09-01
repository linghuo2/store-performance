'use strict';

/* ----------------------------- 全局状态 ----------------------------- */
let me = null;
const cache = { stores: [], users: [], records: [], summary: null, regions: [], categories: [] };

const $ = sel => document.querySelector(sel);
const app = () => document.getElementById('app');
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = n => '¥' + Number(n || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const today = () => new Date().toISOString().slice(0, 10);
const curMonth = () => new Date().toISOString().slice(0, 7);
const roleName = r => ({ boss: '老板', regional: '区域经理', manager: '店长', clerk: '店员' }[r] || r);

/* 全局错误兜底：任何未捕获错误都显示到页面，避免“整页白屏”无信息 */
function showFatal(msg) {
  const box = `<div style="max-width:680px;margin:48px auto;padding:22px;background:#fff;border:1px solid #f0c2c2;border-radius:12px;color:#c0392b;font-size:14px;line-height:1.8;">
    <div style="font-weight:700;margin-bottom:8px;">页面加载出错</div>
    <div>${esc(msg || '未知错误')}</div>
    <div style="margin-top:12px;color:#6b7686;font-size:13px;">若是通过微信打开本页，请点右上角「···」→「在浏览器打开」（微信会拦截 GitHub 的脚本资源，导致白屏）。</div>
  </div>`;
  const el = document.getElementById('app');
  if (el) el.innerHTML = box; else document.body.insertAdjacentHTML('beforeend', box);
}
window.addEventListener('error', e => { showFatal((e.message || '脚本错误') + (e.filename ? ' @ ' + e.filename.split('/').pop() + ':' + e.lineno : '')); });
window.addEventListener('unhandledrejection', e => { showFatal('未处理的异步错误：' + ((e.reason && e.reason.message) || e.reason || '未知')); });

/* 访问方式防护：通过 file:// 双击本地 HTML 文件会导致二维码/数据异常，给出醒目提示并阻止进入 */
function checkAccessMode() {
  if (location.protocol !== 'file:') return false;
  const box = `<div style="max-width:680px;margin:48px auto;padding:22px;background:#fff7ed;border:1px solid #fed7aa;border-radius:12px;color:#b54708;font-size:14px;line-height:1.9;">
    <div style="font-weight:700;margin-bottom:8px;">⚠️ 访问方式不对，请勿直接双击本地 HTML 文件</div>
    <div>你现在是通过电脑上的文件（<code>file:///...</code>）打开本系统的。这样会导致：① 生成的二维码员工手机扫不开（二维码里写的是你电脑上的文件路径）；② 看不到之前登记的数据（数据按「网站地址 + 门店码」隔离存储，与网站互不通用）。</div>
    <div style="margin-top:10px;">正确做法：用浏览器打开部署好的网站地址 <b>https://linghuo2.github.io/store-performance/?room=shop_mendian</b>（把 shop_mendian 换成你当初用的门店码），在那里登录、使用、再点「生成二维码」。</div>
  </div>`;
  const el = document.getElementById('app');
  if (el) el.innerHTML = box; else document.body.insertAdjacentHTML('beforeend', box);
  return true;
}

function recomputeCache() {
  const u = me;
  if (!u) {
    cache.stores = []; cache.users = []; cache.records = [];
    cache.summary = null; cache.regions = [];
    cache.categories = (DB.getDB() && DB.getDB().categories) || [];
    return;
  }
  cache.categories = DB.getDB().categories;
  cache.regions = DB.accessibleRegions(u);
  cache.stores = DB.accessibleStores(u);
  cache.users = DB.filterUsers(DB.getDB().users, u).map(DB.publicUser);
  cache.members = DB.getMembers(u);
  cache.records = DB.filterRecords(DB.getDB().records, u);
  cache.summary = DB.computeSummary(u, (timeRange.from || timeRange.to || timeRange.month) ? timeRange : null);
}

/* 业务大类 / 小类：从本地数据动态加载（老板可后台维护） */
function catOptionsHTML(selected) {
  const list = (cache.categories || []).map(c => c.name);
  if (selected && !list.includes(selected)) list.unshift(selected);
  return list.map(c => `<option${c === selected ? ' selected' : ''}>${esc(c)}</option>`).join('');
}
function subNameOf(s) { return (typeof s === 'object' && s && s.name) ? s.name : String(s || ''); }
function subDatalistHTML() {
  const set = new Set();
  (cache.categories || []).forEach(c => (c.subs || []).forEach(s => set.add(subNameOf(s))));
  const opts = Array.from(set).filter(Boolean).map(n => `<option value="${esc(n)}"></option>`).join('');
  return `<datalist id="subList">${opts}</datalist>`;
}
function payDatalistHTML() {
  const opts = PAY_METHODS.map(p => `<option value="${esc(p)}"></option>`).join('');
  return `<datalist id="payList">${opts}</datalist>`;
}

/* 经营总览时间筛选（全局） */
const timeRange = { mode: 'all', from: '', to: '', month: '' };
function rangeQuery() {
  const p = [];
  if (timeRange.from) p.push('from=' + encodeURIComponent(timeRange.from));
  if (timeRange.to) p.push('to=' + encodeURIComponent(timeRange.to));
  if (timeRange.month) p.push('month=' + encodeURIComponent(timeRange.month));
  return p.length ? '?' + p.join('&') : '';
}
function rangeFilteredRecords() {
  const r = timeRange;
  if (!r.from && !r.to && !r.month) return cache.records;
  return cache.records.filter(x => {
    if (r.from && (x.date || '') < r.from) return false;
    if (r.to && (x.date || '') > r.to) return false;
    if (r.month && (x.date || '').slice(0, 7) !== r.month) return false;
    return true;
  });
}

function toast(msg, isErr) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(t._t);
  t._t = setTimeout(() => { t.className = 'toast' + (isErr ? ' err' : ''); }, 2200);
}

/* ----------------------------- 实时同步状态 ----------------------------- */
function updateLive() {
  const el = $('#liveDot');
  if (el) {
    const ok = DB.isConnected();
    el.parentElement.classList.toggle('off', !ok);
    el.parentElement.querySelector('.txt').textContent = ok ? '实时已连接' : '连接中…';
  }
}

/* ----------------------------- 登录 ----------------------------- */
async function doLogin(username, password) {
  timeRange.mode = 'all'; timeRange.from = ''; timeRange.to = ''; timeRange.month = '';
  const r = await DB.login(username, password);
  if (r.ok) { me = r.user; recomputeCache(); render(); }
  else toast(r.error || '登录失败', true);
}
function doLogout() {
  DB.logout(); me = null; recomputeCache(); renderLogin();
}

/* ----------------------------- 修改密码弹窗 ----------------------------- */
function openPasswordModal() {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.id = 'pwModal';
  mask.innerHTML = `
    <div class="modal">
      <div class="modal-title">修改登录密码</div>
      <div class="field"><label>当前密码</label><input id="pwCur" type="password" placeholder="请输入当前密码" autocomplete="current-password" /></div>
      <div class="field"><label>新密码（至少 6 位）</label><input id="pwNew" type="password" placeholder="请输入新密码" autocomplete="new-password" /></div>
      <div class="field"><label>确认新密码</label><input id="pwNew2" type="password" placeholder="再次输入新密码" autocomplete="new-password" /></div>
      <div class="modal-err" id="pwErr"></div>
      <div class="modal-actions">
        <button class="btn ghost" id="pwCancel">取消</button>
        <button class="btn" id="pwSubmit">确认修改</button>
      </div>
    </div>`;
  document.body.appendChild(mask);
  const close = () => mask.remove();
  mask.addEventListener('click', e => { if (e.target === mask) close(); });
  $('#pwCancel').onclick = close;
  $('#pwSubmit').onclick = async () => {
    const cur = $('#pwCur').value, nw = $('#pwNew').value, nw2 = $('#pwNew2').value;
    const err = $('#pwErr');
    err.textContent = '';
    if (!cur) return err.textContent = '请输入当前密码';
    if (nw.length < 6) return err.textContent = '新密码至少 6 位';
    if (nw !== nw2) return err.textContent = '两次输入的新密码不一致';
    const r = await DB.changePassword(cur, nw);
    if (r.ok) { close(); toast('密码已修改，下次登录请使用新密码'); }
    else err.textContent = r.error || '修改失败';
  };
  setTimeout(() => { const el = $('#pwCur'); if (el) el.focus(); }, 50);
}
function renderLogin() {
  app().innerHTML = `
  <div class="login-wrap">
    <div class="login-card">
      <h1>门店业绩<span>工作台</span></h1>
      <div class="sub">多角色 · 实时同步 · 分权管理 · 区域层级</div>
      <label>账号</label>
      <input id="lgUser" placeholder="请输入账号" autocomplete="username" />
      <label>密码</label>
      <input id="lgPass" type="password" placeholder="请输入密码" autocomplete="current-password" />
      <button class="btn" id="lgBtn">登 录</button>
      <div class="accounts">
        <div style="margin-bottom:6px;color:var(--ink);font-weight:600;">演示账号（点击自动填充）</div>
        <div class="row" data-u="boss" data-p="boss123"><b>老板</b> · boss / boss123（看全部 + 管门店/区域）</div>
        <div class="row" data-u="reg1" data-p="reg123"><b>区域经理</b> · reg1 / reg123（华东大区范围）</div>
        <div class="row" data-u="mgrA" data-p="mgr123"><b>店长</b> · mgrA / mgr123（仅本门店 + 管店员）</div>
        <div class="row" data-u="clerkA1" data-p="clerk123"><b>店员</b> · clerkA1 / clerk123（仅本人业绩/提成）</div>
      </div>
      <div class="muted" style="margin-top:12px;font-size:12px;line-height:1.7;">
        本系统按「门店空间」隔离：请用老板分享的<b>带门店码</b>链接进入（地址栏含 <code>?room=</code>）。同一空间内的老板/店长/店员数据实时同步。
      </div>
    </div>
  </div>`;
  $('#lgBtn').onclick = () => doLogin($('#lgUser').value.trim(), $('#lgPass').value);
  $('#lgPass').addEventListener('keydown', e => { if (e.key === 'Enter') $('#lgBtn').click(); });
  document.querySelectorAll('.accounts .row').forEach(r => {
    r.onclick = () => { $('#lgUser').value = r.dataset.u; $('#lgPass').value = r.dataset.p; $('#lgBtn').click(); };
  });
}

/* ----------------------------- 主渲染 ----------------------------- */
function render() {
  if (!me) { renderLogin(); return; }
  const top = `
  <div class="topbar">
    <div class="logo">门店业绩<span>工作台</span></div>
    <span class="pill ${me.role}">${roleName(me.role)}</span>
    <div class="spacer"></div>
    <div class="live" id="liveDot"><span class="dot"></span><span class="txt">实时已连接</span></div>
    <span class="user-name">${esc(me.name)}</span>
    <button class="btn ghost sm" id="pwBtn">修改密码</button>
    <button class="btn ghost sm" id="logoutBtn">退出</button>
  </div>`;
  $('#app').innerHTML = top + `<div class="container" id="main"></div>` + subDatalistHTML() + payDatalistHTML();
  $('#logoutBtn').onclick = doLogout;
  $('#pwBtn').onclick = openPasswordModal;
  updateLive();
  if (me.role === 'boss' || me.role === 'regional') renderBoss();
  else if (me.role === 'manager') renderManager();
  else renderClerk();
}

/* --------------------- 导出月报工具条 --------------------- */
function exportBarHTML() {
  return `<div class="export-bar">
    <span class="exp-label">📊 月度 Excel 月报</span>
    <input type="month" id="expMonth" value="${curMonth()}" />
    <button class="btn sm" data-action="export-xlsx">导出当前月份</button>
  </div>`;
}

/* --------------------- 经营总览时间筛选条 --------------------- */
function timeBarHTML() {
  const presets = [['all', '全部'], ['thisMonth', '本月'], ['lastMonth', '上月'], ['last3', '近3个月'], ['custom', '自定义区间']];
  const isC = timeRange.mode === 'custom';
  return `<div class="time-bar">
    <span class="tb-label">时间筛选</span>
    <select id="rangeMode">${presets.map(([v, t]) => `<option value="${v}" ${timeRange.mode === v ? 'selected' : ''}>${t}</option>`).join('')}</select>
    <input type="date" id="rangeFrom" value="${timeRange.from}" style="display:${isC ? '' : 'none'}" />
    <span id="rangeSep" style="display:${isC ? '' : 'none'}">至</span>
    <input type="date" id="rangeTo" value="${timeRange.to}" style="display:${isC ? '' : 'none'}" />
    <button class="btn sm" id="rangeApply" style="display:${isC ? '' : 'none'}">应用</button>
  </div>`;
}

/* --------------------- 员工访问地址（分享卡片） --------------------- */
function copyText(t) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(t).catch(() => fallbackCopy(t));
  } else fallbackCopy(t);
}
function fallbackCopy(t) {
  const ta = document.createElement('textarea');
  ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); } catch (e) {}
  ta.remove();
}
function shareUrlVersioned() {
  const base = location.origin + location.pathname + '?room=' + DB.getRoom();
  const v = window.__DEPLOY_VER;
  return v ? base + '&v=' + v : base;
}
function shareLinkHTML() {
  const url = shareUrlVersioned();
  const ver = window.__DEPLOY_VER ? ('v' + window.__DEPLOY_VER) : '未带版本号';
  return `<div class="share-card">
    <span class="sc-icon">🔗</span>
    <div class="sc-body">
      <div class="sc-title">员工访问地址（门店空间）</div>
      <div class="sc-sub">把下面<b>带门店码</b>的地址发给门店员工，用各自账号登录即可登记业绩（无需安装、无需域名）。点「生成二维码」可得到<b>当前最新版本</b>的二维码，员工扫码即是最新版。</div>
      <code id="shareUrl" class="sc-url">${url}</code>
      <div class="sc-ver">当前部署版本：${ver}</div>
    </div>
    <div class="sc-btns">
      <button class="btn sm" data-action="copy-link">复制链接</button>
      <button class="btn sm ghost" data-action="show-share-qr">生成二维码</button>
    </div>
  </div>`;
}
function upgradeUrlToVersioned() {
  // 页面一旦加载到「带部署版本号」的新版，就把地址栏升级成 ?v=<版本号> 形式：
  // 之后无论是从地址栏复制、还是扫本页二维码，拿到的都是最新版本链接，旧二维码自然失效。
  // 注意：这只对“已加载到新版页面”的会话生效；首次进入新版仍需用部署脚本打印的带版本号链接引导一次。
  const ver = window.__DEPLOY_VER;
  if (!ver) return;
  const params = new URLSearchParams(location.search);
  if (params.get('v') === ver) return; // 已经是版本化地址，无需处理
  if (!params.get('room')) {
    const r = (DB && DB.getRoom) ? DB.getRoom() : '';
    if (r) params.set('room', r);
  }
  params.set('v', ver);
  const newUrl = location.pathname + '?' + params.toString();
  try { history.replaceState(null, '', newUrl); } catch (e) {}
}
function showUpdateBanner(newVer) {
  let bar = document.getElementById('updateBanner');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'updateBanner';
    bar.className = 'update-banner';
    bar.innerHTML = '<span class="ub-text"></span><button class="ub-btn" id="ubEnter">重新进入</button>';
    document.body.appendChild(bar);
    bar.querySelector('#ubEnter').onclick = () => {
      const params = new URLSearchParams(location.search);
      const room = params.get('room') || ((DB && DB.getRoom) ? DB.getRoom() : '') || '';
      location.href = location.origin + location.pathname + '?room=' + encodeURIComponent(room) + '&v=' + (bar.dataset.ver || '');
    };
  }
  bar.dataset.ver = newVer;
  const typing = document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
  const modalOpen = !!document.querySelector('.modal-mask');
  const txt = bar.querySelector('.ub-text');
  if (typing || modalOpen) {
    // 用户正在操作或弹窗打开：不自动跳，避免丢失未保存内容，改为手动按钮
    txt.textContent = '发现新版本，建议点「重新进入」以体验最新功能';
    bar.style.display = 'flex';
    return;
  }
  // 空闲态：静默自动刷新到最新版（CDN 必是未命中 -> 必加载最新页面）
  txt.textContent = '发现新版本，正在自动更新到最新版…';
  bar.style.display = 'flex';
  if (bar.dataset.timer) return;
  bar.dataset.timer = '1';
  setTimeout(() => {
    const params = new URLSearchParams(location.search);
    const room = params.get('room') || ((DB && DB.getRoom) ? DB.getRoom() : '') || '';
    location.href = location.origin + location.pathname + '?room=' + encodeURIComponent(room) + '&v=' + newVer;
  }, 1200);
}
function hideUpdateBanner() { const b = document.getElementById('updateBanner'); if (b) b.style.display = 'none'; }
async function checkNewVersion() {
  const cur = window.__DEPLOY_VER;
  if (!cur) return;
  try {
    const res = await fetch('version.json?_=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return;
    const j = await res.json();
    if (j && j.ver && j.ver !== cur) showUpdateBanner(j.ver);
    else hideUpdateBanner();
  } catch (e) {}
}
async function ensureQR() {
  if (typeof qrcode !== 'undefined') return true;
  return await new Promise(resolve => {
    const s = document.createElement('script');
    s.src = 'vendor/qrcode.js';
    s.onload = () => resolve(typeof qrcode !== 'undefined');
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });
}
async function showShareQR() {
  const url = shareUrlVersioned();
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal">
      <div class="modal-title">当前分享二维码（最新版）</div>
      <div class="qr-wrap" id="qrWrap"><div class="qr-loading">二维码生成中…</div></div>
      <div class="sc-sub" style="margin-top:10px;">员工扫描下方二维码即可进入<b>当前最新版本</b>。若手机扫不出，可直接点「复制链接」发到群里，员工点链接即可打开（更稳妥）。</div>
      <code class="sc-url" style="display:block;word-break:break-all;white-space:normal;">${url}</code>
      <div class="modal-actions">
        <button class="btn ghost" id="qrClose">关闭</button>
        <button class="btn" id="qrCopy">复制链接</button>
      </div>
    </div>`;
  document.body.appendChild(mask);
  const close = () => mask.remove();
  mask.addEventListener('click', e => { if (e.target === mask) close(); });
  $('#qrClose').onclick = close;
  $('#qrCopy').onclick = () => { copyText(url); toast('链接已复制'); };
  const ok = await ensureQR();
  const wrap = $('#qrWrap');
  if (!ok) { wrap.innerHTML = '<div class="qr-loading">二维码组件加载失败，请复制上方链接发给员工。</div>'; return; }
  try {
    const qr = qrcode(0, 'H');
    qr.addData(url);
    qr.make();
    // 边距用 4 个模块（标准值）；之前用 16 导致图案被压得太小、手机扫屏幕易扫歪
    wrap.innerHTML = '<img class="qr-img" src="' + qr.createDataURL(8, 4) + '" alt="分享二维码" />';
  } catch (e) {
    wrap.innerHTML = '<div class="qr-loading">二维码生成失败，请复制上方链接。</div>';
  }
}
function computeRangeFromMode(mode) {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  const ymd = (yy, mm, dd) => `${yy}-${String(mm + 1).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  const monthBounds = (yy, mm) => { const first = ymd(yy, mm, 1); const last = new Date(yy, mm + 1, 0); return [first, ymd(yy, mm, last.getDate())]; };
  if (mode === 'thisMonth') { const [a, b] = monthBounds(y, m); timeRange.from = a; timeRange.to = b; timeRange.month = ''; }
  else if (mode === 'lastMonth') { const [a, b] = monthBounds(y, m - 1); timeRange.from = a; timeRange.to = b; timeRange.month = ''; }
  else if (mode === 'last3') { const [a] = monthBounds(y, m - 2); const [, b] = monthBounds(y, m); timeRange.from = a; timeRange.to = b; timeRange.month = ''; }
  else { timeRange.from = ''; timeRange.to = ''; timeRange.month = ''; }
}
function applyRange() { recomputeCache(); render(); }
function onRangeModeChange(e) {
  timeRange.mode = e.target.value;
  const show = timeRange.mode === 'custom';
  ['#rangeFrom', '#rangeSep', '#rangeTo', '#rangeApply'].forEach(s => { const el = $(s); if (el) el.style.display = show ? '' : 'none'; });
  if (show) return;
  computeRangeFromMode(timeRange.mode);
  applyRange();
}
function applyCustomRange() {
  timeRange.from = ($('#rangeFrom') && $('#rangeFrom').value) || '';
  timeRange.to = ($('#rangeTo') && $('#rangeTo').value) || '';
  timeRange.month = '';
  applyRange();
}
async function exportXLSX(month) {
  try {
    const recs = month ? cache.records.filter(r => (r.date || '').slice(0, 7) === month) : cache.records.slice();
    DB.exportXLSX(recs, me, month);
    toast('已导出 业绩月报_' + (month || '全部') + '.xlsx');
  } catch (e) { toast('导出失败', true); }
}
async function exportMembersXLSX() {
  try {
    const members = cache.members || [];
    if (!members.length) return toast('暂无会员可导出', true);
    DB.exportMembers(members, cache.stores, me);
    const tag = me.role === 'manager' ? (me.storeName || '本店') : '全部';
    toast('已导出 会员信息_' + tag + '.xlsx');
  } catch (e) { toast('导出失败', true); }
}

/* --------------------- 支付方式 --------------------- */
const PAY_METHODS = ['美团', '大众', '微信', '支付宝', '现金', '会员'];

/* --------------------- 通用：业绩登记表 --------------------- */
function recordsTable(records) {
  if (!records.length) return `<div class="empty">暂无业绩记录</div>`;
  const showStore = (me.role === 'boss' || me.role === 'regional');
  const showClerk = (me.role !== 'clerk');
  const rows = [...records].sort((a, b) => (b.date + b.id).localeCompare(a.date + a.id)).map(r => `
    <tr>
      <td>${esc(r.date)}</td>
      ${showStore ? `<td>${esc(r.storeName)}</td>` : ''}
      ${showClerk ? `<td>${esc(r.clerkName)}</td>` : ''}
      <td>${esc(r.category || '—')}</td>
      <td>${esc(r.subCategory || '—')}</td>
      <td>${esc(r.payMethod || '—')}</td>
      <td class="c-amount">${money(r.amount)}</td>
      <td class="c-comm">${money(r.commission)}</td>
      <td class="muted">${esc(r.note || '')}</td>
      <td>
        <button class="btn danger sm" data-action="del-record" data-id="${r.id}">删除</button>
      </td>
    </tr>`).join('');
  return `<div class="tbl-scroll"><table>
    <thead><tr>
      <th>日期</th>
      ${showStore ? '<th>门店</th>' : ''}
      ${showClerk ? '<th>店员</th>' : ''}
      <th>大类</th><th>小类</th><th>支付方式</th>
      <th>业绩金额</th><th>提成</th><th>备注</th><th>操作</th>
    </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

/* --------------------- 可编辑业绩明细表 --------------------- */
function editableRecordsTable(records) {
  if (!records.length) return `<div class="empty">暂无业绩记录</div>`;
  const showStore = (me.role === 'boss' || me.role === 'regional');
  const showClerk = (me.role !== 'clerk');
  const canReassign = (me.role === 'boss' || me.role === 'regional');
  const storeOptions = (sel) => cache.stores.map(s => `<option value="${s.id}" ${s.id === sel ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
  const clerkOptions = (storeId, sel) => cache.users
    .filter(u => u.role === 'clerk' && u.active && u.storeId === storeId)
    .map(u => `<option value="${u.id}" ${u.id === sel ? 'selected' : ''}>${esc(u.name)}</option>`).join('');
  const rows = [...records].sort((a, b) => (b.date + b.id).localeCompare(a.date + a.id)).map(r => {
    const opts = Array.from(new Set([...(r.category ? [r.category] : []), ...(cache.categories || []).map(c => c.name)]));
    const optHTML = opts.map(c => `<option value="${esc(c)}" ${c === (r.category || '') ? 'selected' : ''}>${esc(c)}</option>`).join('');
    const storeTd = canReassign
      ? `<td><select class="ed-store" data-rid="${r.id}">${storeOptions(r.storeId)}</select></td>`
      : (showStore ? `<td>${esc(r.storeName)}</td>` : '');
    const clerkTd = canReassign
      ? `<td><select class="ed-clerk" data-rid="${r.id}">${clerkOptions(r.storeId, r.clerkId)}</select></td>`
      : (showClerk ? `<td>${esc(r.clerkName)}</td>` : '');
    return `<tr data-rid="${r.id}">
      <td>${esc(r.date)}</td>
      ${storeTd}
      ${clerkTd}
      <td><select class="ed-cat" data-rid="${r.id}">${optHTML}</select></td>
      <td><input class="ed-sub" data-rid="${r.id}" list="subList" value="${esc(r.subCategory || '')}" placeholder="小类" /></td>
      <td><input class="ed-pay" data-rid="${r.id}" list="payList" value="${esc(r.payMethod || '')}" placeholder="支付方式" style="width:120px;" /></td>
      <td><input class="ed-amt" data-rid="${r.id}" type="number" step="0.01" value="${r.amount}" style="width:104px;" /></td>
      <td class="c-comm">${money(r.commission)}</td>
      <td><input class="ed-note" data-rid="${r.id}" value="${esc(r.note || '')}" placeholder="备注" style="width:120px;" /></td>
      <td>
        <button class="btn sm" data-action="save-record" data-id="${r.id}">保存</button>
        <button class="btn danger sm" data-action="del-record" data-id="${r.id}">删除</button>
      </td>
    </tr>`;
  }).join('');
  return `<div class="tbl-scroll"><table class="editable">
    <thead><tr>
      <th>日期</th>
      ${canReassign ? '<th>归属门店</th><th>归属店员</th>' : (showStore ? '<th>门店</th>' : '') + (showClerk ? '<th>店员</th>' : '')}
      <th>大类</th><th>小类</th><th>支付方式</th><th>业绩金额</th><th>提成</th><th>备注</th><th>操作</th>
    </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

/* --------------------- 项目构成汇总表 --------------------- */
function categoryBreakdownHTML(byCategory) {
  if (!byCategory || !byCategory.length) return '';
  const memberPriceOf = (catName, subName) => {
    const c = (cache.categories || []).find(x => x.name === catName);
    if (!c) return 0;
    const s = (c.subs || []).find(y => (typeof y === 'object' ? y.name : y) === subName);
    return (s && typeof s === 'object') ? (Number(s.memberPrice) || 0) : 0;
  };
  const rows = byCategory.map(c => {
    const subs = (c.subs || []).map(s => {
      const mp = memberPriceOf(c.name, s.name);
      const mpText = mp > 0 ? ` · 会员价${money(mp)}` : '';
      return `<li>${esc(s.name)}：${money(s.sales)}（${s.count} 笔）${mpText}</li>`;
    }).join('');
    return `<tr>
      <td>${esc(c.name)}</td>
      <td>${c.count} 笔</td>
      <td class="c-amount">${money(c.sales)}</td>
      <td class="c-comm">${money(c.commission)}</td>
      <td class="muted">${subs ? `<ul class="subs">${subs}</ul>` : '—'}</td>
    </tr>`;
  }).join('');
  return `<div class="section">
    <h2>项目构成 <span class="tag">按大类汇总（小类见明细，金额相加即为总业绩；明细含会员价）</span></h2>
    <div class="tbl-scroll"><table>
      <thead><tr><th>大类</th><th>笔数</th><th>业绩金额</th><th>提成</th><th>小类明细</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </div>`;
}

/* --------------------- 月度提成曲线（SVG） --------------------- */
function monthlyCommission(records) {
  const map = {};
  for (const r of records) {
    const m = (r.date || '').slice(0, 7);
    if (!m) continue;
    map[m] = (map[m] || 0) + (Number(r.commission) || 0);
  }
  return Object.keys(map).sort().map(m => ({ month: m, value: Math.round(map[m] * 100) / 100 }));
}
function commissionCurve(records, title) {
  const pts = monthlyCommission(records);
  if (!pts.length) return `<div class="empty">暂无提成数据，登记业绩后这里会显示月度提成曲线</div>`;
  const W = 680, H = 260, padL = 56, padR = 18, padT = 28, padB = 38;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const max = Math.max(...pts.map(p => p.value), 1);
  const niceMax = Math.max(100, Math.ceil(max / 100) * 100);
  const n = pts.length;
  const x = i => n === 1 ? padL + innerW / 2 : padL + (innerW * i) / (n - 1);
  const y = v => padT + innerH * (1 - v / niceMax);
  let grid = '';
  for (let g = 0; g <= 4; g++) {
    const gy = padT + innerH * g / 4;
    const val = niceMax * (1 - g / 4);
    grid += `<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" stroke="#eef1f6" stroke-width="1"/>`;
    grid += `<text x="${padL - 8}" y="${gy + 4}" text-anchor="end" font-size="11" fill="#9aa3b2">${money(val)}</text>`;
  }
  const linePts = pts.map((p, i) => `${x(i)},${y(p.value)}`).join(' ');
  const areaPts = `${padL},${padT + innerH} ` + linePts + ` ${x(n - 1)},${padT + innerH}`;
  let dots = '', labels = '';
  pts.forEach((p, i) => {
    dots += `<circle cx="${x(i)}" cy="${y(p.value)}" r="4" fill="#2f6bff" stroke="#fff" stroke-width="2"/>`;
    dots += `<text x="${x(i)}" y="${y(p.value) - 10}" text-anchor="middle" font-size="11" fill="#2f6bff" font-weight="600">${money(p.value)}</text>`;
    labels += `<text x="${x(i)}" y="${H - 14}" text-anchor="middle" font-size="11" fill="#6b7686">${p.month}</text>`;
  });
  return `<div class="curve">
    <svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${esc(title)}">
      ${grid}
      <polygon points="${areaPts}" fill="rgba(47,107,255,.08)"/>
      <polyline points="${linePts}" fill="none" stroke="#2f6bff" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
      ${dots}
      ${labels}
      <text x="${padL}" y="16" font-size="12" fill="#6b7686">${esc(title)}</text>
    </svg>
  </div>`;
}

/* ----------------------------- 会员管理（老板 / 店长） ----------------------------- */
function membersSectionHTML() {
  const canPick = me.role === 'boss';
  return `<div class="section">
    <h2>会员管理 <span class="tag">${me.role === 'manager' ? '本门店储值会员' : '各门店储值会员'}</span></h2>
    <div class="row-actions" style="margin-bottom:12px;">
      ${canPick ? `<div class="field"><label>所属门店</label><select id="nmStore"></select></div>` : ''}
      <div class="field"><label>会员姓名</label><input id="nmName" placeholder="如：张三" /></div>
      <div class="field"><label>手机号</label><input id="nmPhone" placeholder="选填" style="width:140px;" /></div>
      <div class="field"><label>初始余额(元)</label><input id="nmBalance" type="number" step="0.01" value="0" style="width:120px;" /></div>
      <button class="btn" data-action="add-member">+ 新增会员</button>
      <button class="btn sm ghost" data-action="export-members">导出会员信息</button>
    </div>
    <div id="memberList"></div>
  </div>`;
}
function renderMembers() {
  const box = $('#memberList'); if (!box) return;
  const members = cache.members || [];
  if (!members.length) { box.innerHTML = `<div class="empty">暂无会员，请在上方新增</div>`; return; }
  const consumeMap = {};
  (cache.records || []).forEach(r => { if (r.memberId && r.payMethod === '会员') consumeMap[r.memberId] = (consumeMap[r.memberId] || 0) + Number(r.amount || 0); });
  const storeName = id => { const s = cache.stores.find(x => x.id === id); return s ? s.name : '—'; };
  const rows = members.map(m => `<tr>
    <td>${esc(m.name)}</td>
    <td>${esc(m.phone || '—')}</td>
    <td class="muted">${esc(storeName(m.storeId))}</td>
    <td class="c-amount">${money(m.balance)}</td>
    <td class="c-amount">${money(consumeMap[m.id] || 0)}</td>
    <td>
      <button class="btn sm" data-action="recharge-member" data-id="${m.id}">充值</button>
      <button class="btn sm ghost" data-action="edit-member" data-id="${m.id}">编辑</button>
      <button class="btn sm ghost" data-action="member-records" data-id="${m.id}">记录</button>
      <button class="btn danger sm" data-action="del-member" data-id="${m.id}">删除</button>
    </td>
  </tr>`).join('');
  box.innerHTML = `<div class="tbl-scroll"><table>
    <thead><tr><th>姓名</th><th>电话</th><th>所属门店</th><th>剩余金额</th><th>累计消费</th><th>操作</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}
function fillMemberStoreOptions() {
  const sel = $('#nmStore'); if (!sel) return;
  sel.innerHTML = cache.stores.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
}
function bindMemberToggle(payId, rowId, selId, subInputId, catSelId, amtId) {
  /* selId = 隐藏 input（存会员 id）；selId+'Input' = 搜索框；selId+'Dropdown' = 下拉；selId+'Wrap' = 容器 */
  const pay = document.getElementById(payId);
  const row = document.getElementById(rowId);
  const sel = document.getElementById(selId);
  const input = document.getElementById(selId + 'Input');
  const dropdown = document.getElementById(selId + 'Dropdown');
  if (!pay || !row || !sel) return;
  const subInput = subInputId ? document.getElementById(subInputId) : null;
  let prevMember = null;
  const renderMemberOptions = (filter) => {
    if (!dropdown) return;
    const kw = (filter || '').trim().toLowerCase();
    const list = (cache.members || []).filter(m =>
      !kw || (m.name || '').toLowerCase().includes(kw) || (m.phone || '').toLowerCase().includes(kw));
    if (!list.length) { dropdown.innerHTML = '<div class="sub-search-empty">无匹配会员</div>'; return; }
    dropdown.innerHTML = list.map(m => `<div class="member-item sub-search-item" data-id="${esc(m.id)}">
      <div class="ssi-name">${esc(m.name)} <span class="ssi-cat">余${money(m.balance)}</span></div>
      ${m.phone ? `<div class="ssi-meta">${esc(m.phone)}</div>` : ''}
    </div>`).join('');
  };
  const openMember = (filter) => { if (dropdown) { renderMemberOptions(filter); dropdown.classList.add('open'); } };
  const update = () => {
    const isMember = (pay.value || '').trim() === '会员';
    row.style.display = isMember ? '' : 'none';
    if (isMember) {
      /* 刚从非会员切到会员时强制重带会员价，覆盖已填的普通售价 */
      if (subInput) autoFillPriceFromSub(subInput, catSelId, amtId, prevMember === false);
      if (input) { openMember(input.value); setTimeout(() => input.focus(), 0); }
    } else {
      sel.value = ''; if (input) input.value = '';
      if (dropdown) dropdown.classList.remove('open');
    }
    prevMember = isMember;
  };
  if (input) {
    input.addEventListener('focus', () => openMember(input.value));
    input.addEventListener('click', () => openMember(input.value));
    input.addEventListener('input', () => openMember(input.value));
    input.addEventListener('keydown', e => { if (e.key === 'Escape' && dropdown) dropdown.classList.remove('open'); });
    input.addEventListener('focusout', () => setTimeout(() => {
      if (dropdown && document.activeElement !== input && !dropdown.contains(document.activeElement)) dropdown.classList.remove('open');
    }, 120));
  }
  pay.addEventListener('input', update);
  pay.addEventListener('change', update);
  update();
}
function showMemberRecords(memberId) {
  const m = (cache.members || []).find(x => x.id === memberId);
  if (!m) return;
  const recs = (cache.records || []).filter(r => r.memberId === memberId && r.payMethod === '会员').sort((a, b) => (b.date + b.id).localeCompare(a.date + a.id));
  const total = recs.reduce((s, r) => s + Number(r.amount || 0), 0);
  const rows = recs.length ? recs.map(r => `<tr>
    <td>${esc(r.date)}</td>
    <td>${esc(r.storeName || '—')}</td>
    <td>${esc(r.clerkName || '—')}</td>
    <td>${esc(r.category || '—')}</td>
    <td>${esc(r.subCategory || '—')}</td>
    <td class="c-amount">${money(r.amount)}</td>
  </tr>`).join('') : `<tr><td colspan="6" class="muted">暂无会员消费记录</td></tr>`;
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal" style="max-width:700px;">
      <div class="modal-title">${esc(m.name)} · 会员消费记录</div>
      <div class="muted" style="margin:-4px 0 10px;">所属门店：${esc((cache.stores.find(s => s.id === m.storeId) || {}).name || '—')} · 剩余余额：<b>${money(m.balance)}</b> · 累计消费：<b>${money(total)}</b></div>
      <div class="tbl-scroll"><table>
        <thead><tr><th>日期</th><th>门店</th><th>店员</th><th>大类</th><th>小类</th><th>金额</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <div class="modal-actions"><button class="btn ghost" id="mrClose">关闭</button></div>
    </div>`;
  document.body.appendChild(mask);
  mask.addEventListener('click', e => { if (e.target === mask) mask.remove(); });
  mask.querySelector('#mrClose').onclick = () => mask.remove();
}

/* ----------------------------- 老板 / 区域经理 视图 ----------------------------- */
function renderBoss() {
  const s = cache.summary;
  const isBoss = me.role === 'boss';
  const regionName = (cache.regions[0] && cache.regions[0].name) || '';
  const scopeTitle = isBoss ? '所有门店实时汇总' : (regionName + ' · 大区汇总');
  const main = $('#main');
  main.innerHTML = `
    <div class="section">
      <h2>${isBoss ? '经营总览' : (regionName + ' 总览')} <span class="tag">${scopeTitle}</span></h2>
      ${timeBarHTML()}
      ${shareLinkHTML()}
      <div class="cards">
        <div class="kpi"><div class="label">总业绩</div><div class="val">${money(s.totalSales)}</div></div>
        <div class="kpi green"><div class="label">总提成</div><div class="val">${money(s.totalCommission)}</div></div>
        <div class="kpi gray"><div class="label">登记笔数</div><div class="val">${s.recordCount}</div></div>
        <div class="kpi amber"><div class="label">在岗店员</div><div class="val">${s.clerkCount}</div></div>
      </div>
      ${commissionCurve(rangeFilteredRecords(), isBoss ? '全平台月度提成趋势' : (regionName + ' 月度提成趋势'))}
    </div>

    ${categoryBreakdownHTML(s.byCategory)}

    ${isBoss ? `
    <div class="section">
      <h2>区域管理 <span class="tag">老板专属 · 大区架构</span></h2>
      <div id="regionList"></div>
      <div class="row-actions" style="margin-top:12px;">
        <div class="field"><label>新增大区名称</label><input id="nrName" placeholder="如：华南大区" /></div>
        <button class="btn" data-action="add-region">+ 新增大区</button>
      </div>
    </div>` : ''}

    <div class="section">
      <h2>门店管理 <span class="tag">${isBoss ? '老板专属 · 可增删改' : '本大区门店'}</span></h2>
      <div id="storeList"></div>
      <div class="row-actions" style="margin-top:14px;">
        <div class="field"><label>门店名称</label><input id="nsName" placeholder="如：门店C（ mall 店）" /></div>
        <div class="field"><label>提成比例</label><input id="nsRate" type="number" step="0.01" value="0.10" style="width:110px;" /></div>
        <div class="field"><label>固定提成(元)</label><input id="nsFixed" type="number" step="1" value="0" style="width:110px;" /></div>
        ${isBoss ? `<div class="field"><label>所属大区</label><select id="nsRegion"></select></div>` : ''}
        <button class="btn" data-action="add-store">+ 新增门店</button>
      </div>
    </div>

    <div class="section">
      <h2>业务大类 / 小类维护 <span class="tag">老板专属 · 可自定义，登记与汇总同步生效</span></h2>
      <div id="catList"></div>
      <div class="row-actions" style="margin-top:12px;">
        <div class="field"><label>新增大类名称</label><input id="ncName" placeholder="如：美容" /></div>
        <button class="btn" data-action="add-cat">+ 新增大类</button>
      </div>
    </div>

    <div class="section">
      <h2>业绩明细管理 <span class="tag">可直接修改大类 / 小类 / 金额 / 归属（实时同步）</span></h2>
      ${exportBarHTML()}
      <div id="bossRecords"></div>
    </div>

    <div class="section">
      <h2>人员管理 <span class="tag">${isBoss ? '全部账号（含多老板/区域经理）' : '本大区账号'}</span></h2>
      <div id="bossUsers"></div>
      <div class="row-actions" style="margin-top:14px;">
        <div class="field"><label>姓名</label><input id="nuName" placeholder="如：小周" /></div>
        <div class="field"><label>账号</label><input id="nuUser" placeholder="如：clerkC1" /></div>
        <div class="field"><label>初始密码</label><input id="nuPass" value="clerk123" style="width:120px;" /></div>
        <div class="field"><label>角色</label><select id="nuRole">${isBoss ? '<option value="clerk">店员</option><option value="manager">店长</option><option value="regional">区域经理</option><option value="boss">老板</option>' : '<option value="clerk">店员</option><option value="manager">店长</option>'}</select></div>
        <div class="field" id="nuStoreField"><label>归属门店</label><select id="nuStore"></select></div>
        <div class="field" id="nuRegionField" style="display:none;"><label>归属大区</label><select id="nuRegion"></select></div>
        <button class="btn" data-action="add-user">+ 新增人员</button>
      </div>
    </div>

    ${membersSectionHTML()}

  `;
  if (isBoss) { renderRegionList(); renderCategories(); }
  renderStoreList();
  renderBossRecords();
  renderBossUsers();
  const sel = $('#nuStore');
  sel.innerHTML = cache.stores.map(st => `<option value="${st.id}">${esc(st.name)}</option>`).join('');
  const rsel = $('#nuRegion');
  if (rsel) rsel.innerHTML = cache.regions.map(rg => `<option value="${rg.id}">${esc(rg.name)}</option>`).join('');
  const nsel = $('#nsRegion');
  if (nsel) nsel.innerHTML = `<option value="">不限大区</option>` + cache.regions.map(rg => `<option value="${rg.id}">${esc(rg.name)}</option>`).join('');
  const nuRole = $('#nuRole');
  if (nuRole) nuRole.onchange = () => {
    const v = nuRole.value;
    $('#nuStoreField').style.display = (v === 'clerk' || v === 'manager') ? '' : 'none';
    $('#nuRegionField').style.display = (v === 'regional') ? '' : 'none';
  };
  const rmode = $('#rangeMode');
  if (rmode) rmode.onchange = onRangeModeChange;
  const rapply = $('#rangeApply');
  if (rapply) rapply.onclick = applyCustomRange;
  renderMembers();
  if (me.role === 'boss') fillMemberStoreOptions();
}

function renderRegionList() {
  const box = $('#regionList');
  if (!box) return;
  if (!cache.regions.length) { box.innerHTML = `<div class="empty">暂无大区，请新增</div>`; return; }
  box.innerHTML = cache.regions.map(rg => {
    const n = cache.stores.filter(s => s.regionId === rg.id).length;
    return `<div class="store-block">
      <div class="head">
        <span class="name">${esc(rg.name)}</span>
        <span class="muted">门店 ${n} 家</span>
      </div>
      <div class="inline-edit">
        <button class="btn danger sm" data-action="del-region" data-id="${rg.id}">删除大区</button>
      </div>
    </div>`;
  }).join('');
}

function renderStoreList() {
  const box = $('#storeList');
  if (!box) return;
  box.innerHTML = cache.stores.map(st => {
    const sum = (cache.summary.byStore || []).find(b => b.id === st.id) || {};
    const region = cache.regions.find(rg => rg.id === st.regionId);
    return `<div class="store-block">
      <div class="head">
        <span class="name">${esc(st.name)}</span>
        <span class="muted">业绩 ${money(sum.sales || 0)} · 提成 ${money(sum.commission || 0)} · 店员 ${sum.clerks || 0} 人${region ? ' · ' + esc(region.name) : ''}</span>
      </div>
      <div class="inline-edit">
        <div class="field"><label>名称</label><input id="sn_${st.id}" value="${esc(st.name)}" /></div>
        <div class="field"><label>提成率</label><input id="sr_${st.id}" type="number" step="0.01" value="${st.commissionRate}" style="width:90px;" /></div>
        <div class="field"><label>固定提成</label><input id="sf_${st.id}" type="number" step="1" value="${st.commissionFixed || 0}" style="width:90px;" /></div>
        <button class="btn sm" data-action="edit-store" data-id="${st.id}">保存</button>
        <button class="btn danger sm" data-action="del-store" data-id="${st.id}">删除门店</button>
      </div>
    </div>`;
  }).join('');
}

function renderBossRecords() {
  const box = $('#bossRecords');
  if (box) box.innerHTML = editableRecordsTable(rangeFilteredRecords());
}

function renderBossUsers() {
  const box = $('#bossUsers');
  if (!box) return;
  if (!cache.users.length) { box.innerHTML = `<div class="empty">暂无人员</div>`; return; }
  const rows = cache.users.filter(u => u.active).map(u => {
    const store = cache.stores.find(s => s.id === u.storeId);
    const region = cache.regions.find(rg => rg.id === u.regionId);
    return `<tr>
      <td>${esc(u.name)}</td>
      <td>${esc(u.username)}</td>
      <td><span class="pill ${u.role}">${roleName(u.role)}</span></td>
      <td class="muted">${store ? esc(store.name) : (region ? esc(region.name) : '—')}</td>
      <td>
        <button class="btn sm" data-action="edit-name" data-id="${u.id}">改名</button>
        <button class="btn sm" data-action="reset-pw" data-id="${u.id}">重置</button>
        <button class="btn danger sm" data-action="del-user" data-id="${u.id}">删除</button>
      </td>
    </tr>`;
  }).join('');
  box.innerHTML = `<div class="tbl-scroll"><table><thead><tr><th>姓名</th><th>账号</th><th>角色</th><th>归属</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

/* --------------------- 业务大类 / 小类维护（老板专属） --------------------- */
function renderCategories() {
  const box = $('#catList');
  if (!box) return;
  const cats = cache.categories || [];
  if (!cats.length) { box.innerHTML = `<div class="empty">暂无大类，请在下方新增</div>`; return; }
  box.innerHTML = cats.map(c => {
    const subs = (c.subs || []).map(s => {
      const name = (typeof s === 'object') ? s.name : s;
      const rate = (typeof s === 'object') ? (s.rate || 0) : 0;
      const fixed = (typeof s === 'object') ? (s.fixed || 0) : 0;
      const price = (typeof s === 'object') ? (s.price || 0) : 0;
      const mprice = (typeof s === 'object') ? (s.memberPrice || 0) : 0;
      return `<div class="sub-row" data-sub="${esc(name)}">
        <input class="sub-name-input" value="${esc(name)}" maxlength="20" title="可直接修改小类名称" />
        <label class="sub-field">比例<input class="sub-rate" type="number" step="0.001" min="0" value="${rate}" placeholder="%" style="width:60px" />%</label>
        <label class="sub-field">固定<input class="sub-fixed" type="number" step="0.01" min="0" value="${fixed}" placeholder="元" style="width:70px" />元</label>
        <label class="sub-field">售价<input class="sub-price" type="number" step="0.01" min="0" value="${price}" placeholder="元" style="width:74px" />元</label>
        <label class="sub-field">会员价<input class="sub-mprice" type="number" step="0.01" min="0" value="${mprice}" placeholder="元" style="width:74px" />元</label>
        <button class="btn sm" data-action="save-sub" data-cat="${esc(c.name)}" data-sub="${esc(name)}">保存</button>
        <button class="chip-x" title="删除小类" data-action="del-sub" data-cat="${esc(c.name)}" data-sub="${esc(name)}">×</button>
      </div>`;
    }).join('');
    return `<div class="cat-card" data-cat="${esc(c.name)}">
      <div class="cat-head">
        <span class="cat-name">${esc(c.name)}</span>
        <span class="cat-subcount">${(c.subs || []).length} 个小类</span>
        <span class="spacer"></span>
        <button class="btn sm ghost" data-action="rename-cat" data-cat="${esc(c.name)}">重命名</button>
        <button class="btn sm danger" data-action="del-cat" data-cat="${esc(c.name)}">删除大类</button>
      </div>
      <div class="cat-subs">${subs || '<span class="muted">暂无小类</span>'}</div>
      <div class="cat-add">
        <input class="sub-input" data-cat="${esc(c.name)}" placeholder="小类名称" style="flex:1;min-width:90px;" />
        <input class="add-rate" type="number" step="0.001" min="0" placeholder="比例%" style="width:74px" />
        <input class="add-fixed" type="number" step="0.01" min="0" placeholder="固定元" style="width:80px" />
        <input class="add-price" type="number" step="0.01" min="0" placeholder="售价元" style="width:84px" />
        <input class="add-mprice" type="number" step="0.01" min="0" placeholder="会员价元" style="width:88px" />
        <button class="btn sm" data-action="add-sub" data-cat="${esc(c.name)}">+ 小类</button>
      </div>
    </div>`;
  }).join('');
}

/* ----------------------------- 店长视图 ----------------------------- */
function renderManager() {
  const s = cache.summary;
  const store = cache.stores[0];
  const clerks = cache.users.filter(u => u.role === 'clerk');
  const main = $('#main');
  main.innerHTML = `
    <div class="section">
      <h2>本门店总览 <span class="tag">${esc(store ? store.name : '未关联门店')}</span></h2>
      <div class="cards">
        <div class="kpi"><div class="label">门店业绩</div><div class="val">${money(s.totalSales)}</div></div>
        <div class="kpi green"><div class="label">门店提成</div><div class="val">${money(s.totalCommission)}</div></div>
        <div class="kpi amber"><div class="label">登记笔数</div><div class="val">${s.recordCount}</div></div>
        <div class="kpi gray"><div class="label">在岗店员</div><div class="val">${s.clerkCount}</div></div>
      </div>
      ${commissionCurve(cache.records, '本门店月度提成趋势')}
      ${shareLinkHTML()}
    </div>

    ${categoryBreakdownHTML(s.byCategory)}

    <div class="section">
      <h2>门店人员管理 <span class="tag">店长专属 · 可增减店员</span></h2>
      <div id="mgrUsers"></div>
      <div class="row-actions" style="margin-top:14px;">
        <div class="field"><label>姓名</label><input id="muName" placeholder="如：小李" /></div>
        <div class="field"><label>账号</label><input id="muUser" placeholder="如：clerkA3" /></div>
        <div class="field"><label>初始密码</label><input id="muPass" value="clerk123" style="width:120px;" /></div>
        <button class="btn" data-action="add-clerk">+ 新增店员</button>
      </div>
    </div>

    <div class="section">
      <h2>门店业绩登记 <span class="tag">仅本门店</span></h2>
      ${exportBarHTML()}
      <div class="row-actions" style="margin-bottom:14px;">
        <div class="field"><label>店员</label><select id="mrClerk"></select></div>
        <div class="field"><label>日期</label><input id="mrDate" type="date" value="${today()}" /></div>
        <div class="field"><label>大类</label><select id="mrCat">${catOptionsHTML()}</select></div>
        <div class="field" style="position:relative;"><label>小类</label><div class="sub-search"><input id="mrSub" class="sub-search-input" placeholder="搜索或选择小类" autocomplete="off" /><div id="mrSubDropdown" class="sub-search-dropdown"></div></div></div>
        <div class="field"><label>业绩金额</label><input id="mrAmount" type="number" step="0.01" placeholder="0.00" style="width:130px;" /></div>
        <div class="field"><label>支付方式</label><div class="sub-search pay-search" id="mrPayWrap"><input id="mrPay" class="sub-search-input" placeholder="搜索或选择支付方式" autocomplete="off" /><div id="mrPayDropdown" class="sub-search-dropdown"></div></div></div>
        <div class="field" id="mrMemberRow" style="display:none; position:relative;"><label>会员（储值）</label><div class="sub-search member-search" id="mrMemberWrap"><input id="mrMemberInput" class="sub-search-input" placeholder="搜索会员姓名/手机号" autocomplete="off" /><div id="mrMemberDropdown" class="sub-search-dropdown"></div></div><input type="hidden" id="mrMember" /></div>
        <div class="field"><label>备注</label><input id="mrNote" placeholder="选填" /></div>
        <button class="btn" data-action="add-record">+ 登记业绩</button>
      </div>
      <div id="mrCommissionHint" class="commission-hint"></div>
      <div id="mgrRecords"></div>
    </div>

    ${membersSectionHTML()}

  `;
  const sel = $('#mrClerk');
  sel.innerHTML = clerks.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  renderMgrUsers();
  renderMgrRecords();
  renderMembers();
  bindMemberToggle('mrPay', 'mrMemberRow', 'mrMember', 'mrSub', 'mrCat', 'mrAmount');
}
function renderMgrUsers() {
  const box = $('#mgrUsers');
  if (!box) return;
  const clerks = cache.users.filter(u => u.role === 'clerk');
  if (!clerks.length) { box.innerHTML = `<div class="empty">本门店暂无店员，请在下方新增</div>`; return; }
  const rows = clerks.map(c => `<tr>
    <td>${esc(c.name)}</td><td>${esc(c.username)}</td>
    <td>
      <button class="btn sm" data-action="edit-name" data-id="${c.id}">改名</button>
      <button class="btn danger sm" data-action="del-user" data-id="${c.id}">删除</button>
    </td>
  </tr>`).join('');
  box.innerHTML = `<div class="tbl-scroll"><table><thead><tr><th>店员姓名</th><th>账号</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
function renderMgrRecords() { const box = $('#mgrRecords'); if (box) box.innerHTML = editableRecordsTable(cache.records); }

/* ----------------------------- 店员视图 ----------------------------- */
function renderClerk() {
  const s = cache.summary;
  const main = $('#main');
  const storeTag = me.storeName ? ` · 所属门店：${esc(me.storeName)}` : '';
  main.innerHTML = `
    <div class="section">
      <h2>我的业绩 <span class="tag">仅本人可见${storeTag}</span></h2>
      <div class="cards">
        <div class="kpi"><div class="label">我的业绩总额</div><div class="val">${money(s.totalSales)}</div></div>
        <div class="kpi green"><div class="label">我的提成总额</div><div class="val">${money(s.totalCommission)}</div></div>
        <div class="kpi gray"><div class="label">登记笔数</div><div class="val">${s.recordCount}</div></div>
      </div>
      ${commissionCurve(cache.records, '我的月度提成曲线')}
    </div>
    <div class="section">
      <h2>登记我的业绩</h2>
      ${exportBarHTML()}
      <div class="row-actions" style="margin-bottom:14px;">
        <div class="field"><label>日期</label><input id="crDate" type="date" value="${today()}" /></div>
        <div class="field"><label>大类</label><select id="crCat">${catOptionsHTML()}</select></div>
        <div class="field" style="position:relative;"><label>小类</label><div class="sub-search"><input id="crSub" class="sub-search-input" placeholder="搜索或选择小类" autocomplete="off" /><div id="crSubDropdown" class="sub-search-dropdown"></div></div></div>
        <div class="field"><label>业绩金额</label><input id="crAmount" type="number" step="0.01" placeholder="0.00" style="width:130px;" /></div>
        <div class="field"><label>支付方式</label><div class="sub-search pay-search" id="crPayWrap"><input id="crPay" class="sub-search-input" placeholder="搜索或选择支付方式" autocomplete="off" /><div id="crPayDropdown" class="sub-search-dropdown"></div></div></div>
        <div class="field" id="crMemberRow" style="display:none; position:relative;"><label>会员（储值）</label><div class="sub-search member-search" id="crMemberWrap"><input id="crMemberInput" class="sub-search-input" placeholder="搜索会员姓名/手机号" autocomplete="off" /><div id="crMemberDropdown" class="sub-search-dropdown"></div></div><input type="hidden" id="crMember" /></div>
        <div class="field"><label>备注</label><input id="crNote" placeholder="选填" /></div>
        <button class="btn" data-action="add-record">+ 登记业绩</button>
      </div>
      <div id="crCommissionHint" class="commission-hint"></div>
      <div id="clerkRecords"></div>
    </div>`;
  const box = $('#clerkRecords');
  if (box) box.innerHTML = recordsTable(cache.records);
  bindMemberToggle('crPay', 'crMemberRow', 'crMember', 'crSub', 'crCat', 'crAmount');
}

/* ----------------------------- 行为处理（事件委托） ----------------------------- */
document.addEventListener('click', async e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const id = btn.dataset.id;

  if (action === 'export-xlsx') {
    const m = $('#expMonth') ? $('#expMonth').value : '';
    await exportXLSX(m);
    return;
  }
  if (action === 'export-members') {
    await exportMembersXLSX();
    return;
  }
  if (action === 'copy-link') {
    copyText(shareUrlVersioned());
    toast('访问地址已复制，发给员工即可登录登记');
    return;
  }
  if (action === 'show-share-qr') {
    await showShareQR();
    return;
  }
  if (action === 'add-region') {
    const name = $('#nrName').value.trim();
    if (!name) return toast('请输入大区名称', true);
    const r = await DB.addRegion(name);
    if (r.ok) { recomputeCache(); renderRegionList(); toast('大区已新增'); }
    else toast(r.error || '添加失败', true);
  }
  else if (action === 'del-region') {
    if (!confirm('确认删除该大区？需先清空其下门店。')) return;
    const r = await DB.deleteRegion(id);
    if (r.ok) { recomputeCache(); renderRegionList(); toast('大区已删除'); }
    else toast(r.error || '删除失败', true);
  }
  else if (action === 'add-store') {
    const name = $('#nsName').value.trim();
    const rate = parseFloat($('#nsRate').value);
    const fixed = parseFloat($('#nsFixed').value) || 0;
    if (!name) return toast('请输入门店名称', true);
    const body = { name, commissionRate: rate, commissionFixed: fixed };
    if (me.role === 'boss') body.regionId = $('#nsRegion') ? $('#nsRegion').value || null : null;
    const r = await DB.addStore(body);
    if (r.ok) { recomputeCache(); renderStoreList(); $('#nsName').value = ''; toast('门店已新增'); }
    else toast(r.error || '添加失败', true);
  }
  else if (action === 'edit-store') {
    const name = $('#sn_' + id).value.trim();
    const rate = parseFloat($('#sr_' + id).value);
    const fixed = parseFloat($('#sf_' + id).value) || 0;
    const r = await DB.updateStore(id, { name, commissionRate: rate, commissionFixed: fixed });
    if (r.ok) { recomputeCache(); renderStoreList(); renderBossRecords(); toast('门店已更新'); }
    else toast(r.error || '更新失败', true);
  }
  else if (action === 'del-store') {
    if (!confirm('确认删除该门店？删除前需先清空其业绩记录与在岗人员。')) return;
    const r = await DB.deleteStore(id);
    if (r.ok) {
      recomputeCache(); renderStoreList(); renderBossUsers();
      if ($('#nuStore')) $('#nuStore').innerHTML = cache.stores.map(st => `<option value="${st.id}">${esc(st.name)}</option>`).join('');
      toast('门店已删除');
    }
    else toast(r.error || '删除失败', true);
  }
  else if (action === 'add-user') {
    const name = $('#nuName').value.trim();
    const username = $('#nuUser').value.trim();
    const password = $('#nuPass').value;
    const role = $('#nuRole').value;
    if (!name || !username) return toast('姓名和账号必填', true);
    const body = { name, username, password, role };
    if (role === 'clerk' || role === 'manager') body.storeId = $('#nuStore').value;
    if (role === 'regional') body.regionId = $('#nuRegion').value;
    const r = await DB.addUser(body);
    if (r.ok) {
      recomputeCache(); renderBossUsers();
      $('#nuName').value = ''; $('#nuUser').value = '';
      toast('人员已添加');
    } else toast(r.error || '添加失败', true);
  }
  else if (action === 'add-clerk') {
    const name = $('#muName').value.trim();
    const username = $('#muUser').value.trim();
    const password = $('#muPass').value;
    if (!name || !username) return toast('姓名和账号必填', true);
    const r = await DB.addUser({ name, username, password, role: 'clerk', storeId: me.storeId });
    if (r.ok) {
      recomputeCache();
      renderMgrUsers();
      $('#mrClerk').innerHTML = cache.users.filter(u => u.role === 'clerk').map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
      $('#muName').value = ''; $('#muUser').value = '';
      toast('店员已添加');
    } else toast(r.error || '添加失败', true);
  }
  else if (action === 'edit-name') {
    const who = cache.users.find(u => u.id === id);
    if (!who) return;
    const newName = prompt('修改姓名：', who.name);
    if (newName === null) return;
    const name = newName.trim();
    if (!name) return toast('姓名不能为空', true);
    const r = await DB.updateUser(id, { name });
    if (r.ok) {
      recomputeCache();
      if (me.role === 'boss' || me.role === 'regional') { renderBossUsers(); }
      else { renderMgrUsers(); $('#mrClerk').innerHTML = cache.users.filter(u => u.role === 'clerk').map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join(''); }
      toast('姓名已更新');
    } else toast(r.error || '修改失败', true);
  }
  else if (action === 'del-user') {
    const who = cache.users.find(u => u.id === id);
    if (!confirm('确认删除 ' + (who ? who.name : '该人员') + '？删除后不可恢复。')) return;
    const r = await DB.deleteUser(id);
    if (r.ok) {
      recomputeCache();
      if (me.role === 'boss' || me.role === 'regional') { renderBossUsers(); }
      else { renderMgrUsers(); $('#mrClerk').innerHTML = cache.users.filter(u => u.role === 'clerk').map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join(''); }
      toast('人员已删除');
    } else toast(r.error || '操作失败', true);
  }
  else if (action === 'add-record') {
    let body;
    if (me.role === 'clerk') {
      body = { date: $('#crDate').value, category: $('#crCat').value, subCategory: $('#crSub').value.trim(), payMethod: $('#crPay').value, amount: parseFloat($('#crAmount').value), note: $('#crNote').value };
      if ($('#crPay').value === '会员') body.memberId = $('#crMember').value;
    }
    else if (me.role === 'manager') {
      body = { clerkId: $('#mrClerk').value, date: $('#mrDate').value, category: $('#mrCat').value, subCategory: $('#mrSub').value.trim(), payMethod: $('#mrPay').value, amount: parseFloat($('#mrAmount').value), note: $('#mrNote').value };
      if ($('#mrPay').value === '会员') body.memberId = $('#mrMember').value;
    }
    else return;
    if (!(body.amount >= 0)) return toast('请输入有效金额', true);
    const r = await DB.addRecord(body);
    if (r.ok) {
      recomputeCache();
      if (me.role === 'clerk') { renderClerk(); }
      else if (me.role === 'manager') { renderMgrRecords(); }
      else { renderBossRecords(); }
      toast('业绩已登记');
    } else toast(r.error || '登记失败', true);
  }
  else if (action === 'del-record') {
    if (!confirm('确认删除这条业绩记录？')) return;
    const r = await DB.deleteRecord(id);
    if (r.ok) { recomputeCache(); render(); toast('已删除'); }
    else toast(r.error || '删除失败', true);
  }
  else if (action === 'add-member') {
    const name = $('#nmName').value.trim();
    const phone = $('#nmPhone').value.trim();
    const balance = parseFloat($('#nmBalance').value) || 0;
    if (!name) return toast('请输入会员姓名', true);
    const body = { name, phone, balance };
    if (me.role === 'boss') body.storeId = $('#nmStore') ? $('#nmStore').value : null;
    const r = await DB.addMember(body);
    if (r.ok) {
      recomputeCache(); renderMembers();
      $('#nmName').value = ''; $('#nmPhone').value = ''; $('#nmBalance').value = '0';
      toast('会员已新增');
    } else toast(r.error || '新增失败', true);
  }
  else if (action === 'recharge-member') {
    const who = (cache.members || []).find(x => x.id === id);
    const amtStr = prompt('为「' + (who ? who.name : '该会员') + '」充值金额（元）：', '100');
    if (amtStr === null) return;
    const amt = parseFloat(amtStr);
    if (!(amt > 0)) return toast('请输入大于 0 的金额', true);
    const r = await DB.rechargeMember(id, amt);
    if (r.ok) { recomputeCache(); renderMembers(); const m = (cache.members || []).find(x => x.id === id); toast('充值成功，余额 ' + (m ? money(m.balance) : '')); }
    else toast(r.error || '充值失败', true);
  }
  else if (action === 'edit-member') {
    const who = (cache.members || []).find(x => x.id === id);
    if (!who) return;
    const newName = prompt('修改会员姓名：', who.name);
    if (newName === null) return;
    const newPhone = prompt('修改手机号：', who.phone || '');
    if (newPhone === null) return;
    const r = await DB.updateMember(id, { name: newName.trim(), phone: newPhone.trim() });
    if (r.ok) { recomputeCache(); renderMembers(); toast('会员信息已更新'); }
    else toast(r.error || '修改失败', true);
  }
  else if (action === 'member-records') {
    showMemberRecords(id);
  }
  else if (action === 'del-member') {
    const who = (cache.members || []).find(x => x.id === id);
    if (!confirm('确认删除会员「' + (who ? who.name : '') + '」？其消费记录将保留，仅解除会员关联。')) return;
    const r = await DB.deleteMember(id);
    if (r.ok) { recomputeCache(); renderMembers(); toast('会员已删除'); }
    else toast(r.error || '删除失败', true);
  }
  else if (action === 'save-record') {
    const rid = id;
    const cat = document.querySelector('.ed-cat[data-rid="' + rid + '"]').value;
    const sub = (document.querySelector('.ed-sub[data-rid="' + rid + '"]').value || '').trim();
    const amt = parseFloat(document.querySelector('.ed-amt[data-rid="' + rid + '"]').value);
    const note = (document.querySelector('.ed-note[data-rid="' + rid + '"]').value || '').trim();
    const paySel = document.querySelector('.ed-pay[data-rid="' + rid + '"]');
    if (!(amt >= 0)) return toast('请输入有效金额', true);
    const body = { category: cat, subCategory: sub, amount: amt, note, payMethod: paySel ? paySel.value : '' };
    if (me.role === 'boss' || me.role === 'regional') {
      const storeSel = document.querySelector('.ed-store[data-rid="' + rid + '"]');
      const clerkSel = document.querySelector('.ed-clerk[data-rid="' + rid + '"]');
      if (storeSel) body.storeId = storeSel.value;
      if (clerkSel) body.clerkId = clerkSel.value;
    }
    const r = await DB.updateRecord(rid, body);
    if (r.ok) { recomputeCache(); render(); toast('已保存'); }
    else toast(r.error || '保存失败', true);
  }
  else if (action === 'add-cat') {
    const name = $('#ncName').value.trim();
    if (!name) return toast('请输入大类名称', true);
    const r = await DB.addCategory(name);
    if (r.ok) { recomputeCache(); renderCategories(); $('#ncName').value = ''; toast('大类已新增'); }
    else toast(r.error || '添加失败', true);
  }
  else if (action === 'rename-cat') {
    const cat = btn.dataset.cat || id;
    const nn = prompt('将该大类重命名为：', cat);
    if (!nn || !nn.trim()) return;
    const r = await DB.renameCategory(cat, nn.trim());
    if (r.ok) { recomputeCache(); render(); toast('已重命名'); }
    else toast(r.error || '重命名失败', true);
  }
  else if (action === 'del-cat') {
    const cat = btn.dataset.cat || id;
    if (!confirm('确认删除大类「' + cat + '」？已登记的该大类记录在列表中仍保留原名称，仅不再出现在下拉中。')) return;
    const r = await DB.deleteCategory(cat);
    if (r.ok) { recomputeCache(); render(); toast('大类已删除'); }
    else toast(r.error || '删除失败', true);
  }
  else if (action === 'add-sub') {
    const card = btn.closest('.cat-card');
    const inp = card ? card.querySelector('.sub-input') : null;
    const val = inp ? inp.value.trim() : '';
    if (!val) return toast('请输入小类名称', true);
    const rate = card ? parseFloat(card.querySelector('.add-rate').value) || 0 : 0;
    const fixed = card ? parseFloat(card.querySelector('.add-fixed').value) || 0 : 0;
    const price = card ? parseFloat(card.querySelector('.add-price').value) || 0 : 0;
    const mprice = card ? parseFloat(card.querySelector('.add-mprice').value) || 0 : 0;
    const catObj = cache.categories.find(c => c.name === btn.dataset.cat);
    const subs = [];
    const seen = new Set();
    (catObj ? catObj.subs : []).forEach(s => {
      const n = (typeof s === 'object') ? s.name : s;
      if (!seen.has(n)) { seen.add(n); subs.push(typeof s === 'object' ? s : { name: n, rate: 0, fixed: 0, price: 0, memberPrice: 0 }); }
    });
    if (!seen.has(val)) subs.push({ name: val, rate, fixed, price, memberPrice: mprice });
    const r = await DB.setSubs(btn.dataset.cat, subs);
    if (r.ok) { recomputeCache(); renderCategories(); toast('小类已添加' + (rate || fixed || price || mprice ? '（含提成/售价/会员价）' : '')); }
    else toast(r.error && r.error || '添加失败', true);
  }
  else if (action === 'save-sub') {
    const catObj = cache.categories.find(c => c.name === btn.dataset.cat);
    if (!catObj) return toast('大类不存在', true);
    const row = btn.closest('.sub-row');
    const nameInput = row ? row.querySelector('.sub-name-input') : null;
    const newName = nameInput ? nameInput.value.trim() : '';
    if (!newName) return toast('小类名称不能为空', true);
    const rate = row ? parseFloat(row.querySelector('.sub-rate').value) || 0 : 0;
    const fixed = row ? parseFloat(row.querySelector('.sub-fixed').value) || 0 : 0;
    const price = row ? parseFloat(row.querySelector('.sub-price').value) || 0 : 0;
    const mprice = row ? parseFloat(row.querySelector('.sub-mprice').value) || 0 : 0;
    const from = btn.dataset.sub;
    const subs = (catObj.subs || []).map(s => {
      const n = (typeof s === 'object') ? s.name : s;
      if (n === from) return { name: newName, rate, fixed, price, memberPrice: mprice };
      return (typeof s === 'object') ? s : { name: n, rate: 0, fixed: 0, price: 0, memberPrice: 0 };
    });
    const r = await DB.setSubs(btn.dataset.cat, subs, newName !== from ? { from, to: newName } : undefined);
    if (r.ok) { recomputeCache(); renderCategories(); toast(newName !== from ? '小类已重命名' : '小类提成已保存'); }
    else toast(r.error && r.error || '保存失败', true);
  }
  else if (action === 'del-sub') {
    const catObj = cache.categories.find(c => c.name === btn.dataset.cat);
    const subs = (catObj ? catObj.subs : []).filter(s => (typeof s === 'object' ? s.name : s) !== btn.dataset.sub);
    const r = await DB.setSubs(btn.dataset.cat, subs);
    if (r.ok) { recomputeCache(); renderCategories(); toast('小类已删除'); }
    else toast(r.error || '删除失败', true);
  }
  else if (action === 'reset-pw') {
    openResetPwModal(id);
  }
});

/* 重置密码弹窗（老板为他人设置新密码） */
function openResetPwModal(targetId) {
  const who = cache.users.find(u => u.id === targetId);
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.id = 'rpModal';
  mask.innerHTML = `
    <div class="modal">
      <div class="modal-title">重置密码 · ${esc(who ? who.name : '')}</div>
      <div class="muted" style="margin-bottom:10px;">为「${esc(who ? who.name : '')}」设置一个新的登录密码（至少 6 位），设置后对方用新密码登录。</div>
      <div class="field"><label>新密码</label><input id="rpNew" type="text" placeholder="至少 6 位" autocomplete="new-password" /></div>
      <div class="modal-err" id="rpErr"></div>
      <div class="modal-actions">
        <button class="btn ghost" id="rpCancel">取消</button>
        <button class="btn" id="rpSubmit">确认重置</button>
      </div>
    </div>`;
  document.body.appendChild(mask);
  const close = () => mask.remove();
  mask.addEventListener('click', e => { if (e.target === mask) close(); });
  $('#rpCancel').onclick = close;
  $('#rpSubmit').onclick = async () => {
    const pw = $('#rpNew').value;
    const err = $('#rpErr');
    err.textContent = '';
    if (pw.length < 6) return err.textContent = '新密码至少 6 位';
    const r = await DB.resetPassword(targetId, pw);
    if (r.ok) { close(); toast('已为 ' + (who ? who.name : '该人员') + ' 重置密码'); }
    else err.textContent = r.error || '重置失败';
  };
  setTimeout(() => { const el = $('#rpNew'); if (el) el.focus(); }, 50);
}
/* 归属门店变化 → 同步刷新归属店员下拉 */
document.addEventListener('change', e => {
  const sel = e.target.closest('.ed-store');
  if (!sel) return;
  const rid = sel.dataset.rid;
  const storeId = sel.value;
  const clerkSel = document.querySelector('.ed-clerk[data-rid="' + rid + '"]');
  if (!clerkSel) return;
  const clerks = cache.users.filter(u => u.role === 'clerk' && u.active && u.storeId === storeId);
  clerkSel.innerHTML = clerks.map(u => `<option value="${u.id}">${esc(u.name)}</option>`).join('');
});
/* 选中小类时，若该小类设有“售价”，自动把金额预填为售价（仅当金额框为空，避免覆盖手动输入） */
function findSubAnywhere(name) {
  for (const c of (cache.categories || [])) {
    const s = (c.subs || []).find(x => subNameOf(x) === name);
    if (s) return { cat: c, sub: s };
  }
  return null;
}
function autoFillPriceFromSub(subInput, catSelId, amtId, force) {
  const cat = document.getElementById(catSelId);
  const amt = document.getElementById(amtId);
  if (!cat || !amt) return;
  const subName = (subInput.value || '').trim();
  if (!subName) return;
  let found = null;
  const selCat = (cache.categories || []).find(c => c.name === cat.value);
  if (selCat) found = (selCat.subs || []).find(x => subNameOf(x) === subName);
  if (!found) {
    const r = findSubAnywhere(subName);
    if (r) { found = r.sub; if (cat.value !== r.cat.name) cat.value = r.cat.name; }
  }
  if (!found || typeof found !== 'object') return;
  /* 会员支付时优先带出会员价，否则带出普通售价（仅当金额框为空或强制时） */
  const payId = amtId === 'crAmount' ? 'crPay' : (amtId === 'mrAmount' ? 'mrPay' : null);
  const payInput = payId ? document.getElementById(payId) : null;
  const isMemberPay = payInput && (payInput.value || '').trim() === '会员';
  const memberPrice = Number(found.memberPrice) || 0;
  const price = Number(found.price) || 0;
  if (isMemberPay && memberPrice > 0) { if (force || !amt.value) amt.value = memberPrice; return; }
  if (price > 0 && (force || !amt.value)) amt.value = price;
}
/* 根据小类/门店提成规则计算预计提成；并回传小类在老板后台配置的售价与提成规则 */
function calcCommissionPreview(amount, catName, subName, storeId) {
  const store = (cache.stores || []).find(s => s.id === storeId) || null;
  let rate = 0, fixed = 0, source = '门店默认', subPrice = null, subRule = null;
  if (catName && subName) {
    const c = (cache.categories || []).find(c => c.name === catName);
    if (c) {
      const s = (c.subs || []).find(x => subNameOf(x) === subName);
      if (s && typeof s === 'object') {
        subPrice = (Number(s.price) > 0) ? Number(s.price) : null;
        if (Number(s.rate) > 0 || Number(s.fixed) > 0) {
          rate = Number(s.rate) || 0;
          fixed = Number(s.fixed) || 0;
          source = `小类「${s.name}」`;
          const pct = rate ? '比例 ' + (Math.round(rate * 10000) / 100) + '%' : '';
          subRule = `${pct}${fixed ? (rate ? ' + ' : '') + '固定 ' + money(fixed) : ''}`;
        }
      }
    }
  }
  if (source === '门店默认' && store) {
    rate = Number(store.commissionRate) || 0;
    fixed = Number(store.commissionFixed) || 0;
  }
  const commission = Math.round((amount * rate + fixed) * 100) / 100;
  return { commission, rate, fixed, source, subPrice, subRule };
}
function updateCommissionHint(catSelId, subInputId, amtId, hintId, storeId) {
  const cat = document.getElementById(catSelId);
  const sub = document.getElementById(subInputId);
  const amt = document.getElementById(amtId);
  const hint = document.getElementById(hintId);
  if (!hint || !amt) return;
  const subName = (sub.value || '').trim();
  const amount = parseFloat(amt.value);
  if (!cat || !sub || !subName) { hint.textContent = ''; return; }
  const { commission, source, subPrice, subRule } = calcCommissionPreview(amount || 0, cat.value, subName, storeId);
  /* 会员支付时用会员价替换售价展示 */
  const payId = amtId === 'crAmount' ? 'crPay' : (amtId === 'mrAmount' ? 'mrPay' : null);
  const payInput = payId ? document.getElementById(payId) : null;
  const isMemberPay = payInput && (payInput.value || '').trim() === '会员';
  let shownPrice = subPrice, priceLabel = '售价';
  if (isMemberPay) {
    const c = (cache.categories || []).find(x => x.name === cat.value);
    const s = c && (c.subs || []).find(x => subNameOf(x) === subName);
    const mp = (s && typeof s === 'object') ? (Number(s.memberPrice) || 0) : 0;
    if (mp > 0) { shownPrice = mp; priceLabel = '会员价'; }
  }
  const bits = [];
  if (shownPrice != null) bits.push(`${priceLabel} <b>${money(shownPrice)}</b>`);
  if (subRule) bits.push(`提成规则 <b>${subRule}</b>`);
  else if (shownPrice != null) bits.push(`提成按门店默认`);
  const head = bits.length ? `【${esc(subName)}】${bits.join(' · ')}　` : '';
  if (isNaN(amount) || amount <= 0) {
    hint.innerHTML = head ? head + `（填入金额后自动算提成）` : '';
    return;
  }
  const rateText = (source === '门店默认') ? '门店默认规则' : '小类规则';
  hint.innerHTML = head + `预计提成：<b>${money(commission)}</b>（${rateText}）`;
}
function getCurrentStoreId() {
  if (me.role === 'clerk') return me.storeId;
  if (me.role === 'manager') { const st = cache.stores[0]; return st ? st.id : null; }
  return null;
}
/* 小类搜索下拉 */
function getSubItems(catName) {
  const map = new Map();
  (cache.categories || []).forEach(c => {
    if (catName && c.name !== catName) return;
    (c.subs || []).forEach(s => {
      const name = subNameOf(s);
      if (!name || map.has(name)) return;
      let price = null, rule = '', mprice = null;
      if (typeof s === 'object') {
        if (Number(s.price) > 0) price = Number(s.price);
        if (Number(s.memberPrice) > 0) mprice = Number(s.memberPrice);
        const rate = Number(s.rate) || 0, fixed = Number(s.fixed) || 0;
        if (rate || fixed) {
          const pct = rate ? '比例 ' + (Math.round(rate * 10000) / 100) + '%' : '';
          rule = pct + (fixed ? (rate ? ' + ' : '') + '固定 ' + money(fixed) : '');
        }
      }
      map.set(name, { name, price, mprice, rule, category: c.name });
    });
  });
  return Array.from(map.values());
}
function renderSubDropdown(dropdown, catName, filter) {
  const items = getSubItems(catName).filter(i => i.name.toLowerCase().includes((filter || '').toLowerCase()));
  if (!items.length) { dropdown.innerHTML = '<div class="sub-search-empty">无匹配小类</div>'; return; }
  dropdown.innerHTML = items.map(i => `
    <div class="sub-search-item" data-name="${esc(i.name)}" data-category="${esc(i.category)}">
      <div class="ssi-name">${esc(i.name)} <span class="ssi-cat">${esc(i.category)}</span></div>
      <div class="ssi-meta">${i.price != null ? '售价 ' + money(i.price) : ''}${i.price != null && i.mprice != null ? ' · ' : ''}${i.mprice != null ? '会员价 ' + money(i.mprice) : ''}${i.price != null || i.mprice != null ? (i.rule ? ' · ' : '') : ''}${i.rule || '按门店默认提成'}</div>
    </div>`).join('');
}
function closeSubDropdown(dropdownId) {
  const dropdown = document.getElementById(dropdownId);
  if (dropdown) dropdown.classList.remove('open');
}
function applySubSelection(inputId, catSelId, amtId, hintId, storeId, name, category) {
  const input = document.getElementById(inputId);
  const catSel = document.getElementById(catSelId);
  if (!input) return;
  input.value = name;
  if (catSel && category && catSel.value !== category) catSel.value = category;
  closeSubDropdown(inputId.replace('Sub', 'SubDropdown'));
  autoFillPriceFromSub(input, catSelId, amtId, true);
  updateCommissionHint(catSelId, inputId, amtId, hintId, storeId);
}
function ensureSubDropdownOpen(inputId, dropdownId, catSelId, filter) {
  const input = document.getElementById(inputId);
  const dropdown = document.getElementById(dropdownId);
  const cat = document.getElementById(catSelId);
  if (!input || !dropdown) return;
  renderSubDropdown(dropdown, cat ? cat.value : '', filter);
  dropdown.classList.add('open');
}
document.addEventListener('focusin', e => {
  const input = e.target.closest('#crSub, #mrSub');
  if (!input) return;
  if (input.id === 'crSub') ensureSubDropdownOpen('crSub', 'crSubDropdown', 'crCat', '');
  else ensureSubDropdownOpen('mrSub', 'mrSubDropdown', 'mrCat', '');
});
document.addEventListener('click', e => {
  const input = e.target.closest('#crSub, #mrSub');
  if (!input) return;
  if (input.id === 'crSub') ensureSubDropdownOpen('crSub', 'crSubDropdown', 'crCat', '');
  else ensureSubDropdownOpen('mrSub', 'mrSubDropdown', 'mrCat', '');
});
document.addEventListener('input', e => {
  const input = e.target.closest('#crSub, #mrSub');
  if (!input) return;
  if (input.id === 'crSub') ensureSubDropdownOpen('crSub', 'crSubDropdown', 'crCat', input.value);
  else ensureSubDropdownOpen('mrSub', 'mrSubDropdown', 'mrCat', input.value);
});
document.addEventListener('mousedown', e => {
  const item = e.target.closest('.sub-search-item');
  if (item) {
    const wrap = item.closest('.sub-search');
    const input = wrap ? wrap.querySelector('.sub-search-input') : null;
    if (!input) return;
    const name = item.dataset.name;
    const category = item.dataset.category;
    if (input.id === 'crSub') applySubSelection('crSub', 'crCat', 'crAmount', 'crCommissionHint', getCurrentStoreId(), name, category);
    else applySubSelection('mrSub', 'mrCat', 'mrAmount', 'mrCommissionHint', getCurrentStoreId(), name, category);
    e.preventDefault();
    return;
  }
  if (!e.target.closest('.sub-search')) {
    closeSubDropdown('crSubDropdown');
    closeSubDropdown('mrSubDropdown');
  }
});
document.addEventListener('keydown', e => {
  const input = e.target.closest('#crSub, #mrSub');
  if (!input) return;
  const dropdownId = input.id === 'crSub' ? 'crSubDropdown' : 'mrSubDropdown';
  const dropdown = document.getElementById(dropdownId);
  if (e.key === 'Escape') { if (dropdown) dropdown.classList.remove('open'); return; }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    ensureSubDropdownOpen(input.id, dropdownId, input.id === 'crSub' ? 'crCat' : 'mrCat', '');
    return;
  }
});
document.addEventListener('focusout', e => {
  const input = e.target.closest('#crSub, #mrSub');
  if (!input) return;
  const dropdownId = input.id === 'crSub' ? 'crSubDropdown' : 'mrSubDropdown';
  setTimeout(() => {
    const dropdown = document.getElementById(dropdownId);
    const active = document.activeElement;
    if (dropdown && active !== input && !dropdown.contains(active)) dropdown.classList.remove('open');
  }, 120);
});
document.addEventListener('change', e => {
  const sub = e.target.closest('#crSub, #mrSub');
  if (sub) {
    if (sub.id === 'crSub') autoFillPriceFromSub(sub, 'crCat', 'crAmount');
    else autoFillPriceFromSub(sub, 'mrCat', 'mrAmount');
    updateCommissionHint('crCat', 'crSub', 'crAmount', 'crCommissionHint', getCurrentStoreId());
    updateCommissionHint('mrCat', 'mrSub', 'mrAmount', 'mrCommissionHint', getCurrentStoreId());
  }
  if (e.target.closest('#crAmount, #mrAmount')) {
    updateCommissionHint('crCat', 'crSub', 'crAmount', 'crCommissionHint', getCurrentStoreId());
    updateCommissionHint('mrCat', 'mrSub', 'mrAmount', 'mrCommissionHint', getCurrentStoreId());
  }
  if (e.target.closest('#crCat, #mrCat')) {
    const isCr = e.target.id === 'crCat';
    const subInput = document.getElementById(isCr ? 'crSub' : 'mrSub');
    if (subInput) subInput.value = '';
    closeSubDropdown(isCr ? 'crSubDropdown' : 'mrSubDropdown');
    updateCommissionHint('crCat', 'crSub', 'crAmount', 'crCommissionHint', getCurrentStoreId());
    updateCommissionHint('mrCat', 'mrSub', 'mrAmount', 'mrCommissionHint', getCurrentStoreId());
  }
});
document.addEventListener('input', e => {
  if (e.target.closest('#crAmount, #mrAmount')) {
    updateCommissionHint('crCat', 'crSub', 'crAmount', 'crCommissionHint', getCurrentStoreId());
    updateCommissionHint('mrCat', 'mrSub', 'mrAmount', 'mrCommissionHint', getCurrentStoreId());
  }
});
document.addEventListener('keydown', e => {
  const addInp = e.target.closest('.sub-input');
  if (addInp && e.key === 'Enter') {
    e.preventDefault();
    const card = addInp.closest('.cat-card');
    const btn = card ? card.querySelector('[data-action="add-sub"]') : null;
    if (btn) btn.click();
    return;
  }
  const nameInp = e.target.closest('.sub-name-input');
  if (nameInp && e.key === 'Enter') {
    e.preventDefault();
    const row = nameInp.closest('.sub-row');
    const btn = row ? row.querySelector('[data-action="save-sub"]') : null;
    if (btn) btn.click();
  }
});

/* 支付方式搜索下拉（与「小类」同款体验） */
function renderPayDropdown(dropdown, filter) {
  const items = PAY_METHODS.filter(p => p.toLowerCase().includes((filter || '').toLowerCase()));
  if (!items.length) { dropdown.innerHTML = '<div class="pay-search-empty">无匹配支付方式</div>'; return; }
  dropdown.innerHTML = items.map(p => `<div class="pay-search-item" data-name="${esc(p)}">${esc(p)}</div>`).join('');
}
function ensurePayDropdownOpen(inputId, dropdownId, filter) {
  const input = document.getElementById(inputId);
  const dropdown = document.getElementById(dropdownId);
  if (!input || !dropdown) return;
  renderPayDropdown(dropdown, filter);
  dropdown.classList.add('open');
}
function applyPaySelection(inputId, name) {
  const input = document.getElementById(inputId);
  if (!input) return;
  input.value = name;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  closePayDropdown(inputId === 'crPay' ? 'crPayDropdown' : 'mrPayDropdown');
}
function closePayDropdown(dropdownId) {
  const dropdown = document.getElementById(dropdownId);
  if (dropdown) dropdown.classList.remove('open');
}
document.addEventListener('focusin', e => {
  const input = e.target.closest('#crPay, #mrPay');
  if (!input) return;
  const dropdownId = input.id === 'crPay' ? 'crPayDropdown' : 'mrPayDropdown';
  ensurePayDropdownOpen(input.id, dropdownId, '');
});
document.addEventListener('click', e => {
  const input = e.target.closest('#crPay, #mrPay');
  if (!input) return;
  const dropdownId = input.id === 'crPay' ? 'crPayDropdown' : 'mrPayDropdown';
  ensurePayDropdownOpen(input.id, dropdownId, '');
});
document.addEventListener('input', e => {
  const input = e.target.closest('#crPay, #mrPay');
  if (!input) return;
  const dropdownId = input.id === 'crPay' ? 'crPayDropdown' : 'mrPayDropdown';
  ensurePayDropdownOpen(input.id, dropdownId, input.value);
});
document.addEventListener('mousedown', e => {
  const item = e.target.closest('.pay-search-item');
  if (item) {
    const wrap = item.closest('.pay-search');
    const input = wrap ? wrap.querySelector('.sub-search-input') : null;
    if (!input) return;
    applyPaySelection(input.id, item.dataset.name);
    e.preventDefault();
    return;
  }
  if (!e.target.closest('#crPayWrap, #mrPayWrap, .pay-search-item')) {
    closePayDropdown('crPayDropdown');
    closePayDropdown('mrPayDropdown');
  }
});
/* 会员搜索下拉选择 */
document.addEventListener('mousedown', e => {
  const item = e.target.closest('.member-item');
  if (item) {
    const wrap = item.closest('.member-search');
    const selId = wrap ? wrap.id.replace(/Wrap$/, '') : '';
    const sel = selId ? document.getElementById(selId) : null;
    const input = selId ? document.getElementById(selId + 'Input') : null;
    const dropdown = selId ? document.getElementById(selId + 'Dropdown') : null;
    const id = item.dataset.id;
    const m = (cache.members || []).find(x => x.id === id);
    if (sel) sel.value = id;
    if (input) input.value = m ? m.name : '';
    if (dropdown) dropdown.classList.remove('open');
    e.preventDefault();
    return;
  }
  if (!e.target.closest('.member-search')) {
    ['crMemberDropdown', 'mrMemberDropdown'].forEach(d => { const el = document.getElementById(d); if (el) el.classList.remove('open'); });
  }
});
document.addEventListener('keydown', e => {
  const input = e.target.closest('#crPay, #mrPay');
  if (!input) return;
  const dropdownId = input.id === 'crPay' ? 'crPayDropdown' : 'mrPayDropdown';
  if (e.key === 'Escape') { const d = document.getElementById(dropdownId); if (d) d.classList.remove('open'); }
});
document.addEventListener('focusout', e => {
  const input = e.target.closest('#crPay, #mrPay');
  if (!input) return;
  const dropdownId = input.id === 'crPay' ? 'crPayDropdown' : 'mrPayDropdown';
  setTimeout(() => {
    const dropdown = document.getElementById(dropdownId);
    const active = document.activeElement;
    if (dropdown && active !== input && !dropdown.contains(active)) dropdown.classList.remove('open');
  }, 120);
});

/* ----------------------------- 启动 ----------------------------- */
(async function init() {
  try {
    if (checkAccessMode()) return;
    upgradeUrlToVersioned();
    checkNewVersion();
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkNewVersion(); });
    setInterval(checkNewVersion, 5 * 60 * 1000);
    await DB.init(() => {
      if (me) { recomputeCache(); render(); }
      else updateLive();
    });
    me = DB.getCurrentUser();
    recomputeCache();
    updateLive();
    if (me) render();
    else renderLogin();
  } catch (err) {
    showFatal((err && err.message) || String(err));
  }
})();
