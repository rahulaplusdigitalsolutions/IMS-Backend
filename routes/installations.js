const router = require("express").Router();
const { mysqlPool } = require("../db");
const { mapDispatchRow } = require("../helpers");

const SELECT_INSTALLATION = `
  SELECT oi.guid as id, oi.serialNumberGuid as serialNumberId, oi.modelGuid as modelId,
    oi.sellingPrice, oi.warranty, oi.quantity, oi.contractFilename,
    o.guid as _orderId, o.orderid, o.platform, o.orderDate, o.dispatchDate, o.dispatchedBy, o.status,
    o.gemOrderType, o.bidNumber, o.customerName as customer, o.consigneeName, o.buyerEmail, o.consigneeEmail,
    o.paymentAuthorityEmail, o.shippingAddress, o.address, o.gstNumber, o.contactNumber, o.altContactNumber,
    o.invoiceNumber, o.invoiceFilename, o.ewayBillNumber, o.ewayBillFilename, o.gemBillUploaded,
    o.freightCharges, o.packagingCost, o.commission, o.orderVerified,
    oi.remarks AS remarks, o.remarks AS orderRemarks, o.cancellationReason as cancelReason,
    o.cancelledBy, o.cancelledAt, o.isDeleted, o.rowColor, o.tags,
    ol.courierPartner, ol.trackingId, ol.logisticsStatus, ol.logisticsDispatchDate, ol.podFilename, ol.lastDeliveryDate,
    ins.installationRequired, ins.installationStatus, ins.technicianName, ins.technicianContact,
    ins.installationCharges, ins.installationRemarks, ins.scheduledDate, ins.installationDate,
    s.value as serialValue, m.name as modelName, m.company as companyName
  FROM order_items oi
  JOIN orders o ON oi.orderGuid=o.guid
  LEFT JOIN order_logistics ol ON o.guid=ol.orderGuid
  LEFT JOIN order_installations ins ON o.guid=ins.orderGuid
  LEFT JOIN serials s ON oi.serialNumberGuid=s.guid
  LEFT JOIN models m ON s.modelGuid=m.guid
`;

const INSTALL_REQUIRED_CONDITION = "(ins.installationRequired='Yes' OR ins.installationRequired='true' OR ins.installationRequired='1')";

router.get("/stats", async (req, res) => {
  try {
    const [rows] = await mysqlPool.query(`
      SELECT COUNT(oi.guid) as total,
        SUM(CASE WHEN ins.installationStatus='Pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN ins.installationStatus='Scheduled' THEN 1 ELSE 0 END) as scheduled,
        SUM(CASE WHEN ins.installationStatus='In Progress' THEN 1 ELSE 0 END) as inProgress,
        SUM(CASE WHEN ins.installationStatus='Completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN ins.installationStatus='Cancelled' THEN 1 ELSE 0 END) as cancelled,
        SUM(IFNULL(ins.installationCharges,0)) as totalCharges
      FROM order_items oi JOIN orders o ON oi.orderGuid=o.guid
      JOIN order_installations ins ON o.guid=ins.orderGuid
      WHERE ${INSTALL_REQUIRED_CONDITION} AND o.isDeleted=0
    `);
    res.json(rows[0]);
  } catch (err) {
    console.error("[installations] stats:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

router.put("/bulk/update", async (req, res) => {
  try {
    const { ids, updates } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ message: "No IDs provided" });
    const { technicianName, technicianContact, installationStatus, scheduledDate } = updates;

    for (const id of ids) {
      const [itemRows] = await mysqlPool.query("SELECT orderGuid FROM order_items WHERE guid=?", [id]);
      if (!itemRows.length) continue;
      const clauses = [], params = [];
      if (technicianName !== undefined) { clauses.push("technicianName=?"); params.push(technicianName); }
      if (technicianContact !== undefined) { clauses.push("technicianContact=?"); params.push(technicianContact); }
      if (installationStatus !== undefined) { clauses.push("installationStatus=?"); params.push(installationStatus); }
      if (scheduledDate !== undefined) { clauses.push("scheduledDate=?"); params.push(new Date(scheduledDate)); }
      if (clauses.length) { params.push(itemRows[0].orderGuid); await mysqlPool.query(`UPDATE order_installations SET ${clauses.join(",")} WHERE orderGuid=?`, params); }
    }
    res.json({ message: `${ids.length} installations updated` });
  } catch (err) {
    console.error("[installations] bulk update:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

router.get("/", async (req, res) => {
  try {
    const [rows] = await mysqlPool.query(`
      ${SELECT_INSTALLATION}
      WHERE ${INSTALL_REQUIRED_CONDITION} AND o.isDeleted=0
      ORDER BY CASE WHEN ins.installationStatus='Pending' THEN 1 WHEN ins.installationStatus='Scheduled' THEN 2 WHEN ins.installationStatus='In Progress' THEN 3 WHEN ins.installationStatus='Completed' THEN 4 ELSE 5 END, o.dispatchDate DESC
    `);
    res.json(rows.map(mapDispatchRow));
  } catch (err) {
    console.error("[installations] GET /:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const [rows] = await mysqlPool.query(`
      ${SELECT_INSTALLATION}
      WHERE oi.guid=? AND ${INSTALL_REQUIRED_CONDITION}
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: "Installation not found" });
    res.json(mapDispatchRow(rows[0]));
  } catch (err) {
    console.error("[installations] GET /:id:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { technicianName, technicianContact, installationStatus, installationCharges, installationRemarks, scheduledDate, installationDate } = req.body;

    const [cur] = await mysqlPool.query("SELECT ins.*, oi.orderGuid FROM order_items oi LEFT JOIN order_installations ins ON oi.orderGuid=ins.orderGuid WHERE oi.guid=?", [id]);
    if (!cur.length) return res.status(404).json({ message: "Installation not found" });
    const c = cur[0];

    let finalInstallDate = installationDate !== undefined ? new Date(installationDate) : c.installationDate;
    if (installationStatus === "Completed" && !finalInstallDate) finalInstallDate = new Date();

    await mysqlPool.query(
      "UPDATE order_installations SET technicianName=?,technicianContact=?,installationStatus=?,installationCharges=?,installationRemarks=?,scheduledDate=?,installationDate=? WHERE orderGuid=?",
      [technicianName ?? c.technicianName, technicianContact ?? c.technicianContact,
        installationStatus ?? c.installationStatus, installationCharges ?? c.installationCharges,
        installationRemarks ?? c.installationRemarks,
        scheduledDate !== undefined ? new Date(scheduledDate) : c.scheduledDate,
        finalInstallDate, c.orderGuid]
    );
    res.json({ message: "Installation updated successfully" });
  } catch (err) {
    console.error("[installations] PUT /:id:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

module.exports = router;
