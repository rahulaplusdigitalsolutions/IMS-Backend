const router = require("express").Router();
const { mysqlPool } = require("../db");

router.get("/", async (req, res) => {
  try {
    const { q, type } = req.query;
    if (!q || q.trim().length < 2) return res.json([]);
    const term = `%${q.trim()}%`;
    let results = [];

    if (!type || type === "all" || type === "models") {
      const [r] = await mysqlPool.query(
        "SELECT 'model' as type, id, name as title, company as subtitle, category as extra FROM models WHERE (name LIKE ? OR company LIKE ? OR category LIKE ?) AND isDeleted=0 ORDER BY name",
        [term, term, term]
      );
      results = results.concat(r);
    }
    if (!type || type === "all" || type === "serials") {
      const [r] = await mysqlPool.query(
        "SELECT 'serial' as type, s.guid, s.value as title, m.name as subtitle, s.status as extra FROM serials s JOIN models m ON s.modelGuid=m.guid WHERE s.value LIKE ? AND s.isDeleted=0 AND m.isDeleted=0 ORDER BY s.value",
        [term]
      );
      results = results.concat(r);
    }
    if (!type || type === "all" || type === "dispatches") {
      const [r] = await mysqlPool.query(
        "SELECT 'dispatch' as type, oi.guid, o.platform as title, o.orderid as subtitle, o.status as extra FROM order_items oi JOIN orders o ON oi.orderGuid=o.guid WHERE (o.platform LIKE ? OR o.orderid LIKE ? OR o.address LIKE ? OR o.shippingAddress LIKE ?) AND o.isDeleted=0 ORDER BY o.dispatchDate DESC",
        [term, term, term, term]
      );
      results = results.concat(r);
    }
    if (!type || type === "all" || type === "returns") {
      const [r] = await mysqlPool.query(
        "SELECT 'return' as type, r.guid, s.value as title, r.condition as subtitle, r.returnDate as extra FROM returns r JOIN serials s ON r.serialNumberGuid=s.guid WHERE s.value LIKE ? AND r.isDeleted=0 ORDER BY r.returnDate DESC",
        [term]
      );
      results = results.concat(r);
    }

    res.json(results.slice(0, 50));
  } catch (err) {
    console.error("[search] GET /:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

module.exports = router;
