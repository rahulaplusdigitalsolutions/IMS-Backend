// Extracted from inventoryRoutes.js — handlers unchanged.
const { v4: uuidv4 } = require('uuid');

function setupInventoryMasterRoutes(app, getPool, requireAuth) {
  app.get('/Inventory/GetCategoryList', requireAuth, async (req, res) => {
    try {
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 1000;
      const offset = (page - 1) * limit;

      const pool = await getPool(res);
      if (!pool) return;

      const [countRows] = await pool.query("SELECT COUNT(*) as total FROM inventorycategorymaster WHERE isDeleted = 0");
      const [rows] = await pool.query('SELECT categoryId, categoryName FROM inventorycategorymaster WHERE isDeleted = 0 ORDER BY categoryName ASC LIMIT ? OFFSET ?', [limit, offset]);

      res.json({ message: "Success", data: rows, total: countRows[0].total });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.post('/Inventory/SaveOrUpdateCategory', requireAuth, async (req, res) => {
    try {
      const { CategoryId, CategoryName } = req.body;
      const pool = await getPool(res);
      if (!pool) return;
      if (CategoryId && CategoryId !== "0" && CategoryId !== 0 && CategoryId !== "") {
        await pool.execute('UPDATE inventorycategorymaster SET categoryName = ? WHERE categoryId = ?', [CategoryName, CategoryId]);
      } else {
        await pool.execute('INSERT INTO inventorycategorymaster (categoryId, categoryName) VALUES (?, ?)', [uuidv4(), CategoryName]);
      }
      res.json({ message: 'Success' });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.post('/Inventory/DeleteCategory', requireAuth, async (req, res) => {
    try {
      const { categoryId } = req.body;
      const pool = await getPool(res);
      if (!pool) return;
      await pool.execute('UPDATE inventorycategorymaster SET isDeleted = 1 WHERE categoryId = ?', [categoryId]);
      res.json({ message: 'Success' });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  // ==========================================
  // BRAND MASTER
  // ==========================================
  app.get('/Inventory/GetBrandList', requireAuth, async (req, res) => {
    try {
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 1000;
      const offset = (page - 1) * limit;

      const pool = await getPool(res);
      if (!pool) return;

      const [countRows] = await pool.query("SELECT COUNT(*) as total FROM inventorybrandmaster WHERE isDeleted = 0");
      const [rows] = await pool.query('SELECT brandId, brandName FROM inventorybrandmaster WHERE isDeleted = 0 ORDER BY brandName ASC LIMIT ? OFFSET ?', [limit, offset]);

      res.json({ data: rows, total: countRows[0].total, message: "Success" });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.post('/Inventory/SaveOrUpdateBrand', requireAuth, async (req, res) => {
    try {
      const { BrandId, BrandName } = req.body;
      const pool = await getPool(res);
      if (!pool) return;
      if (BrandId && BrandId !== "0" && BrandId !== "") {
        await pool.execute('UPDATE inventorybrandmaster SET brandName = ? WHERE brandId = ?', [BrandName, BrandId]);
      } else {
        await pool.execute('INSERT INTO inventorybrandmaster (brandId, brandName) VALUES (?, ?)', [uuidv4(), BrandName]);
      }
      res.json({ message: 'Success' });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.post('/Inventory/DeleteBrand', requireAuth, async (req, res) => {
    try {
      const { brandId } = req.body;
      const pool = await getPool(res);
      if (!pool) return;
      await pool.execute('UPDATE inventorybrandmaster SET isDeleted = 1 WHERE brandId = ?', [brandId]);
      res.json({ message: 'Success' });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  // ==========================================
  // UNIT MASTER
  // ==========================================
  app.get('/Inventory/GetUnitList', requireAuth, async (req, res) => {
    try {
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 1000;
      const offset = (page - 1) * limit;

      const pool = await getPool(res);
      if (!pool) return;

      const [countRows] = await pool.query("SELECT COUNT(*) as total FROM inventoryunitmaster WHERE isDeleted = 0");
      const [rows] = await pool.query('SELECT unitId, unitName, unitDesc as unitDescription, baseUnitQty FROM inventoryunitmaster WHERE isDeleted = 0 LIMIT ? OFFSET ?', [limit, offset]);
      res.json({ data: rows, total: countRows[0].total, message: "Success" });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.post('/Inventory/SaveOrUpdateUnit', requireAuth, async (req, res) => {
    try {
      const { UnitId, UnitName, UnitDesc, BaseUnitQty } = req.body;
      const pool = await getPool(res);
      if (!pool) return;
      if (UnitId && UnitId !== "0" && UnitId !== "") {
        await pool.execute('UPDATE inventoryunitmaster SET unitName = ?, unitDesc = ?, baseUnitQty = ? WHERE unitId = ?', [UnitName, UnitDesc, BaseUnitQty, UnitId]);
      } else {
        await pool.execute('INSERT INTO inventoryunitmaster (unitId, unitName, unitDesc, baseUnitQty) VALUES (?, ?, ?, ?)', [uuidv4(), UnitName, UnitDesc, BaseUnitQty]);
      }
      res.json({ message: 'Success' });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  // ==========================================
  // UNIT MASTER
  // ==========================================

  // ... existing GetUnitList and SaveOrUpdateUnit routes ...

  app.post('/Inventory/DeleteUnit', requireAuth, async (req, res) => {
    try {
      const { unitId } = req.body;
      const pool = await getPool(res);
      if (!pool) return;
      await pool.execute('UPDATE inventoryunitmaster SET isDeleted = 1 WHERE unitId = ?', [unitId]);
      res.json({ message: 'Success' });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  // ==========================================
  // VENDOR MASTER
  // ==========================================
  app.get('/Inventory/GetVendorList', requireAuth, async (req, res) => {
    try {
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 1000;
      const offset = (page - 1) * limit;

      const pool = await getPool(res);
      if (!pool) return;

      const [countRows] = await pool.query("SELECT COUNT(*) as total FROM inventoryvendor WHERE isDeleted = 0");
      const [rows] = await pool.query('SELECT * FROM inventoryvendor WHERE isDeleted = 0 LIMIT ? OFFSET ?', [limit, offset]);
      res.json({ data: rows, total: countRows[0].total, message: "Success" });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.post('/Inventory/SaveOrUpdateVendor', requireAuth, async (req, res) => {
    try {
      const {
        VendorId,
        VendorFirmName,
        VendorContactPerson = '',
        VendorContactNo = '',
        VendorEmail = '',
        VendorGST = '',
        VendorAddress = ''
      } = req.body;
      const pool = await getPool(res);
      if (!pool) return;

      if (VendorId && VendorId !== "0" && VendorId !== "") {
        await pool.execute('UPDATE inventoryvendor SET vendorFirmName = ?, vendorContactPerson = ?, vendorContactNo = ?, vendorEmail = ?, vendorGST = ?, vendorAddress = ? WHERE vendorId = ?',
          [VendorFirmName, VendorContactPerson, VendorContactNo, VendorEmail, VendorGST, VendorAddress, VendorId]);
      } else {
        const id = uuidv4();
        await pool.execute('INSERT INTO inventoryvendor (vendorId, vendorFirmName, vendorContactPerson, vendorContactNo, vendorEmail, vendorGST, vendorAddress, isDeleted) VALUES (?, ?, ?, ?, ?, ?, ?, 0)',
          [id, VendorFirmName, VendorContactPerson, VendorContactNo, VendorEmail, VendorGST, VendorAddress]);
      }
      res.json({ message: 'Success' });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.get('/Inventory/GetVendorDetails', requireAuth, async (req, res) => {
    try {
      const { vendorId } = req.query;
      const pool = await getPool(res);
      if (!pool) return;
      const [rows] = await pool.query('SELECT * FROM inventoryvendor WHERE vendorId = ?', [vendorId]);
      if (rows.length === 0) return res.status(404).json({ message: "Vendor not found" });

      // Map database columns to camelCase expected by frontend if needed, 
      // but test_vendor_update suggests many match or are slightly different.
      // We'll return the row as is, and the frontend handles common variations.
      res.json({ data: rows[0], message: "Success" });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.post('/Inventory/SaveVendorFromDetails', requireAuth, async (req, res) => {
    try {
      const {
        VendorId, VendorName, VendorFirmName, VendorGstin, VendorMobile, VendorAlternateMobile,
        VendorEmail, VendorAddress, VendorState, VendorPincode, VendorBankName, VendorBankAccountName,
        VendorBankAccountNumber, VendorBankIfsc, DealingCategoryIds, VendorDealingItems
      } = req.body;
      const pool = await getPool(res);
      if (!pool) return;

      const catsStr = Array.isArray(DealingCategoryIds) ? DealingCategoryIds.join(",") : DealingCategoryIds;

      if (VendorId && VendorId !== "0" && VendorId !== "") {
        await pool.execute(
          `UPDATE inventoryvendor SET 
            vendorName = ?, vendorFirmName = ?, vendorGSTIN = ?, vendorMobile = ?, 
            vendorAlternateMobile = ?, vendorEmail = ?, vendorAddress = ?, vendorState = ?, 
            vendorPincode = ?, vendorBankName = ?, vendorBankAccountName = ?, 
            vendorBankAccountNumber = ?, vendorBankIFSC = ?, 
            vendorDealingCategories = ?, vendorDealingItems = ? 
          WHERE vendorId = ?`,
          [
            VendorName || '', VendorFirmName || '', VendorGstin || '', VendorMobile || '',
            VendorAlternateMobile || '', VendorEmail || '', VendorAddress || '', VendorState || '',
            VendorPincode || '', VendorBankName || '', VendorBankAccountName || '',
            VendorBankAccountNumber || '', VendorBankIfsc || '',
            catsStr || '', VendorDealingItems || '', VendorId
          ]
        );
      } else {
        const id = uuidv4();
        await pool.execute(
          `INSERT INTO inventoryvendor (
            vendorId, vendorName, vendorFirmName, vendorGSTIN, vendorMobile, 
            vendorAlternateMobile, vendorEmail, vendorAddress, vendorState, 
            vendorPincode, vendorBankName, vendorBankAccountName, 
            vendorBankAccountNumber, vendorBankIFSC, 
            vendorDealingCategories, vendorDealingItems, isDeleted
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 0)`,
          [
            id, VendorName || '', VendorFirmName || '', VendorGstin || '', VendorMobile || '',
            VendorAlternateMobile || '', VendorEmail || '', VendorAddress || '', VendorState || '',
            VendorPincode || '', VendorBankName || '', VendorBankAccountName || '',
            VendorBankAccountNumber || '', VendorBankIfsc || '',
            catsStr || '', VendorDealingItems || ''
          ]
        );
      }
      res.json({ message: 'Success' });
    } catch (err) {
      console.error("Error saving vendor details:", err);
      res.status(500).json({ message: err.message });
    }
  });

  app.post('/Inventory/DeleteVendor', requireAuth, async (req, res) => {
    try {
      const { vendorId } = req.body;
      const pool = await getPool(res);
      if (!pool) return;
      await pool.execute('UPDATE inventoryvendor SET isDeleted = 1 WHERE vendorId = ?', [vendorId]);
      res.json({ message: 'Success' });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  // ==========================================
  // ITEM MASTER
  // ==========================================
  app.get('/Inventory/GetItemList', requireAuth, async (req, res) => {
    try {
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 1000;
      const offset = (page - 1) * limit;

      const pool = await getPool(res);
      if (!pool) return;

      const [countRows] = await pool.query("SELECT COUNT(*) as total FROM inventoryitemmaster WHERE isDeleted = 0");
      const [rows] = await pool.query(`
        SELECT i.*, c.categoryName, b.brandName, u.unitName 
        FROM inventoryitemmaster i
        LEFT JOIN inventorycategorymaster c ON i.categoryId = c.categoryId
        LEFT JOIN inventorybrandmaster b ON i.brandId = b.brandId
        LEFT JOIN inventoryunitmaster u ON i.unitId = u.unitId
        WHERE i.isDeleted = 0
        LIMIT ? OFFSET ?
      `, [limit, offset]);
      res.json({ data: rows, total: countRows[0].total, message: "Success" });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.post('/Inventory/SaveOrUpdateItem', requireAuth, async (req, res) => {
    try {
      const { ItemId, CategoryId, BrandId, ItemName, ItemCode, HsnCode, HSNCode, UnitId, IsTrackable, UseSerialTab } = req.body;
      const finalHsnCode = HsnCode || HSNCode || "";
      const pool = await getPool(res);
      if (!pool) return;
      if (ItemId && ItemId !== "0" && ItemId !== "") {
        await pool.execute('UPDATE inventoryitemmaster SET categoryId=?, brandId=?, itemName=?, itemCode=?, hsnCode=?, unitId=?, isTrackable=?, useSerialTab=? WHERE itemId=?',
          [CategoryId, BrandId, ItemName, ItemCode, finalHsnCode, UnitId, IsTrackable ? 1 : 0, UseSerialTab ? 1 : 0, ItemId]);
      } else {
        await pool.execute('INSERT INTO inventoryitemmaster (itemId, categoryId, brandId, itemName, itemCode, hsnCode, unitId, isTrackable, useSerialTab) VALUES (?,?,?,?,?,?,?,?,?)',
          [uuidv4(), CategoryId, BrandId, ItemName, ItemCode, finalHsnCode, UnitId, IsTrackable ? 1 : 0, UseSerialTab ? 1 : 0]);
      }
      res.json({ message: 'Success' });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.post('/Inventory/DeleteItem', requireAuth, async (req, res) => {
    try {
      const pool = await getPool(res);
      if (!pool) return;
      await pool.execute('UPDATE inventoryitemmaster SET isDeleted = 1 WHERE itemId = ?', [req.body.itemId]);
      res.json({ message: 'Success' });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  // ==========================================
  // ITEM VARIANT MASTER
  // ==========================================
  app.get('/Inventory/GetItemVariantList', requireAuth, async (req, res) => {
    try {
      const { itemId, page = 1, limit = 10 } = req.query;
      const offset = (page - 1) * limit;
      const pool = await getPool(res);
      if (!pool) return;

      const [rows] = await pool.query(
        'SELECT itemVariantId, variantName as variantCode FROM inventoryitemvariant WHERE itemId = ? AND isDeleted = 0 LIMIT ? OFFSET ?',
        [itemId, Number(limit), Number(offset)]
      );

      const [[{ total }]] = await pool.query(
        'SELECT COUNT(*) as total FROM inventoryitemvariant WHERE itemId = ? AND isDeleted = 0',
        [itemId]
      );

      res.json({ message: "Success", data: rows, total });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.post('/Inventory/SaveOrUpdateItemVariant', requireAuth, async (req, res) => {
    try {
      const { ItemVariantId, ItemId, VariantCode } = req.body;
      const pool = await getPool(res);
      if (!pool) return;
      if (ItemVariantId && ItemVariantId !== "0" && ItemVariantId !== "") {
        await pool.execute('UPDATE inventoryitemvariant SET variantName = ? WHERE itemVariantId = ?', [VariantCode, ItemVariantId]);
      } else {
        await pool.execute('INSERT INTO inventoryitemvariant (itemVariantId, itemId, variantName) VALUES (?, ?, ?)', [uuidv4(), ItemId, VariantCode]);
      }

      // Check if a model with the same name exists
      const [existingModel] = await pool.query(
        "SELECT guid FROM models WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) AND isDeleted = 0",
        [VariantCode]
      );

      if (existingModel.length === 0) {
        // Check if there is already a pending approval request
        const [existingRequest] = await pool.query(
          "SELECT guid FROM model_approval_requests WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) AND status = 'pending' AND isDeleted = 0",
          [VariantCode]
        );

        if (existingRequest.length === 0) {
          // Get the parent item details (brand name, category name, item name)
          const [itemRows] = await pool.query(
            `SELECT i.itemName, b.brandName, c.categoryName 
             FROM inventoryitemmaster i 
             LEFT JOIN inventorybrandmaster b ON i.brandId = b.brandId 
             LEFT JOIN inventorycategorymaster c ON i.categoryId = c.categoryId 
             WHERE i.itemId = ?`,
            [ItemId]
          );

          if (itemRows.length > 0) {
            const company = itemRows[0].brandName;
            const category = itemRows[0].categoryName;
            const categoryNameLower = (category || "").toLowerCase();
            const isPC = categoryNameLower.includes("pc") || categoryNameLower.includes("computer") || categoryNameLower.includes("laptop") || categoryNameLower.includes("computing");
            const isMonitor = categoryNameLower.includes("monitor") || categoryNameLower.includes("display") || categoryNameLower.includes("screen");
            const mainCategory = isMonitor ? "Monitor" : isPC ? "PC" : "Printer";
            const description = `Automatically requested from Item Variant Master for item: ${itemRows[0].itemName}`;
            const requestedBy = req.user?.username || "System";
            const requestedByGuid = req.user?.userid ? String(req.user.userid) : null;
            const requestGuid = uuidv4();

            // Determine the actual variantId of the newly inserted (or updated) variant
            let resolvedVariantId = ItemVariantId && ItemVariantId !== "0" && ItemVariantId !== "" ? ItemVariantId : null;
            if (!resolvedVariantId) {
              // For new inserts, fetch the just-inserted row
              const [newVar] = await pool.query(
                "SELECT itemVariantId FROM inventoryitemvariant WHERE itemId = ? AND variantName = ? AND isDeleted = 0 ORDER BY itemVariantId DESC LIMIT 1",
                [ItemId, VariantCode]
              );
              resolvedVariantId = newVar[0]?.itemVariantId || null;
            }

            await pool.query(
              `INSERT INTO model_approval_requests
                (guid, name, company, category, colorType, printerType, description, mrp, mainCategory, cpu, ram, ssdHdd, requestedBy, requestedByGuid, status, serialNumber, landingPrice, landingPriceReason, godownGuid, variantId)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?,?,?)`,
              [
                requestGuid, VariantCode.trim(), company || null, category || null,
                "Monochrome", "Multi-Function",
                description || null, 0, mainCategory,
                null, null, null,
                requestedBy, requestedByGuid,
                null, 0, null, null,
                resolvedVariantId
              ]
            );

            // Notify all Admins
            const { createNotification } = require("../../notificationService");
            await createNotification(pool, {
              targetRole: "Admin",
              title: "New Model Approval Request",
              message: `${requestedBy} requested to add model "${VariantCode.trim()}" via Item Variant Master.`,
              type: "info",
              priority: "low",
              link: "/models?tab=approvals"
            });
          }
        }
      }

      res.json({ message: 'Success' });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.post('/Inventory/DeleteItemVariant', requireAuth, async (req, res) => {
    try {
      const { itemVariantId } = req.body;
      const pool = await getPool(res);
      if (!pool) return;
      await pool.execute('UPDATE inventoryitemvariant SET isDeleted = 1 WHERE itemVariantId = ?', [itemVariantId]);
      res.json({ message: 'Success' });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  // ==========================================
  // VARIANT BARCODE MAPPING
  // ==========================================
  app.get('/Inventory/GetVariantBarcodeList', requireAuth, async (req, res) => {
    try {
      const { itemVariantId } = req.query;
      const pool = await getPool(res);
      if (!pool) return;
      const [rows] = await pool.query('SELECT barcodeId as BarcodeId, barcode as Barcode, subUnitQty as SubUnitQty FROM inventoryvariantbarcode WHERE itemVariantId = ? AND isDeleted = 0', [itemVariantId]);
      res.json({ message: "Success", data: rows });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.post('/Inventory/SaveOrUpdateVariantBarcode', requireAuth, async (req, res) => {
    try {
      const { BarcodeId, ItemVariantId, Barcode, SubUnitQty } = req.body;
      const pool = await getPool(res);
      if (!pool) return;
      if (BarcodeId && BarcodeId !== "0" && BarcodeId !== "") {
        await pool.execute('UPDATE inventoryvariantbarcode SET barcode = ?, subUnitQty = ? WHERE barcodeId = ?', [Barcode, SubUnitQty, BarcodeId]);
      } else {
        await pool.execute('INSERT INTO inventoryvariantbarcode (barcodeId, itemVariantId, barcode, subUnitQty) VALUES (?, ?, ?, ?)', [uuidv4(), ItemVariantId, Barcode, SubUnitQty]);
      }
      res.json({ message: 'Success' });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.post('/Inventory/DeleteVariantBarcode', requireAuth, async (req, res) => {
    try {
      const { barcodeId } = req.body;
      const pool = await getPool(res);
      if (!pool) return;
      await pool.execute('UPDATE inventoryvariantbarcode SET isDeleted = 1 WHERE barcodeId = ?', [barcodeId]);
      res.json({ message: 'Success' });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  // ==========================================
  // CATEGORY BRAND MAPPING
  // ==========================================
  app.get('/Inventory/GetCategoryBrandMappingList', requireAuth, async (req, res) => {
    try {
      const pool = await getPool(res);
      if (!pool) return;
      const [rows] = await pool.query(`
        SELECT m.mappingId, c.categoryName, b.brandName, m.categoryId, m.brandId
        FROM inventorycategorybrandmapping m
        JOIN inventorycategorymaster c ON m.categoryId = c.categoryId
        JOIN inventorybrandmaster b ON m.brandId = b.brandId
        WHERE m.isDeleted = 0
      `);
      res.json({ data: rows, message: "Success" });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.post('/Inventory/SaveCategoryBrandMapping', requireAuth, async (req, res) => {
    try {
      const { categoryId, brandId } = req.body;
      const pool = await getPool(res);
      if (!pool) return;
      await pool.execute('INSERT INTO inventorycategorybrandmapping (mappingId, categoryId, brandId) VALUES (?, ?, ?)', [uuidv4(), categoryId, brandId]);
      res.json({ message: 'Success' });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.post('/Inventory/SaveOrUpdateCategoryBrandMapping', requireAuth, async (req, res) => {
    try {
      const { MappingId, CategoryId, BrandId } = req.body;
      const pool = await getPool(res);
      if (!pool) return;

      if (!CategoryId || !BrandId) {
        return res.status(400).json({ message: 'CategoryId and BrandId are required' });
      }

      if (MappingId && MappingId !== '0' && MappingId !== '') {
        // Update existing
        await pool.execute(
          'UPDATE inventorycategorybrandmapping SET categoryId = ?, brandId = ? WHERE mappingId = ?',
          [CategoryId, BrandId, MappingId]
        );
      } else {
        // Check for duplicate before insert
        const [existing] = await pool.query(
          'SELECT mappingId FROM inventorycategorybrandmapping WHERE categoryId = ? AND brandId = ? AND isDeleted = 0',
          [CategoryId, BrandId]
        );
        if (existing.length > 0) {
          return res.status(400).json({ message: 'This category-brand mapping already exists' });
        }
        await pool.execute(
          'INSERT INTO inventorycategorybrandmapping (mappingId, categoryId, brandId) VALUES (?, ?, ?)',
          [uuidv4(), CategoryId, BrandId]
        );
      }

      res.json({ message: 'Success' });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  app.post('/Inventory/DeleteCategoryBrandMapping', requireAuth, async (req, res) => {
    try {
      const pool = await getPool(res);
      if (!pool) return;
      await pool.execute('UPDATE inventorycategorybrandmapping SET isDeleted = 1 WHERE mappingId = ?', [req.body.mappingId]);
      res.json({ message: 'Success' });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.get('/Inventory/GetCategoryDropdown', requireAuth, async (req, res) => {
    try {
      const pool = await getPool(res);
      if (!pool) return;
      const [rows] = await pool.query('SELECT categoryId as Value, categoryName as Text FROM inventorycategorymaster WHERE isDeleted = 0');
      res.json({ data: rows, message: "Success" });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.get('/Inventory/GetBrandDropdown', requireAuth, async (req, res) => {
    try {
      const pool = await getPool(res);
      if (!pool) return;
      const [rows] = await pool.query('SELECT brandId as Value, brandName as Text FROM inventorybrandmaster WHERE isDeleted = 0');
      res.json({ data: rows, message: "Success" });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.get('/Inventory/GetBrandByCategory', requireAuth, async (req, res) => {
    try {
      const { categoryId } = req.query;
      const pool = await getPool(res);
      if (!pool) return;
      const [rows] = await pool.query(`
        SELECT b.brandId, b.brandName 
        FROM inventorybrandmaster b
        JOIN inventorycategorybrandmapping m ON b.brandId = m.brandId
        WHERE m.categoryId = ? AND b.isDeleted = 0 AND m.isDeleted = 0
      `, [categoryId]);
      res.json({ data: rows, message: "Success" });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  // ==========================================
  // STOCK IN ROUTES
  // ==========================================
}

module.exports = { setupInventoryMasterRoutes };
