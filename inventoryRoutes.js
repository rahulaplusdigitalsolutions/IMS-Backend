// Aggregator for the legacy /Inventory/* endpoints.
// Handlers live in routes/inventory/{masters,stockIn,combos,stockOut}.js.
const express = require('express');
const path = require('path');

const { setupInventoryMasterRoutes } = require('./routes/inventory/masters');
const { setupStockInRoutes } = require('./routes/inventory/stockIn');
const { setupComboRoutes } = require('./routes/inventory/combos');
const { setupStockOutRoutes } = require('./routes/inventory/stockOut');

// ✅ MySQL Schema Sync: Ensure inventorystationeryreturns table has rowColor and tags
async function syncStationeryReturnsSchema(pool) {
  try {
    const [columns] = await pool.query("SHOW COLUMNS FROM inventorystationeryreturns");
    const columnNames = columns.map(c => c.Field);

    if (!columnNames.includes('rowColor')) {
      await pool.query("ALTER TABLE inventorystationeryreturns ADD COLUMN rowColor VARCHAR(50) NULL");
      console.log("✅ Added 'rowColor' column to MySQL 'inventorystationeryreturns' table");
    }

    if (!columnNames.includes('tags')) {
      await pool.query("ALTER TABLE inventorystationeryreturns ADD COLUMN tags LONGTEXT NULL");
      console.log("✅ Added 'tags' column to MySQL 'inventorystationeryreturns' table");
    }
  } catch (err) {
    console.error("⚠️ Error syncing MySQL Stationery Returns schema:", err.message);
  }
}

function setupInventoryRoutes(app, getPool, requireAuth) {
  // ✅ Serve uploaded files as static assets
  app.use('/uploads', express.static(path.resolve(__dirname, 'uploads')));
  (async () => {
    try {
      const pool = await getPool();
      if (pool) await syncStationeryReturnsSchema(pool);
    } catch (e) {
      console.error("Failed to sync stationery returns schema:", e);
    }
  })();

  setupInventoryMasterRoutes(app, getPool, requireAuth);
  setupStockInRoutes(app, getPool, requireAuth);
  setupComboRoutes(app, getPool, requireAuth);
  setupStockOutRoutes(app, getPool, requireAuth);
}

module.exports = { setupInventoryRoutes };
