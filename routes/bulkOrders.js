const { randomUUID } = require("crypto");
const router = require("express").Router();
const { mysqlPool } = require("../db");
const { requireAuth } = require("../middleware/auth");

router.post("/", requireAuth, async (req, res) => {
  let conn;
  try {
    const { customerName, firmName, totalAmount, serialIds, invoice, dispatch } = req.body;
    conn = await mysqlPool.getConnection();
    await conn.beginTransaction();
    try {
      const orderGuid = randomUUID();
      await conn.query(
        "INSERT INTO bulkorders (guid,orderid,platform,totalAmount,createdBy,status) VALUES (?,?,?,?,?,'Pending')",
        [orderGuid, customerName, firmName, totalAmount || 0, req.user?.username || "System"]
      );
      for (const sId of serialIds) {
        await conn.query("INSERT INTO bulkorderitems (orderGuid,serialNumberGuid,itemStatus) VALUES (?,?,'Active')", [orderGuid, sId]);
        await conn.query("UPDATE serials SET status='Dispatched' WHERE guid=?", [sId]);
      }
      if (invoice?.invoiceNumber) await conn.query("INSERT INTO bulkorderinvoices (orderGuid,invoiceNumber,ewayBillNumber) VALUES (?,?,?)", [orderGuid, invoice.invoiceNumber, invoice.ewayBillNumber || null]);
      if (dispatch?.trackingId) await conn.query("INSERT INTO bulkorderdispatches (orderGuid,trackingId,courierPartner,logisticsStatus) VALUES (?,?,?,'Dispatched')", [orderGuid, dispatch.trackingId, dispatch.courierPartner || null]);
      await conn.commit();
      res.status(201).json({ message: "Bulk order created successfully", orderId: orderGuid });
    } catch (e) { await conn.rollback(); throw e; }
  } catch (err) {
    if (conn) await conn.rollback();
    console.error("[bulkOrders] POST /:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  } finally { if (conn) conn.release(); }
});

router.post("/:id/replace", requireAuth, async (req, res) => {
  let conn;
  try {
    const { id } = req.params;
    const { replacements, invoice, dispatch, reason } = req.body;
    conn = await mysqlPool.getConnection();
    await conn.beginTransaction();
    try {
      for (const rep of replacements) {
        await conn.query("UPDATE serials SET status='Available' WHERE guid=?", [rep.oldSerialId]);
        await conn.query("UPDATE serials SET status='Dispatched' WHERE guid=?", [rep.newSerialId]);
        await conn.query("UPDATE bulkorderitems SET itemStatus='Replaced' WHERE orderGuid=? AND serialNumberGuid=? AND itemStatus='Active'", [id, rep.oldSerialId]);
        await conn.query("INSERT INTO bulkorderitems (orderGuid,serialNumberGuid,itemStatus) VALUES (?,?,'Active')", [id, rep.newSerialId]);
        await conn.query("INSERT INTO replacementhistory (orderGuid,oldSerialId,newSerialId,reason,replacedBy) VALUES (?,?,?,?,?)", [id, rep.oldSerialId, rep.newSerialId, reason || "Replaced", req.user?.username || "System"]);
      }
      if (invoice?.invoiceNumber) await conn.query("INSERT INTO bulkorderinvoices (orderGuid,invoiceNumber,ewayBillNumber) VALUES (?,?,?)", [id, invoice.invoiceNumber, invoice.ewayBillNumber || null]);
      if (dispatch?.trackingId) await conn.query("INSERT INTO bulkorderdispatches (orderGuid,trackingId,courierPartner,logisticsStatus) VALUES (?,?,?,'Dispatched')", [id, dispatch.trackingId, dispatch.courierPartner || null]);
      await conn.commit();
      res.json({ message: "Replacement processed successfully" });
    } catch (e) { await conn.rollback(); throw e; }
  } catch (err) {
    if (conn) await conn.rollback();
    console.error("[bulkOrders] replace:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  } finally { if (conn) conn.release(); }
});

router.post("/:id/payment", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { amount, utrId, paymentDate } = req.body;
    await mysqlPool.query("INSERT INTO bulkorderpayments (orderGuid,amount,utrId,paymentDate) VALUES (?,?,?,?)", [id, amount, utrId, paymentDate ? new Date(paymentDate) : new Date()]);
    await mysqlPool.query("UPDATE bulkorders SET status='Completed' WHERE guid=?", [id]);
    res.json({ message: "Consolidated payment recorded successfully" });
  } catch (err) {
    console.error("[bulkOrders] payment:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

router.get("/:id/consolidated", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const [[order]] = await mysqlPool.query("SELECT *, orderid as customerName, platform as firmName FROM bulkorders WHERE guid=?", [id]);
    const [serials] = await mysqlPool.query("SELECT boi.*, s.value as serialValue, m.name as modelName FROM bulkorderitems boi JOIN serials s ON boi.serialNumberGuid=s.guid JOIN models m ON s.modelGuid=m.guid WHERE boi.orderGuid=? ORDER BY boi.addedAt ASC", [id]);
    const [replacements] = await mysqlPool.query("SELECT r.*, oldS.value as oldSerial, newS.value as newSerial FROM replacementhistory r JOIN serials oldS ON r.oldSerialId=oldS.guid JOIN serials newS ON r.newSerialId=newS.guid WHERE r.orderGuid=? ORDER BY r.createdAt ASC", [id]);
    const [invoices] = await mysqlPool.query("SELECT * FROM bulkorderinvoices WHERE orderGuid=? ORDER BY createdAt ASC", [id]);
    const [dispatches] = await mysqlPool.query("SELECT * FROM bulkorderdispatches WHERE orderGuid=? ORDER BY dispatchDate ASC", [id]);
    const [payments] = await mysqlPool.query("SELECT * FROM bulkorderpayments WHERE orderGuid=? ORDER BY createdAt ASC", [id]);
    res.json({ order, serials, replacements, invoices, dispatches, payments });
  } catch (err) {
    console.error("[bulkOrders] consolidated:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

module.exports = router;
