const { v4: uuidv4 } = require('uuid');

// Map<userId, Set<res>> — O(1) lookup per user
const sseClients = new Map();

function addSSEClient(userId, res) {
    const id = String(userId);
    if (!sseClients.has(id)) sseClients.set(id, new Set());
    sseClients.get(id).add(res);
    res.on('close', () => {
        const set = sseClients.get(id);
        if (set) {
            set.delete(res);
            if (set.size === 0) sseClients.delete(id);
        }
    });
}

function sendSSEToUser(userId, data) {
    const set = sseClients.get(String(userId));
    if (!set) return;
    const payload = `data: ${JSON.stringify(data)}\n\n`;
    set.forEach(res => res.write(payload));
}

async function createNotification(pool, { targetUserGuid, targetRole, title, message, type = 'info', priority = 'low', link = null }) {
    try {
        let usersToNotify = [];

        if (targetUserGuid) {
            usersToNotify.push(targetUserGuid);
        }
        
        if (targetRole) {
            const [rows] = await pool.query("SELECT userid FROM users WHERE role = ?", [targetRole]);
            usersToNotify.push(...rows.map(r => String(r.userid)));
        }

        usersToNotify = [...new Set(usersToNotify)];
        if (usersToNotify.length === 0) return;

        const values = usersToNotify.map(uid => [
            uuidv4(), uid, title, message, type, priority, link
        ]);

        await pool.query(
            "INSERT INTO notifications (guid, targetUserGuid, title, message, type, priority, link) VALUES ?",
            [values]
        );

        // Map values to object for SSE
        const newNotifs = values.map(v => ({
            guid: v[0], targetUserGuid: v[1], title: v[2], message: v[3], type: v[4], priority: v[5], link: v[6], isRead: 0, createdAt: new Date().toISOString()
        }));

        newNotifs.forEach(notif => {
            sendSSEToUser(notif.targetUserGuid, { type: 'NEW_NOTIFICATION', payload: notif });
        });

    } catch (err) {
        console.error("Error creating notification:", err);
    }
}

async function handleOrderUpdates(pool, current, merged, orderId) {
    const finalStatus = merged.status;
    const finalLogisticsStatus = merged.logisticsStatus;
    const trackingId = merged.trackingId;
    const displayOrderId = current.orderid || current._orderId || orderId;

    let creatorGuid = null;
    if (current.dispatchedBy) {
        const [creatorRows] = await pool.query("SELECT userid FROM users WHERE username = ?", [current.dispatchedBy]);
        if (creatorRows.length > 0) creatorGuid = String(creatorRows[0].userid);
    }

    if (current.status !== finalStatus) {
        let displayStatus = finalStatus;
        if (finalStatus === "Billed") displayStatus = "Packing in Process";

        await createNotification(pool, {
            targetRole: 'Admin',
            targetUserGuid: creatorGuid,
            title: 'Order Status Changed',
            message: `Order ${displayOrderId} changed from ${current.status || 'Pending'} to ${displayStatus}`,
            type: 'info',
            link: '/orderTracking'
        });
        
        if (finalStatus === "Send for Billing") {
            await createNotification(pool, {
                targetRole: 'Accountant',
                title: 'Order Ready for Billing',
                message: `Order ${displayOrderId} is ready for billing.`,
                type: 'warning',
                link: '/billing'
            });
        }
        
        if (finalStatus === "Billed" && creatorGuid) {
            await createNotification(pool, {
                targetUserGuid: creatorGuid,
                title: 'Billing Completed',
                message: `Billing completed for your order ${displayOrderId}. It has moved to Dispatch.`,
                type: 'success',
                link: '/dispatch'
            });
        }
    }

    if (current.logisticsStatus !== finalLogisticsStatus || current.trackingId !== trackingId) {
        await createNotification(pool, {
            targetRole: 'Admin',
            targetUserGuid: creatorGuid,
            title: 'Logistics Updated',
            message: `Logistics/Tracking updated for Order ${displayOrderId}`,
            type: 'info',
            link: '/dispatch'
        });
    }
}

module.exports = {
    addSSEClient,
    sendSSEToUser,
    createNotification,
    handleOrderUpdates
};
