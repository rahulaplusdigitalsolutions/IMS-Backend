const router = require("express").Router();
const { mysqlPool } = require("../db");

router.get("/inventory", async (req, res) => {
  try {
    const [rows] = await mysqlPool.query(`
      SELECT m.name as modelName, m.company as companyName, m.category,
        COUNT(s.guid) as totalSerials,
        SUM(CASE WHEN s.status='Available' THEN 1 ELSE 0 END) as availableSerials,
        SUM(CASE WHEN s.status='Dispatched' THEN 1 ELSE 0 END) as dispatchedSerials,
        SUM(CASE WHEN s.status='Damaged' THEN 1 ELSE 0 END) as damagedSerials,
        AVG(s.landingPrice) as avgLandingPrice, m.stockQuantity
      FROM models m LEFT JOIN serials s ON m.guid=s.modelGuid AND s.isDeleted=0
      WHERE m.isDeleted=0 GROUP BY m.guid, m.name, m.company, m.category, m.stockQuantity ORDER BY m.name
    `);
    res.json(rows);
  } catch (err) {
    console.error("[reports] inventory:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

router.get("/sales", async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    let q = `
      SELECT o.dispatchDate, o.platform AS firmName, o.orderid as customer,
             oi.sellingPrice, s.landingPrice, m.name as modelName, m.company as companyName,
             s.value as serialNumber, ins.installationRequired, ins.installationCharges,
             o.packagingCost, o.commission, o.status
      FROM order_items oi JOIN orders o ON oi.orderGuid=o.guid
      LEFT JOIN order_installations ins ON o.guid=ins.orderGuid
      LEFT JOIN serials s ON oi.serialNumberGuid=s.guid LEFT JOIN models m ON s.modelGuid=m.guid
      WHERE o.isDeleted=0
    `;
    const params = [];
    if (startDate && endDate) { q += " AND o.dispatchDate>=? AND o.dispatchDate<=?"; params.push(`${startDate.split("T")[0]} 00:00:00`, `${endDate.split("T")[0]} 23:59:59`); }
    q += " ORDER BY o.dispatchDate DESC";
    const [sales] = await mysqlPool.query(q, params);

    const isInstall = (i) => i.installationRequired === 1 || i.installationRequired === "Yes" || i.installationRequired === true || i.installationRequired === "true";
    const summary = {
      totalSales: sales.length,
      totalRevenue: sales.reduce((s, r) => s + (Number(r.sellingPrice) || 0), 0),
      totalCost: sales.reduce((s, r) => s + (Number(r.landingPrice) || 0) + (Number(r.packagingCost) || 0) + (Number(r.commission) || 0), 0),
      totalProfit: sales.reduce((s, r) => s + ((Number(r.sellingPrice) || 0) - (Number(r.landingPrice) || 0) - (Number(r.packagingCost) || 0) - (Number(r.commission) || 0)), 0),
      totalInstallationCharges: sales.reduce((s, r) => isInstall(r) ? s + (Number(r.installationCharges) || 0) : s, 0),
    };
    res.json({ summary, sales });
  } catch (err) {
    console.error("[reports] sales:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

router.get("/installations", async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    let q = `
      SELECT oi.guid, o.dispatchDate, o.platform AS firmName, o.orderid as customer,
             m.name as modelName, s.value as serialNumber,
             ins.installationStatus, ins.installationCharges, ins.installationRemarks,
             ins.scheduledDate, ins.installationDate, ins.technicianName, ins.technicianContact
      FROM order_items oi JOIN orders o ON oi.orderGuid=o.guid
      LEFT JOIN order_installations ins ON o.guid=ins.orderGuid
      LEFT JOIN serials s ON oi.serialNumberGuid=s.guid LEFT JOIN models m ON s.modelGuid=m.guid
      WHERE (ins.installationRequired='Yes' OR ins.installationRequired='true' OR ins.installationRequired='1') AND o.isDeleted=0
    `;
    const params = [];
    if (startDate && endDate) { q += " AND o.dispatchDate>=? AND o.dispatchDate<=?"; params.push(`${startDate.split("T")[0]} 00:00:00`, `${endDate.split("T")[0]} 23:59:59`); }
    q += " ORDER BY o.dispatchDate DESC";
    const [installations] = await mysqlPool.query(q, params);

    const summary = { total: installations.length };
    for (const s of ["Pending", "Scheduled", "In Progress", "Completed", "Cancelled"]) {
      summary[s.replace(" ", "")] = installations.filter((i) => i.installationStatus === s).length;
    }
    summary.totalCharges = installations.reduce((s, i) => s + (Number(i.installationCharges) || 0), 0);
    res.json({ summary, installations });
  } catch (err) {
    console.error("[reports] installations:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

router.get("/", async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const sDate = startDate ? startDate.split("T")[0] : null;
    const eDate = endDate ? endDate.split("T")[0] : null;

    const buildWhere = (base, col, prefix) => {
      const params = [];
      let w = base;
      if (sDate && eDate) { w += ` AND ${col} BETWEEN ? AND ?`; params.push(`${prefix ? sDate + " 00:00:00" : sDate}`, `${prefix ? eDate + " 23:59:59" : eDate}`); }
      return { w, params };
    };

    const s1 = buildWhere(" WHERE s.isDeleted=0", "s.invoiceDate", false);
    const [stationeryRows] = await mysqlPool.query(`
      SELECT s.stockInId as _id, s.invoiceNo as orderId, s.invoiceDate as dispatchDate,
             'Stock In' as status, IF(s.status=1,'Finalized','Draft') as logisticsStatus,
             0 as sellingPrice, SUM(d.purchaseRate*d.stockInQty*d.defaultPcsQty) as landingPrice,
             v.vendorFirmName as firmName, 'Inventory Inward' as customerName,
             GROUP_CONCAT(DISTINCT IFNULL(i.itemName,m.name) SEPARATOR ', ') as modelName,
             'NA' as serialValue, 'Stationery' as category, s.invoiceFile
      FROM inventorystockin s
      JOIN inventorystockindetail d ON s.stockInId=d.stockInId
      LEFT JOIN inventoryvendor v ON s.vendorId=v.vendorId
      LEFT JOIN inventoryitemvariant iv ON d.itemVariantId=iv.itemVariantId
      LEFT JOIN inventoryitemmaster i ON iv.itemId=i.itemId
      LEFT JOIN models m ON d.modelGuid=m.guid
      ${s1.w} GROUP BY s.stockInId,v.vendorFirmName,s.invoiceNo,s.invoiceDate,s.status,s.invoiceFile
    `, s1.params);

    const s2 = buildWhere(" WHERE o.isDeleted=0", "o.dispatchDate", true);
    const [printerRows] = await mysqlPool.query(`
      SELECT oi.guid as _id, o.invoiceNumber as orderId, o.dispatchDate,
             o.status, ol.logisticsStatus, oi.sellingPrice, s.landingPrice,
             o.platform AS firmName, o.orderid AS customerName, m.name as modelName, s.value as serialValue,
             'Printers' as category, o.invoiceFilename as invoiceFile, o.ewayBillFilename as ewayBillFile
      FROM order_items oi JOIN orders o ON oi.orderGuid=o.guid
      LEFT JOIN order_logistics ol ON o.guid=ol.orderGuid
      LEFT JOIN serials s ON oi.serialNumberGuid=s.guid LEFT JOIN models m ON s.modelGuid=m.guid
      ${s2.w}
    `, s2.params);

    const s3 = buildWhere(" WHERE s.isDeleted=0", "s.createdAt", true);
    const [stockInRows] = await mysqlPool.query(`
      SELECT s.guid as _id, IFNULL(st.invoiceNo,'Stock In') as orderId, s.createdAt as dispatchDate,
             'Stock In' as status, 'Finalized' as logisticsStatus,
             0 as sellingPrice, s.landingPrice, IFNULL(v.vendorFirmName,'Internal') as firmName,
             'Inventory Inward' as customerName, m.name as modelName, s.value as serialValue,
             'Printers' as category, MAX(st.invoiceFile) as invoiceFile
      FROM serials s LEFT JOIN models m ON s.modelGuid=m.guid
      LEFT JOIN inventorystockinserial s_in ON s.value=s_in.serialNumber AND s_in.isDeleted=0
      LEFT JOIN inventorystockindetail st_d ON s_in.stockInDetailId=st_d.stockInDetailId
      LEFT JOIN inventorystockin st ON st_d.stockInId=st.stockInId
      LEFT JOIN inventoryvendor v ON st.vendorId=v.vendorId
      ${s3.w} GROUP BY s.guid,s.createdAt,s.landingPrice,m.name,s.value,st.invoiceNo,v.vendorFirmName
    `, s3.params);

    const s4 = buildWhere(" WHERE o.isDeleted=0", "o.issueDate", true);
    const [stockOutRows] = await mysqlPool.query(`
      SELECT o.stockOutId as _id, COALESCE(o.orderId,o.refNo) as orderId, o.issueDate as dispatchDate,
             'Stock Out' as status, 'Finalized' as logisticsStatus,
             COALESCE(NULLIF(o.sellingPrice,0),SUM(d.sellingPrice)) as sellingPrice,
             SUM(IFNULL(ivs.lastPurchaseRate,IFNULL(ivs.avgPurchaseRate,0))*d.issueQty) as landingPrice,
             o.platformId as firmName, o.issuedBy as customerName,
             'Multiple Items' as modelName, 'NA' as serialValue, 'Stationery' as category,
             o.packingCost as packing, o.freightCost as freight, o.commission,
             o.invoiceFile
      FROM inventorystockout o JOIN inventorystockoutdetail d ON o.stockOutId=d.stockOutId
      LEFT JOIN inventoryvariantstock ivs ON d.itemVariantId=ivs.itemVariantId
      ${s4.w}
      GROUP BY o.stockOutId,o.orderId,o.refNo,o.issueDate,o.platformId,o.issuedBy,o.packingCost,o.freightCost,o.commission,o.sellingPrice,o.invoiceFile
    `, s4.params);

    const [statStock] = await mysqlPool.query(
      "SELECT SUM(availablePCS*IFNULL(NULLIF(lastPurchaseRate,0),IFNULL(avgPurchaseRate,0))) as total FROM inventoryvariantstock ivs JOIN inventoryitemvariant iv ON ivs.itemVariantId=iv.itemVariantId WHERE iv.isDeleted=0"
    );
    const [printStock] = await mysqlPool.query("SELECT SUM(IFNULL(landingPrice,0)) as total FROM serials WHERE status='Available' AND isDeleted=0");

    const transactions = [...stationeryRows, ...printerRows, ...stockInRows, ...stockOutRows].sort((a, b) => new Date(b.dispatchDate) - new Date(a.dispatchDate));
    res.json({
      transactions,
      stockSummary: {
        total: Number(statStock[0]?.total || 0) + Number(printStock[0]?.total || 0),
        printer: Number(printStock[0]?.total || 0),
        stationery: Number(statStock[0]?.total || 0),
      },
    });
  } catch (err) {
    console.error("[reports] GET /:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

module.exports = router;
