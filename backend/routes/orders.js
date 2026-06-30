const router = require("express").Router();
const fs = require("fs");
const path = require("path");
const { mysqlPool } = require("../db");
const { mapDispatchRow, safeDate, recordSerialMovement } = require("../helpers");
const { requireAuth, canManageOrderDocuments } = require("../middleware/auth");
const { upload } = require("../middleware/upload");
const { createNotification } = require("../notificationService");

const ORDER_SELECT = `
  SELECT oi.guid as id, oi.serialNumberGuid as serialNumberId, oi.modelGuid as modelId,
    oi.sellingPrice, oi.warranty, oi.quantity, oi.contractFilename, oi.warrantyStartDate as itemWarrantyStartDate,
    o.guid as _orderId, o.orderid, o.platform, o.orderDate, o.dispatchDate, o.dispatchedBy, o.status,
    o.gemOrderType, o.bidNumber, o.customerName as customer, o.consigneeName, o.buyerEmail, o.consigneeEmail,
    o.paymentAuthorityEmail, o.shippingAddress, o.address, o.buyerAddress, o.gstNumber,
    o.contactNumber, o.altContactNumber, o.invoiceNumber, o.invoiceDate, o.warrantyStartDate, o.invoiceFilename, o.ewayBillNumber,
    o.ewayBillFilename, o.gemBillUploaded, o.freightCharges, o.packagingCost, o.commission,
    o.orderVerified, oi.remarks AS remarks, o.remarks AS orderRemarks, o.cancellationReason as cancelReason,
    o.cancelledBy, o.cancelledAt, o.isDeleted, o.rowColor, o.tags,
    ol.courierPartner, ol.trackingId, ol.logisticsStatus, ol.logisticsDispatchDate, ol.podFilename, ol.lastDeliveryDate,
    ins.installationRequired, ins.installationStatus, ins.technicianName, ins.technicianContact,
    ins.installationCharges, ins.installationRemarks, ins.scheduledDate, ins.installationDate,
    s.value as serialValue, m.name as modelName, m.company as companyName,
    p.paymentDate as paymentReceivedDate, p.amount as paymentReceivedAmount, p.utrId
  FROM order_items oi JOIN orders o ON oi.orderGuid=o.guid
  LEFT JOIN order_logistics ol ON o.guid=ol.orderGuid
  LEFT JOIN order_installations ins ON o.guid=ins.orderGuid
  LEFT JOIN serials s ON oi.serialNumberGuid=s.guid
  LEFT JOIN models m ON s.modelGuid=m.guid
  LEFT JOIN payments p ON oi.guid=p.dispatchGuid
`;

