// ย้ายข้อมูลจาก SQLite เดิม (data/pos.db) ไปยัง Postgres/Supabase ตาม DATABASE_URL
//
//   node scripts/migrate-sqlite.js            ย้ายเมื่อฐานข้อมูลปลายทางยังว่างเท่านั้น
//   node scripts/migrate-sqlite.js --replace  ลบข้อมูลปลายทางทั้งหมดก่อน แล้วย้ายใหม่
import '../env.js';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pool, tx, SCHEMA } from '../db.js';

const sqlitePath = process.argv.find((a) => a.endsWith('.db')) || fileURLToPath(new URL('../data/pos.db', import.meta.url));
const replace = process.argv.includes('--replace');

// เรียงตาม foreign key: ตารางแม่ก่อน
const TABLES = ['users', 'menu_items', 'payment_accounts', 'orders', 'order_items'];

if (!existsSync(sqlitePath)) {
  console.error(`ไม่พบไฟล์ ${sqlitePath}`);
  process.exit(1);
}
const src = new DatabaseSync(sqlitePath, { readOnly: true });

try {
  await pool.query(SCHEMA);
  const counts = {};
  for (const t of TABLES) counts[t] = Number((await pool.query(`SELECT COUNT(*) AS c FROM ${t}`)).rows[0].c);
  const hasData = Object.values(counts).some((c) => c > 0);
  if (hasData && !replace) {
    console.error('ฐานข้อมูลปลายทางมีข้อมูลอยู่แล้ว:', counts);
    console.error('ถ้าต้องการลบของเดิมแล้วแทนที่ด้วยข้อมูลจาก SQLite ให้รันอีกครั้งพร้อม --replace');
    process.exit(1);
  }

  await tx(async (t) => {
    if (replace) await t.query(`TRUNCATE ${['sessions', ...TABLES].join(', ')} RESTART IDENTITY CASCADE`);
    for (const table of TABLES) {
      const rows = src.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
      for (const row of rows) {
        const cols = Object.keys(row);
        await t.query(
          `INSERT INTO ${table} (${cols.join(', ')}) OVERRIDING SYSTEM VALUE VALUES (${cols.map(() => '?').join(', ')})`,
          cols.map((c) => row[c]),
        );
      }
      // ให้เลข id ถัดไปต่อจากข้อมูลที่ย้ายมา
      await t.query(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 0) + 1, false)`);
      console.log(`${table}: ย้าย ${rows.length} แถว`);
    }
  });
  console.log('ย้ายข้อมูลเสร็จแล้ว (ผู้ใช้ทุกคนต้องเข้าสู่ระบบใหม่)');
} finally {
  src.close();
  await pool.end();
}
