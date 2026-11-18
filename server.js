import './env.js';
import express from 'express';
import QRCode from 'qrcode';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { db, tx, initDb, isTransient, nowLocal, hashPassword, verifyPassword } from './db.js';
import { promptPayPayload, normalizePromptPayId } from './promptpay.js';

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const SESSION_HOURS = 12;

app.set('trust proxy', process.env.TRUST_PROXY === '1');
app.use(express.json({ limit: '3mb' }));
app.use(express.static(fileURLToPath(new URL('./public/', import.meta.url))));

// ---------- helpers ----------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => { throw new HttpError(400, msg); };
const money = (n) => Math.round(Number(n) * 100) / 100;
const wrap = (fn) => (req, res, next) => { Promise.resolve().then(() => fn(req, res, next)).catch(next); };
const today = () => nowLocal().slice(0, 10);

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

app.use(wrap(async (req, _res, next) => {
  const token = readCookie(req, 'pos_session');
  if (token) {
    const row = await db.one(`
      SELECT u.id, u.username, u.display_name, u.role FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token = ? AND s.expires_at > ? AND u.deleted = 0`, [token, Date.now()]);
    if (row) req.user = row;
  }
  next();
}));

const requireLogin = (req, _res, next) => (req.user ? next() : next(new HttpError(401, 'กรุณาเข้าสู่ระบบ')));
const requireAdmin = (req, _res, next) =>
  !req.user ? next(new HttpError(401, 'กรุณาเข้าสู่ระบบ'))
    : req.user.role !== 'admin' ? next(new HttpError(403, 'เฉพาะผู้ดูแลระบบ'))
    : next();

// ---------- auth ----------
const loginAttempts = new Map(); // ip -> { count, until }

app.post('/api/login', wrap(async (req, res) => {
  const ip = req.ip;
  const a = loginAttempts.get(ip);
  if (a && a.until > Date.now()) throw new HttpError(429, 'ลองผิดหลายครั้งเกินไป กรุณารอสักครู่');

  const { username, password } = req.body || {};
  const user = await db.one('SELECT * FROM users WHERE username = ? AND deleted = 0', [String(username || '').trim()]);
  if (!user || !verifyPassword(String(password || ''), user.password_hash)) {
    const count = (a?.count || 0) + 1;
    loginAttempts.set(ip, { count, until: count >= 5 ? Date.now() + 60_000 : 0 });
    throw new HttpError(401, 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
  }
  loginAttempts.delete(ip);
  await db.run('DELETE FROM sessions WHERE expires_at < ?', [Date.now()]);
  const token = randomBytes(32).toString('hex');
  await db.run('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)',
    [token, user.id, Date.now() + SESSION_HOURS * 3600_000]);
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie',
    `pos_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}${secure}`);
  res.json({ id: user.id, username: user.username, display_name: user.display_name, role: user.role });
}));

app.post('/api/logout', wrap(async (req, res) => {
  const token = readCookie(req, 'pos_session');
  if (token) await db.run('DELETE FROM sessions WHERE token = ?', [token]);
  res.setHeader('Set-Cookie', 'pos_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  res.json({ ok: true });
}));

app.get('/api/me', requireLogin, (req, res) => res.json(req.user));

app.post('/api/me/password', requireLogin, wrap(async (req, res) => {
  const { current, next: newPw } = req.body || {};
  const user = await db.one('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
  if (!verifyPassword(String(current || ''), user.password_hash)) bad('รหัสผ่านเดิมไม่ถูกต้อง');
  if (String(newPw || '').length < 6) bad('รหัสผ่านใหม่ต้องมีอย่างน้อย 6 ตัวอักษร');
  await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(newPw), req.user.id]);
  res.json({ ok: true });
}));

// ---------- menu ----------
app.get('/api/menu', requireLogin, wrap(async (req, res) => {
  const rows = await db.all('SELECT * FROM menu_items ORDER BY category, name');
  res.json(req.user.role === 'admin' ? rows : rows.filter((r) => r.available));
}));

function validateMenu(body) {
  const name = String(body.name || '').trim();
  const category = String(body.category || '').trim() || 'ทั่วไป';
  const price = Number(body.price);
  if (!name) bad('กรุณาใส่ชื่อรายการ');
  if (!Number.isFinite(price) || price < 0) bad('ราคาไม่ถูกต้อง');
  return { name, category, price: money(price), available: body.available === false || body.available === 0 ? 0 : 1 };
}

