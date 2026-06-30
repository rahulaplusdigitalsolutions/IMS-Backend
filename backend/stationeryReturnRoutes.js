const { v4: uuidv4 } = require('uuid');

async function setupStationeryReturnRoutes(app, getPool, requireAuth) {
  
  // Initialize Table
  (async () => {
    try {
      const pool = await getPool();
      if (!pool) return;
      await pool.query(`
        CREATE TABLE IF NOT EXISTS inventorystationeryreturns (
          returnId VARCHAR(50) PRIMARY KEY,
          stockOutId VARCHAR(50),
          trackingId VARCHAR(100),
          isSameItemReceived TINYINT(1) DEFAULT 1,
          isConditionCorrect TINYINT(1) DEFAULT 1,
          originalItemSent TEXT,
          itemReceivedInstead TEXT,
          isCompensationReceived TINYINT(1) DEFAULT 0,
          compensationAmount DECIMAL(18, 2) DEFAULT 0,
          remarks TEXT,
          isDeleted TINYINT(1) DEFAULT 0,
          createdBy VARCHAR(50),
          createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
          updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
      `);
      console.log("✅ InventoryStationeryReturns table checked/created");
    } catch (err) {
      console.error("🔴 Failed to initialize InventoryStationeryReturns table:", err.message);
    }
  })();

  // Universal Search order by Tracking ID, Order ID, or Bill No
  app.get('/Inventory/SearchOrderForReturn', requireAuth, async (req, res) => {
    try {
      let { query } = req.query;
      if (!query) return res.status(400).json({ message: "Search query required" });
      query = query.trim();

      const decodedQuery = decodeURIComponent(query);
      const pool = await getPool(res);
      if (!pool) return;

      // 1. Search in NEW Inventory System (InventoryStockOut)
      const [inventoryOrders] = await pool.query(`
        SELECT 
            o.stockOutId, o.refNo, o.orderId, o.trackingId, o.issueDate, o.issuedBy,
            d.stockOutDetailId, d.itemVariantId, d.issueQty,
            v.variantName, i.itemName
        FROM inventorystockout o
        JOIN inventorystockoutdetail d ON o.stockOutId = d.stockOutId
        JOIN inventoryitemvariant v ON d.itemVariantId = v.itemVariantId
        JOIN inventoryitemmaster i ON v.itemId = i.itemId
        WHERE (o.refNo LIKE ? OR o.orderId = ? OR o.trackingId = ? OR o.stockOutId = ?) AND o.isDeleted = 0
      `, [`%${decodedQuery}%`, decodedQuery, decodedQuery, decodedQuery]);

      if (inventoryOrders.length > 0) {
        // Group by order
        const result = {
          stockOutId: inventoryOrders[0].stockOutId,
          refNo: inventoryOrders[0].refNo || inventoryOrders[0].orderId || inventoryOrders[0].trackingId,
          issueDate: inventoryOrders[0].issueDate,
          issuedBy: inventoryOrders[0].issuedBy,
          source: 'inventory',
          items: inventoryOrders.map(o => ({
            detailId: o.stockOutDetailId,
            variantId: o.itemVariantId,
            variantName: o.variantName,
            itemName: o.itemName,
            quantity: o.issueQty
          }))
        };
        return res.json({ data: result });
      }

      // 2. Search in LEGACY System (Dispatches - now order_items/orders)
      // We search invoiceNumber, trackingId, serial number (sn.value), E-Way Bill, or id
      const [legacyOrders] = await pool.query(`
        SELECT
            oi.guid as dispatchGuid, o.invoiceNumber, ol.trackingId, o.dispatchDate, o.platform as firmName, o.orderid as customerName,
            sn.value as serialNumber, m.name as modelName, o.ewayBillNumber
        FROM order_items oi
        JOIN orders o ON oi.orderGuid = o.guid
        LEFT JOIN order_logistics ol ON o.guid = ol.orderGuid
        LEFT JOIN serials sn ON oi.serialNumberGuid = sn.guid
        LEFT JOIN models m ON sn.modelGuid = m.guid
        WHERE (o.invoiceNumber LIKE ? OR ol.trackingId LIKE ? OR sn.value = ? OR o.ewayBillNumber = ? OR CAST(oi.guid AS CHAR) = ?) AND o.isDeleted = 0
      `, [`%${decodedQuery}%`, `%${decodedQuery}%`, decodedQuery, decodedQuery, decodedQuery]);

      if (legacyOrders.length > 0) {
        const result = {
          stockOutId: `LEGACY-${legacyOrders[0].dispatchGuid}`,
          refNo: `Bill: ${legacyOrders[0].invoiceNumber || 'N/A'} | Track: ${legacyOrders[0].trackingId || 'N/A'}`,
          issueDate: legacyOrders[0].dispatchDate,
          issuedBy: legacyOrders[0].firmName || legacyOrders[0].customerName,
          source: 'legacy',
          items: legacyOrders.map(o => ({
            detailId: o.dispatchGuid,
            variantId: null,
            variantName: o.modelName || 'N/A',
            itemName: o.serialNumber ? `Serial: ${o.serialNumber}` : 'Legacy Item',
            quantity: 1
          }))
        };
        return res.json({ data: result });
      }

      // 3. Search by Serial Number in Inventory (NEW)
      const [serialMatch] = await pool.query(`
        SELECT 
            o.stockOutId, o.refNo, o.issueDate, o.issuedBy,
            d.stockOutDetailId, d.itemVariantId, d.issueQty,
            v.variantName, i.itemName
        FROM inventorystockoutserial ss
        LEFT JOIN inventorystockinserial sis ON ss.stockInSerialId = sis.serialId
        JOIN inventorystockoutdetail d ON ss.stockOutDetailId = d.stockOutDetailId
        JOIN inventorystockout o ON d.stockOutId = o.stockOutId
        JOIN inventoryitemvariant v ON d.itemVariantId = v.itemVariantId
        JOIN inventoryitemmaster i ON v.itemId = i.itemId
        WHERE (ss.serialNumber = ? OR sis.serialNumber = ?) AND o.isDeleted = 0
      `, [decodedQuery, decodedQuery]);

      if (serialMatch.length > 0) {
        const result = {
          stockOutId: serialMatch[0].stockOutId,
          refNo: serialMatch[0].refNo,
          issueDate: serialMatch[0].issueDate,
          issuedBy: serialMatch[0].issuedBy,
          source: 'inventory-serial',
          items: serialMatch.map(o => ({
            detailId: o.stockOutDetailId,
            variantId: o.itemVariantId,
            variantName: o.variantName,
            itemName: o.itemName,
            quantity: o.issueQty
          }))
        };
        return res.json({ data: result });
      }

      // 4. Search in Bulk Orders System
      const [bulkOrders] = await pool.query(`
        SELECT
            bo.guid as bulkOrderId, bo.customerName, bo.firmName, bo.createdAt,
            bod.trackingId, boi.invoiceNumber, boi.ewayBillNumber
        FROM bulkorders bo
        LEFT JOIN bulkorderdispatches bod ON bo.guid = bod.orderGuid
        LEFT JOIN bulkorderinvoices boi ON bo.guid = boi.orderGuid
        WHERE bod.trackingId = ? OR boi.invoiceNumber = ? OR boi.ewayBillNumber = ? OR bo.guid = ?
      `, [decodedQuery, decodedQuery, decodedQuery, decodedQuery]);

      if (bulkOrders.length > 0) {
        const [bulkItems] = await pool.query(`
            SELECT bi.serialNumberGuid, s.value as serialNumber, m.name as modelName
            FROM bulkorderitems bi
            JOIN serials s ON bi.serialNumberGuid = s.guid
            JOIN models m ON s.modelGuid = m.guid
            WHERE bi.orderGuid = ? AND bi.itemStatus = 'Active'
        `, [bulkOrders[0].bulkOrderId]);

        const result = {
          stockOutId: `BULK-${bulkOrders[0].bulkOrderId}`,
          refNo: `Bulk Order: ${bulkOrders[0].invoiceNumber || bulkOrders[0].trackingId || bulkOrders[0].bulkOrderId}`,
          issueDate: bulkOrders[0].createdAt,
          issuedBy: bulkOrders[0].firmName || bulkOrders[0].customerName,
          source: 'bulk',
          items: bulkItems.map(item => ({
            detailId: `BULK-ITEM-${item.serialNumberGuid}`,
            variantId: null,
            variantName: item.modelName,
            itemName: `Serial: ${item.serialNumber}`,
            quantity: 1
          }))
        };
        return res.json({ data: result });
      }

      // 5. Search by Barcode (Universal)
      const [barcodeMatch] = await pool.query(`
        SELECT 
            o.stockOutId, o.refNo, o.issueDate, o.issuedBy,
            d.stockOutDetailId, d.itemVariantId, d.issueQty,
            v.variantName, i.itemName
        FROM inventoryvariantbarcode vb
        JOIN inventorystockoutdetail d ON vb.itemVariantId = d.itemVariantId
        JOIN inventorystockout o ON d.stockOutId = o.stockOutId
        JOIN inventoryitemvariant v ON d.itemVariantId = v.itemVariantId
        JOIN inventoryitemmaster i ON v.itemId = i.itemId
        WHERE vb.barcode = ? AND o.isDeleted = 0
        ORDER BY o.issueDate DESC LIMIT 1
      `, [decodedQuery]);

      if (barcodeMatch.length > 0) {
        const result = {
          stockOutId: barcodeMatch[0].stockOutId,
          refNo: barcodeMatch[0].refNo,
          issueDate: barcodeMatch[0].issueDate,
          issuedBy: barcodeMatch[0].issuedBy,
          source: 'inventory-barcode',
          items: [{
            detailId: barcodeMatch[0].stockOutDetailId,
            variantId: barcodeMatch[0].itemVariantId,
            variantName: barcodeMatch[0].variantName,
            itemName: barcodeMatch[0].itemName,
            quantity: barcodeMatch[0].issueQty
          }]
        };
        return res.json({ data: result });
      }

      res.status(404).json({ message: "No order found with this Tracking ID, Order ID, or Bill No" });
    } catch (err) {
      console.error("SearchOrderForReturn Error:", err);
      res.status(500).json({ message: err.message });
    }
  });

  // Save Stationery Return
  app.post('/Inventory/SaveStationeryReturn', requireAuth, async (req, res) => {
    try {
      const {
        stockOutId,
        trackingId,
        isSameItemReceived,
        isConditionCorrect,
        originalItemSent,
        itemReceivedInstead,
        isCompensationReceived,
        compensationAmount,
        remarks
      } = req.body;

      const pool = await getPool(res);
      if (!pool) return;

      const connection = await pool.getConnection();
      await connection.beginTransaction();

      try {
        const returnId = `SR-${Date.now()}`;
        const user = req.user?.username || 'System';

        await connection.execute(`
          INSERT INTO inventorystationeryreturns (
            returnId, stockOutId, trackingId, isSameItemReceived, isConditionCorrect,
            originalItemSent, itemReceivedInstead, isCompensationReceived, 
            compensationAmount, remarks, createdBy
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          returnId, stockOutId, trackingId || '', 
          isSameItemReceived ? 1 : 0, 
          isConditionCorrect ? 1 : 0,
          originalItemSent || '', 
          itemReceivedInstead || '', 
          isCompensationReceived ? 1 : 0,
          compensationAmount || 0, 
          remarks || '',
          user
        ]);

        await connection.commit();
        res.json({ message: "Success", returnId });
      } catch (e) {
        await connection.rollback();
        throw e;
      } finally {
        connection.release();
      }
    } catch (err) {
      console.error("SaveStationeryReturn Error:", err);
      res.status(500).json({ message: err.message });
    }
  });

  // Get Stationery Returns History
  app.get('/Inventory/GetStationeryReturnsHistory', requireAuth, async (req, res) => {
    try {
      const pool = await getPool(res);
      if (!pool) return;

      const [rows] = await pool.query(`
        SELECT 
          r.*,
          COALESCE(o.issuedBy, 'Legacy/Bulk') as customerName,
          'Internal' as firmName,
          o.issueDate as dispatchDate
        FROM inventorystationeryreturns r
        LEFT JOIN inventorystockout o ON r.stockOutId = o.stockOutId
        WHERE r.isDeleted = 0 
        ORDER BY r.createdAt DESC
      `);
      res.json({ data: rows });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // Update Compensation for Stationery Return
  app.post('/Inventory/UpdateStationeryCompensation', requireAuth, async (req, res) => {
    try {
      const { returnId, isCompensationReceived, compensationAmount, remarks } = req.body;
      const pool = await getPool(res);
      if (!pool) return;

      await pool.execute(`
        UPDATE inventorystationeryreturns 
        SET isCompensationReceived = ?, 
            compensationAmount = ?, 
            remarks = COALESCE(?, remarks)
        WHERE returnId = ?
      `, [isCompensationReceived ? 1 : 0, compensationAmount || 0, remarks || null, returnId]);

      res.json({ message: "Success" });
    } catch (err) {
      console.error("UpdateStationeryCompensation Error:", err);
      res.status(500).json({ message: err.message });
    }
  });
}

module.exports = { setupStationeryReturnRoutes };
