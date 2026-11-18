// Edge Function: จัดการบัญชีผู้ใช้ (เฉพาะ admin)
// ต้องใช้ service role key จึงทำในหน้าเว็บไม่ได้ — คีย์นี้อยู่ใน Supabase เท่านั้น ไม่อยู่ในหน้าเว็บ
//
// POST { action: 'create', username, display_name, password, role }
// POST { action: 'update', id, display_name?, role?, password? }
// POST { action: 'delete', id }
// (การดูรายชื่อผู้ใช้ หน้าเว็บอ่านจากตาราง profiles ได้เองผ่าน RLS)
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const EMAIL_DOMAIN = 'pos.local';
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

class Bad extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

function bkkNow() {
  const d = new Date(Date.now() + 7 * 3600_000); // Asia/Bangkok (UTC+7, ไม่มี DST)
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const url = Deno.env.get('SUPABASE_URL')!;
  const service = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

  try {
    // ใครเรียก: ตรวจ token ของผู้ใช้ แล้วดูสิทธิ์ในตาราง profiles
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: who, error: whoErr } = await service.auth.getUser(token);
    if (whoErr || !who?.user) throw new Bad('กรุณาเข้าสู่ระบบ', 401);
    const { data: me } = await service.from('profiles').select('id, role').eq('id', who.user.id).maybeSingle();
    if (me?.role !== 'admin') throw new Bad('เฉพาะผู้ดูแลระบบ', 403);

    const body = await req.json().catch(() => ({}));
    const adminCount = async () =>
      (await service.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'admin')).count ?? 0;
    const checkPassword = (pw: unknown) => {
      if (typeof pw !== 'string' || pw.length < 6) throw new Bad('รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร');
      return pw;
    };
    const role = (r: unknown) => (r === 'admin' ? 'admin' : 'staff');

    if (body.action === 'create') {
      const username = String(body.username || '').trim().toLowerCase();
      if (!/^[a-z0-9_.-]{3,30}$/.test(username)) throw new Bad('ชื่อผู้ใช้ต้องเป็น a-z, 0-9, _ . - ยาว 3-30 ตัว');
      const password = checkPassword(body.password);
      const { data: exists } = await service.from('profiles').select('id').eq('username', username).maybeSingle();
      if (exists) throw new Bad('ชื่อผู้ใช้นี้มีอยู่แล้ว');
      const { data: created, error } = await service.auth.admin.createUser({
        email: `${username}@${EMAIL_DOMAIN}`, password, email_confirm: true,
      });
      if (error || !created.user) throw new Bad(error?.message?.includes('already') ? 'ชื่อผู้ใช้นี้มีอยู่แล้ว' : `สร้างบัญชีไม่สำเร็จ: ${error?.message}`);
      const profile = {
        id: created.user.id, username, role: role(body.role),
        display_name: String(body.display_name || '').trim().slice(0, 50) || username, created_at: bkkNow(),
      };
      const { error: pErr } = await service.from('profiles').insert(profile);
      if (pErr) { await service.auth.admin.deleteUser(created.user.id); throw new Bad(`สร้างบัญชีไม่สำเร็จ: ${pErr.message}`); }
      return json(profile);
    }

    if (body.action === 'update') {
      const { data: user } = await service.from('profiles').select('*').eq('id', String(body.id || '')).maybeSingle();
      if (!user) throw new Bad('ไม่พบผู้ใช้', 404);
      const newRole = body.role ? role(body.role) : user.role;
      if (user.role === 'admin' && newRole !== 'admin' && (await adminCount()) <= 1) throw new Bad('ต้องมีผู้ดูแลระบบอย่างน้อย 1 คน');
      if (body.password) {
        const { error } = await service.auth.admin.updateUserById(user.id, { password: checkPassword(body.password) });
        if (error) throw new Bad(`เปลี่ยนรหัสผ่านไม่สำเร็จ: ${error.message}`);
      }
      const display_name = String(body.display_name || '').trim().slice(0, 50) || user.display_name;
      const { error } = await service.from('profiles').update({ display_name, role: newRole }).eq('id', user.id);
      if (error) throw new Bad(error.message);
      return json({ ok: true });
    }

    if (body.action === 'delete') {
      const id = String(body.id || '');
      if (id === me.id) throw new Bad('ไม่สามารถลบบัญชีของตัวเองได้');
      const { data: user } = await service.from('profiles').select('*').eq('id', id).maybeSingle();
      if (!user) throw new Bad('ไม่พบผู้ใช้', 404);
      if (user.role === 'admin' && (await adminCount()) <= 1) throw new Bad('ต้องมีผู้ดูแลระบบอย่างน้อย 1 คน');
      // ลบบัญชีล็อกอิน (profiles ลบตามอัตโนมัติ) — บิลเก่ายังเก็บชื่อพนักงานไว้
      const { error } = await service.auth.admin.deleteUser(id);
      if (error) throw new Bad(`ลบบัญชีไม่สำเร็จ: ${error.message}`);
      return json({ ok: true });
    }

    throw new Bad('ไม่รู้จักคำสั่ง');
  } catch (e) {
    if (e instanceof Bad) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: 'เกิดข้อผิดพลาดในระบบ' }, 500);
  }
});