app.post('/api/menu', requireAdmin, wrap(async (req, res) => {
  const m = validateMenu(req.body || {});
  res.json(await db.one('INSERT INTO menu_items (name, category, price, available, created_at) VALUES (?,?,?,?,?) RETURNING *',
    [m.name, m.category, m.price, m.available, nowLocal()]));
}));

app.put('/api/menu/:id', requireAdmin, wrap(async (req, res) => {
  const m = validateMenu(req.body || {});
  const row = await db.one('UPDATE menu_items SET name=?, category=?, price=?, available=? WHERE id=? RETURNING *',
    [m.name, m.category, m.price, m.available, Number(req.params.id)]);
  if (!row) throw new HttpError(404, 'ไม่พบรายการ');
  res.json(row);
}));

app.delete('/api/menu/:id', requireAdmin, wrap(async (req, res) => {
  await db.run('DELETE FROM menu_items WHERE id = ?', [Number(req.params.id)]);
  res.json({ ok: true });
}));

// ---------- users ----------
const adminCount = async () => (await db.one("SELECT COUNT(*) AS c FROM users WHERE role='admin' AND deleted=0")).c;

app.get('/api/users', requireAdmin, wrap(async (_req, res) => {
  res.json(await db.all('SELECT id, username, display_name, role, created_at FROM users WHERE deleted = 0 ORDER BY role, username'));
}));

app.post('/api/users', requireAdmin, wrap(async (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase();
  const display_name = String(req.body?.display_name || '').trim() || username;
  const password = String(req.body?.password || '');
  const role = req.body?.role === 'admin' ? 'admin' : 'staff';
  if (!/^[a-z0-9_.-]{3,30}$/.test(username)) bad('ชื่อผู้ใช้ต้องเป็น a-z, 0-9, _ . - ยาว 3-30 ตัว');
  if (password.length < 6) bad('รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร');
  const row = await db.one(`INSERT INTO users (username, password_hash, display_name, role, created_at) VALUES (?,?,?,?,?)
    ON CONFLICT (username) DO NOTHING RETURNING id`, [username, hashPassword(password), display_name, role, nowLocal()]);
  if (!row) bad('ชื่อผู้ใช้นี้มีอยู่แล้ว');
  res.json({ id: row.id, username, display_name, role });
}));

app.put('/api/users/:id', requireAdmin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const user = await db.one('SELECT * FROM users WHERE id = ? AND deleted = 0', [id]);
  if (!user) throw new HttpError(404, 'ไม่พบผู้ใช้');
  const display_name = String(req.body?.display_name || '').trim() || user.display_name;
  const role = req.body?.role === 'admin' ? 'admin' : req.body?.role === 'staff' ? 'staff' : user.role;
  if (user.role === 'admin' && role !== 'admin' && (await adminCount()) <= 1) bad('ต้องมีผู้ดูแลระบบอย่างน้อย 1 คน');
  if (req.body?.password && String(req.body.password).length < 6) bad('รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร');
  await tx(async (t) => {
    await t.run('UPDATE users SET display_name=?, role=? WHERE id=?', [display_name, role, id]);
    if (req.body?.password) {
      await t.run('UPDATE users SET password_hash=? WHERE id=?', [hashPassword(String(req.body.password)), id]);
      await t.run('DELETE FROM sessions WHERE user_id = ?', [id]);
    }
  });
  res.json({ ok: true });
}));

app.delete('/api/users/:id', requireAdmin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) bad('ไม่สามารถลบบัญชีของตัวเองได้');
  const user = await db.one('SELECT * FROM users WHERE id = ? AND deleted = 0', [id]);
  if (!user) throw new HttpError(404, 'ไม่พบผู้ใช้');
  if (user.role === 'admin' && (await adminCount()) <= 1) bad('ต้องมีผู้ดูแลระบบอย่างน้อย 1 คน');
  // เก็บประวัติบิลไว้ จึงลบแบบ soft และปล่อยชื่อผู้ใช้ให้ใช้ใหม่ได้
  await tx(async (t) => {
    await t.run('UPDATE users SET deleted = 1, username = ? WHERE id = ?', [`${user.username}#deleted#${id}`, id]);
    await t.run('DELETE FROM sessions WHERE user_id = ?', [id]);
  });
  res.json({ ok: true });
}));

