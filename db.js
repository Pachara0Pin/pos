// ชั้นฐานข้อมูล: PostgreSQL (Supabase) ผ่าน node-postgres
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

// COUNT / id (bigint) และเงิน (numeric) ให้คืนค่าเป็น number แทน string
pg.types.setTypeParser(20, (v) => Number.parseInt(v, 10));
pg.types.setTypeParser(1700, (v) => Number.parseFloat(v));

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('ไม่พบ DATABASE_URL — สร้างไฟล์ .env ตามตัวอย่างใน .env.example');
  process.exit(1);
}

function sslConfig(connectionString) {
  const host = new URL(connectionString).hostname;
  if (['localhost', '127.0.0.1', '::1'].includes(host)) return false;
  const ca = process.env.DATABASE_CA_CERT;
  if (ca) return { ca: readFileSync(ca, 'utf8') };
  console.warn('คำเตือน: ยังไม่ได้ตั้ง DATABASE_CA_CERT — เชื่อมต่อแบบเข้ารหัสแต่ไม่ตรวจใบรับรองเซิร์ฟเวอร์ (ดู README)');
  return { rejectUnauthorized: false };
}

export const pool = new pg.Pool({
  connectionString: url,
  ssl: sslConfig(url),
  max: Number(process.env.DATABASE_POOL_SIZE) || 5,
  idleTimeoutMillis: 30_000,
  // ฐานข้อมูลอยู่บนอินเทอร์เน็ต: ถ้าเน็ตสะดุด ให้ตัดและแจ้ง error แทนการค้างไปเรื่อยๆ
  keepAlive: true,
  // ปกติคำสั่งหนึ่งใช้ < 1 วินาที: ถ้าเกิน 5 วินาทีถือว่าเน็ตหลุด แล้วลองใหม่ด้วย connection ใหม่
  connectionTimeoutMillis: 5_000,
  query_timeout: 5_000,
});
pool.on('error', (err) => console.error('ฐานข้อมูลหลุดการเชื่อมต่อ:', err.message));

// เริ่ม transaction พร้อมตั้งเวลาจำกัดในรอบเดียว:
// - ถ้าเน็ตหลุดกลาง transaction ฐานข้อมูลจะยกเลิกเองใน 5 วินาที (ไม่ค้างล็อกเลขบิล)
// - transaction ของเราสั้นมาก (คำสั่งติดกัน ห่างกันไม่ถึงวินาที) จึงไม่โดนตัดในการใช้งานปกติ
const BEGIN_SQL = "BEGIN; SET LOCAL idle_in_transaction_session_timeout = '5s'; SET LOCAL lock_timeout = '4s'; SET LOCAL statement_timeout = '10s'";

// ใช้ ? เป็น placeholder แล้วแปลงเป็น $1, $2, ... ของ Postgres
const toPg = (sql) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };

