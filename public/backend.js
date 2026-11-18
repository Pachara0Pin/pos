// ===== ชั้นเชื่อมต่อ Supabase =====
// หน้าเว็บเรียก api('/menu') ฯลฯ เหมือนเดิม แต่ไฟล์นี้แปลงเป็นการเรียก Supabase โดยตรง
// ความปลอดภัยอยู่ที่ฐานข้อมูล (Row Level Security + ฟังก์ชันใน Postgres) ไม่ใช่ที่ไฟล์นี้
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { promptPayPayload, normalizePromptPayId } from './promptpay.js';

const EMAIL_DOMAIN = 'pos.local';
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: 'pos-auth' },
});

// ---------- errors ----------
function httpError(message, status = 400, retryable = false) {
  const e = new Error(message);
  e.status = status;
  e.retryable = retryable;
  return e;
}

const NETWORK = /fetch|network|timeout|abort|load failed|connection/i;
const PG_MESSAGES = {
  23505: 'ข้อมูลนี้มีอยู่แล้ว',
  23503: 'ไม่พบข้อมูลที่อ้างถึง',
  23514: 'ข้อมูลไม่ถูกต้อง',
  42501: 'ไม่มีสิทธิ์ทำรายการนี้',
};

/** แปลง error จาก Supabase เป็นข้อความภาษาไทยสำหรับผู้ใช้ */
function fromSupabase(error, messages = {}) {
  if (!error) return null;
  if (error.name === 'AbortError' || NETWORK.test(error.message || '') && !error.code) {
    return httpError('เชื่อมต่อฐานข้อมูลไม่ได้ชั่วคราว ตรวจสอบอินเทอร์เน็ต', 503, true);
  }
  if (error.code === 'PGRST301' || error.code === '401') return httpError('กรุณาเข้าสู่ระบบ', 401);
  // ข้อความภาษาไทยจากฟังก์ชันในฐานข้อมูล (RAISE EXCEPTION) ใช้ได้เลย
  if (error.code === 'P0001' || /[฀-๿]/.test(error.message || '')) return httpError(error.message, error.code === '42501' ? 403 : 400);
  return httpError(messages[error.code] || PG_MESSAGES[error.code] || 'เกิดข้อผิดพลาดในระบบ', 400);
}

/** รัน query ของ Supabase พร้อมเวลาจำกัด แล้วคืน data หรือโยน error */
async function run(builder, { timeout = 20000, messages } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const { data, error } = await builder.abortSignal(ctrl.signal);
    if (error) throw fromSupabase(error, messages);
    return data;
  } catch (e) {
    if (e.status) throw e;
    throw httpError('เชื่อมต่อฐานข้อมูลไม่ได้ชั่วคราว ตรวจสอบอินเทอร์เน็ต', 503, true);
  } finally {
    clearTimeout(timer);
  }
}

/** อ่านข้อมูล: ลองใหม่เองเมื่อเน็ตสะดุด */
async function read(makeBuilder, opts) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run(makeBuilder(), opts);
    } catch (e) {
      if (!e.retryable || attempt >= 2) throw e;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
}

// ---------- session / profile ----------
let profileCache = null;

async function currentProfile() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) throw httpError('กรุณาเข้าสู่ระบบ', 401);
  if (profileCache?.id === session.user.id) return profileCache;
  const p = await read(() => sb.from('profiles').select('id, username, display_name, role').eq('id', session.user.id).maybeSingle());
  if (!p) {
    await sb.auth.signOut();
    throw httpError('บัญชีนี้ไม่มีสิทธิ์ใช้งาน กรุณาติดต่อผู้ดูแล', 401);
  }
  profileCache = p;
  return p;
}

const emailOf = (username) => `${String(username || '').trim().toLowerCase()}@${EMAIL_DOMAIN}`;

async function login({ username, password }) {
  profileCache = null;
  const { error } = await sb.auth.signInWithPassword({ email: emailOf(username), password: String(password || '') });
  if (error) {
    if (NETWORK.test(error.message || '') && !error.status) throw httpError('เชื่อมต่อไม่ได้ ตรวจสอบอินเทอร์เน็ต', 503, true);
    if (error.status === 429) throw httpError('ลองผิดหลายครั้งเกินไป กรุณารอสักครู่', 429);
    throw httpError('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง', 401);
  }
  return currentProfile();
}

async function changePassword({ current, next }) {
  const me = await currentProfile();
  if (String(next || '').length < 6) throw httpError('รหัสผ่านใหม่ต้องมีอย่างน้อย 6 ตัวอักษร');
  const { error: e1 } = await sb.auth.signInWithPassword({ email: emailOf(me.username), password: String(current || '') });
  if (e1) throw httpError('รหัสผ่านเดิมไม่ถูกต้อง');
  const { error: e2 } = await sb.auth.updateUser({ password: String(next) });
  if (e2) throw httpError(`เปลี่ยนรหัสผ่านไม่สำเร็จ: ${e2.message}`);
  return { ok: true };
}