// ---------- payment accounts (QR) ----------
const publicAccount = (a, withImage = true) => ({
  id: a.id, name: a.name, type: a.type, promptpay_id: a.promptpay_id,
  account_name: a.account_name, active: a.active, ...(withImage ? { image_data: a.image_data } : {}),
});

app.get('/api/payment-accounts', requireLogin, wrap(async (req, res) => {
  const isAdmin = req.user.role === 'admin';
  const rows = await db.all(`SELECT * FROM payment_accounts ${isAdmin ? '' : 'WHERE active = 1'} ORDER BY id`);
  res.json(rows.map((a) => publicAccount(a, isAdmin)));
}));

app.post('/api/payment-accounts', requireAdmin, wrap(async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const account_name = String(b.account_name || '').trim();
  if (!name) bad('กรุณาใส่ชื่อบัญชี');
  let promptpay_id = null, image_data = null;
  if (b.type === 'promptpay') {
    if (!normalizePromptPayId(b.promptpay_id)) bad('เลข PromptPay ต้องเป็นเบอร์มือถือ 10 หลัก หรือเลขประจำตัว 13 หลัก');
    promptpay_id = String(b.promptpay_id).replace(/\D/g, '');
  } else if (b.type === 'image') {
    if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(String(b.image_data || ''))) bad('กรุณาอัปโหลดรูป QR (PNG/JPG/WEBP)');
    image_data = b.image_data;
  } else bad('ประเภทบัญชีไม่ถูกต้อง');
  const row = await db.one(`INSERT INTO payment_accounts (name, type, promptpay_id, account_name, image_data, created_at)
    VALUES (?,?,?,?,?,?) RETURNING id`, [name, b.type, promptpay_id, account_name, image_data, nowLocal()]);
  res.json({ id: row.id });
}));

app.put('/api/payment-accounts/:id', requireAdmin, wrap(async (req, res) => {
  await db.run('UPDATE payment_accounts SET active = ? WHERE id = ?', [req.body?.active ? 1 : 0, Number(req.params.id)]);
  res.json({ ok: true });
}));

app.delete('/api/payment-accounts/:id', requireAdmin, wrap(async (req, res) => {
  await db.run('DELETE FROM payment_accounts WHERE id = ?', [Number(req.params.id)]);
  res.json({ ok: true });
}));

// สร้าง QR สำหรับยอดเงินที่ต้องชำระ
app.post('/api/payment-qr', requireLogin, wrap(async (req, res) => {
  const acc = await db.one('SELECT * FROM payment_accounts WHERE id = ? AND active = 1', [Number(req.body?.account_id)]);
  if (!acc) throw new HttpError(404, 'ไม่พบบัญชีรับเงิน');
  const amount = money(req.body?.amount || 0);
  if (acc.type === 'image') return res.json({ image: acc.image_data, dynamic: false, account: publicAccount(acc, false) });
  const payload = promptPayPayload(acc.promptpay_id, amount);
  const image = await QRCode.toDataURL(payload, { margin: 1, width: 360, errorCorrectionLevel: 'M' });
  res.json({ image, dynamic: true, payload, account: publicAccount(acc, false) });
}));

// ---------- orders ----------
async function attachItems(runner, orders) {
  if (!orders.length) return orders;
  const items = await runner.all('SELECT * FROM order_items WHERE order_id = ANY(?) ORDER BY id', [orders.map((o) => o.id)]);
  return orders.map((o) => ({ ...o, items: items.filter((i) => i.order_id === o.id) }));
}

