// ตรวจความเสถียรของการเชื่อมต่อฐานข้อมูล: node scripts/db-check.js [จำนวนครั้ง]
import '../env.js';
import pg from 'pg';

const N = Number(process.argv[2]) || 100;
const url = new URL(process.env.DATABASE_URL);
const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
const cfg = () => ({
  connectionString: url.toString(),
  ssl: local ? false : { rejectUnauthorized: false },
  query_timeout: 5000,
  connectionTimeoutMillis: 8000,
});

console.log(`host: ${url.hostname}:${url.port}`);

// 1) หลายคำสั่งบน connection เดียว
const times = [];
let fails = 0;
let c = new pg.Client(cfg());
await c.connect();
for (let i = 0; i < N; i++) {
  const t = Date.now();
  try {
    await c.query('SELECT $1::int + 1 AS n', [i]);
    times.push(Date.now() - t);
  } catch (e) {
    fails++;
    console.log(`  query ${i + 1}: ${e.message}`);
    await c.end().catch(() => {});
    c = new pg.Client(cfg());
    await c.connect().catch((err) => console.log('  reconnect failed:', err.message));
  }
}
await c.end().catch(() => {});
times.sort((a, b) => a - b);
const pct = (p) => times[Math.min(times.length - 1, Math.floor(times.length * p))];
console.log(`queries: ${N - fails}/${N} ok, fail ${fails} | median ${pct(0.5)} ms, p95 ${pct(0.95)} ms, max ${times.at(-1)} ms`);

// 2) เปิด connection ใหม่หลายครั้ง
let connFails = 0;
const connTimes = [];
for (let i = 0; i < 10; i++) {
  const cc = new pg.Client(cfg());
  const t = Date.now();
  try { await cc.connect(); await cc.query('SELECT 1'); connTimes.push(Date.now() - t); }
  catch (e) { connFails++; console.log(`  connect ${i + 1}: ${e.message}`); }
  await cc.end().catch(() => {});
}
console.log(`connects: ${10 - connFails}/10 ok | avg ${Math.round(connTimes.reduce((a, b) => a + b, 0) / (connTimes.length || 1))} ms`);
process.exit(fails || connFails ? 1 : 0);
