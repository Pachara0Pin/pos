// ย้ายบัญชีผู้ใช้จากตาราง users (เวอร์ชัน Node server) ไป Supabase Auth
//
//   node scripts/migrate-users.js
//
// ต้องมีใน .env: DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// - รหัสผ่านเดิมย้ายไม่ได้ (คนละรูปแบบการเข้ารหัส) จึงตั้งรหัสชั่วคราวแบบสุ่มให้ทุกบัญชี
// - รหัสชั่วคราวเขียนลงไฟล์ data/initial-passwords.txt เท่านั้น (ไม่แสดงบนจอ, ไม่ขึ้น git)
// - บิลเก่าจะผูกกับบัญชีใหม่ (orders.staff_uid)
// - รันซ้ำได้: บัญชีที่ย้ายแล้วจะข้าม
// - --finalize: เปลี่ยนชื่อตาราง users → legacy_users และลบตาราง sessions (เลิกใช้ Node server)
import '../env.js';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { mkdirSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const { DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!DATABASE_URL || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('ต้องตั้ง DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY ใน .env');
  process.exit(1);
}
const EMAIL_DOMAIN = 'pos.local';
const outFile = fileURLToPath(new URL('../data/initial-passwords.txt', import.meta.url));

const host = new URL(DATABASE_URL).hostname;
const db = new pg.Client({
  connectionString: DATABASE_URL,
  ssl: ['localhost', '127.0.0.1'].includes(host) ? false : { rejectUnauthorized: false },
});

async function authAdmin(method, path, body) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin${path}`, {
    method,
    headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${data.msg || data.message || data.error_description || JSON.stringify(data)}`);
  return data;
}

// อ่านง่าย พิมพ์บน iPad ง่าย: ไม่มีตัวที่สับสน (0/O, 1/l)
function tempPassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from(randomBytes(10), (b) => chars[b % chars.length]).join('');
}

await db.connect();
try {
  if (!(await db.query("SELECT to_regclass('public.users') AS t")).rows[0].t) {
    console.log('ไม่มีตาราง users (ย้ายไปแล้ว) — ไม่มีอะไรต้องทำ');
    process.exit(0);
  }
  const users = (await db.query('SELECT * FROM users WHERE deleted = 0 ORDER BY id')).rows;
  mkdirSync(fileURLToPath(new URL('../data/', import.meta.url)), { recursive: true });
  let created = 0;

  for (const u of users) {
    const existing = (await db.query('SELECT id FROM profiles WHERE username = $1', [u.username])).rows[0];
    let uid = existing?.id;
    if (!uid) {
      const password = tempPassword();
      const authUser = await authAdmin('POST', '/users', { email: `${u.username}@${EMAIL_DOMAIN}`, password, email_confirm: true });
      uid = authUser.id;
      await db.query('INSERT INTO profiles (id, username, display_name, role, created_at) VALUES ($1,$2,$3,$4,$5)',
        [uid, u.username, u.display_name, u.role, u.created_at]);
      appendFileSync(outFile, `${u.username}\t${password}\t(${u.role})\n`, { mode: 0o600 });
      created++;
      console.log(`สร้างบัญชี ${u.username} (${u.role})`);
    } else {
      console.log(`ข้าม ${u.username} (ย้ายแล้ว)`);
    }
    const r = await db.query('UPDATE orders SET staff_uid = $1 WHERE staff_id = $2 AND staff_uid IS NULL', [uid, u.id]);
    if (r.rowCount) console.log(`  ผูกบิลเก่า ${r.rowCount} บิล`);
  }

  console.log(`\nเสร็จ: สร้าง ${created} บัญชี${created ? ` — รหัสผ่านชั่วคราวอยู่ในไฟล์ data/initial-passwords.txt` : ''}`);
  // --finalize: เลิกใช้ระบบเก่า (Node server จะล็อกอินไม่ได้อีก) — รันเมื่อย้ายไปหน้าเว็บใหม่แล้ว
  if (process.argv.includes('--finalize')) {
    await db.query('BEGIN');
    await db.query('DROP TABLE IF EXISTS sessions');
    await db.query('ALTER TABLE users RENAME TO legacy_users');
    await db.query('ALTER TABLE legacy_users ENABLE ROW LEVEL SECURITY');
    await db.query('COMMIT');
    console.log('ตาราง users เปลี่ยนชื่อเป็น legacy_users (ลบได้เมื่อมั่นใจแล้ว)');
  } else {
    console.log('ระบบเก่ายังใช้งานได้ — เมื่อพร้อมเลิกใช้ ให้รันอีกครั้งพร้อม --finalize');
  }
} catch (e) {
  await db.query('ROLLBACK').catch(() => {});
  console.error('ล้มเหลว:', e.message);
  process.exitCode = 1;
} finally {
  await db.end();
}
