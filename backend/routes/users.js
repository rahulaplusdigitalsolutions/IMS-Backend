const router = require("express").Router();
const { mysqlPool } = require("../db");
const { sanitizeUser, normalizeRole, safeStr, toBit, hashPassword, logUserActivity } = require("../helpers");
const { requireRoles, isSuperUser, invalidateUserCache } = require("../middleware/auth");

router.get("/", async (req, res) => {
  try {
    const [rows] = await mysqlPool.query(
      "SELECT * FROM users WHERE role != 'SuperAdmin' ORDER BY createdAt DESC, userid DESC"
    );
    res.json(rows.map(sanitizeUser));
  } catch (err) {
    console.error("[users] GET /:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

router.post("/", async (req, res) => {
  try {
    const { username, password, role, fullName, email, phone, permissions,
      allow_edit_models, allow_edit_serials, allow_edit_godown,
      allow_create_order, allow_edit_order_processing, allow_edit_billing, allow_edit_dispatch,
      allow_edit_installations, allow_edit_damaged, allow_edit_returns, allow_edit_fbf_fba, allow_edit_warranty } = req.body;

    const safeUsername = safeStr(username, "");
    if (!safeUsername || !password) return res.status(400).json({ message: "Username and password are required." });

    if (normalizeRole(role) === "SuperAdmin") {
      return res.status(403).json({ message: "SuperAdmin account cannot be created from here." });
    }

    const [check] = await mysqlPool.query("SELECT userid FROM users WHERE username=?", [safeUsername]);
    if (check.length > 0) return res.status(400).json({ message: "Username already exists." });

    const hashed = await hashPassword(password);
    const perms = Array.isArray(permissions) ? JSON.stringify(permissions) : "[]";

    await mysqlPool.query(
      `INSERT INTO users (userid, username, password, role, fullName, email, phone, permissions,
         allow_edit_models, allow_edit_serials, allow_edit_godown,
         allow_create_order, allow_edit_order_processing, allow_edit_billing, allow_edit_dispatch,
         allow_edit_installations, allow_edit_damaged, allow_edit_returns, allow_edit_fbf_fba, allow_edit_warranty, createdAt, updatedAt)
       VALUES (UUID(),?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW(),NOW())`,
      [safeUsername, hashed, normalizeRole(role), safeStr(fullName), safeStr(email), safeStr(phone), perms,
        allow_edit_models ? 1 : 0, allow_edit_serials ? 1 : 0, allow_edit_godown ? 1 : 0,
        allow_create_order ? 1 : 0, allow_edit_order_processing ? 1 : 0, allow_edit_billing ? 1 : 0,
        allow_edit_dispatch ? 1 : 0, allow_edit_installations ? 1 : 0,
        allow_edit_damaged ? 1 : 0, allow_edit_returns ? 1 : 0, allow_edit_fbf_fba ? 1 : 0, allow_edit_warranty ? 1 : 0]
    );

    const [newUser] = await mysqlPool.query("SELECT * FROM users WHERE username=?", [safeUsername]);
    res.status(201).json({ message: "User created successfully.", user: sanitizeUser(newUser[0]) });
  } catch (err) {
    console.error("[users] POST /:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { username, password, role, fullName, email, phone, permissions,
      allow_edit_models, allow_edit_serials, allow_edit_godown,
      allow_create_order, allow_edit_order_processing, allow_edit_billing, allow_edit_dispatch,
      allow_edit_installations, allow_edit_damaged, allow_edit_returns, allow_edit_fbf_fba, allow_edit_warranty } = req.body;

    const [existing] = await mysqlPool.query("SELECT * FROM users WHERE userid=?", [id]);
    if (!existing.length) return res.status(404).json({ message: "User not found." });
    const cur = existing[0];

    // Block editing the SuperAdmin account by anyone except SuperAdmin itself
    if (cur.role === "SuperAdmin" && req.user.role !== "SuperAdmin") {
      return res.status(403).json({ message: "SuperAdmin account cannot be edited." });
    }

    const nextUsername = safeStr(username, cur.username);
    const nextPassword = password && password.trim() !== "" ? await hashPassword(password) : cur.password;
    // Prevent changing role to/from SuperAdmin via this endpoint
    const rawRole = normalizeRole(role || cur.role);
    const nextRole = rawRole === "SuperAdmin" ? cur.role : rawRole;
    const nextPerms = Array.isArray(permissions) ? JSON.stringify(permissions) : cur.permissions || "[]";

    const [dup] = await mysqlPool.query("SELECT userid FROM users WHERE username=? AND userid<>?", [nextUsername, id]);
    if (dup.length > 0) return res.status(400).json({ message: "Username already exists." });
    if (String(id) === String(req.user.id) && !isSuperUser(nextRole) && isSuperUser(cur.role)) {
      return res.status(400).json({ message: "You cannot remove your own elevated access." });
    }
    if (String(id) === String(req.user.id) && nextRole !== "Admin" && cur.role === "Admin") {
      return res.status(400).json({ message: "You cannot remove your own Admin access." });
    }

    const b = (flag, fallback) => flag !== undefined ? (flag ? 1 : 0) : fallback;

    await mysqlPool.query(
      `UPDATE users SET username=?, password=?, role=?, fullName=?, email=?, phone=?, permissions=?,
         allow_edit_models=?, allow_edit_serials=?, allow_edit_godown=?,
         allow_create_order=?, allow_edit_order_processing=?, allow_edit_billing=?, allow_edit_dispatch=?,
         allow_edit_installations=?, allow_edit_damaged=?, allow_edit_returns=?, allow_edit_fbf_fba=?, allow_edit_warranty=?, updatedAt=NOW()
       WHERE userid=?`,
      [nextUsername, nextPassword, nextRole, safeStr(fullName, cur.fullName), safeStr(email, cur.email),
        safeStr(phone, cur.phone), nextPerms,
        b(allow_edit_models, cur.allow_edit_models), b(allow_edit_serials, cur.allow_edit_serials),
        b(allow_edit_godown, cur.allow_edit_godown),
        b(allow_create_order, cur.allow_create_order), b(allow_edit_order_processing, cur.allow_edit_order_processing),
        b(allow_edit_billing, cur.allow_edit_billing), b(allow_edit_dispatch, cur.allow_edit_dispatch),
        b(allow_edit_installations, cur.allow_edit_installations), b(allow_edit_damaged, cur.allow_edit_damaged),
        b(allow_edit_returns, cur.allow_edit_returns), b(allow_edit_fbf_fba, cur.allow_edit_fbf_fba),
        b(allow_edit_warranty, cur.allow_edit_warranty), id]
    );

    invalidateUserCache(id);
    const [updated] = await mysqlPool.query("SELECT * FROM users WHERE userid=?", [id]);
    res.json({ message: "User updated successfully.", user: sanitizeUser(updated[0]) });
  } catch (err) {
    console.error("[users] PUT /:id:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (String(id) === String(req.user.id)) return res.status(400).json({ message: "You cannot delete your own account." });

    const [target] = await mysqlPool.query("SELECT * FROM users WHERE userid=?", [id]);
    if (!target.length) return res.status(404).json({ message: "User not found." });

    if (target[0].role === "SuperAdmin") {
      return res.status(403).json({ message: "SuperAdmin account cannot be deleted." });
    }

    if (normalizeRole(target[0].role) === "Admin") {
      const [admins] = await mysqlPool.query("SELECT COUNT(*) as total FROM users WHERE role='Admin'");
      if (Number(admins[0].total) <= 1) return res.status(400).json({ message: "At least one Admin account must remain." });
    }

    await mysqlPool.query("DELETE FROM users WHERE userid=?", [id]);
    res.json({ message: "User deleted successfully." });
  } catch (err) {
    console.error("[users] DELETE /:id:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

module.exports = router;
