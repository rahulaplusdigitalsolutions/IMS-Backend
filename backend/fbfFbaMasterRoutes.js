const express = require('express');
const { v4: uuidv4 } = require('uuid');

async function syncFbfFbaWarehouseSchema(pool) {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS fbf_fba_platforms (
                guid VARCHAR(36) PRIMARY KEY,
                name VARCHAR(100) NOT NULL UNIQUE
            )
        `);
        
        await pool.query(`
            CREATE TABLE IF NOT EXISTS fbf_fba_states (
                guid VARCHAR(36) PRIMARY KEY,
                name VARCHAR(100) NOT NULL UNIQUE
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS fbf_fba_warehouses (
                guid VARCHAR(36) PRIMARY KEY,
                platform VARCHAR(50) NOT NULL,
                state VARCHAR(100) NOT NULL,
                warehouseName VARCHAR(255) NOT NULL,
                warehouseAddress TEXT,
                isDeleted TINYINT(1) DEFAULT 0,
                createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )
        `);

        // Drop id columns if they exist
        for (const table of ['fbf_fba_platforms', 'fbf_fba_states', 'fbf_fba_warehouses']) {
            const [cols] = await pool.query(`SHOW COLUMNS FROM ${table}`);
            if (cols.some(c => c.Field === 'id')) {
                // To drop id which might be a primary key, we might need to handle auto_increment
                await pool.query(`ALTER TABLE ${table} MODIFY id INT`); // remove auto_increment
                await pool.query(`ALTER TABLE ${table} DROP PRIMARY KEY`);
                await pool.query(`ALTER TABLE ${table} DROP COLUMN id`);
                await pool.query(`ALTER TABLE ${table} ADD PRIMARY KEY (guid)`);
            }
        }

        // Insert Example Platforms
        const [platforms] = await pool.query("SELECT COUNT(*) as cnt FROM fbf_fba_platforms");
        if (platforms[0].cnt === 0) {
            await pool.query("INSERT IGNORE INTO fbf_fba_platforms (guid, name) VALUES (?, ?), (?, ?)", [
                uuidv4(), "FBF",
                uuidv4(), "FBA"
            ]);
        }

        // Insert Example States
        const [states] = await pool.query("SELECT COUNT(*) as cnt FROM fbf_fba_states");
        if (states[0].cnt === 0) {
            await pool.query("INSERT IGNORE INTO fbf_fba_states (guid, name) VALUES (?, ?), (?, ?), (?, ?)", [
                uuidv4(), "Maharashtra",
                uuidv4(), "Delhi",
                uuidv4(), "Karnataka"
            ]);
        }

        // Insert Example Warehouse
        const [wh] = await pool.query("SELECT COUNT(*) as cnt FROM fbf_fba_warehouses");
        if (wh[0].cnt === 0) {
            await pool.query("INSERT IGNORE INTO fbf_fba_warehouses (guid, platform, state, warehouseName, warehouseAddress) VALUES (?, ?, ?, ?, ?)", [
                uuidv4(), "FBF", "Maharashtra", "Bhiwandi Main Hub", "Gala No 12, Bhiwandi, Thane, MH"
            ]);
        }

    } catch (err) {
        console.error("Error syncing FBF/FBA master schema:", err.message);
    }
}

function setupFbfFbaMasterRoutes(app, getPool, requireAuth) {
    const router = express.Router();
    router.use(requireAuth);

    (async () => {
        const pool = await getPool();
        if (pool) await syncFbfFbaWarehouseSchema(pool);
    })();

    // 1. Get all warehouses
    router.get('/warehouses', async (req, res) => {
        try {
            const pool = await getPool(res);
            const [rows] = await pool.query(`
                SELECT * FROM fbf_fba_warehouses 
                WHERE isDeleted = 0 
                ORDER BY platform ASC, state ASC, warehouseName ASC
            `);
            res.json(rows);
        } catch (err) {
            res.status(500).json({ message: err.message });
        }
    });

    // 2. Add new warehouse
    router.post('/warehouses', async (req, res) => {
        try {
            const { platform, state, warehouseName, warehouseAddress } = req.body;
            
            if (!platform || !state || !warehouseName) {
                return res.status(400).json({ message: "Platform, State and Warehouse Name are required." });
            }

            const pool = await getPool(res);
            const newGuid = uuidv4();
            await pool.query(
                "INSERT INTO fbf_fba_warehouses (guid, platform, state, warehouseName, warehouseAddress) VALUES (?, ?, ?, ?, ?)",
                [newGuid, platform, state, warehouseName, warehouseAddress || '']
            );

            res.json({ message: "Warehouse added successfully", guid: newGuid });
        } catch (err) {
            res.status(500).json({ message: err.message });
        }
    });

    // 3. Update warehouse
    router.put('/warehouses/:guid', async (req, res) => {
        try {
            const { platform, state, warehouseName, warehouseAddress } = req.body;
            const { guid } = req.params;

            if (!platform || !state || !warehouseName) {
                return res.status(400).json({ message: "Platform, State and Warehouse Name are required." });
            }

            const pool = await getPool(res);
            await pool.query(
                "UPDATE fbf_fba_warehouses SET platform = ?, state = ?, warehouseName = ?, warehouseAddress = ? WHERE guid = ?",
                [platform, state, warehouseName, warehouseAddress || '', guid]
            );

            res.json({ message: "Warehouse updated successfully" });
        } catch (err) {
            res.status(500).json({ message: err.message });
        }
    });

    // 4. Delete warehouse
    router.delete('/warehouses/:guid', async (req, res) => {
        try {
            const { guid } = req.params;
            const pool = await getPool(res);
            await pool.query("UPDATE fbf_fba_warehouses SET isDeleted = 1 WHERE guid = ?", [guid]);
            res.json({ message: "Warehouse deleted successfully" });
        } catch (err) {
            res.status(500).json({ message: err.message });
        }
    });

    // ==========================================
    // PLATFORMS
    // ==========================================
    router.get('/platforms', async (req, res) => {
        try {
            const pool = await getPool(res);
            const [rows] = await pool.query("SELECT * FROM fbf_fba_platforms ORDER BY name ASC");
            res.json(rows);
        } catch (err) {
            res.status(500).json({ message: err.message });
        }
    });

    router.post('/platforms', async (req, res) => {
        try {
            const { name } = req.body;
            if (!name) return res.status(400).json({ message: "Platform name is required" });
            const pool = await getPool(res);
            const newGuid = uuidv4();
            await pool.query("INSERT INTO fbf_fba_platforms (guid, name) VALUES (?, ?)", [newGuid, name.trim()]);
            res.json({ message: "Platform added", guid: newGuid });
        } catch (err) {
            res.status(500).json({ message: err.message });
        }
    });

    router.delete('/platforms/:guid', async (req, res) => {
        try {
            const pool = await getPool(res);
            await pool.query("DELETE FROM fbf_fba_platforms WHERE guid = ?", [req.params.guid]);
            res.json({ message: "Platform deleted" });
        } catch (err) {
            res.status(500).json({ message: err.message });
        }
    });

    // ==========================================
    // STATES
    // ==========================================
    router.get('/states', async (req, res) => {
        try {
            const pool = await getPool(res);
            const [rows] = await pool.query("SELECT * FROM fbf_fba_states ORDER BY name ASC");
            res.json(rows);
        } catch (err) {
            res.status(500).json({ message: err.message });
        }
    });

    router.post('/states', async (req, res) => {
        try {
            const { name } = req.body;
            if (!name) return res.status(400).json({ message: "State name is required" });
            const pool = await getPool(res);
            const newGuid = uuidv4();
            await pool.query("INSERT INTO fbf_fba_states (guid, name) VALUES (?, ?)", [newGuid, name.trim()]);
            res.json({ message: "State added", guid: newGuid });
        } catch (err) {
            res.status(500).json({ message: err.message });
        }
    });

    router.delete('/states/:guid', async (req, res) => {
        try {
            const pool = await getPool(res);
            await pool.query("DELETE FROM fbf_fba_states WHERE guid = ?", [req.params.guid]);
            res.json({ message: "State deleted" });
        } catch (err) {
            res.status(500).json({ message: err.message });
        }
    });

    app.use('/api/fbf-fba-master', router);
}

module.exports = { setupFbfFbaMasterRoutes };
