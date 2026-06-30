const router = require("express").Router();
const fs = require("fs");
const { randomUUID } = require("crypto");
const xlsx = require("xlsx");
const { mysqlPool } = require("../db");
const { logUserActivity } = require("../helpers");
const { upload } = require("../middleware/upload");

router.get("/download-template", async (req, res) => {
  try {
    const [models] = await mysqlPool.query("SELECT guid as id, name, company, mrp FROM models WHERE isDeleted=0 ORDER BY name");
    const [godowns] = await mysqlPool.query("SELECT guid, godownName, godownAddress FROM godowns WHERE isDeleted=0 ORDER BY isDefault DESC, godownName ASC");

    const wb = xlsx.utils.book_new();
    const tpl = xlsx.utils.json_to_sheet([{ modelId: "paste-model-guid-here", "Model Name (For Reference)": "", godownGuid: "optional-godown-guid", "Godown Name (For Reference)": "", value: "SAMPLE-SER-001", landingPrice: 25000, status: "Available", landingPriceReason: "" }]);
    tpl["!cols"] = [{ wch: 38 }, { wch: 25 }, { wch: 38 }, { wch: 25 }, { wch: 18 }, { wch: 12 }, { wch: 12 }, { wch: 30 }];
    xlsx.utils.book_append_sheet(wb, tpl, "1. Upload Serials Here");

    const mSheet = xlsx.utils.json_to_sheet(models.map((m) => ({ "Model ID": m.id, "Model Name": m.name, Company: m.company, MRP: m.mrp })));
    mSheet["!cols"] = [{ wch: 38 }, { wch: 30 }, { wch: 20 }, { wch: 12 }];
    xlsx.utils.book_append_sheet(wb, mSheet, "2. Find Model IDs Here");

    const gSheet = xlsx.utils.json_to_sheet(godowns.map((g) => ({ "Godown GUID": g.guid, "Godown Name": g.godownName, Address: g.godownAddress || "" })));
    gSheet["!cols"] = [{ wch: 38 }, { wch: 30 }, { wch: 40 }];
    xlsx.utils.book_append_sheet(wb, gSheet, "3. Find Godowns Here");

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", "attachment; filename=serial_upload_template.xlsx");
    res.send(xlsx.write(wb, { type: "buffer", bookType: "xlsx" }));
  } catch (err) {
    console.error("[serials] download-template:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

router.get("/export-excel", async (req, res) => {
  try {
    const [rows] = await mysqlPool.query(`
      SELECT s.guid as id, s.modelGuid as modelId,
             COALESCE(m.name, CONCAT(i.itemName, ' (', itv.variantName, ')'), 'Unknown Item') as modelName,
             COALESCE(m.company, b.brandName, '') as company,
             s.value as serialNumber, s.godownGuid, g.godownName, s.landingPrice,
             COALESCE(m.mrp, 0) as mrp,
             s.status, s.landingPriceReason, s.createdAt
      FROM serials s
      LEFT JOIN models m ON s.modelGuid=m.guid AND m.isDeleted=0
      LEFT JOIN inventoryitemvariant itv ON s.modelGuid=itv.itemVariantId AND itv.isDeleted=0
      LEFT JOIN inventoryitemmaster i ON itv.itemId=i.itemId AND i.isDeleted=0
      LEFT JOIN inventorybrandmaster b ON i.brandId=b.brandId AND b.isDeleted=0
      LEFT JOIN godowns g ON s.godownGuid=g.guid AND g.isDeleted=0
      WHERE s.isDeleted=0
    `);
    const data = rows.map((r) => ({
      ID: r.id, "Model ID": r.modelId, "Model Name": r.modelName, Company: r.company,
      "Serial Number": r.serialNumber, Godown: r.godownName || "", "Godown GUID": r.godownGuid || "",
      "Landing Price": r.landingPrice, MRP: r.mrp, Status: r.status,
      "Price Reason": r.landingPriceReason || "",
      "Created At": r.createdAt ? new Date(r.createdAt).toLocaleString("en-IN") : "",
    }));
    const ws = xlsx.utils.json_to_sheet(data);
    ws["!cols"] = [8, 38, 25, 15, 25, 25, 38, 15, 12, 12, 25, 20].map((w) => ({ wch: w }));
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, "Serials");
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename=serials_export_${Date.now()}.xlsx`);
    res.send(xlsx.write(wb, { type: "buffer", bookType: "xlsx" }));
  } catch (err) {
    console.error("[serials] export-excel:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

router.post("/upload-excel", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: "No file uploaded" });
    const targetModelId = req.body.targetModelId ? String(req.body.targetModelId).trim() : null;

    const wb = xlsx.readFile(req.file.path);
    const data = xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
    if (!data.length) { fs.unlinkSync(req.file.path); return res.status(400).json({ message: "Excel file is empty" }); }

    const results = { success: [], failed: [], skipped: [], totalRows: data.length };

    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const rowNum = i + 2;
      try {
        const modelIdValue = row.modelId || row.modelid || row.ModelId || row["Model ID"] || row.model_id;
        const serialValue = row.value || row.Value || row.serialNumber || row.SerialNumber || row["Serial Number"] || row["Serial No"] || row.serial;
        const lpKey = Object.keys(row).find((k) => k.toLowerCase().replace(/[^a-z]/g, "") === "landingprice");
        const rawLp = lpKey ? row[lpKey] : 0;
        const statusValue = row.status || row.Status || "Available";
        const reasonValue = row.landingPriceReason || row.LandingPriceReason || row.reason || row.Reason || null;
        const godownGuidValue = row.godownGuid || row.GodownGuid || row["Godown GUID"] || row["Godown Id"] || row["Godown ID"] || row.warehouseGuid || row["Warehouse GUID"] || null;

        if (!modelIdValue || !serialValue) { results.failed.push({ row: rowNum, serialNumber: serialValue || "N/A", reason: "Missing required fields: modelId or value" }); continue; }

        const modelId = String(modelIdValue).trim();
        if (targetModelId && modelId !== targetModelId) { results.skipped.push({ row: rowNum, serialNumber: String(serialValue), reason: "Skipped (Model Filter)" }); continue; }

        const trimmedSerial = String(serialValue).trim();
        let cleanLp = 0;
        if (rawLp !== undefined && rawLp !== null && rawLp !== "") cleanLp = Number(String(rawLp).replace(/[^0-9.]/g, ""));
        const landingPrice = isNaN(cleanLp) ? 0 : cleanLp;
        const landingPriceReason = reasonValue ? String(reasonValue).trim() : null;

        const [mCheck] = await mysqlPool.query("SELECT guid as id, mrp, name FROM models WHERE guid=? AND isDeleted=0", [modelId]);
        if (!mCheck.length) { results.failed.push({ row: rowNum, serialNumber: trimmedSerial, reason: `Model ID ${modelId} not found` }); continue; }

        const [sCheck] = await mysqlPool.query("SELECT guid FROM serials WHERE value=?", [trimmedSerial]);
        if (sCheck.length > 0) { results.failed.push({ row: rowNum, serialNumber: trimmedSerial, reason: "Serial number already exists" }); continue; }

        const modelMRP = Number(mCheck[0].mrp) || 0;
        let finalReason = null;
        if (landingPrice > modelMRP && modelMRP > 0) {
          if (!landingPriceReason) { results.failed.push({ row: rowNum, serialNumber: trimmedSerial, reason: "Landing Price exceeds MRP. Reason required.", requiresReason: true }); continue; }
          finalReason = landingPriceReason;
        }

        const godownGuid = godownGuidValue ? String(godownGuidValue).trim() : null;
        if (godownGuid) {
          const [gCheck] = await mysqlPool.query("SELECT guid FROM godowns WHERE guid=? AND isDeleted=0", [godownGuid]);
          if (!gCheck.length) { results.failed.push({ row: rowNum, serialNumber: trimmedSerial, reason: `Godown ${godownGuid} not found` }); continue; }
        }

        const serialGuid = randomUUID();
        await mysqlPool.query(
          "INSERT INTO serials (guid,modelGuid,godownGuid,value,landingPrice,status,landingPriceReason,isDeleted,createdAt) VALUES (?,?,?,?,?,?,?,0,NOW())",
          [serialGuid, modelId, godownGuid, trimmedSerial, landingPrice, String(statusValue).trim() || "Available", finalReason]
        );
        results.success.push({ row: rowNum, id: serialGuid, serialNumber: trimmedSerial, modelId, modelName: mCheck[0].name });
      } catch (e) {
        if (e.code === "ER_DUP_ENTRY") {
          results.failed.push({ row: rowNum, serialNumber: row.value || "N/A", reason: "Serial number already exists" });
        } else {
          results.failed.push({ row: rowNum, serialNumber: row.value || "N/A", reason: e.message });
        }
      }
    }

    fs.unlinkSync(req.file.path);
    res.json({ message: `Upload completed. Success: ${results.success.length}, Failed: ${results.failed.length}, Skipped: ${results.skipped.length}`, results });
  } catch (err) {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    console.error("[serials] upload-excel:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

router.get("/", async (req, res) => {
  try {
    const [rows] = await mysqlPool.query(`
      SELECT s.*, s.guid as id, s.modelGuid as modelId,
        COALESCE(m.name, itv.variantName, 'Unknown Item') as modelName,
        COALESCE(m.company, b.brandName, '') as companyName,
        COALESCE(m.category, c.categoryName, '') as modelCategory,
        g.godownName, g.godownAddress, g.godownName as warehouseName,
        g.godownAddress as warehouseAddress, s.godownGuid as warehouseGuid,
        iv.vendorFirmName as vendorName,
        lr.reason as latestReturnReason, lr.returnDate as latestReturnDate, lr.condition as latestReturnCondition
      FROM serials s
      LEFT JOIN models m ON s.modelGuid=m.guid AND m.isDeleted=0
      LEFT JOIN inventoryitemvariant itv ON s.modelGuid=itv.itemVariantId AND itv.isDeleted=0
      LEFT JOIN inventoryitemmaster i ON itv.itemId=i.itemId AND i.isDeleted=0
      LEFT JOIN inventorybrandmaster b ON i.brandId=b.brandId AND b.isDeleted=0
      LEFT JOIN inventorycategorymaster c ON i.categoryId=c.categoryId AND c.isDeleted=0
      LEFT JOIN godowns g ON s.godownGuid=g.guid AND g.isDeleted=0
      LEFT JOIN inventoryvendor iv ON s.vendorId=iv.vendorId AND iv.isDeleted=0
      LEFT JOIN (
        SELECT r1.* FROM returns r1
        INNER JOIN (
          SELECT serialNumberGuid, MAX(returnDate) as maxDate, MAX(guid) as maxId FROM returns WHERE isDeleted=0 GROUP BY serialNumberGuid
        ) r2 ON r1.serialNumberGuid=r2.serialNumberGuid AND r1.returnDate=r2.maxDate AND r1.guid=r2.maxId
      ) lr ON s.guid=lr.serialNumberGuid
      WHERE s.isDeleted=0
      ORDER BY s.createdAt DESC, s.guid DESC
    `);
    // Return plain array — frontend api.js calls res.data.map() directly
    res.json(rows);
  } catch (err) {
    console.error("[serials] GET /:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

router.post("/", async (req, res) => {
  try {
    const { modelId, value, status, landingPrice, landingPriceReason } = req.body;
    const godownGuid = req.body.godownGuid || req.body.warehouseGuid || null;
    const [check] = await mysqlPool.query("SELECT guid FROM serials WHERE value=? AND isDeleted=0", [value]);
    if (check.length > 0) return res.status(400).json({ message: "Serial exists!" });
    await mysqlPool.query(
      "INSERT INTO serials (guid,modelGuid,godownGuid,value,status,landingPrice,landingPriceReason,isDeleted,createdAt) VALUES (UUID(),?,?,?,?,?,?,0,NOW())",
      [modelId, godownGuid, value, status || "Available", landingPrice || 0, landingPriceReason || null]
    );
    await logUserActivity(mysqlPool, req.user, "Add Serial", [{ field: "serialNumber", newValue: value }, { field: "modelId", newValue: modelId }], req.ip);
    res.json({ message: "Serial added" });
  } catch (err) {
    console.error("[serials] POST /:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { modelId, value, status, landingPrice, landingPriceReason } = req.body;
    const godownGuid = req.body.godownGuid || req.body.warehouseGuid || null;
    await mysqlPool.query(
      "UPDATE serials SET modelGuid=?,value=?,status=COALESCE(?,status),landingPrice=?,landingPriceReason=?,godownGuid=? WHERE guid=? AND isDeleted=0",
      [modelId, value, status || null, landingPrice || 0, landingPriceReason || null, godownGuid, id]
    );
    await logUserActivity(mysqlPool, req.user, "Update Serial", [{ field: "serialNumber", newValue: value }], req.ip);
    res.json({ message: "Serial updated" });
  } catch (err) {
    console.error("[serials] PUT /:id:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await mysqlPool.query("UPDATE serials SET isDeleted=1 WHERE guid=?", [id]);
    await logUserActivity(mysqlPool, req.user, "Delete Serial", [{ field: "id", oldValue: id, newValue: "Deleted" }], req.ip);
    res.json({ message: "Serial deleted (soft)" });
  } catch (err) {
    console.error("[serials] DELETE /:id:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

router.post("/bulk", async (req, res) => {
  try {
    const { serials } = req.body;
    const results = { success: [], failed: [] };

    // Batch-check existing serials to avoid N+1
    const values = serials.map((s) => s.value?.trim()).filter(Boolean);
    const [existing] = values.length
      ? await mysqlPool.query("SELECT value FROM serials WHERE value IN (?) AND isDeleted=0", [values])
      : [[]];
    const existingSet = new Set(existing.map((r) => r.value));

    for (const serial of serials) {
      const trimmed = serial.value?.trim();
      if (!trimmed) { results.failed.push({ value: serial.value, reason: "Empty serial value" }); continue; }
      if (existingSet.has(trimmed)) { results.failed.push({ value: trimmed, reason: "Already exists" }); continue; }
      try {
        const [mCheck] = await mysqlPool.query("SELECT mrp FROM models WHERE guid=? AND isDeleted=0", [serial.modelId]);
        let reasonValue = null;
        if (mCheck.length > 0) {
          const mrp = Number(mCheck[0].mrp) || 0;
          const lp = Number(serial.landingPrice) || 0;
          if (lp > mrp && mrp > 0) {
            if (!serial.landingPriceReason?.trim()) { results.failed.push({ value: trimmed, reason: `Landing Price (₹${lp}) exceeds MRP (₹${mrp}). Reason required.`, requiresReason: true }); continue; }
            reasonValue = serial.landingPriceReason.trim();
          }
        }
        const serialGuid = randomUUID();
        await mysqlPool.query(
          "INSERT INTO serials (guid,modelGuid,godownGuid,value,landingPrice,landingPriceReason,status,isDeleted,createdAt) VALUES (?,?,?,?,?,?,'Available',0,NOW())",
          [serialGuid, serial.modelId, serial.godownGuid || serial.warehouseGuid || null, trimmed, serial.landingPrice || 0, reasonValue]
        );
        existingSet.add(trimmed);
        results.success.push({ id: serialGuid, value: trimmed });
      } catch (e) {
        if (e.code === "ER_DUP_ENTRY") {
          results.failed.push({ value: trimmed, reason: "Already exists" });
        } else {
          results.failed.push({ value: trimmed, reason: e.message });
        }
      }
    }
    res.json({ message: "Bulk add completed", results });
  } catch (err) {
    console.error("[serials] bulk:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

router.post("/bulk-delete", async (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [req.body.ids];
    if (ids.length > 0) await mysqlPool.query("UPDATE serials SET isDeleted=1 WHERE guid IN (?)", [ids]);
    res.json({ message: "Bulk deleted (soft)" });
  } catch (err) {
    console.error("[serials] bulk-delete:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

router.get("/:id/history", async (req, res) => {
  try {
    const serialId = req.params.id;
    const [serials] = await mysqlPool.query(`
      SELECT s.guid, s.value as serialValue, s.status as currentStatus, s.returnCount, s.createdAt,
             m.guid as modelId, m.name as modelName, m.company as companyName
      FROM serials s LEFT JOIN models m ON m.guid=s.modelGuid
      WHERE s.guid=? AND s.isDeleted=0
    `, [serialId]);
    if (!serials.length) return res.status(404).json({ message: "Serial not found" });

    const [history] = await mysqlPool.query(`
      SELECT sm.*, o.dispatchDate, o.status as orderStatus, ol.logisticsStatus, ins.installationStatus, ins.installationRequired,
             COALESCE(o.platform, sm.firmName) as linkedFirmName, COALESCE(o.customerName, o.orderid, sm.customerName) as linkedCustomerName,
             COALESCE(o.shippingAddress, o.address) as linkedShippingAddress, COALESCE(o.invoiceNumber, sm.invoiceNumber) as linkedInvoiceNumber
      FROM serialmovements sm
      LEFT JOIN order_items oi ON oi.guid=sm.dispatchId
      LEFT JOIN orders o ON oi.orderGuid=o.guid
      LEFT JOIN order_logistics ol ON o.guid=ol.orderGuid
      LEFT JOIN order_installations ins ON o.guid=ins.orderGuid
      WHERE sm.serialNumberId=?
      ORDER BY sm.createdAt DESC, sm.guid DESC
    `, [serialId]);

    res.json({ serial: serials[0], history });
  } catch (err) {
    console.error("[serials] /:id/history:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

module.exports = router;
