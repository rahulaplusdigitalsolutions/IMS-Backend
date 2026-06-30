const router = require("express").Router();
const { mysqlPool } = require("../db");
const { createNotification } = require("../notificationService");

// GET — list approval requests (Admin only, optional ?status=pending|approved|rejected)
router.get("/", async (req, res) => {
  try {
    const { status } = req.query;
    let sql = "SELECT r.*, g.godownName FROM model_approval_requests r LEFT JOIN godowns g ON r.godownGuid COLLATE utf8mb4_unicode_ci = g.guid COLLATE utf8mb4_unicode_ci WHERE r.isDeleted=0";
    const params = [];
    if (status) { sql += " AND r.status=?"; params.push(status); }
    sql += " ORDER BY r.createdAt DESC";
    const [rows] = await mysqlPool.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error("[modelApprovals] GET /:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

// POST — submit a new model approval request
router.post("/", async (req, res) => {
  try {
    const { name, company, category, colorType, printerType, description, mrp, mainCategory, cpu, ram, ssd, serialNumber, landingPrice, landingPriceReason, godownGuid, screenSize, resolution, panelType, refreshRate } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ message: "Model name is required." });

    // Check if model already exists
    const [existing] = await mysqlPool.query(
      "SELECT guid FROM models WHERE LOWER(TRIM(name))=LOWER(TRIM(?)) AND isDeleted=0", [name]
    );
    if (existing.length > 0) {
      // Model exists — if serial provided, add it directly without going through approval
      if (serialNumber && serialNumber.trim()) {
        const sn = serialNumber.trim();
        const [sCheck] = await mysqlPool.query("SELECT guid FROM serials WHERE value=? AND isDeleted=0", [sn]);
        if (sCheck.length > 0) return res.status(400).json({ message: `Serial number "${sn}" already exists in the system!` });
        await mysqlPool.query(
          "INSERT INTO serials (guid, modelGuid, godownGuid, value, landingPrice, landingPriceReason, status, isDeleted, createdAt) VALUES (UUID(), ?, ?, ?, ?, ?, 'Available', 0, NOW())",
          [existing[0].guid, godownGuid || null, sn, landingPrice || 0, landingPriceReason || null]
        );
        return res.json({ message: `Model already exists. Serial "${sn}" added directly to stock.`, directlyAdded: true, modelGuid: existing[0].guid });
      }
      return res.status(400).json({ message: "This model already exists in the system." });
    }

    // Check for duplicate pending request
    const [dup] = await mysqlPool.query(
      "SELECT guid FROM model_approval_requests WHERE LOWER(TRIM(name))=LOWER(TRIM(?)) AND status='pending' AND isDeleted=0", [name]
    );
    if (dup.length > 0) return res.status(400).json({ message: "An approval request for this model is already pending." });

    // Check if serial number already exists in serials or pending requests
    if (serialNumber && serialNumber.trim()) {
      const trimmedSerial = serialNumber.trim();
      const [sCheck] = await mysqlPool.query("SELECT guid FROM serials WHERE value=? AND isDeleted=0", [trimmedSerial]);
      if (sCheck.length > 0) return res.status(400).json({ message: `Serial number "${trimmedSerial}" already exists in the system!` });

      const [sPendingCheck] = await mysqlPool.query("SELECT guid FROM model_approval_requests WHERE serialNumber=? AND status='pending' AND isDeleted=0", [trimmedSerial]);
      if (sPendingCheck.length > 0) return res.status(400).json({ message: `Serial number "${trimmedSerial}" is already pending approval for another model!` });
    }

    const { randomUUID } = require("crypto");
    const guid = randomUUID();
    await mysqlPool.query(
      `INSERT INTO model_approval_requests
        (guid, name, company, category, colorType, printerType, description, mrp, mainCategory, cpu, ram, ssdHdd, requestedBy, requestedByGuid, status, serialNumber, landingPrice, landingPriceReason, godownGuid, screenSize, resolution, panelType, refreshRate)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?,?,?,?,?,?)`,
      [
        guid, name.trim(), company || null, category || null,
        colorType || "Monochrome", printerType || "Multi-Function",
        description || null, mrp || 0, mainCategory || "Printer",
        cpu || null, ram || null, ssd || null,
        req.user?.username || "Unknown",
        req.user?.userid ? String(req.user.userid) : null,
        serialNumber?.trim() || null,
        landingPrice !== undefined && landingPrice !== null && landingPrice !== "" ? Number(landingPrice) : 0,
        landingPriceReason || null,
        godownGuid || null,
        screenSize || null, resolution || null, panelType || null, refreshRate || null
      ]
    );

    // Notify all Admins
    await createNotification(mysqlPool, {
      targetRole: "Admin",
      title: "New Model Approval Request",
      message: `${req.user?.username || "A user"} requested to add model "${name.trim()}". Please review and approve in the Models tab.`,
      type: "info",
      priority: "low",
      link: "/models?tab=approvals"
    });

    res.json({ message: "Approval request submitted. Admins have been notified.", guid });
  } catch (err) {
    console.error("[modelApprovals] POST /:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

// GET /:guid/serials — Fetch Available serials for the variant linked to this approval request
router.get("/:guid/serials", async (req, res) => {
  try {
    const { guid } = req.params;
    const [rows] = await mysqlPool.query(
      "SELECT variantId FROM model_approval_requests WHERE guid=? AND isDeleted=0", [guid]
    );
    if (!rows.length) return res.status(404).json({ message: "Request not found." });

    const variantId = rows[0].variantId;
    if (!variantId) {
      // No linked variant — return empty
      return res.json([]);
    }

    // Fetch serials from the serials table where modelGuid = variantId AND status = Available
    const [serials] = await mysqlPool.query(
      `SELECT s.guid, s.value, s.landingPrice, s.landingPriceReason, s.status, s.createdAt,
              g.godownName
       FROM serials s
       LEFT JOIN godowns g ON s.godownGuid = g.guid
       WHERE s.modelGuid = ? AND s.status = 'Available' AND s.isDeleted = 0`,
      [variantId]
    );

    res.json(serials);
  } catch (err) {
    console.error("[modelApprovals] GET /:guid/serials:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

// PUT /:guid/approve — Admin approves → creates the model with full details
router.put("/:guid/approve", async (req, res) => {
  try {
    const { guid } = req.params;
    const [rows] = await mysqlPool.query(
      "SELECT * FROM model_approval_requests WHERE guid=? AND isDeleted=0", [guid]
    );
    if (!rows.length) return res.status(404).json({ message: "Request not found." });
    const r = rows[0];
    if (r.status !== "pending") return res.status(400).json({ message: "This request is not pending." });

    // Check model doesn't already exist (race condition guard)
    const [existing] = await mysqlPool.query(
      "SELECT guid FROM models WHERE LOWER(TRIM(name))=LOWER(TRIM(?)) AND isDeleted=0", [r.name]
    );
    if (existing.length > 0) return res.status(400).json({ message: "A model with this name already exists." });

    // Merge request defaults with admin-provided overrides from body
    const body = req.body || {};
    const finalName      = (body.name      && body.name.trim())      || r.name;
    const finalCompany   = body.company    !== undefined ? body.company   : (r.company   || null);
    const finalCategory  = body.category   !== undefined ? body.category  : (r.category  || null);
    const finalColorType = body.colorType  !== undefined ? body.colorType : (r.colorType || "Monochrome");
    const finalPrinterType = body.printerType !== undefined ? body.printerType : (r.printerType || "Multi-Function");
    const finalDesc      = body.description !== undefined ? body.description : (r.description || null);
    const finalMrp       = body.mrp        !== undefined ? Number(body.mrp)       : (Number(r.mrp) || 0);
    const finalMainCat   = body.mainCategory !== undefined ? body.mainCategory : (r.mainCategory || "Printer");
    const finalCpu       = body.cpu        !== undefined ? body.cpu        : (r.cpu   || null);
    const finalRam       = body.ram        !== undefined ? body.ram        : (r.ram   || null);
    const finalSsd       = body.ssd        !== undefined ? body.ssd        : (r.ssdHdd || null);
    const finalBarcode      = body.barcode     !== undefined ? body.barcode     : null;
    const finalScreenSize   = body.screenSize  !== undefined ? body.screenSize  : (r.screenSize  || null);
    const finalResolution   = body.resolution  !== undefined ? body.resolution  : (r.resolution  || null);
    const finalPanelType    = body.panelType   !== undefined ? body.panelType   : (r.panelType   || null);
    const finalRefreshRate  = body.refreshRate !== undefined ? body.refreshRate : (r.refreshRate || null);

    const { v4: uuidv4 } = require("uuid");
    const newModelGuid = uuidv4();

    // Insert model — same columns as routes/models.js POST
    await mysqlPool.query(
      "INSERT INTO models (guid,name,company,category,colorType,printerType,description,mrp,isSerialized,stockQuantity,packagingCost,mainCategory,cpu,ram,`ssd/hdd`,barcode,screenSize,resolution,panelType,refreshRate,isDeleted) VALUES (?,?,?,?,?,?,?,?,1,0,0,?,?,?,?,?,?,?,?,?,0)",
      [
        newModelGuid,
        finalName, finalCompany, finalCategory,
        finalColorType, finalPrinterType,
        finalDesc, finalMrp,
        finalMainCat,
        finalCpu || null, finalRam || null, finalSsd || null,
        finalBarcode || null,
        finalScreenSize, finalResolution, finalPanelType, finalRefreshRate
      ]
    );

    // If there is a serial number in the request, insert into serials table
    if (r.serialNumber && r.serialNumber.trim()) {
      await mysqlPool.query(
        "INSERT INTO serials (guid, modelGuid, godownGuid, value, landingPrice, landingPriceReason, status, isDeleted, createdAt) VALUES (UUID(), ?, ?, ?, ?, ?, 'Available', 0, NOW())",
        [
          newModelGuid,
          r.godownGuid || null,
          r.serialNumber.trim(),
          r.landingPrice || 0,
          r.landingPriceReason || null
        ]
      );
    }

    // Re-link existing Available serials that were stocked in under this variant
    // (In FinalizeStockIn, serials are inserted with modelGuid = itemVariantId)
    if (r.variantId) {
      await mysqlPool.query(
        "UPDATE serials SET modelGuid = ? WHERE modelGuid = ? AND status = 'Available' AND isDeleted = 0",
        [newModelGuid, r.variantId]
      );
    }

    const approver = req.user?.username || "Admin";
    await mysqlPool.query(
      "UPDATE model_approval_requests SET status='approved', approvedBy=?, approvedAt=NOW(), linkedModelGuid=? WHERE guid=?",
      [approver, newModelGuid, guid]
    );

    // Notify the requester
    if (r.requestedByGuid) {
      await createNotification(mysqlPool, {
        targetUserGuid: r.requestedByGuid,
        title: "Model Request Approved ✓",
        message: `Your request to add model "${finalName}" was approved! It is now available in the Models tab.`,
        type: "success",
        priority: "low",
        link: "/models"
      });
    }

    res.json({ message: `Model "${finalName}" approved and added to the system.` });
  } catch (err) {
    console.error("[modelApprovals] PUT /:guid/approve:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

// PUT /:guid/reject — Admin rejects with reason
router.put("/:guid/reject", async (req, res) => {
  try {
    const { guid } = req.params;
    const { reason } = req.body;
    const [rows] = await mysqlPool.query(
      "SELECT * FROM model_approval_requests WHERE guid=? AND isDeleted=0", [guid]
    );
    if (!rows.length) return res.status(404).json({ message: "Request not found." });
    const r = rows[0];
    if (r.status !== "pending") return res.status(400).json({ message: "This request is not pending." });

    const approver = req.user?.username || "Admin";
    await mysqlPool.query(
      "UPDATE model_approval_requests SET status='rejected', approvedBy=?, approvedAt=NOW(), rejectionReason=? WHERE guid=?",
      [approver, reason || "No reason provided", guid]
    );

    if (r.requestedByGuid) {
      await createNotification(mysqlPool, {
        targetUserGuid: r.requestedByGuid,
        title: "Model Request Rejected",
        message: `Your request to add model "${r.name}" was rejected. Reason: ${reason || "No reason provided"}.`,
        type: "warning",
        priority: "low",
        link: "/models"
      });
    }

    res.json({ message: `Request for "${r.name}" rejected.` });
  } catch (err) {
    console.error("[modelApprovals] PUT /:guid/reject:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

module.exports = router;
