import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

mkdirSync(new URL('./data/', import.meta.url), { recursive: true });
export const db = new DatabaseSync(fileURLToPath(new URL('./data/pos.db', import.meta.url)));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','staff')),
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS menu_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'ทั่วไป',
  price REAL NOT NULL CHECK (price >= 0),
  available INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('promptpay','image')),
  promptpay_id TEXT,
  account_name TEXT,
  image_data TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no TEXT NOT NULL UNIQUE,
  order_type TEXT NOT NULL CHECK (order_type IN ('dine_in','takeaway')),
  table_no TEXT,
  subtotal REAL NOT NULL,
  discount REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL,
  payment_method TEXT NOT NULL CHECK (payment_method IN ('cash','qr')),
  payment_account_name TEXT,
  cash_received REAL,
  change_amount REAL,
  status TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('paid','void')),
  staff_id INTEGER REFERENCES users(id),
  staff_name TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id INTEGER,
  name TEXT NOT NULL,
  price REAL NOT NULL,
  qty INTEGER NOT NULL CHECK (qty > 0),
  note TEXT,
  line_total REAL NOT NULL
);
`);

/** เวลาท้องถิ่น (ตั้ง TZ=Asia/Bangkok ใน server.js) รูปแบบ YYYY-MM-DD HH:MM:SS */
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

// ข้อมูลเริ่มต้นครั้งแรก
const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
if (userCount === 0) {
  const ins = db.prepare('INSERT INTO users (username, password_hash, display_name, role, created_at) VALUES (?,?,?,?,?)');
  ins.run('admin', hashPassword('admin123'), 'ผู้ดูแลระบบ', 'admin', nowLocal());
  ins.run('staff', hashPassword('staff123'), 'พนักงาน 1', 'staff', nowLocal());
  console.log('สร้างบัญชีเริ่มต้น: admin / admin123 และ staff / staff123 (กรุณาเปลี่ยนรหัสผ่าน)');
}

const menuCount = db.prepare('SELECT COUNT(*) AS c FROM menu_items').get().c;
if (menuCount === 0) {
  const ins = db.prepare('INSERT INTO menu_items (name, category, price, created_at) VALUES (?,?,?,?)');
  [
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
  ].forEach(([n, c, p]) => ins.run(n, c, p, nowLocal()));
}