router.get("/", async (req, res) => {
  try {
    const [orders] = await mysqlPool.query(ORDER_SELECT + " ORDER BY o.dispatchDate DESC");
    const [docs] = await mysqlPool.query("SELECT dispatchGuid as dispatchId, docType, filename, createdAt FROM orderdocuments ORDER BY createdAt ASC");
    const docsMap = {};
    docs.forEach((d) => { if (!docsMap[d.dispatchId]) docsMap[d.dispatchId] = []; docsMap[d.dispatchId].push(d); });
    res.json(orders.map((o) => ({ ...mapDispatchRow(o), documents: docsMap[o.id] || [] })));
  } catch (err) {
    console.error("[orders] GET /:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

router.put("/bulk-reset-docs", requireAuth, async (req, res) => {
  try {
    const { items, removeInvoice, removeEwayBill } = req.body;
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ message: "No items provided" });
    for (const item of items) {
      const clauses = [];
      if (removeInvoice) { clauses.push("invoiceNumber=NULL", "invoiceFilename=NULL"); }
      if (removeEwayBill) { clauses.push("ewayBillNumber=NULL", "ewayBillFilename=NULL"); }
      if (clauses.length) await mysqlPool.query(`UPDATE orders SET ${clauses.join(",")} WHERE guid=?`, [item.id]);
    }
    res.json({ message: "Documents reset successfully" });
  } catch (err) {
    console.error("[orders] bulk-reset-docs:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

router.put("/bulk-send-back", requireAuth, async (req, res) => {
  try {
    const { items, removeInvoice, removeEwayBill } = req.body;
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ message: "No items provided" });
    const notified = new Set();
    for (const item of items) {
      const { id: orderGuid, cancelReason: remarks = "" } = item;
      const [oRows] = await mysqlPool.query("SELECT orderid, dispatchedBy FROM orders WHERE guid=?", [orderGuid]);
      const orderId = oRows[0]?.orderid || "Unknown Order";
      const dispatchedBy = oRows[0]?.dispatchedBy || null;

      await mysqlPool.query("UPDATE orders SET status=?, remarks=?, freightCharges=0 WHERE guid=?", ["Send for Billing", remarks, orderGuid]);
      await mysqlPool.query("UPDATE order_logistics SET logisticsStatus=NULL, trackingId=NULL, courierPartner=NULL WHERE orderGuid=?", [orderGuid]);

      if (!notified.has(orderId)) {
        notified.add(orderId);
        let creatorGuid = null;
        if (dispatchedBy) {
          const [cr] = await mysqlPool.query("SELECT userid FROM users WHERE username=?", [dispatchedBy]);
          if (cr.length) creatorGuid = String(cr[0].userid);
        }
        await createNotification(mysqlPool, { targetRole: "Admin", title: "Order Sent Back to Billing", message: `Order ${orderId} sent back to billing. Reason: ${remarks}`, type: "warning", link: "/billing" });
        await createNotification(mysqlPool, { targetRole: "Accountant", title: "Order Sent Back to Billing", message: `Order ${orderId} sent back by Dispatch. Reason: ${remarks}`, type: "warning", link: "/billing" });
        if (creatorGuid) await createNotification(mysqlPool, { targetUserGuid: creatorGuid, title: "Order Sent Back to Billing", message: `Order ${orderId} has been sent back to billing. Reason: ${remarks}`, type: "warning", link: "/billing" });
      }

      if (removeInvoice || removeEwayBill) {
        const clauses = [];
        if (removeInvoice) clauses.push("invoiceNumber=NULL", "invoiceFilename=NULL");
        if (removeEwayBill) clauses.push("ewayBillNumber=NULL", "ewayBillFilename=NULL");
        if (clauses.length) await mysqlPool.query(`UPDATE orders SET ${clauses.join(",")} WHERE guid=?`, [orderGuid]);
      }
    }
    res.json({ message: "Orders sent back to billing successfully" });
  } catch (err) {
    console.error("[orders] bulk-send-back:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

router.put("/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    const { status, trackingId, reason, cancelledBy, clearLogistics } = req.body;
    const [cur] = await mysqlPool.query("SELECT oi.serialNumberGuid, oi.orderGuid FROM order_items oi WHERE oi.guid=?", [id]);
    if (!cur.length) return res.status(404).json({ message: "Order not found" });
    const { serialNumberGuid, orderGuid } = cur[0];
    if (status === "Order Cancelled") {
      await mysqlPool.query("UPDATE serials SET status='Available' WHERE guid=?", [serialNumberGuid]);
      await mysqlPool.query("UPDATE orders SET status=?,isDeleted=1,cancellationReason=?,cancelledBy=?,cancelledAt=NOW() WHERE guid=?", [status, reason || "No reason", cancelledBy || "Unknown", orderGuid]);
    } else {
      await mysqlPool.query("UPDATE orders SET status=? WHERE guid=? AND isDeleted=0", [status, orderGuid]);
    }
    if (clearLogistics) {
      await mysqlPool.query("UPDATE order_logistics SET logisticsStatus=NULL, trackingId=NULL WHERE orderGuid=?", [orderGuid]);
    } else {
      await mysqlPool.query("UPDATE order_logistics SET trackingId=? WHERE orderGuid=?", [trackingId || null, orderGuid]);
    }
    res.json({ message: "Status updated successfully" });
  } catch (err) {
    console.error("[orders] /:id/status:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

const handleReplace = async (req, res) => {
  try {
    const { id } = req.params;
    const targetSerialId = req.body.newSerialId || req.body.serialId;
    const reason = req.body.reason || req.body.remarks || "Replaced by user";
    const condition = req.body.condition || "Available";

    const [dispRows] = await mysqlPool.query(
      "SELECT oi.guid, oi.serialNumberGuid, oi.orderGuid, o.platform as firmName, o.customerName as customer FROM order_items oi JOIN orders o ON oi.orderGuid=o.guid WHERE oi.guid=?",
      [id]
    );
    if (!dispRows.length) return res.status(404).json({ message: "Order not found" });
    const dispatch = dispRows[0];

    const [newSer] = await mysqlPool.query("SELECT * FROM serials WHERE guid=? AND isDeleted=0", [targetSerialId]);
    if (!newSer.length) return res.status(404).json({ message: "New serial not found" });
    if (newSer[0].status !== "Available") return res.status(400).json({ message: "New serial is not Available" });

    const [oldSer] = await mysqlPool.query("SELECT value FROM serials WHERE guid=?", [dispatch.serialNumberGuid]);
    const oldValue = oldSer[0]?.value || "Unknown";

    await mysqlPool.query("UPDATE serials SET status=? WHERE guid=?", [condition === "Damaged" ? "Damaged" : "Available", dispatch.serialNumberGuid]);
    await mysqlPool.query("UPDATE serials SET status='Dispatched' WHERE guid=?", [targetSerialId]);
    await mysqlPool.query("UPDATE order_items SET serialNumberGuid=?,remarks=? WHERE guid=?", [targetSerialId, reason, id]);

    const isMarketplace = dispatch.firmName === "Amazon" || dispatch.firmName === "Flipkart";
    await mysqlPool.query("UPDATE orders SET status=?,isDeleted=0 WHERE guid=?", [isMarketplace ? "Ready for Pickup" : "Send for Billing", dispatch.orderGuid]);
    await mysqlPool.query("UPDATE order_logistics SET logisticsStatus=? WHERE orderGuid=?", [isMarketplace ? "Ready for Pickup" : null, dispatch.orderGuid]);

    await recordSerialMovement(mysqlPool, { serialNumberGuid: dispatch.serialNumberGuid, serialValue: oldValue, dispatchGuid: id, actionType: "ReplacedOut", status: condition === "Damaged" ? "Damaged" : "Available", condition: condition !== "Available" ? condition : null, reason, firmName: dispatch.firmName, customerName: dispatch.customer || "", createdBy: req.body.replacedBy || "System" });
    await recordSerialMovement(mysqlPool, { serialNumberGuid: targetSerialId, serialValue: newSer[0].value, dispatchGuid: id, actionType: "ReplacedIn", status: "Dispatched", reason, firmName: dispatch.firmName, customerName: dispatch.customer || "", createdBy: req.body.replacedBy || "System" });

    res.json({ message: "Order replaced successfully", newSerialValue: newSer[0].value });
  } catch (err) {
    console.error("[orders] replace:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
};

router.post("/:id/replace", handleReplace);
router.put("/:id/replace", handleReplace);

router.put("/:id/warranty-start", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { warrantyStartDate } = req.body;
    const [itemRows] = await mysqlPool.query("SELECT guid FROM order_items WHERE guid=?", [id]);
    if (!itemRows.length) return res.status(404).json({ message: "Order item not found" });
    await mysqlPool.query(
      "UPDATE order_items SET warrantyStartDate=? WHERE guid=?",
      [safeDate(warrantyStartDate) || null, id]
    );
    res.json({ message: "Warranty start date updated" });
  } catch (err) {
    console.error("[orders] warranty-start:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

// Add a brand-new serial/item to an EXISTING order (does not touch existing items)
router.post("/:orderGuid/items", requireAuth, async (req, res) => {
  try {
    const { orderGuid } = req.params;
    const { newSerialId, sellingPrice, warranty, addedBy } = req.body;

    if (!newSerialId) return res.status(400).json({ message: "newSerialId is required" });

    const [orderRows] = await mysqlPool.query(
      "SELECT guid, platform, customerName FROM orders WHERE guid=? AND isDeleted=0",
      [orderGuid]
    );
    if (!orderRows.length) return res.status(404).json({ message: "Order not found" });
    const order = orderRows[0];

    const [serRows] = await mysqlPool.query("SELECT * FROM serials WHERE guid=? AND isDeleted=0", [newSerialId]);
    if (!serRows.length) return res.status(404).json({ message: "Serial not found" });
    if (serRows[0].status !== "Available") return res.status(400).json({ message: "Selected serial is not Available" });

    const newItemGuid = require("crypto").randomUUID();

    const conn = await mysqlPool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(
        `INSERT INTO order_items (guid,orderGuid,serialNumberGuid,modelGuid,sellingPrice,warranty)
         VALUES (?,?,?,?,?,?)`,
        [newItemGuid, orderGuid, newSerialId, serRows[0].modelGuid, sellingPrice || 0, warranty || null]
      );
      await conn.query("UPDATE serials SET status='Dispatched' WHERE guid=?", [newSerialId]);
      await conn.commit();
    } catch (txErr) {
      await conn.rollback();
      conn.release();
      throw txErr;
    }
    conn.release();

    await recordSerialMovement(mysqlPool, {
      serialNumberGuid: newSerialId,
      serialValue: serRows[0].value,
      dispatchGuid: newItemGuid,
      actionType: "Dispatched",
      status: "Dispatched",
      reason: "Added to existing order",
      firmName: order.platform,
      customerName: order.customerName || "",
      createdBy: addedBy || "System"
    });

    const [newRow] = await mysqlPool.query(ORDER_SELECT + " WHERE oi.guid=?", [newItemGuid]);
    res.status(201).json({ message: "Serial added to order", item: mapDispatchRow(newRow[0]) });
  } catch (err) {
    console.error("[orders] add item:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

router.post("/:id/upload", requireAuth, upload.single("file"), async (req, res) => {
  try {
    const { id } = req.params;
    const { docType } = req.body;
    const filename = req.file?.filename;
    if (!filename) return res.status(400).json({ message: "No file uploaded" });

    const role = req.user?.role;
    if (!canManageOrderDocuments(role, docType)) {
      if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res.status(403).json({ message: "You cannot upload this document type." });
    }

    if (id !== "0") {
      const [itemRows] = await mysqlPool.query("SELECT orderGuid FROM order_items WHERE guid=?", [id]);
      if (!itemRows.length) return res.status(404).json({ message: "Order not found" });
      const orderId = itemRows[0].orderGuid;
      // Standard doc types update a dedicated column; custom docs only go to orderdocuments
      if (docType === "gemContract") {
        await mysqlPool.query("UPDATE order_items SET contractFilename=? WHERE guid=?", [filename, id]);
      } else if (docType === "pod") {
        await mysqlPool.query("UPDATE order_logistics SET podFilename=? WHERE orderGuid=?", [filename, orderId]);
      } else if (docType === "ewayBill") {
        await mysqlPool.query("UPDATE orders SET ewayBillFilename=? WHERE guid=?", [filename, orderId]);
      } else if (docType === "invoice") {
        await mysqlPool.query("UPDATE orders SET invoiceFilename=? WHERE guid=?", [filename, orderId]);
      }
      // All uploads (including custom) are recorded in orderdocuments for full audit trail
      await mysqlPool.query("INSERT INTO orderdocuments (guid, dispatchGuid, docType, filename) VALUES (UUID(),?,?,?)", [id, docType, filename]);
    }

    res.json({ message: "File uploaded successfully", filename, url: `${process.env.BACKEND_URI}/uploads/${filename}` });
  } catch (err) {
    console.error("[orders] upload:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

router.delete("/documents", requireAuth, async (req, res) => {
  try {
    const role = req.user?.role;
    const allowedRoles = ["Admin", "SuperAdmin", "Accountant", "Supervisor"];
    if (!allowedRoles.includes(role) && !req.user?.allow_edit_dispatch) {
      return res.status(403).json({ message: "You do not have permission to delete documents." });
    }

    const { filename } = req.body;
    if (!filename) return res.status(400).json({ message: "filename required" });

    // Strip any directory components to prevent path traversal (e.g. "../../.env")
    const safeFilename = path.basename(String(filename));

    const [result] = await mysqlPool.query("DELETE FROM orderdocuments WHERE filename=?", [safeFilename]);
    if (!result.affectedRows) return res.status(404).json({ message: "Document not found" });

    const filePath = path.join(__dirname, "../uploads", safeFilename);
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (fsErr) {
      console.error("[orders] delete doc file:", fsErr.message);
    }

    res.json({ message: "Document deleted" });
  } catch (err) {
    console.error("[orders] delete doc:", err);
    res.status(500).json({ message: "Failed to delete document" });
  }
});

router.put("/:id/payment", requireAuth, async (req, res) => {
  let conn;
  try {
    const { id } = req.params;
    const { paymentDate, amount, utrId, status, paymentType, settlementDeduction } = req.body;
    const numAmount = Number(amount);
    const numDeduction = Number(settlementDeduction || 0);
    if (!Number.isFinite(numAmount) || numAmount < 0) return res.status(400).json({ message: "Invalid payment amount." });
    if (!Number.isFinite(numDeduction) || numDeduction < 0) return res.status(400).json({ message: "Invalid settlement deduction amount." });
    conn = await mysqlPool.getConnection();
    await conn.beginTransaction();
    try {
      const [existing] = await conn.query("SELECT guid FROM payments WHERE dispatchGuid=?", [id]);
      if (existing.length) {
        await conn.query("UPDATE payments SET paymentDate=?,amount=?,utrId=?,paymentType=?,settlementDeduction=? WHERE dispatchGuid=?", [safeDate(paymentDate), numAmount, utrId, paymentType || "Full", numDeduction, id]);
      } else {
        await conn.query("INSERT INTO payments (guid,dispatchGuid,paymentDate,amount,utrId,paymentType,settlementDeduction) VALUES (UUID(),?,?,?,?,?,?)", [id, safeDate(paymentDate), numAmount, utrId, paymentType || "Full", numDeduction]);
      }
      const [itemRows] = await conn.query("SELECT orderGuid FROM order_items WHERE guid=?", [id]);
      if (itemRows.length) {
        await conn.query("UPDATE orders SET status=? WHERE guid=?", [status || "Completed", itemRows[0].orderGuid]);
        await conn.query("UPDATE order_logistics SET logisticsStatus=CASE WHEN logisticsStatus!='Delivered' THEN 'Delivered' ELSE logisticsStatus END WHERE orderGuid=?", [itemRows[0].orderGuid]);
      }
      await conn.commit();
      res.json({ message: "Payment recorded and order completed." });
    } catch (e) { await conn.rollback(); throw e; }
  } catch (err) {
    if (conn) await conn.rollback();
    console.error("[orders] payment:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  } finally { if (conn) conn.release(); }
});

router.post("/batch-payment", requireAuth, async (req, res) => {
  let conn;
  try {
    const { itemIds, paymentDate, totalAmount, utrId, status, paymentType, settlementDeduction } = req.body;
    if (!Array.isArray(itemIds) || !itemIds.length) return res.status(400).json({ message: "No items provided." });
    const numTotal = Number(totalAmount);
    const numDeduction = Number(settlementDeduction || 0);
    if (!Number.isFinite(numTotal) || numTotal < 0) return res.status(400).json({ message: "Invalid total amount." });
    if (!Number.isFinite(numDeduction) || numDeduction < 0) return res.status(400).json({ message: "Invalid settlement deduction amount." });
    conn = await mysqlPool.getConnection();
    await conn.beginTransaction();
    try {
      const amtPer = (numTotal / itemIds.length).toFixed(2);
      const dedPer = (numDeduction / itemIds.length).toFixed(2);
      for (const id of itemIds) {
        const [ex] = await conn.query("SELECT guid FROM payments WHERE dispatchGuid=?", [id]);
        if (ex.length) {
          await conn.query("UPDATE payments SET paymentDate=?,amount=?,utrId=?,paymentType=?,settlementDeduction=? WHERE dispatchGuid=?", [safeDate(paymentDate), amtPer, utrId, paymentType || "Full", dedPer, id]);
        } else {
          await conn.query("INSERT INTO payments (guid,dispatchGuid,paymentDate,amount,utrId,paymentType,settlementDeduction) VALUES (UUID(),?,?,?,?,?,?)", [id, safeDate(paymentDate), amtPer, utrId, paymentType || "Full", dedPer]);
        }
        const [ir] = await conn.query("SELECT orderGuid FROM order_items WHERE guid=?", [id]);
        if (ir.length) {
          await conn.query("UPDATE orders SET status=? WHERE guid=?", [status || "Completed", ir[0].orderGuid]);
          await conn.query("UPDATE order_logistics SET logisticsStatus=CASE WHEN logisticsStatus!='Delivered' THEN 'Delivered' ELSE logisticsStatus END WHERE orderGuid=?", [ir[0].orderGuid]);
        }
      }
      await conn.commit();
      res.json({ message: "Batch payment recorded successfully" });
    } catch (e) { await conn.rollback(); throw e; }
  } catch (err) {
    if (conn) await conn.rollback();
    console.error("[orders] batch-payment:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  } finally { if (conn) conn.release(); }
});

module.exports = router;
