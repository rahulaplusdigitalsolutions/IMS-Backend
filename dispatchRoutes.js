const express = require('express');
const { randomUUID } = require('crypto');
const { handleOrderUpdates, createNotification } = require('./notificationService');

// Inline replacement for sp_dispatch_create_v2 — avoids stored-procedure collation issues.
// Uses parameterised queries (values are COERCIBLE, always yield to the column collation).
async function createDispatchInline(conn, p, helpers) {
  const { safeDate, normalizeBusinessStatus, normalizeLogisticsStatus, safeStr } = helpers;

  // 1. Lock & validate serial
  const [serialRows] = await conn.query(
    "SELECT status, value, modelGuid FROM serials WHERE guid = ? FOR UPDATE",
    [p.serialId]
  );
  if (!serialRows.length) return { success: false, message: "Serial not found" };
  if (serialRows[0].status !== "Available") return { success: false, message: "Serial is not available" };

  const serialValue = serialRows[0].value;
  const modelGuid   = serialRows[0].modelGuid;

  // 2. Dispatch the serial
  await conn.query("UPDATE serials SET status = 'Dispatched' WHERE guid = ?", [p.serialId]);

  // 3. Find or create order
  const safeCustomer = safeStr(p.customerName, "") || "";
  const safeOrderId  = safeCustomer || `TEMP-${Date.now()}`;
  let   orderId      = null;

  const [orderRows] = await conn.query(
    "SELECT guid FROM orders WHERE (orderid = ? OR customerName = ?) AND isDeleted = 0 LIMIT 1",
    [safeOrderId, safeCustomer]
  );
  if (orderRows.length) {
    orderId = orderRows[0].guid;
  } else {
    orderId = randomUUID();
    await conn.query(
      `INSERT INTO orders
         (guid,orderid,platform,customerName,consigneeName,buyerEmail,consigneeEmail,
          paymentAuthorityEmail,address,shippingAddress,dispatchedBy,status,gemOrderType,
          bidNumber,orderDate,gstNumber,contactNumber,altContactNumber,orderVerified,
          packagingCost,commission,freightCharges,remarks,dispatchDate,buyerAddress)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW(),?)`,
      [orderId, safeOrderId, p.firmName, safeCustomer, p.consigneeName||null, p.buyerEmail||null,
       p.consigneeEmail||null, p.paymentAuthorityEmail||null, p.address||null, p.shippingAddress||null,
       p.user||"System", normalizeBusinessStatus(p.status||"Pending"), p.gemOrderType||null,
       p.bidNumber||null, safeDate(p.orderDate), p.gstNumber||null, p.contactNumber||null,
       p.altContactNumber||null, p.orderVerified||"No", p.packagingCost||0, p.commission||0,
       p.freightCharges||0, p.remarks||null, p.buyerAddress||null]
    );
    await conn.query(
      `INSERT INTO order_logistics
         (orderGuid,courierPartner,trackingId,logisticsStatus,logisticsDispatchDate,podFilename,lastDeliveryDate)
       VALUES (?,?,?,?,?,?,?)`,
      [orderId, p.courierPartner||null, p.trackingId||null,
       normalizeLogisticsStatus(p.logisticsStatus), safeDate(p.logisticsDispatchDate),
       p.podFilename||null, safeDate(p.lastDeliveryDate)]
    );
    await conn.query(
      `INSERT INTO order_installations
         (orderGuid,installationRequired,installationStatus,technicianName,technicianContact,
          installationCharges,installationRemarks,scheduledDate)
       VALUES (?,?,?,?,?,?,?,?)`,
      [orderId, p.installationRequired||"No", p.installationStatus||null,
       p.technicianName||null, p.technicianContact||null,
       p.installationCharges||0, p.installationRemarks||null, safeDate(p.scheduledDate)]
    );
  }

  // 4. Create order item
  const dispatchGuid = randomUUID();
  await conn.query(
    `INSERT INTO order_items
       (guid,orderGuid,serialNumberGuid,modelGuid,sellingPrice,warranty,contractFilename)
     VALUES (?,?,?,?,?,?,?)`,
    [dispatchGuid, orderId, p.serialId, modelGuid,
     p.sellingPrice||0, p.warranty||null, p.contractFilename||null]
  );

  // 5. Serial movement log
  await conn.query(
    `INSERT INTO serialmovements
       (guid,serialNumberGuid,serialValue,dispatchGuid,actionType,status,
        platform,orderid,createdBy,notes,createdAt)
     VALUES (?,?,?,?,?,?,?,?,?,?,NOW())`,
    [randomUUID(), p.serialId, serialValue, dispatchGuid,
     "Dispatched", "Dispatched", p.firmName||null, safeOrderId,
     p.user||"System", `Assigned to order #${orderId} as item #${dispatchGuid}`]
  );

  return { success: true, message: "Success", dispatchGuid, orderId };
}

