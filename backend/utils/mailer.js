const nodemailer = require("nodemailer");

function getTransporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === "true",
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

async function sendOtpEmail({ to, otp, action, pageUrl }) {
  const transporter = getTransporter();
  
  const viewLinkHtml = pageUrl ? `
            <div style="text-align:center;margin-bottom:24px">
              <a href="${pageUrl}" style="background:#6d28d9;color:#ffffff;text-decoration:none;padding:10px 20px;border-radius:6px;font-size:14px;font-weight:600;display:inline-block">View Action Page</a>
            </div>
  ` : '';

  await transporter.sendMail({
    from: `"APDS IMS" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
    to,
    subject: "APDS IMS — SuperAdmin Action OTP",
    html: `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:'Segoe UI',Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">

        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(135deg,#6d28d9,#7c3aed);padding:28px 32px">
            <div style="display:inline-block;vertical-align:middle">
              <div style="width:40px;height:40px;background:rgba(255,255,255,0.2);border-radius:10px;display:inline-flex;align-items:center;justify-content:center;vertical-align:middle">
                <span style="font-size:20px">🛡️</span>
              </div>
            </div>
            <div style="display:inline-block;vertical-align:middle;margin-left:12px">
              <div style="color:#ffffff;font-size:18px;font-weight:700;line-height:1">APDS IMS</div>
              <div style="color:rgba(255,255,255,0.7);font-size:12px;margin-top:3px">Inventory Management System</div>
            </div>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:32px 32px 24px">
            <h2 style="margin:0 0 8px;font-size:20px;color:#1e293b;font-weight:700">Action Verification Required</h2>
            <p style="margin:0 0 20px;color:#64748b;font-size:14px;line-height:1.6">
              A destructive action was requested from the Super Admin panel. Enter the OTP below to confirm.
            </p>

            <!-- Action box -->
            <div style="background:#fefce8;border:1px solid #fde68a;border-radius:10px;padding:14px 16px;margin-bottom:24px">
              <div style="font-size:11px;color:#92400e;font-weight:600;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Reason / Requested Action</div>
              <div style="font-size:13px;color:#78350f;line-height:1.5">${action || "Destructive action"}</div>
            </div>

            ${viewLinkHtml}

            <!-- OTP box -->
            <div style="background:#f8fafc;border:2px dashed #c7d2fe;border-radius:12px;padding:28px 16px;text-align:center;margin-bottom:24px">
              <div style="font-size:11px;color:#6366f1;font-weight:700;letter-spacing:3px;text-transform:uppercase;margin-bottom:12px">Your OTP</div>
              <div style="font-size:48px;font-weight:800;letter-spacing:14px;color:#1e293b;font-family:'Courier New',monospace;line-height:1">${otp}</div>
            </div>

            <!-- Expiry note -->
            <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:12px 14px">
              <span style="font-size:16px">⏱️</span>
              <span style="font-size:13px;color:#991b1b;margin-left:6px">This OTP expires in <strong>5 minutes</strong>. Do not share it with anyone.</span>
            </div>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:16px 32px;text-align:center">
            <p style="margin:0;font-size:12px;color:#94a3b8">If you did not request this, please secure your account immediately.</p>
            <p style="margin:6px 0 0;font-size:12px;color:#cbd5e1">© APDS — A Plus Digital Solutions</p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>
    `,
  });
}

async function sendTestEmail({ to }) {
  const transporter = getTransporter();
  await transporter.sendMail({
    from: `"APDS IMS" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
    to,
    subject: "APDS IMS — SMTP Test Email",
    html: `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:'Segoe UI',Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
        <tr>
          <td style="background:linear-gradient(135deg,#6d28d9,#7c3aed);padding:28px 32px">
            <div style="color:#ffffff;font-size:18px;font-weight:700">APDS IMS</div>
            <div style="color:rgba(255,255,255,0.7);font-size:12px;margin-top:3px">Inventory Management System</div>
          </td>
        </tr>
        <tr>
          <td style="padding:32px">
            <h2 style="margin:0 0 12px;font-size:20px;color:#1e293b">SMTP Test Successful</h2>
            <p style="margin:0;color:#64748b;font-size:14px;line-height:1.7">
              Your email configuration is working correctly. This test was sent from the SuperAdmin panel at <strong>${new Date().toLocaleString("en-IN")}</strong>.
            </p>
            <div style="margin-top:24px;padding:16px;background:#f0fdf4;border:1px solid #86efac;border-radius:10px">
              <div style="font-size:13px;color:#166534">✅ SMTP connection established and email delivered successfully.</div>
            </div>
          </td>
        </tr>
        <tr>
          <td style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:16px 32px;text-align:center">
            <p style="margin:0;font-size:12px;color:#94a3b8">© APDS — A Plus Digital Solutions</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
  });
}

async function sendApprovalEmail({ to, action, approveUrl, rejectUrl }) {
  const transporter = getTransporter();
  const shortAction = (action || "Destructive admin action").slice(0, 80);
  await transporter.sendMail({
    from: `"APDS IMS" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
    to,
    subject: `Approval Required: ${shortAction}${shortAction.length < (action || "").length ? "…" : ""} — APDS IMS`,
    html: `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:'Segoe UI',Tahoma,Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0">

        <tr>
          <td style="background:linear-gradient(135deg,#4f46e5,#7c3aed);padding:22px 32px">
            <table width="100%"><tr>
              <td style="color:#ffffff;font-size:17px;font-weight:700;letter-spacing:-0.3px">APDS IMS</td>
              <td align="right" style="color:rgba(255,255,255,0.6);font-size:12px;white-space:nowrap">SuperAdmin Panel</td>
            </tr></table>
          </td>
        </tr>

        <tr>
          <td style="padding:32px 32px 0">
            <p style="margin:0 0 4px;font-size:11px;color:#6366f1;font-weight:700;text-transform:uppercase;letter-spacing:1.5px">Approval Required</p>
            <h2 style="margin:0 0 20px;font-size:20px;font-weight:700;color:#0f172a;line-height:1.3">Following change is being made —<br>do you approve?</h2>

            <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px">
              <tr>
                <td style="background:#0f172a;border-radius:10px;padding:20px 22px">
                  <p style="margin:0 0 6px;font-size:11px;color:#94a3b8;font-weight:600;text-transform:uppercase;letter-spacing:1.5px">Change being performed</p>
                  <p style="margin:0;font-size:14px;color:#f8fafc;font-weight:500;line-height:1.8;white-space:pre-wrap;font-family:'Courier New',monospace">${action || "Destructive admin action"}</p>
                </td>
              </tr>
            </table>

            <p style="margin:0 0 20px;font-size:13px;color:#64748b;line-height:1.7">
              If you initiated this action, click <strong style="color:#16a34a">Approve</strong> to receive your OTP and proceed.<br>
              If you did not, click <strong style="color:#dc2626">Reject</strong> to immediately cancel it.
            </p>

            <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px">
              <tr>
                <td width="49%" style="padding-right:6px">
                  <a href="${approveUrl}" style="display:block;background:#16a34a;color:#ffffff;text-decoration:none;padding:13px 16px;border-radius:8px;font-size:14px;font-weight:600;text-align:center">Approve &amp; Get OTP</a>
                </td>
                <td width="49%" style="padding-left:6px">
                  <a href="${rejectUrl}" style="display:block;color:#dc2626;text-decoration:none;padding:12px 16px;border-radius:8px;font-size:14px;font-weight:600;text-align:center;border:1.5px solid #fca5a5">Reject</a>
                </td>
              </tr>
            </table>

            <p style="margin:0 0 28px;font-size:12px;color:#94a3b8">⏱&nbsp; This approval request expires in <strong style="color:#64748b">10 minutes</strong>.</p>
          </td>
        </tr>

        <tr>
          <td style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:16px 32px">
            <p style="margin:0;font-size:12px;color:#94a3b8;line-height:1.6">If you did not initiate this action, click Reject immediately or ignore this email.</p>
            <p style="margin:8px 0 0;font-size:12px;color:#cbd5e1">© A Plus Digital Solutions — APDS IMS</p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`,
  });
}

async function sendWarrantyEmail({ to, cc, bcc, subject, body, attachments }) {
  const transporter = getTransporter();
  const htmlBody = (body || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");
  await transporter.sendMail({
    from: `"A Plus Digital Solutions" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
    to,
    ...(cc  ? { cc }  : {}),
    ...(bcc ? { bcc } : {}),
    subject,
    text: body || "",
    html: `<div style="font-family:Arial,sans-serif;font-size:14px;color:#1e293b;line-height:1.8">${htmlBody}</div>`,
    attachments: Array.isArray(attachments) ? attachments : [],
  });
}

module.exports = { sendOtpEmail, sendApprovalEmail, sendTestEmail, sendWarrantyEmail };
