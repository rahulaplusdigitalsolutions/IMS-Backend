// Dispatch stats and appearance endpoints that live outside the stored-procedure-based dispatchRoutes.js
const router = require("express").Router();
const { mysqlPool } = require("../db");

router.get("/stats", async (req, res) => {
  try {
    const [rows] = await mysqlPool.query(`
      SELECT COUNT(oi.guid) as total,
        SUM(CASE WHEN o.isDeleted=0 THEN 1 ELSE 0 END) as active,
        SUM(CASE WHEN o.status='Delivered' AND o.isDeleted=0 THEN 1 ELSE 0 END) as delivered,
        SUM(CASE WHEN o.status='In Transit' AND o.isDeleted=0 THEN 1 ELSE 0 END) as inTransit,
        SUM(CASE WHEN o.status='Cancelled' AND o.isDeleted=0 THEN 1 ELSE 0 END) as cancelled
      FROM order_items oi JOIN orders o ON oi.orderGuid=o.guid
    `);
    res.json(rows[0]);
  } catch (err) {
    console.error("[dispatches] stats:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

router.put("/batch/appearance", async (req, res) => {
  try {
    const { ids, rowColor, tags } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ message: "No IDs provided" });
    await mysqlPool.query(
      "UPDATE orders o JOIN order_items oi ON o.guid=oi.orderGuid SET o.rowColor=?,o.tags=? WHERE oi.guid IN (?)",
      [rowColor || null, tags || null, ids]
    );
    res.json({ message: "Batch appearance updated successfully" });
  } catch (err) {
    console.error("[dispatches] batch appearance:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

router.put("/:id/appearance", async (req, res) => {
  try {
    const { rowColor, tags } = req.body;
    await mysqlPool.query(
      "UPDATE orders o JOIN order_items oi ON o.guid=oi.orderGuid SET o.rowColor=?,o.tags=? WHERE oi.guid=?",
      [rowColor || null, tags || null, req.params.id]
    );
    res.json({ message: "Appearance updated successfully" });
  } catch (err) {
    console.error("[dispatches] appearance:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

module.exports = router;
