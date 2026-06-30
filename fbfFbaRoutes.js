const express = require('express');

async function syncFbfFbaSchema(pool) {
    try {
        const [stockColumns] = await pool.query("SHOW COLUMNS FROM fbf_fba_stock");
        const stockColumnNames = stockColumns.map((column) => column.Field);

        if (!stockColumnNames.includes('itemId')) {
            await pool.query("ALTER TABLE fbf_fba_stock ADD COLUMN itemId VARCHAR(36) NULL AFTER modelGuid");
        }

        if (!stockColumnNames.includes('itemKind')) {
            await pool.query("ALTER TABLE fbf_fba_stock ADD COLUMN itemKind ENUM('serialized', 'nonSerialized') NOT NULL DEFAULT 'serialized' AFTER itemId");
        }

        if (!stockColumnNames.includes('modelGuid')) {
            await pool.query("ALTER TABLE fbf_fba_stock ADD COLUMN modelGuid CHAR(36) NULL AFTER modelGuid");
        }

        const modelGuidColumn = stockColumns.find((column) => column.Field === 'modelGuid');
        if (modelGuidColumn && String(modelGuidColumn.Null).toUpperCase() === 'NO') {
            await pool.query("ALTER TABLE fbf_fba_stock MODIFY modelGuid INT NULL");
        }

        if (!stockColumnNames.includes('warehouseGuid')) {
            await pool.query("ALTER TABLE fbf_fba_stock ADD COLUMN warehouseGuid VARCHAR(36) NULL AFTER type");
        }
        if (stockColumnNames.includes('warehouseId')) {
            await pool.query("ALTER TABLE fbf_fba_stock DROP COLUMN warehouseId");
        }

        await pool.query(`
            UPDATE fbf_fba_stock s
            JOIN models m ON s.modelGuid = m.guid
            SET s.modelGuid = m.guid
            WHERE s.modelGuid IS NOT NULL
              AND (s.modelGuid IS NULL OR s.modelGuid = '')
        `);

        const [transactionColumns] = await pool.query("SHOW COLUMNS FROM fbf_fba_transactions");
        const transactionColumnNames = transactionColumns.map((column) => column.Field);

        if (!transactionColumnNames.includes('itemId')) {
            await pool.query("ALTER TABLE fbf_fba_transactions ADD COLUMN itemId VARCHAR(36) NULL AFTER modelGuid");
        }

        if (!transactionColumnNames.includes('itemKind')) {
            await pool.query("ALTER TABLE fbf_fba_transactions ADD COLUMN itemKind ENUM('serialized', 'nonSerialized') NOT NULL DEFAULT 'serialized' AFTER itemId");
        }

        if (!transactionColumnNames.includes('modelGuid')) {
            await pool.query("ALTER TABLE fbf_fba_transactions ADD COLUMN modelGuid CHAR(36) NULL AFTER modelGuid");
        }

        if (!transactionColumnNames.includes('amount')) {
            await pool.query("ALTER TABLE fbf_fba_transactions ADD COLUMN amount DECIMAL(12,2) NULL AFTER quantity");
        }

        if (!transactionColumnNames.includes('transactionDate')) {
            await pool.query("ALTER TABLE fbf_fba_transactions ADD COLUMN transactionDate DATE NULL AFTER amount");
        }

        const transactionModelIdColumn = transactionColumns.find((column) => column.Field === 'modelGuid');
        if (transactionModelIdColumn && String(transactionModelIdColumn.Null).toUpperCase() === 'NO') {
            await pool.query("ALTER TABLE fbf_fba_transactions MODIFY modelGuid INT NULL");
        }

        if (!transactionColumnNames.includes('warehouseGuid')) {
            await pool.query("ALTER TABLE fbf_fba_transactions ADD COLUMN warehouseGuid VARCHAR(36) NULL AFTER type");
        }
        if (transactionColumnNames.includes('warehouseId')) {
            await pool.query("ALTER TABLE fbf_fba_transactions DROP COLUMN warehouseId");
        }

        await pool.query(`
            UPDATE fbf_fba_transactions t
            JOIN models m ON t.modelGuid = m.guid
            SET t.modelGuid = m.guid
            WHERE t.modelGuid IS NOT NULL
              AND (t.modelGuid IS NULL OR t.modelGuid = '')
        `);
    } catch (err) {
        console.error("Error syncing FBF/FBA schema:", err.message);
    }
}

async function resolveModelId(connection, modelGuid) {
    const guidCandidate = String(modelGuid || '').trim();
    const idCandidate = String(modelGuid || '').trim();
    const numericId = Number(idCandidate);

    if (Number.isInteger(numericId) && numericId > 0) {
        return numericId;
    }

    const lookupGuid = guidCandidate || idCandidate;
    if (!lookupGuid) return null;

    const [rows] = await connection.query(
        "SELECT guid FROM models WHERE guid = ? AND isDeleted = 0 LIMIT 1",
        [lookupGuid]
    );

    return rows[0]?.guid || null;
}

