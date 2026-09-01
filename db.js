'use strict';
/*
 * db.js —— 纯前端数据层 + MQTT 实时同步
 * 把原 server.js 的存储 / 权限 / 提成计算 / 汇总 / 鉴权 / 导出 全部移植到浏览器端。
 * 多端通过公共 MQTT broker（broker.emqx.io，WebSocket）按「门店空间(room)」同步全量状态。
 * 注意：此为演示级架构，数据经公共 broker 中转，非敏感内部数据可接受；请勿用于机密业务。
 */
window.DB = (function () {
  const BROKER = 'wss://broker.emqx.io:8084/mqtt';
  const rand = () => Math.random().toString(36).slice(2, 10);

  let room = null;
  let state = null;            // { version, ts, db }
  let client = null;
  let updateCb = null;

  const lsKey = () => 'wb_shop_' + room;
  const lsUserKey = () => 'wb_user_' + room;

  /* ----------------------------- 密码（演示级 SHA-256） ----------------------------- */
  async function hashPassword(pw) {
    const enc = new TextEncoder().encode(pw);
    const buf = await crypto.subtle.digest('SHA-256', enc);
    return 'sha256:' + [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  async function verifyPassword(pw, stored) {
    if (!stored || !stored.startsWith('sha256:')) return false;
    return (await hashPassword(pw)) === stored;
  }

  /* ----------------------------- 种子数据（贴合用户当前门店类目） ----------------------------- */
  function defaultCategories() {
    return [
      { name: '头疗', subs: [{ name: '生姜', rate: 0, fixed: 35, price: 109, memberPrice: 99 }, { name: '草本', rate: 0, fixed: 35, price: 109, memberPrice: 99 }, { name: '速洗', rate: 0, fixed: 20, price: 68.8, memberPrice: 58.8 }] },
      { name: '脸', subs: [{ name: '脸', rate: 0, fixed: 40, price: 109, memberPrice: 99 }, { name: '脸（加班）', rate: 0.5, fixed: 0, price: 109, memberPrice: 99 }] },
      { name: '采耳', subs: [{ name: '30分钟', rate: 0, fixed: 30, price: 86, memberPrice: 76 }, { name: '30分钟（加班）', rate: 0.5, fixed: 0, price: 86, memberPrice: 76 }] },
      { name: '组合', subs: [{ name: '头+脸', rate: 0, fixed: 65, price: 194, memberPrice: 174 }, { name: '头+肩', rate: 0, fixed: 65, price: 194, memberPrice: 174 }, { name: '头+采耳', rate: 0, fixed: 65, price: 194, memberPrice: 174 }] },
      { name: '其他', subs: [] }
    ];
  }
  async function seedDB() {
    const d = { regions: [{ id: 'r1', name: '华东大区' }], stores: [], users: [], records: [], members: [], categories: defaultCategories() };
    d.stores.push({ id: 's1', name: '门店A（旗舰店）', commissionRate: 0.10, commissionFixed: 0, regionId: 'r1' });
    d.stores.push({ id: 's2', name: '门店B（社区店）', commissionRate: 0.12, commissionFixed: 0, regionId: 'r1' });
    const add = async (username, password, name, role, opts) => {
      opts = opts || {};
      d.users.push({
        id: 'u_' + rand(), username, password: await hashPassword(password), name, role,
        storeId: opts.storeId || null, regionId: opts.regionId || null, active: true,
        createdAt: new Date().toISOString()
      });
    };
    await add('boss', 'boss123', '陈俊杰（老板）', 'boss', {});
    await add('reg1', 'reg123', '王总（华东区域经理）', 'regional', { regionId: 'r1' });
    await add('mgrA', 'mgr123', '张店长', 'manager', { storeId: 's1' });
    await add('mgrB', 'mgr123', '李店长', 'manager', { storeId: 's2' });
    await add('clerkA1', 'clerk123', '小王', 'clerk', { storeId: 's1' });
    await add('clerkA2', 'clerk123', '小赵', 'clerk', { storeId: 's1' });
    await add('clerkB1', 'clerk123', '小钱', 'clerk', { storeId: 's2' });
    await add('clerkB2', 'clerk123', '小孙', 'clerk', { storeId: 's2' });
    return d;
  }

  /* ----------------------------- 本地持久化 ----------------------------- */
  function saveLocal() { try { localStorage.setItem(lsKey(), JSON.stringify(state)); } catch (e) {} }
  function loadLocal() {
    try { const s = localStorage.getItem(lsKey()); if (s) return JSON.parse(s); } catch (e) {}
    return null;
  }

  /* ----------------------------- 业务函数 ----------------------------- */
  function getDB() { return state.db; }
  function getStore(id) { return state.db.stores.find(s => s.id === id) || null; }
  function findUser(id) { return state.db.users.find(u => u.id === id) || null; }
  function findSubCategory(category, subName) {
    if (!category || !subName) return null;
    const cat = state.db.categories.find(c => c.name === category);
    if (!cat) return null;
    const sub = (cat.subs || []).find(s => (typeof s === 'object' ? s.name : s) === subName);
    if (!sub) return null;
    return typeof sub === 'object' ? sub : { name: sub, rate: 0, fixed: 0, price: 0 };
  }
  function calcCommission(amount, store, sub) {
    let rate = Number(store && store.commissionRate) || 0;
    let fixed = Number(store && store.commissionFixed) || 0;
    if (sub && (Number(sub.rate) > 0 || Number(sub.fixed) > 0)) { rate = Number(sub.rate) || 0; fixed = Number(sub.fixed) || 0; }
    return Math.round((amount * rate + fixed) * 100) / 100;
  }
  function publicUser(u) {
    const st = u.storeId ? getStore(u.storeId) : null;
    return { id: u.id, username: u.username, name: u.name, role: u.role, storeId: u.storeId, storeName: st ? st.name : null, regionId: u.regionId, active: u.active };
  }
  function accessibleStores(user) {
    if (user.role === 'boss') return state.db.stores;
    if (user.role === 'regional') return state.db.stores.filter(s => s.regionId === user.regionId);
    if (user.role === 'manager') { const s = getStore(user.storeId); return s ? [s] : []; }
    return [];
  }
  function filterRecords(records, user) {
    if (user.role === 'boss') return records;
    if (user.role === 'regional') { const ids = new Set(accessibleStores(user).map(s => s.id)); return records.filter(r => ids.has(r.storeId)); }
    if (user.role === 'manager') return records.filter(r => r.storeId === user.storeId);
    return records.filter(r => r.clerkId === user.id);
  }
  function filterUsers(users, user) {
    if (user.role === 'boss') return users;
    if (user.role === 'regional') { const ids = new Set(accessibleStores(user).map(s => s.id)); return users.filter(u => u.id === user.id || (u.storeId && ids.has(u.storeId))); }
    if (user.role === 'manager') return users.filter(u => u.storeId === user.storeId);
    return users.filter(u => u.id === user.id);
  }
  function accessibleRegions(user) {
    if (user.role === 'boss') return state.db.regions;
    if (user.role === 'regional') return state.db.regions.filter(r => r.id === user.regionId);
    return [];
  }
  function applyTimeFilter(records, range) {
    if (!range) return records;
    let out = records;
    if (range.month) out = out.filter(r => (r.date || '').slice(0, 7) === range.month);
    if (range.from) out = out.filter(r => (r.date || '') >= range.from);
    if (range.to) out = out.filter(r => (r.date || '') <= range.to);
    return out;
  }
  function computeSummary(user, range) {
    const stores = accessibleStores(user);
    const users = filterUsers(state.db.users, user);
    let records = filterRecords(state.db.records, user);
    records = applyTimeFilter(records, range);
    const totalSales = records.reduce((s, r) => s + r.amount, 0);
    const totalCommission = records.reduce((s, r) => s + r.commission, 0);
    const byStore = stores.map(st => {
      const rs = records.filter(r => r.storeId === st.id);
      return { id: st.id, name: st.name, sales: rs.reduce((s, r) => s + r.amount, 0), commission: rs.reduce((s, r) => s + r.commission, 0), count: rs.length, clerks: state.db.users.filter(u => u.storeId === st.id && u.role === 'clerk' && u.active).length };
    });
    const byClerk = users.filter(u => u.role === 'clerk').map(cl => {
      const rs = records.filter(r => r.clerkId === cl.id);
      return { id: cl.id, name: cl.name, storeId: cl.storeId, sales: rs.reduce((s, r) => s + r.amount, 0), commission: rs.reduce((s, r) => s + r.commission, 0), count: rs.length };
    });
    const catMap = {};
    for (const r of records) {
      const k = (r.category && r.category.trim()) || '未分类';
      if (!catMap[k]) catMap[k] = { name: k, sales: 0, commission: 0, count: 0, subs: {} };
      catMap[k].sales += r.amount; catMap[k].commission += r.commission; catMap[k].count += 1;
      const sk = (r.subCategory && r.subCategory.trim()) || '—';
      if (!catMap[k].subs[sk]) catMap[k].subs[sk] = { name: sk, sales: 0, count: 0 };
      catMap[k].subs[sk].sales += r.amount; catMap[k].subs[sk].count += 1;
    }
    const byCategory = Object.values(catMap).sort((a, b) => b.sales - a.sales).map(c => ({ name: c.name, sales: c.sales, commission: c.commission, count: c.count, subs: Object.values(c.subs).sort((a, b) => b.sales - a.sales) }));
    return { totalSales, totalCommission, recordCount: records.length, clerkCount: users.filter(u => u.role === 'clerk' && u.active).length, byStore, byClerk, byCategory };
  }

  /* ----------------------------- 登录 / 当前用户 ----------------------------- */
  function getCurrentUser() {
    const id = localStorage.getItem(lsUserKey());
    if (!id) return null;
    const u = findUser(id);
    return u && u.active ? publicUser(u) : null;
  }
  async function login(username, password) {
    const u = state.db.users.find(x => x.username === username && x.active);
    if (!u) return { ok: false, error: '用户名或密码错误' };
    if (!(await verifyPassword(password, u.password))) return { ok: false, error: '用户名或密码错误' };
    localStorage.setItem(lsUserKey(), u.id);
    return { ok: true, user: publicUser(u) };
  }
  function logout() { localStorage.removeItem(lsUserKey()); }
  async function changePassword(current, next) {
    const u = findUser(localStorage.getItem(lsUserKey()));
    if (!u) return { ok: false, error: '未登录' };
    if (!(await verifyPassword(current, u.password))) return { ok: false, error: '当前密码不正确' };
    if (next.length < 6) return { ok: false, error: '新密码至少 6 位' };
    u.password = await hashPassword(next);
    publishState();
    return { ok: true };
  }
  async function resetPassword(targetId, pw) {
    const u = findUser(targetId);
    if (!u) return { ok: false, error: '人员不存在' };
    if (pw.length < 6) return { ok: false, error: '新密码至少 6 位' };
    u.password = await hashPassword(pw);
    publishState();
    return { ok: true };
  }

  /* ----------------------------- 变更操作（改后 publishState） ----------------------------- */
  function publishState() {
    state.version = (state.version || 0) + 1;
    state.ts = Date.now();
    saveLocal();
    if (client && client.connected) {
      client.publish('shop/' + room + '/state', JSON.stringify(state), { qos: 0, retain: true });
    }
    if (updateCb) updateCb();
  }
  async function addRegion(name) {
    if (getCurrentUser().role !== 'boss') return { ok: false, error: '无权限' };
    state.db.regions.push({ id: 'r_' + rand(), name }); publishState(); return { ok: true };
  }
  async function deleteRegion(id) {
    if (getCurrentUser().role !== 'boss') return { ok: false, error: '无权限' };
    if (state.db.stores.some(s => s.regionId === id)) return { ok: false, error: '该区域仍有门店，无法删除' };
    state.db.regions = state.db.regions.filter(r => r.id !== id); publishState(); return { ok: true };
  }
  async function addStore(body) {
    const me = getCurrentUser();
    if (me.role !== 'boss' && me.role !== 'regional') return { ok: false, error: '无权限' };
    let regionId = null;
    if (me.role === 'regional') regionId = me.regionId;
    else if (body.regionId) { const reg = state.db.regions.find(r => r.id === body.regionId); if (reg) regionId = reg.id; }
    state.db.stores.push({ id: 's_' + rand(), name: body.name, commissionRate: Number(body.commissionRate) || 0.1, commissionFixed: Number(body.commissionFixed) || 0, regionId });
    publishState(); return { ok: true };
  }
  async function updateStore(id, body) {
    const me = getCurrentUser(); const st = getStore(id); if (!st) return { ok: false };
    if (me.role === 'regional' && st.regionId !== me.regionId) return { ok: false, error: '无权限' };
    if (me.role !== 'boss' && me.role !== 'regional') return { ok: false, error: '无权限' };
    if (body.name !== undefined) st.name = String(body.name).trim() || st.name;
    if (body.commissionRate !== undefined) { const r = Number(body.commissionRate); if (!isNaN(r)) st.commissionRate = r; }
    if (body.commissionFixed !== undefined) { const f = Number(body.commissionFixed); if (!isNaN(f)) st.commissionFixed = f; }
    if (body.regionId !== undefined && me.role === 'boss') { const reg = state.db.regions.find(r => r.id === body.regionId); if (reg) st.regionId = reg.id; }
    publishState(); return { ok: true };
  }
  async function deleteStore(id) {
    const me = getCurrentUser(); const st = getStore(id); if (!st) return { ok: false };
    if (me.role === 'regional' && st.regionId !== me.regionId) return { ok: false, error: '无权限' };
    if (me.role !== 'boss' && me.role !== 'regional') return { ok: false, error: '无权限' };
    if (state.db.records.some(r => r.storeId === id)) return { ok: false, error: '该门店已有业绩记录，无法删除' };
    if (state.db.users.some(x => x.storeId === id && x.active)) return { ok: false, error: '该门店仍有在岗人员，无法删除' };
    state.db.stores = state.db.stores.filter(s => s.id !== id);
    state.db.users = state.db.users.filter(x => x.storeId !== id);
    publishState(); return { ok: true };
  }
  async function addUser(body) {
    const me = getCurrentUser();
    if (me.role !== 'boss' && me.role !== 'regional' && me.role !== 'manager') return { ok: false, error: '无权限' };
    if (!body.name || !body.username) return { ok: false, error: '姓名和账号必填' };
    if (state.db.users.some(x => x.username === body.username)) return { ok: false, error: '账号已存在' };
    let storeId = null, regionId = null;
    if (me.role === 'boss') {
      if (body.role === 'boss') { }
      else if (body.role === 'regional') { regionId = body.regionId || null; if (!regionId || !state.db.regions.find(r => r.id === regionId)) return { ok: false, error: '请选择有效区域' }; }
      else if (body.role === 'manager' || body.role === 'clerk') { storeId = body.storeId || null; if (!storeId || !getStore(storeId)) return { ok: false, error: '请选择有效门店' }; }
    } else if (me.role === 'regional') {
      if (body.role !== 'manager' && body.role !== 'clerk') return { ok: false, error: '仅可创建本大区店长/店员' };
      storeId = body.storeId || null; const s = storeId && getStore(storeId);
      if (!s || s.regionId !== me.regionId) return { ok: false, error: '门店须属于本大区' };
    } else { if (body.role !== 'clerk') return { ok: false, error: '无权限' }; storeId = me.storeId; }
    const nu = { id: 'u_' + rand(), username: body.username, password: await hashPassword(body.password || '123456'), name: body.name, role: body.role, storeId, regionId, active: true, createdAt: new Date().toISOString() };
    state.db.users.push(nu); publishState(); return { ok: true };
  }
  async function updateUser(id, body) {
    const me = getCurrentUser(); const t = findUser(id); if (!t) return { ok: false, error: '用户不存在' };
    if (me.role === 'boss') { }
    else if (me.role === 'regional') {
      const ids = new Set(accessibleStores(me).map(s => s.id));
      if (t.role === 'boss' || t.role === 'regional') return { ok: false, error: '无权限' };
      if (!t.storeId || !ids.has(t.storeId)) return { ok: false, error: '无权限' };
    } else if (me.role === 'manager' && t.storeId === me.storeId && t.role === 'clerk') { }
    else return { ok: false, error: '无权限' };
    if (body.name !== undefined) {
      const name = (body.name || '').trim();
      if (!name) return { ok: false, error: '姓名不能为空' };
      t.name = name;
    }
    publishState(); return { ok: true };
  }
  async function deleteUser(id) {
    const me = getCurrentUser(); const t = findUser(id); if (!t) return { ok: false, error: '用户不存在' };
    if (me.role === 'boss') { }
    else if (me.role === 'regional') {
      const ids = new Set(accessibleStores(me).map(s => s.id));
      if (t.id === me.id) return { ok: false, error: '不能删除自己' };
      if (t.role === 'boss' || t.role === 'regional') return { ok: false, error: '无权限' };
      if (!t.storeId || !ids.has(t.storeId)) return { ok: false, error: '无权限' };
    } else if (me.role === 'manager' && t.storeId === me.storeId && t.role === 'clerk') { }
    else return { ok: false, error: '无权限' };
    if (t.id === me.id) return { ok: false, error: '不能删除自己' };
    state.db.users = state.db.users.filter(u => u.id !== id); publishState(); return { ok: true };
  }
  async function addRecord(body) {
    const me = getCurrentUser();
    let storeId = (me.role === 'boss' || me.role === 'regional') ? body.storeId : me.storeId;
    if (!storeId) return { ok: false, error: '缺少门店' };
    const store = getStore(storeId); if (!store) return { ok: false, error: '门店无效' };
    if (me.role === 'regional' && store.regionId !== me.regionId) return { ok: false, error: '无权限' };
    if ((me.role === 'manager' || me.role === 'clerk') && storeId !== me.storeId) return { ok: false, error: '无权限操作其他门店' };
    let clerkId, clerkName;
    if (me.role === 'clerk') { clerkId = me.id; clerkName = me.name; }
    else { const clerk = state.db.users.find(x => x.id === body.clerkId && x.role === 'clerk' && x.storeId === storeId && x.active); if (!clerk) return { ok: false, error: '店员无效' }; clerkId = clerk.id; clerkName = clerk.name; }
    const amount = Number(body.amount); if (!(amount >= 0)) return { ok: false, error: '金额无效' };
    const date = (body.date || '').trim() || new Date().toISOString().slice(0, 10);
    const category = (body.category || '').toString().trim().slice(0, 30);
    const subCategory = (body.subCategory || '').toString().trim().slice(0, 50);
    const payMethod = (body.payMethod || '').toString().trim().slice(0, 10);
    let memberId = null, memberName = null;
    if (payMethod === '会员') {
      const mId = (body.memberId || '').toString().trim();
      const member = mId ? (state.db.members || []).find(x => x.id === mId) : null;
      if (!member) return { ok: false, error: '请选择有效会员' };
      if (member.storeId !== storeId) return { ok: false, error: '该会员不属于本门店' };
      if (member.balance < amount) return { ok: false, error: '会员余额不足（当前余额 ' + member.balance.toFixed(2) + ' 元）' };
      member.balance = Math.round((member.balance - amount) * 100) / 100;
      memberId = member.id; memberName = member.name;
    }
    const rec = { id: 'r_' + rand(), storeId, storeName: store.name, clerkId, clerkName, date, amount, category, subCategory, payMethod, memberId, memberName, commission: calcCommission(amount, store, findSubCategory(category, subCategory)), note: body.note || '', createdBy: me.id, createdAt: new Date().toISOString() };
    state.db.records.push(rec); publishState(); return { ok: true, record: rec };
  }
  async function updateRecord(id, body) {
    const me = getCurrentUser(); const rec = state.db.records.find(r => r.id === id); if (!rec) return { ok: false, error: '记录不存在' };
    const store = getStore(rec.storeId);
    const canEdit = me.role === 'boss' || (me.role === 'regional' && store && store.regionId === me.regionId) || (me.role === 'manager' && me.storeId === rec.storeId) || (me.role === 'clerk' && me.id === rec.clerkId);
    if (!canEdit) return { ok: false, error: '无权限' };
    // 先回退旧的会员扣款（避免与后续重扣重复）
    if (rec.memberId && rec.payMethod === '会员') {
      const oldM = (state.db.members || []).find(m => m.id === rec.memberId);
      if (oldM) oldM.balance = Math.round((oldM.balance + rec.amount) * 100) / 100;
    }
    if (body.date !== undefined) rec.date = String(body.date);
    if (body.storeId !== undefined && body.storeId !== rec.storeId) {
      if (me.role !== 'boss' && me.role !== 'regional') return { ok: false, error: '无权限修改归属门店' };
      const ns = getStore(body.storeId); if (!ns) return { ok: false, error: '门店无效' };
      if (me.role === 'regional' && ns.regionId !== me.regionId) return { ok: false, error: '无权限操作其他大区门店' };
      rec.storeId = ns.id; rec.storeName = ns.name;
    }
    if (body.clerkId !== undefined && body.clerkId !== rec.clerkId) {
      if (me.role !== 'boss' && me.role !== 'regional') return { ok: false, error: '无权限修改归属店员' };
      const clerk = state.db.users.find(x => x.id === body.clerkId && x.role === 'clerk' && x.active && x.storeId === rec.storeId);
      if (!clerk) return { ok: false, error: '该店员不属于本记录所属门店' };
      rec.clerkId = clerk.id; rec.clerkName = clerk.name;
    }
    if (body.amount !== undefined) { const a = Number(body.amount); if (a >= 0) rec.amount = a; }
    if (body.note !== undefined) rec.note = String(body.note);
    if (body.payMethod !== undefined) rec.payMethod = String(body.payMethod || '').trim().slice(0, 10);
    if (body.category !== undefined) rec.category = String(body.category || '').trim().slice(0, 30);
    if (body.subCategory !== undefined) rec.subCategory = String(body.subCategory || '').trim().slice(0, 50);
    if (body.memberId !== undefined) rec.memberId = (body.memberId || '').toString().trim() || null;
    // 若最终为会员支付且关联了会员，重新扣减余额
    if (rec.payMethod === '会员' && rec.memberId) {
      const m = (state.db.members || []).find(x => x.id === rec.memberId);
      if (!m) return { ok: false, error: '会员不存在' };
      if (m.balance < rec.amount) return { ok: false, error: '会员余额不足（当前余额 ' + m.balance.toFixed(2) + ' 元），无法保存' };
      m.balance = Math.round((m.balance - rec.amount) * 100) / 100;
      rec.memberName = m.name;
    } else { rec.memberId = null; rec.memberName = null; }
    rec.commission = calcCommission(rec.amount, getStore(rec.storeId), findSubCategory(rec.category, rec.subCategory));
    publishState(); return { ok: true };
  }
  async function deleteRecord(id) {
    const me = getCurrentUser(); const rec = state.db.records.find(r => r.id === id); if (!rec) return { ok: false };
    const store = getStore(rec.storeId);
    const can = me.role === 'boss' || (me.role === 'regional' && store && store.regionId === me.regionId) || (me.role === 'manager' && me.storeId === rec.storeId) || (me.role === 'clerk' && me.id === rec.clerkId);
    if (!can) return { ok: false, error: '无权限' };
    // 删除会员消费记录时，回退会员余额
    if (rec.memberId && rec.payMethod === '会员') {
      const m = (state.db.members || []).find(x => x.id === rec.memberId);
      if (m) m.balance = Math.round((m.balance + rec.amount) * 100) / 100;
    }
    state.db.records = state.db.records.filter(r => r.id !== id); publishState(); return { ok: true };
  }
  async function addCategory(name) {
    if (getCurrentUser().role !== 'boss') return { ok: false, error: '无权限' };
    if (!name) return { ok: false, error: '大类名称必填' };
    if (state.db.categories.some(c => c.name === name)) return { ok: false, error: '该大类已存在' };
    state.db.categories.push({ name, subs: [] }); publishState(); return { ok: true };
  }
  async function renameCategory(oldName, newName) {
    if (getCurrentUser().role !== 'boss') return { ok: false, error: '无权限' };
    if (!newName || !newName.trim()) return { ok: false };
    newName = newName.trim();
    if (newName !== oldName && state.db.categories.some(c => c.name === newName)) return { ok: false, error: '该大类名已存在' };
    const cat = state.db.categories.find(c => c.name === oldName); if (!cat) return { ok: false, error: '大类不存在' };
    if (newName !== oldName) state.db.records.forEach(r => { if (r.category === oldName) r.category = newName; });
    cat.name = newName; publishState(); return { ok: true };
  }
  async function deleteCategory(name) {
    if (getCurrentUser().role !== 'boss') return { ok: false, error: '无权限' };
    state.db.categories = state.db.categories.filter(c => c.name !== name); publishState(); return { ok: true };
  }
  async function setSubs(catName, subs, renameSub) {
    if (getCurrentUser().role !== 'boss') return { ok: false, error: '无权限' };
    const cat = state.db.categories.find(c => c.name === catName); if (!cat) return { ok: false, error: '大类不存在' };
    cat.subs = subs;
    if (renameSub && renameSub.from != null && renameSub.to != null && String(renameSub.from) !== String(renameSub.to)) {
      const from = String(renameSub.from), to = String(renameSub.to).trim();
      state.db.records.forEach(r => { if (r.category === catName && r.subCategory === from) r.subCategory = to; });
    }
    publishState(); return { ok: true };
  }

  /* ----------------------------- 会员管理（门店储值卡） ----------------------------- */
  function canManageMember(me, m) {
    if (me.role === 'boss') return true;
    if (me.role === 'regional') { const s = getStore(m.storeId); return !!(s && s.regionId === me.regionId); }
    if (me.role === 'manager') return m.storeId === me.storeId;
    return false;
  }
  function getMembers(user) {
    const list = state.db.members || [];
    if (user.role === 'boss') return list;
    if (user.role === 'regional') { const ids = new Set(accessibleStores(user).map(s => s.id)); return list.filter(m => m.storeId && ids.has(m.storeId)); }
    if (user.role === 'manager') return list.filter(m => m.storeId === user.storeId);
    if (user.role === 'clerk') return list.filter(m => m.storeId === user.storeId); // 店员可看本店会员用于登记
    return [];
  }
  async function addMember(body) {
    const me = getCurrentUser();
    if (me.role !== 'boss' && me.role !== 'regional' && me.role !== 'manager') return { ok: false, error: '无权限' };
    if (!body || !body.name || !body.name.trim()) return { ok: false, error: '会员姓名必填' };
    let storeId = null;
    if (me.role === 'manager') storeId = me.storeId;
    else if (body.storeId) {
      const s = getStore(body.storeId);
      if (!s) return { ok: false, error: '门店无效' };
      if (me.role === 'regional' && s.regionId !== me.regionId) return { ok: false, error: '无权限' };
      storeId = s.id;
    }
    if (!storeId) return { ok: false, error: '请选择所属门店' };
    const balance = Number(body.balance);
    if (!(balance >= 0)) return { ok: false, error: '初始余额需为非负数字' };
    state.db.members = state.db.members || [];
    state.db.members.push({ id: 'm_' + rand(), name: String(body.name).trim(), phone: String(body.phone || '').trim(), balance: Math.round(balance * 100) / 100, storeId, createdAt: new Date().toISOString() });
    publishState(); return { ok: true };
  }
  async function updateMember(id, body) {
    const me = getCurrentUser(); const m = (state.db.members || []).find(x => x.id === id); if (!m) return { ok: false, error: '会员不存在' };
    if (!canManageMember(me, m)) return { ok: false, error: '无权限' };
    if (body.name !== undefined) { const n = String(body.name || '').trim(); if (!n) return { ok: false, error: '姓名不能为空' }; m.name = n; }
    if (body.phone !== undefined) m.phone = String(body.phone || '').trim();
    publishState(); return { ok: true };
  }
  async function rechargeMember(id, amount) {
    const me = getCurrentUser(); const m = (state.db.members || []).find(x => x.id === id); if (!m) return { ok: false, error: '会员不存在' };
    if (!canManageMember(me, m)) return { ok: false, error: '无权限' };
    const amt = Number(amount); if (!(amt > 0)) return { ok: false, error: '充值金额需大于 0' };
    m.balance = Math.round((m.balance + amt) * 100) / 100;
    publishState(); return { ok: true };
  }
  async function deleteMember(id) {
    const me = getCurrentUser(); const m = (state.db.members || []).find(x => x.id === id); if (!m) return { ok: false, error: '会员不存在' };
    if (!canManageMember(me, m)) return { ok: false, error: '无权限' };
    state.db.members = state.db.members.filter(x => x.id !== id);
    state.db.records.forEach(r => { if (r.memberId === id) r.memberId = null; }); // 保留消费记录，仅解除关联
    publishState(); return { ok: true };
  }

  /* ----------------------------- MQTT 同步 ----------------------------- */
  /* 状态迁移：老数据可能缺新加的字段（成员、价格等），同步/加载时自动补齐，防止 undefined.push 崩溃 */
  function migrateState() {
    if (!state) state = { version: 1, ts: Date.now(), db: {} };
    if (!state.db) state.db = {};
    if (!Array.isArray(state.db.members)) state.db.members = [];
    if (!Array.isArray(state.db.records)) state.db.records = [];
    if (!Array.isArray(state.db.users)) state.db.users = [];
    if (!Array.isArray(state.db.stores)) state.db.stores = [];
    if (!Array.isArray(state.db.regions)) state.db.regions = [];
    if (!Array.isArray(state.db.categories)) state.db.categories = defaultCategories();
  }
  function mergeIncoming(payload) {
    try {
      const inc = JSON.parse(payload);
      if (!inc || !inc.db) return;
      if (!state || inc.version > state.version) { state = inc; migrateState(); saveLocal(); if (updateCb) updateCb(); }
    } catch (e) {}
  }
  function connectMQTT() {
    if (typeof mqtt === 'undefined') { console.warn('mqtt lib 未加载'); return; }
    try {
      client = mqtt.connect(BROKER, { clientId: 'wb_' + rand() + Date.now(), clean: true, connectTimeout: 8000, reconnectPeriod: 3000 });
      client.on('connect', () => {
        client.subscribe('shop/' + room + '/state', { qos: 0 });
        if (state) client.publish('shop/' + room + '/state', JSON.stringify(state), { retain: true }); // 把本地未同步更新推上去
        if (updateCb) updateCb();
      });
      client.on('message', (topic, message) => { if (topic === 'shop/' + room + '/state') mergeIncoming(message.toString()); });
      client.on('error', () => {});
      client.on('close', () => {});
    } catch (e) {}
  }

  /* ----------------------------- 初始化 ----------------------------- */
  async function init(cb) {
    let roomParam = null;
    try {
      const u = new URL(location.href);
      roomParam = u.searchParams.get('room');
      if (!roomParam) { room = 'shop_' + rand(); u.searchParams.set('room', room); history.replaceState(null, '', u.toString()); }
      else room = roomParam;
    } catch (e) { room = room || 'shop_' + rand(); }
    updateCb = cb || null;
    const local = loadLocal();
    if (local && local.db) state = local;
    else { state = { version: 1, ts: Date.now(), db: await seedDB() }; saveLocal(); }
    migrateState();
    state.version = (state.version || 0) + 1; state.ts = Date.now(); saveLocal();
    connectMQTT();
    return state;
  }
  function getRoom() { return room; }
  function isConnected() { return !!(client && client.connected); }

  /* ----------------------------- Excel 导出（SheetJS） ----------------------------- */
  function buildExportRows(recs, user) {
    const isBossLike = (user.role === 'boss' || user.role === 'regional');
    const header = isBossLike
      ? ['日期', '门店', '店员', '大类', '小类', '支付方式', '业绩金额', '提成比例', '固定提成', '提成', '备注']
      : (user.role === 'manager'
        ? ['日期', '店员', '大类', '小类', '支付方式', '业绩金额', '提成比例', '固定提成', '提成', '备注']
        : ['日期', '大类', '小类', '支付方式', '业绩金额', '提成比例', '固定提成', '提成', '备注']);
    const rows = [header];
    const sorted = [...recs].sort((a, b) => (a.date + a.id).localeCompare(b.date + b.id));
    for (const r of sorted) {
      const st = getStore(r.storeId) || {};
      const rate = Number(st.commissionRate) || 0;
      const fixed = Number(st.commissionFixed) || 0;
      const cells = [r.date];
      if (isBossLike) cells.push(r.storeName || st.name || '');
      if (user.role !== 'clerk') cells.push(r.clerkName);
      cells.push(r.category || '', r.subCategory || '', r.payMethod || '', r.amount, rate, fixed, r.commission, r.note || '');
      rows.push(cells);
    }
    return rows;
  }
  let xlsxLoading = null;
  function ensureXLSX() {
    if (typeof XLSX !== 'undefined') return Promise.resolve(true);
    if (xlsxLoading) return xlsxLoading;
    xlsxLoading = new Promise(resolve => {
      const s = document.createElement('script');
      s.src = 'vendor/xlsx.full.min.js';
      s.onload = () => resolve(typeof XLSX !== 'undefined');
      s.onerror = () => resolve(false);
      document.head.appendChild(s);
    });
    return xlsxLoading;
  }
  async function exportXLSX(recs, user, month) {
    const ok = await ensureXLSX();
    if (!ok) { alert('Excel 导出组件加载失败，请检查网络后重试'); return; }
    const rows = buildExportRows(recs, user);
    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '业绩月报');
    XLSX.writeFile(wb, '业绩月报_' + (month || '全部') + '.xlsx');
  }
  async function exportMembers(members, stores, user) {
    const ok = await ensureXLSX();
    if (!ok) { alert('Excel 导出组件加载失败，请检查网络后重试'); return; }
    const storeName = id => { const s = (stores || []).find(x => x.id === id); return s ? s.name : ''; };
    const consumeMap = {};
    (state.db.records || []).forEach(r => {
      if (r.memberId && r.payMethod === '会员') consumeMap[r.memberId] = (consumeMap[r.memberId] || 0) + Number(r.amount || 0);
    });
    const rows = [['姓名', '手机号', '所属门店', '剩余金额(元)', '累计消费(元)', '创建日期']];
    const sorted = [...(members || [])].sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh'));
    for (const m of sorted) {
      rows.push([m.name, m.phone || '', storeName(m.storeId), m.balance, consumeMap[m.id] || 0, (m.createdAt || '').slice(0, 10)]);
    }
    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '会员信息');
    const tag = (user && user.role === 'manager') ? (user.storeName || '本店') : '全部';
    XLSX.writeFile(wb, '会员信息_' + tag + '.xlsx');
  }

  return {
    init, getRoom, isConnected, getCurrentUser, login, logout, changePassword, resetPassword,
    getDB, computeSummary, accessibleStores, filterRecords, filterUsers, accessibleRegions, getStore, findSubCategory, calcCommission, publicUser,
    addRegion, deleteRegion, addStore, updateStore, deleteStore, addUser, updateUser, deleteUser, addRecord, updateRecord, deleteRecord,
    addCategory, renameCategory, deleteCategory, setSubs, buildExportRows, exportXLSX, exportMembers,
    addMember, updateMember, rechargeMember, deleteMember, getMembers
  };
})();
