const fs = require("fs");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { mysqlPool } = require("./db");

const VALID_ROLES = ["Admin", "Supervisor", "Accountant", "User", "Operator", "SuperAdmin"];

const safeDate = (v) => (v && v !== "" ? v : null);

const safeNum = (val, fallback = 0) => {
  const n = Number(val);
  return Number.isNaN(n) ? fallback : n;
};

const safeStr = (val, fallback = null) => {
  if (val === undefined || val === null) return fallback;
  const v = String(val).trim();
  return v === "" ? fallback : v;
};

const toBit = (val) =>
  val === true || val === 1 || val === "1" || val === "true" || val === "TRUE" || val === "Yes" || val === "yes";

const normalizeRole = (role) => {
  const value = safeStr(role, "User");
  return VALID_ROLES.find((r) => r.toLowerCase() === String(value).toLowerCase()) || "User";
};

const normalizeBusinessStatus = (status) => {
  return safeStr(status, "Pending");
};

const normalizeLogisticsStatus = (status) => {
  const s = safeStr(status, null);
  if (!s) return null;
  return s === "Ready for Dispatch" ? "Packing in Process" : s;
};

const mapDispatchRow = (row) => {
  if (!row) return row;
  const orderIdStr = String(row.orderid || row.customerName || "");
  const defaultPlatform = orderIdStr.startsWith("GEM") ? "GeM" : "Unknown";
  return {
    ...row,
    firmName: row.platform || row.firmName || defaultPlatform,
    customerName: row.orderid !== undefined ? row.orderid : row.customerName,
  };
};

const sanitizeUser = (user) => {
  if (!user) return null;
  let permissions = [];
  try {
    if (user.permissions) {
      permissions = typeof user.permissions === "string" ? JSON.parse(user.permissions) : user.permissions;
    }
  } catch (e) {
    console.error("Error parsing user permissions:", e);
  }
  return {
    id: user.userid || user.id,
    username: user.username,
    role: normalizeRole(user.role),
    fullName: user.fullName || null,
    email: user.email || null,
    phone: user.phone || null,
    permissions: Array.isArray(permissions) ? permissions : [],
    allow_edit_models: toBit(user.allow_edit_models),
    allow_edit_serials: toBit(user.allow_edit_serials),
    allow_edit_godown: toBit(user.allow_edit_godown),
    allow_create_order: toBit(user.allow_create_order),
    allow_edit_order_processing: toBit(user.allow_edit_order_processing),
    allow_edit_billing: toBit(user.allow_edit_billing),
    allow_edit_dispatch: toBit(user.allow_edit_dispatch),
    allow_edit_installations: toBit(user.allow_edit_installations),
    allow_edit_damaged: toBit(user.allow_edit_damaged),
    allow_edit_returns: toBit(user.allow_edit_returns),
    allow_edit_fbf_fba: toBit(user.allow_edit_fbf_fba),
    allow_edit_warranty: toBit(user.allow_edit_warranty),
    createdAt: user.createdAt || null,
    updatedAt: user.updatedAt || null,
  };
};

const signToken = (user) =>
  jwt.sign(
    { id: user.userid, username: user.username, role: user.role },
    process.env.JWT_SECRET || "fallback_secret_change_in_production",
    { expiresIn: `${Number(process.env.SESSION_HOURS || 8)}h` }
  );

const verifyToken = (token) => {
  try {
    return jwt.verify(token, process.env.JWT_SECRET || "fallback_secret_change_in_production");
  } catch {
    return null;
  }
};

const generateAuthToken = signToken;

// Hash a new password with bcrypt.
async function hashPassword(password) {
  return bcrypt.hash(password, 10);
}

