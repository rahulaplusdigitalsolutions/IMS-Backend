const { mysqlPool } = require("../db");
const { sanitizeUser, normalizeRole, safeStr, normalizeBusinessStatus, normalizeLogisticsStatus, verifyToken } = require("../helpers");

const ALL_AUTHENTICATED_ROLES = ["Admin", "Supervisor", "Accountant", "User", "Operator", "SuperAdmin"];

const isSuperUser = (role) => role === "Admin" || role === "SuperAdmin";

// 30-second in-memory user cache — avoids a DB query on every request
const _userCache = new Map(); // userId -> { user, exp }
const USER_CACHE_TTL = 30_000;

function _getCached(userId) {
  const entry = _userCache.get(String(userId));
  if (!entry || Date.now() > entry.exp) { _userCache.delete(String(userId)); return null; }
  return entry.user;
}
function _setCache(userId, user) {
  _userCache.set(String(userId), { user, exp: Date.now() + USER_CACHE_TTL });
}
function invalidateUserCache(userId) {
  _userCache.delete(String(userId));
}
function getCacheSize() { return _userCache.size; }
function clearAllUserCache() { _userCache.clear(); }

async function getUserByToken(token) {
  const payload = verifyToken(token);
  if (!payload) return null;

  const cached = _getCached(payload.id);
  if (cached) {
    if (cached.forceLogoutAt && new Date(cached.forceLogoutAt).getTime() > payload.iat * 1000) {
      invalidateUserCache(payload.id);
      return null;
    }
    return cached;
  }

  const [rows] = await mysqlPool.query(
    "SELECT * FROM users WHERE userid = ? LIMIT 1",
    [payload.id]
  );
  const user = rows[0];
  if (!user) return null;
  if (user.forceLogoutAt && new Date(user.forceLogoutAt).getTime() > payload.iat * 1000) return null;
  _setCache(payload.id, user);
  return user;
}

// Accept token from Authorization header only — never from query string.
function getBearerToken(req) {
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) return header.slice(7).trim() || null;
  return null;
}

async function attachAuthenticatedUser(req, res, next) {
  if (!req.path.startsWith("/api") && !req.path.startsWith("/Inventory")) return next();
  const token = getBearerToken(req);
  if (!token) { req.user = null; return next(); }
  try {
    const user = await getUserByToken(token);
    req.user = user ? sanitizeUser(user) : null;
    return next();
  } catch (err) {
    console.error("[auth] attachAuthenticatedUser:", err.message);
    return res.status(500).json({ message: "An internal server error occurred." });
  }
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ message: "Authentication required" });
  return next();
}

function requireRoles(roles, message = "You do not have permission to perform this action.") {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ message: "Authentication required" });
    if (isSuperUser(normalizeRole(req.user.role))) return next();
    if (!roles.includes(normalizeRole(req.user.role))) return res.status(403).json({ message });
    return next();
  };
}

function requirePermission(permission, message = "You do not have the required power to access this feature.") {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ message: "Authentication required" });
    if (isSuperUser(normalizeRole(req.user.role))) return next();
    if (req.user.permissions && req.user.permissions.includes(permission)) return next();
    return res.status(403).json({ message });
  };
}

function requireEditPermission(columnName) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ message: "Authentication required" });
    if (isSuperUser(normalizeRole(req.user.role))) return next();
    if (req.user[columnName]) return next();
    return res.status(403).json({ message: "You do not have permission to edit this module." });
  };
}

function authorizeReadWrite({ readRoles = ALL_AUTHENTICATED_ROLES, writeRoles = [], deleteRoles = null, denyMessage = "You do not have permission to perform this action.", editColumnName = null }) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ message: "Authentication required" });
    const role = normalizeRole(req.user.role);
    if (isSuperUser(role)) return next();
    const method = req.method.toUpperCase();
    const safeDeleteRoles = deleteRoles || writeRoles;
    const allowedRoles = ["GET", "HEAD", "OPTIONS"].includes(method) ? readRoles : method === "DELETE" ? safeDeleteRoles : writeRoles;
    if (!allowedRoles.includes(role)) {
      if (editColumnName && ["POST", "PUT", "PATCH", "DELETE"].includes(method) && req.user[editColumnName]) return next();
      return res.status(403).json({ message: denyMessage });
    }
    return next();
  };
}

const ACCOUNTANT_DISPATCH_FIELDS = new Set(["id", "ids", "status", "invoiceNumber", "invoiceDate", "ewayBillNumber", "gemBillUploaded", "invoiceFilename", "ewayBillFilename", "logisticsStatus", "commission"]);
const ACCOUNTANT_ALLOWED_DISPATCH_STATUSES = new Set(["Send for Billing", "Billed", "Payment Pending", "Completed"]);
const ACCOUNTANT_ALLOWED_LOGISTICS_STATUSES = new Set([null, "", "Packing in Process", "Delivered"]);

