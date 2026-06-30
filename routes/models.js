const router = require("express").Router();
const { mysqlPool } = require("../db");
const { logUserActivity } = require("../helpers");

router.get("/", async (req, res) => {
  try {
    const [rows] = await mysqlPool.query(`
      SELECT m.*, m.guid as id, m.\`ssd/hdd\` AS ssd,
        IFNULL(stock.availableCount,0) as stockCount,
        (SELECT landingPrice FROM serials WHERE modelGuid=m.guid AND isDeleted=0 ORDER BY createdAt DESC LIMIT 1) as lastLandingPrice
      FROM models m
      LEFT JOIN (
        SELECT modelGuid, COUNT(*) as availableCount FROM serials
        WHERE status='Available' AND isDeleted=0 GROUP BY modelGuid
      ) stock ON stock.modelGuid=m.guid
      WHERE m.isDeleted=0
      ORDER BY m.name ASC
    `);
    res.json(rows);
  } catch (err) {
    console.error("[models] GET /:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

router.post("/", async (req, res) => {
  try {
    const { name, company, category, colorType, printerType, description, mrp, isSerialized, stockQuantity, packagingCost, mainCategory, cpu, ram, ssd, barcode, screenSize, resolution, panelType, refreshRate } = req.body;
    if (name) {
      const [dup] = await mysqlPool.query("SELECT guid FROM models WHERE LOWER(TRIM(name))=LOWER(TRIM(?)) AND isDeleted=0", [name]);
      if (dup.length > 0) return res.status(400).json({ message: "A model with this name already exists." });
    }
    if (barcode && barcode.trim()) {
      const [bDup] = await mysqlPool.query("SELECT guid FROM models WHERE barcode=? AND isDeleted=0", [barcode.trim()]);
      if (bDup.length > 0) return res.status(400).json({ message: "This barcode is already assigned to another model." });
    }
    await mysqlPool.query(
      "INSERT INTO models (guid,name,company,category,colorType,printerType,description,mrp,isSerialized,stockQuantity,packagingCost,mainCategory,cpu,ram,`ssd/hdd`,barcode,screenSize,resolution,panelType,refreshRate,isDeleted) VALUES (UUID(),?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)",
      [name, company, category, colorType || "Monochrome", printerType || "Multi-Function", description, mrp || 0, isSerialized !== false, stockQuantity || 0, packagingCost || 0, mainCategory || "Printer", cpu || null, ram || null, ssd || null, barcode?.trim() || null, screenSize || null, resolution || null, panelType || null, refreshRate || null]
    );
    await logUserActivity(mysqlPool, req.user, "Add Model", [{ field: "name", newValue: name }], req.ip);
    res.json({ message: "Model added" });
  } catch (err) {
    console.error("[models] POST /:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { name, company, category, colorType, printerType, description, mrp, isSerialized, stockQuantity, packagingCost, mainCategory, cpu, ram, ssd, barcode, screenSize, resolution, panelType, refreshRate } = req.body;

    const [existing] = await mysqlPool.query("SELECT * FROM models WHERE guid=? AND isDeleted=0", [id]);
    if (!existing.length) return res.status(404).json({ message: "Model not found" });
    const cur = existing[0];

    if (name && name.trim().toLowerCase() !== (cur.name || "").trim().toLowerCase()) {
      const [dup] = await mysqlPool.query("SELECT guid FROM models WHERE LOWER(TRIM(name))=LOWER(TRIM(?)) AND guid!=? AND isDeleted=0", [name, id]);
      if (dup.length > 0) return res.status(400).json({ message: "A model with this name already exists." });
    }
    if (barcode && barcode.trim() && barcode.trim() !== (cur.barcode || "")) {
      const [bDup] = await mysqlPool.query("SELECT guid FROM models WHERE barcode=? AND guid!=? AND isDeleted=0", [barcode.trim(), id]);
      if (bDup.length > 0) return res.status(400).json({ message: "This barcode is already assigned to another model." });
    }

    const fc = (v, fb) => (v !== undefined && v !== "") ? v : fb;
    const newBarcode = barcode !== undefined ? (barcode?.trim() || null) : cur.barcode;

    await mysqlPool.query(
      "UPDATE models SET name=?,company=?,category=?,colorType=?,printerType=?,description=?,mrp=?,isSerialized=?,stockQuantity=?,packagingCost=?,mainCategory=?,cpu=?,ram=?,`ssd/hdd`=?,barcode=?,screenSize=?,resolution=?,panelType=?,refreshRate=? WHERE guid=? AND isDeleted=0",
      [name || cur.name, company || cur.company, category || cur.category,
        fc(colorType, cur.colorType || "Monochrome"), fc(printerType, cur.printerType || "Multi-Function"),
        description !== undefined ? description : cur.description,
        mrp !== undefined ? mrp : cur.mrp,
        isSerialized !== undefined ? isSerialized : cur.isSerialized,
        stockQuantity !== undefined ? stockQuantity : cur.stockQuantity,
        packagingCost !== undefined ? packagingCost : cur.packagingCost,
        fc(mainCategory, cur.mainCategory || "Printer"),
        cpu !== undefined ? cpu : cur.cpu,
        ram !== undefined ? ram : cur.ram,
        ssd !== undefined ? ssd : cur["ssd/hdd"],
        newBarcode,
        screenSize !== undefined ? screenSize : cur.screenSize,
        resolution !== undefined ? resolution : cur.resolution,
        panelType !== undefined ? panelType : cur.panelType,
        refreshRate !== undefined ? refreshRate : cur.refreshRate,
        id]
    );
    await logUserActivity(mysqlPool, req.user, "Update Model", [{ field: "name", newValue: name || cur.name }], req.ip);
    res.json({ message: "Model updated" });
  } catch (err) {
    console.error("[models] PUT /:id:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const [check] = await mysqlPool.query("SELECT COUNT(*) as c FROM serials WHERE modelGuid=? AND isDeleted=0", [id]);
    if (check[0].c > 0) return res.status(400).json({ message: "Cannot delete: Model has active serials." });
    await mysqlPool.query("UPDATE models SET isDeleted=1 WHERE guid=?", [id]);
    await logUserActivity(mysqlPool, req.user, "Delete Model", [{ field: "id", oldValue: id, newValue: "Deleted" }], req.ip);
    res.json({ message: "Model deleted (soft)" });
  } catch (err) {
    console.error("[models] DELETE /:id:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

router.post("/bulk-delete", async (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [req.body.ids];
    const results = { success: [], failed: [] };
    for (const id of ids) {
      try {
        const [check] = await mysqlPool.query("SELECT COUNT(*) as c FROM serials WHERE modelGuid=? AND isDeleted=0", [id]);
        if (check[0].c > 0) { results.failed.push({ id, reason: "Has active serials" }); continue; }
        await mysqlPool.query("UPDATE models SET isDeleted=1 WHERE guid=?", [id]);
        results.success.push(id);
      } catch (e) { results.failed.push({ id, reason: e.message }); }
    }
    res.json({ message: "Bulk delete completed", results });
  } catch (err) {
    console.error("[models] bulk-delete:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

module.exports = router;
