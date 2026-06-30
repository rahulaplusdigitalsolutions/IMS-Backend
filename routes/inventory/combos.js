// Extracted from inventoryRoutes.js — handlers unchanged.
const { v4: uuidv4 } = require('uuid');

function setupComboRoutes(app, getPool, requireAuth) {
  app.get('/Inventory/GetComboList', requireAuth, async (req, res) => {
    try {
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 10;
      const offset = (page - 1) * limit;

      const pool = await getPool(res);
      if (!pool) return;

      const [countRows] = await pool.query(`
        SELECT COUNT(DISTINCT m.parentVariantId) as total 
        FROM inventorycombomapping m 
        WHERE m.isDeleted = 0
      `);

      const [rows] = await pool.query(`
        SELECT m.parentVariantId as itemVariantId, pv.variantName as variantCode, pi.itemName, COUNT(m.childVariantId) as componentCount 
        FROM inventorycombomapping m 
        JOIN inventoryitemvariant pv ON m.parentVariantId = pv.itemVariantId 
        JOIN inventoryitemmaster pi ON pv.itemId = pi.itemId 
        WHERE m.isDeleted = 0 
        GROUP BY m.parentVariantId
        LIMIT ? OFFSET ?
      `, [limit, offset]);

      res.json({ data: rows, total: countRows[0].total, message: "Success" });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.get('/Inventory/GetComboDetails/:pvId', requireAuth, async (req, res) => {
    try {
      const pool = await getPool(res);
      if (!pool) return;
      const [rows] = await pool.query("SELECT m.childVariantId, cv.variantName as variantCode, ci.itemName, m.quantity, u.unitName FROM inventorycombomapping m JOIN inventoryitemvariant cv ON m.childVariantId = cv.itemVariantId JOIN inventoryitemmaster ci ON cv.itemId = ci.itemId LEFT JOIN inventoryunitmaster u ON ci.unitId = u.unitId WHERE m.parentVariantId = ? AND m.isDeleted = 0", [req.params.pvId]);
      res.json({ data: rows, message: "Success" });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.post('/Inventory/SaveComboMapping', requireAuth, async (req, res) => {
    try {
      let { parentVariantId, components, comboName } = req.body;
      const pool = await getPool(res);
      if (!pool) return;

      const connection = await pool.getConnection();
      await connection.beginTransaction();
      try {
        if (parentVariantId === "NEW") {
          // Find existing SYSTEM_COMBOS item
          let [items] = await connection.execute("SELECT itemId FROM inventoryitemmaster WHERE itemName = 'SYSTEM_COMBOS' LIMIT 1");
          let itemId;
          if (items.length > 0) {
            itemId = items[0].itemId;
          } else {
            // Create a default SYSTEM_COMBOS item if not exists (using common fallback IDs)
            itemId = `ITEM-COMBO-${Date.now()}`;
            await connection.execute(
              "INSERT INTO inventoryitemmaster (itemId, itemName, categoryId, brandId, unitId) VALUES (?, ?, ?, ?, ?)",
              [itemId, 'SYSTEM_COMBOS', '054f9306-2128-4ec3-91d7-f941896040a7', '03feb3df-029a-419c-a773-7da61285c341', 'UNT-1776263087562']
            );
          }

          // Create new variant for this combo
          parentVariantId = uuidv4();
          await connection.execute(
            "INSERT INTO inventoryitemvariant (itemVariantId, itemId, variantName, sku) VALUES (?, ?, ?, ?)",
            [parentVariantId, itemId, comboName, `CB-${Date.now()}`]
          );
        } else if (comboName) {
          await connection.execute("UPDATE inventoryitemvariant SET variantName = ? WHERE itemVariantId = ?", [comboName, parentVariantId]);
        }

        // Soft-delete old mappings
        await connection.execute("UPDATE inventorycombomapping SET isDeleted = 1 WHERE parentVariantId = ?", [parentVariantId]);

        // Insert new components
        for (const comp of components) {
          if (comp.childVariantId) {
            await connection.execute(
              "INSERT INTO inventorycombomapping (parentVariantId, childVariantId, quantity) VALUES (?, ?, ?)",
              [parentVariantId, comp.childVariantId, comp.quantity || 1]
            );
          }
        }
        await connection.commit();
        res.json({ message: "Saved successfully" });
      } catch (err) {
        await connection.rollback();
        console.error("SQL Transaction Error:", err);
        throw err;
      } finally {
        connection.release();
      }
    } catch (err) {
      console.error("Error saving combo mapping:", err);
      res.status(500).json({ message: err.message });
    }
  });

  app.post('/Inventory/DeleteCombo', requireAuth, async (req, res) => {
    try {
      const { parentVariantId } = req.body;
      const pool = await getPool(res);
      if (!pool) return;
      await pool.execute("UPDATE inventorycombomapping SET isDeleted = 1 WHERE parentVariantId = ?", [parentVariantId]);
      res.json({ message: "Success" });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  // ==========================================
  // STOCK OUT ROUTES
  // ==========================================
}

module.exports = { setupComboRoutes };
