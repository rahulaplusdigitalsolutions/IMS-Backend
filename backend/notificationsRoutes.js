const express = require('express');
const { addSSEClient } = require('./notificationService');
const { mysqlPool } = require('./db');
const { sanitizeUser, verifyToken } = require('./helpers');

// EventSource cannot send headers, so the SSE stream authenticates via query param.
async function requireAuthViaQueryToken(req, res, next) {
    const token = req.query.token;
    if (!token) return res.status(401).json({ message: "Authentication required" });
    try {
        const payload = verifyToken(token);
        if (!payload) return res.status(401).json({ message: "Authentication required" });
        const [rows] = await mysqlPool.query("SELECT * FROM users WHERE userid = ? LIMIT 1", [payload.id]);
        const user = rows[0] ? sanitizeUser(rows[0]) : null;
        if (!user) return res.status(401).json({ message: "Authentication required" });
        req.user = user;
        return next();
    } catch (err) {
        console.error("[notifications/stream] auth error:", err.message);
        return res.status(500).json({ message: "Internal server error" });
    }
}

module.exports = function (requireAuth, getMysqlPool) {
    const router = express.Router();

    // SSE Stream endpoint
    router.get('/stream', requireAuthViaQueryToken, (req, res) => {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        // Send an initial heartbeat
        res.write('data: {"type":"CONNECTED"}\n\n');

        addSSEClient(req.user.id, res);

        const heartbeat = setInterval(() => {
            res.write(':\n\n'); // SSE comment for heartbeat
        }, 30000);

        res.on('close', () => clearInterval(heartbeat));
    });

    // Get user's notifications
    router.get('/', requireAuth, async (req, res) => {
        try {
            const pool = await getMysqlPool();
            const limit = parseInt(req.query.limit) || 50;
            const offset = parseInt(req.query.offset) || 0;
            
            const [rows] = await pool.query(
                "SELECT * FROM notifications WHERE targetUserGuid = ? ORDER BY createdAt DESC LIMIT ? OFFSET ?",
                [req.user.id, limit, offset]
            );

            const [unreadCountRow] = await pool.query(
                "SELECT COUNT(*) as unread FROM notifications WHERE targetUserGuid = ? AND isRead = FALSE",
                [req.user.id]
            );

            res.json({
                notifications: rows,
                unreadCount: unreadCountRow[0].unread
            });
        } catch (err) {
            console.error(err);
            res.status(500).json({ message: "Error fetching notifications" });
        }
    });

    // Mark as read
    router.put('/:guid/read', requireAuth, async (req, res) => {
        try {
            const pool = await getMysqlPool();
            await pool.query(
                "UPDATE notifications SET isRead = TRUE WHERE guid = ? AND targetUserGuid = ?",
                [req.params.guid, req.user.id]
            );
            res.json({ success: true });
        } catch (err) {
            console.error(err);
            res.status(500).json({ message: "Error updating notification" });
        }
    });

    // Mark all as read
    router.put('/read-all', requireAuth, async (req, res) => {
        try {
            const pool = await getMysqlPool();
            await pool.query(
                "UPDATE notifications SET isRead = TRUE WHERE targetUserGuid = ? AND isRead = FALSE",
                [req.user.id]
            );
            res.json({ success: true });
        } catch (err) {
            console.error(err);
            res.status(500).json({ message: "Error updating notifications" });
        }
    });

    // Clear all
    router.delete('/clear-all', requireAuth, async (req, res) => {
        try {
            const pool = await getMysqlPool();
            await pool.query(
                "DELETE FROM notifications WHERE targetUserGuid = ?",
                [req.user.id]
            );
            res.json({ success: true });
        } catch (err) {
            console.error(err);
            res.status(500).json({ message: "Error deleting notifications" });
        }
    });

    // Delete a single notification
    router.delete('/:guid', requireAuth, async (req, res) => {
        try {
            const pool = await getMysqlPool();
            await pool.query(
                "DELETE FROM notifications WHERE guid = ? AND targetUserGuid = ?",
                [req.params.guid, req.user.id]
            );
            res.json({ success: true });
        } catch (err) {
            console.error(err);
            res.status(500).json({ message: "Error deleting notification" });
        }
    });

    return router;
};
