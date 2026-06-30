const express = require('express');

function setupDropdownRoutes(app, getPool, requireAuth) {
    
    // API to get dropdown options by dropdown_code
    app.get('/api/dropdown/:code', requireAuth, async (req, res) => {
        try {
            const { code } = req.params;
            const pool = await getPool(res);
            if (!pool) return;

            // Query using both tables with a JOIN
            const query = `
                SELECT o.option_label AS label, o.option_value AS value 
                FROM dropdown_option o
                JOIN dropdown_master m ON o.dropdown_id = m.id
                WHERE m.dropdown_code = ? 
                  AND m.is_active = 1 
                  AND o.is_active = 1
                ORDER BY o.display_order ASC
            `;
            
            const [rows] = await pool.query(query, [code]);
            
            res.json({ 
                success: true, 
                data: rows 
            });
        } catch (err) {
            console.error(`Error fetching dropdown for ${req.params.code}:`, err);
            res.status(500).json({ 
                success: false, 
                message: err.message 
            });
        }
    });

    // Optional: API to get all active masters (useful for admin screens)
    app.get('/api/dropdown-masters', requireAuth, async (req, res) => {
        try {
            const pool = await getPool(res);
            if (!pool) return;

            const [rows] = await pool.query(`
                SELECT id, dropdown_code, dropdown_name, description 
                FROM dropdown_master 
                WHERE is_active = 1
            `);
            
            res.json({ 
                success: true, 
                data: rows 
            });
        } catch (err) {
            res.status(500).json({ 
                success: false, 
                message: err.message 
            });
        }
    });
}

module.exports = { setupDropdownRoutes };
