const bcrypt = require("bcryptjs");
const { mysqlPool } = require("../db");

async function runMigrations() {
  try {
    // ── users: permissions & per-module edit flags ──────────────────────────
    const [permRows] = await mysqlPool.query(
      "SELECT COUNT(*) as c FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='users' AND COLUMN_NAME='permissions'"
    );
    if (permRows[0].c === 0) {
      await mysqlPool.query("ALTER TABLE users ADD COLUMN permissions LONGTEXT NULL");
      console.log("Migration: added users.permissions");
    }

    const boolCols = [
      "allow_edit_models", "allow_edit_serials", "allow_edit_godown",
      "allow_create_order", "allow_edit_order_processing",
      "allow_edit_billing", "allow_edit_dispatch",
      "allow_edit_installations", "allow_edit_damaged", "allow_edit_returns",
      "allow_edit_fbf_fba", "allow_edit_warranty",
    ];
    for (const col of boolCols) {
      const [r] = await mysqlPool.query(
        "SELECT COUNT(*) as c FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='users' AND COLUMN_NAME=?",
        [col]
      );
      if (r[0].c === 0) {
        await mysqlPool.query(`ALTER TABLE users ADD COLUMN ${col} TINYINT(1) DEFAULT 0`);
        console.log(`Migration: added users.${col}`);
      }
    }

    // ── users: tokenExpiresAt ───────────────────────────────────────────────
    const [teCols] = await mysqlPool.query(
      "SELECT COUNT(*) as c FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='users' AND COLUMN_NAME='tokenExpiresAt'"
    );
    if (teCols[0].c === 0) {
      await mysqlPool.query("ALTER TABLE users ADD COLUMN tokenExpiresAt DATETIME NULL");
      console.log("Migration: added users.tokenExpiresAt");
    }

    // ── users: forceLogoutAt ────────────────────────────────────────────────
    const [flCols] = await mysqlPool.query(
      "SELECT COUNT(*) as c FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='users' AND COLUMN_NAME='forceLogoutAt'"
    );
    if (flCols[0].c === 0) {
      await mysqlPool.query("ALTER TABLE users ADD COLUMN forceLogoutAt DATETIME NULL");
      console.log("Migration: added users.forceLogoutAt");
    }

    // ── users: SuperAdmin role ───────────────────────────────────────────────
    const [roleCol] = await mysqlPool.query(
      "SELECT COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users' AND COLUMN_NAME='role'"
    );
    if (roleCol.length > 0 && !roleCol[0].COLUMN_TYPE.includes('SuperAdmin')) {
      await mysqlPool.query(
        "ALTER TABLE users MODIFY COLUMN role ENUM('Admin','Supervisor','Accountant','User','Operator','SuperAdmin') NOT NULL DEFAULT 'User'"
      );
      console.log("Migration: added SuperAdmin to users.role ENUM");
    }

    // ── orders: invoiceDate ──────────────────────────────────────────────────
    try {
      await mysqlPool.query("ALTER TABLE orders ADD COLUMN invoiceDate DATE NULL");
      console.log("Migration: added orders.invoiceDate");
    } catch (e) { if (e.code !== "ER_DUP_FIELDNAME") console.error("Migration orders.invoiceDate:", e.message); }

    // ── payments: paymentType & settlementDeduction ──────────────────────────
    try {
      await mysqlPool.query("ALTER TABLE payments ADD COLUMN paymentType VARCHAR(50) DEFAULT 'Full'");
      await mysqlPool.query("ALTER TABLE payments ADD COLUMN settlementDeduction DECIMAL(18,2) DEFAULT 0");
      console.log("Migration: added payments.paymentType & settlementDeduction");
    } catch (e) { if (e.code !== "ER_DUP_FIELDNAME") console.error("Migration payments:", e.message); }

    // ── WARRANTY dropdown ────────────────────────────────────────────────────
    const [masters] = await mysqlPool.query("SELECT id FROM dropdown_master WHERE dropdown_code='WARRANTY'");
    let masterId;
    if (masters.length === 0) {
      const [ins] = await mysqlPool.query(
        "INSERT INTO dropdown_master (dropdown_code, dropdown_name, description, is_active) VALUES ('WARRANTY','Warranty Period','Warranty duration options',1)"
      );
      masterId = ins.insertId;
      console.log("Migration: created WARRANTY dropdown master");
    } else {
      masterId = masters[0].id;
    }
    for (let i = 0; i < 3; i++) {
      const { label, value } = [{ label: "1 Year", value: "1 Year" }, { label: "3 Year", value: "3 Year" }, { label: "5 Year", value: "5 Year" }][i];
      const [ex] = await mysqlPool.query("SELECT id FROM dropdown_option WHERE dropdown_id=? AND option_value=?", [masterId, value]);
      if (ex.length === 0) {
        await mysqlPool.query(
          "INSERT INTO dropdown_option (dropdown_id, option_label, option_value, display_order, is_active) VALUES (?,?,?,?,1)",
          [masterId, label, value, i + 1]
        );
        console.log(`Migration: added WARRANTY option '${label}'`);
      }
    }

    // ── godowns & stocktransferhistory tables ────────────────────────────────
    await mysqlPool.query(`
      CREATE TABLE IF NOT EXISTS godowns (
        guid VARCHAR(36) PRIMARY KEY,
        godownName VARCHAR(255) NOT NULL,
        godownAddress TEXT,
        isDefault TINYINT(1) DEFAULT 0,
        isDeleted TINYINT(1) DEFAULT 0,
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    await mysqlPool.query(`
      CREATE TABLE IF NOT EXISTS stocktransferhistory (
        id INT AUTO_INCREMENT PRIMARY KEY,
        transferId VARCHAR(36) NOT NULL,
        modelName VARCHAR(255),
        serialNumber VARCHAR(255),
        fromGodown VARCHAR(255),
        toGodown VARCHAR(255),
        transferredBy VARCHAR(255),
        transferDate TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // ── serials: godownGuid ──────────────────────────────────────────────────
    const [cols] = await mysqlPool.query("SHOW COLUMNS FROM serials");
    if (!cols.some((c) => c.Field === "godownGuid")) {
      await mysqlPool.query("ALTER TABLE serials ADD COLUMN godownGuid VARCHAR(36) NULL AFTER modelGuid");
      console.log("Migration: added serials.godownGuid");
    }

    // ── orders: gstin & invoiceUploader ──────────────────────────────────────
    const [oCols] = await mysqlPool.query("SHOW COLUMNS FROM orders");
    const oColNames = oCols.map((c) => c.Field);
    if (!oColNames.includes("gstin")) {
      await mysqlPool.query("ALTER TABLE orders ADD COLUMN gstin VARCHAR(50) NULL");
      console.log("Migration: added orders.gstin");
    }
    if (!oColNames.includes("invoiceUploader")) {
      await mysqlPool.query("ALTER TABLE orders ADD COLUMN invoiceUploader VARCHAR(255) NULL");
      console.log("Migration: added orders.invoiceUploader");
    }
    // ── default Main Godown ──────────────────────────────────────────────────
    const [gcount] = await mysqlPool.query("SELECT COUNT(*) as total FROM godowns WHERE isDeleted=0");
    if (Number(gcount[0].total) === 0) {
      await mysqlPool.query("INSERT INTO godowns (guid, godownName, godownAddress, isDefault) VALUES (UUID(),'Main Godown','',1)");
      console.log("Migration: created default Main Godown");
    }

    // ── serials: vendorId + stockInId for vendor traceability ───────────────
    const [sCols] = await mysqlPool.query("SHOW COLUMNS FROM serials");
    const sColNames = sCols.map((c) => c.Field);
    if (!sColNames.includes("vendorId")) {
      await mysqlPool.query("ALTER TABLE serials ADD COLUMN vendorId VARCHAR(36) NULL");
      console.log("Migration: added serials.vendorId");
    }
    if (!sColNames.includes("stockInId")) {
      await mysqlPool.query("ALTER TABLE serials ADD COLUMN stockInId VARCHAR(36) NULL");
      console.log("Migration: added serials.stockInId");
    }

    // ── model_approval_requests table ────────────────────────────────────────
    await mysqlPool.query(`
      CREATE TABLE IF NOT EXISTS model_approval_requests (
        guid         VARCHAR(36) NOT NULL,
        name         VARCHAR(255) NOT NULL,
        company      VARCHAR(255),
        category     VARCHAR(255),
        colorType    VARCHAR(100) DEFAULT 'Monochrome',
        printerType  VARCHAR(100) DEFAULT 'Multi-Function',
        description  TEXT,
        mrp          DECIMAL(10,2) DEFAULT 0,
        mainCategory VARCHAR(100) DEFAULT 'Printer',
        cpu          VARCHAR(255),
        ram          VARCHAR(255),
        ssdHdd       VARCHAR(255),
        requestedBy      VARCHAR(255),
        requestedByGuid  VARCHAR(36),
        status       ENUM('pending','approved','rejected') DEFAULT 'pending',
        rejectionReason  TEXT,
        approvedBy   VARCHAR(255),
        approvedAt   TIMESTAMP NULL,
        createdAt    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        isDeleted    TINYINT DEFAULT 0,
        PRIMARY KEY (guid)
      )
    `);
    console.log("Migration: ensured model_approval_requests table");

    // ── model_approval_requests: serial number and price fields for new model serial mapping ─────
    const [marCols] = await mysqlPool.query("SHOW COLUMNS FROM model_approval_requests");
    const marColNames = marCols.map((c) => c.Field);
    if (!marColNames.includes("serialNumber")) {
      await mysqlPool.query("ALTER TABLE model_approval_requests ADD COLUMN serialNumber VARCHAR(100) NULL");
      console.log("Migration: added model_approval_requests.serialNumber");
    }
    if (!marColNames.includes("landingPrice")) {
      await mysqlPool.query("ALTER TABLE model_approval_requests ADD COLUMN landingPrice INT DEFAULT 0");
      console.log("Migration: added model_approval_requests.landingPrice");
    }
    if (!marColNames.includes("landingPriceReason")) {
      await mysqlPool.query("ALTER TABLE model_approval_requests ADD COLUMN landingPriceReason LONGTEXT NULL");
      console.log("Migration: added model_approval_requests.landingPriceReason");
    }
    if (!marColNames.includes("godownGuid")) {
      await mysqlPool.query("ALTER TABLE model_approval_requests ADD COLUMN godownGuid VARCHAR(36) NULL");
      console.log("Migration: added model_approval_requests.godownGuid");
    }
    if (!marColNames.includes("variantId")) {
      await mysqlPool.query("ALTER TABLE model_approval_requests ADD COLUMN variantId VARCHAR(36) NULL");
      console.log("Migration: added model_approval_requests.variantId");
    }

    // ── models: barcode field for StockIn barcode scan ───────────────────────
    const [mCols] = await mysqlPool.query("SHOW COLUMNS FROM models");
    const mColNames = mCols.map(c => c.Field);
    if (!mColNames.includes("barcode")) {
      await mysqlPool.query("ALTER TABLE models ADD COLUMN barcode VARCHAR(255) NULL");
      console.log("Migration: added models.barcode");
    }

    // ── models: Monitor & PC screen fields ───────────────────────────────────
    const monitorModelCols = ["screenSize", "resolution", "panelType", "refreshRate"];
    for (const col of monitorModelCols) {
      if (!mColNames.includes(col)) {
        await mysqlPool.query(`ALTER TABLE models ADD COLUMN ${col} VARCHAR(100) NULL`);
        console.log(`Migration: added models.${col}`);
      }
    }

    // ── model_approval_requests: Monitor & PC screen fields ──────────────────
    const [marCols2] = await mysqlPool.query("SHOW COLUMNS FROM model_approval_requests");
    const marColNames2 = marCols2.map(c => c.Field);
    const monitorApprovalCols = ["screenSize", "resolution", "panelType", "refreshRate", "linkedModelGuid"];
    for (const col of monitorApprovalCols) {
      if (!marColNames2.includes(col)) {
        await mysqlPool.query(`ALTER TABLE model_approval_requests ADD COLUMN ${col} VARCHAR(100) NULL`);
        console.log(`Migration: added model_approval_requests.${col}`);
      }
    }
    // Backfill linkedModelGuid for old approved requests that don't have it yet
    await mysqlPool.query(`
      UPDATE model_approval_requests mar
      JOIN models m ON LOWER(TRIM(m.name)) = LOWER(TRIM(mar.name)) AND m.isDeleted = 0
      SET mar.linkedModelGuid = m.guid
      WHERE mar.status = 'approved' AND (mar.linkedModelGuid IS NULL OR mar.linkedModelGuid = '') AND mar.isDeleted = 0
    `);
    // Backfill serials: re-link serials that still point to itemVariantId to the approved model guid
    await mysqlPool.query(`
      UPDATE serials s
      JOIN model_approval_requests mar ON mar.variantId = s.modelGuid AND mar.linkedModelGuid IS NOT NULL AND mar.status = 'approved' AND mar.isDeleted = 0
      SET s.modelGuid = mar.linkedModelGuid
      WHERE s.isDeleted = 0
    `);

    // ── warranty_template (single-row master) ───────────────────────────────
    await mysqlPool.query(`
      CREATE TABLE IF NOT EXISTS warranty_template (
        id              INT PRIMARY KEY DEFAULT 1,
        companyName     VARCHAR(255),
        companyAddress  TEXT,
        companyPhone    VARCHAR(100),
        companyEmail    VARCHAR(255),
        companyGstin    VARCHAR(50),
        headerImagePath VARCHAR(500),
        htmlBody        LONGTEXT,
        termsHtml       LONGTEXT,
        updatedAt       TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    // Ensure headerHtml, docxRawText, docxFileName columns exist
    const [wtCols] = await mysqlPool.query("SHOW COLUMNS FROM warranty_template");
    if (!wtCols.some((c) => c.Field === "headerHtml")) {
      await mysqlPool.query("ALTER TABLE warranty_template ADD COLUMN headerHtml LONGTEXT NULL");
      console.log("Migration: added warranty_template.headerHtml");
    }
    if (!wtCols.some((c) => c.Field === "docxRawText")) {
      await mysqlPool.query("ALTER TABLE warranty_template ADD COLUMN docxRawText MEDIUMTEXT NULL");
      console.log("Migration: added warranty_template.docxRawText");
    }
    if (!wtCols.some((c) => c.Field === "docxFileName")) {
      await mysqlPool.query("ALTER TABLE warranty_template ADD COLUMN docxFileName VARCHAR(255) NULL");
      console.log("Migration: added warranty_template.docxFileName");
    }
    if (!wtCols.some((c) => c.Field === "docxBinary")) {
      await mysqlPool.query("ALTER TABLE warranty_template ADD COLUMN docxBinary LONGBLOB NULL");
      console.log("Migration: added warranty_template.docxBinary");
    }

    // Load default headerHtml from header_preview.html if available
    const fs = require("fs");
    const path = require("path");
    let defaultHeaderHtml = "";
    try {
      const previewPath = path.resolve(__dirname, "../header_preview.html");
      if (fs.existsSync(previewPath)) {
        const content = fs.readFileSync(previewPath, "utf8");
        const startIdx = content.indexOf('<div style="position:relative;');
        const endIdx = content.lastIndexOf('</div></div></body></html>');
        if (startIdx !== -1 && endIdx !== -1) {
          defaultHeaderHtml = content.substring(startIdx, endIdx + 6);
        } else {
          defaultHeaderHtml = content;
        }
      }
    } catch (err) {
      console.error("Migration: failed to load default header HTML:", err.message);
    }

    const defaultHtmlBody = `<div class="warranty-certificate" style="font-family:Arial,sans-serif;max-width:800px;margin:0 auto;color:#000;font-size:13px;line-height:1.8;">

  <!-- Header Image (company letterhead) — full-width, no extra padding -->
  <div style="margin-bottom:0;">
    {{HEADER_IMAGE}}
  </div>

  <!-- Letter content with margins -->
  <div style="padding:28px 50px 40px 50px;">

  <p><strong>Reference No.:</strong> {{BID_NUMBER}}</p>
  <p><strong>Date:</strong> {{DISPATCH_DATE}}</p>

  <br>

  <p>
    To<br>
    <strong>{{CONSIGNEE_NAME}}</strong><br>
    {{ADDRESS}}
  </p>

  <h2 style="text-align:center;text-decoration:underline;font-size:15px;font-weight:bold;margin:24px 0;letter-spacing:1px;">
    WARRANTY CERTIFICATE
  </h2>

  <p>
    <strong>Subject:</strong> Warranty Certificate &ndash; Contract No. {{BID_NUMBER}}
  </p>

  <p>Respected Sir/Madam,</p>

  <p>
    This is to certify that the equipment supplied under the above-mentioned
    contract is covered under warranty by the OEM as per the details below:
  </p>

  <p><strong>Product Details:</strong></p>

  <p>
    <strong>Product Name :</strong> {{MODEL_NAME}} with {{WARRANTY_PERIOD}} Warranty ({{QUANTITY}} Units)
  </p>

  <p>
    <strong>Serial Numbers :</strong> {{SERIAL_NUMBERS}}
  </p>

  <p><strong>Warranty Terms &amp; Conditions:</strong></p>

  <ol>
    <li>
      The product is warranted against manufacturing defects for a period
      of {{WARRANTY_PERIOD}} from the date of supply {{DISPATCH_DATE}}.
    </li>
    <li>
      During the warranty period, any defective part will be repaired or
      replaced free of cost.
    </li>
    <li>
      The warranty does not cover damages resulting from mishandling,
      improper installation by unauthorized personnel, or external
      electrical fluctuations beyond specified limits.
    </li>
    <li>
      Post-warranty service support and spare parts will be available
      through the authorized service center on a chargeable basis.
    </li>
  </ol>

  <p>
    This certificate is issued in compliance with the contract terms and
    conditions and remains valid for the specified warranty period from the
    date of supply. ({{DISPATCH_DATE}})
  </p>

  <br>

  <p>
    Thanks &amp; Regards,<br>
    <strong>For {{COMPANY_NAME}}</strong>
  </p>

  <br><br><br>

  <p>(Authorized Signatory)</p>

  </div><!-- end letter content -->
</div>`;

    const [wtRows] = await mysqlPool.query("SELECT id FROM warranty_template WHERE id=1");
    if (wtRows.length === 0) {
      await mysqlPool.query(`
        INSERT INTO warranty_template (id, companyName, companyAddress, companyPhone, companyEmail, companyGstin, headerImagePath, htmlBody, termsHtml, headerHtml)
        VALUES (1, 'Your Company Address', '', '', '', NULL, ?,
          '<p>1. This warranty is valid for the period specified above.<br>2. Warranty is void if product is damaged due to misuse.<br>3. Carry proof of purchase for warranty claims.</p>',
          ?
        )
      `, [defaultHtmlBody, defaultHeaderHtml]);
      console.log("Migration: inserted default warranty_template row");
    } else {
      // If row exists, update fields if they are at old defaults
      const [fullRows] = await mysqlPool.query("SELECT companyName, htmlBody, headerHtml FROM warranty_template WHERE id=1");
      if (fullRows.length > 0) {
        const r = fullRows[0];
        let needsUpdate = false;
        let updateQuery = "UPDATE warranty_template SET ";
        const updateParams = [];

        if (r.companyName === "Your Company Name") {
          updateQuery += "companyName = ?, ";
          updateParams.push("A+ Digital Solutions");
          needsUpdate = true;
        }
        if (!r.headerHtml || r.headerHtml.trim() === "" || r.headerHtml.includes("iVBORw0KGgoAAAASUUEX") || r.headerHtml.includes("iVBORw0KGgoAAAANSUhEUgAAADQAAAA0CAYAAADFeBvrAAAJZ0l")) {
          updateQuery += "headerHtml = ?, ";
          updateParams.push(defaultHeaderHtml);
          needsUpdate = true;
        }
        if (!r.htmlBody || !r.htmlBody.includes("{{HEADER_IMAGE}}")) {
          updateQuery += "htmlBody = ?, ";
          updateParams.push(defaultHtmlBody);
          needsUpdate = true;
        }

        if (needsUpdate) {
          updateQuery = updateQuery.slice(0, -2);
          updateQuery += " WHERE id=1";
          await mysqlPool.query(updateQuery, updateParams);
          console.log("Migration: updated existing warranty_template row with default headerHtml/htmlBody");
        }
      }
    }



    // ── Normalize all domain table collations to utf8mb4_unicode_ci ─────────
    // Prevents "Illegal mix of collations" errors when tables created under
    // different MySQL versions have mismatched default collations.
    const domainTables = [
      "orders", "order_items", "order_logistics", "order_installations",
      "serials", "models", "serialmovements", "returns", "payments",
      "bulkorders", "bulkorderitems", "bulkorderdispatches", "bulkorderinvoices",
      "bulkorderpayments", "replacementhistory", "orderdocuments",
      "godowns", "stocktransferhistory", "model_approval_requests",
    ];
    for (const tbl of domainTables) {
      try {
        const [[{ Collation }]] = await mysqlPool.query(
          "SELECT CCSA.collation_name AS Collation FROM information_schema.TABLES T " +
          "JOIN information_schema.COLLATION_CHARACTER_SET_APPLICABILITY CCSA " +
          "ON CCSA.collation_name = T.TABLE_COLLATION " +
          "WHERE T.TABLE_SCHEMA = DATABASE() AND T.TABLE_NAME = ?",
          [tbl]
        );
        if (Collation && Collation !== "utf8mb4_unicode_ci") {
          await mysqlPool.query(
            `ALTER TABLE \`${tbl}\` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
          );
          console.log(`Migration: converted ${tbl} collation → utf8mb4_unicode_ci`);
        }
      } catch (e) {
        // Table may not exist yet — skip silently
      }
    }

    // ── Recreate stored procedures with explicit collation on all params ─────
    // Ensures SP string comparisons never hit collation mismatch errors.
    // Wrapped in try/catch: CREATE PROCEDURE may fail on restricted MySQL users (SYSTEM_USER).
    try {
    await mysqlPool.query("DROP PROCEDURE IF EXISTS sp_dispatch_create_v2");
    await mysqlPool.query(`CREATE PROCEDURE sp_dispatch_create_v2(
    IN p_serialId CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
    IN p_firmName VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
    IN p_customerName VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
    IN p_address LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
    IN p_shippingAddress LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
    IN p_user VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
    IN p_sellingPrice DECIMAL(18,2),
    IN p_status VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
    IN p_orderVerified VARCHAR(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
    IN p_gemOrderType VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
    IN p_bidNumber VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
    IN p_orderDate DATE,
    IN p_lastDeliveryDate DATE,
    IN p_gstNumber VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
    IN p_contactNumber VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
    IN p_altContactNumber VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
    IN p_buyerEmail VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
    IN p_consigneeEmail VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
    IN p_paymentAuthorityEmail VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
    IN p_consigneeName VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
    IN p_contractFilename VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
    IN p_installationRequired VARCHAR(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
    IN p_installationStatus VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
    IN p_technicianName VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
    IN p_technicianContact VARCHAR(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
    IN p_installationCharges DECIMAL(10,2),
    IN p_installationRemarks LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
    IN p_scheduledDate DATETIME,
    IN p_packagingCost DECIMAL(18,2),
    IN p_commission DECIMAL(18,2),
    IN p_courierPartner VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
    IN p_logisticsDispatchDate DATETIME,
    IN p_trackingId VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
    IN p_freightCharges DECIMAL(18,2),
    IN p_logisticsStatus VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
    IN p_podFilename VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
    IN p_ewayBillFilename VARCHAR(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
    IN p_remarks LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
    IN p_warranty VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
    IN p_buyerAddress LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
    OUT p_ResultMessage VARCHAR(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
    OUT p_DispatchId CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
)
BEGIN
    DECLARE v_SerialStatus VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    DECLARE v_SerialValue VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    DECLARE v_ModelId CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    DECLARE v_OrderId CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL;
    DECLARE v_SafeOrderId VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        GET DIAGNOSTICS CONDITION 1 @sqlstate = RETURNED_SQLSTATE, @errno = MYSQL_ERRNO, @text = MESSAGE_TEXT;
        SET p_ResultMessage = CONCAT('SQL ERROR OCCURRED: ', @text);
        ROLLBACK;
    END;
    SELECT status, value, modelGuid INTO v_SerialStatus, v_SerialValue, v_ModelId
    FROM serials WHERE guid = p_serialId COLLATE utf8mb4_unicode_ci LIMIT 1;
    IF v_SerialStatus IS NULL THEN
        SET p_ResultMessage = 'Serial not found';
    ELSEIF v_SerialStatus != 'Available' THEN
        SET p_ResultMessage = 'Serial is not available';
    ELSE
        START TRANSACTION;
        UPDATE serials SET status = 'Dispatched' WHERE guid = p_serialId COLLATE utf8mb4_unicode_ci;
        IF p_customerName IS NULL OR p_customerName = '' THEN
            SET v_SafeOrderId = CONCAT('TEMP-', UNIX_TIMESTAMP());
        ELSE
            SET v_SafeOrderId = p_customerName;
        END IF;
        SELECT guid INTO v_OrderId FROM orders
        WHERE (orderid COLLATE utf8mb4_unicode_ci = v_SafeOrderId OR customerName COLLATE utf8mb4_unicode_ci = p_customerName)
        AND isDeleted = 0 LIMIT 1;
        IF v_OrderId IS NULL THEN
            SET v_OrderId = UUID();
            INSERT INTO orders (
                guid, orderid, platform, customerName, consigneeName, buyerEmail, consigneeEmail, paymentAuthorityEmail,
                address, shippingAddress, dispatchedBy, status, gemOrderType, bidNumber, orderDate,
                gstNumber, contactNumber, altContactNumber, orderVerified, packagingCost, commission,
                freightCharges, remarks, dispatchDate, buyerAddress
            ) VALUES (
                v_OrderId, v_SafeOrderId, p_firmName, p_customerName, p_consigneeName, p_buyerEmail, p_consigneeEmail, p_paymentAuthorityEmail,
                p_address, p_shippingAddress, p_user, p_status, p_gemOrderType, p_bidNumber, p_orderDate,
                p_gstNumber, p_contactNumber, p_altContactNumber, IFNULL(p_orderVerified, 'No'), IFNULL(p_packagingCost, 0), IFNULL(p_commission, 0),
                IFNULL(p_freightCharges, 0), p_remarks, NOW(), p_buyerAddress
            );
            INSERT INTO order_logistics (orderGuid, courierPartner, trackingId, logisticsStatus, logisticsDispatchDate, podFilename, lastDeliveryDate)
            VALUES (v_OrderId, p_courierPartner, p_trackingId, p_logisticsStatus, p_logisticsDispatchDate, p_podFilename, p_lastDeliveryDate);
            INSERT INTO order_installations (orderGuid, installationRequired, installationStatus, technicianName, technicianContact,
                installationCharges, installationRemarks, scheduledDate)
            VALUES (v_OrderId, p_installationRequired, p_installationStatus, p_technicianName, p_technicianContact,
                IFNULL(p_installationCharges, 0), p_installationRemarks, p_scheduledDate);
        END IF;
        SET p_DispatchId = UUID();
        INSERT INTO order_items (guid, orderGuid, serialNumberGuid, modelGuid, sellingPrice, warranty, contractFilename)
        VALUES (p_DispatchId, v_OrderId, p_serialId, v_ModelId, IFNULL(p_sellingPrice, 0), p_warranty, p_contractFilename);
        INSERT INTO serialmovements (guid, serialNumberGuid, serialValue, dispatchGuid, actionType, status,
            platform, orderid, createdBy, notes, createdAt)
        VALUES (UUID(), p_serialId, v_SerialValue, p_DispatchId, 'Dispatched', 'Dispatched',
            p_firmName, v_SafeOrderId, p_user, CONCAT('Assigned to order #', v_OrderId, ' as item #', p_DispatchId), NOW());
        COMMIT;
        SET p_ResultMessage = 'Success';
    END IF;
END`);

    await mysqlPool.query("DROP PROCEDURE IF EXISTS sp_dispatch_cancel");
    await mysqlPool.query(`CREATE PROCEDURE sp_dispatch_cancel(
    IN p_itemId CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
    IN p_reason LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
    IN p_cancelledBy VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
    OUT p_ResultMessage VARCHAR(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
)
BEGIN
    DECLARE v_OrderId CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    DECLARE v_SerialId CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    DECLARE v_SerialValue VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    DECLARE v_Platform VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    DECLARE v_OrderIdStr VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        ROLLBACK;
        SET p_ResultMessage = 'SQL ERROR OCCURRED';
    END;
    SELECT orderGuid, serialNumberGuid INTO v_OrderId, v_SerialId
    FROM order_items WHERE guid = p_itemId COLLATE utf8mb4_unicode_ci LIMIT 1;
    IF v_OrderId IS NULL THEN
        SET p_ResultMessage = 'Dispatch Item not found';
    ELSE
        START TRANSACTION;
        IF v_SerialId IS NOT NULL THEN
            UPDATE serials SET status = 'Available' WHERE guid = v_SerialId COLLATE utf8mb4_unicode_ci;
        END IF;
        UPDATE orders SET status = 'Order Cancelled', cancellationReason = p_reason,
            cancelledBy = p_cancelledBy, cancelledAt = NOW()
        WHERE guid = v_OrderId COLLATE utf8mb4_unicode_ci;
        SELECT value INTO v_SerialValue FROM serials WHERE guid = v_SerialId COLLATE utf8mb4_unicode_ci;
        SELECT platform, orderid INTO v_Platform, v_OrderIdStr FROM orders WHERE guid = v_OrderId COLLATE utf8mb4_unicode_ci;
        INSERT INTO serialmovements (guid, serialNumberGuid, serialValue, dispatchGuid, actionType, status,
            platform, orderid, createdBy, notes, createdAt)
        VALUES (UUID(), v_SerialId, IFNULL(v_SerialValue, ''), p_itemId, 'Cancelled', 'Available',
            v_Platform, v_OrderIdStr, p_cancelledBy, CONCAT('Cancelled order item #', p_itemId, ': ', p_reason), NOW());
        COMMIT;
        SET p_ResultMessage = 'Success';
    END IF;
END`);

    await mysqlPool.query("DROP PROCEDURE IF EXISTS sp_dispatch_restore");
    await mysqlPool.query(`CREATE PROCEDURE sp_dispatch_restore(
    IN p_itemId CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
    OUT p_ResultMessage VARCHAR(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
)
BEGIN
    DECLARE v_OrderId CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    DECLARE v_SerialId CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    DECLARE v_LogisticsStatus VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    DECLARE v_CurrentStatus VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    DECLARE v_NewStatus VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    DECLARE v_SerialValue VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    DECLARE v_Platform VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    DECLARE v_OrderIdStr VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        ROLLBACK;
        SET p_ResultMessage = 'SQL ERROR OCCURRED';
    END;
    SELECT orderGuid, serialNumberGuid INTO v_OrderId, v_SerialId
    FROM order_items WHERE guid = p_itemId COLLATE utf8mb4_unicode_ci LIMIT 1;
    IF v_OrderId IS NULL THEN
        SET p_ResultMessage = 'Dispatch Item not found';
    ELSE
        START TRANSACTION;
        IF v_SerialId IS NOT NULL THEN
            UPDATE serials SET status = 'Dispatched' WHERE guid = v_SerialId COLLATE utf8mb4_unicode_ci;
        END IF;
        SELECT status INTO v_CurrentStatus FROM orders WHERE guid = v_OrderId COLLATE utf8mb4_unicode_ci;
        SELECT logisticsStatus INTO v_LogisticsStatus FROM order_logistics WHERE orderGuid = v_OrderId COLLATE utf8mb4_unicode_ci;
        IF v_CurrentStatus = 'Order Cancelled' THEN
            IF v_LogisticsStatus = 'Delivered' THEN
                SET v_NewStatus = 'Payment Pending';
            ELSEIF v_LogisticsStatus IS NOT NULL AND v_LogisticsStatus != '' THEN
                SET v_NewStatus = 'Billed';
            ELSE
                SET v_NewStatus = 'Pending';
            END IF;
        ELSE
            SET v_NewStatus = v_CurrentStatus;
        END IF;
        UPDATE orders SET isDeleted = 0, status = v_NewStatus,
            cancellationReason = NULL, cancelledBy = NULL, cancelledAt = NULL
        WHERE guid = v_OrderId COLLATE utf8mb4_unicode_ci;
        SELECT value INTO v_SerialValue FROM serials WHERE guid = v_SerialId COLLATE utf8mb4_unicode_ci;
        SELECT platform, orderid INTO v_Platform, v_OrderIdStr FROM orders WHERE guid = v_OrderId COLLATE utf8mb4_unicode_ci;
        INSERT INTO serialmovements (guid, serialNumberGuid, serialValue, dispatchGuid, actionType, status,
            platform, orderid, createdBy, notes, createdAt)
        VALUES (UUID(), v_SerialId, IFNULL(v_SerialValue, ''), p_itemId, 'Restored', 'Dispatched',
            v_Platform, v_OrderIdStr, 'System', CONCAT('Restored order item #', p_itemId), NOW());
        COMMIT;
        SET p_ResultMessage = 'Success';
    END IF;
END`);
    console.log("Migration: stored procedures recreated with explicit collation");
    } catch (spErr) { 
      // Silently ignore privilege warnings to avoid cluttering the terminal
      // console.debug("Migration: stored procedures skipped (insufficient privileges)"); 
    }

    // ── Default SuperAdmin user ──────────────────────────────────────────────
    const [saRows] = await mysqlPool.query("SELECT userid FROM users WHERE role='SuperAdmin' LIMIT 1");
    if (saRows.length === 0) {
      const defaultPassword = process.env.SUPERADMIN_PASSWORD || "SuperAdmin@1234";
      const hashed = await bcrypt.hash(defaultPassword, 10);
      await mysqlPool.query(
        `INSERT INTO users (userid, username, password, role, fullName, createdAt, updatedAt)
         VALUES (UUID(), 'superadmin', ?, 'SuperAdmin', 'Super Admin', NOW(), NOW())`,
        [hashed]
      );
      console.log("Migration: created default SuperAdmin user (username: superadmin)");
    }

    // ── orders: warrantyStartDate ────────────────────────────────────────────
    try {
      await mysqlPool.query("ALTER TABLE orders ADD COLUMN warrantyStartDate DATE NULL");
      console.log("Migration: added orders.warrantyStartDate");
    } catch (e) { if (e.code !== "ER_DUP_FIELDNAME") console.error("Migration orders.warrantyStartDate:", e.message); }

    // ── order_items: warrantyStartDate (per-serial) ──────────────────────────
    try {
      await mysqlPool.query("ALTER TABLE order_items ADD COLUMN warrantyStartDate DATE NULL");
      console.log("Migration: added order_items.warrantyStartDate");
    } catch (e) { if (e.code !== "ER_DUP_FIELDNAME") console.error("Migration order_items.warrantyStartDate:", e.message); }

    // ── warranty_template: email fields ──────────────────────────────────────
    for (const [col, def] of [
      ["emailSubject", "VARCHAR(500) NULL"],
      ["emailBody",    "LONGTEXT NULL"],
      ["emailTo",      "VARCHAR(500) NULL"],
      ["emailCc",      "VARCHAR(1000) NULL"],
      ["emailBcc",     "VARCHAR(1000) NULL"],
    ]) {
      try {
        await mysqlPool.query(`ALTER TABLE warranty_template ADD COLUMN ${col} ${def}`);
        console.log(`Migration: added warranty_template.${col}`);
      } catch (e) { if (e.code !== "ER_DUP_FIELDNAME") console.error(`Migration warranty_template.${col}:`, e.message); }
    }

    console.log("✅ DB migrations complete");
  } catch (err) {
    console.error("⚠️ DB migration error:", err.message);
  }
}

module.exports = { runMigrations };
