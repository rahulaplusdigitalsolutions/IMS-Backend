const router = require("express").Router();
const { mysqlPool } = require("../db");

router.get("/:type", async (req, res) => {
  try {
    const { type } = req.params;
    const { format = "csv", startDate, endDate } = req.query;
    const params = [];
    let query, filename;

    switch (type) {
      case "models":
        query = `
          SELECT m.name, m.company, m.category, m.colorType, m.printerType, m.description, m.mrp, m.stockQuantity, m.packagingCost,
            COUNT(s.guid) as totalSerials, SUM(CASE WHEN s.status='Available' THEN 1 ELSE 0 END) as availableSerials
          FROM models m LEFT JOIN serials s ON m.guid=s.modelGuid AND s.isDeleted=0
          WHERE m.isDeleted=0 GROUP BY m.guid, m.name, m.company, m.category, m.colorType, m.printerType, m.description, m.mrp, m.stockQuantity, m.packagingCost
          ORDER BY m.name
        `;
        filename = "models";
        break;

      case "serials":
        query = `
          SELECT s.value as serialNumber, m.name as modelName, m.company, s.landingPrice, m.mrp,
            s.landingPriceReason, s.status, s.createdAt
          FROM serials s JOIN models m ON s.modelGuid=m.guid
          WHERE s.isDeleted=0 AND m.isDeleted=0 ORDER BY s.createdAt DESC
        `;
        filename = "serials";
        break;

      case "dispatches":
        query = `
          SELECT o.dispatchDate, o.platform AS firmName, o.orderid as customer,
            COALESCE(o.address,o.shippingAddress) as address,
            oi.sellingPrice, o.packagingCost, o.commission, s.value as serialNumber,
            m.name as modelName, m.company, o.status, ins.installationRequired, ins.installationStatus,
            ol.courierPartner, ol.trackingId, o.freightCharges, ol.logisticsStatus, o.ewayBillFilename
          FROM order_items oi JOIN orders o ON oi.orderGuid=o.guid
          LEFT JOIN order_logistics ol ON o.guid=ol.orderGuid
          LEFT JOIN order_installations ins ON o.guid=ins.orderGuid
          LEFT JOIN serials s ON oi.serialNumberGuid=s.guid
          LEFT JOIN models m ON s.modelGuid=m.guid
          WHERE o.isDeleted=0
        `;
        if (startDate && endDate) {
          query += " AND o.dispatchDate>=? AND o.dispatchDate<=?";
          params.push(`${startDate.split("T")[0]} 00:00:00`, `${endDate.split("T")[0]} 23:59:59`);
        }
        query += " ORDER BY o.dispatchDate DESC";
        filename = "dispatches";
        break;

      case "returns":
        query = `
          SELECT r.returnDate, s.value as serialNumber, m.name as modelName, r.condition,
            r.dispatchGuid as orderId, r.invoiceNumber, r.reason
          FROM returns r JOIN serials s ON r.serialNumberGuid=s.guid JOIN models m ON s.modelGuid=m.guid
          WHERE r.isDeleted=0 ORDER BY r.returnDate DESC
        `;
        filename = "returns";
        break;

      default:
        return res.status(400).json({ message: "Invalid export type" });
    }

    const [data] = await mysqlPool.query(query, params);
    if (!data.length) return res.status(404).json({ message: "No data to export" });

    if (format === "csv") {
      const headers = Object.keys(data[0]).join(",");
      const rows = data.map((row) => Object.values(row).map((v) => `"${v ?? ""}"`).join(","));
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename=${filename}.csv`);
      return res.send([headers, ...rows].join("\n"));
    }

    res.json(data);
  } catch (err) {
    console.error("[export] GET /:type:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

module.exports = router;