function setupDispatchRoutes(app, getMysqlPool, attachAuthenticatedUser, requireAuth, authorizeDispatchRequest, helpers) {
  const {
    mapDispatchRow,
    recordSerialMovement,
    logUserActivity,
    safeStr,
    safeDate,
    toBit,
    normalizeBusinessStatus,
    normalizeLogisticsStatus
  } = helpers;

  // Helper function to update a single dispatch item using stored procedure
  async function updateDispatchItem(pool, itemId, fields, user) {
    // 1. Fetch current record
    const [currentRows] = await pool.query(`
      SELECT 
          oi.guid as id, oi.serialNumberGuid as serialGuid, oi.modelGuid, oi.sellingPrice, oi.warranty, oi.quantity, oi.contractFilename, oi.warrantyStartDate as itemWarrantyStartDate,
          o.guid as _orderId, o.orderid, o.platform, o.orderDate, o.dispatchDate, o.dispatchedBy, o.status, 
          o.gemOrderType, o.bidNumber, o.customerName as customer, o.consigneeName, o.buyerEmail, o.consigneeEmail, 
          o.paymentAuthorityEmail,
          o.shippingAddress, o.address, o.buyerAddress, o.gstNumber, o.contactNumber, o.altContactNumber, o.invoiceNumber,
          o.invoiceDate, o.warrantyStartDate, o.invoiceFilename, o.ewayBillNumber, o.ewayBillFilename, o.gemBillUploaded, o.freightCharges,
          o.packagingCost, o.commission, o.orderVerified, o.remarks, o.cancellationReason as cancelReason,
          o.cancelledBy, o.cancelledAt, o.isDeleted, o.rowColor, o.tags,
          ol.courierPartner, ol.trackingId, ol.logisticsStatus, ol.logisticsDispatchDate, ol.podFilename, ol.lastDeliveryDate,
          ins.installationRequired, ins.installationStatus, ins.technicianName, ins.technicianContact,
          ins.installationCharges, ins.installationRemarks, ins.scheduledDate, ins.installationDate
      FROM order_items oi
      JOIN orders o ON oi.orderGuid = o.guid
      LEFT JOIN order_logistics ol ON o.guid = ol.orderGuid
      LEFT JOIN order_installations ins ON o.guid = ins.orderGuid
      WHERE oi.guid = ?
    `, [itemId]);

    if (currentRows.length === 0) {
      throw new Error("Dispatch item not found");
    }

    const current = currentRows[0];

    // 2. Merge fields
    const merged = {
      serialId: fields.serialId !== undefined ? fields.serialId : (fields.serialGuid !== undefined ? fields.serialGuid : current.serialGuid),
      firmName: fields.firmName || fields.platform || current.platform || current.firmName,
      customerName: fields.customerName || fields.customer || current.customer || current.customerName,
      address: fields.address !== undefined ? fields.address : current.address,
      shippingAddress: fields.shippingAddress !== undefined ? fields.shippingAddress : current.shippingAddress,
      user: user || fields.user || fields.dispatchedBy || current.dispatchedBy || "System",
      sellingPrice: fields.sellingPrice !== undefined ? fields.sellingPrice : current.sellingPrice,
      status: fields.status !== undefined ? fields.status : current.status,
      dispatchDate: fields.dispatchDate !== undefined ? fields.dispatchDate : current.dispatchDate,
      courierPartner: fields.courierPartner !== undefined ? fields.courierPartner : current.courierPartner,
      logisticsDispatchDate: fields.logisticsDispatchDate !== undefined ? fields.logisticsDispatchDate : current.logisticsDispatchDate,
      trackingId: fields.trackingId !== undefined ? fields.trackingId : current.trackingId,
      freightCharges: fields.freightCharges !== undefined ? fields.freightCharges : current.freightCharges,
      logisticsStatus: fields.logisticsStatus !== undefined ? fields.logisticsStatus : current.logisticsStatus,
      podFilename: fields.podFilename !== undefined ? fields.podFilename : current.podFilename,
      invoiceNumber: fields.invoiceNumber !== undefined ? fields.invoiceNumber : current.invoiceNumber,
      ewayBillNumber: fields.ewayBillNumber !== undefined ? fields.ewayBillNumber : current.ewayBillNumber,
      gemBillUploaded: fields.gemBillUploaded !== undefined ? fields.gemBillUploaded : current.gemBillUploaded,
      invoiceFilename: fields.invoiceFilename !== undefined ? fields.invoiceFilename : current.invoiceFilename,
      installationRequired: fields.installationRequired !== undefined ? fields.installationRequired : current.installationRequired,
      installationStatus: fields.installationStatus !== undefined ? fields.installationStatus : current.installationStatus,
      technicianName: fields.technicianName !== undefined ? fields.technicianName : current.technicianName,
      technicianContact: fields.technicianContact !== undefined ? fields.technicianContact : current.technicianContact,
      installationCharges: fields.installationCharges !== undefined ? fields.installationCharges : current.installationCharges,
      installationRemarks: fields.installationRemarks !== undefined ? fields.installationRemarks : current.installationRemarks,
      scheduledDate: fields.scheduledDate !== undefined ? fields.scheduledDate : current.scheduledDate,
      installationDate: fields.installationDate !== undefined ? fields.installationDate : current.installationDate,
      packagingCost: fields.packagingCost !== undefined ? fields.packagingCost : current.packagingCost,
      commission: fields.commission !== undefined ? fields.commission : current.commission,
      ewayBillFilename: fields.ewayBillFilename !== undefined ? fields.ewayBillFilename : current.ewayBillFilename,
      contactNumber: fields.contactNumber !== undefined ? fields.contactNumber : current.contactNumber,
      altContactNumber: fields.altContactNumber !== undefined ? fields.altContactNumber : current.altContactNumber,
      buyerEmail: fields.buyerEmail !== undefined ? fields.buyerEmail : current.buyerEmail,
      consigneeEmail: fields.consigneeEmail !== undefined ? fields.consigneeEmail : current.consigneeEmail,
      consigneeName: fields.consigneeName !== undefined ? fields.consigneeName : current.consigneeName,
      gstNumber: fields.gstNumber !== undefined ? fields.gstNumber : current.gstNumber,
      contractFilename: fields.contractFilename !== undefined ? fields.contractFilename : (fields.contractFile !== undefined ? fields.contractFile : current.contractFilename),
      remarks: fields.remarks !== undefined ? fields.remarks : current.remarks,
      warranty: fields.warranty !== undefined ? fields.warranty : current.warranty,
      lastDeliveryDate: fields.lastDeliveryDate !== undefined ? fields.lastDeliveryDate : current.lastDeliveryDate,
      buyerAddress: fields.buyerAddress !== undefined ? fields.buyerAddress : current.buyerAddress
    };

    const finalStatus = normalizeBusinessStatus(merged.status);
    const finalLogisticsStatus = normalizeLogisticsStatus(merged.logisticsStatus);
    const installReqBit = toBit(merged.installationRequired) ? "Yes" : "No";
    const installStatusBit = toBit(merged.installationRequired) ? (merged.installationStatus || "Pending") : null;

    // Execute update procedure
    await pool.query("SET @resultMsg = '';");
    await pool.query(`
      CALL sp_dispatch_update_v2(
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        @resultMsg
      )
    `, [
      itemId,
      merged.serialId,
      merged.firmName,
      merged.customerName,
      safeStr(merged.address),
      safeStr(merged.shippingAddress),
      merged.user,
      merged.sellingPrice || 0,
      finalStatus,
      safeDate(merged.dispatchDate),
      merged.courierPartner || null,
      safeDate(merged.logisticsDispatchDate),
      merged.trackingId || null,
      merged.freightCharges || 0,
      finalLogisticsStatus,
      merged.podFilename || null,
      merged.invoiceNumber || null,
      merged.ewayBillNumber || null,
      merged.gemBillUploaded || "No",
      merged.invoiceFilename || null,
      installReqBit,
      installStatusBit,
      merged.technicianName || null,
      merged.technicianContact || null,
      merged.installationCharges || 0,
      merged.installationRemarks || null,
      safeDate(merged.scheduledDate),
      safeDate(merged.installationDate),
      merged.packagingCost || 0,
      merged.commission || 0,
      merged.ewayBillFilename || null,
      merged.contactNumber || null,
      merged.altContactNumber || null,
      merged.buyerEmail || null,
      merged.consigneeEmail || null,
      merged.paymentAuthorityEmail || null,
      merged.consigneeName || null,
      merged.gstNumber || null,
      merged.contractFilename || null,
      merged.remarks || null,
      merged.warranty || null,
      safeDate(merged.lastDeliveryDate),
      safeStr(merged.buyerAddress)
    ]);

    const [outParams] = await pool.query("SELECT @resultMsg as message");
    if (outParams[0].message !== 'Success') {
      throw new Error(outParams[0].message);
    }

    // Direct metadata update to ensure empty strings are saved and fields are updated regardless of IFNULL
    let updateQ = "UPDATE orders SET ";
    let updateParams = [];
    if (fields.paymentAuthorityEmail !== undefined) { updateQ += "paymentAuthorityEmail = ?, "; updateParams.push(fields.paymentAuthorityEmail); }
    if (fields.invoiceNumber !== undefined) { updateQ += "invoiceNumber = ?, "; updateParams.push(fields.invoiceNumber); }
    if (fields.invoiceDate !== undefined) { updateQ += "invoiceDate = ?, "; updateParams.push(safeDate(fields.invoiceDate)); }
    if (fields.warrantyStartDate !== undefined) { updateQ += "warrantyStartDate = ?, "; updateParams.push(safeDate(fields.warrantyStartDate) || null); }
    if (fields.buyerAddress !== undefined) { updateQ += "buyerAddress = ?, "; updateParams.push(fields.buyerAddress); }
    
    if (updateParams.length > 0) {
      updateQ = updateQ.slice(0, -2) + " WHERE guid = ?";
      updateParams.push(current._orderId);
      await pool.query(updateQ, updateParams);
    }

    // TRIGGER NOTIFICATIONS
    try {
      await handleOrderUpdates(pool, current, merged, itemId);
    } catch (notifErr) {
      console.error("Error sending order updates notifications:", notifErr);
    }


  }

  // 1. GET /api/dispatches
  app.get("/api/dispatches", requireAuth, authorizeDispatchRequest, async (req, res) => {
    try {
      const pool = await getMysqlPool();
      if (!pool) return res.status(500).json({ message: "MySQL not connected" });

      const includeDeleted = req.query.includeDeleted === "true" ? 1 : 0;

      const [rows] = await pool.query(`
        SELECT
            oi.guid as id, oi.serialNumberGuid as serialGuid, oi.modelGuid, oi.sellingPrice, oi.warranty, oi.quantity, oi.contractFilename, oi.warrantyStartDate as itemWarrantyStartDate,
            o.guid as _orderId, o.orderid, o.platform, o.orderDate, o.dispatchDate, o.dispatchedBy, o.status,
            o.gemOrderType, o.bidNumber, o.customerName as customer, o.consigneeName, o.buyerEmail, o.consigneeEmail,
            o.paymentAuthorityEmail,
            o.shippingAddress, o.address, o.buyerAddress, o.gstNumber, o.contactNumber, o.altContactNumber, o.invoiceNumber,
            o.invoiceDate, o.warrantyStartDate, o.invoiceFilename, o.ewayBillNumber, o.ewayBillFilename, o.gemBillUploaded, o.freightCharges,
            o.packagingCost, o.commission, o.orderVerified, oi.remarks AS remarks, o.remarks AS orderRemarks, o.cancellationReason as cancelReason,
            o.cancelledBy, o.cancelledAt, o.isDeleted, o.rowColor, o.tags,
            ol.courierPartner, ol.trackingId, ol.logisticsStatus, ol.logisticsDispatchDate, ol.podFilename, ol.lastDeliveryDate,
            ins.installationRequired, ins.installationStatus, ins.technicianName, ins.technicianContact,
            ins.installationCharges, ins.installationRemarks, ins.scheduledDate, ins.installationDate,
            s.value as serialValue, s.landingPrice,
            m.name as modelName, m.company as companyName, m.category as modelCategory,
            p.paymentDate as paymentReceivedDate, p.amount as paymentReceivedAmount, p.utrId
        FROM order_items oi
        JOIN orders o ON oi.orderGuid = o.guid
        LEFT JOIN order_logistics ol ON o.guid = ol.orderGuid
        LEFT JOIN order_installations ins ON o.guid = ins.orderGuid
        LEFT JOIN serials s ON oi.serialNumberGuid = s.guid
        LEFT JOIN models m ON s.modelGuid = m.guid
        LEFT JOIN (
            SELECT p1.dispatchGuid, p1.paymentDate, p1.amount, p1.utrId
            FROM payments p1
            INNER JOIN (SELECT dispatchGuid, MAX(paymentDate) AS maxDate FROM payments GROUP BY dispatchGuid) p2
            ON p1.dispatchGuid = p2.dispatchGuid AND p1.paymentDate = p2.maxDate
        ) p ON oi.guid = p.dispatchGuid
        WHERE (? = 1 OR o.isDeleted = 0)
        ORDER BY o.dispatchDate DESC
      `, [includeDeleted]);

      res.json(rows.map(mapDispatchRow));
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // 2. GET /api/dispatches/stats
  app.get("/api/dispatches/stats", requireAuth, async (req, res) => {
    try {
      const pool = await getMysqlPool();
      if (!pool) return res.status(500).json({ message: "MySQL not connected" });

      const [rows] = await pool.query(`
        SELECT 
          COUNT(oi.guid) as total,
          SUM(CASE WHEN o.isDeleted = 0 THEN 1 ELSE 0 END) as active,
          SUM(CASE WHEN o.status = 'Delivered' AND o.isDeleted = 0 THEN 1 ELSE 0 END) as delivered,
          SUM(CASE WHEN (o.status = 'In Transit' OR ol.logisticsStatus = 'In Transit') AND o.isDeleted = 0 THEN 1 ELSE 0 END) as inTransit,
          SUM(CASE WHEN (o.status = 'Cancelled' OR o.status = 'Order Cancelled') AND o.isDeleted = 0 THEN 1 ELSE 0 END) as cancelled
        FROM order_items oi
        JOIN orders o ON oi.orderGuid = o.guid
        LEFT JOIN order_logistics ol ON o.guid = ol.orderGuid
      `);
      res.json(rows[0]);
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // 2.5 GET /api/dispatches/check/:orderId (Check Duplicate Order ID)
  app.get("/api/dispatches/check/:orderId", requireAuth, authorizeDispatchRequest, async (req, res) => {
    try {
      const pool = await getMysqlPool();
      if (!pool) return res.status(500).json({ message: "MySQL not connected" });

      const safeOrderId = safeStr(req.params.orderId, "");
      if (!safeOrderId || safeOrderId.toLowerCase() === "n/a") {
        return res.json({ exists: false });
      }

      const [existing] = await pool.query(
        "SELECT guid FROM orders WHERE (orderid = ? OR customerName = ?) AND isDeleted = 0 LIMIT 1",
        [safeOrderId, safeOrderId]
      );

      res.json({ exists: existing.length > 0 });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // 3. GET /api/dispatches/:guid
  app.get("/api/dispatches/:guid", requireAuth, authorizeDispatchRequest, async (req, res) => {
    try {
      const pool = await getMysqlPool();
      if (!pool) return res.status(500).json({ message: "MySQL not connected" });

      const { guid } = req.params;
      if (guid.startsWith('SO-')) {
        const [stockOutRows] = await pool.query(`
          SELECT 
            o.*,
            'Inventory' as firmName,
            o.issuedBy as customerName,
            o.issueDate as dispatchDate,
            'Delivered' as status,
            'Delivered' as logisticsStatus
          FROM inventorystockout o
          WHERE o.stockOutId = ? AND o.isDeleted = 0
        `, [guid]);

        if (stockOutRows.length === 0) return res.status(404).json({ message: "Stock Out not found" });
        
        const [items] = await pool.query(`
          SELECT d.*, v.variantName, i.itemName
          FROM inventorystockoutdetail d
          JOIN inventoryitemvariant v ON d.itemVariantId = v.itemVariantId
          JOIN inventoryitemmaster i ON v.itemId = i.itemId
          WHERE d.stockOutId = ?
        `, [guid]);

        const result = {
          id: stockOutRows[0].stockOutId,
          firmName: 'Inventory',
          customerName: stockOutRows[0].issuedBy,
          dispatchDate: stockOutRows[0].issueDate,
          status: 'Delivered',
          logisticsStatus: 'Delivered',
          invoiceNumber: stockOutRows[0].refNo,
          gemContact: 'N/A',
          modelName: items[0]?.variantName || 'N/A',
          quantity: items[0]?.issueQty || 1,
          sellingPrice: 0
        };

        return res.json(result);
      }

      const [rows] = await pool.query(`
        SELECT 
            oi.guid as id, oi.serialNumberGuid as serialGuid, oi.modelGuid, oi.sellingPrice, oi.warranty, oi.quantity, oi.contractFilename, oi.warrantyStartDate as itemWarrantyStartDate,
            o.guid as _orderId, o.orderid, o.platform, o.orderDate, o.dispatchDate, o.dispatchedBy, o.status, 
            o.gemOrderType, o.bidNumber, o.customerName as customer, o.consigneeName, o.buyerEmail, o.consigneeEmail, 
            o.paymentAuthorityEmail,
            o.shippingAddress, o.address, o.buyerAddress, o.gstNumber, o.contactNumber, o.altContactNumber, o.invoiceNumber,
            o.invoiceDate, o.warrantyStartDate, o.invoiceFilename, o.ewayBillNumber, o.ewayBillFilename, o.gemBillUploaded, o.freightCharges,
            o.packagingCost, o.commission, o.orderVerified, oi.remarks AS remarks, o.remarks AS orderRemarks, o.cancellationReason as cancelReason,
            o.cancelledBy, o.cancelledAt, o.isDeleted, o.rowColor, o.tags,
            ol.courierPartner, ol.trackingId, ol.logisticsStatus, ol.logisticsDispatchDate, ol.podFilename, ol.lastDeliveryDate,
            ins.installationRequired, ins.installationStatus, ins.technicianName, ins.technicianContact,
            ins.installationCharges, ins.installationRemarks, ins.scheduledDate, ins.installationDate,
            s.value as serialValue, s.landingPrice,
            m.name as modelName, m.company as companyName, m.category as modelCategory,
            p.paymentDate as paymentReceivedDate, p.amount as paymentReceivedAmount, p.utrId
        FROM order_items oi
        JOIN orders o ON oi.orderGuid = o.guid
        LEFT JOIN order_logistics ol ON o.guid = ol.orderGuid
        LEFT JOIN order_installations ins ON o.guid = ins.orderGuid
        LEFT JOIN serials s ON oi.serialNumberGuid = s.guid
        LEFT JOIN models m ON s.modelGuid = m.guid
        LEFT JOIN (
            SELECT p1.dispatchGuid, p1.paymentDate, p1.amount, p1.utrId
            FROM payments p1
            INNER JOIN (SELECT dispatchGuid, MAX(paymentDate) AS maxDate FROM payments GROUP BY dispatchGuid) p2
            ON p1.dispatchGuid = p2.dispatchGuid AND p1.paymentDate = p2.maxDate
        ) p ON oi.guid = p.dispatchGuid
        WHERE oi.guid = ?
      `, [guid]);

      if (rows.length === 0) return res.status(404).json({ message: "Dispatch not found" });
      res.json(mapDispatchRow(rows[0]));
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // 4. POST /api/dispatches
  app.post("/api/dispatches", requireAuth, authorizeDispatchRequest, async (req, res) => {
    let connection;
    try {
      const pool = await getMysqlPool();
      if (!pool) return res.status(500).json({ message: "MySQL not connected" });
      connection = await pool.getConnection();

      // ✅ FIXED: Correctly closed the destructuring block
      const {
        serialId, firmName, customer, customerName, address, shippingAddress, user,
        sellingPrice, status, orderVerified, gemOrderType, bidNumber, orderDate,
        lastDeliveryDate, gstNumber, contactNumber, altContactNumber, buyerEmail,
        consigneeEmail, consigneeName, contractFilename, installationRequired, installationStatus,
        technicianName, technicianContact, installationCharges, installationRemarks,
        scheduledDate, packagingCost, commission, courierPartner, logisticsDispatchDate,
        trackingId, freightCharges, logisticsStatus, podFilename, ewayBillFilename, remarks, warranty,
        invoiceNumber, invoiceDate, invoiceFilename, buyerAddress
      } = req.body;

      const safeCustomerName = safeStr(customerName || customer, "");
      
      // ✅ Prevent duplicate Order ID from being created
      if (safeCustomerName && safeCustomerName.toLowerCase() !== "n/a") {
        const [existing] = await connection.query(
          "SELECT guid FROM orders WHERE (orderid = ? OR customerName = ?) AND isDeleted = 0 LIMIT 1",
          [safeCustomerName, safeCustomerName]
        );
        if (existing.length > 0) {
          return res.status(400).json({ message: `Order ID "${safeCustomerName}" already exists in the system.` });
        }
      }

      const safeAddress = safeStr(address || shippingAddress, null);
      const safeShippingAddress = safeStr(shippingAddress || address, null);
      const finalStatus = normalizeBusinessStatus(status);
      const finalLogisticsStatus = normalizeLogisticsStatus(logisticsStatus);
      const installReqBit = toBit(installationRequired) ? "Yes" : "No";
      const installStatusBit = toBit(installationRequired) ? (installationStatus || "Pending") : null;

      // Create dispatch inline (no stored procedure — avoids collation issues)
      await connection.beginTransaction();
      const result = await createDispatchInline(connection, {
        serialId, firmName, customerName: safeCustomerName,
        address: safeAddress, shippingAddress: safeShippingAddress,
        user: user || "System", sellingPrice, status: finalStatus,
        orderVerified: orderVerified || "No", gemOrderType, bidNumber,
        orderDate, lastDeliveryDate, gstNumber, contactNumber, altContactNumber,
        buyerEmail, consigneeEmail, paymentAuthorityEmail: req.body.paymentAuthorityEmail,
        consigneeName, contractFilename: contractFilename || req.body.contractFile,
        installationRequired: installReqBit, installationStatus: installStatusBit,
        technicianName, technicianContact, installationCharges,
        installationRemarks, scheduledDate, packagingCost, commission,
        courierPartner, logisticsDispatchDate, trackingId,
        freightCharges, logisticsStatus: finalLogisticsStatus, podFilename, ewayBillFilename,
        remarks, warranty, buyerAddress
      }, helpers);

      if (!result.success) {
        await connection.rollback();
        return res.status(400).json({ message: result.message });
      }

      const dispatchGuid = result.dispatchGuid;
      const orderGuidForUpdate = result.orderId;

      // Save metadata to the Database directly
      if (req.body.paymentAuthorityEmail || invoiceNumber || invoiceDate || invoiceFilename) {
        let updateQ = "UPDATE orders SET ";
        let params = [];
        if (req.body.paymentAuthorityEmail) { updateQ += "paymentAuthorityEmail = ?, "; params.push(req.body.paymentAuthorityEmail); }
        if (invoiceNumber) { updateQ += "invoiceNumber = ?, "; params.push(invoiceNumber); }
        if (invoiceDate) { updateQ += "invoiceDate = ?, "; params.push(safeDate(invoiceDate)); }
        if (invoiceFilename) { updateQ += "invoiceFilename = ?, "; params.push(invoiceFilename); }
        if (params.length > 0) {
          updateQ = updateQ.slice(0, -2) + " WHERE guid = ?";
          params.push(orderGuidForUpdate);
          await connection.query(updateQ, params);
        }
      }

      await connection.commit();

      // TRIGGER NOTIFICATIONS FOR NEW DISPATCH
      try {
        const displayOrderId = safeCustomerName && safeCustomerName.toLowerCase() !== "n/a" ? safeCustomerName : 'TEMP';
        await createNotification(pool, {
            targetRole: 'Admin',
            title: 'New Dispatch Created',
            message: `A new dispatch order ${displayOrderId} has been created by ${user || "System"}.`,
            type: 'success',
            link: '/dispatch'
        });
      } catch (notifErr) {
        console.error("Error sending new order notification:", notifErr);
      }

      res.status(201).json({ message: "Dispatched successfully", dispatchGuid });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: err.message });
    } finally {
      if (connection) connection.release();
    }
  });

  // 5. POST /api/dispatches/bulk
  app.post("/api/dispatches/bulk", requireAuth, authorizeDispatchRequest, async (req, res) => {
    const { items } = req.body;
    let connection;

    try {
      const pool = await getMysqlPool();
      if (!pool) return res.status(500).json({ message: "MySQL not connected" });
      connection = await pool.getConnection();

      // ✅ Prevent duplicate Order ID for bulk shipments
      const firstCustomer = safeStr(items[0]?.customerName || items[0]?.customer, "");
      if (firstCustomer && firstCustomer.toLowerCase() !== "n/a") {
        const [existing] = await connection.query(
          "SELECT guid FROM orders WHERE (orderid = ? OR customerName = ?) AND isDeleted = 0 LIMIT 1",
          [firstCustomer, firstCustomer]
        );
        if (existing.length > 0) {
          return res.status(400).json({ message: `Order ID "${firstCustomer}" already exists in the system.` });
        }
      }

      await connection.beginTransaction();

      for (const item of items) {
        // Fetch model default packaging cost
        const [serialCheck] = await connection.query(
          "SELECT s.status, s.value AS serialValue, m.packagingCost AS modelDefaultCost" +
          " FROM serials s JOIN models m ON s.modelGuid COLLATE utf8mb4_unicode_ci = m.guid COLLATE utf8mb4_unicode_ci" +
          " WHERE s.guid = ?",
          [item.serialId]
        );

        if (serialCheck.length === 0) {
          await connection.rollback();
          return res.status(404).json({ message: `Serial ID ${item.serialId} not found` });
        }

        const serialData = serialCheck[0];
        const finalPackagingCost = (item.packagingCost !== undefined && item.packagingCost !== "" && item.packagingCost !== null)
          ? Number(item.packagingCost)
          : Number(serialData.modelDefaultCost || 0);

        const finalStatus = normalizeBusinessStatus(item.status || "Pending");
        const finalLogisticsStatus = normalizeLogisticsStatus(item.logisticsStatus);
        const installReqBit = toBit(item.installationRequired) ? "Yes" : "No";
        const installStatusBit = toBit(item.installationRequired) ? (item.installationStatus || "Pending") : null;

        const result = await createDispatchInline(connection, {
          serialId: item.serialId,
          firmName: item.firmName,
          customerName: safeStr(item.customerName || item.customer, ""),
          address: safeStr(item.address || item.shippingAddress, null),
          shippingAddress: safeStr(item.shippingAddress || item.address, null),
          user: item.user || "System",
          sellingPrice: item.sellingPrice || 0,
          status: finalStatus,
          orderVerified: item.orderVerified || "No",
          gemOrderType: item.orderType || item.gemOrderType || null,
          bidNumber: item.bidNo || item.bidNumber || null,
          orderDate: item.orderDate, lastDeliveryDate: item.lastDeliveryDate,
          gstNumber: item.gstNumber || null, contactNumber: item.contactNumber || null,
          altContactNumber: item.altContactNumber || null, buyerEmail: item.buyerEmail || null,
          consigneeEmail: item.consigneeEmail || null, paymentAuthorityEmail: item.paymentAuthorityEmail || null,
          consigneeName: item.consigneeName || null,
          contractFilename: item.contractFile || item.contractFilename || null,
          installationRequired: installReqBit, installationStatus: installStatusBit,
          technicianName: item.technicianName || null, technicianContact: item.technicianContact || null,
          installationCharges: item.installationCharges || 0, installationRemarks: item.installationRemarks || null,
          scheduledDate: item.scheduledDate, packagingCost: finalPackagingCost, commission: item.commission || 0,
          courierPartner: item.courierPartner || null, logisticsDispatchDate: item.logisticsDispatchDate,
          trackingId: item.trackingId || null, freightCharges: item.freightCharges || 0,
          logisticsStatus: finalLogisticsStatus, podFilename: item.podFilename || null,
          ewayBillFilename: item.ewayBillFilename || null, remarks: item.remarks || null,
          warranty: item.warranty || null, buyerAddress: safeStr(item.buyerAddress, null)
        }, helpers);

        if (!result.success) {
          await connection.rollback();
          return res.status(400).json({ message: `Failed for item ${item.serialId}: ${result.message}` });
        }

        const { dispatchGuid, orderId: itemOrderId } = result;

        // Update invoice/email metadata if provided
        let updateQ = "UPDATE orders SET ";
        let params = [];
        if (item.paymentAuthorityEmail) { updateQ += "paymentAuthorityEmail = ?, "; params.push(item.paymentAuthorityEmail); }
        if (item.invoiceNumber) { updateQ += "invoiceNumber = ?, "; params.push(item.invoiceNumber); }
        if (item.invoiceDate) { updateQ += "invoiceDate = ?, "; params.push(safeDate(item.invoiceDate)); }
        if (item.warrantyStartDate !== undefined) { updateQ += "warrantyStartDate = ?, "; params.push(safeDate(item.warrantyStartDate) || null); }
        if (item.invoiceFilename) { updateQ += "invoiceFilename = ?, "; params.push(item.invoiceFilename); }
        if (params.length > 0) {
          updateQ = updateQ.slice(0, -2) + " WHERE guid = ?";
          params.push(itemOrderId);
          await connection.query(updateQ, params);
        }
      }

      try {
        await createNotification(pool, {
            targetRole: 'Admin',
            title: 'Bulk Dispatch Created',
            message: `${items.length} new dispatch orders have been created.`,
            type: 'success',
            link: '/dispatch'
        });
      } catch (notifErr) {
        console.error("Error sending bulk order notification:", notifErr);
      }

      await connection.commit();
      res.json({ message: "Bulk Dispatch Successful" });
    } catch (err) {
      if (connection) await connection.rollback();
      console.error(err);
      res.status(500).json({ message: "Bulk dispatch failed.", error: err.message });
    } finally {
      if (connection) connection.release();
    }
  });

  // 6. PUT /api/dispatches/:guid
  app.put("/api/dispatches/:guid", requireAuth, authorizeDispatchRequest, async (req, res) => {
    try {
      const { guid } = req.params;
      const pool = await getMysqlPool();
      if (!pool) return res.status(500).json({ message: "MySQL not connected" });

      if (guid.startsWith('SO-')) {
        const { commission } = req.body;
        const [stockOutCheck] = await pool.query("SELECT * FROM inventorystockout WHERE stockOutId = ? AND isDeleted = 0", [guid]);
        if (stockOutCheck.length === 0) return res.status(404).json({ message: "Stock Out not found" });
        
        await pool.query("UPDATE inventorystockout SET commission = ? WHERE stockOutId = ?", [commission || 0, guid]);
        return res.json({ message: "Updated successfully" });
      }

      await updateDispatchItem(pool, guid, req.body, req.user?.username);
      res.json({ message: "Dispatch updated successfully" });
    } catch (err) {
      console.error("Update dispatch error:", err);
      res.status(500).json({ message: err.message });
    }
  });

  // 7. PUT /api/dispatches (Bulk Update)
  app.put("/api/dispatches", requireAuth, authorizeDispatchRequest, async (req, res) => {
    try {
      const { updates } = req.body;
      const pool = await getMysqlPool();
      if (!pool) return res.status(500).json({ message: "MySQL not connected" });

      if (!Array.isArray(updates)) {
        return res.status(400).json({ message: "updates must be an array" });
      }

      const results = { success: [], failed: [] };

      for (const update of updates) {
        try {
          const { id, ...fields } = update;
          if (!id) {
            results.failed.push("unknown");
            continue;
          }

          await updateDispatchItem(pool, id, fields, req.user?.username);
          results.success.push(id);
        } catch (err) {
          console.error("Bulk update item failed:", update?.id, err.message);
          results.failed.push(update.id || "unknown");
        }
      }

      res.json({ message: "Bulk update completed", results });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // 12. PUT /api/dispatches/:guid/appearance
  app.put("/api/dispatches/:guid/appearance", requireAuth, async (req, res) => {
    try {
      const { guid } = req.params;
      const { rowColor, tags } = req.body;
      const pool = await getMysqlPool();
      if (!pool) return res.status(500).json({ message: "MySQL not connected" });

      const [itemRows] = await pool.query("SELECT orderGuid FROM order_items WHERE guid = ?", [guid]);
      if (itemRows.length === 0) return res.status(404).json({ message: "Dispatch item not found" });

      await pool.query("UPDATE orders SET rowColor = ?, tags = ? WHERE guid = ?", [rowColor || null, tags || null, itemRows[0].orderGuid]);
      res.json({ message: "Appearance updated successfully" });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // 13. PUT /api/dispatches/batch/appearance
  app.put("/api/dispatches/batch/appearance", requireAuth, async (req, res) => {
    try {
      const { ids, rowColor, tags } = req.body;
      if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ message: "No IDs provided" });

      const pool = await getMysqlPool();
      if (!pool) return res.status(500).json({ message: "MySQL not connected" });

      const [itemRows] = await pool.query("SELECT DISTINCT orderGuid FROM order_items WHERE guid IN (?)", [ids]);
      if (itemRows.length > 0) {
        const orderGuids = itemRows.map(r => r.orderGuid);
        await pool.query("UPDATE orders SET rowColor = ?, tags = ? WHERE guid IN (?)", [rowColor || null, tags || null, orderGuids]);
      }

      res.json({ message: "Batch appearance updated successfully" });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // 8, 9, 10, 11 Cancel, Delete, Restore, Permanent Delete
  app.put("/api/dispatches/cancel", requireAuth, authorizeDispatchRequest, async (req, res) => {
    try {
      const { ids, reason, cancelledBy } = req.body;
      const pool = await getMysqlPool();
      const results = { success: [], failed: [] };
      for (const id of ids) {
        await pool.query("SET @resultMsg = '';");
        await pool.query("CALL sp_dispatch_cancel(?, ?, ?, @resultMsg);", [id, reason || "No reason", cancelledBy || req.user?.username || "Unknown"]);
        const [out] = await pool.query("SELECT @resultMsg as message");
        if (out[0].message === 'Success') results.success.push(id); else results.failed.push(id);
      }
      res.json({ message: "Cancellation completed", results });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.delete("/api/dispatches", requireAuth, authorizeDispatchRequest, async (req, res) => {
    try {
      const { ids, reason, cancelledBy } = req.body;
      const pool = await getMysqlPool();
      const idArray = Array.isArray(ids) ? ids : [ids];
      const results = { success: [], failed: [], errors: {} };
      const actor = cancelledBy || req.user?.username || "Unknown";
      const deleteReason = reason || "No reason";

      for (const id of idArray) {
        if (!id) { results.failed.push(id); results.errors[id] = 'No ID provided'; continue; }

        const conn = await pool.getConnection();
        try {
          // Find the order_items row
          const [[item]] = await conn.query(
            "SELECT oi.guid, oi.orderGuid, oi.serialNumberGuid, s.value as serialValue, o.platform, o.orderid FROM order_items oi LEFT JOIN serials s ON oi.serialNumberGuid=s.guid LEFT JOIN orders o ON oi.orderGuid=o.guid WHERE oi.guid=? LIMIT 1",
            [id]
          );
          if (!item) {
            results.failed.push(id);
            results.errors[id] = 'Dispatch Item not found';
            conn.release();
            continue;
          }

          await conn.beginTransaction();

          // Free the serial
          if (item.serialNumberGuid) {
            await conn.query("UPDATE serials SET status='Available' WHERE guid=?", [item.serialNumberGuid]);
          }

          // Remove any dependent rows first (FK constraints)
          await conn.query("DELETE FROM payments WHERE dispatchGuid=?", [id]);
          await conn.query("DELETE FROM orderdocuments WHERE dispatchGuid=?", [id]);

          // Delete the order_items row
          await conn.query("DELETE FROM order_items WHERE guid=?", [id]);

          // Record serial movement
          await conn.query(
            "INSERT INTO serialmovements (guid, serialNumberGuid, serialValue, dispatchGuid, actionType, status, platform, orderid, createdBy, notes, createdAt) VALUES (UUID(),?,?,?,'Deleted','Available',?,?,?,?,NOW())",
            [item.serialNumberGuid, item.serialValue || '', id, item.platform || '', item.orderid || '', actor, `Removed from order: ${deleteReason}`]
          );

          // Cancel parent order if no items remain
          const [[{ remaining }]] = await conn.query(
            "SELECT COUNT(*) as remaining FROM order_items WHERE orderGuid=?", [item.orderGuid]
          );
          if (remaining === 0) {
            await conn.query(
              "UPDATE orders SET isDeleted=1, status='Order Cancelled', cancellationReason=?, cancelledBy=?, cancelledAt=NOW() WHERE guid=?",
              [deleteReason, actor, item.orderGuid]
            );
          }

          await conn.commit();
          results.success.push(id);
        } catch (txErr) {
          await conn.rollback();
          results.failed.push(id);
          results.errors[id] = txErr.message;
        } finally {
          conn.release();
        }
      }
      res.json({ message: "Deletion completed", results });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.post("/api/dispatches/restore", requireAuth, authorizeDispatchRequest, async (req, res) => {
    try {
      const { ids } = req.body;
      const pool = await getMysqlPool();
      const idArray = Array.isArray(ids) ? ids : [ids];
      const results = { success: [], failed: [] };
      for (const id of idArray) {
        await pool.query("SET @resultMsg = '';");
        await pool.query("CALL sp_dispatch_restore(?, @resultMsg);", [id]);
        const [out] = await pool.query("SELECT @resultMsg as message");
        if (out[0].message === 'Success') results.success.push(id); else results.failed.push(id);
      }
      res.json({ message: "Restore completed", results });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.delete("/api/dispatches/permanent", requireAuth, authorizeDispatchRequest, async (req, res) => {
    try {
      const { ids } = req.body;
      const pool = await getMysqlPool();
      const idArray = Array.isArray(ids) ? ids : [ids];
      for (const id of idArray) {
        await pool.query("SET @resultMsg = '';");
        await pool.query("CALL sp_dispatch_permanent_delete(?, @resultMsg);", [id]);
      }
      res.json({ message: "Permanently deleted" });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });
}

module.exports = { setupDispatchRoutes };