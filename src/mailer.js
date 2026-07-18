'use strict';
const nodemailer = require('nodemailer');
const { db, getSettings } = require('./db');

// SMTP is optional. Without SMTP_HOST configured, every email is stored in the
// outbox (email_log with sent=0) and can be previewed in Admin > Emails.
let transporter = null;
if (process.env.SMTP_HOST) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });
}

async function sendMail(to, subject, html) {
  let sent = 0;
  let error = '';
  if (transporter) {
    try {
      await transporter.sendMail({
        from: process.env.SMTP_FROM || getSettings().contact_email,
        to, subject, html,
      });
      sent = 1;
    } catch (err) {
      error = String(err && err.message || err);
    }
  }
  db.prepare('INSERT INTO email_log (to_addr, subject, html, sent, error) VALUES (?,?,?,?,?)')
    .run(to, subject, html, sent, error);
  return { sent: sent === 1, error };
}

function baseTemplate(title, bodyHtml) {
  const s = getSettings();
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:560px;margin:24px auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;">
    <div style="background:#101828;color:#ffffff;padding:20px 28px;">
      <div style="font-size:12px;letter-spacing:2px;opacity:.8;">SEOUL ROBOT &amp; AI MUSEUM</div>
      <div style="font-size:20px;font-weight:bold;margin-top:4px;">${title}</div>
    </div>
    <div style="padding:28px;color:#1f2937;font-size:14px;line-height:1.7;">${bodyHtml}</div>
    <div style="padding:16px 28px;background:#f9fafb;color:#6b7280;font-size:12px;line-height:1.6;">
      Seoul Robot &amp; AI Museum · ${s.address_en}<br>
      ${s.contact_phone} · ${s.contact_email}<br>
      This mailbox is monitored during opening hours (Tue–Sun 09:30–17:30 KST).
    </div>
  </div></body></html>`;
}

function fmtSlot(r) {
  const lang = r.language === 'en' ? 'English docent' : 'Korean docent';
  const type = r.tour_type === 'permanent' ? 'Permanent Exhibition Tour' : 'Special Exhibition Tour';
  return `${type} (${lang}) — ${r.visit_date}, ${r.start_time}–${r.end_time}`;
}

function requestReceivedEmail(r) {
  const s = getSettings();
  return baseTemplate('Reservation request received', `
    <p>Dear ${r.name},</p>
    <p>We have received your reservation request. <strong>This is not a confirmation yet.</strong>
    Our staff will check seat availability and send you a separate confirmation email.</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      <tr><td style="padding:6px 0;color:#6b7280;width:130px;">Request code</td><td style="font-weight:bold;">${r.code}</td></tr>
      <tr><td style="padding:6px 0;color:#6b7280;">Tour</td><td>${fmtSlot(r)}</td></tr>
      <tr><td style="padding:6px 0;color:#6b7280;">Party size</td><td>${r.party_size}</td></tr>
    </table>
    <p style="color:#6b7280;">${s.reply_sla_text}</p>
    <p>You can check the status of your request anytime on the <strong>My Booking</strong> page using your request code and email address.</p>`);
}

function confirmedEmail(r) {
  return baseTemplate('Your reservation is confirmed', `
    <p>Dear ${r.name},</p>
    <p>Your reservation has been <strong style="color:#059669;">confirmed</strong>. We look forward to seeing you!</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      <tr><td style="padding:6px 0;color:#6b7280;width:130px;">Reservation code</td><td style="font-weight:bold;font-size:16px;">${r.code}</td></tr>
      <tr><td style="padding:6px 0;color:#6b7280;">Tour</td><td>${fmtSlot(r)}</td></tr>
      <tr><td style="padding:6px 0;color:#6b7280;">Party size</td><td>${r.party_size}</td></tr>
      <tr><td style="padding:6px 0;color:#6b7280;">Admission</td><td>Free</td></tr>
    </table>
    <p><strong>On the day:</strong> please arrive 10 minutes early and show this email (or your reservation code) at the 1F information desk.</p>
    <p><strong>Getting here:</strong> Subway Line 1 or 4 to Chang-dong Station, Exit 1 — 5-minute walk.</p>
    <p style="color:#b91c1c;">If your plans change, please cancel via the My Booking page. Repeated no-shows may lead to future requests being declined.</p>`);
}

function declinedEmail(r) {
  const s = getSettings();
  return baseTemplate('About your reservation request', `
    <p>Dear ${r.name},</p>
    <p>We are sorry — we could not confirm your request <strong>${r.code}</strong> for
    ${fmtSlot(r)}.</p>
    ${r.decline_reason ? `<p style="background:#fef2f2;border-radius:8px;padding:12px 16px;">Reason: ${r.decline_reason}</p>` : ''}
    <p>Seats for that session may already be fully booked. Please try another date or session —
    you can submit a new request on our booking page at any time.</p>
    <p>Also note that our walk-in areas (Robot &amp; AI Garden and RAIM PLAY) can be
    enjoyed <strong>without any reservation</strong>.</p>
    <p style="color:#6b7280;">Questions? Contact us at ${s.contact_email}.</p>`);
}

function reminderEmail(r) {
  return baseTemplate('Your visit is tomorrow', `
    <p>Dear ${r.name},</p>
    <p>This is a reminder that your visit is <strong>tomorrow</strong>.</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      <tr><td style="padding:6px 0;color:#6b7280;width:130px;">Reservation code</td><td style="font-weight:bold;">${r.code}</td></tr>
      <tr><td style="padding:6px 0;color:#6b7280;">Tour</td><td>${fmtSlot(r)}</td></tr>
      <tr><td style="padding:6px 0;color:#6b7280;">Party size</td><td>${r.party_size}</td></tr>
    </table>
    <p>Please arrive 10 minutes early and check in at the 1F desk.</p>
    <p><strong>Getting here:</strong> Chang-dong Stn Exit 1.</p>
    <p>If your plans have changed, please cancel via the My Booking page.</p>`);
}

function cancelledEmail(r) {
  return baseTemplate('Your reservation was cancelled', `
    <p>Dear ${r.name},</p>
    <p>Your reservation <strong>${r.code}</strong> for ${fmtSlot(r)} has been cancelled.</p>
    <p>Thank you for letting us know — we hope to see you another day. You are always welcome to
    submit a new request on our booking page.</p>`);
}

// ---------- staff notifications (internal, Korean) ----------
const BASE_URL = process.env.BASE_URL || 'http://localhost:4310';

function staffTemplate(title, bodyHtml) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f4f5f7;font-family:'Apple SD Gothic Neo',Arial,sans-serif;">
  <div style="max-width:560px;margin:24px auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;">
    <div style="background:#1b64da;color:#ffffff;padding:16px 24px;">
      <div style="font-size:11px;letter-spacing:2px;opacity:.85;">RAIM ADMIN 알림</div>
      <div style="font-size:18px;font-weight:bold;margin-top:2px;">${title}</div>
    </div>
    <div style="padding:24px;color:#1f2937;font-size:14px;line-height:1.7;">${bodyHtml}
      <p style="margin-top:18px;"><a href="${BASE_URL}/admin" style="color:#1b64da;font-weight:bold;">관리자 페이지 열기 →</a></p>
    </div>
  </div></body></html>`;
}