/** error ที่เกิดจากเน็ต/การเชื่อมต่อ (ลองใหม่ได้) ไม่ใช่ error จากข้อมูล */
export function isTransient(err) {
  const msg = String(err?.message || '');
  return /timeout|terminated|ECONNRESET|EPIPE|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|Connection.*(ended|closed)/i.test(msg)
    // 55P03 = รอล็อกนานเกิน (มี transaction ค้างจากเน็ตหลุด), 57014 = คำสั่งถูกยกเลิกเพราะเกินเวลา
    || ['57P01', '57P02', '57P03', '08000', '08003', '08006', '08001', '08004', '53300', '55P03', '57014'].includes(err?.code);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeQueries(runner, { retryReads = false } = {}) {
  const query = async (sql, params = []) => {
    const readOnly = retryReads && /^\s*SELECT\b/i.test(sql);
    for (let attempt = 0; ; attempt++) {
      try {
        return await runner.query(toPg(sql), params);
      } catch (e) {
        // pool.query คืน connection ที่เสียทิ้งให้อยู่แล้ว จึงลองใหม่ได้ทันทีด้วย connection ใหม่
        if (!readOnly || attempt >= 2 || !isTransient(e)) throw e;
        await sleep(200 * (attempt + 1));
      }
    }
  };
  return {
    query,
    all: async (sql, params) => (await query(sql, params)).rows,
    one: async (sql, params) => (await query(sql, params)).rows[0],
    run: async (sql, params) => (await query(sql, params)).rowCount,
  };
}

export const db = makeQueries(pool, { retryReads: true });

/**
 * รันหลายคำสั่งใน transaction เดียว
 * retries > 0 ใช้ได้เฉพาะ fn ที่รันซ้ำแล้วไม่เกิดผลซ้ำ (idempotent) เช่นการออกบิลที่มี request_id
 */
export async function tx(fn, { retries = 0 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let client;
    try {
      client = await pool.connect();
    } catch (e) {
      if (attempt < retries && isTransient(e)) { await sleep(300 * (attempt + 1)); continue; }
      throw e;
    }
    let broken = null;
    // connection ที่หลุดระหว่างใช้งานจะส่ง event 'error': ต้องรับไว้ ไม่งั้นเซิร์ฟเวอร์ทั้งตัวล้ม
    const onError = (err) => { broken = err; };
    client.on('error', onError);
    try {
      await client.query(BEGIN_SQL);
      const result = await fn(makeQueries(client));
      await client.query('COMMIT');
      return result;
    } catch (e) {
      if (isTransient(e)) broken = e; // connection อาจเสีย: ทิ้งไป ไม่คืนเข้า pool
      else await client.query('ROLLBACK').catch((err) => { broken = err; });
      if (attempt < retries && isTransient(e)) { await sleep(300 * (attempt + 1)); continue; }
      throw e;
    } finally {
      // connection ที่เสียจะถูกทิ้ง: คง listener ไว้รับ error ที่อาจตามมาภายหลัง
      if (!broken) client.removeListener('error', onError);
      client.release(broken || undefined);
    }
  }
}

/** เวลาท้องถิ่น (TZ=Asia/Bangkok) รูปแบบ YYYY-MM-DD HH:MM:SS */
export function nowLocal(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const a = Buffer.from(hash, 'hex');
  const b = scryptSync(password, salt, 64);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','staff')),
  deleted SMALLINT NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at BIGINT NOT NULL
);

-- ครัว (เช่น ครัว 1, ครัวเครื่องดื่ม): ใช้แยกใบสั่งอาหารหลังคิดเงิน
CREATE TABLE IF NOT EXISTS kitchens (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS menu_items (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'ทั่วไป',
  price NUMERIC(12,2) NOT NULL CHECK (price >= 0),
  available SMALLINT NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_accounts (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('promptpay','image')),
  promptpay_id TEXT,
  account_name TEXT,
  image_data TEXT,
  active SMALLINT NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  order_no TEXT NOT NULL UNIQUE,
  order_type TEXT NOT NULL CHECK (order_type IN ('dine_in','takeaway')),
  table_no TEXT,
  subtotal NUMERIC(12,2) NOT NULL,
  discount NUMERIC(12,2) NOT NULL DEFAULT 0,
  total NUMERIC(12,2) NOT NULL,
  payment_method TEXT NOT NULL CHECK (payment_method IN ('cash','qr')),
  payment_account_name TEXT,
  cash_received NUMERIC(12,2),
  change_amount NUMERIC(12,2),
  status TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('paid','void')),
  staff_id BIGINT REFERENCES users(id),
  staff_name TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
-- รหัสคำขอจากเครื่องขาย: กดจ่ายซ้ำ/ลองใหม่หลังเน็ตหลุด จะได้บิลเดิม ไม่เกิดบิลซ้ำ
ALTER TABLE orders ADD COLUMN IF NOT EXISTS request_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_request_id ON orders(request_id);

CREATE TABLE IF NOT EXISTS order_items (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id BIGINT,
  name TEXT NOT NULL,
  price NUMERIC(12,2) NOT NULL,
  qty INTEGER NOT NULL CHECK (qty > 0),
  note TEXT,
  line_total NUMERIC(12,2) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

-- เมนูผูกกับครัว (ลบครัวแล้วเมนูกลายเป็น "ไม่ระบุครัว")
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS kitchen_id BIGINT REFERENCES kitchens(id) ON DELETE SET NULL;
-- เก็บครัว ณ ตอนขายไว้ในบิล (ย้าย/ลบครัวภายหลัง ใบสั่งเก่ายังพิมพ์ซ้ำได้ถูกต้อง)
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS kitchen_id BIGINT;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS kitchen_name TEXT;

-- Supabase เปิด REST API ให้ทุกตารางใน schema public อัตโนมัติ
-- เปิด RLS โดยไม่มี policy = ปิดการเข้าถึงผ่าน API ทั้งหมด (เซิร์ฟเวอร์เราต่อตรงจึงไม่ติด RLS)
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE kitchens ENABLE ROW LEVEL SECURITY;
`;

/** สร้างตาราง และใส่ข้อมูลเริ่มต้นถ้ายังว่าง (ลองใหม่เองถ้าเน็ตสะดุดตอนเปิดเซิร์ฟเวอร์) */
export async function initDb() {
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query(SCHEMA); // CREATE ... IF NOT EXISTS: รันซ้ำได้
      await tx(seed);           // ตรวจและใส่ข้อมูลใน transaction เดียว: รันซ้ำได้
      return;
    } catch (e) {
      if (!isTransient(e) || attempt >= 6) throw e;
      console.warn(`เชื่อมต่อฐานข้อมูลไม่สำเร็จ (${e.message}) — ลองใหม่ครั้งที่ ${attempt + 1}`);
      await sleep(1000 * attempt);
    }
  }
}

async function seed(t) {
  // กันเซิร์ฟเวอร์สองตัวเปิดพร้อมกันแล้วใส่ข้อมูลซ้ำ
  await t.query('SELECT pg_advisory_xact_lock(7002)');
  if ((await t.one('SELECT COUNT(*) AS c FROM users')).c === 0) {
    const sql = 'INSERT INTO users (username, password_hash, display_name, role, created_at) VALUES (?,?,?,?,?) ON CONFLICT (username) DO NOTHING';
    await t.run(sql, ['admin', hashPassword('admin123'), 'ผู้ดูแลระบบ', 'admin', nowLocal()]);
    await t.run(sql, ['staff', hashPassword('staff123'), 'พนักงาน 1', 'staff', nowLocal()]);
    console.log('สร้างบัญชีเริ่มต้น: admin / admin123 และ staff / staff123 (กรุณาเปลี่ยนรหัสผ่าน)');
  }

  if ((await t.one('SELECT COUNT(*) AS c FROM menu_items')).c === 0) {
    const items = [
      ['ข้าวผัดหมู', 'อาหารจานเดียว', 50],
      ['ข้าวกะเพราไก่ไข่ดาว', 'อาหารจานเดียว', 60],
      ['ผัดไทยกุ้งสด', 'อาหารจานเดียว', 70],
      ['ข้าวมันไก่', 'อาหารจานเดียว', 50],
      ['ต้มยำกุ้ง', 'กับข้าว', 120],
      ['ไข่เจียวหมูสับ', 'กับข้าว', 60],
      ['ส้มตำไทย', 'กับข้าว', 50],
      ['ข้าวสวย', 'อื่นๆ', 10],
      ['ชาไทยเย็น', 'เครื่องดื่ม', 35],
      ['น้ำเปล่า', 'เครื่องดื่ม', 10],
      ['โค้ก', 'เครื่องดื่ม', 20],
    ];
    await t.run(`INSERT INTO menu_items (name, category, price, created_at) VALUES ${items.map(() => '(?,?,?,?)').join(', ')}`,
      items.flatMap(([n, c, p]) => [n, c, p, nowLocal()]));
  }
}
