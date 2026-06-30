const fs = require("fs");
process.on("uncaughtException", (err) => {
  fs.appendFileSync("hostinger_error.log", `${new Date().toISOString()} - Uncaught Exception: ${err.stack || err}\n`);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  fs.appendFileSync("hostinger_error.log", `${new Date().toISOString()} - Unhandled Rejection: ${reason?.stack || reason}\n`);
});

require("dotenv").config();

const express = require("express");
require("express-async-errors"); // Catches all unhandled promise rejections in routes
const helmet = require("helmet");
const cors = require("cors");
const path = require("path");
const rateLimit = require("express-rate-limit");

// ── Internal modules ─────────────────────────────────────────────────────────
const { getMysqlPool } = require("./db");
const { runMigrations } = require("./startup/dbInit");
const { uploadDir } = require("./middleware/upload");
const {
  ALL_AUTHENTICATED_ROLES,
  isSuperUser,
  attachAuthenticatedUser,
  requireAuth,
  requirePermission,
  authorizeReadWrite,
  authorizeDispatchRequest,
  authorizeOrdersRequest,
} = require("./middleware/auth");
const {
  mapDispatchRow,
  recordSerialMovement,
  logUserActivity,
  safeStr,
  safeDate,
  toBit,
  normalizeBusinessStatus,
  normalizeLogisticsStatus,
} = require("./helpers");

// ── External route modules (existing files kept unchanged) ────────────────────
const { setupInventoryRoutes } = require("./inventoryRoutes");
const { setupStationeryReturnRoutes } = require("./stationeryReturnRoutes");
const { setupDropdownRoutes } = require("./dropdownRoutes");
const { setupDispatchRoutes } = require("./dispatchRoutes");
const { setupDelhiveryRoutes } = require("./delhiveryRoutes");
const notificationsRoutes = require("./notificationsRoutes");
const { setupFbfFbaRoutes } = require("./fbfFbaRoutes");
const { setupFbfFbaMasterRoutes } = require("./fbfFbaMasterRoutes");

// ── New route modules ────────────────────────────────────────────────────────
const authRoutes = require("./routes/auth");
const usersRoutes = require("./routes/users");
const modelsRoutes = require("./routes/models");
const serialsRoutes = require("./routes/serials");
const godownsRoutes = require("./routes/godowns");
const installationsRoutes = require("./routes/installations");
const returnsRoutes = require("./routes/returns");
const tagsRoutes = require("./routes/tags");
const reportsRoutes = require("./routes/reports");
const ordersRoutes = require("./routes/orders");
const dispatchesExtRoutes = require("./routes/dispatches-ext");
const dashboardRoutes = require("./routes/dashboard");
const searchRoutes = require("./routes/search");
const exportRoutes = require("./routes/export");
const bulkOrdersRoutes = require("./routes/bulkOrders");
const activityLogsRoutes = require("./routes/activityLogs");
const modelApprovalsRoutes = require("./routes/modelApprovals");
const warrantyRoutes  = require("./routes/warranty");
const aiParseRoutes   = require("./routes/aiParse");
const gatepassRoutes  = require("./routes/gatepass");
const { router: superAdminRoutes, publicRouter: superAdminPublic } = require("./routes/superAdmin");

// ── App setup ─────────────────────────────────────────────────────────────────
const app = express();

// Global Security Headers
app.use(helmet());

// Global Rate Limiting for all /api routes
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 500, // Limit each IP to 500 requests per 15 minutes
  message: "Too many requests from this IP, please try again after 15 minutes",
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/api", globalLimiter);

// Trust reverse proxy (required for express-rate-limit on Hostinger/cPanel)
app.set("trust proxy", 1);

// CORS — restrict to frontend origin if configured
const frontendUrl = process.env.FRONTEND_URL;
let corsOptions;
if (frontendUrl) {
  corsOptions = { origin: frontendUrl, credentials: true };
} else if (process.env.NODE_ENV === "production") {
  console.error("❌  FRONTEND_URL not set in production — CORS will deny all cross-origin requests. Set FRONTEND_URL in .env.");
  corsOptions = { origin: false };
} else {
  console.warn("⚠️  FRONTEND_URL not set — CORS is unrestricted (development mode). Set FRONTEND_URL in .env for production.");
  corsOptions = {};
}
app.use(cors(corsOptions));

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));
app.use("/uploads", express.static(uploadDir));