// Verify a password against stored hash.
// Handles legacy SHA-256 hashes transparently — returns { ok, legacy } so the
// caller can migrate the stored hash after a successful login.
async function verifyPassword(password, stored) {
  if (stored && stored.startsWith("$2")) {
    const ok = await bcrypt.compare(password, stored);
    return { ok, legacy: false };
  }
  // Legacy SHA-256 path
  const sha256 = crypto.createHash("sha256").update(password).digest("hex");
  return { ok: sha256 === stored, legacy: true };
}

async function recordSerialMovement(pool, movement = {}) {
  if (!pool || !movement.serialNumberGuid || !movement.serialValue) return;
  try {
    await pool.query(
      `INSERT INTO serialmovements
         (guid, serialNumberGuid, serialValue, dispatchGuid, actionType, status, itemCondition,
          reason, platform, orderid, invoiceNumber, createdAt, createdBy, notes)
       VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        movement.serialNumberGuid,
        String(movement.serialValue).trim(),
        movement.dispatchGuid || null,
        safeStr(movement.actionType, "StatusUpdated"),
        safeStr(movement.status, "Unknown"),
        safeStr(movement.condition, null),
        safeStr(movement.reason, null),
        safeStr(movement.firmName, null),
        safeStr(movement.customerName, null),
        safeStr(movement.invoiceNumber, null),
        movement.createdAt ? new Date(movement.createdAt) : new Date(),
        safeStr(movement.createdBy, "System"),
        safeStr(movement.notes, null),
      ]
    );
  } catch (err) {
    console.error("Error recording serial movement:", err.message);
  }
}

async function logUserActivity(pool, user, action, changes, ipAddress) {
  try {
    await pool.query(
      `INSERT INTO useractivitylogs (guid, userId, username, role, action, details, ipAddress)
       VALUES (UUID(), ?, ?, ?, ?, ?, ?)`,
      [user.id, user.username, user.role, action, JSON.stringify(changes), ipAddress]
    );
  } catch (err) {
    console.error("Failed to create audit log:", err.message);
  }
}

function appendErrorLog(label, err) {
  try {
    fs.appendFileSync("./error.log", `${new Date().toISOString()} [${label}]: ${err.stack || err}\n`);
  } catch (_) {}
}

const isSameDateTimeValue = (a, b) => {
  const left = safeDate(a);
  const right = safeDate(b);
  return (left ? new Date(left).getTime() : null) === (right ? new Date(right).getTime() : null);
};
const isSameStringValue = (a, b) => safeStr(a, "") === safeStr(b, "");
const isSameNumericValue = (a, b) => Number(a ?? 0) === Number(b ?? 0);

const hasDeliveredLogisticsFieldChange = (fields, current) =>
  (fields.dispatchDate !== undefined && !isSameDateTimeValue(fields.dispatchDate, current.dispatchDate)) ||
  (fields.courierPartner !== undefined && !isSameStringValue(fields.courierPartner, current.courierPartner)) ||
  (fields.logisticsDispatchDate !== undefined && !isSameDateTimeValue(fields.logisticsDispatchDate, current.logisticsDispatchDate)) ||
  (fields.trackingId !== undefined && !isSameStringValue(fields.trackingId, current.trackingId)) ||
  (fields.freightCharges !== undefined && !isSameNumericValue(fields.freightCharges, current.freightCharges)) ||
  (fields.podFilename !== undefined && !isSameStringValue(fields.podFilename, current.podFilename)) ||
  (fields.packagingCost !== undefined && !isSameNumericValue(fields.packagingCost, current.packagingCost));

module.exports = {
  VALID_ROLES,
  safeDate,
  safeNum,
  safeStr,
  toBit,
  normalizeRole,
  normalizeBusinessStatus,
  normalizeLogisticsStatus,
  mapDispatchRow,
  sanitizeUser,
  signToken,
  verifyToken,
  generateAuthToken,
  hashPassword,
  verifyPassword,
  recordSerialMovement,
  logUserActivity,
  appendErrorLog,
  isSameDateTimeValue,
  isSameStringValue,
  isSameNumericValue,
  hasDeliveredLogisticsFieldChange,
};
