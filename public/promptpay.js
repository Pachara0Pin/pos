// สร้าง payload PromptPay (มาตรฐาน EMVCo / Thai QR Payment) พร้อมจำนวนเงิน

const f = (id, value) => id + String(value.length).padStart(2, '0') + value;

function crc16(str) {
  let crc = 0xffff;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/** ตรวจและแปลงเลข PromptPay: เบอร์มือถือ 10 หลัก, เลขบัตรประชาชน/เลขผู้เสียภาษี 13 หลัก, e-Wallet 15 หลัก */
export function normalizePromptPayId(raw) {
  const id = String(raw || '').replace(/\D/g, '');
  if (id.length === 10 && id.startsWith('0')) return { tag: '01', value: '0066' + id.slice(1) };
  if (id.length === 13) return { tag: '02', value: id };
  if (id.length === 15) return { tag: '03', value: id };
  return null;
}

export function promptPayPayload(rawId, amount) {
  const target = normalizePromptPayId(rawId);
  if (!target) throw new Error('เลข PromptPay ไม่ถูกต้อง');
  const hasAmount = amount && amount > 0;
  const merchant = f('00', 'A000000677010111') + f(target.tag, target.value);
  let payload =
    f('00', '01') +
    f('01', hasAmount ? '12' : '11') +
    f('29', merchant) +
    f('53', '764') +
    (hasAmount ? f('54', Number(amount).toFixed(2)) : '') +
    f('58', 'TH') +
    '6304';
  return payload + crc16(payload);
}