app.post('/api/orders', requireLogin, wrap(async (req, res) => {
  const b = req.body || {};
  if (!Array.isArray(b.items) || !b.items.length) bad('ยังไม่มีรายการอาหาร');
  if (b.items.length > 200) bad('รายการมากเกินไป');
  const order_type = b.order_type === 'takeaway' ? 'takeaway' : b.order_type === 'dine_in' ? 'dine_in' : bad('กรุณาเลือกทานที่ร้านหรือกลับบ้าน');

  const ids = [...new Set(b.items.map((it) => Number(it.menu_item_id)).filter(Number.isInteger))];
  const menu = new Map((await db.all('SELECT * FROM menu_items WHERE id = ANY(?)', [ids])).map((m) => [m.id, m]));
  const lines = b.items.map((it) => {
    const m = menu.get(Number(it.menu_item_id));
    if (!m || !m.available) bad('มีรายการที่ไม่พร้อมขาย กรุณาตรวจสอบ');
    const qty = Math.floor(Number(it.qty));
    if (!(qty > 0 && qty <= 999)) bad('จำนวนไม่ถูกต้อง');
    return { menu_item_id: m.id, name: m.name, price: m.price, qty, note: String(it.note || '').slice(0, 200), line_total: money(m.price * qty) };
  });
  const subtotal = money(lines.reduce((s, l) => s + l.line_total, 0));
  const discount = money(Math.min(Math.max(Number(b.discount) || 0, 0), subtotal));
  const total = money(subtotal - discount);

  let payment_account_name = null, cash_received = null, change_amount = null;
  if (b.payment_method === 'cash') {
    cash_received = money(b.cash_received);
    if (!(cash_received >= total)) bad('รับเงินไม่พอ');
    change_amount = money(cash_received - total);
  } else if (b.payment_method === 'qr') {
    const acc = await db.one('SELECT name FROM payment_accounts WHERE id = ?', [Number(b.payment_account_id)]);
    if (!acc) bad('กรุณาเลือกบัญชีรับเงิน');
    payment_account_name = acc.name;
  } else bad('กรุณาเลือกวิธีชำระเงิน');

  // รหัสคำขอจากเครื่องขาย: ส่งซ้ำ (เน็ตหลุดแล้วลองใหม่) จะได้บิลเดิมคืน ไม่เกิดบิลซ้ำ
  const requestId = /^[A-Za-z0-9-]{8,64}$/.test(String(b.request_id || '')) ? String(b.request_id) : null;

  const order = await tx(async (t) => {
    // ล็อกการออกเลขบิล กันหลายเครื่องกดพร้อมกันแล้วได้เลขซ้ำ
    await t.query('SELECT pg_advisory_xact_lock(7001)');
    if (requestId) {
      const existing = await t.one('SELECT * FROM orders WHERE request_id = ?', [requestId]);
      if (existing) return (await attachItems(t, [existing]))[0];
    }
    const createdAt = nowLocal();
    const day = createdAt.slice(0, 10);
    const { c } = await t.one('SELECT COUNT(*) AS c FROM orders WHERE substr(created_at,1,10) = ?', [day]);
    const orderNo = `${day.replaceAll('-', '')}-${String(c + 1).padStart(4, '0')}`;
    const o = await t.one(`INSERT INTO orders (order_no, order_type, table_no, subtotal, discount, total, payment_method,
      payment_account_name, cash_received, change_amount, staff_id, staff_name, created_at, request_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *`,
    [orderNo, order_type, order_type === 'dine_in' ? String(b.table_no || '').slice(0, 20) : null,
      subtotal, discount, total, b.payment_method, payment_account_name, cash_received, change_amount,
      req.user.id, req.user.display_name, createdAt, requestId]);
    // ใส่ทุกรายการในคำสั่งเดียว (ฐานข้อมูลอยู่ไกล ลดจำนวนรอบการเรียก)
    const items = await t.all(`INSERT INTO order_items (order_id, menu_item_id, name, price, qty, note, line_total)
      VALUES ${lines.map(() => '(?,?,?,?,?,?,?)').join(', ')} RETURNING *`,
    lines.flatMap((l) => [o.id, l.menu_item_id, l.name, l.price, l.qty, l.note, l.line_total]));
    return { ...o, items: items.sort((x, y) => x.id - y.id) };
  }, { retries: requestId ? 2 : 0 });
  res.json(order);
}));

app.get('/api/orders', requireLogin, wrap(async (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : today();
  const orders = await db.all('SELECT * FROM orders WHERE substr(created_at,1,10) = ? ORDER BY id DESC', [date]);
  res.json(await attachItems(db, orders));
}));

app.post('/api/orders/:id/void', requireAdmin, wrap(async (req, res) => {
  const o = await db.one("UPDATE orders SET status = 'void' WHERE id = ? RETURNING *", [Number(req.params.id)]);
  if (!o) throw new HttpError(404, 'ไม่พบบิล');
  res.json((await attachItems(db, [o]))[0]);
}));

