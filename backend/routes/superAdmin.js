const express = require("express");
const router = express.Router();
const os = require("os");
const fs = require("fs");
const path = require("path");
const { mysqlPool } = require("../db");
const { uploadDir } = require("../middleware/upload");
const { sendApprovalEmail, sendTestEmail } = require("../utils/mailer");
const { v4: uuidv4 } = require("uuid");
const { getActiveSessions, removeSession } = require("../utils/sessionTracker");
const { invalidateUserCache, getCacheSize, clearAllUserCache } = require("../middleware/auth");
const { createNotification } = require("../notificationService");
const { normalizeRole, sanitizeUser, logUserActivity } = require("../helpers");

// ── Stores ───────────────────────────────────────────────────────────────────
const otpStore      = new Map(); // userId -> { otp, expiresAt }
const approvalStore = new Map(); // token  -> { userId, action, status, otp, expiresAt }

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

const SAFE_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;

function isSafeIdentifier(name) {
  return SAFE_IDENTIFIER.test(name);
}

function verifyAndConsumeOtp(userId, otp) {
  const entry = otpStore.get(String(userId));
  if (!entry) return { valid: false, reason: "OTP not found. Please request an OTP first." };
  if (Date.now() > entry.expiresAt) {
    otpStore.delete(String(userId));
    return { valid: false, reason: "OTP has expired. Please request a new one." };
  }
  if (entry.otp !== String(otp)) return { valid: false, reason: "Incorrect OTP. Please try again." };
  otpStore.delete(String(userId));
  return { valid: true };
}

// ── HTML helpers for approval pages ──────────────────────────────────────────
const AUTO_CLOSE_SCRIPT = `<script>
  (function() {
    var t = setTimeout(function() { window.close(); }, 800);
    window.onload = function() { clearTimeout(t); window.close(); };
  })();
</script>`;

function approvedPage() {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Approved — APDS IMS</title>${AUTO_CLOSE_SCRIPT}</head>
<body style="margin:0;padding:0;background:#f0fdf4;font-family:'Segoe UI',Arial,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh">
<div style="text-align:center;padding:40px 24px;max-width:360px">
  <div style="width:64px;height:64px;background:#16a34a;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 20px;font-size:28px;line-height:64px">✓</div>
  <h2 style="margin:0 0 8px;font-size:20px;font-weight:700;color:#14532d">Action Approved</h2>
  <p style="margin:0;font-size:14px;color:#4b7c5a;line-height:1.6">Return to the SuperAdmin panel — your OTP is ready there. This tab will close automatically.</p>
</div>
</body></html>`;
}

function rejectedPage() {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rejected — APDS IMS</title>${AUTO_CLOSE_SCRIPT}</head>
<body style="margin:0;padding:0;background:#fef2f2;font-family:'Segoe UI',Arial,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh">
<div style="text-align:center;padding:40px 24px;max-width:360px">
  <div style="width:64px;height:64px;background:#dc2626;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 20px;font-size:28px;line-height:64px;color:#fff">✕</div>
  <h2 style="margin:0 0 8px;font-size:20px;font-weight:700;color:#7f1d1d">Action Rejected</h2>
  <p style="margin:0;font-size:14px;color:#9b3a3a;line-height:1.6">The action has been cancelled. No changes were made. This tab will close automatically.</p>
</div>
</body></html>`;
}

