const router = require("express").Router();
const { mysqlPool } = require("../db");
const { requireRoles } = require("../middleware/auth");

router.get("/", requireRoles(["Admin"]), async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 10, 100);
    const offset = (page - 1) * limit;
    const [[{ total }]] = await mysqlPool.query("SELECT COUNT(*) as total FROM useractivitylogs");
    const [rows] = await mysqlPool.query("SELECT * FROM useractivitylogs ORDER BY changedAt DESC LIMIT ? OFFSET ?", [limit, offset]);
    res.json({ data: rows, total });
  } catch (err) {
    console.error("[activityLogs] GET /:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

module.exports = router;
