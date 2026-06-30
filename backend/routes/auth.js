const router = require("express").Router();
const { mysqlPool } = require("../db");
const { sanitizeUser, normalizeRole, safeStr, signToken, hashPassword, verifyPassword, logUserActivity } = require("../helpers");
const { requireAuth } = require("../middleware/auth");

async function getUserCount() {
  const [rows] = await mysqlPool.query("SELECT COUNT(*) as total FROM users");
  return Number(rows[0]?.total || 0);
}

router.get("/bootstrap-status", async (req, res) => {
  try {
    res.json({ setupRequired: (await getUserCount()) === 0 });
  } catch (err) {
    console.error("[auth] bootstrap-status:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

router.get("/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

router.post("/signup", async (req, res) => {
  try {
    const { username, password, role } = req.body;
    const safeUsername = safeStr(username, "");
    if (!safeUsername || !password) return res.status(400).json({ message: "Username and password are required." });

    const total = await getUserCount();
    if (total > 0 && normalizeRole(req.user?.role) !== "Admin") {
      return res.status(403).json({ message: "Only Admin can create users." });
    }

    const [check] = await mysqlPool.query("SELECT userid FROM users WHERE username=?", [safeUsername]);
    if (check.length > 0) return res.status(400).json({ message: "Username already exists." });

    const requestedRole = total === 0 ? "Admin" : normalizeRole(role);
    const hashed = await hashPassword(password);

    await mysqlPool.query(
      "INSERT INTO users (userid, username, password, role, createdAt, updatedAt) VALUES (UUID(),?,?,?,NOW(),NOW())",
      [safeUsername, hashed, requestedRole]
    );

    const [newUser] = await mysqlPool.query("SELECT * FROM users WHERE username=?", [safeUsername]);
    res.json({
      message: total === 0 ? "Admin account created successfully." : "User created successfully.",
      user: sanitizeUser(newUser[0]),
    });
  } catch (err) {
    console.error("[auth] signup:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ message: "Username and password are required." });

    const [rows] = await mysqlPool.query(
      "SELECT * FROM users WHERE (username=? OR email=?) LIMIT 1",
      [safeStr(username, ""), safeStr(username, "")]
    );

    if (rows.length === 0) return res.status(401).json({ message: "Invalid credentials" });
    const user = rows[0];

    const { ok, legacy } = await verifyPassword(password, user.password);
    if (!ok) return res.status(401).json({ message: "Invalid credentials" });

    // Migrate legacy SHA-256 hash to bcrypt on successful login
    if (legacy) {
      const newHash = await hashPassword(password);
      await mysqlPool.query("UPDATE users SET password=? WHERE userid=?", [newHash, user.userid]);
    }

    const token = signToken(user);
    // Clear any active force-logout so the new session is valid
    await mysqlPool.query("UPDATE users SET forceLogoutAt = NULL WHERE userid = ?", [user.userid]);
    await logUserActivity(mysqlPool, { id: user.userid, username: user.username, role: user.role }, "Login", [{ field: "session", newValue: "Started" }], req.ip);

    res.json({ token, user: sanitizeUser(user) });
  } catch (err) {
    console.error("[auth] login:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

router.post("/logout", requireAuth, async (req, res) => {
  try {
    await logUserActivity(mysqlPool, req.user, "Logout", [{ field: "session", newValue: "Ended" }], req.ip);
    res.json({ message: "Logged out successfully." });
  } catch (err) {
    console.error("[auth] logout:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

router.get("/profile", requireAuth, async (req, res) => {
  try {
    const [rows] = await mysqlPool.query(
      "SELECT * FROM users WHERE userid=?",
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ message: "User not found." });
    res.json(sanitizeUser(rows[0]));
  } catch (err) {
    console.error("[auth] profile GET:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

router.put("/profile", requireAuth, async (req, res) => {
  try {
    const { fullName, email, phone } = req.body;
    const [existing] = await mysqlPool.query("SELECT * FROM users WHERE userid=?", [req.user.id]);
    if (!existing.length) return res.status(404).json({ message: "User not found." });
    const cur = existing[0];

    const updates = {};
    const changes = [];

    const nfull = safeStr(fullName);
    const nemail = safeStr(email);
    const nphone = safeStr(phone);

    if (fullName !== undefined && nfull !== cur.fullName) { updates.fullName = nfull; changes.push({ field: "fullName", oldValue: cur.fullName, newValue: nfull }); }
    if (email !== undefined && nemail !== cur.email) { updates.email = nemail; changes.push({ field: "email", oldValue: cur.email, newValue: nemail }); }
    if (phone !== undefined && nphone !== cur.phone) { updates.phone = nphone; changes.push({ field: "phone", oldValue: cur.phone, newValue: nphone }); }

    if (changes.length > 0) {
      // Explicit columns — no dynamic keys from request body
      await mysqlPool.query(
        "UPDATE users SET fullName=?, email=?, phone=? WHERE userid=?",
        [updates.fullName ?? cur.fullName, updates.email ?? cur.email, updates.phone ?? cur.phone, req.user.id]
      );
      await logUserActivity(mysqlPool, req.user, "Profile Update", changes, req.ip);
    }

    const [updated] = await mysqlPool.query("SELECT * FROM users WHERE userid=?", [req.user.id]);
    res.json({ message: "Profile updated successfully.", user: sanitizeUser(updated[0]) });
  } catch (err) {
    console.error("[auth] profile PUT:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

router.put(["/password", "/change-password"], requireAuth, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword || !newPassword.trim()) return res.status(400).json({ message: "Old and new password are required." });

    const [rows] = await mysqlPool.query("SELECT * FROM users WHERE userid=?", [req.user.id]);
    if (!rows.length) return res.status(404).json({ message: "User not found." });
    const cur = rows[0];

    const { ok } = await verifyPassword(oldPassword, cur.password);
    if (!ok) return res.status(400).json({ message: "Incorrect old password." });

    const hashed = await hashPassword(newPassword);
    await mysqlPool.query("UPDATE users SET password=? WHERE userid=?", [hashed, req.user.id]);
    await logUserActivity(mysqlPool, req.user, "Password Change", [{ field: "password", oldValue: "***", newValue: "***" }], req.ip);

    res.json({ message: "Password changed successfully." });
  } catch (err) {
    console.error("[auth] change-password:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

module.exports = router;