function expiredPage() {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link Expired — APDS IMS</title></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:'Segoe UI',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:48px 16px"><tr><td align="center">
<table width="480" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;border:1px solid #e2e8f0;overflow:hidden">
  <tr><td style="background:linear-gradient(135deg,#64748b,#475569);padding:28px 32px">
    <p style="margin:0;color:#fff;font-size:20px;font-weight:700">Link Expired</p>
    <p style="margin:4px 0 0;color:rgba(255,255,255,0.75);font-size:13px">APDS IMS — SuperAdmin Panel</p>
  </td></tr>
  <tr><td style="padding:32px;text-align:center">
    <p style="margin:0 0 8px;font-size:16px;font-weight:600;color:#0f172a">This approval link has expired.</p>
    <p style="margin:0;font-size:14px;color:#64748b;line-height:1.7">Please request a new OTP from the SuperAdmin panel and try again.</p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

// ── Public router — no auth required ─────────────────────────────────────────
const publicRouter = express.Router();

publicRouter.get("/approve-otp", (req, res) => {
  const entry = approvalStore.get(req.query.token);
  if (!entry || Date.now() > entry.expiresAt) { approvalStore.delete(req.query.token); return res.send(expiredPage()); }
  if (entry.status === "rejected") return res.send(rejectedPage());
  if (entry.status === "approved") return res.send(approvedPage());
  const otp = generateOtp();
  entry.status = "approved";
  entry.otp = otp;
  otpStore.set(String(entry.userId), { otp, expiresAt: Date.now() + 5 * 60 * 1000 });
  return res.send(approvedPage());
});

publicRouter.get("/reject-otp", (req, res) => {
  const entry = approvalStore.get(req.query.token);
  if (!entry || Date.now() > entry.expiresAt) { approvalStore.delete(req.query.token); return res.send(expiredPage()); }
  if (entry.status !== "pending") return res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Already Processed</title></head><body style="margin:0;padding:48px 16px;background:#f8fafc;font-family:'Segoe UI',Arial,sans-serif;text-align:center"><div style="max-width:400px;margin:auto;background:#fff;border-radius:12px;border:1px solid #e2e8f0;padding:32px"><p style="font-size:16px;font-weight:600;color:#0f172a;margin:0 0 8px">Already ${entry.status.charAt(0).toUpperCase() + entry.status.slice(1)}</p><p style="color:#64748b;font-size:14px;margin:0">This request was already processed. You may close this tab.</p></div></body></html>`);
  entry.status = "rejected";
  return res.send(rejectedPage());
});

// ── Auth middleware (all routes below require SuperAdmin) ─────────────────────
const requireSuperAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== "SuperAdmin") {
    return res.status(403).json({ message: "SuperAdmin access required" });
  }
  next();
};
router.use(requireSuperAdmin);

function requireOtp(req, res, next) {
  const otp = req.body?.otp;
  if (!otp) return res.status(400).json({ message: "OTP required" });
  const result = verifyAndConsumeOtp(req.user.id, String(otp));
  if (!result.valid) return res.status(401).json({ message: result.reason });
  next();
}

router.post("/request-otp", async (req, res) => {
  try {
    const emailConfigured = process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS;
    const userEmail = req.user.email;
    if (!emailConfigured || !userEmail) return res.json({ notConfigured: true });

    const token = uuidv4();
    const action = req.body.action || "Destructive action";
    approvalStore.set(token, {
      userId: String(req.user.id),
      action,
      status: "pending",
      otp: null,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });

    const base = req.protocol + "://" + req.get("host");
    try {
      await sendApprovalEmail({
        to: userEmail,
        action,
        approveUrl: `${base}/api/admin/approve-otp?token=${token}`,
        rejectUrl:  `${base}/api/admin/reject-otp?token=${token}`,
      });
      return res.json({ approvalToken: token });
    } catch (mailErr) {
      approvalStore.delete(token);
      console.error("[superAdmin] approval email error:", mailErr.message);
      return res.status(500).json({ message: "Failed to send approval email: " + mailErr.message });
    }
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get("/check-approval", (req, res) => {
  const entry = approvalStore.get(req.query.token);
  if (!entry) return res.json({ status: "expired" });
  if (Date.now() > entry.expiresAt) { approvalStore.delete(req.query.token); return res.json({ status: "expired" }); }
  if (entry.userId !== String(req.user.id)) return res.status(403).json({ message: "Forbidden" });
  const payload = { status: entry.status };
  if (entry.status === "approved" && entry.otp) payload.otp = entry.otp;
  return res.json(payload);
});

// ── User Monitor ────────────────────────────────────────────────────────────

router.get("/active-users", (req, res) => {
  res.json(getActiveSessions(30));
});

router.post("/force-logout/:userid", requireOtp, async (req, res) => {
  try {
    const { userid } = req.params;
    if (userid === req.user.id)
      return res.status(400).json({ message: "You cannot force-logout yourself." });
    const [rows] = await mysqlPool.query("SELECT userid, role FROM users WHERE userid = ? LIMIT 1", [userid]);
    if (!rows.length) return res.status(404).json({ message: "User not found." });
    if (rows[0].role === "SuperAdmin") return res.status(403).json({ message: "Cannot logout SuperAdmin." });
    await mysqlPool.query("UPDATE users SET forceLogoutAt = NOW() WHERE userid = ?", [userid]);
    removeSession(userid);
    invalidateUserCache(userid);
    await logUserActivity(mysqlPool, req.user, "SuperAdmin Action", [
      { field: "Action", newValue: "Force Logout User" },
      { field: "Target User", newValue: userid },
      { field: "Reason", newValue: req.body.reason || "No reason provided" }
    ], req.ip);
    res.json({ message: "User has been logged out." });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get("/user-activity", async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit)  || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const userId = req.query.userId || null;

    const where  = userId ? "WHERE userId = ?" : "";
    const params = userId ? [userId] : [];

    const [logs]  = await mysqlPool.query(
      `SELECT * FROM useractivitylogs ${where} ORDER BY createdAt DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    const [[{ total }]] = await mysqlPool.query(
      `SELECT COUNT(*) as total FROM useractivitylogs ${where}`,
      params
    );
    res.json({ logs, total: Number(total) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get("/managed-users", async (req, res) => {
  try {
    const [rows] = await mysqlPool.query(
      `SELECT userid, username, role, fullName, email, permissions,
              allow_edit_models, allow_edit_serials, allow_edit_godown,
              allow_create_order, allow_edit_order_processing, allow_edit_billing,
              allow_edit_dispatch, allow_edit_installations, allow_edit_damaged,
              allow_edit_returns, allow_edit_fbf_fba, allow_edit_warranty, createdAt
       FROM users WHERE role != 'SuperAdmin' ORDER BY role, username`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.put("/managed-users/:userid", requireOtp, async (req, res) => {
  try {
    const { userid } = req.params;
    const { role, permissions, ...toggles } = req.body;

    const [check] = await mysqlPool.query("SELECT role FROM users WHERE userid = ? LIMIT 1", [userid]);
    if (!check.length) return res.status(404).json({ message: "User not found." });
    if (check[0].role === "SuperAdmin") return res.status(403).json({ message: "Cannot modify SuperAdmin." });

    const newRole = normalizeRole(role);
    if (newRole === "SuperAdmin") return res.status(403).json({ message: "Cannot assign SuperAdmin role." });

    await mysqlPool.query(
      `UPDATE users SET role=?, permissions=?,
       allow_edit_models=?, allow_edit_serials=?, allow_edit_godown=?,
       allow_create_order=?, allow_edit_order_processing=?, allow_edit_billing=?,
       allow_edit_dispatch=?, allow_edit_installations=?, allow_edit_damaged=?,
       allow_edit_returns=?, allow_edit_fbf_fba=?, allow_edit_warranty=?, updatedAt=NOW()
       WHERE userid=?`,
      [
        newRole,
        JSON.stringify(Array.isArray(permissions) ? permissions : []),
        toggles.allow_edit_models        ? 1 : 0,
        toggles.allow_edit_serials       ? 1 : 0,
        toggles.allow_edit_godown        ? 1 : 0,
        toggles.allow_create_order       ? 1 : 0,
        toggles.allow_edit_order_processing ? 1 : 0,
        toggles.allow_edit_billing       ? 1 : 0,
        toggles.allow_edit_dispatch      ? 1 : 0,
        toggles.allow_edit_installations ? 1 : 0,
        toggles.allow_edit_damaged       ? 1 : 0,
        toggles.allow_edit_returns       ? 1 : 0,
        toggles.allow_edit_fbf_fba       ? 1 : 0,
        toggles.allow_edit_warranty      ? 1 : 0,
        userid,
      ]
    );
    await logUserActivity(mysqlPool, req.user, "SuperAdmin Action", [
      { field: "Action", newValue: "Edit Managed User" },
      { field: "Target User", newValue: userid },
      { field: "Reason", newValue: req.body.reason || "No reason provided" }
    ], req.ip);
    res.json({ message: "User updated successfully." });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── Health ──────────────────────────────────────────────────────────────────
router.get("/health", async (req, res) => {
  try {
    let dbStatus = "ok";
    let dbLatency = null;
    try {
      const start = Date.now();
      await mysqlPool.query("SELECT 1");
      dbLatency = Date.now() - start;
    } catch {
      dbStatus = "error";
    }

    let fileCount = 0;
    let uploadSize = 0;
    try {
      const files = fs.readdirSync(uploadDir);
      fileCount = files.length;
      for (const f of files) {
        try { uploadSize += fs.statSync(path.join(uploadDir, f)).size; } catch {}
      }
    } catch {}

    res.json({
      uptime: process.uptime(),
      nodeVersion: process.version,
      platform: process.platform,
      cpuCount: os.cpus().length,
      memory: { total: os.totalmem(), used: os.totalmem() - os.freemem(), free: os.freemem() },
      db: { status: dbStatus, latencyMs: dbLatency },
      uploads: { fileCount, totalSizeBytes: uploadSize },
      env: process.env.NODE_ENV || "development",
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── Files ───────────────────────────────────────────────────────────────────
router.get("/files", (req, res) => {
  try {
    const backendUri = process.env.BACKEND_URI || "";
    const files = fs.readdirSync(uploadDir).map((filename) => {
      const fp = path.join(uploadDir, filename);
      const stat = fs.statSync(fp);
      return { filename, size: stat.size, modifiedAt: stat.mtime, url: `${backendUri}/uploads/${filename}` };
    });
    files.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
    res.json(files);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.delete("/files/:filename", requireOtp, async (req, res) => {
  try {
    const filename = path.basename(req.params.filename);
    const fp = path.join(uploadDir, filename);
    if (!fs.existsSync(fp)) return res.status(404).json({ message: "File not found" });
    fs.unlinkSync(fp);
    await logUserActivity(mysqlPool, req.user, "SuperAdmin Action", [
      { field: "Action", newValue: "Delete File" },
      { field: "File", newValue: filename },
      { field: "Reason", newValue: req.body.reason || "No reason provided" }
    ], req.ip);
    res.json({ message: "Deleted" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── DB Explorer ─────────────────────────────────────────────────────────────
const getAllowedTables = async () => {
  const [rows] = await mysqlPool.query("SHOW TABLES");
  return rows.map((r) => Object.values(r)[0]);
};

const ALLOWED_COL_TYPES = new Set([
  "INT", "BIGINT", "SMALLINT", "TINYINT",
  "VARCHAR(255)", "VARCHAR(100)", "VARCHAR(50)",
  "TEXT", "LONGTEXT", "MEDIUMTEXT",
  "DECIMAL(10,2)", "DECIMAL(15,4)", "FLOAT", "DOUBLE",
  "BOOLEAN", "TINYINT(1)",
  "DATE", "DATETIME", "TIMESTAMP",
  "JSON", "UUID",
]);

router.post("/tables", requireOtp, async (req, res) => {
  try {
    const { tableName, columns } = req.body;
    if (!tableName || !isSafeIdentifier(tableName))
      return res.status(400).json({ message: "Invalid table name. Use only letters, numbers, underscores." });
    if (!Array.isArray(columns) || columns.length === 0)
      return res.status(400).json({ message: "At least one column is required." });

    const existing = await getAllowedTables();
    if (existing.includes(tableName))
      return res.status(400).json({ message: `Table "${tableName}" already exists.` });

    const pkCount = columns.filter((c) => c.primaryKey).length;
    if (pkCount > 1) return res.status(400).json({ message: "Only one primary key is allowed." });

    const colDefs = columns.map((col) => {
      if (!col.name || !isSafeIdentifier(col.name))
        throw new Error(`Invalid column name: "${col.name}"`);
      if (!ALLOWED_COL_TYPES.has(col.type))
        throw new Error(`Invalid column type: "${col.type}"`);

      let def = `\`${col.name}\` ${col.type}`;
      if (col.primaryKey) {
        def += " NOT NULL";
        if (col.autoIncrement) def += " AUTO_INCREMENT";
      } else {
        def += col.nullable ? " NULL" : " NOT NULL";
        if (col.defaultValue !== undefined && col.defaultValue !== "")
          def += ` DEFAULT '${String(col.defaultValue).replace(/'/g, "''")}'`;
      }
      return def;
    });

    const pkCol = columns.find((c) => c.primaryKey);
    if (pkCol) colDefs.push(`PRIMARY KEY (\`${pkCol.name}\`)`);

    const sql = `CREATE TABLE \`${tableName}\` (${colDefs.join(", ")})`;
    await mysqlPool.query(sql);
    await logUserActivity(mysqlPool, req.user, "SuperAdmin Action", [
      { field: "Action", newValue: "Create Table" },
      { field: "Table", newValue: tableName },
      { field: "Reason", newValue: req.body.reason || "No reason provided" }
    ], req.ip);
    res.json({ message: `Table "${tableName}" created successfully.`, sql });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.delete("/tables/:name", requireOtp, async (req, res) => {
  try {
    return res.status(403).json({ message: "Dropping tables is disabled for security reasons." });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get("/tables", async (req, res) => {
  try {
    const tables = await getAllowedTables();
    const result = [];
    for (const t of tables) {
      try {
        const [[{ cnt }]] = await mysqlPool.query(`SELECT COUNT(*) as cnt FROM \`${t}\``);
        result.push({ name: t, rowCount: Number(cnt) });
      } catch {
        result.push({ name: t, rowCount: null });
      }
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get("/table/:name", async (req, res) => {
  try {
    const allowed = await getAllowedTables();
    const tableName = req.params.name;
    if (!allowed.includes(tableName)) return res.status(400).json({ message: "Invalid table" });

    const page = Math.max(0, parseInt(req.query.page) || 0);
    const limit = 50;
    const offset = page * limit;

    const [cols] = await mysqlPool.query(`SHOW COLUMNS FROM \`${tableName}\``);
    const [[{ total }]] = await mysqlPool.query(`SELECT COUNT(*) as total FROM \`${tableName}\``);
    const [rows] = await mysqlPool.query(`SELECT * FROM \`${tableName}\` LIMIT ? OFFSET ?`, [limit, offset]);
    const pkCol = cols.find((c) => c.Key === "PRI");

    res.json({
      columns: cols.map((c) => ({ field: c.Field, type: c.Type, key: c.Key, nullable: c.Null === "YES" })),
      rows,
      total: Number(total),
      page,
      limit,
      primaryKey: pkCol ? pkCol.Field : null,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.put("/table/:name/:pk", requireOtp, async (req, res) => {
  try {
    const allowed = await getAllowedTables();
    const tableName = req.params.name;
    if (!allowed.includes(tableName)) return res.status(400).json({ message: "Invalid table" });

    const { pkColumn, data } = req.body;
    if (!pkColumn || !data) return res.status(400).json({ message: "pkColumn and data required" });
    if (!isSafeIdentifier(pkColumn)) return res.status(400).json({ message: "Invalid pkColumn name" });

    const cols = Object.keys(data).filter((k) => k !== pkColumn);
    if (cols.length === 0) return res.status(400).json({ message: "No fields to update" });
    const unsafeCol = cols.find((k) => !isSafeIdentifier(k));
    if (unsafeCol) return res.status(400).json({ message: `Invalid column name: ${unsafeCol}` });

    const setClauses = cols.map((k) => `\`${k}\` = ?`).join(", ");
    const values = [...cols.map((k) => data[k] === "" ? null : data[k]), req.params.pk];

    await mysqlPool.query(`UPDATE \`${tableName}\` SET ${setClauses} WHERE \`${pkColumn}\` = ?`, values);
    await logUserActivity(mysqlPool, req.user, "SuperAdmin Action", [
      { field: "Action", newValue: "Edit Record" },
      { field: "Table", newValue: tableName },
      { field: "Record ID", newValue: req.params.pk },
      { field: "Reason", newValue: req.body.reason || "No reason provided" }
    ], req.ip);
    res.json({ message: "Updated" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.delete("/table/:name/:pk", requireOtp, async (req, res) => {
  try {
    return res.status(403).json({ message: "Deleting records from the Database Explorer is disabled for security reasons." });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── Analytics ────────────────────────────────────────────────────────────────
router.get("/analytics", async (req, res) => {
  const safeCount = async (table, where = "") => {
    try {
      const [[r]] = await mysqlPool.query(`SELECT COUNT(*) as n FROM \`${table}\` ${where}`);
      return Number(r.n);
    } catch { return null; }
  };
  const thisMonth = "WHERE createdAt >= DATE_FORMAT(NOW(),'%Y-%m-01')";
  const [orders, ordersMonth, dispatches, users, admins, installs, returns, logs] = await Promise.all([
    safeCount("orders"),
    safeCount("orders", thisMonth),
    safeCount("dispatches"),
    safeCount("users", "WHERE role != 'SuperAdmin'"),
    safeCount("users", "WHERE role = 'Admin'"),
    safeCount("installations"),
    safeCount("returns"),
    safeCount("useractivitylogs"),
  ]);
  let recentActivity = [];
  try {
    const [rows] = await mysqlPool.query(
      "SELECT username, role, action, createdAt, ipAddress FROM useractivitylogs ORDER BY createdAt DESC LIMIT 8"
    );
    recentActivity = rows;
  } catch {}
  res.json({
    totals: { orders, ordersMonth, dispatches, users, admins, installs, returns, logs },
    activeSessions: getActiveSessions(30).length,
    recentActivity,
  });
});

// ── Error Logs ───────────────────────────────────────────────────────────────
router.get("/error-logs", (req, res) => {
  try {
    const logFile = path.join(__dirname, "..", "hostinger_error.log");
    if (!fs.existsSync(logFile)) return res.json({ lines: [] });
    const content = fs.readFileSync(logFile, "utf-8");
    const lines = content.split("\n").filter(Boolean).slice(-300).reverse();
    res.json({ lines });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.delete("/error-logs", requireOtp, async (req, res) => {
  try {
    const logFile = path.join(__dirname, "..", "hostinger_error.log");
    if (fs.existsSync(logFile)) fs.writeFileSync(logFile, "");
    await logUserActivity(mysqlPool, req.user, "SuperAdmin Action", [
      { field: "Action", newValue: "Clear Error Logs" },
      { field: "Reason", newValue: req.body.reason || "No reason provided" }
    ], req.ip);
    res.json({ message: "Error log cleared." });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── Broadcast Notification ───────────────────────────────────────────────────
router.post("/broadcast", requireOtp, async (req, res) => {
  try {
    const { title, message, type = "info", targetRole } = req.body;
    if (!title || !message) return res.status(400).json({ message: "Title and message required." });
    const roles = ["Admin", "Supervisor", "Accountant", "User", "Operator"];
    const targets = targetRole && targetRole !== "All" ? [targetRole] : roles;
    for (const role of targets) {
      await createNotification(mysqlPool, { targetRole: role, title, message, type, priority: "high" });
    }
    await logUserActivity(mysqlPool, req.user, "SuperAdmin Action", [
      { field: "Action", newValue: "Broadcast Notification" },
      { field: "Target", newValue: targetRole || "All" },
      { field: "Reason", newValue: req.body.reason || "No reason provided" }
    ], req.ip);
    res.json({ message: `Notification sent to ${targetRole || "all users"}.` });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── Test Email ───────────────────────────────────────────────────────────────
router.post("/test-email", async (req, res) => {
  try {
    const to = req.body.to || req.user.email;
    if (!to) return res.status(400).json({ message: "No email address. Set email in your profile first." });
    await sendTestEmail({ to });
    res.json({ message: `Test email sent to ${to}` });
  } catch (err) {
    res.status(500).json({ message: `Failed: ${err.message}` });
  }
});

// ── Export Table as CSV ──────────────────────────────────────────────────────
router.get("/export-table/:name", async (req, res) => {
  try {
    const { name } = req.params;
    if (!isSafeIdentifier(name)) return res.status(400).json({ message: "Invalid table name." });
    const allowed = await getAllowedTables();
    if (!allowed.includes(name)) return res.status(400).json({ message: "Table not found." });
    const [rows] = await mysqlPool.query(`SELECT * FROM \`${name}\` LIMIT 10000`);
    if (!rows.length) {
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="${name}.csv"`);
      return res.send("");
    }
    const cols = Object.keys(rows[0]);
    const escape = (v) => (v === null || v === undefined ? "" : `"${String(v).replace(/"/g, '""')}"`);
    const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => escape(r[c])).join(","))].join("\n");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${name}.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── Cleanup Old Logs ─────────────────────────────────────────────────────────
router.delete("/cleanup-logs", requireOtp, async (req, res) => {
  try {
    const days = Math.max(1, Math.min(365, Number(req.body.days) || 30));
    const [result] = await mysqlPool.query(
      "DELETE FROM useractivitylogs WHERE createdAt < DATE_SUB(NOW(), INTERVAL ? DAY)",
      [days]
    );
    await logUserActivity(mysqlPool, req.user, "SuperAdmin Action", [
      { field: "Action", newValue: "Cleanup Logs" },
      { field: "Days", newValue: days },
      { field: "Reason", newValue: req.body.reason || "No reason provided" }
    ], req.ip);
    res.json({ message: `Deleted ${result.affectedRows} log entries older than ${days} days.`, deleted: result.affectedRows });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── Cache ────────────────────────────────────────────────────────────────────
router.get("/cache-stats", (req, res) => {
  res.json({ count: getCacheSize() });
});

router.delete("/cache", requireOtp, async (req, res) => {
  clearAllUserCache();
  await logUserActivity(mysqlPool, req.user, "SuperAdmin Action", [
    { field: "Action", newValue: "Clear Auth Cache" },
    { field: "Reason", newValue: req.body.reason || "No reason provided" }
  ], req.ip);
  res.json({ message: "All user session cache cleared." });
});

module.exports = { router, publicRouter };
