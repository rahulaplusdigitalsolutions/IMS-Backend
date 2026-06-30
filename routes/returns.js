const { randomUUID } = require("crypto");
const router = require("express").Router();
const { mysqlPool } = require("../db");
const { mapDispatchRow, recordSerialMovement } = require("../helpers");

router.get("/lookup", async (req, res) => {
  try {
    const raw = req.query.serialValue || req.query.serialNumber || req.query.serial;
    if (!raw) return res.status(400).json({ message: "Serial number is required" });
    const normalized = raw.trim().toUpperCase();

    const [serials] = await mysqlPool.query(`
      SELECT s.*, m.name as modelName, m.company as companyName,
             lr.reason as latestReturnReason, lr.condition as latestReturnCondition
      FROM serials s LEFT JOIN models m ON s.modelGuid=m.guid
      LEFT JOIN (
        SELECT r1.serialNumberGuid, r1.reason, r1.condition FROM returns r1
        JOIN (SELECT serialNumberGuid, MAX(returnDate) as maxDate, MAX(guid) as maxId FROM returns WHERE isDeleted=0 GROUP BY serialNumberGuid) r2
        ON r1.serialNumberGuid=r2.serialNumberGuid AND r1.returnDate=r2.maxDate AND r1.guid=r2.maxId
      ) lr ON s.guid=lr.serialNumberGuid
      WHERE s.value=? AND s.isDeleted=0
    `, [normalized]);

    if (!serials.length) return res.status(404).json({ message: "Serial not found" });
    const serial = serials[0];

    const [dispatches] = await mysqlPool.query(`
      SELECT oi.guid, oi.serialNumberGuid, oi.modelGuid, oi.sellingPrice, oi.warranty, oi.quantity, oi.contractFilename,
             o.guid as _orderId, o.orderid, o.platform, o.orderDate, o.dispatchDate, o.dispatchedBy, o.status,
             o.gemOrderType, o.bidNumber, o.customerName as customer, o.consigneeName, o.buyerEmail, o.consigneeEmail,
             o.paymentAuthorityEmail, o.shippingAddress, o.address, o.gstNumber, o.contactNumber, o.altContactNumber,
             o.invoiceNumber, o.invoiceFilename, o.ewayBillNumber, o.ewayBillFilename, o.gemBillUploaded,
             o.freightCharges, o.packagingCost, o.commission, o.orderVerified, o.remarks, o.cancellationReason as cancelReason,
             o.cancelledBy, o.cancelledAt, o.isDeleted, o.rowColor, o.tags,
             ol.courierPartner, ol.trackingId, ol.logisticsStatus, ol.logisticsDispatchDate, ol.podFilename, ol.lastDeliveryDate,
             ins.installationRequired, ins.installationStatus, ins.technicianName, ins.technicianContact,
             ins.installationCharges, ins.installationRemarks, ins.scheduledDate, ins.installationDate,
             m.name as modelName, s.value as serialValue
      FROM order_items oi JOIN orders o ON oi.orderGuid=o.guid
      JOIN serials s ON oi.serialNumberGuid=s.guid JOIN models m ON s.modelGuid=m.guid
      LEFT JOIN order_logistics ol ON o.guid=ol.orderGuid LEFT JOIN order_installations ins ON o.guid=ins.orderGuid
      WHERE oi.serialNumberGuid=? AND o.isDeleted=0
      ORDER BY o.dispatchDate DESC, oi.guid DESC LIMIT 1
    `, [serial.guid]);

    const linkedOrder = dispatches[0] || null;
    let existingReturn = null;
    if (linkedOrder) {
      const [ret] = await mysqlPool.query("SELECT * FROM returns WHERE serialNumberGuid=? AND dispatchGuid=? AND isDeleted=0 ORDER BY returnDate DESC, guid DESC LIMIT 1", [serial.guid, linkedOrder.guid]);
      existingReturn = ret[0] || null;
    }

    res.json({
      ...serial,
      canReturn: serial.status === "Dispatched" && !!linkedOrder && !existingReturn,
      linkedOrder: linkedOrder ? mapDispatchRow(linkedOrder) : null,
      existingReturnForLinkedOrder: existingReturn,
      smartWarning: serial.returnCount > 0
        ? `This serial was previously returned${serial.latestReturnReason ? ` (Reason: ${serial.latestReturnReason})` : ""}.`
        : null,
    });
  } catch (err) {
    console.error("[returns] lookup:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

router.get("/", async (req, res) => {
  try {
    const [printerRows] = await mysqlPool.query(`
      SELECT r.guid as id, r.serialNumberGuid as serialNumberId,
             COALESCE(NULLIF(r.serialValue,''), s.value, '') as serialValue,
             r.condition, r.returnDate, r.returnedBy, r.platform AS firmName, r.orderid AS customerName,
             r.reason, r.repairCost, r.returnCount, r.dispatchGuid, m.name as modelName,
             0 as refundAmount, r.rowColor, r.tags
      FROM returns r LEFT JOIN serials s ON r.serialNumberGuid=s.guid LEFT JOIN models m ON s.modelGuid=m.guid
      WHERE r.isDeleted=0
    `);
    const [stationeryRows] = await mysqlPool.query(`
      SELECT r.returnId as id, r.stockOutId as dispatchId, r.originalItemSent as serialValue,
             IF(r.isConditionCorrect=1,'Correct','Damaged') as \`condition\`,
             r.createdAt as returnDate, r.createdBy as returnedBy,
             o.platformId as firmName, COALESCE(o.orderId,o.issuedBy,'Unknown') as customerName,
             r.compensationAmount as refundAmount, r.remarks as reason,
             'Stationery' as modelName, 0 as repairCost, 1 as returnCount, r.rowColor, r.tags
      FROM inventorystationeryreturns r LEFT JOIN inventorystockout o ON r.stockOutId=o.stockOutId
      WHERE r.isDeleted=0
    `);
    const all = [...printerRows, ...stationeryRows].sort((a, b) => new Date(b.returnDate) - new Date(a.returnDate));
    res.json(all);
  } catch (err) {
    console.error("[returns] GET /:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

router.post("/", async (req, res) => {
  let conn;
  try {
    const { serialNumber, serialValue, condition, returnDate, returnedBy, dispatchId, reason } = req.body;
    const trimmed = String(serialNumber || serialValue || "").trim();
    if (!trimmed) return res.status(400).json({ message: "Serial number is required" });

    conn = await mysqlPool.getConnection();
    await conn.beginTransaction();

    const [serialCheck] = await conn.query(
      "SELECT s.guid, s.status, s.modelGuid, s.value as serialValue, s.returnCount, m.name as modelName FROM serials s JOIN models m ON s.modelGuid=m.guid WHERE UPPER(s.value)=? AND s.isDeleted=0 FOR UPDATE",
      [trimmed.toUpperCase()]
    );
    if (!serialCheck.length) { await conn.rollback(); return res.status(404).json({ message: `Serial number "${trimmed}" not found` }); }
    const serial = serialCheck[0];
    if (serial.status !== "Dispatched") { await conn.rollback(); return res.status(400).json({ message: `Cannot return: Item status is "${serial.status}"` }); }

    const VALID_CONDITIONS = ["Good", "InStock", "Damaged"];
    const rawCondition = condition || "Good";
    if (!VALID_CONDITIONS.includes(rawCondition)) { await conn.rollback(); return res.status(400).json({ message: `Invalid condition. Must be one of: ${VALID_CONDITIONS.join(", ")}` }); }
    let finalCondition = rawCondition;
    let newStatus = "Available";
    if (finalCondition === "InStock" || finalCondition === "Good") { finalCondition = "Good"; newStatus = "Available"; }
    else if (finalCondition === "Damaged") { newStatus = "Damaged"; }

    let dQuery = `SELECT oi.guid, o.dispatchDate, o.platform AS firmName, o.orderid AS customerName, o.invoiceNumber, o.status as orderStatus, ol.logisticsStatus
      FROM order_items oi JOIN orders o ON oi.orderGuid=o.guid LEFT JOIN order_logistics ol ON o.guid=ol.orderGuid
      WHERE oi.serialNumberGuid=? AND o.isDeleted=0 AND o.status NOT IN ('Returned','Order Cancelled','Partially Returned')`;
    const dParams = [serial.guid];
    if (dispatchId) { dQuery += " AND oi.guid=?"; dParams.push(dispatchId); }
    dQuery += " ORDER BY o.dispatchDate DESC, oi.guid DESC LIMIT 1";

    const [dispatchInfo] = await conn.query(dQuery, dParams);
    const dispatch = dispatchInfo[0] || null;
    if (!dispatch?.guid) { await conn.rollback(); return res.status(400).json({ message: "No linked order found for this serial" }); }

    const [dupCheck] = await conn.query("SELECT guid FROM returns WHERE serialNumberGuid=? AND dispatchGuid=? AND isDeleted=0 LIMIT 1", [serial.guid, dispatch.guid]);
    if (dupCheck.length > 0) { await conn.rollback(); return res.status(400).json({ message: `Return already recorded for order #${dispatch.guid}` }); }

    const [countCheck] = await conn.query("SELECT COUNT(*) as total FROM returns WHERE serialNumberGuid=? AND isDeleted=0", [serial.guid]);
    const returnCount = (countCheck[0].total || 0) + 1;

    const returnGuid = randomUUID();
    await conn.query(
      "INSERT INTO returns (guid,serialNumberGuid,serialValue,`condition`,returnDate,returnedBy,platform,orderid,returnCount,isDeleted,dispatchGuid,invoiceNumber,reason) VALUES (?,?,?,?,?,?,?,?,?,0,?,?,?)",
      [returnGuid, serial.guid, trimmed, finalCondition, returnDate ? new Date(returnDate) : new Date(), returnedBy || "System",
        dispatch.firmName || null, dispatch.customerName || null, returnCount, dispatch.guid, dispatch.invoiceNumber || null, String(reason || "").trim()]
    );

    await conn.query("UPDATE serials SET status=?, returnCount=? WHERE guid=?", [newStatus, returnCount, serial.guid]);

    const [itemCheck] = await conn.query("SELECT orderGuid FROM order_items WHERE guid=?", [dispatch.guid]);
    if (itemCheck.length) {
      const orderGuid = itemCheck[0].orderGuid;
      const [total] = await conn.query("SELECT COUNT(*) as total FROM order_items WHERE orderGuid=?", [orderGuid]);
      const [returned] = await conn.query("SELECT COUNT(DISTINCT serialNumberGuid) as total FROM returns WHERE dispatchGuid IN (SELECT guid FROM order_items WHERE orderGuid=?) AND isDeleted=0", [orderGuid]);
      const newOrderStatus = returned[0].total >= total[0].total ? "Returned" : "Partially Returned";
      await conn.query("UPDATE orders SET status=? WHERE guid=?", [newOrderStatus, orderGuid]);
    }

    await recordSerialMovement(conn, { serialNumberGuid: serial.guid, serialValue: serial.serialValue, dispatchGuid: dispatch.guid, actionType: "Returned", status: "Returned", condition: finalCondition, reason: String(reason || "").trim(), firmName: dispatch.firmName, customerName: dispatch.customerName, invoiceNumber: dispatch.invoiceNumber, createdAt: returnDate || new Date(), createdBy: returnedBy || "System", notes: `Returned from order #${dispatch.guid}` });
    await recordSerialMovement(conn, { serialNumberGuid: serial.guid, serialValue: serial.serialValue, dispatchGuid: null, actionType: finalCondition === "Damaged" ? "Damaged" : "InStock", status: newStatus, condition: finalCondition, reason: String(reason || "").trim(), firmName: dispatch.firmName, customerName: dispatch.customerName, invoiceNumber: dispatch.invoiceNumber, createdAt: returnDate ? new Date(new Date(returnDate).getTime() + 1000) : new Date(), createdBy: returnedBy || "System", notes: finalCondition === "Damaged" ? "Moved to damaged stock after return" : "Restocked after return" });

    await conn.commit();
    res.status(201).json({ message: "Return processed successfully", id: returnGuid, serialValue: trimmed, condition: finalCondition, status: newStatus, dispatchId: dispatch.guid, invoiceNumber: dispatch.invoiceNumber, reason: String(reason || "").trim() });
  } catch (err) {
    if (conn) await conn.rollback();
    console.error("[returns] POST /:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  } finally { if (conn) conn.release(); }
});

router.put("/:id/appearance", async (req, res) => {
  try {
    const { rowColor, tags } = req.body;
    await mysqlPool.query("UPDATE returns SET rowColor=?, tags=? WHERE guid=?", [rowColor || null, tags || null, req.params.id]);
    res.json({ message: "Appearance updated successfully" });
  } catch (err) {
    console.error("[returns] appearance:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { condition, repairCost, reason } = req.body;
    const [existing] = await mysqlPool.query(`
      SELECT r.guid, r.serialNumberGuid, s.value as serialValue, r.condition, r.reason,
             r.platform AS firmName, r.orderid AS customerName, r.invoiceNumber, r.dispatchGuid
      FROM returns r LEFT JOIN serials s ON s.guid=r.serialNumberGuid WHERE r.guid=?
    `, [id]);
    if (!existing.length) return res.status(404).json({ message: "Return not found" });
    const ext = existing[0];

    const setClauses = [], params = [];
    if (condition !== undefined) { setClauses.push("`condition`=?"); params.push(condition); }
    if (repairCost !== undefined) { setClauses.push("repairCost=?"); params.push(repairCost); }
    if (reason !== undefined) { setClauses.push("reason=?"); params.push(reason); }

    if (setClauses.length) { params.push(id); await mysqlPool.query(`UPDATE returns SET ${setClauses.join(",")} WHERE guid=?`, params); }

    if (condition !== undefined) {
      const newStatus = ["Repaired", "Good", "InStock"].includes(condition) ? "Available" : "Damaged";
      await mysqlPool.query("UPDATE serials SET status=? WHERE guid=?", [newStatus, ext.serialNumberGuid]);
      await recordSerialMovement(mysqlPool, { serialNumberGuid: ext.serialNumberGuid, serialValue: ext.serialValue, dispatchGuid: ext.dispatchGuid, actionType: newStatus === "Available" ? "InStock" : "Damaged", status: newStatus, condition, reason: reason !== undefined ? reason : ext.reason, firmName: ext.firmName, customerName: ext.customerName, invoiceNumber: ext.invoiceNumber, createdBy: "System", notes: `Inventory status updated from return #${id}` });
    }

    res.json({ message: "Return updated successfully" });
  } catch (err) {
    console.error("[returns] PUT /:id:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const [check] = await mysqlPool.query(`
      SELECT r.guid, r.serialNumberGuid, COALESCE(NULLIF(r.serialValue,''),s.value,'') as serialValue,
             r.condition, r.reason, r.platform AS firmName, r.orderid AS customerName, r.invoiceNumber, r.dispatchGuid
      FROM returns r LEFT JOIN serials s ON s.guid=r.serialNumberGuid WHERE r.guid=? LIMIT 1
    `, [id]);
    if (!check.length) return res.status(404).json({ message: "Return not found" });
    const rec = check[0];

    await mysqlPool.query("UPDATE returns SET isDeleted=1 WHERE guid=?", [id]);
    const [cnt] = await mysqlPool.query("SELECT COUNT(*) as total FROM returns WHERE serialNumberGuid=? AND isDeleted=0", [rec.serialNumberGuid]);
    await mysqlPool.query("UPDATE serials SET status='Dispatched', returnCount=? WHERE guid=?", [cnt[0].total, rec.serialNumberGuid]);

    if (rec.dispatchGuid) {
      const [item] = await mysqlPool.query("SELECT orderGuid FROM order_items WHERE guid=?", [rec.dispatchGuid]);
      if (item.length) {
        const og = item[0].orderGuid;
        const [tot] = await mysqlPool.query("SELECT COUNT(*) as total FROM order_items WHERE orderGuid=?", [og]);
        const [ret] = await mysqlPool.query("SELECT COUNT(DISTINCT serialNumberGuid) as total FROM returns WHERE dispatchGuid IN (SELECT guid FROM order_items WHERE orderGuid=?) AND isDeleted=0", [og]);
        const ns = ret[0].total === 0 ? "Delivered" : ret[0].total >= tot[0].total ? "Returned" : "Partially Returned";
        await mysqlPool.query("UPDATE orders SET status=? WHERE guid=?", [ns, og]);
      }
    }

    await recordSerialMovement(mysqlPool, { serialNumberGuid: rec.serialNumberGuid, serialValue: rec.serialValue, dispatchGuid: rec.dispatchGuid, actionType: "ReturnDeleted", status: "Dispatched", condition: rec.condition, reason: rec.reason, firmName: rec.firmName, customerName: rec.customerName, invoiceNumber: rec.invoiceNumber, createdBy: "System", notes: `Return #${id} was deleted and order context restored` });

    res.json({ message: "Return record deleted successfully" });
  } catch (err) {
    console.error("[returns] DELETE /:id:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

module.exports = router;