function isPlainObject(v) { return !!v && typeof v === "object" && !Array.isArray(v); }

function getDispatchUpdatePayloads(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.updates)) return body.updates;
  if (isPlainObject(body?.updates)) return [body.updates];
  if (isPlainObject(body)) return [body];
  return [];
}

function isAccountantDispatchUpdateAllowed(update) {
  if (!isPlainObject(update)) return false;
  const keys = Object.keys(update).filter((k) => update[k] !== undefined);
  if (!keys.length || !keys.every((k) => ACCOUNTANT_DISPATCH_FIELDS.has(k))) return false;
  if (update.status !== undefined && !ACCOUNTANT_ALLOWED_DISPATCH_STATUSES.has(normalizeBusinessStatus(update.status))) return false;
  if (update.logisticsStatus !== undefined && !ACCOUNTANT_ALLOWED_LOGISTICS_STATUSES.has(normalizeLogisticsStatus(update.logisticsStatus))) return false;
  return true;
}

function isAccountantDispatchRequest(req) {
  const updates = getDispatchUpdatePayloads(req.body);
  return updates.length > 0 && updates.every(isAccountantDispatchUpdateAllowed);
}

function authorizeDispatchRequest(req, res, next) {
  if (!req.user) return res.status(401).json({ message: "Authentication required" });
  const role = normalizeRole(req.user.role);
  const method = req.method.toUpperCase();
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return next();
  if (isSuperUser(role) || req.user.allow_edit_dispatch) return next();
  if (role === "Accountant" && method === "PUT" && isAccountantDispatchRequest(req)) return next();
  return res.status(403).json({ message: "This dispatch action is not allowed for your role." });
}

function canManageOrderDocuments(role, docType) {
  const dt = safeStr(docType, "");
  if (isSuperUser(role)) return true;
  // Custom / additional doc types (not in the standard set) are open to any
  // authenticated user who already passed authorizeOrdersRequest.
  const standardTypes = ["invoice", "ewayBill", "pod", "gemContract"];
  if (!standardTypes.includes(dt)) return true;
  // Standard types remain role-gated
  if (role === "Supervisor") return true;
  if (role === "Accountant") return ["invoice", "ewayBill", "pod"].includes(dt);
  if (role === "User" || role === "Operator") return ["gemContract", "pod"].includes(dt);
  return false;
}

function authorizeOrdersRequest(req, res, next) {
  if (!req.user) return res.status(401).json({ message: "Authentication required" });
  const role = normalizeRole(req.user.role);
  const method = req.method.toUpperCase();
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return next();
  if (isSuperUser(role)) return next();
  if (method === "POST" && req.user.allow_create_order) return next();
  // Payment paths must be checked BEFORE allow_edit_order_processing so that
  // a user with only that permission cannot bypass the Admin/Accountant restriction.
  if (req.path.endsWith("/payment") || req.path.endsWith("/batch-payment")) {
    if (role === "Accountant") return next();
    return res.status(403).json({ message: "Only Admin or Accountant can update payments." });
  }
  if (["PUT", "PATCH", "DELETE"].includes(method) && req.user.allow_edit_order_processing) return next();
  if (req.path.endsWith("/upload")) {
    if (["Admin", "Accountant", "User", "Operator"].includes(role)) return next();
    return res.status(403).json({ message: "You cannot upload order documents." });
  }
  if (req.path.endsWith("/status")) {
    if (["Admin", "User", "Operator"].includes(role)) return next();
    return res.status(403).json({ message: "Only Admin or Operators can update order status." });
  }
  if (req.path.endsWith("/replace")) {
    if (["Admin", "User", "Operator"].includes(role)) return next();
    return res.status(403).json({ message: "Only Admin or Operators can replace orders." });
  }
  if (req.path.endsWith("/warranty-start")) {
    if (["Admin", "User", "Operator"].includes(role)) return next();
    return res.status(403).json({ message: "Only Admin or Operators can update warranty dates." });
  }
  return res.status(403).json({ message: "This order action is not allowed for your role." });
}

module.exports = {
  ALL_AUTHENTICATED_ROLES,
  isSuperUser,
  invalidateUserCache,
  getCacheSize,
  clearAllUserCache,
  attachAuthenticatedUser,
  requireAuth,
  requireRoles,
  requirePermission,
  requireEditPermission,
  authorizeReadWrite,
  authorizeDispatchRequest,
  authorizeOrdersRequest,
  canManageOrderDocuments,
  isAccountantDispatchRequest,
};
