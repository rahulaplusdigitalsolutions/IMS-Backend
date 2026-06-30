const router = require("express").Router();
const crypto = require("crypto");
const { mysqlPool } = require("../db");
const { safeStr, toBit, logUserActivity } = require("../helpers");

router.get("/transfer-history", async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = (page - 1) * limit;
    const [countRows] = await mysqlPool.query("SELECT COUNT(*) as total FROM stocktransferhistory");
    const [rows] = await mysqlPool.query("SELECT * FROM stocktransferhistory ORDER BY transferDate DESC LIMIT ? OFFSET ?", [limit, offset]);
    res.json({ data: rows, total: countRows[0].total, page, limit });
  } catch (err) {
    console.error("[godowns] transfer-history:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

router.post("/transfer", async (req, res) => {
  try {
    const { sourceGodownId, destinationGodownId, serialIds, modelName } = req.body;
    if (!sourceGodownId || !destinationGodownId || !serialIds?.length) return res.status(400).json({ message: "Missing required fields" });
    if (sourceGodownId === destinationGodownId) return res.status(400).json({ message: "Source and destination godowns cannot be the same" });

    const [srcG] = await mysqlPool.query("SELECT godownName FROM godowns WHERE guid=?", [sourceGodownId]);
    const [dstG] = await mysqlPool.query("SELECT godownName FROM godowns WHERE guid=?", [destinationGodownId]);
    if (!srcG.length || !dstG.length) return res.status(400).json({ message: "Invalid godown selected" });

    const [serials] = await mysqlPool.query(
      "SELECT guid, value FROM serials WHERE guid IN (?) AND godownGuid=? AND status='Available' AND isDeleted=0",
      [serialIds, sourceGodownId]
    );
    if (serials.length !== serialIds.length) return res.status(400).json({ message: "Some serials are no longer available in the source godown" });

    const conn = await mysqlPool.getConnection();
    await conn.beginTransaction();
    try {
      await conn.query("UPDATE serials SET godownGuid=? WHERE guid IN (?)", [destinationGodownId, serialIds]);
      const transferId = crypto.randomUUID();
      for (const s of serials) {
        await conn.query(
          "INSERT INTO stocktransferhistory (transferId,modelName,serialNumber,fromGodown,toGodown,transferredBy) VALUES (?,?,?,?,?,?)",
          [transferId, modelName || "Unknown Model", s.value, srcG[0].godownName, dstG[0].godownName, req.user?.username || "System"]
        );
      }
      await conn.commit();
      await logUserActivity(mysqlPool, req.user, "Stock Transfer", [{ field: "model", newValue: modelName }, { field: "count", newValue: serialIds.length }, { field: "from", newValue: srcG[0].godownName }, { field: "to", newValue: dstG[0].godownName }], req.ip);
      res.json({ message: "Stock transferred successfully", transferId });
    } catch (e) { await conn.rollback(); throw e; }
    finally { conn.release(); }
  } catch (err) {
    console.error("[godowns] transfer:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

router.get("/:id/models", async (req, res) => {
  try {
    const [rows] = await mysqlPool.query(
      `SELECT m.guid as modelId, m.name as modelName, COUNT(s.guid) as availableCount
       FROM serials s JOIN models m ON s.modelGuid=m.guid
       WHERE s.godownGuid=? AND s.status='Available' AND s.isDeleted=0
       GROUP BY m.guid, m.name ORDER BY m.name ASC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    console.error("[godowns] /:id/models:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

router.get("/:id/models/:modelId/serials", async (req, res) => {
  try {
    const { id, modelId } = req.params;
    const [rows] = await mysqlPool.query(
      "SELECT guid as id, value as serialNumber FROM serials WHERE godownGuid=? AND modelGuid=? AND status='Available' AND isDeleted=0 ORDER BY value ASC",
      [id, modelId]
    );
    res.json(rows);
  } catch (err) {
    console.error("[godowns] /:id/models/:modelId/serials:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

router.get("/", async (req, res) => {
  try {
    const [rows] = await mysqlPool.query(
      "SELECT guid, godownName, godownAddress, isDefault, createdAt, updatedAt FROM godowns WHERE isDeleted=0 ORDER BY isDefault DESC, godownName ASC"
    );
    res.json(rows);
  } catch (err) {
    console.error("[godowns] GET /:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

router.post("/", async (req, res) => {
  try {
    const { godownName, godownAddress, isDefault } = req.body;
    const name = safeStr(godownName, "");
    if (!name) return res.status(400).json({ message: "Godown name is required" });
    if (toBit(isDefault)) await mysqlPool.query("UPDATE godowns SET isDefault=0 WHERE isDeleted=0");
    const guid = crypto.randomUUID();
    await mysqlPool.query("INSERT INTO godowns (guid,godownName,godownAddress,isDefault) VALUES (?,?,?,?)", [guid, name, safeStr(godownAddress, ""), toBit(isDefault) ? 1 : 0]);
    await logUserActivity(mysqlPool, req.user, "Add Godown", [{ field: "name", newValue: name }], req.ip);
    res.status(201).json({ message: "Godown added", guid });
  } catch (err) {
    console.error("[godowns] POST /:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { godownName, godownAddress, isDefault } = req.body;
    const name = safeStr(godownName, "");
    if (!name) return res.status(400).json({ message: "Godown name is required" });
    if (toBit(isDefault)) await mysqlPool.query("UPDATE godowns SET isDefault=0 WHERE guid<>? AND isDeleted=0", [id]);
    await mysqlPool.query("UPDATE godowns SET godownName=?,godownAddress=?,isDefault=? WHERE guid=? AND isDeleted=0", [name, safeStr(godownAddress, ""), toBit(isDefault) ? 1 : 0, id]);
    await logUserActivity(mysqlPool, req.user, "Update Godown", [{ field: "name", newValue: name }], req.ip);
    res.json({ message: "Godown updated" });
  } catch (err) {
    console.error("[godowns] PUT /:id:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await mysqlPool.query("UPDATE serials SET godownGuid=NULL WHERE godownGuid=?", [id]);
    await mysqlPool.query("UPDATE godowns SET isDeleted=1 WHERE guid=?", [id]);
    await logUserActivity(mysqlPool, req.user, "Delete Godown", [{ field: "id", oldValue: id, newValue: "Deleted" }], req.ip);
    res.json({ message: "Godown deleted" });
  } catch (err) {
    console.error("[godowns] DELETE /:id:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

module.exports = router;
