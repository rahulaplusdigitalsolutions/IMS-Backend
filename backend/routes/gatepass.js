const router = require("express").Router();
const path   = require("path");
const fs     = require("fs");
const { mysqlPool } = require("../db");

const fmt = (d) =>
  d ? new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—";

const fmtINR = (n) =>
  Number(n) ? Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—";

function buildGatepassHtml(order, items, logoDataUrl, companyName) {
  const orderId   = order.orderid || "—";
  const gpNo      = `GP-${orderId}`;
  const date      = fmt(order.dispatchDate || order.orderDate || new Date());
  const platform  = order.platform || "—";
  const orderType = order.gemOrderType || "—";

  const fromName  = companyName || "A Plus Digital Solutions";
  const consignee = order.consigneeName || order.customerName || "—";
  const toAddr    = (order.shippingAddress || order.address || order.buyerAddress || "—").replace(/\n/g, "<br/>");
  const bidNo     = order.bidNumber ? `<br/>Bid / Contract No: ${order.bidNumber}` : "";
  const invoiceNo = order.invoiceNumber ? `<br/>Invoice No: ${order.invoiceNumber}` : "";

  let totalQty = 0;
  let totalAmt = 0;
  let rowsHtml = "";

  items.forEach((it, idx) => {
    const serial   = it.serialValue || "—";
    const model    = it.modelName   || "—";
    const company  = it.companyName || "—";
    const qty      = Number(it.quantity) || 1;
    const price    = Number(it.sellingPrice) || 0;
    const amount   = qty * price;
    totalQty      += qty;
    totalAmt      += amount;

    const bg = idx % 2 === 0 ? "" : "background:#f8fafc;";
    rowsHtml += `
      <tr style="${bg}border-bottom:1px solid #e2e8f0;">
        <td style="padding:8px 10px;font-size:11px;color:#334155;text-align:center;">${idx + 1}</td>
        <td style="padding:8px 10px;font-size:11px;color:#334155;">${model}</td>
        <td style="padding:8px 10px;font-size:11px;color:#334155;">${company}</td>
        <td style="padding:8px 10px;font-size:11px;color:#334155;font-family:monospace;">${serial}</td>
        <td style="padding:8px 10px;font-size:11px;color:#334155;text-align:center;">${qty}</td>
        <td style="padding:8px 10px;font-size:11px;color:#334155;text-align:right;">&#8377;${fmtINR(price)}</td>
        <td style="padding:8px 10px;font-size:11px;color:#334155;text-align:right;">&#8377;${fmtINR(amount)}</td>
      </tr>`;
  });

  const generatedAt = new Date().toLocaleString("en-IN", { hour12: true });

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>Gate Pass ${gpNo}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Arial', sans-serif; background: #fff; color: #1e293b; }
  .page { width: 559px; min-height: 794px; margin: 0 auto; padding: 24px 28px; position: relative; }

  /* Accent bar at top */
  .top-bar { height: 5px; background: linear-gradient(90deg, #1e3a5f 0%, #2563eb 60%, #22c55e 100%); margin-bottom: 28px; border-radius: 3px; }

  /* Header */
  .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
  .gp-badge { text-align: right; }
  .gp-badge .title { font-size: 26px; font-weight: 900; letter-spacing: 4px; color: #1e3a5f; }
  .gp-badge .number { display: inline-block; margin-top: 5px; background: #1e3a5f; color: #fff; font-size: 11px; font-weight: 700; padding: 3px 10px; border-radius: 20px; letter-spacing: 0.5px; }

  /* Info strip */
  .info-strip { display: flex; border: 1.5px solid #e2e8f0; border-radius: 10px; overflow: hidden; margin-bottom: 20px; }
  .info-cell { flex: 1; padding: 10px 16px; border-right: 1.5px solid #e2e8f0; }
  .info-cell:last-child { border-right: none; }
  .info-cell .lbl { font-size: 8.5px; font-weight: 800; color: #94a3b8; text-transform: uppercase; letter-spacing: 1.2px; margin-bottom: 4px; }
  .info-cell .val { font-size: 11.5px; font-weight: 700; color: #0f172a; }

  /* From / To */
  .party-row { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 20px; }
  .party-box { border: 1.5px solid #e2e8f0; border-radius: 10px; padding: 14px 16px; }
  .party-box.to-box { border-color: #bfdbfe; background: #eff6ff; }
  .party-tag { font-size: 8px; font-weight: 900; text-transform: uppercase; letter-spacing: 1.8px; color: #94a3b8; margin-bottom: 7px; display: flex; align-items: center; gap: 5px; }
  .party-tag.to-tag { color: #3b82f6; }
  .party-tag::before { content: ''; display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .party-name { font-size: 13px; font-weight: 800; color: #0f172a; margin-bottom: 4px; }
  .to-box .party-name { color: #1d4ed8; }
  .party-addr { font-size: 10.5px; color: #475569; line-height: 1.65; }
  .to-box .party-addr { color: #3b82f6; }

  /* Table */
  .tbl-title { font-size: 8.5px; font-weight: 900; text-transform: uppercase; letter-spacing: 1.5px; color: #64748b; margin-bottom: 8px; padding-left: 2px; }
  table { width: 100%; border-collapse: collapse; border-radius: 10px; overflow: hidden; border: 1.5px solid #e2e8f0; }
  thead tr { background: #1e3a5f; }
  thead th { padding: 9px 11px; font-size: 9px; font-weight: 800; color: #fff; text-transform: uppercase; letter-spacing: 0.8px; }
  thead th:first-child { width: 36px; text-align: center; }
  thead th:nth-child(5) { text-align: center; }
  thead th:nth-child(6), thead th:nth-child(7) { text-align: right; }
  tbody tr { border-bottom: 1px solid #f1f5f9; }
  tbody tr:last-child { border-bottom: none; }
  tbody tr:nth-child(even) { background: #f8fafc; }
  tbody td { padding: 9px 11px; font-size: 11px; color: #334155; }
  tbody td:first-child { text-align: center; color: #94a3b8; font-weight: 700; font-size: 10px; }
  tbody td:nth-child(4) { font-family: monospace; font-size: 10.5px; color: #0f172a; font-weight: 600; }
  tbody td:nth-child(5) { text-align: center; font-weight: 700; }
  tbody td:nth-child(6), tbody td:nth-child(7) { text-align: right; }
  tfoot tr { background: #1e3a5f; }
  tfoot td { padding: 9px 11px; font-size: 11px; font-weight: 800; color: #fff; }
  tfoot td:nth-child(2) { text-align: right; }
  tfoot td:nth-child(3) { text-align: center; }
  tfoot td:last-child { text-align: right; }

  /* Signatures */
  .sig-section { display: flex; justify-content: space-between; margin-top: 52px; gap: 60px; }
  .sig-box { flex: 1; }
  .sig-line { border-top: 1.5px solid #cbd5e1; padding-top: 8px; margin-top: 56px; }
  .sig-label { font-size: 10px; font-weight: 700; color: #64748b; text-align: center; }
  .sig-date { font-size: 9px; color: #94a3b8; text-align: center; margin-top: 3px; }

  /* Footer */
  .footer { position: absolute; bottom: 24px; left: 40px; right: 40px; border-top: 1px solid #f1f5f9; padding-top: 8px; display: flex; justify-content: space-between; align-items: center; }
  .footer-left { font-size: 8.5px; color: #cbd5e1; }
  .footer-right { font-size: 8.5px; color: #cbd5e1; }
</style>
</head>
<body>
<div class="page">

  <!-- Watermark -->
  <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);pointer-events:none;user-select:none;white-space:nowrap;line-height:1;z-index:0;">
    <span style="font-size:300px;font-weight:900;color:#1e3a5f;opacity:0.05;font-family:Arial,sans-serif;">A</span><span style="font-size:300px;font-weight:900;color:#22c55e;opacity:0.08;font-family:Arial,sans-serif;">+</span>
  </div>

  <div style="position:relative;z-index:1;">
  <div class="top-bar"></div>

  <!-- Header -->
  <div class="header">
    <div>
      ${logoDataUrl
        ? `<img src="${logoDataUrl}" alt="${fromName}" style="max-height:60px;max-width:240px;object-fit:contain;display:block;"/>`
        : `<div style="font-size:24px;font-weight:900;color:#1e3a5f;">${fromName}</div>`
      }
    </div>
    <div class="gp-badge">
      <div class="title">GATE PASS</div>
      <div class="number">${gpNo}</div>
    </div>
  </div>

  <!-- Info strip -->
  <div class="info-strip">
    ${[["Date", date], ["Order ID", orderId], ["Platform", platform], ["Order Type", orderType], ["Total Units", String(totalQty)]]
      .map(([l, v]) => `<div class="info-cell"><div class="lbl">${l}</div><div class="val">${v}</div></div>`).join("")}
  </div>

  <!-- From / To -->
  <div class="party-row">
    <div class="party-box">
      <div class="party-tag">From — Sender</div>
      <div class="party-name">${fromName}</div>
      <div class="party-addr">New Delhi, India${bidNo ? `<br/>${bidNo.replace("<br/>", "")}` : ""}${invoiceNo ? `<br/>${invoiceNo.replace("<br/>", "")}` : ""}</div>
    </div>
    <div class="party-box to-box">
      <div class="party-tag to-tag">To — Consignee</div>
      <div class="party-name">${consignee}</div>
      <div class="party-addr">${toAddr}</div>
    </div>
  </div>

  <!-- Items Table -->
  <div class="tbl-title">Item Details</div>
  <table>
    <thead>
      <tr>
        <th>#</th>
        <th style="text-align:left">Model / Description</th>
        <th style="text-align:left">Company</th>
        <th style="text-align:left">Serial No.</th>
        <th>Qty</th>
        <th>Unit Price (&#8377;)</th>
        <th>Amount (&#8377;)</th>
      </tr>
    </thead>
    <tbody>${rowsHtml}</tbody>
    <tfoot>
      <tr>
        <td></td>
        <td colspan="3" style="text-align:right;letter-spacing:1px;">TOTAL</td>
        <td style="text-align:center">${totalQty}</td>
        <td></td>
        <td style="text-align:right">&#8377;${fmtINR(totalAmt)}</td>
      </tr>
    </tfoot>
  </table>

  <!-- Signatures -->
  <div class="sig-section">
    <div class="sig-box">
      <div class="sig-line"></div>
      <div class="sig-label">Prepared By</div>
      <div class="sig-date">Name &amp; Date</div>
    </div>
    <div class="sig-box">
      <div class="sig-line"></div>
      <div class="sig-label">Receiver Signature</div>
      <div class="sig-date">Name, Date &amp; Stamp</div>
    </div>
  </div>

  <!-- Footer -->
  <div class="footer">
    <span class="footer-left">System-generated &mdash; APDS IMS</span>
    <span class="footer-right">Generated: ${generatedAt}</span>
  </div>

  </div><!-- end z-index wrapper -->

</div>
</body>
</html>`;
}

// GET /api/gatepass/:orderGuid
router.get("/:orderGuid", async (req, res) => {
  try {
    const { orderGuid } = req.params;

    const [orderRows] = await mysqlPool.query(`
      SELECT o.guid, o.orderid, o.platform, o.gemOrderType, o.bidNumber,
             o.customerName, o.consigneeName, o.shippingAddress, o.address, o.buyerAddress,
             o.contactNumber, o.invoiceNumber, o.orderDate, o.dispatchDate
      FROM orders o
      WHERE o.guid = ?
      LIMIT 1
    `, [orderGuid]);

    if (!orderRows.length) return res.status(404).json({ message: "Order not found" });
    const order = orderRows[0];

    const [items] = await mysqlPool.query(`
      SELECT oi.sellingPrice, oi.quantity,
             s.value AS serialValue,
             m.name  AS modelName, m.company AS companyName
      FROM order_items oi
      LEFT JOIN serials s ON oi.serialNumberGuid = s.guid
      LEFT JOIN models  m ON s.modelGuid = m.guid
      WHERE oi.orderGuid = ?
      ORDER BY oi.guid ASC
    `, [orderGuid]);

    // Load company name from warranty template; always use aplus.png as logo
    let logoDataUrl = null;
    let companyName = null;
    try {
      const [tpl] = await mysqlPool.query("SELECT companyName FROM warranty_template WHERE id=1");
      if (tpl[0]) companyName = tpl[0].companyName || null;
    } catch (_) {}
    try {
      const logoPath = path.resolve(__dirname, "../uploads/aplus.png");
      if (fs.existsSync(logoPath)) {
        const buf   = fs.readFileSync(logoPath);
        logoDataUrl = `data:image/png;base64,${buf.toString("base64")}`;
      }
    } catch (_) {}

    const html = buildGatepassHtml(order, items, logoDataUrl, companyName);

    const puppeteer = require("puppeteer");
    const browser   = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
    const page      = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    const pdfBuffer = await page.pdf({
      format: "A5",
      printBackground: true,
      margin: { top: "0", right: "0", bottom: "0", left: "0" },
    });
    await browser.close();

    const safeName = String(order.orderid || orderGuid).replace(/[^a-zA-Z0-9\-_]/g, "");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="gatepass-${safeName}.pdf"`);
    res.end(pdfBuffer);
  } catch (err) {
    console.error("[gatepass] GET /:orderGuid:", err);
    res.status(500).json({ message: err.message || "Failed to generate gate pass" });
  }
});

module.exports = router;