// ---------- admin users (Edge Function) ----------
async function adminUsers(body) {
  const { data, error } = await sb.functions.invoke('admin-users', { body });
  if (error) {
    let msg = 'เกิดข้อผิดพลาดในระบบ';
    try { msg = (await error.context.json()).error || msg; } catch { if (NETWORK.test(error.message || '')) msg = 'เชื่อมต่อไม่ได้ ตรวจสอบอินเทอร์เน็ต'; }
    throw httpError(msg, error.context?.status || 400);
  }
  return data;
}

// ---------- menu ----------
const MENU_COLS = '*, kitchen:kitchens(name)';
const menuRow = (m) => {
  const { kitchen, ...rest } = m;
  return { ...rest, kitchen_name: kitchen?.name ?? null };
};

function validateMenu(b) {
  const name = String(b.name || '').trim();
  const price = Number(b.price);
  if (!name) throw httpError('กรุณาใส่ชื่อรายการ');
  if (!Number.isFinite(price) || price < 0) throw httpError('ราคาไม่ถูกต้อง');
  const kid = b.kitchen_id === '' || b.kitchen_id == null ? null : Number(b.kitchen_id);
  return {
    name, category: String(b.category || '').trim() || 'ทั่วไป', price: Math.round(price * 100) / 100,
    available: b.available === false || b.available === 0 ? 0 : 1, kitchen_id: kid,
  };
}

// ---------- payment accounts ----------
function validateAccount(b) {
  const name = String(b.name || '').trim();
  if (!name) throw httpError('กรุณาใส่ชื่อบัญชี');
  const row = { name, account_name: String(b.account_name || '').trim(), type: b.type, promptpay_id: null, image_data: null };
  if (b.type === 'promptpay') {
    if (!normalizePromptPayId(b.promptpay_id)) throw httpError('เลข PromptPay ต้องเป็นเบอร์มือถือ 10 หลัก หรือเลขประจำตัว 13 หลัก');
    row.promptpay_id = String(b.promptpay_id).replace(/\D/g, '');
  } else if (b.type === 'image') {
    if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(String(b.image_data || ''))) throw httpError('กรุณาอัปโหลดรูป QR (PNG/JPG/WEBP)');
    row.image_data = b.image_data;
  } else throw httpError('ประเภทบัญชีไม่ถูกต้อง');
  return row;
}

/** สร้างรูป QR จากข้อความ (ทำในเครื่อง ไม่ส่งข้อมูลออกไปไหน) */
function qrDataUrl(text) {
  const qr = window.qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createDataURL(8, 2);
}

const sortItems = (o) => ({ ...o, items: [...(o.items || [])].sort((a, b) => a.id - b.id) });

