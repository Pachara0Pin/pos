// ต้อง import ไฟล์นี้ก่อนไฟล์อื่น: โหลด .env และตั้งเขตเวลาไทย
try {
  process.loadEnvFile(new URL('./.env', import.meta.url));
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}
process.env.TZ = process.env.TZ || 'Asia/Bangkok';
