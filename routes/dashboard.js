const router = require("express").Router();
const { mysqlPool } = require("../db");

router.get("/stats", async (req, res) => {
  try {
    const [[{ totalModels }]] = await mysqlPool.query("SELECT COUNT(*) as totalModels FROM models WHERE isDeleted=0");
    const [[{ totalSerials }]] = await mysqlPool.query("SELECT COUNT(*) as totalSerials FROM serials WHERE isDeleted=0");
    const [[{ availableSerials }]] = await mysqlPool.query("SELECT COUNT(*) as availableSerials FROM serials WHERE status='Available' AND isDeleted=0");
    const [[{ dispatchedSerials }]] = await mysqlPool.query("SELECT COUNT(*) as dispatchedSerials FROM serials WHERE status='Dispatched' AND isDeleted=0");
    const [[{ totalDispatches }]] = await mysqlPool.query("SELECT COUNT(oi.guid) as totalDispatches FROM order_items oi JOIN orders o ON oi.orderGuid=o.guid WHERE o.isDeleted=0");
    const [[{ recentDispatches }]] = await mysqlPool.query("SELECT COUNT(oi.guid) as recentDispatches FROM order_items oi JOIN orders o ON oi.orderGuid=o.guid WHERE o.dispatchDate>=DATE_SUB(NOW(),INTERVAL 30 DAY) AND o.isDeleted=0");
    const [[{ totalReturns }]] = await mysqlPool.query("SELECT COUNT(*) as totalReturns FROM returns WHERE isDeleted=0");
    const [[{ pendingInstallations }]] = await mysqlPool.query("SELECT COUNT(oi.guid) as pendingInstallations FROM order_items oi JOIN orders o ON oi.orderGuid=o.guid JOIN order_installations ins ON o.guid=ins.orderGuid WHERE (ins.installationRequired='Yes' OR ins.installationRequired='true' OR ins.installationRequired='1') AND ins.installationStatus IN ('Pending','Scheduled') AND o.isDeleted=0");
    const [[{ totalRevenue }]] = await mysqlPool.query("SELECT SUM(oi.sellingPrice) as totalRevenue FROM order_items oi JOIN orders o ON oi.orderGuid=o.guid WHERE o.dispatchDate>=DATE_SUB(NOW(),INTERVAL 30 DAY) AND o.isDeleted=0");

    res.json({ totalModels, totalSerials, availableSerials, dispatchedSerials, totalDispatches, recentDispatches, totalReturns, pendingInstallations, totalRevenue: Number(totalRevenue || 0) });
  } catch (err) {
    console.error("[dashboard] stats:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

module.exports = router;