// ---------- reports ----------
async function summarize(where, params) {
  const base = `FROM orders WHERE status='paid' AND ${where}`;
  const [totals, byPayment, byType, byAccount, topItems, voided] = await Promise.all([
    db.one(`SELECT COUNT(*) AS orders, COALESCE(SUM(total),0) AS sales, COALESCE(SUM(discount),0) AS discount ${base}`, params),
    db.all(`SELECT payment_method AS key, COUNT(*) AS orders, SUM(total) AS sales ${base} GROUP BY payment_method`, params),
    db.all(`SELECT order_type AS key, COUNT(*) AS orders, SUM(total) AS sales ${base} GROUP BY order_type`, params),
    db.all(`SELECT payment_account_name AS key, COUNT(*) AS orders, SUM(total) AS sales ${base} AND payment_method='qr' GROUP BY payment_account_name`, params),
    db.all(`SELECT oi.name, SUM(oi.qty) AS qty, SUM(oi.line_total) AS sales
      FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE o.status='paid' AND ${where.replaceAll('created_at', 'o.created_at')}
      GROUP BY oi.name ORDER BY qty DESC, sales DESC LIMIT 15`, params),
    db.one(`SELECT COUNT(*) AS c FROM orders WHERE status='void' AND ${where}`, params),
  ]);
  return { ...totals, voided: voided.c, byPayment, byType, byAccount, topItems };
}

app.get('/api/reports/daily', requireAdmin, wrap(async (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : today();
  const [s, hourly] = await Promise.all([
    summarize('substr(created_at,1,10) = ?', [date]),
    db.all(`SELECT CAST(substr(created_at,12,2) AS INTEGER) AS hour, COUNT(*) AS orders, SUM(total) AS sales
      FROM orders WHERE status='paid' AND substr(created_at,1,10) = ? GROUP BY 1 ORDER BY 1`, [date]),
  ]);
  res.json({ date, ...s, hourly });
}));

app.get('/api/reports/monthly', requireAdmin, wrap(async (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : today().slice(0, 7);
  const [s, daily] = await Promise.all([
    summarize('substr(created_at,1,7) = ?', [month]),
    db.all(`SELECT substr(created_at,1,10) AS date, COUNT(*) AS orders, SUM(total) AS sales,
      SUM(CASE WHEN payment_method='cash' THEN total ELSE 0 END) AS cash,
      SUM(CASE WHEN payment_method='qr' THEN total ELSE 0 END) AS qr
      FROM orders WHERE status='paid' AND substr(created_at,1,7) = ? GROUP BY 1 ORDER BY 1`, [month]),
  ]);
  res.json({ month, ...s, daily });
}));

// ---------- errors ----------
app.use('/api', (_req, _res, next) => next(new HttpError(404, 'ไม่พบ API')));
app.use((err, _req, res, _next) => {
  // 503 = เชื่อมต่อฐานข้อมูลไม่ได้ชั่วคราว: หน้าเว็บจะลองใหม่เองสำหรับการชำระเงิน
  const status = err.status || (err.type === 'entity.too.large' ? 413 : isTransient(err) ? 503 : 500);
  if (status >= 500) console.error(status === 503 ? `ฐานข้อมูลไม่ตอบสนอง: ${err.message}` : err);
  const message = status === 503 ? 'เชื่อมต่อฐานข้อมูลไม่ได้ชั่วคราว กรุณาลองใหม่'
    : status === 500 ? 'เกิดข้อผิดพลาดในระบบ' : status === 413 ? 'ไฟล์ใหญ่เกินไป' : err.message;
  res.status(status).json({ error: message });
});

await initDb();
app.listen(PORT, () => {
  console.log(`POS พร้อมใช้งานที่ http://localhost:${PORT}`);
  // แสดงที่อยู่ในวง Wi-Fi สำหรับเปิดจาก iPad / มือถือ
  const lan = Object.values(networkInterfaces()).flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => `http://${n.address}:${PORT}`);
  if (lan.length) console.log(`เปิดจาก iPad (Wi-Fi เดียวกัน): ${lan.join('  ')}`);
});
