// Extracted from inventoryRoutes.js — handlers unchanged.
const { v4: uuidv4 } = require('uuid');

function setupStockInRoutes(app, getPool, requireAuth) {
  app.get('/Inventory/GetStockInCounts', requireAuth, async (req, res) => {
    try {
      const pool = await getPool(res);
      if (!pool) return;
      const [drafts] = await pool.query("SELECT COUNT(*) as count FROM inventorystockin WHERE status = 0 AND isDeleted = 0");
      const [finalized] = await pool.query("SELECT COUNT(*) as count FROM inventorystockin WHERE status = 1 AND isDeleted = 0");
      res.json({ draftCount: drafts[0].count, finalizedCount: finalized[0].count });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.get('/Inventory/GetStockInList', requireAuth, async (req, res) => {
    try {
      const { status, startDate, endDate } = req.query;
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 10;
      const offset = (page - 1) * limit;

      const pool = await getPool(res);
      if (!pool) return;

      // Base filters
      let filterSql = "WHERE s.status = ? AND s.isDeleted = 0";
      const filterParams = [status];
      if (startDate && endDate) {
        filterSql += " AND s.invoiceDate BETWEEN ? AND ?";
        filterParams.push(`${startDate} 00:00:00`, `${endDate} 23:59:59`);
      }

      // 1. Get total count for pagination
      const [countRows] = await pool.query(`SELECT COUNT(*) as total FROM inventorystockin s ${filterSql}`, filterParams);
      const totalRecords = countRows[0].total;

      // 2. Get paginated data
      let query = `
        SELECT s.*, v.vendorFirmName as vendorName, 
               IFNULL(SUM(d.stockInQty), 0) as totalQty,
               IFNULL(SUM(d.stockInQty * d.purchaseRate), 0) as totalAmount,
               GROUP_CONCAT(DISTINCT IFNULL(i.itemName, m.name) SEPARATOR ', ') as itemNames,
               COUNT(DISTINCT d.stockInDetailId) as itemTypeCount
        FROM inventorystockin s 
        LEFT JOIN inventoryvendor v ON s.vendorId = v.vendorId 
        LEFT JOIN inventorystockindetail d ON s.stockInId = d.stockInId AND d.isDeleted = 0
        LEFT JOIN inventoryitemvariant iv ON d.itemVariantId = iv.itemVariantId
        LEFT JOIN inventoryitemmaster i ON iv.itemId = i.itemId
        LEFT JOIN models m ON d.modelGuid = m.guid
        ${filterSql}
        GROUP BY s.stockInId 
        ORDER BY s.invoiceDate DESC 
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
      console.error("Error in GetStockInList:", err);
      res.status(500).json({ message: err.message });
    }
  });

  app.get('/Inventory/GetLastDraftStockIn', requireAuth, async (req, res) => {
    try {
      const pool = await getPool(res);
      if (!pool) return;
      const [rows] = await pool.query("SELECT * FROM inventorystockin WHERE status = 0 AND isDeleted = 0 ORDER BY createdAt DESC LIMIT 1");
      res.json({ data: rows, message: "Success" });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.get('/Inventory/GetStockInDetails', requireAuth, async (req, res) => {
    try {
      const { stockInId } = req.query;
      const pool = await getPool(res);
      if (!pool) return;
      const [rows] = await pool.query(`
        SELECT
          d.stockInDetailId, d.stockInId, d.itemVariantId, d.modelGuid, d.godownGuid, d.unitId, d.barcode,
          IFNULL(d.stockInQty, 0) as qty, IFNULL(d.defaultPcsQty, 1) as pcs, IFNULL(d.purchaseRate, 0) as rate,
          IFNULL((d.stockInQty * d.purchaseRate), 0) as amount,
          IFNULL(v.variantName, m.name) as variantCode,
          IFNULL(i.itemName, m.name) as itemName,
          IFNULL(u.unitName, '') as unitName,
          IF(d.modelGuid IS NOT NULL, 1, i.isTrackable) as hasSerialNumber,
          (SELECT COUNT(*) FROM inventorystockinserial iss WHERE iss.stockInDetailId = d.stockInDetailId AND iss.isDeleted = 0) as serialCount,
          s.vendorId, s.invoiceNo, s.invoiceDate, s.invoiceFile, s.status as stockInStatus
        FROM inventorystockindetail d
        JOIN inventorystockin s ON d.stockInId = s.stockInId
        LEFT JOIN inventoryitemvariant v ON d.itemVariantId = v.itemVariantId
        LEFT JOIN inventoryitemmaster i ON v.itemId = i.itemId
        LEFT JOIN inventoryunitmaster u ON d.unitId = u.unitId
        LEFT JOIN models m ON d.modelGuid = m.guid
        WHERE d.stockInId = ? AND d.isDeleted = 0
      `, [stockInId]);
      res.json({ data: rows, message: "Success" });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.get('/Inventory/LookupBarcode', requireAuth, async (req, res) => {
    try {
      const { code } = req.query;
      const pool = await getPool(res);
      if (!pool) return;
      const [rows] = await pool.query(`
        SELECT
          NULL as itemVariantId,
          m.name as variantCode,
          m.name as itemName,
          NULL as unitName,
          1 as hasSerialNumber,
          IFNULL(m.mrp, 0) as lastPurchaseRate,
          m.guid as modelGuid,
          1 as isModelItem
        FROM models m
        WHERE m.barcode = ? AND m.isDeleted = 0

        UNION ALL

        SELECT
          vb.itemVariantId,
          v.variantName as variantCode,
          i.itemName,
          u.unitName,
          i.isTrackable as hasSerialNumber,
          IFNULL(s.lastPurchaseRate, 0) as lastPurchaseRate,
          NULL as modelGuid,
          0 as isModelItem
        FROM inventoryvariantbarcode vb
        JOIN inventoryitemvariant v ON vb.itemVariantId = v.itemVariantId
        JOIN inventoryitemmaster i ON v.itemId = i.itemId
        LEFT JOIN inventoryunitmaster u ON i.unitId = u.unitId
        LEFT JOIN inventoryvariantstock s ON v.itemVariantId = s.itemVariantId
        WHERE vb.barcode = ? AND v.isDeleted = 0
      `, [code, code]);
      res.json({ data: rows, message: "Success" });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.post('/Inventory/DeleteStockInDetail', requireAuth, async (req, res) => {
    try {
      const { detailId } = req.body;
      const pool = await getPool(res);
      if (!pool) return;
      await pool.execute("UPDATE inventorystockindetail SET isDeleted = 1 WHERE stockInDetailId = ?", [detailId]);
      res.json({ message: "Success" });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.post('/Inventory/DeleteStockIn', requireAuth, async (req, res) => {
    try {
      const { stockInId } = req.body;
      const pool = await getPool(res);
      if (!pool) return;
      const connection = await pool.getConnection();
      await connection.beginTransaction();
      try {
        await connection.execute("UPDATE inventorystockin SET isDeleted = 1 WHERE stockInId = ?", [stockInId]);
        await connection.execute("UPDATE inventorystockindetail SET isDeleted = 1 WHERE stockInId = ?", [stockInId]);
        await connection.commit();
        res.json({ message: "Success" });
      } catch (err) { await connection.rollback(); throw err; } finally { connection.release(); }
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.post('/Inventory/SaveStockInDraft', requireAuth, async (req, res) => {
    try {
      const {
        StockInId, StockInDetailId, VendorId, InvoiceNo, InvoiceDate,
        ItemVariantId, modelGuid, godownGuid, UnitId, Barcode, StockInQty,
        DefaultPcsQty, FinalPcsQty, PurchaseRate,
        Remarks, InvoiceFile
      } = req.body;

      if (!StockInId) return res.status(400).json({ message: "StockInId is required" });
      if (!ItemVariantId && !modelGuid) return res.status(400).json({ message: "ItemVariantId or modelGuid is required" });

      const pool = await getPool(res);
      if (!pool) return;
      const connection = await pool.getConnection();
      await connection.beginTransaction();
      try {
        const sanitizedInvoiceDate = InvoiceDate && InvoiceDate.trim() !== "" ? InvoiceDate : null;
        const sanitizedVendorId = VendorId && VendorId.trim() !== "" ? VendorId : null;

        // Use INSERT IGNORE + UPDATE to avoid race condition ER_DUP_ENTRY
        // when the frontend fires multiple rapid saves with the same StockInId
        await connection.execute(
          "INSERT IGNORE INTO inventorystockin (stockInId, vendorId, invoiceNo, invoiceDate, remarks, invoiceFile, status) VALUES (?, ?, ?, ?, ?, ?, 0)",
          [StockInId, sanitizedVendorId, InvoiceNo || null, sanitizedInvoiceDate, Remarks || null, InvoiceFile || null]
        );
        // Always update the header fields in case they changed
        await connection.execute(
          "UPDATE inventorystockin SET vendorId = ?, invoiceNo = ?, invoiceDate = ?, remarks = ?, invoiceFile = ? WHERE stockInId = ? AND status = 0",
          [sanitizedVendorId, InvoiceNo || null, sanitizedInvoiceDate, Remarks || null, InvoiceFile || null, StockInId]
        );

        let currentDetailId = StockInDetailId;
        if (currentDetailId && currentDetailId !== "null") {
          await connection.execute(
            "UPDATE inventorystockindetail SET itemVariantId = ?, modelGuid = ?, godownGuid = ?, unitId = ?, barcode = ?, stockInQty = ?, defaultPcsQty = ?, finalPcsQty = ?, purchaseRate = ? WHERE stockInDetailId = ?",
            [ItemVariantId || null, modelGuid || null, godownGuid || null, UnitId || null, Barcode || null, StockInQty || 0, DefaultPcsQty || 1, FinalPcsQty || 0, PurchaseRate || 0, currentDetailId]
          );
        } else {
          // Hardening: Check if this variant/unit already exists in this stockIn (prevents race condition duplicates)
          const [dup] = await connection.query(
            "SELECT stockInDetailId FROM inventorystockindetail WHERE stockInId = ? AND (itemVariantId = ? OR modelGuid = ?) AND unitId <=> ? AND isDeleted = 0 LIMIT 1",
            [StockInId, ItemVariantId || 'N/A', modelGuid || 'N/A', UnitId || null]
          );

          if (dup.length > 0) {
            currentDetailId = dup[0].stockInDetailId;
            await connection.execute(
              "UPDATE inventorystockindetail SET barcode = ?, godownGuid = COALESCE(?, godownGuid), stockInQty = ?, defaultPcsQty = ?, finalPcsQty = ?, purchaseRate = ? WHERE stockInDetailId = ?",
              [Barcode || null, godownGuid || null, StockInQty || 0, DefaultPcsQty || 1, FinalPcsQty || 0, PurchaseRate || 0, currentDetailId]
            );
          } else {
            currentDetailId = uuidv4();
            await connection.execute(
              "INSERT INTO inventorystockindetail (stockInDetailId, stockInId, itemVariantId, modelGuid, godownGuid, unitId, barcode, stockInQty, defaultPcsQty, finalPcsQty, purchaseRate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
              [currentDetailId, StockInId, ItemVariantId || null, modelGuid || null, godownGuid || null, UnitId || null, Barcode || null, StockInQty || 0, DefaultPcsQty || 1, FinalPcsQty || 0, PurchaseRate || 0]
            );
          }
        }

        // Calculate Totals for the main record
        const [totals] = await connection.query(
          "SELECT SUM(stockInQty) as totalQty, SUM(stockInQty * purchaseRate) as totalAmount FROM inventorystockindetail WHERE stockInId = ? AND isDeleted = 0",
          [StockInId]
        );
        await connection.execute(
          "UPDATE inventorystockin SET totalAmount = ? WHERE stockInId = ?",
          [totals[0].totalAmount || 0, StockInId]
        );

        await connection.commit();
        res.json({ message: "Success", data: { stockInDetailId: currentDetailId } });
      } catch (err) {
        await connection.rollback();
        console.error("Error in SaveStockInDraft transaction:", err);
        throw err;
      } finally {
        connection.release();
      }
    } catch (err) {
      console.error("Error in SaveStockInDraft route:", err);
      res.status(500).json({ message: err.message });
    }
  });

  app.post('/Inventory/FinalizeStockIn', requireAuth, async (req, res) => {
    try {
      const { stockInId } = req.body;
      const pool = await getPool(res);
      if (!pool) return;
      const connection = await pool.getConnection();
      await connection.beginTransaction();
      try {
        await connection.execute("UPDATE inventorystockin SET status = 1, finalizedOn = CURRENT_TIMESTAMP WHERE stockInId = ?", [stockInId]);
        // Fetch vendorId for traceability on serials
        const [stockInRows] = await connection.query("SELECT vendorId FROM inventorystockin WHERE stockInId = ?", [stockInId]);
        const stockInVendorId = stockInRows[0]?.vendorId || null;
        const [details] = await connection.query(`
          SELECT d.*, i.useSerialTab
          FROM inventorystockindetail d
          LEFT JOIN inventoryitemvariant v ON d.itemVariantId = v.itemVariantId
          LEFT JOIN inventoryitemmaster i ON v.itemId = i.itemId
          WHERE d.stockInId = ? AND d.isDeleted = 0
        `, [stockInId]);
        for (const item of details) {
          if (item.modelGuid) {
            // Printer model — always goes to serials table
            const [serials] = await connection.query("SELECT serialNumber FROM inventorystockinserial WHERE stockInDetailId = ? AND isDeleted = 0", [item.stockInDetailId]);
            for (const s of serials) {
              await connection.execute(
                "INSERT INTO serials (guid, modelGuid, godownGuid, value, landingPrice, vendorId, stockInId, status, isDeleted, createdAt) VALUES (UUID(), ?, ?, ?, ?, ?, ?, 'Available', 0, NOW())",
                [item.modelGuid, item.godownGuid || null, s.serialNumber, item.purchaseRate || 0, stockInVendorId, stockInId]
              );
            }
          } else if (item.itemVariantId) {
            const [itemSerials] = await connection.query("SELECT serialNumber FROM inventorystockinserial WHERE stockInDetailId = ? AND isDeleted = 0", [item.stockInDetailId]);
            if (item.useSerialTab && itemSerials.length > 0) {
              // useSerialTab=1 item with serials → goes to Serials tab
              // Use approved model guid if this variant was linked to an approved model, so the count shows in Models tab
              const [modelLink] = await connection.query(
                "SELECT linkedModelGuid FROM model_approval_requests WHERE variantId = ? AND status = 'approved' AND linkedModelGuid IS NOT NULL AND isDeleted = 0 LIMIT 1",
                [item.itemVariantId]
              );
              const serialModelGuid = (modelLink.length > 0 && modelLink[0].linkedModelGuid) ? modelLink[0].linkedModelGuid : item.itemVariantId;
              for (const s of itemSerials) {
                await connection.execute(
                  "INSERT INTO serials (guid, modelGuid, godownGuid, value, landingPrice, vendorId, stockInId, status, isDeleted, createdAt) VALUES (UUID(), ?, ?, ?, ?, ?, ?, 'Available', 0, NOW())",
                  [serialModelGuid, item.godownGuid || null, s.serialNumber, item.purchaseRate || 0, stockInVendorId, stockInId]
                );
              }
            } else {
              // Regular item → update Current Stock quantity
              const qty = item.stockInQty * item.defaultPcsQty;
              await connection.execute("INSERT INTO inventoryvariantstock (itemVariantId, availablePCS, avgPurchaseRate, lastPurchaseRate) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE availablePCS = availablePCS + VALUES(availablePCS), lastPurchaseRate = VALUES(lastPurchaseRate)", [item.itemVariantId, qty, item.purchaseRate, item.purchaseRate]);
            }
          }
        }
        await connection.commit();
        res.json({ message: "Success" });
      } catch (err) { await connection.rollback(); throw err; } finally { connection.release(); }
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.post('/Inventory/RevertStockIn', requireAuth, async (req, res) => {
    try {
      const { stockInId } = req.body;
      const pool = await getPool(res);
      if (!pool) return;
      const connection = await pool.getConnection();
      await connection.beginTransaction();
      try {
        const [details] = await connection.query(`
          SELECT d.*, i.useSerialTab
          FROM inventorystockindetail d
          LEFT JOIN inventoryitemvariant v ON d.itemVariantId = v.itemVariantId
          LEFT JOIN inventoryitemmaster i ON v.itemId = i.itemId
          WHERE d.stockInId = ? AND d.isDeleted = 0
        `, [stockInId]);

        for (const item of details) {
          if (item.modelGuid) {
            const [serials] = await connection.query("SELECT serialNumber FROM inventorystockinserial WHERE stockInDetailId = ? AND isDeleted = 0", [item.stockInDetailId]);
            for (const s of serials) {
              const [check] = await connection.query("SELECT status FROM serials WHERE value = ? AND isDeleted = 0 LIMIT 1", [s.serialNumber]);
              if (check.length > 0 && check[0].status !== 'Available') {
                throw new Error(`Cannot revert: Serial ${s.serialNumber} is already ${check[0].status}.`);
              }
              await connection.execute("DELETE FROM serials WHERE value = ? AND isDeleted = 0", [s.serialNumber]);
            }
          } else if (item.itemVariantId) {
            const [itemSerials] = await connection.query("SELECT serialNumber FROM inventorystockinserial WHERE stockInDetailId = ? AND isDeleted = 0", [item.stockInDetailId]);
            if (item.useSerialTab && itemSerials.length > 0) {
              // useSerialTab=1 — remove from serials table
              for (const s of itemSerials) {
                const [check] = await connection.query("SELECT status FROM serials WHERE value = ? AND isDeleted = 0 LIMIT 1", [s.serialNumber]);
                if (check.length > 0 && check[0].status !== 'Available') {
                  throw new Error(`Cannot revert: Serial ${s.serialNumber} is already ${check[0].status}.`);
                }
                await connection.execute("DELETE FROM serials WHERE value = ? AND isDeleted = 0", [s.serialNumber]);
              }
            } else {
              // Regular item — decrease stock quantity
              const qty = item.stockInQty * item.defaultPcsQty;
              await connection.execute("UPDATE inventoryvariantstock SET availablePCS = availablePCS - ? WHERE itemVariantId = ?", [qty, item.itemVariantId]);
            }
          }
        }
        
        await connection.execute("UPDATE inventorystockin SET status = 0, finalizedOn = NULL WHERE stockInId = ?", [stockInId]);
        await connection.commit();
        res.json({ message: "Success" });
      } catch (err) { 
        await connection.rollback(); 
        throw err; 
      } finally { 
        connection.release(); 
      }
    } catch (err) { 
      res.status(500).json({ message: err.message }); 
    }
  });

  app.get('/Inventory/GetStockInSerials', requireAuth, async (req, res) => {
    try {
      const { detailId } = req.query;
      const pool = await getPool(res);
      if (!pool) return;
      const [rows] = await pool.query("SELECT serialId, serialNumber FROM inventorystockinserial WHERE stockInDetailId = ? AND isDeleted = 0", [detailId]);
      res.json({ data: rows, message: "Success" });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.post('/Inventory/SaveStockInSerials', requireAuth, async (req, res) => {
    try {
      const { stockInDetailId, itemVariantId, serialNumbers } = req.body;
      const pool = await getPool(res);
      if (!pool) return;

      for (const sn of serialNumbers) {
        const [dup] = await pool.query("SELECT value FROM serials WHERE value = ? AND isDeleted = 0 LIMIT 1", [sn]);
        if (dup.length > 0) {
           return res.status(400).json({ message: `Serial Number ${sn} already exists` });
        }
      }

      for (const sn of serialNumbers) {
        await pool.execute("INSERT INTO inventorystockinserial (serialId, stockInDetailId, itemVariantId, serialNumber) VALUES (?, ?, ?, ?)", [uuidv4(), stockInDetailId, itemVariantId || null, sn]);
      }
      res.json({ message: "Saved Successfully" });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.post('/Inventory/DeleteStockInSerial', requireAuth, async (req, res) => {
    try {
      const { serialId } = req.body;
      const pool = await getPool(res);
      if (!pool) return;
      await pool.execute("UPDATE inventorystockinserial SET isDeleted = 1 WHERE serialId = ?", [serialId]);
      res.json({ message: "Success" });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  // ==========================================
  // COMBO ROUTES
  // ==========================================
}

module.exports = { setupStockInRoutes };
