// Extracted from inventoryRoutes.js — handlers unchanged.
const { v4: uuidv4 } = require('uuid');
const { upload } = require('../../middleware/upload');

function setupStockOutRoutes(app, getPool, requireAuth) {
  app.get('/Inventory/GetStockOutList', requireAuth, async (req, res) => {
    try {
      const { startDate, endDate } = req.query;
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 10;
      const offset = (page - 1) * limit;

      const pool = await getPool(res);
      if (!pool) return;

      let filterSql = "WHERE o.isDeleted = 0";
      const filterParams = [];
      if (startDate && endDate) {
        filterSql += " AND o.issueDate BETWEEN ? AND ?";
        filterParams.push(`${startDate} 00:00:00`, `${endDate} 23:59:59`);
      }

      // 1. Get total count
      const [countRows] = await pool.query(`SELECT COUNT(*) as total FROM inventorystockout o ${filterSql}`, filterParams);
      const totalRecords = countRows[0].total;

      // 2. Get paginated data
      const query = `
        SELECT o.*, d.issueQty, d.sellingPrice, v.variantName as variantCode, i.itemName 
        FROM inventorystockout o 
        JOIN inventorystockoutdetail d ON o.stockOutId = d.stockOutId 
        JOIN inventoryitemvariant v ON d.itemVariantId = v.itemVariantId 
        JOIN inventoryitemmaster i ON v.itemId = i.itemId 
        ${filterSql} 
        ORDER BY o.issueDate DESC 
        LIMIT ? OFFSET ?
      `;
      const params = [...filterParams, limit, offset];

      const [rows] = await pool.query(query, params);
      res.json({
        data: rows,
        total: totalRecords,
        page,
        limit,
        message: "Success"
      });
    } catch (err) {
      console.error("Error in GetStockOutList:", err);
      res.status(500).json({ message: err.message });
    }
  });

  app.get('/Inventory/ResolveBarcodeForStockOut', requireAuth, async (req, res) => {
    try {
      const pool = await getPool(res);
      if (!pool) return;
      const [rows] = await pool.query(`
        SELECT v.itemVariantId, v.variantName as variantCode, i.itemName, u.unitName, IFNULL(s.availablePCS, 0) as availableQty, i.isTrackable as isSerialItem, 0 as isCombo
        FROM inventoryvariantbarcode vb 
        JOIN inventoryitemvariant v ON vb.itemVariantId = v.itemVariantId 
        JOIN inventoryitemmaster i ON v.itemId = i.itemId 
        LEFT JOIN inventoryunitmaster u ON i.unitId = u.unitId 
        LEFT JOIN inventoryvariantstock s ON v.itemVariantId = s.itemVariantId 
        WHERE vb.barcode = ? AND v.isDeleted = 0
        
        UNION
        
        SELECT pv.itemVariantId, pv.variantName as variantCode, pi.itemName, 'Combo' as unitName, IFNULL(ps.availablePCS, 0) as availableQty, pi.isTrackable as isSerialItem, 1 as isCombo
        FROM inventoryvariantbarcode vb 
        JOIN inventoryitemvariant v ON vb.itemVariantId = v.itemVariantId 
        JOIN inventorycombomapping m ON v.itemVariantId = m.childVariantId 
        JOIN inventoryitemvariant pv ON m.parentVariantId = pv.itemVariantId 
        JOIN inventoryitemmaster pi ON pv.itemId = pi.itemId 
        LEFT JOIN inventoryvariantstock ps ON pv.itemVariantId = ps.itemVariantId 
        WHERE vb.barcode = ? AND m.isDeleted = 0 AND pv.isDeleted = 0
      `, [req.query.barcode, req.query.barcode]);

      // Fetch components for combos
      for (const row of rows) {
        if (row.isCombo === 1) {
          const [components] = await pool.query(
            "SELECT cv.variantName, m.quantity, u.unitName FROM inventorycombomapping m JOIN inventoryitemvariant cv ON m.childVariantId = cv.itemVariantId JOIN inventoryitemmaster ci ON cv.itemId = ci.itemId LEFT JOIN inventoryunitmaster u ON ci.unitId = u.unitId WHERE m.parentVariantId = ? AND m.isDeleted = 0",
            [row.itemVariantId]
          );
          row.components = components;
        }
      }

      res.json({ data: rows, message: "Success" });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.get('/Inventory/GetAvailableSerials', requireAuth, async (req, res) => {
    try {
      const { itemVariantId } = req.query;
      const pool = await getPool(res);
      if (!pool) return;
      const [rows] = await pool.query("SELECT serialId, serialNumber FROM inventorystockinserial WHERE itemVariantId = ? AND isDeleted = 0 AND serialId NOT IN (SELECT stockInSerialId FROM inventorystockoutserial WHERE isDeleted = 0)", [itemVariantId]);
      res.json({ data: rows, message: "Success" });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.post('/Inventory/UploadStockOutInvoice', requireAuth, upload.single('file'), (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ message: "No file uploaded" });
      res.json({ message: "Success", filePath: req.file.filename });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.post('/Inventory/UploadInvoice', requireAuth, upload.single('file'), (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ message: "No file uploaded" });
      res.json({ message: "Success", filePath: req.file.filename });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.post('/Inventory/SaveStockOut', requireAuth, async (req, res) => {
    try {
      const { RefNo, OrderId, TrackingId, IssueDate, IssuedBy, Items, invoiceFile, packingCost, freightCost, commission, platformId } = req.body;
      const pool = await getPool(res);
      if (!pool) return;
      const connection = await pool.getConnection();
      await connection.beginTransaction();
      try {
        const soId = `SO-${Date.now()}`;
        const formattedDate = IssueDate ? IssueDate.replace('T', ' ').slice(0, 19) : new Date().toISOString().replace('T', ' ').slice(0, 19);

        // Calculate total selling price
        const totalSellingPrice = Items.reduce((sum, item) => sum + (item.issueQty * (item.sellingPrice || 0)), 0);

        await connection.execute(
          "INSERT INTO inventorystockout (stockOutId, refNo, orderId, trackingId, issueDate, issuedBy, invoiceFile, packingCost, freightCost, commission, platformId, sellingPrice) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [soId, RefNo, OrderId, TrackingId, formattedDate, IssuedBy, invoiceFile || null, packingCost || 0, freightCost || 0, commission || 0, platformId || null, totalSellingPrice]
        );

        for (const item of Items) {
          const detId = uuidv4();
          await connection.execute(
            "INSERT INTO inventorystockoutdetail (stockOutDetailId, stockOutId, itemVariantId, issueQty, sellingPrice) VALUES (?, ?, ?, ?, ?)",
            [detId, soId, item.itemVariantId, item.issueQty, item.sellingPrice || 0]
          );

          if (item.serials && item.serials.length > 0) {
            for (const serial of item.serials) {
              await connection.execute(
                "INSERT INTO inventorystockoutserial (stockOutSerialId, stockOutDetailId, stockInSerialId, serialNumber) VALUES (?, ?, ?, ?)",
                [uuidv4(), detId, serial.stockInSerialId || serial, serial.serialNumber || null]
              );
            }
          }

          // Check if it is a combo
          const [comboComponents] = await connection.query(
            "SELECT childVariantId, quantity FROM inventorycombomapping WHERE parentVariantId = ? AND isDeleted = 0",
            [item.itemVariantId]
          );

          if (comboComponents.length > 0) {
            // It is a combo! Decrease stock of components
            for (const comp of comboComponents) {
              const totalChildQty = comp.quantity * item.issueQty;
              const [result] = await connection.execute(
                "UPDATE inventoryvariantstock SET availablePCS = availablePCS - ? WHERE itemVariantId = ?",
                [totalChildQty, comp.childVariantId]
              );
              if (result.affectedRows === 0) {
                throw new Error(`Stock record not found for component ${comp.childVariantId}`);
              }
            }
          } else {
            // It is a regular item! Decrease its stock directly
            const [result] = await connection.execute(
              "UPDATE inventoryvariantstock SET availablePCS = availablePCS - ? WHERE itemVariantId = ?",
              [Number(item.issueQty), item.itemVariantId]
            );
            if (result.affectedRows === 0) {
              throw new Error(`Stock record not found for item variant ${item.itemVariantId}`);
            }
          }
        }
        await connection.commit();
        res.json({ message: "Success", stockOutId: soId });
      } catch (err) { await connection.rollback(); throw err; } finally { connection.release(); }
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  // ==========================================
  // CURRENT STOCK
  // ==========================================
  app.get('/Inventory/GetCurrentStock', requireAuth, async (req, res) => {
    try {
      const { page = 1, limit = 10, brandId, search } = req.query;
      const offset = (page - 1) * limit;
      const pool = await getPool(res);
      if (!pool) return;

      let whereClause = "WHERE v.isDeleted = 0 AND i.itemName != 'SYSTEM_COMBOS' AND IFNULL(i.useSerialTab, 0) = 0 AND v.itemVariantId NOT IN (SELECT parentVariantId FROM inventorycombomapping WHERE isDeleted = 0)";
      let params = [];

      if (brandId && brandId !== "all") {
        whereClause += " AND i.brandId = ?";
        params.push(brandId);
      }

      if (search) {
        whereClause += " AND (i.itemName LIKE ? OR v.variantName LIKE ?)";
        params.push(`%${search}%`, `%${search}%`);
      }

      const [rows] = await pool.query(`
        SELECT v.itemVariantId, v.variantName, i.itemName, i.brandId, u.unitName, 
               IFNULL(s.availablePCS, 0) as availablePCS, 
               IFNULL(NULLIF(s.lastPurchaseRate, 0), IFNULL(s.avgPurchaseRate, 0)) as avgPurchaseRate,
               (IFNULL(s.availablePCS, 0) * IFNULL(NULLIF(s.lastPurchaseRate, 0), IFNULL(s.avgPurchaseRate, 0))) as totalValue
        FROM inventoryitemvariant v
        JOIN inventoryitemmaster i ON v.itemId = i.itemId
        LEFT JOIN inventoryunitmaster u ON i.unitId = u.unitId
        LEFT JOIN inventoryvariantstock s ON v.itemVariantId = s.itemVariantId
        ${whereClause}
        LIMIT ? OFFSET ?
      `, [...params, Number(limit), Number(offset)]);

      const [[{ total, totalValue, lowStockCount }]] = await pool.query(`
        SELECT 
          COUNT(*) as total, 
          SUM(IFNULL(s.availablePCS, 0) * IFNULL(NULLIF(s.lastPurchaseRate, 0), IFNULL(s.avgPurchaseRate, 0))) as totalValue,
          COUNT(CASE WHEN IFNULL(s.availablePCS, 0) < 10 THEN 1 END) as lowStockCount
        FROM inventoryitemvariant v
        JOIN inventoryitemmaster i ON v.itemId = i.itemId
        LEFT JOIN inventoryvariantstock s ON v.itemVariantId = s.itemVariantId
        ${whereClause}
      `, params);

      res.json({
        data: rows,
        total,
        totalValue: totalValue || 0,
        lowStockCount: lowStockCount || 0,
        message: "Success"
      });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.post('/Inventory/ParseInvoice', requireAuth, upload.single('invoice'), (req, res) => {
    res.json({ message: "Success", data: { items: [] } });
  });

  // Appearance Update for Stock In / Stock Out
  app.put('/Inventory/UpdateAppearance', requireAuth, async (req, res) => {
    try {
      const { type, id, rowColor, tags } = req.body;
      const pool = await getPool(res);
      if (!pool) return;

      const table = type === 'in' ? 'inventorystockin' :
        type === 'stationery_return' ? 'inventorystationeryreturns' :
          'inventorystockout';

      const idColumn = type === 'in' ? 'stockInId' :
        type === 'stationery_return' ? 'returnId' :
          'stockOutId';

      await pool.query(`UPDATE ${table} SET rowColor = ?, tags = ? WHERE ${idColumn} = ?`, [rowColor || null, tags || null, id]);

      res.json({ message: "Appearance updated successfully" });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });
}

module.exports = { setupStockOutRoutes };