// ── Rate limiting on auth endpoints ──────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many requests. Please try again later." },
});

// ── Auth middleware (runs on every /api and /Inventory request) ───────────────
const { trackActivity } = require("./utils/sessionTracker");
app.use(attachAuthenticatedUser);
app.use(trackActivity);

// ── Home page ─────────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.type("html").send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><title>Printer Tracker API</title>
    <style>body{margin:0;font-family:Arial,sans-serif;background:#f5f7fb;color:#1f2937}.wrap{max-width:720px;margin:48px auto;padding:32px;background:#fff;border-radius:16px;box-shadow:0 10px 30px rgba(15,23,42,.08)}h1{margin-top:0}code{background:#eef2ff;padding:2px 6px;border-radius:6px}</style>
    </head><body><div class="wrap"><h1>Printer Tracker API is running</h1>
    <p>Backend URI: <code>${process.env.BACKEND_URI || "not set"}</code></p>
    </div></body></html>`);
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ── Route-level authorization guards ─────────────────────────────────────────
const writeRoles = ["Admin", "User", "Operator"];
const allRoles = ALL_AUTHENTICATED_ROLES;

app.use("/api/users", requirePermission("users", "User management access required."));
app.use("/api/models", authorizeReadWrite({ readRoles: allRoles, writeRoles, deleteRoles: ["Admin"], denyMessage: "Only Admin or Operators can manage models.", editColumnName: "allow_edit_models" }));
app.use("/api/serials", authorizeReadWrite({ readRoles: allRoles, writeRoles, deleteRoles: ["Admin"], denyMessage: "Only Admin or Operators can manage serials.", editColumnName: "allow_edit_serials" }));
app.use("/api/godowns", authorizeReadWrite({ readRoles: allRoles, writeRoles, deleteRoles: ["Admin"], denyMessage: "Only Admin or Operators can manage godowns.", editColumnName: "allow_edit_godown" }));
app.use("/api/dispatches", authorizeDispatchRequest);
app.use("/api/installations", authorizeReadWrite({ readRoles: ["Admin", "Supervisor", "User", "Operator"], writeRoles, denyMessage: "Only Admin or Operators can manage installations.", editColumnName: "allow_edit_installations" }));
app.use("/api/returns", (req, res, next) => {
  if (!req.user) return res.status(401).json({ message: "Authentication required" });
  const role = req.user.role;
  const method = req.method.toUpperCase();
  if (isSuperUser(role)) return next();
  if (["GET", "HEAD", "OPTIONS"].includes(method)) {
    return ["Admin", "Supervisor", "User", "Operator"].includes(role) ? next() : res.status(403).json({ message: "You do not have access to returns." });
  }
  if (method === "DELETE") return role === "Admin" ? next() : res.status(403).json({ message: "Only Admin can delete return records." });
  return ["Admin", "User", "Operator"].includes(role) ? next() : res.status(403).json({ message: "Only Admin or Operators can manage returns." });
});
app.use("/api/reports", authorizeReadWrite({ readRoles: ["Admin", "Supervisor", "Accountant"], writeRoles: ["Admin", "Accountant"], denyMessage: "You do not have access to reports." }));
app.use("/api/orders", authorizeOrdersRequest);
app.use("/api/fbf-fba-master", authorizeReadWrite({ readRoles: allRoles, writeRoles: ["Admin", "User", "Operator"], deleteRoles: ["Admin"], denyMessage: "Only Admin or Operators can manage FBF/FBA Master data.", editColumnName: "allow_edit_fbf_fba" }));
app.use("/api/fbf-fba", authorizeReadWrite({ readRoles: allRoles, writeRoles: ["Admin", "User", "Operator"], deleteRoles: ["Admin"], denyMessage: "Only Admin or Operators can manage FBF/FBA Stock.", editColumnName: "allow_edit_fbf_fba" }));
app.use("/api/dashboard", authorizeReadWrite({ readRoles: allRoles, writeRoles: [], denyMessage: "You do not have access to dashboard data." }));
app.use("/api/search", authorizeReadWrite({ readRoles: allRoles, writeRoles: [], denyMessage: "You do not have access to search." }));
app.use("/api/export", authorizeReadWrite({ readRoles: allRoles, writeRoles: [], denyMessage: "You do not have access to exports." }));

// ── Routes ────────────────────────────────────────────────────────────────────
app.use("/api/auth", authLimiter, authRoutes);
app.use("/api/admin/activity-logs", activityLogsRoutes);
app.use("/api/users", usersRoutes);
app.use("/api/models", modelsRoutes);
app.use("/api/serials", serialsRoutes);
app.use("/api/godowns", godownsRoutes);
app.use("/api/installations", installationsRoutes);
app.use("/api/returns", returnsRoutes);
app.use("/api/global-tags", tagsRoutes);
app.use("/api/reports", reportsRoutes);
app.use("/api/orders", ordersRoutes);
app.use("/api/dispatches", dispatchesExtRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/search", searchRoutes);
app.use("/api/export", exportRoutes);
app.use("/api/bulk-orders", bulkOrdersRoutes);
app.use("/api/model-approvals", requireAuth, modelApprovalsRoutes);
app.use("/api/warranty", authorizeReadWrite({ readRoles: allRoles, writeRoles: ["Admin", "User", "Operator"], deleteRoles: ["Admin"], denyMessage: "Only Admin or Operators can manage warranty templates and certificates.", editColumnName: "allow_edit_warranty" }), warrantyRoutes);
app.use("/api/ai", requireAuth, aiParseRoutes);
app.use("/api/gatepass", requireAuth, gatepassRoutes);
app.use("/api/admin", superAdminPublic);
app.use("/api/admin", requireAuth, superAdminRoutes);

// ── /api/Inventory → /Inventory rewrite (frontend compatibility) ──────────────
app.use((req, res, next) => {
  if (req.url.startsWith("/api/Inventory")) req.url = req.url.replace("/api/Inventory", "/Inventory");
  next();
});

// ── External route modules ────────────────────────────────────────────────────
setupInventoryRoutes(app, getMysqlPool, requireAuth);
setupStationeryReturnRoutes(app, getMysqlPool, requireAuth);
setupDropdownRoutes(app, getMysqlPool, requireAuth);
setupDelhiveryRoutes(app, requireAuth);
setupDispatchRoutes(app, getMysqlPool, attachAuthenticatedUser, requireAuth, authorizeDispatchRequest, {
  mapDispatchRow, recordSerialMovement, logUserActivity, safeStr, safeDate, toBit, normalizeBusinessStatus, normalizeLogisticsStatus,
});
app.use("/api/notifications", notificationsRoutes(requireAuth, getMysqlPool));
setupFbfFbaMasterRoutes(app, getMysqlPool, requireAuth);
setupFbfFbaRoutes(app, getMysqlPool, requireAuth, { recordSerialMovement });

// ── Global Error Handler ────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  const isProd = process.env.NODE_ENV === "production";
  const errorMessage = err.message || "An unexpected internal server error occurred.";
  
  // Log the full stack trace to the internal error log
  fs.appendFileSync("hostinger_error.log", `${new Date().toISOString()} - Global Error Handler: ${err.stack || err}\n`);
  console.error("Global Error Caught:", err);
  
  res.status(err.status || 500).json({ 
    message: isProd ? "Internal Server Error" : errorMessage,
    ...(isProd ? {} : { stack: err.stack })
  });
});

// ── Start server ──────────────────────────────────────────────────────────────
let PORT = parseInt(process.env.PORT || 5001, 10);
(async () => {
  await runMigrations();
  const startServer = (port) => {
    const server = app.listen(port, () => {
      console.log(`🚀 Server running on port ${port}`);
    }).on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.warn(`⚠️ Port ${port} is already in use. Trying port ${port + 1}...`);
        startServer(port + 1);
      } else {
        console.error(err);
      }
    });

    // Graceful shutdown for nodemon restarts
    process.once('SIGUSR2', () => {
      server.close(() => {
        process.kill(process.pid, 'SIGUSR2');
      });
    });

    process.on('SIGINT', () => {
      server.close(() => {
        process.exit(0);
      });
    });
  };

  startServer(PORT);
})();