function setupFbfFbaRoutes(app, getPool, requireAuth, helpers) {
    const router = express.Router();
    router.use(requireAuth);

    (async () => {
        const pool = await getPool();
        if (pool) await syncFbfFbaSchema(pool);
    })();

    // 1. Add Stock to FBF/FBA (IN)
    router.post('/add-stock', async (req, res) => {
        let connection;
        try {
            const { modelGuid, itemId, type, quantity, serialNumbers, createdBy, warehouseGuid } = req.body;
            const itemKind = req.body.itemKind || (serialNumbers?.length ? 'serialized' : 'nonSerialized');
            const isSerialized = itemKind === 'serialized';
            const safeItemId = isSerialized ? null : String(itemId || '').trim();
            const safeQuantity = Number(quantity);

            const pool = await getPool(res);
            connection = await pool.getConnection();
            const safeModelId = isSerialized ? await resolveModelId(connection, modelGuid) : null;

            if (!type || !['FBF', 'FBA'].includes(type)) {
                return res.status(400).json({ message: "Invalid stock type" });
            }

            if (!Number.isFinite(safeQuantity) || safeQuantity <= 0) {
                return res.status(400).json({ message: "Quantity must be greater than zero" });
            }

            if (isSerialized && !safeModelId) {
                return res.status(400).json({ message: "Model is required for serialized stock" });
            }

            if (!isSerialized && !safeItemId) {
                return res.status(400).json({ message: "Item is required for non-serialized stock" });
            }

            await connection.beginTransaction();

            if (isSerialized) {
                const [existingStock] = await connection.query(
                    "SELECT guid FROM fbf_fba_stock WHERE itemKind = 'serialized' AND modelGuid = ? AND type = ? AND (warehouseGuid = ? OR (warehouseGuid IS NULL AND ? IS NULL)) LIMIT 1 FOR UPDATE",
                    [safeModelId, type, warehouseGuid || null, warehouseGuid || null]
                );

                if (existingStock.length > 0) {
                    await connection.query(
                        "UPDATE fbf_fba_stock SET quantity = quantity + ? WHERE guid = ?",
                        [safeQuantity, existingStock[0].guid]
                    );
                } else {
                    await connection.query(`
                        INSERT INTO fbf_fba_stock (guid, modelGuid, itemId, itemKind, type, warehouseGuid, quantity)
                        VALUES (UUID(), ?, NULL, 'serialized', ?, ?, ?)
                    `, [safeModelId, type, warehouseGuid || null, safeQuantity]);
                }
            } else {
                const [existingStock] = await connection.query(
                    "SELECT guid FROM fbf_fba_stock WHERE itemKind = 'nonSerialized' AND itemId = ? AND type = ? AND (warehouseGuid = ? OR (warehouseGuid IS NULL AND ? IS NULL)) LIMIT 1 FOR UPDATE",
                    [safeItemId, type, warehouseGuid || null, warehouseGuid || null]
                );

                if (existingStock.length > 0) {
                    await connection.query(
                        "UPDATE fbf_fba_stock SET quantity = quantity + ? WHERE guid = ?",
                        [safeQuantity, existingStock[0].guid]
                    );
                } else {
                    await connection.query(
                        "INSERT INTO fbf_fba_stock (guid, modelGuid, itemId, itemKind, type, warehouseGuid, quantity) VALUES (UUID(), NULL, ?, 'nonSerialized', ?, ?, ?)",
                        [safeItemId, type, warehouseGuid || null, safeQuantity]
                    );
                }
            }

            // Record Transaction
            if (isSerialized) {
                await connection.query(`
                    INSERT INTO fbf_fba_transactions (guid, modelGuid, itemId, itemKind, type, warehouseGuid, transactionType, quantity, serialNumbers, createdBy)
                    VALUES (UUID(), ?, NULL, 'serialized', ?, ?, 'IN', ?, ?, ?)
                `, [safeModelId, type, warehouseGuid || null, safeQuantity, JSON.stringify(serialNumbers || []), createdBy]);
            } else {
                await connection.query(`
                    INSERT INTO fbf_fba_transactions (guid, modelGuid, itemId, itemKind, type, warehouseGuid, transactionType, quantity, serialNumbers, createdBy)
                    VALUES (UUID(),  NULL, ?, 'nonSerialized', ?, ?, 'IN', ?, ?, ?)
                `, [safeItemId || null, type, warehouseGuid || null, safeQuantity, JSON.stringify(serialNumbers || []), createdBy]);
            }

            // Sync with Main Inventory (Update Serials status)
            if (isSerialized && serialNumbers && serialNumbers.length > 0) {
                await connection.query(
                    "UPDATE serials SET status = ? WHERE value IN (?) AND modelGuid = ?",
                    [type, serialNumbers, safeModelId]
                );

                // Record movements for each serial
                for (const sn of serialNumbers) {
                    const [sRow] = await connection.query("SELECT guid FROM serials WHERE value = ?", [sn]);
                    if (sRow.length > 0) {
                        await helpers.recordSerialMovement(connection, {
                            serialGuid: sRow[0].guid,
                            serialValue: sn,
                            actionType: type,
                            status: type,
                            notes: `Moved to ${type} stock`,
                            createdBy: createdBy
                        });
                    }
                }
            }

            await connection.commit();
            res.json({ message: `Successfully added ${safeQuantity} items to ${type}` });
        } catch (err) {
            if (connection) await connection.rollback();
            res.status(500).json({ message: err.message });
        } finally {
            if (connection) connection.release();
        }
    });

    // 2. Get FBF/FBA Stock View
    router.get('/stock', async (req, res) => {
        try {
            const { type } = req.query; // FBF or FBA
            const pool = await getPool(res);
            const [rows] = await pool.query(`
                SELECT 
                    s.*,
                    w.platform as whPlatform,
                    w.state as whState,
                    w.warehouseName as whName,
                    COALESCE(m.name, i.itemName) as modelName,
                    COALESCE(m.company, b.brandName) as company,
                    CASE WHEN s.itemKind = 'serialized' THEN m.isSerialized ELSE 0 END as isSerialized,
                    (SELECT GROUP_CONCAT(value) FROM serials WHERE status = s.type AND modelGuid = s.modelGuid AND isDeleted = 0) as activeSerials
                FROM fbf_fba_stock s
                LEFT JOIN models m ON s.modelGuid = m.guid
                LEFT JOIN inventoryitemmaster i ON s.itemId = i.itemId
                LEFT JOIN inventorybrandmaster b ON i.brandId = b.brandId
                LEFT JOIN fbf_fba_warehouses w ON s.warehouseGuid = w.guid
                WHERE s.type = ? AND s.quantity > 0
                ORDER BY whPlatform ASC, whName ASC, modelName ASC
            `, [type]);
            res.json(rows);
        } catch (err) {
            res.status(500).json({ message: err.message });
        }
    });

    // 3. Sell / Out Functionality (FIFO Logic)
    router.post('/sell-out', async (req, res) => {
        let connection;
        try {
            const { modelGuid, itemId, type, quantity, amount, transactionDate, referenceId, createdBy, warehouseGuid } = req.body;
            const itemKind = req.body.itemKind || (itemId ? 'nonSerialized' : 'serialized');
            const isSerialized = itemKind === 'serialized';
            const safeItemId = isSerialized ? null : String(itemId || '').trim();
            const safeQuantity = Number(quantity);
            const safeAmount = amount === null || amount === undefined || amount === '' ? null : Number(amount);
            const safeTransactionDate = transactionDate ? new Date(transactionDate) : new Date();

            if (safeAmount !== null && (!Number.isFinite(safeAmount) || safeAmount < 0)) {
                return res.status(400).json({ message: "Amount must be a valid positive number" });
            }

            if (Number.isNaN(safeTransactionDate.getTime())) {
                return res.status(400).json({ message: "Invalid sell out date" });
            }

            const pool = await getPool(res);
            connection = await pool.getConnection();
            const safeModelId = isSerialized ? await resolveModelId(connection, modelGuid) : null;

            if (isSerialized && !safeModelId) {
                return res.status(400).json({ message: "Model is required for serialized stock" });
            }

            if (!isSerialized && !safeItemId) {
                return res.status(400).json({ message: "Item is required for non-serialized stock" });
            }

            if (!Number.isFinite(safeQuantity) || safeQuantity <= 0) {
                return res.status(400).json({ message: "Quantity must be greater than zero" });
            }

            await connection.beginTransaction();

            // 1. Check Availability
            const [stock] = isSerialized
                ? await connection.query("SELECT quantity FROM fbf_fba_stock WHERE modelGuid = ? AND type = ? AND (warehouseGuid = ? OR (warehouseGuid IS NULL AND ? IS NULL))", [safeModelId, type, warehouseGuid || null, warehouseGuid || null])
                : await connection.query("SELECT quantity FROM fbf_fba_stock WHERE itemKind = 'nonSerialized' AND itemId = ? AND type = ? AND (warehouseGuid = ? OR (warehouseGuid IS NULL AND ? IS NULL))", [safeItemId, type, warehouseGuid || null, warehouseGuid || null]);

            if (!stock[0] || stock[0].quantity < safeQuantity) {
                throw new Error("Insufficient stock in " + type);
            }

            let soldSerials = [];
            // 2. FIFO Serial Handling
            if (isSerialized) {
                const [model] = await connection.query("SELECT isSerialized FROM models WHERE guid = ?", [safeModelId]);
                // Find oldest serials currently in this bucket
                const [availableSerials] = await connection.query(`
                    SELECT guid, value FROM serials 
                    WHERE modelGuid = ? AND status = ? AND isDeleted = 0 
                    ORDER BY createdAt ASC LIMIT ?
                `, [safeModelId, type, safeQuantity]);

                if (model[0]?.isSerialized && availableSerials.length < safeQuantity) throw new Error("Not enough serialized units found");

                soldSerials = availableSerials.map(s => s.value);
                const serialIds = availableSerials.map(s => s.guid);

                // Mark as Sold
                await connection.query("UPDATE serials SET status = 'Sold' WHERE guid IN (?)", [serialIds]);

                for (const sObj of availableSerials) {
                    await helpers.recordSerialMovement(connection, {
                        serialGuid: sObj.guid,
                        serialValue: sObj.value,
                        actionType: 'Sold',
                        status: 'Sold',
                        notes: `Sold via ${type} (Ref: ${referenceId})`,
                        createdBy: createdBy
                    });
                }
            }

            // 3. Deduct Stock
            if (isSerialized) {
                await connection.query("UPDATE fbf_fba_stock SET quantity = quantity - ? WHERE modelGuid = ? AND type = ? AND (warehouseGuid = ? OR (warehouseGuid IS NULL AND ? IS NULL))", [safeQuantity, safeModelId, type, warehouseGuid || null, warehouseGuid || null]);
            } else {
                await connection.query("UPDATE fbf_fba_stock SET quantity = quantity - ? WHERE itemKind = 'nonSerialized' AND itemId = ? AND type = ? AND (warehouseGuid = ? OR (warehouseGuid IS NULL AND ? IS NULL))", [safeQuantity, safeItemId, type, warehouseGuid || null, warehouseGuid || null]);
            }

            // 4. Record Transaction
            if (isSerialized) {
                await connection.query(`
                    INSERT INTO fbf_fba_transactions (guid, modelGuid, itemId, itemKind, type, warehouseGuid, transactionType, quantity, amount, transactionDate, referenceId, serialNumbers, createdBy)
                    VALUES (UUID(), ?, NULL, 'serialized', ?, ?, 'OUT', ?, ?, ?, ?, ?, ?)
                `, [safeModelId, type, warehouseGuid || null, safeQuantity, safeAmount, safeTransactionDate, referenceId, JSON.stringify(soldSerials), createdBy]);
            } else {
                await connection.query(`
                    INSERT INTO fbf_fba_transactions (guid, modelGuid, itemId, itemKind, type, warehouseGuid, transactionType, quantity, amount, transactionDate, referenceId, serialNumbers, createdBy)
                    VALUES (UUID(), NULL, ?, 'nonSerialized', ?, ?, 'OUT', ?, ?, ?, ?, ?, ?)
                `, [safeItemId || null, type, warehouseGuid || null, safeQuantity, safeAmount, safeTransactionDate, referenceId, JSON.stringify(soldSerials), createdBy]);
            }

            await connection.commit();
            res.json({ message: "Stock updated successfully", soldSerials });
        } catch (err) {
            if (connection) await connection.rollback();
            res.status(500).json({ message: err.message });
        } finally {
            if (connection) connection.release();
        }
    });

    router.put('/stock/:guid', async (req, res) => {
        try {
            const { guid } = req.params;
            const { warehouseGuid, quantity, modelGuid, itemId } = req.body;
            const pool = await getPool(res);
            if (!pool) return;

            const [existing] = await pool.query('SELECT * FROM fbf_fba_stock WHERE guid = ?', [guid]);
            if (existing.length === 0) {
                return res.status(404).json({ message: 'Stock record not found' });
            }

            const currentRecord = existing[0];

            let finalQuantity = currentRecord.quantity;
            if (currentRecord.itemKind === 'nonSerialized') {
                finalQuantity = quantity !== undefined ? Number(quantity) : currentRecord.quantity;
            }

            await pool.query(
                `UPDATE fbf_fba_stock 
                 SET warehouseGuid = COALESCE(?, warehouseGuid), 
                     quantity = ?, 
                     modelGuid = COALESCE(?, modelGuid), 
                     itemId = COALESCE(?, itemId),
                     lastUpdated = NOW()
                 WHERE guid = ?`,
                [warehouseGuid || null, finalQuantity, modelGuid || null, itemId || null, guid]
            );

            res.json({ message: 'Stock updated successfully' });
        } catch (error) {
            res.status(500).json({ message: error.message });
        }
    });

    // Register router to /api/fbf-fba
    app.use('/api/fbf-fba', router);
}

module.exports = { setupFbfFbaRoutes };
