// ===== ระบบ POS ร้านอาหาร (frontend) =====
const $app = document.getElementById('app');
const $modal = document.getElementById('modal-root');
const $toast = document.getElementById('toast');

const state = {
  user: null,
  menu: [],
  accounts: [],
  kitchens: [],
  cart: [], // { menu_item_id, name, price, qty, note }
  orderType: 'dine_in',
  tableNo: '',
  discount: 0,
  category: 'ทั้งหมด',
  search: '',
};

// ---------- utils ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const baht = (n) => '฿' + Number(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const ORDER_TYPE = { dine_in: 'ทานที่ร้าน', takeaway: 'กลับบ้าน' };
const PAY = { cash: 'เงินสด', qr: 'สแกน QR' };

async function api(path, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeout || 30000);
  let res;
  try {
    res = await fetch('/api' + path, {
      method: opts.method || (opts.body ? 'POST' : 'GET'),
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: ctrl.signal,
    });
  } catch {
    const err = new Error('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ ตรวจสอบ Wi-Fi');
    err.retryable = true;
    throw err;
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/login') { state.user = null; render(); }
  if (!res.ok) {
    const err = new Error(data.error || 'เกิดข้อผิดพลาด');
    err.status = res.status;
    err.retryable = [502, 503, 504].includes(res.status);
    throw err;
  }
  return data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// ไม่ใช้ crypto.randomUUID เพราะใช้ไม่ได้บนหน้า http:// (iPad เปิดผ่าน IP ในร้าน)
const newRequestId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

let toastTimer;
function toast(msg, isErr = false) {
  $toast.textContent = msg;
  $toast.className = 'toast' + (isErr ? ' err' : '');
  $toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($toast.hidden = true), 2600);
}
const fail = (e) => toast(e.message, true);

let modalOnClose = null;
function openModal(html, { wide = false, onMount, onClose } = {}) {
  modalOnClose = null;
  $modal.innerHTML = `<div class="modal-backdrop"><div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">${html}</div></div>`;
  modalOnClose = onClose || null;
  const back = $modal.firstElementChild;
  back.addEventListener('mousedown', (e) => { if (e.target === back) closeModal(); });
  $modal.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeModal));
  const first = $modal.querySelector('input, select');
  if (first) setTimeout(() => first.focus(), 30);
  onMount?.($modal.querySelector('.modal'));
}
function closeModal() {
  const cb = modalOnClose;
  modalOnClose = null;
  $modal.innerHTML = '';
  cb?.();
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

function confirmBox(message, okText = 'ยืนยัน') {
  return new Promise((resolve) => {
    openModal(`<h3>ยืนยัน</h3><p>${esc(message)}</p>
      <div class="row"><span class="spacer"></span><button class="btn" data-close>ยกเลิก</button><button class="btn primary" id="cf-ok">${esc(okText)}</button></div>`,
    { onMount: (m) => {
      m.querySelector('#cf-ok').onclick = () => { closeModal(); resolve(true); };
      m.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => resolve(false)));
    } });
  });
}

// ---------- routing ----------
const ROUTES = {
  pos: { label: 'ขายหน้าร้าน', roles: ['admin', 'staff'], render: renderPOS },
  orders: { label: 'บิลวันนี้', roles: ['admin', 'staff'], render: renderOrders },
  menu: { label: 'จัดการเมนู', roles: ['admin'], render: renderMenuAdmin },
  users: { label: 'บัญชีผู้ใช้', roles: ['admin'], render: renderUsers },
  accounts: { label: 'บัญชี QR', roles: ['admin'], render: renderAccounts },
  reports: { label: 'สรุปยอดขาย', roles: ['admin'], render: renderReports },
};
const currentRoute = () => {
  const r = location.hash.replace('#/', '') || 'pos';
  return ROUTES[r] && ROUTES[r].roles.includes(state.user?.role) ? r : 'pos';
};
window.addEventListener('hashchange', () => render());

function render() {
  closeModal();
  if (!state.user) return renderLogin();
  const route = currentRoute();
  const links = Object.entries(ROUTES).filter(([, r]) => r.roles.includes(state.user.role))
    .map(([k, r]) => `<a href="#/${k}" class="${k === route ? 'active' : ''}">${r.label}</a>`).join('');
  $app.innerHTML = `
    <header class="topbar">
      <div class="logo">🍜 POS</div>
      <nav class="nav">${links}</nav>
      <span class="spacer"></span>
      <div class="user-chip">
        <span class="uname">${esc(state.user.display_name)}</span>
        <span class="badge ${state.user.role === 'admin' ? 'admin' : ''}">${state.user.role === 'admin' ? 'Admin' : 'Staff'}</span>
        <button class="btn sm" id="btn-pw" title="เปลี่ยนรหัสผ่าน">🔑<span class="lbl">เปลี่ยนรหัส</span></button>
        <button class="btn sm" id="btn-logout" title="ออกจากระบบ"><span class="lbl">ออกจากระบบ</span><span class="short">ออก</span></button>
      </div>
    </header>
    <main id="view"></main>`;
  document.getElementById('btn-logout').onclick = async () => { await api('/logout', { method: 'POST' }).catch(() => {}); state.user = null; state.cart = []; render(); };
  document.getElementById('btn-pw').onclick = changePasswordModal;
  ROUTES[route].render(document.getElementById('view'));
}

// ---------- login ----------
function renderLogin() {
  $app.innerHTML = `
    <div class="login-wrap">
      <form class="login-card form-grid" id="login-form">
        <div class="brand-mark">POS</div>
        <div><h1>เข้าสู่ระบบ</h1><div class="muted">ระบบขายหน้าร้านอาหาร</div></div>
        <label class="field">ชื่อผู้ใช้<input class="input" name="username" autocomplete="username" required></label>
        <label class="field">รหัสผ่าน<input class="input" name="password" type="password" autocomplete="current-password" required></label>
        <div class="error" id="login-err"></div>
        <button class="btn primary lg block" type="submit">เข้าสู่ระบบ</button>
      </form>
    </div>`;
  const form = document.getElementById('login-form');
  form.username.focus();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      state.user = await api('/login', { body: { username: form.username.value, password: form.password.value } });
      location.hash = '#/pos';
      render();
    } catch (err) {
      document.getElementById('login-err').textContent = err.message;
      btn.disabled = false;
    }
  };
}

function changePasswordModal() {
  openModal(`<h3>เปลี่ยนรหัสผ่าน</h3>
    <form class="form-grid" id="pw-form">
      <label class="field">รหัสผ่านเดิม<input class="input" type="password" name="current" required></label>
      <label class="field">รหัสผ่านใหม่ (อย่างน้อย 6 ตัว)<input class="input" type="password" name="next" minlength="6" required></label>
      <div class="row"><span class="spacer"></span><button type="button" class="btn" data-close>ยกเลิก</button><button class="btn primary">บันทึก</button></div>
    </form>`, { onMount: (m) => {
    m.querySelector('form').onsubmit = async (e) => {
      e.preventDefault();
      try { await api('/me/password', { body: { current: e.target.current.value, next: e.target.next.value } }); closeModal(); toast('เปลี่ยนรหัสผ่านแล้ว'); }
      catch (err) { fail(err); }
    };
  } });
}