// ---------- router: path + method → Supabase ----------
const routes = [
  ['POST', /^\/login$/, (_, b) => login(b)],
  ['POST', /^\/logout$/, async () => { profileCache = null; await sb.auth.signOut(); return { ok: true }; }],
  ['GET', /^\/me$/, () => currentProfile()],
  ['POST', /^\/me\/password$/, (_, b) => changePassword(b)],

  ['GET', /^\/menu$/, async () => {
    const me = await currentProfile();
    const rows = (await read(() => sb.from('menu_items').select(MENU_COLS).order('category').order('name'))).map(menuRow);
    return me.role === 'admin' ? rows : rows.filter((r) => r.available);
  }],
  ['POST', /^\/menu$/, async (_, b) => menuRow(await run(sb.from('menu_items').insert({ ...validateMenu(b), created_at: bkkNow() }).select(MENU_COLS).single(),
    { messages: { 23503: 'ไม่พบครัวที่เลือก' } }))],
  ['PUT', /^\/menu\/(\d+)$/, async ([id], b) => menuRow(await run(sb.from('menu_items').update(validateMenu(b)).eq('id', id).select(MENU_COLS).single(),
    { messages: { 23503: 'ไม่พบครัวที่เลือก', PGRST116: 'ไม่พบรายการ' } }))],
  ['DELETE', /^\/menu\/(\d+)$/, async ([id]) => { await run(sb.from('menu_items').delete().eq('id', id)); return { ok: true }; }],

  ['GET', /^\/kitchens$/, async () => (await read(() => sb.from('kitchens').select('*, menu_items(id)').order('name')))
    .map(({ menu_items: mi, ...k }) => ({ ...k, menu_count: mi?.length || 0 }))],
  ['POST', /^\/kitchens$/, (_, b) => run(sb.from('kitchens').insert({ name: kitchenName(b), created_at: bkkNow() }).select().single(),
    { messages: { 23505: 'มีครัวชื่อนี้แล้ว' } })],
  ['PUT', /^\/kitchens\/(\d+)$/, ([id], b) => run(sb.from('kitchens').update({ name: kitchenName(b) }).eq('id', id).select().single(),
    { messages: { 23505: 'มีครัวชื่อนี้แล้ว', PGRST116: 'ไม่พบครัว' } })],
  ['DELETE', /^\/kitchens\/(\d+)$/, async ([id]) => { await run(sb.from('kitchens').delete().eq('id', id)); return { ok: true }; }],

  ['GET', /^\/users$/, () => read(() => sb.from('profiles').select('id, username, display_name, role, created_at').order('role').order('username'))],
  ['POST', /^\/users$/, (_, b) => adminUsers({ action: 'create', ...b })],
  ['PUT', /^\/users\/([0-9a-f-]{36})$/, ([id], b) => adminUsers({ action: 'update', id, ...b })],
  ['DELETE', /^\/users\/([0-9a-f-]{36})$/, ([id]) => adminUsers({ action: 'delete', id })],

  ['GET', /^\/payment-accounts$/, () => read(() => sb.from('payment_accounts').select('*').order('id'))],
  ['POST', /^\/payment-accounts$/, (_, b) => run(sb.from('payment_accounts').insert({ ...validateAccount(b), created_at: bkkNow() }).select('id').single())],
  ['PUT', /^\/payment-accounts\/(\d+)$/, async ([id], b) => { await run(sb.from('payment_accounts').update({ active: b.active ? 1 : 0 }).eq('id', id)); return { ok: true }; }],
  ['DELETE', /^\/payment-accounts\/(\d+)$/, async ([id]) => { await run(sb.from('payment_accounts').delete().eq('id', id)); return { ok: true }; }],
  ['POST', /^\/payment-qr$/, async (_, b) => {
    const acc = await read(() => sb.from('payment_accounts').select('*').eq('id', Number(b.account_id)).eq('active', 1).maybeSingle());
    if (!acc) throw httpError('ไม่พบบัญชีรับเงิน', 404);
    if (acc.type === 'image') return { image: acc.image_data, dynamic: false };
    const payload = promptPayPayload(acc.promptpay_id, Math.round(Number(b.amount || 0) * 100) / 100);
    return { image: qrDataUrl(payload), dynamic: true, payload };
  }],

  ['GET', /^\/orders\?date=(\d{4}-\d{2}-\d{2})$/, async ([date]) => (await read(() => sb.from('orders')
    .select('*, items:order_items(*)').like('created_at', `${date}%`).order('id', { ascending: false }))).map(sortItems)],
  // คิดเงิน: คำนวณราคา/เลขบิลในฐานข้อมูล (ฟังก์ชัน checkout) — ส่งซ้ำด้วย request_id เดิมได้บิลเดิม
  ['POST', /^\/orders$/, (_, b, opts) => run(sb.rpc('checkout', { p: b }), { timeout: opts.timeout || 30000 })],
  ['POST', /^\/orders\/(\d+)\/void$/, ([id]) => run(sb.rpc('void_order', { p_id: Number(id) }))],

  ['GET', /^\/reports\/daily\?date=(\d{4}-\d{2}-\d{2})$/, async ([date]) => ({ date, ...(await read(() => sb.rpc('sales_summary', { p_prefix: date }))) })],
  ['GET', /^\/reports\/monthly\?month=(\d{4}-\d{2})$/, async ([month]) => ({ month, ...(await read(() => sb.rpc('sales_summary', { p_prefix: month }))) })],
];

function kitchenName(b) {
  const name = String(b?.name || '').trim().slice(0, 50);
  if (!name) throw httpError('กรุณาใส่ชื่อครัว');
  return name;
}

function bkkNow() {
  const d = new Date(Date.now() + 7 * 3600_000); // Asia/Bangkok
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/** จุดเรียกเดียวของหน้าเว็บ: api('/menu'), api('/orders', { body }) ... */
export async function backend(path, opts = {}) {
  const method = opts.method || (opts.body ? 'POST' : 'GET');
  const clean = decodeURIComponent(path);
  for (const [m, re, handler] of routes) {
    if (m !== method) continue;
    const match = clean.match(re);
    if (match) return handler(match.slice(1), opts.body || {}, opts);
  }
  throw httpError(`ไม่รองรับ ${method} ${path}`, 404);
}

// ออกจากระบบในแท็บอื่น / token หมดอายุ → ให้หน้าเว็บกลับไปหน้าเข้าสู่ระบบ
sb.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_OUT') {
    profileCache = null;
    window.dispatchEvent(new Event('pos:signed-out'));
  }
});