function staffKoSlot(r) {
  const type = r.tour_type === 'permanent' ? '상설전시' : '기획전시';
  const lang = r.language === 'en' ? '영어 해설' : '한국어 해설';
  return `${r.visit_date} ${r.start_time}–${r.end_time} · ${type} (${lang})`;
}
function staffInfoTable(r) {
  return `<table style="width:100%;border-collapse:collapse;font-size:14px;">
    <tr><td style="padding:5px 0;color:#6b7280;width:90px;">코드</td><td style="font-weight:bold;">${r.code}</td></tr>
    <tr><td style="padding:5px 0;color:#6b7280;">회차</td><td>${staffKoSlot(r)}</td></tr>
    <tr><td style="padding:5px 0;color:#6b7280;">신청자</td><td>${r.name} (${r.email}${r.country ? ', ' + r.country : ''})</td></tr>
    <tr><td style="padding:5px 0;color:#6b7280;">인원</td><td>${r.party_size}명</td></tr>
    ${r.notes ? `<tr><td style="padding:5px 0;color:#6b7280;">메모</td><td>${r.notes}</td></tr>` : ''}
  </table>`;
}

function staffNewRequestEmail(r) {
  return staffTemplate('새 외국인 예약 신청', `
    <p>외국인 전용 예약 사이트에 새 신청이 접수되었습니다.</p>
    ${staffInfoTable(r)}
    <div style="background:#eef4ff;border-radius:8px;padding:12px 16px;margin-top:16px;font-size:13px;color:#1b64da;">
      처리 절차: ① 해당 회차 잔여석 확인 → ② 서울시공공서비스예약(yeyak) <strong>관리자 예약으로 ${r.party_size}석 차단</strong>
      → ③ 관리자 페이지에서 Confirm (확정 메일 자동 발송)
    </div>`);
}

function staffReleaseEmail(r) {
  return staffTemplate('확정 예약 취소 — yeyak 좌석 해제 필요', `
    <p>확정된 예약이 <strong>방문자에 의해 취소</strong>되었습니다.</p>
    ${staffInfoTable(r)}
    <div style="background:#fdeeee;border-radius:8px;padding:12px 16px;margin-top:16px;font-size:13px;color:#d22030;">
      yeyak에 차단해 둔 <strong>${r.party_size}석을 해제</strong>해 주세요.
      해제 후 관리자 페이지 Dashboard의 <strong>Yeyak release queue</strong>에서 완료 처리하면 목록에서 사라집니다.
    </div>`);
}

async function notifyStaff(subject, html) {
  const to = (getSettings().staff_notify_email || '').trim();
  if (!to) return { sent: false, skipped: true };
  return sendMail(to, subject, html);
}

module.exports = {
  sendMail, requestReceivedEmail, confirmedEmail, declinedEmail, cancelledEmail, reminderEmail,
  staffNewRequestEmail, staffReleaseEmail, notifyStaff,
  smtpConfigured: !!transporter,
};