// ---------- POS ----------
const cartSubtotal = () => round2(state.cart.reduce((s, l) => s + l.price * l.qty, 0));
const cartTotal = () => round2(Math.max(cartSubtotal() - Math.min(state.discount, cartSubtotal()), 0));

async function renderPOS(view) {
  view.innerHTML = `<div class="pos">
    <section class="pos-menu">
      <div class="row" style="margin-bottom:12px"><input class="input" id="menu-search" placeholder="ค้นหาเมนู..." value="${esc(state.search)}" style="max-width:320px"></div>
      <div class="cats" id="cats"></div>
      <div class="menu-grid" id="menu-grid"><div class="muted">กำลังโหลด...</div></div>
    </section>
    <aside class="cart" id="cart"></aside>
  </div>`;
  view.querySelector('#menu-search').oninput = (e) => { state.search = e.target.value; drawMenu(); };
  drawCart();
  try {
    [state.menu, state.accounts] = await Promise.all([api('/menu'), api('/payment-accounts')]);
    if (state.user.role === 'admin') state.accounts = state.accounts.filter((a) => a.active);
    state.menu = state.menu.filter((m) => m.available);
    // ลบรายการในตะกร้าที่ไม่มีขายแล้ว และอัปเดตราคา
    state.cart = state.cart.filter((l) => state.menu.some((m) => m.id === l.menu_item_id))
      .map((l) => { const m = state.menu.find((x) => x.id === l.menu_item_id); return { ...l, name: m.name, price: m.price }; });
    drawMenu(); drawCart();
  } catch (e) { fail(e); }
}

function drawMenu() {
  const cats = ['ทั้งหมด', ...new Set(state.menu.map((m) => m.category))];
  if (!cats.includes(state.category)) state.category = 'ทั้งหมด';
  const catsEl = document.getElementById('cats');
  const grid = document.getElementById('menu-grid');
  if (!catsEl) return;
  catsEl.innerHTML = cats.map((c) => `<button class="cat ${c === state.category ? 'active' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('');
  catsEl.querySelectorAll('.cat').forEach((b) => (b.onclick = () => { state.category = b.dataset.cat; drawMenu(); }));
  const q = state.search.trim().toLowerCase();
  const items = state.menu.filter((m) => (state.category === 'ทั้งหมด' || m.category === state.category) && (!q || m.name.toLowerCase().includes(q)));
  grid.innerHTML = items.length ? items.map((m) => {
    const inCart = state.cart.find((l) => l.menu_item_id === m.id);
    return `<button class="menu-tile" data-id="${m.id}">
      <span class="name">${esc(m.name)}</span>
      <span class="row"><span class="price">${baht(m.price)}</span><span class="spacer"></span>${inCart ? `<span class="qty-dot">${inCart.qty}</span>` : ''}</span>
    </button>`;
  }).join('') : '<div class="muted">ไม่พบเมนู</div>';
  grid.querySelectorAll('.menu-tile').forEach((b) => (b.onclick = () => addToCart(Number(b.dataset.id))));
}

function addToCart(id) {
  const m = state.menu.find((x) => x.id === id);
  if (!m) return;
  const line = state.cart.find((l) => l.menu_item_id === id && !l.note);
  if (line) line.qty++;
  else state.cart.push({ menu_item_id: m.id, name: m.name, price: m.price, qty: 1, note: '' });
  drawMenu(); drawCart();
}

function drawCart() {
  const el = document.getElementById('cart');
  if (!el) return;
  const sub = cartSubtotal();
  el.innerHTML = `
    <div class="cart-head">
      <div class="row"><h3>รายการสั่ง</h3><span class="spacer"></span>${state.cart.length ? '<button class="btn sm danger" id="clear-cart">ล้าง</button>' : ''}</div>
      <div class="seg">
        <button data-type="dine_in" class="${state.orderType === 'dine_in' ? 'active' : ''}">🍽 ทานที่ร้าน</button>
        <button data-type="takeaway" class="${state.orderType === 'takeaway' ? 'active' : ''}">🛍 กลับบ้าน</button>
      </div>
      ${state.orderType === 'dine_in' ? `<input class="input" id="table-no" placeholder="เลขโต๊ะ (ถ้ามี)" value="${esc(state.tableNo)}">` : ''}
    </div>
    <div class="cart-items">
      ${state.cart.length ? state.cart.map((l, i) => `
        <div class="cart-line">
          <div><div class="nm">${esc(l.name)}</div><div class="muted num" style="font-size:14px">${baht(l.price)} × ${l.qty} = <b>${baht(l.price * l.qty)}</b></div></div>
          <div class="stepper"><button data-dec="${i}" aria-label="ลด">−</button><span>${l.qty}</span><button data-inc="${i}" aria-label="เพิ่ม">+</button></div>
          <div class="nt">${l.note ? '📝 ' + esc(l.note) + ' · ' : ''}<button class="link" data-note="${i}">${l.note ? 'แก้หมายเหตุ' : '+ หมายเหตุ'}</button></div>
        </div>`).join('') : '<div class="cart-empty">แตะเมนูทางซ้ายเพื่อเพิ่มรายการ</div>'}
    </div>
    <div class="cart-foot">
      <div class="sum-row"><span class="muted">รวม (${state.cart.reduce((s, l) => s + l.qty, 0)} รายการ)</span><span class="num">${baht(sub)}</span></div>
      <div class="sum-row"><span class="muted">ส่วนลด</span><span><button class="link" id="btn-discount">${state.discount ? '−' + baht(Math.min(state.discount, sub)) : 'เพิ่มส่วนลด'}</button></span></div>
      <div class="sum-row total"><span>ยอดชำระ</span><span class="num">${baht(cartTotal())}</span></div>
      <div class="pay-btns">
        <button class="btn ok lg" id="pay-cash" ${state.cart.length ? '' : 'disabled'}>💵 เงินสด</button>
        <button class="btn primary lg" id="pay-qr" ${state.cart.length ? '' : 'disabled'}>📱 สแกน QR</button>
      </div>
    </div>`;
  el.querySelectorAll('[data-type]').forEach((b) => (b.onclick = () => { state.orderType = b.dataset.type; drawCart(); }));
  el.querySelector('#table-no')?.addEventListener('input', (e) => (state.tableNo = e.target.value));
  el.querySelectorAll('[data-inc]').forEach((b) => (b.onclick = () => { state.cart[b.dataset.inc].qty++; drawCart(); drawMenu(); }));
  el.querySelectorAll('[data-dec]').forEach((b) => (b.onclick = () => {
    const l = state.cart[b.dataset.dec];
    if (--l.qty <= 0) state.cart.splice(b.dataset.dec, 1);
    drawCart(); drawMenu();
  }));
  el.querySelectorAll('[data-note]').forEach((b) => (b.onclick = () => noteModal(Number(b.dataset.note))));
  el.querySelector('#clear-cart')?.addEventListener('click', async () => { if (await confirmBox('ล้างรายการทั้งหมด?', 'ล้าง')) resetCart(); });
  el.querySelector('#btn-discount').onclick = discountModal;
  el.querySelector('#pay-cash').onclick = cashModal;
  el.querySelector('#pay-qr').onclick = () => qrModal();
}

function resetCart() {
  state.cart = []; state.discount = 0; state.tableNo = '';
  drawCart(); drawMenu();
}

function noteModal(i) {
  const l = state.cart[i];
  openModal(`<h3>หมายเหตุ: ${esc(l.name)}</h3>
    <form class="form-grid"><input class="input" name="note" maxlength="200" placeholder="เช่น ไม่เผ็ด, ไม่ใส่ผัก" value="${esc(l.note)}">
    <div class="row"><span class="spacer"></span><button type="button" class="btn" data-close>ยกเลิก</button><button class="btn primary">บันทึก</button></div></form>`,
  { onMount: (m) => (m.querySelector('form').onsubmit = (e) => {
    e.preventDefault(); l.note = e.target.note.value.trim(); closeModal(); drawCart();
  }) });
}

function discountModal() {
  openModal(`<h3>ส่วนลด (บาท)</h3>
    <form class="form-grid"><input class="input" name="d" type="number" min="0" step="0.01" inputmode="decimal" value="${state.discount || ''}">
    <div class="row"><button type="button" class="btn" id="d-clear">ไม่มีส่วนลด</button><span class="spacer"></span><button type="button" class="btn" data-close>ยกเลิก</button><button class="btn primary">ตกลง</button></div></form>`,
  { onMount: (m) => {
    m.querySelector('#d-clear').onclick = () => { state.discount = 0; closeModal(); drawCart(); };
    m.querySelector('form').onsubmit = (e) => { e.preventDefault(); state.discount = Math.max(0, round2(e.target.d.value || 0)); closeModal(); drawCart(); };
  } });
}

function orderPayload(extra) {
  return {
    items: state.cart.map((l) => ({ menu_item_id: l.menu_item_id, qty: l.qty, note: l.note })),
    order_type: state.orderType,
    table_no: state.tableNo,
    discount: state.discount,
    ...extra,
  };
}

// รหัสคำขอผูกกับรายการในบิล: ส่งซ้ำ/ลองใหม่ด้วยรายการเดิม จะได้บิลเดิมจากเซิร์ฟเวอร์ ไม่เกิดบิลซ้ำ
// ถ้าแก้รายการ (เพิ่ม/ลด/ส่วนลด/โต๊ะ) จะได้รหัสใหม่
let checkout = null;
function checkoutRequestId(payload) {
  const key = JSON.stringify([payload.items, payload.order_type, payload.table_no, payload.discount]);
  if (!checkout || checkout.key !== key) checkout = { key, id: newRequestId() };
  return checkout.id;
}

async function submitOrder(extra, btn) {
  btn.disabled = true;
  const label = btn.textContent;
  const payload = orderPayload(extra);
  payload.request_id = checkoutRequestId(payload);
  for (let attempt = 0; ; attempt++) {
    try {
      const order = await api('/orders', { body: payload, timeout: 45000 });
      checkout = null;
      resetCart();
      receiptModal(order);
      return;
    } catch (e) {
      if (e.retryable && attempt < 2) {
        btn.textContent = 'เน็ตสะดุด กำลังลองใหม่...';
        await sleep(1500);
        continue;
      }
      btn.textContent = label;
      btn.disabled = false;
      fail(e.retryable ? new Error('บันทึกบิลไม่สำเร็จเพราะเน็ตมีปัญหา — กดยืนยันอีกครั้งได้ จะไม่เกิดบิลซ้ำ') : e);
      return;
    }
  }
}

function cashModal() {
  const total = cartTotal();
  const quick = [...new Set([total, ...[20, 50, 100, 500, 1000].map((n) => Math.ceil(total / n) * n)])].filter((v) => v >= total).sort((a, b) => a - b).slice(0, 4);
  openModal(`<h3>ชำระด้วยเงินสด</h3>
    <div class="big-total num">${baht(total)}</div>
    <label class="field">รับเงินมา<input class="input num" id="cash-in" type="number" min="0" step="0.01" inputmode="decimal" style="font-size:22px;text-align:right"></label>
    <div class="quick-cash">${quick.map((v) => `<button class="btn" data-q="${v}">${v === total ? 'พอดี' : v.toLocaleString('th-TH')}</button>`).join('')}</div>
    <div class="change-box short" id="change">ทอน —</div>
    <div class="row"><button class="btn" data-close>ยกเลิก</button><span class="spacer"></span><button class="btn ok lg" id="cash-ok" disabled>ยืนยันรับเงิน</button></div>`,
  { onMount: (m) => {
    const input = m.querySelector('#cash-in');
    const okBtn = m.querySelector('#cash-ok');
    const update = () => {
      const v = round2(input.value || 0);
      const ch = m.querySelector('#change');
      if (input.value !== '' && v >= total) { ch.className = 'change-box'; ch.textContent = 'เงินทอน ' + baht(v - total); okBtn.disabled = false; }
      else { ch.className = 'change-box short'; ch.textContent = input.value === '' ? 'ใส่จำนวนเงินที่รับ' : 'ยังขาดอีก ' + baht(total - v); okBtn.disabled = true; }
    };
    input.oninput = update;
    m.querySelectorAll('[data-q]').forEach((b) => (b.onclick = () => { input.value = b.dataset.q; update(); }));
    input.onkeydown = (e) => { if (e.key === 'Enter' && !okBtn.disabled) okBtn.click(); };
    okBtn.onclick = () => submitOrder({ payment_method: 'cash', cash_received: round2(input.value) }, okBtn);
    update();
  } });
}

async function qrModal(accountId) {
  const total = cartTotal();
  if (!state.accounts.length) return toast('ยังไม่มีบัญชีรับเงิน QR — ให้ Admin เพิ่มที่เมนู "บัญชี QR"', true);
  const acc = state.accounts.find((a) => a.id === accountId) || state.accounts[0];
  openModal(`<h3>ชำระด้วย QR</h3>
    <div class="big-total num">${baht(total)}</div>
    ${state.accounts.length > 1 ? `<div class="acc-pick">${state.accounts.map((a) => `<button class="btn sm ${a.id === acc.id ? 'primary' : ''}" data-acc="${a.id}">${esc(a.name)}</button>`).join('')}</div>` : ''}
    <div class="qr-box" id="qr-box"><div class="muted">กำลังสร้าง QR...</div></div>
    <div class="row"><button class="btn" data-close>ยกเลิก</button><span class="spacer"></span><button class="btn ok lg" id="qr-ok" disabled>ได้รับเงินแล้ว</button></div>`,
  { onMount: async (m) => {
    m.querySelectorAll('[data-acc]').forEach((b) => (b.onclick = () => qrModal(Number(b.dataset.acc))));
    const okBtn = m.querySelector('#qr-ok');
    okBtn.onclick = () => submitOrder({ payment_method: 'qr', payment_account_id: acc.id }, okBtn);
    try {
      const qr = await api('/payment-qr', { body: { account_id: acc.id, amount: total } });
      const box = m.querySelector('#qr-box');
      if (!box) return;
      box.innerHTML = `<img src="${esc(qr.image)}" alt="QR ชำระเงิน">
        <div><b>${esc(acc.name)}</b>${acc.account_name ? ' · ' + esc(acc.account_name) : ''}</div>
        <div class="muted" style="font-size:14px">${qr.dynamic ? 'PromptPay — ยอดเงินถูกใส่ใน QR แล้ว' : 'QR แบบคงที่ — ลูกค้าต้องกรอกยอด ' + baht(total) + ' เอง'}</div>
        <div class="muted" style="font-size:13px">ตรวจสอบสลิป/แจ้งเตือนเงินเข้าก่อนกดยืนยัน</div>`;
      okBtn.disabled = false;
    } catch (e) { fail(e); }
  } });
}

function receiptHTML(o) {
  return `<div class="receipt">
    <div class="c"><b style="font-size:16px">ใบเสร็จรับเงิน</b></div>
    <div class="c">เลขที่ ${esc(o.order_no)}</div>
    <div class="c">${esc(o.created_at)}</div>
    <div class="c">${ORDER_TYPE[o.order_type]}${o.table_no ? ' · โต๊ะ ' + esc(o.table_no) : ''}</div>
    ${o.status === 'void' ? '<div class="c" style="color:#c00"><b>*** ยกเลิกบิล ***</b></div>' : ''}
    <hr>
    ${o.items.map((i) => `<div class="ln"><span>${i.qty} × ${esc(i.name)}</span><span>${baht(i.line_total)}</span></div>${i.note ? `<div style="font-size:12px;padding-left:12px">- ${esc(i.note)}</div>` : ''}`).join('')}
    <hr>
    <div class="ln"><span>รวม</span><span>${baht(o.subtotal)}</span></div>
    ${o.discount ? `<div class="ln"><span>ส่วนลด</span><span>-${baht(o.discount)}</span></div>` : ''}
    <div class="ln"><b>ยอดสุทธิ</b><b>${baht(o.total)}</b></div>
    <div class="ln"><span>ชำระโดย</span><span>${PAY[o.payment_method]}${o.payment_account_name ? ' (' + esc(o.payment_account_name) + ')' : ''}</span></div>
    ${o.payment_method === 'cash' ? `<div class="ln"><span>รับเงิน</span><span>${baht(o.cash_received)}</span></div><div class="ln"><span>เงินทอน</span><span>${baht(o.change_amount)}</span></div>` : ''}
    <hr><div class="c">พนักงาน: ${esc(o.staff_name || '-')}</div><div class="c">ขอบคุณที่ใช้บริการ</div>
  </div>`;
}

function printReceipt(o) {
  document.getElementById('print-area').innerHTML = receiptHTML(o);
  window.print();
}

// ---------- ใบสั่งอาหารแยกตามครัว ----------
const NO_KITCHEN = 'ไม่ระบุครัว';

/** จัดกลุ่มรายการในบิลตามครัว (ใช้ครัว ณ ตอนขายที่บันทึกไว้ในบิล) */
function kitchenGroups(o) {
  const groups = new Map();
  for (const it of o.items) {
    const key = it.kitchen_name || NO_KITCHEN;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === NO_KITCHEN) - (b === NO_KITCHEN) || a.localeCompare(b, 'th'))
    .map(([kitchen, items]) => ({ kitchen, items, qty: items.reduce((s, i) => s + i.qty, 0) }));
}

function kitchenTicketHTML(o, g, index, count) {
  return `<div class="ticket">
    <div class="t-kitchen">${esc(g.kitchen)}</div>
    <div class="t-type">${o.order_type === 'takeaway' ? '🛍 กลับบ้าน' : '🍽 ทานที่ร้าน'}${o.table_no ? ' · โต๊ะ ' + esc(o.table_no) : ''}</div>
    <div class="t-meta"><span>บิล ${esc(o.order_no.slice(-4))}</span><span>${esc(o.created_at.slice(11, 16))}</span><span>ใบ ${index + 1}/${count}</span></div>
    ${o.status === 'void' ? '<div class="t-void">*** ยกเลิกบิล ***</div>' : ''}
    <hr>
    ${g.items.map((i) => `<div class="t-line"><span class="t-qty">${i.qty}</span><span class="t-name">${esc(i.name)}${i.note ? `<span class="t-note">» ${esc(i.note)}</span>` : ''}</span></div>`).join('')}
    <hr>
    <div class="t-foot">รวม ${g.qty} ที่ · ${esc(o.staff_name || '')}</div>
  </div>`;
}

function printKitchenTickets(o, onlyKitchen) {
  const groups = kitchenGroups(o);
  const html = groups
    .map((g, i) => (onlyKitchen && g.kitchen !== onlyKitchen ? '' : kitchenTicketHTML(o, g, i, groups.length)))
    .join('');
  document.getElementById('print-area').innerHTML = html;
  window.print();
}

// ตั้งค่าเฉพาะเครื่อง: พิมพ์ใบสั่งครัวอัตโนมัติหลังคิดเงิน (ค่าเริ่มต้น: เปิด)
const AUTO_KEY = 'pos.autoKitchenPrint';
const autoKitchenPrint = {
  get() { try { return localStorage.getItem(AUTO_KEY) !== '0'; } catch { return true; } },
  set(on) { try { localStorage.setItem(AUTO_KEY, on ? '1' : '0'); } catch { /* ไม่มี storage: ใช้ค่าเริ่มต้น */ } },
};

function receiptModal(o, { fresh = true } = {}) {
  const groups = kitchenGroups(o);
  openModal(`${fresh ? `<h3 style="color:var(--ok)">✓ ชำระเงินสำเร็จ</h3>` : `<h3>บิล ${esc(o.order_no)}</h3>`}
    ${fresh && o.payment_method === 'cash' ? `<div class="change-box">เงินทอน ${baht(o.change_amount)}</div>` : ''}
    <div class="kitchen-box">
      <div class="row"><b>ใบสั่งอาหาร (${groups.length} ครัว)</b><span class="spacer"></span>
        <button class="btn primary" id="k-print-all">🖨 พิมพ์ใบสั่งครัว</button></div>
      <div class="kitchen-chips">${groups.map((g) => `<button class="btn sm" data-kprint="${esc(g.kitchen)}" title="พิมพ์เฉพาะ ${esc(g.kitchen)}">
        ${esc(g.kitchen)} <span class="muted">· ${g.qty}</span></button>`).join('')}</div>
      <label class="row muted" style="font-size:14px"><input type="checkbox" id="k-auto" ${autoKitchenPrint.get() ? 'checked' : ''}> พิมพ์ใบสั่งครัวอัตโนมัติหลังคิดเงิน (เครื่องนี้)</label>
    </div>
    <details><summary class="muted">ดูใบเสร็จ</summary>${receiptHTML(o)}</details>
    <div class="row"><button class="btn" id="r-print">🖨 พิมพ์ใบเสร็จ</button><span class="spacer"></span><button class="btn primary" data-close>${fresh ? 'บิลถัดไป' : 'ปิด'}</button></div>`,
  { onMount: (m) => {
    m.querySelector('#r-print').onclick = () => printReceipt(o);
    m.querySelector('#k-print-all').onclick = () => printKitchenTickets(o);
    m.querySelectorAll('[data-kprint]').forEach((b) => (b.onclick = () => printKitchenTickets(o, b.dataset.kprint)));
    m.querySelector('#k-auto').onchange = (e) => autoKitchenPrint.set(e.target.checked);
    // ออกใบสั่งครัวทันทีหลังคิดเงิน (ถ้าเบราว์เซอร์ไม่เปิดหน้าพิมพ์เอง ให้กดปุ่มด้านบน)
    if (fresh && autoKitchenPrint.get()) setTimeout(() => printKitchenTickets(o), 300);
  } });
}

// ---------- orders today ----------
async function renderOrders(view, date = todayStr()) {
  const isAdmin = state.user.role === 'admin';
  view.innerHTML = `<div class="page">
    <div class="page-head"><h2>รายการบิล</h2><span class="spacer"></span>
      <input class="input" type="date" id="o-date" value="${date}" style="width:auto" ${isAdmin ? '' : 'disabled'}></div>
    <div class="card table-wrap" id="o-list"><div class="muted">กำลังโหลด...</div></div></div>`;
  view.querySelector('#o-date').onchange = (e) => renderOrders(view, e.target.value || todayStr());
  try {
    const orders = await api('/orders?date=' + encodeURIComponent(date));
    const list = view.querySelector('#o-list');
    const paid = orders.filter((o) => o.status === 'paid');
    list.innerHTML = orders.length ? `
      <div class="row" style="margin-bottom:10px"><span class="muted">${paid.length} บิล · ยอดรวม</span><b class="num">${baht(paid.reduce((s, o) => s + o.total, 0))}</b></div>
      <table><thead><tr><th>เลขที่</th><th>เวลา</th><th>ประเภท</th><th>รายการ</th><th class="right">ยอด</th><th>ชำระ</th><th>พนักงาน</th><th></th></tr></thead>
      <tbody>${orders.map((o) => `<tr class="${o.status === 'void' ? 'void' : ''}">
        <td>${esc(o.order_no)}</td><td>${esc(o.created_at.slice(11, 16))}</td>
        <td>${ORDER_TYPE[o.order_type]}${o.table_no ? ' · โต๊ะ ' + esc(o.table_no) : ''}</td>
        <td>${o.items.reduce((s, i) => s + i.qty, 0)}</td>
        <td class="right num">${baht(o.total)}</td><td>${PAY[o.payment_method]}</td><td>${esc(o.staff_name || '')}</td>
        <td class="row" style="flex-wrap:nowrap"><button class="btn sm" data-view="${o.id}">ดู</button>
          ${isAdmin && o.status === 'paid' ? `<button class="btn sm danger" data-void="${o.id}">ยกเลิกบิล</button>` : ''}</td></tr>`).join('')}
      </tbody></table>` : '<div class="muted">ยังไม่มีบิล</div>';
    list.querySelectorAll('[data-view]').forEach((b) => (b.onclick = () => receiptModal(orders.find((o) => o.id === Number(b.dataset.view)), { fresh: false })));
    list.querySelectorAll('[data-void]').forEach((b) => (b.onclick = async () => {
      const o = orders.find((x) => x.id === Number(b.dataset.void));
      if (!(await confirmBox(`ยกเลิกบิล ${o.order_no} ยอด ${baht(o.total)}? บิลที่ยกเลิกจะไม่นับในยอดขาย`, 'ยกเลิกบิล'))) return;
      try { await api(`/orders/${o.id}/void`, { method: 'POST' }); toast('ยกเลิกบิลแล้ว'); renderOrders(view, date); } catch (e) { fail(e); }
    }));
  } catch (e) { fail(e); }
}

// ---------- admin: menu ----------
const kitchenOptions = (selectedId) => `<option value="">— ไม่ระบุครัว —</option>${state.kitchens
  .map((k) => `<option value="${k.id}" ${k.id === selectedId ? 'selected' : ''}>${esc(k.name)}</option>`).join('')}`;

async function renderMenuAdmin(view) {
  view.innerHTML = `<div class="page">
    <div class="page-head"><h2>จัดการเมนู</h2><span class="spacer"></span>
      <button class="btn" id="m-kitchens">🍳 จัดการครัว</button>
      <button class="btn primary" id="m-add">+ เพิ่มรายการ</button></div>
    <div class="card table-wrap" id="m-list"><div class="muted">กำลังโหลด...</div></div></div>`;
  view.querySelector('#m-add').onclick = () => menuForm();
  view.querySelector('#m-kitchens').onclick = () => kitchensModal();
  try {
    [state.menu, state.kitchens] = await Promise.all([api('/menu'), api('/kitchens')]);
    const list = view.querySelector('#m-list');
    list.innerHTML = state.menu.length ? `<table><thead><tr><th>ชื่อรายการ</th><th>หมวดหมู่</th><th>ครัว</th><th class="right">ราคา (บาท)</th><th>สถานะ</th><th></th></tr></thead><tbody>
      ${state.menu.map((m) => `<tr>
        <td><b>${esc(m.name)}</b></td><td>${esc(m.category)}</td>
        <td><select class="input kitchen-select" data-kitchen="${m.id}" aria-label="ครัวของ ${esc(m.name)}">${kitchenOptions(m.kitchen_id)}</select></td>
        <td class="right"><input class="input price-input num" type="number" min="0" step="0.01" value="${m.price}" data-price="${m.id}" title="แก้ราคาแล้วกด Enter"></td>
        <td><button class="badge ${m.available ? 'ok' : 'off'}" data-toggle="${m.id}" style="cursor:pointer">${m.available ? 'พร้อมขาย' : 'หมด/ปิดขาย'}</button></td>
        <td class="row" style="flex-wrap:nowrap"><button class="btn sm" data-edit="${m.id}">แก้ไข</button><button class="btn sm danger" data-del="${m.id}">ลบ</button></td>
      </tr>`).join('')}</tbody></table>` : '<div class="muted">ยังไม่มีรายการ</div>';
    const find = (id) => state.menu.find((m) => m.id === Number(id));
    const save = (m, patch) => api('/menu/' + m.id, { method: 'PUT', body: { ...m, ...patch } });
    list.querySelectorAll('[data-price]').forEach((inp) => {
      const commit = async () => {
        const m = find(inp.dataset.price);
        const price = round2(inp.value);
        if (inp.value === '' || price < 0) { inp.value = m.price; return toast('ราคาไม่ถูกต้อง', true); }
        if (price === m.price) return;
        try { await save(m, { price }); m.price = price; toast(`ปรับราคา ${m.name} เป็น ${baht(price)}`); } catch (e) { fail(e); inp.value = m.price; }
      };
      inp.onkeydown = (e) => { if (e.key === 'Enter') inp.blur(); };
      inp.onchange = commit;
    });
    list.querySelectorAll('[data-kitchen]').forEach((sel) => (sel.onchange = async () => {
      const m = find(sel.dataset.kitchen);
      const kitchen_id = sel.value ? Number(sel.value) : null;
      try {
        const saved = await save(m, { kitchen_id });
        Object.assign(m, saved);
        toast(`${m.name} → ${saved.kitchen_name || 'ไม่ระบุครัว'}`);
      } catch (e) { fail(e); sel.value = m.kitchen_id ?? ''; }
    }));
    list.querySelectorAll('[data-toggle]').forEach((b) => (b.onclick = async () => {
      const m = find(b.dataset.toggle);
      try { await save(m, { available: !m.available }); renderMenuAdmin(view); } catch (e) { fail(e); }
    }));
    list.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => menuForm(find(b.dataset.edit))));
    list.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
      const m = find(b.dataset.del);
      if (!(await confirmBox(`ลบ "${m.name}" ออกจากเมนู? (บิลเก่ายังคงอยู่)`, 'ลบ'))) return;
      try { await api('/menu/' + m.id, { method: 'DELETE' }); toast('ลบแล้ว'); renderMenuAdmin(view); } catch (e) { fail(e); }
    }));
  } catch (e) { fail(e); }
}

function menuForm(item) {
  const cats = [...new Set(state.menu.map((m) => m.category))];
  openModal(`<h3>${item ? 'แก้ไขรายการ' : 'เพิ่มรายการใหม่'}</h3>
    <form class="form-grid">
      <label class="field">ชื่อรายการ<input class="input" name="name" required value="${esc(item?.name)}"></label>
      <label class="field">หมวดหมู่<input class="input" name="category" list="cat-list" placeholder="เช่น อาหารจานเดียว" value="${esc(item?.category)}">
        <datalist id="cat-list">${cats.map((c) => `<option value="${esc(c)}">`).join('')}</datalist></label>
      <label class="field">ครัวที่ทำ (ใช้แยกใบสั่งอาหาร)<select class="input" name="kitchen_id">${kitchenOptions(item?.kitchen_id ?? null)}</select></label>
      <label class="field">ราคา (บาท)<input class="input" name="price" type="number" min="0" step="0.01" required value="${item?.price ?? ''}"></label>
      <label class="row"><input type="checkbox" name="available" ${!item || item.available ? 'checked' : ''}> พร้อมขาย</label>
      <div class="row"><span class="spacer"></span><button type="button" class="btn" data-close>ยกเลิก</button><button class="btn primary">บันทึก</button></div>
    </form>`, { onMount: (m) => (m.querySelector('form').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const body = {
      name: f.name.value, category: f.category.value, price: Number(f.price.value), available: f.available.checked,
      kitchen_id: f.kitchen_id.value ? Number(f.kitchen_id.value) : null,
    };
    try {
      await api(item ? '/menu/' + item.id : '/menu', { method: item ? 'PUT' : 'POST', body });
      toast('บันทึกแล้ว'); closeModal(); renderMenuAdmin(document.getElementById('view'));
    } catch (err) { fail(err); }
  }) });
}

// ---------- admin: kitchens ----------
function kitchensModal() {
  const draw = (m) => {
    const box = m.querySelector('#k-list');
    box.innerHTML = state.kitchens.length ? `<table><tbody>${state.kitchens.map((k) => `<tr>
        <td><input class="input" value="${esc(k.name)}" data-kname="${k.id}" maxlength="50" aria-label="ชื่อครัว"></td>
        <td class="muted" style="white-space:nowrap">${k.menu_count} เมนู</td>
        <td><button class="btn sm danger" data-kdel="${k.id}">ลบ</button></td></tr>`).join('')}</tbody></table>`
      : '<div class="muted">ยังไม่มีครัว — เพิ่มด้านล่าง เช่น "ครัว 1", "ครัวเครื่องดื่ม"</div>';
    box.querySelectorAll('[data-kname]').forEach((inp) => {
      inp.onkeydown = (e) => { if (e.key === 'Enter') inp.blur(); };
      inp.onchange = async () => {
        const k = state.kitchens.find((x) => x.id === Number(inp.dataset.kname));
        try { const saved = await api('/kitchens/' + k.id, { method: 'PUT', body: { name: inp.value } }); k.name = saved.name; toast('เปลี่ยนชื่อครัวแล้ว'); }
        catch (e) { fail(e); inp.value = k.name; }
      };
    });
    box.querySelectorAll('[data-kdel]').forEach((b) => (b.onclick = async () => {
      const k = state.kitchens.find((x) => x.id === Number(b.dataset.kdel));
      const msg = k.menu_count ? `ลบ "${k.name}"? เมนู ${k.menu_count} รายการในครัวนี้จะกลายเป็น "ไม่ระบุครัว"` : `ลบ "${k.name}"?`;
      if (!confirm(msg)) return;
      try { await api('/kitchens/' + k.id, { method: 'DELETE' }); state.kitchens = await api('/kitchens'); draw(m); toast('ลบครัวแล้ว'); }
      catch (e) { fail(e); }
    }));
  };
  openModal(`<h3>จัดการครัว</h3>
    <div class="muted" style="font-size:14px">หลังคิดเงิน ระบบจะออกใบสั่งอาหารแยกตามครัวของแต่ละเมนู</div>
    <div class="table-wrap" id="k-list"></div>
    <form class="row" id="k-add" style="flex-wrap:nowrap"><input class="input" name="name" placeholder="ชื่อครัวใหม่ เช่น ครัว 1" maxlength="50" required>
      <button class="btn primary" style="white-space:nowrap">+ เพิ่มครัว</button></form>
    <div class="row"><span class="spacer"></span><button class="btn" data-close>เสร็จ</button></div>`, {
    onMount: (m) => {
      draw(m);
      m.querySelector('#k-add').onsubmit = async (e) => {
        e.preventDefault();
        try {
          await api('/kitchens', { body: { name: e.target.name.value } });
          e.target.reset();
          state.kitchens = await api('/kitchens');
          draw(m);
          toast('เพิ่มครัวแล้ว');
        } catch (err) { fail(err); }
      };
    },
    // ปิดหน้าต่าง (ปุ่ม/แตะข้างนอก/Esc) แล้วโหลดตารางเมนูใหม่ เพราะตัวเลือกครัวเปลี่ยน
    onClose: () => renderMenuAdmin(document.getElementById('view')),
  });
}

// ---------- admin: users ----------
async function renderUsers(view) {
  view.innerHTML = `<div class="page">
    <div class="page-head"><h2>บัญชีผู้ใช้</h2><span class="spacer"></span><button class="btn primary" id="u-add">+ เพิ่มบัญชี</button></div>
    <div class="card table-wrap" id="u-list"><div class="muted">กำลังโหลด...</div></div></div>`;
  view.querySelector('#u-add').onclick = () => userForm();
  try {
    const users = await api('/users');
    const list = view.querySelector('#u-list');
    list.innerHTML = `<table><thead><tr><th>ชื่อผู้ใช้</th><th>ชื่อที่แสดง</th><th>สิทธิ์</th><th>สร้างเมื่อ</th><th></th></tr></thead><tbody>
      ${users.map((u) => `<tr><td><b>${esc(u.username)}</b>${u.id === state.user.id ? ' <span class="muted">(คุณ)</span>' : ''}</td><td>${esc(u.display_name)}</td>
        <td><span class="badge ${u.role === 'admin' ? 'admin' : ''}">${u.role === 'admin' ? 'Admin' : 'Staff'}</span></td>
        <td class="muted">${esc(u.created_at.slice(0, 10))}</td>
        <td class="row" style="flex-wrap:nowrap"><button class="btn sm" data-edit="${u.id}">แก้ไข/รีเซ็ตรหัส</button>
        ${u.id !== state.user.id ? `<button class="btn sm danger" data-del="${u.id}">ลบ</button>` : ''}</td></tr>`).join('')}
      </tbody></table>`;
    list.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => userForm(users.find((u) => u.id === Number(b.dataset.edit)))));
    list.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
      const u = users.find((x) => x.id === Number(b.dataset.del));
      if (!(await confirmBox(`ลบบัญชี "${u.username}"? ผู้ใช้นี้จะเข้าสู่ระบบไม่ได้อีก`, 'ลบบัญชี'))) return;
      try { await api('/users/' + u.id, { method: 'DELETE' }); toast('ลบบัญชีแล้ว'); renderUsers(view); } catch (e) { fail(e); }
    }));
  } catch (e) { fail(e); }
}

function userForm(u) {
  openModal(`<h3>${u ? 'แก้ไขบัญชี ' + esc(u.username) : 'เพิ่มบัญชีใหม่'}</h3>
    <form class="form-grid">
      ${u ? '' : '<label class="field">ชื่อผู้ใช้ (a-z, 0-9)<input class="input" name="username" required pattern="[A-Za-z0-9_.\\-]{3,30}" autocomplete="off"></label>'}
      <label class="field">ชื่อที่แสดง<input class="input" name="display_name" value="${esc(u?.display_name)}" placeholder="เช่น น้องเอ"></label>
      <label class="field">สิทธิ์<select class="input" name="role">
        <option value="staff" ${u?.role !== 'admin' ? 'selected' : ''}>Staff — กดรายการ, คิดเงิน</option>
        <option value="admin" ${u?.role === 'admin' ? 'selected' : ''}>Admin — จัดการทุกอย่าง</option></select></label>
      <label class="field">${u ? 'รหัสผ่านใหม่ (เว้นว่างถ้าไม่เปลี่ยน)' : 'รหัสผ่าน (อย่างน้อย 6 ตัว)'}<input class="input" name="password" type="password" minlength="6" ${u ? '' : 'required'} autocomplete="new-password"></label>
      <div class="row"><span class="spacer"></span><button type="button" class="btn" data-close>ยกเลิก</button><button class="btn primary">บันทึก</button></div>
    </form>`, { onMount: (m) => (m.querySelector('form').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const body = { display_name: f.display_name.value, role: f.role.value, password: f.password.value || undefined };
    if (!u) body.username = f.username.value;
    try {
      await api(u ? '/users/' + u.id : '/users', { method: u ? 'PUT' : 'POST', body });
      toast('บันทึกแล้ว'); closeModal(); renderUsers(document.getElementById('view'));
    } catch (err) { fail(err); }
  }) });
}

// ---------- admin: QR accounts ----------
async function renderAccounts(view) {
  view.innerHTML = `<div class="page">
    <div class="page-head"><h2>บัญชีรับเงิน QR</h2><span class="spacer"></span><button class="btn primary" id="a-add">+ เพิ่มบัญชี</button></div>
    <div class="acc-grid" id="a-list"><div class="muted">กำลังโหลด...</div></div></div>`;
  view.querySelector('#a-add').onclick = accountForm;
  try {
    const accs = await api('/payment-accounts');
    const list = view.querySelector('#a-list');
    list.innerHTML = accs.length ? accs.map((a) => `<div class="card acc-card">
      <div class="row"><b>${esc(a.name)}</b><span class="spacer"></span><span class="badge ${a.active ? 'ok' : 'off'}">${a.active ? 'ใช้งาน' : 'ปิด'}</span></div>
      <div class="muted" style="font-size:14px">${a.type === 'promptpay' ? 'PromptPay: ' + esc(a.promptpay_id) + ' (QR ใส่ยอดเงินอัตโนมัติ)' : 'รูป QR ที่อัปโหลด'}${a.account_name ? '<br>ชื่อบัญชี: ' + esc(a.account_name) : ''}</div>
      ${a.type === 'image' ? `<img src="${esc(a.image_data)}" alt="QR">` : ''}
      <div class="row"><button class="btn sm" data-toggle="${a.id}">${a.active ? 'ปิดใช้งาน' : 'เปิดใช้งาน'}</button>
        <button class="btn sm" data-test="${a.id}">ทดสอบ QR</button><span class="spacer"></span><button class="btn sm danger" data-del="${a.id}">ลบ</button></div>
    </div>`).join('') : '<div class="card muted">ยังไม่มีบัญชี — เพิ่มเลข PromptPay หรืออัปโหลดรูป QR ของร้าน</div>';
    list.querySelectorAll('[data-toggle]').forEach((b) => (b.onclick = async () => {
      const a = accs.find((x) => x.id === Number(b.dataset.toggle));
      try { await api('/payment-accounts/' + a.id, { method: 'PUT', body: { active: !a.active } }); renderAccounts(view); } catch (e) { fail(e); }
    }));
    list.querySelectorAll('[data-test]').forEach((b) => (b.onclick = async () => {
      try {
        const qr = await api('/payment-qr', { body: { account_id: Number(b.dataset.test), amount: 1 } });
        openModal(`<h3>ทดสอบ QR (1 บาท)</h3><div class="qr-box"><img src="${esc(qr.image)}" alt="QR"></div><div class="row"><span class="spacer"></span><button class="btn" data-close>ปิด</button></div>`);
      } catch (e) { fail(e); }
    }));
    list.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
      const a = accs.find((x) => x.id === Number(b.dataset.del));
      if (!(await confirmBox(`ลบบัญชี "${a.name}"?`, 'ลบ'))) return;
      try { await api('/payment-accounts/' + a.id, { method: 'DELETE' }); toast('ลบแล้ว'); renderAccounts(view); } catch (e) { fail(e); }
    }));
  } catch (e) { fail(e); }
}

function accountForm() {
  openModal(`<h3>เพิ่มบัญชีรับเงิน QR</h3>
    <form class="form-grid">
      <label class="field">ชื่อเรียก<input class="input" name="name" required placeholder="เช่น พร้อมเพย์ร้าน, KBank"></label>
      <label class="field">ชื่อบัญชี (แสดงให้ลูกค้าเห็น)<input class="input" name="account_name" placeholder="เช่น นายสมชาย ใจดี"></label>
      <div class="seg"><button type="button" data-t="promptpay" class="active">เลข PromptPay</button><button type="button" data-t="image">อัปโหลดรูป QR</button></div>
      <label class="field" id="f-pp">เลข PromptPay (เบอร์มือถือ 10 หลัก หรือเลขประจำตัว 13 หลัก)<input class="input" name="promptpay_id" inputmode="numeric"></label>
      <label class="field" id="f-img" hidden>รูป QR (PNG/JPG ไม่เกิน 2MB)<input class="input" name="image" type="file" accept="image/png,image/jpeg,image/webp"></label>
      <div class="row"><span class="spacer"></span><button type="button" class="btn" data-close>ยกเลิก</button><button class="btn primary">บันทึก</button></div>
    </form>`, { onMount: (m) => {
    let type = 'promptpay';
    m.querySelectorAll('[data-t]').forEach((b) => (b.onclick = () => {
      type = b.dataset.t;
      m.querySelectorAll('[data-t]').forEach((x) => x.classList.toggle('active', x === b));
      m.querySelector('#f-pp').hidden = type !== 'promptpay';
      m.querySelector('#f-img').hidden = type !== 'image';
    }));
    m.querySelector('form').onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      const body = { name: f.name.value, account_name: f.account_name.value, type };
      if (type === 'promptpay') body.promptpay_id = f.promptpay_id.value;
      else {
        const file = f.image.files[0];
        if (!file) return toast('กรุณาเลือกรูป QR', true);
        if (file.size > 2 * 1024 * 1024) return toast('ไฟล์ใหญ่เกิน 2MB', true);
        body.image_data = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
      }
      try { await api('/payment-accounts', { body }); toast('เพิ่มบัญชีแล้ว'); closeModal(); renderAccounts(document.getElementById('view')); }
      catch (err) { fail(err); }
    };
  } });
}

// ---------- admin: reports ----------
let reportMode = 'daily';
async function renderReports(view, value) {
  const isDaily = reportMode === 'daily';
  value = value || (isDaily ? todayStr() : todayStr().slice(0, 7));
  view.innerHTML = `<div class="page">
    <div class="page-head"><h2>สรุปยอดขาย</h2>
      <div class="tabs"><button data-mode="daily" class="${isDaily ? 'active' : ''}">รายวัน</button><button data-mode="monthly" class="${!isDaily ? 'active' : ''}">รายเดือน</button></div>
      <span class="spacer"></span>
      <input class="input" id="r-pick" type="${isDaily ? 'date' : 'month'}" value="${value}" style="width:auto">
      <button class="btn" id="r-print">🖨 พิมพ์</button></div>
    <div id="r-body"><div class="muted">กำลังโหลด...</div></div></div>`;
  view.querySelectorAll('[data-mode]').forEach((b) => (b.onclick = () => { reportMode = b.dataset.mode; renderReports(view); }));
  view.querySelector('#r-pick').onchange = (e) => e.target.value && renderReports(view, e.target.value);
  view.querySelector('#r-print').onclick = () => { document.getElementById('print-area').innerHTML = `<div style="width:auto">${view.querySelector('#r-body').innerHTML}</div>`; window.print(); };
  try {
    const r = await api(isDaily ? '/reports/daily?date=' + value : '/reports/monthly?month=' + value);
    const body = view.querySelector('#r-body');
    const get = (arr, key) => arr.find((x) => x.key === key) || { orders: 0, sales: 0 };
    const cash = get(r.byPayment, 'cash'), qr = get(r.byPayment, 'qr');
    const dine = get(r.byType, 'dine_in'), take = get(r.byType, 'takeaway');
    const bars = (rows, labelFn) => {
      const max = Math.max(1, ...rows.map((x) => x.sales));
      return rows.length ? `<div class="bars">${rows.map((x) => `<div class="bar-row"><span>${labelFn(x)}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${(x.sales / max) * 100}%"></div></div><span class="right num">${baht(x.sales)}</span></div>`).join('')}</div>`
        : '<div class="muted">ไม่มีข้อมูล</div>';
    };
    body.innerHTML = `
      <div class="stats">
        <div class="stat"><div class="lbl">ยอดขายสุทธิ</div><div class="val num">${baht(r.sales)}</div></div>
        <div class="stat"><div class="lbl">จำนวนบิล</div><div class="val num">${r.orders.toLocaleString('th-TH')}</div><div class="muted" style="font-size:13px">เฉลี่ย ${baht(r.orders ? r.sales / r.orders : 0)}/บิล${r.voided ? ` · ยกเลิก ${r.voided}` : ''}</div></div>
        <div class="stat"><div class="lbl">💵 เงินสด</div><div class="val num">${baht(cash.sales)}</div><div class="muted" style="font-size:13px">${cash.orders} บิล</div></div>
        <div class="stat"><div class="lbl">📱 QR</div><div class="val num">${baht(qr.sales)}</div><div class="muted" style="font-size:13px">${qr.orders} บิล</div></div>
      </div>
      <div class="grid-2">
        <div class="card"><h3>ทานที่ร้าน / กลับบ้าน</h3>
          <table><tbody>
            <tr><td>🍽 ทานที่ร้าน</td><td class="right">${dine.orders} บิล</td><td class="right num">${baht(dine.sales)}</td></tr>
            <tr><td>🛍 กลับบ้าน</td><td class="right">${take.orders} บิล</td><td class="right num">${baht(take.sales)}</td></tr>
            <tr><td>ส่วนลดรวม</td><td></td><td class="right num">${baht(r.discount)}</td></tr>
          </tbody></table>
          ${r.byAccount.length ? `<h3 style="margin-top:16px">แยกตามบัญชี QR</h3><table><tbody>${r.byAccount.map((a) => `<tr><td>${esc(a.key)}</td><td class="right">${a.orders} บิล</td><td class="right num">${baht(a.sales)}</td></tr>`).join('')}</tbody></table>` : ''}
        </div>
        <div class="card"><h3>เมนูขายดี</h3>
          ${r.topItems.length ? `<table><thead><tr><th>#</th><th>รายการ</th><th class="right">จำนวน</th><th class="right">ยอดขาย</th></tr></thead><tbody>
            ${r.topItems.map((t, i) => `<tr><td>${i + 1}</td><td>${esc(t.name)}</td><td class="right">${t.qty}</td><td class="right num">${baht(t.sales)}</td></tr>`).join('')}</tbody></table>` : '<div class="muted">ไม่มีข้อมูล</div>'}
        </div>
      </div>
      <div class="card"><h3>${isDaily ? 'ยอดขายรายชั่วโมง' : 'ยอดขายรายวัน'}</h3>
        ${isDaily ? bars(r.hourly, (x) => `${String(x.hour).padStart(2, '0')}:00`)
          : (r.daily.length ? `<div class="table-wrap"><table><thead><tr><th>วันที่</th><th class="right">บิล</th><th class="right">เงินสด</th><th class="right">QR</th><th class="right">รวม</th></tr></thead><tbody>
            ${r.daily.map((d) => `<tr><td>${esc(d.date)}</td><td class="right">${d.orders}</td><td class="right num">${baht(d.cash)}</td><td class="right num">${baht(d.qr)}</td><td class="right num"><b>${baht(d.sales)}</b></td></tr>`).join('')}
            </tbody></table></div>` : '<div class="muted">ไม่มีข้อมูล</div>')}
      </div>`;
  } catch (e) { fail(e); }
}

// ---------- boot ----------
(async () => {
  try { state.user = await api('/me'); } catch { state.user = null; }
  render();
})();
