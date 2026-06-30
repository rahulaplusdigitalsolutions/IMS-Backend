const router = require("express").Router();
const { mysqlPool } = require("../db");
const { logUserActivity } = require("../helpers");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const mammoth = require("mammoth");
const { v4: uuidv4 } = require("uuid");

// ── Theme color resolution helpers ───────────────────────────────────────────

function parseThemeColors(admZip) {
  const colorMap = {};
  try {
    const entry = admZip.getEntry("word/theme/theme1.xml");
    if (!entry) return colorMap;
    const xml = admZip.readAsText(entry);
    const slots = ["dk1","lt1","dk2","lt2","accent1","accent2","accent3","accent4","accent5","accent6","hlink","folHlink"];
    for (const slot of slots) {
      const m1 = xml.match(new RegExp(`<a:${slot}>\\s*<a:srgbClr[^>]+val="([0-9A-Fa-f]{6})"`, "i"));
      if (m1) { colorMap[slot] = m1[1].toUpperCase(); continue; }
      const m2 = xml.match(new RegExp(`<a:${slot}>\\s*<a:sysClr[^>]+lastClr="([0-9A-Fa-f]{6})"`, "i"));
      if (m2) colorMap[slot] = m2[1].toUpperCase();
    }
  } catch (e) {
    console.warn("[warranty] parseThemeColors:", e.message);
  }
  return colorMap;
}

// tintByte 0xFF = full white, 0x00 = no tint (original)
function hexTint(hex, tintByte) {
  const t = tintByte / 255;
  return [0, 2, 4].map(i => {
    const c = parseInt(hex.slice(i, i + 2), 16);
    return Math.min(255, Math.round(c + (255 - c) * t)).toString(16).padStart(2, "0");
  }).join("").toUpperCase();
}

// shadeByte 0xFF = original, 0x00 = full black
function hexShade(hex, shadeByte) {
  const s = shadeByte / 255;
  return [0, 2, 4].map(i => {
    const c = parseInt(hex.slice(i, i + 2), 16);
    return Math.min(255, Math.round(c * s)).toString(16).padStart(2, "0");
  }).join("").toUpperCase();
}

function resolveThemeColorsInXml(xml, colorMap) {
  // Resolve <w:shd> background fills (w:themeFill) and pattern colors (w:themeColor)
  xml = xml.replace(/<w:shd(\s[^>]*?)(\/?>)/g, (full, attrs, end) => {
    let a = attrs;

    // Background fill: w:themeFill → w:fill
    const themeFill = (a.match(/w:themeFill="([^"]+)"/) || [])[1];
    if (themeFill && colorMap[themeFill]) {
      const fillMatch = a.match(/w:fill="([^"]+)"/);
      if (!fillMatch || !/^[0-9A-Fa-f]{6}$/.test(fillMatch[1])) {
        let hex = colorMap[themeFill];
        const tint  = (a.match(/w:themeFillTint="([^"]+)"/)  || [])[1];
        const shade = (a.match(/w:themeFillShade="([^"]+)"/) || [])[1];
        if (tint)  hex = hexTint(hex, parseInt(tint, 16));
        else if (shade) hex = hexShade(hex, parseInt(shade, 16));
        a = fillMatch
          ? a.replace(/w:fill="[^"]*"/, `w:fill="${hex}"`)
          : a + ` w:fill="${hex}"`;
      }
    }

    // Pattern/foreground: w:themeColor → w:color (used in w:val="solid")
    const themeColor = (a.match(/w:themeColor="([^"]+)"/) || [])[1];
    if (themeColor && colorMap[themeColor]) {
      const colorMatch = a.match(/w:color="([^"]+)"/);
      if (!colorMatch || !/^[0-9A-Fa-f]{6}$/.test(colorMatch[1])) {
        let hex = colorMap[themeColor];
        const tint  = (a.match(/w:themeTint="([^"]+)"/)  || [])[1];
        const shade = (a.match(/w:themeShade="([^"]+)"/) || [])[1];
        if (tint)  hex = hexTint(hex, parseInt(tint, 16));
        else if (shade) hex = hexShade(hex, parseInt(shade, 16));
        a = colorMatch
          ? a.replace(/w:color="[^"]*"/, `w:color="${hex}"`)
          : a + ` w:color="${hex}"`;
      }
    }

    return `<w:shd${a}${end}`;
  });

  // Resolve <w:color> run text colors (w:themeColor → w:val)
  xml = xml.replace(/<w:color(\s[^>]*?)(\/?>)/g, (full, attrs, end) => {
    const themeColor = (attrs.match(/w:themeColor="([^"]+)"/) || [])[1];
    if (!themeColor || !colorMap[themeColor]) return full;
    const valMatch = attrs.match(/w:val="([^"]+)"/);
    if (valMatch && /^[0-9A-Fa-f]{6}$/.test(valMatch[1])) return full;
    let hex = colorMap[themeColor];
    const tint  = (attrs.match(/w:themeTint="([^"]+)"/)  || [])[1];
    const shade = (attrs.match(/w:themeShade="([^"]+)"/) || [])[1];
    if (tint)  hex = hexTint(hex, parseInt(tint, 16));
    else if (shade) hex = hexShade(hex, parseInt(shade, 16));
    const a = valMatch
      ? attrs.replace(/w:val="[^"]*"/, `w:val="${hex}"`)
      : attrs + ` w:val="${hex}"`;
    return `<w:color${a}${end}`;
  });

  return xml;
}

// ── file upload for header image / docx ──────────────────────────────────────
const uploadDir = path.resolve(__dirname, "../uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `warranty-header-${Date.now()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, true);
  },
});

// Helper to split HTML string into top-level HTML blocks
function splitHtmlBlocks(html) {
  const blocks = [];
  let currentBlock = "";
  let depth = 0;
  let pos = 0;
  
  while (pos < html.length) {
    if (html[pos] === '<') {
      const tagMatch = html.slice(pos).match(/^<\/?([a-zA-Z1-6]+)/);
      if (tagMatch) {
        const tagName = tagMatch[1].toLowerCase();
        const isClosing = html[pos + 1] === '/';
        const tagLength = html.slice(pos).indexOf('>') + 1;
        
        if (tagLength > 0) {
          const tagMarkup = html.slice(pos, pos + tagLength);
          currentBlock += tagMarkup;
          pos += tagLength;
          
          const isBlockTag = ["p", "table", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "div"].includes(tagName);
          if (isBlockTag) {
            if (isClosing) {
              depth--;
              if (depth <= 0) {
                blocks.push(currentBlock);
                currentBlock = "";
                depth = 0;
              }
            } else {
              const isSelfClosing = tagMarkup.endsWith('/>') || ["img", "br", "hr"].includes(tagName);
              if (!isSelfClosing) {
                depth++;
              } else if (depth === 0) {
                blocks.push(currentBlock);
                currentBlock = "";
              }
            }
          }
          continue;
        }
      }
    }
    
    currentBlock += html[pos];
    pos++;
  }
  
  if (currentBlock.trim()) {
    blocks.push(currentBlock);
  }
  
  return blocks;
}

// Helper to convert HTML block to plain text
function getPlainText(html) {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

// Clean HTML to extract only the header section (removes any letter body starting keywords)
function cleanHeaderHtml(html) {
  const blocks = splitHtmlBlocks(html);
  const headerBlocks = [];
  
  const BODY_START_PATTERNS = [
    /^(ref(erence)?\.?\s*no|contract\s*no)/i,
    /^date\s*:/i,
    /^subject\s*:/i,
    /^warranty\s*certificate/i,
    /^to$/i,
    /^to\s*,/i,
    /^respected\s*sir/i,
    /^respected\s*madam/i,
    /^dear\s*sir/i,
    /^dear\s*madam/i,
    /^consignee/i,
  ];

  for (const block of blocks) {
    const text = getPlainText(block);
    
    let isBodyStart = false;
    for (const pattern of BODY_START_PATTERNS) {
      if (pattern.test(text)) {
        isBodyStart = true;
        break;
      }
    }
    
    if (isBodyStart) {
      console.log(`[warranty-header-cleaner] Block starts with body keyword: "${text}". Stopping extraction.`);
      break;
    }
    
    headerBlocks.push(block);
  }
  
  return headerBlocks.join("").trim();
}

// ── Default certificate body — matches the Word letter-head.docx layout ──────
const DEFAULT_CERT_HTML = `<div style="font-family:Calibri,Arial,sans-serif;font-size:11pt;line-height:1.4;color:#000;padding:14px 28px 20px 28px;">

  <p style="margin:0 0 2px 0;"><strong>Reference No.:</strong> {{GEM_NUMBER}}</p>
  <p style="margin:0 0 12px 0;"><strong>Date:</strong> {{DISPATCH_DATE}}</p>

  <p style="margin:0 0 2px 0;"><strong>To</strong></p>
  <p style="margin:0 0 12px 0;font-weight:bold;">{{TO_ADDRESS}}</p>

  <p style="margin:0 0 12px 0;text-align:center;font-weight:bold;text-decoration:underline;font-size:12pt;letter-spacing:0.5px;">WARRANTY CERTIFICATE</p>

  <p style="margin:0 0 10px 0;"><strong>Subject:</strong> Warranty Certificate &ndash; Contract No. {{GEM_NUMBER}}</p>

  <p style="margin:0 0 10px 0;"><strong>Respected Sir/Madam,</strong></p>

  <p style="margin:0 0 10px 0;">This is to certify that the equipment supplied under the above-mentioned contract is covered under warranty by the OEM as per the details below:</p>

  <p style="margin:0 0 6px 0;"><strong>Invoice No. : {{INVOICE_NUMBER}}</strong></p>

  <p style="margin:0 0 2px 0;"><strong>Product Details :</strong></p>
  <p style="margin:0 0 2px 0;"><strong>Product Name :</strong> {{MODEL_NAME}} Printer with {{WARRANTY_PERIOD}} Warranty ({{QUANTITY}} unit/units)</p>
  <p style="margin:0 0 10px 0;"><strong>Serial Numbers :</strong> {{SERIAL_NUMBERS}}.</p>

  <p style="margin:0 0 4px 0;"><strong>Warranty Terms &amp; Conditions:</strong></p>
  <p style="margin:0 0 3px 0;">1. The product is warranted against manufacturing defects for a period of {{WARRANTY_PERIOD}} from the date of supply {{DISPATCH_DATE}}.</p>
  <p style="margin:0 0 3px 0;">2. During the warranty period, any defective part will be repaired or replaced free of cost.</p>
  <p style="margin:0 0 3px 0;">3. The warranty does not cover damages resulting from mishandling, improper installation by unauthorized personnel, or external electrical fluctuations beyond specified limits.</p>
  <p style="margin:0 0 10px 0;">4. Post-warranty service support and spare parts will be available through the authorized service center on a chargeable basis.</p>

  <p style="margin:0 0 12px 0;"><strong>This certificate is issued in compliance with the contract terms and conditions and remains valid for the specified warranty period from the date of supply. ({{DISPATCH_DATE}})</strong></p>

  <p style="margin:0 0 2px 0;"><strong>Thanks &amp; Regards,</strong></p>
  <p style="margin:0 0 36px 0;">For <strong>A PLUS DIGITAL SOLUTIONS</strong></p>

  <p style="margin:0;">(Authorized Signatory)</p>
</div>`;

// ── helper: render template ───────────────────────────────────────────────────
function renderTemplate(htmlBody, template, order) {
  const warrantyPeriod = order.warranty || "1 Year";
  const fmt = (d) => d ? new Date(d).toLocaleDateString("en-IN", { day:"2-digit", month:"2-digit", year:"numeric" }) : "";

  let expiryDate = "";
  try {
    const base = new Date(order.dispatchDate || order.orderDate || Date.now());
    const num  = parseInt(warrantyPeriod) || 1;
    const isMonths = /month/i.test(warrantyPeriod);
    if (isMonths) {
      base.setMonth(base.getMonth() + num);
    } else {
      base.setFullYear(base.getFullYear() + num);
    }
    expiryDate = fmt(base);
  } catch(e) {}

  const gemNumber  = order.bidNumber || order.orderNumber || order.invoiceNumber || "";
  const toAddress  = [order.consigneeName || order.customer || "", order.shippingAddress || order.address || order.buyerAddress || ""].filter(Boolean).join("<br>");

  const vars = {
    "{{COMPANY_NAME}}":     template.companyName    || "",
    "{{COMPANY_ADDRESS}}":  template.companyAddress || "",
    "{{COMPANY_PHONE}}":    template.companyPhone   || "",
    "{{COMPANY_EMAIL}}":    template.companyEmail   || "",
    "{{COMPANY_GSTIN}}":    template.companyGstin   || "",
    "{{GEM_NUMBER}}":       gemNumber,
    "{{BID_NUMBER}}":       gemNumber,
    "{{CONTRACT_NO}}":      gemNumber,
    "{{ORDER_NUMBER}}":     String(order.orderNumber || order.orderid || ""),
    "{{INVOICE_NUMBER}}":   order.invoiceNumber     || "",
    "{{CUSTOMER_NAME}}":    order.customer          || order.customerName || "",
    "{{CONSIGNEE_NAME}}":   order.consigneeName     || order.customer    || "",
    "{{ADDRESS}}":          (order.shippingAddress  || order.address || order.buyerAddress || "").replace(/\n/g, "<br>"),
    "{{TO_ADDRESS}}":       toAddress,
    "{{CONTACT_NUMBER}}":   order.contactNumber     || "",
    "{{MODEL_NAME}}":       order.modelName         || "",
    "{{SERIAL_NUMBER}}":    order.serialValue       || "",
    "{{SERIAL_NUMBERS}}":   order.allSerials        || order.serialValue || "",
    "{{QUANTITY}}":         String(order.quantity   || order.serialCount || ""),
    "{{PURCHASE_DATE}}":    fmt(order.orderDate),
    "{{DISPATCH_DATE}}":    fmt(order.dispatchDate) || fmt(order.orderDate),
    "{{WARRANTY_PERIOD}}":  warrantyPeriod,
    "{{WARRANTY_EXPIRY}}":  expiryDate,
    "{{SELLING_PRICE}}":    order.sellingPrice ? `₹${Number(order.sellingPrice).toLocaleString("en-IN")}` : "",
    "{{GST_NUMBER}}":       order.gstNumber         || "",
    "{{CERT_NUMBER}}":      `WC-${String(order.orderNumber || order.orderid || "").padStart(6, "0")}`,
  };

  let html = htmlBody;
  for (const [k, v] of Object.entries(vars)) {
    html = html.split(k).join(v || "");
  }
  return html;
}

// ── GET /api/warranty/template ────────────────────────────────────────────────
router.get("/template", async (req, res) => {
  try {
    const [rows] = await mysqlPool.query("SELECT * FROM warranty_template WHERE id=1");
    res.json(rows[0] || {});
  } catch (err) {
    console.error("[warranty] GET /template:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

// ── PUT /api/warranty/template ────────────────────────────────────────────────
// Accepts any combination of: htmlBody, docxRawText, docxFileName, docxBase64
router.put("/template", async (req, res) => {
  try {
    const { htmlBody, docxRawText, docxFileName, docxBase64, clearHeader,
            emailSubject, emailBody, emailTo, emailCc, emailBcc } = req.body;

    const setClauses = [];
    const params     = [];

    if (htmlBody      !== undefined) { setClauses.push("htmlBody=?");      params.push(htmlBody); }
    if (docxRawText   !== undefined) { setClauses.push("docxRawText=?");   params.push(docxRawText); }
    if (docxFileName  !== undefined) { setClauses.push("docxFileName=?");  params.push(docxFileName); }
    if (docxBase64    !== undefined) {
      setClauses.push("docxBinary=?");
      params.push(docxBase64 ? Buffer.from(docxBase64, "base64") : null);
    }
    if (emailSubject  !== undefined) { setClauses.push("emailSubject=?");  params.push(emailSubject); }
    if (emailBody     !== undefined) { setClauses.push("emailBody=?");     params.push(emailBody); }
    if (emailTo       !== undefined) { setClauses.push("emailTo=?");       params.push(emailTo); }
    if (emailCc       !== undefined) { setClauses.push("emailCc=?");       params.push(emailCc); }
    if (emailBcc      !== undefined) { setClauses.push("emailBcc=?");      params.push(emailBcc); }
    if (clearHeader) {
      setClauses.push("headerImagePath=?");
      params.push(null);
      setClauses.push("headerHtml=?");
      params.push(null);
    }

    if (setClauses.length > 0) {
      params.push(1); // WHERE id=1
      await mysqlPool.query(`UPDATE warranty_template SET ${setClauses.join(",")} WHERE id=1`, params);
    }

    await logUserActivity(mysqlPool, req.user, "Update Warranty Template", [], req.ip);
    res.json({ message: "Template updated" });
  } catch (err) {
    console.error("[warranty] PUT /template:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

// ── POST /api/warranty/template/upload-header ─────────────────────────────────
// Accepts: image files → saves as image path
//          .docx files → converts to HTML via mammoth
//          .html files → reads raw HTML content
router.post("/template/upload-header", (req, res) => {
  upload.single("file")(req, res, async (err) => {
    if (err) {
      console.error("[warranty] Multer upload error:", err);
      return res.status(400).json({ message: err.message || "File upload failed" });
    }
    try {
      if (!req.file) {
        console.warn("[warranty] req.file is missing");
        return res.status(400).json({ message: "No file uploaded" });
      }

      const ext = path.extname(req.file.originalname).toLowerCase();
      const backendBase = process.env.BACKEND_URI || `http://localhost:${process.env.PORT || 5001}`;

      if (ext === ".docx") {
        // Convert Word → HTML
        let headerHtml = "";
        try {
          const AdmZip = require("adm-zip");
          const zip = new AdmZip(req.file.path);
          
          // Find all header entries
          const entries = zip.getEntries();
          const headerEntries = entries.filter(e => /^word\/header\d+\.xml$/.test(e.entryName));
          
          let mammothInput = { path: req.file.path };
          
          if (headerEntries.length > 0) {
            console.log(`[warranty] Found ${headerEntries.length} header XML file(s) in docx.`);
            // Sort by name
            headerEntries.sort((a, b) => a.entryName.localeCompare(b.entryName));
            
            // Pick the header file that contains drawing or text nodes
            let targetHeader = headerEntries.find(e => {
              const xml = zip.readAsText(e);
              return xml.includes("<w:t") || xml.includes("<w:drawing");
            });
            
            if (!targetHeader) {
              targetHeader = headerEntries[0];
            }
            
            const headerXml = zip.readAsText(targetHeader);
            console.log(`[warranty] Parsing content from header: ${targetHeader.entryName}`);
            
            // Transform <w:hdr> into <w:document><w:body> so Mammoth can parse it
            let documentXml = headerXml;
            const hdrStartMatch = headerXml.match(/<w:hdr([\s\S]*?)>/);
            if (hdrStartMatch) {
              const fullStartTag = hdrStartMatch[0]; // e.g., <w:hdr ... >
              const attributes = hdrStartMatch[1];
              const docStartTag = `<w:document${attributes}><w:body>`;
              documentXml = headerXml.replace(fullStartTag, docStartTag).replace(/<\/w:hdr>/g, '</w:body></w:document>');
            } else {
              // Fallback wrapping if regex fails
              documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
  <w:body>
    ${headerXml}
  </w:body>
</w:document>`;
            }
            
            // Replace word/document.xml with the modified header content
            zip.addFile("word/document.xml", Buffer.from(documentXml, "utf-8"));
            
            // Copy relationship files if they exist so images inside header are correctly resolved
            const headerRelsPath = `word/_rels/${targetHeader.name}.rels`;
            const headerRelsEntry = zip.getEntry(headerRelsPath);
            if (headerRelsEntry) {
              const relsXml = zip.readAsText(headerRelsEntry);
              zip.addFile("word/_rels/document.xml.rels", Buffer.from(relsXml, "utf-8"));
            }
            
            // Use the modified zip buffer for Mammoth conversion
            mammothInput = { buffer: zip.toBuffer() };
          } else {
            console.log("[warranty] No header XML found in docx, falling back to document body.");
          }

          const result = await mammoth.convertToHtml(
            mammothInput,
            {
              convertImage: mammoth.images.imgElement(async (image) => {
                const buf = await image.read("base64");
                return { src: `data:${image.contentType};base64,${buf}` };
              }),
            }
          );
          headerHtml = result.value || "";
          headerHtml = cleanHeaderHtml(headerHtml);
          if (result.messages && result.messages.length > 0) {
            console.warn("[warranty] Mammoth warnings during conversion:", result.messages);
          }
        } catch (mammothErr) {
          console.error("[warranty] mammoth error:", mammothErr);
          fs.unlink(req.file.path, () => {});
          return res.status(500).json({ message: "Failed to convert Word file: " + mammothErr.message });
        }

        if (!headerHtml) {
          fs.unlink(req.file.path, () => {});
          return res.status(400).json({
            message: "Word file produced empty content. Please ensure your header content is designed within the main body or the header section of the document."
          });
        }

        await mysqlPool.query(
          "UPDATE warranty_template SET headerHtml=?, headerImagePath=NULL WHERE id=1",
          [headerHtml]
        );
        fs.unlink(req.file.path, () => {});
        await logUserActivity(mysqlPool, req.user, "Upload Warranty Header (DOCX)", [], req.ip);
        res.json({ message: "Word header uploaded", type: "docx", headerHtml });

      } else if (ext === ".html" || ext === ".htm") {
        // Read HTML file content
        let headerHtml = fs.readFileSync(req.file.path, "utf8");
        headerHtml = cleanHeaderHtml(headerHtml);
        await mysqlPool.query(
          "UPDATE warranty_template SET headerHtml=?, headerImagePath=NULL WHERE id=1",
          [headerHtml]
        );
        fs.unlink(req.file.path, () => {});
        await logUserActivity(mysqlPool, req.user, "Upload Warranty Header (HTML)", [], req.ip);
        res.json({ message: "HTML header uploaded", type: "html", headerHtml });

      } else if (ext === ".pdf") {
        // Convert PDF first page to PNG via Puppeteer
        const pngFilename = `warranty-header-${Date.now()}.png`;
        const outputPath = path.resolve(uploadDir, pngFilename);
        
        try {
          const pdfDataBuffer = fs.readFileSync(req.file.path);
          const pdfBase64 = pdfDataBuffer.toString('base64');
          
          const puppeteer = require('puppeteer');
          const browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
          });
          const page = await browser.newPage();
          
          // Render using PDF.js inside Puppeteer
          const htmlContent = `
            <!DOCTYPE html>
            <html>
            <head>
              <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.min.js"></script>
              <style>
                body { margin: 0; padding: 0; background: transparent; }
                canvas { display: block; width: 100%; height: auto; }
              </style>
            </head>
            <body>
              <canvas id="pdf-canvas"></canvas>
              <script>
                pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';
                
                async function renderPdf(base64Data) {
                  try {
                    const binData = atob(base64Data);
                    const uint8Data = new Uint8Array(binData.length);
                    for (let i = 0; i < binData.length; i++) {
                      uint8Data[i] = binData.charCodeAt(i);
                    }
                    
                    const loadingTask = pdfjsLib.getDocument({ data: uint8Data });
                    const pdf = await loadingTask.promise;
                    const page = await pdf.getPage(1);
                    
                    const viewport = page.getViewport({ scale: 2.0 }); // 2.0 scale for crisp resolution
                    const canvas = document.getElementById('pdf-canvas');
                    const context = canvas.getContext('2d');
                    canvas.height = viewport.height;
                    canvas.width = viewport.width;
                    
                    await page.render({
                      canvasContext: context,
                      viewport: viewport
                    }).promise;
                    
                    // Auto-crop white space from bottom
                    cropCanvas(canvas);
                    
                    window.renderingComplete = true;
                  } catch (err) {
                    window.renderingError = err.message || err.toString();
                  }
                }

                function cropCanvas(canvas) {
                  const ctx = canvas.getContext('2d');
                  const width = canvas.width;
                  const height = canvas.height;
                  const imgData = ctx.getImageData(0, 0, width, height).data;
                  
                  // Analyze content presence for each row, ignoring the outer 6% margins to bypass page borders
                  const rowHasContent = [];
                  const startX = Math.floor(width * 0.06);
                  const endX = Math.floor(width * 0.94);
                  
                  for (let y = 0; y < height; y++) {
                    let hasContent = false;
                    for (let x = startX; x < endX; x++) {
                      const idx = (y * width + x) * 4;
                      const r = imgData[idx];
                      const g = imgData[idx + 1];
                      const b = imgData[idx + 2];
                      const a = imgData[idx + 3];
                      
                      // Check if pixel is not white (threshold of 250) and has some opacity
                      if (a > 10 && (r < 250 || g < 250 || b < 250)) {
                        hasContent = true;
                        break;
                      }
                    }
                    rowHasContent.push(hasContent);
                  }

                  // Find where the header content starts
                  let headerStart = 0;
                  for (let y = 0; y < height; y++) {
                    if (rowHasContent[y]) {
                      headerStart = y;
                      break;
                    }
                  }

                  // Find the first significant white gap after the header starts
                  let headerEnd = height;
                  let consecutiveWhiteRows = 0;
                  // A gap is defined as at least 70 consecutive white rows (approx. 35 CSS pixels at scale 2.0)
                  const GAP_THRESHOLD = 70;
                  
                  for (let y = headerStart; y < height; y++) {
                    if (!rowHasContent[y]) {
                      consecutiveWhiteRows++;
                      if (consecutiveWhiteRows >= GAP_THRESHOLD) {
                        // The header ends where the gap started, plus 15px margin for aesthetics
                        headerEnd = y - consecutiveWhiteRows + 15;
                        break;
                      }
                    } else {
                      consecutiveWhiteRows = 0;
                    }
                  }

                  // Fallback: Cap the header height to 28% of page height if no gap or if gap is too low
                  const maxHeaderHeight = Math.round(height * 0.28);
                  let cropHeight = headerEnd;
                  
                  if (cropHeight > maxHeaderHeight) {
                    cropHeight = maxHeaderHeight;
                  }

                  // Minimum safety height
                  if (cropHeight < 150) {
                    cropHeight = Math.min(height, 350);
                  }
                  
                  if (cropHeight < height) {
                    const tempCanvas = document.createElement('canvas');
                    tempCanvas.width = width;
                    tempCanvas.height = cropHeight;
                    const tempCtx = tempCanvas.getContext('2d');
                    tempCtx.drawImage(canvas, 0, 0);
                    
                    canvas.parentNode.replaceChild(tempCanvas, canvas);
                    tempCanvas.id = 'pdf-canvas';
                    console.log('Cropped canvas from height ' + height + ' to ' + cropHeight);
                  }
                }
              </script>
            </body>
            </html>
          `;
          
          await page.setContent(htmlContent);
          await page.evaluate((b64) => window.renderPdf(b64), pdfBase64);
          
          // Wait for rendering to complete or error out
          await page.waitForFunction(() => window.renderingComplete || window.renderingError, { timeout: 30000 });
          
          const errorMsg = await page.evaluate(() => window.renderingError);
          if (errorMsg) {
            throw new Error("PDF.js render error: " + errorMsg);
          }
          
          // Take screenshot of the canvas element
          const canvasElement = await page.$('#pdf-canvas');
          await canvasElement.screenshot({ path: outputPath });
          
          await browser.close();
          
          // Delete the temporary PDF file
          fs.unlink(req.file.path, () => {});
          
          // Save the generated PNG path to database
          await mysqlPool.query(
            "UPDATE warranty_template SET headerImagePath=?, headerHtml=NULL WHERE id=1",
            [pngFilename]
          );
          await logUserActivity(mysqlPool, req.user, "Upload Warranty Header (PDF)", [], req.ip);
          res.json({ message: "PDF header uploaded and converted", type: "image", filePath: pngFilename, previewUrl: `${backendBase}/uploads/${pngFilename}` });
        } catch (pdfErr) {
          console.error("[warranty] PDF conversion error:", pdfErr);
          fs.unlink(req.file.path, () => {});
          return res.status(500).json({ message: "Failed to convert PDF file: " + pdfErr.message });
        }

      } else {
        // Image file
        const filePath = req.file.filename;
        await mysqlPool.query(
          "UPDATE warranty_template SET headerImagePath=?, headerHtml=NULL WHERE id=1",
          [filePath]
        );
        await logUserActivity(mysqlPool, req.user, "Upload Warranty Header (Image)", [], req.ip);
        res.json({ message: "Header image uploaded", type: "image", filePath, previewUrl: `${backendBase}/uploads/${filePath}` });
      }
    } catch (err) {
      console.error("[warranty] POST /template/upload-header:", err);
      res.status(500).json({ message: err.message || "Upload failed" });
    }
  });
});

// ── PUT /api/warranty/template/save-header-html ───────────────────────────────
// Save raw HTML string as header (from textarea paste)
router.put("/template/save-header-html", async (req, res) => {
  try {
    let { html } = req.body;
    if (html === undefined) return res.status(400).json({ message: "html is required" });
    html = cleanHeaderHtml(html);
    await mysqlPool.query(
      "UPDATE warranty_template SET headerHtml=?, headerImagePath=NULL WHERE id=1",
      [html || ""]
    );
    await logUserActivity(mysqlPool, req.user, "Save Warranty Header HTML", [], req.ip);
    res.json({ message: "Header HTML saved" });
  } catch (err) {
    console.error("[warranty] PUT /save-header-html:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

// ── GET /api/warranty/orders — GEM orders for cert generation ─────────────────
router.get("/orders", async (req, res) => {
  try {
    const [rows] = await mysqlPool.query(`
      SELECT
        o.guid          AS orderGuid,
        o.orderid       AS orderNumber,
        o.platform,
        o.gemOrderType,
        o.bidNumber,
        o.customerName  AS customer,
        o.consigneeName,
        o.shippingAddress,
        o.address,
        o.buyerAddress,
        o.contactNumber,
        o.altContactNumber,
        o.invoiceNumber,
        o.gstNumber,
        o.orderDate,
        o.dispatchDate,
        o.status,
        oi.sellingPrice,
        oi.warranty,
        s.value         AS serialValue,
        m.name          AS modelName,
        m.company       AS companyName
      FROM orders o
      LEFT JOIN order_items oi ON oi.orderGuid = o.guid
      LEFT JOIN serials s      ON oi.serialNumberGuid = s.guid
      LEFT JOIN models m       ON s.modelGuid = m.guid
      WHERE o.isDeleted = 0
      ORDER BY o.dispatchDate DESC, o.orderDate DESC
    `);

    // Deduplicate by orderGuid — keep first row per order
    const seen = new Set();
    const unique = [];
    for (const row of rows) {
      if (!seen.has(row.orderGuid)) {
        seen.add(row.orderGuid);
        unique.push(row);
      }
    }
    res.json(unique);
  } catch (err) {
    console.error("[warranty] GET /orders:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

// ── GET /api/warranty/generate/:orderGuid ─────────────────────────────────────
router.get("/generate/:orderGuid", async (req, res) => {
  try {
    const { orderGuid } = req.params;

    // Fetch main order + first serial
    const [orderRows] = await mysqlPool.query(`
      SELECT
        o.guid AS orderGuid, o.orderid AS orderNumber,
        o.orderDate, o.dispatchDate,
        o.platform, o.gemOrderType, o.bidNumber,
        o.customerName AS customer, o.consigneeName,
        o.shippingAddress, o.address, o.buyerAddress,
        o.contactNumber, o.altContactNumber,
        o.invoiceNumber, o.gstNumber,
        oi.sellingPrice, oi.warranty, oi.quantity,
        s.value AS serialValue,
        m.name  AS modelName, m.company AS companyName
      FROM orders o
      LEFT JOIN order_items oi ON oi.orderGuid = o.guid
      LEFT JOIN serials s      ON oi.serialNumberGuid = s.guid
      LEFT JOIN models m       ON s.modelGuid = m.guid
      WHERE o.guid = ?
      LIMIT 1
    `, [orderGuid]);

    if (!orderRows.length) return res.status(404).json({ message: "Order not found" });
    const order = orderRows[0];

    // Fetch ALL serial numbers for this order
    const [allSerialRows] = await mysqlPool.query(`
      SELECT s.value
      FROM order_items oi
      LEFT JOIN serials s ON oi.serialNumberGuid = s.guid
      WHERE oi.orderGuid = ? AND s.value IS NOT NULL
      ORDER BY s.value
    `, [orderGuid]);
    order.allSerials  = allSerialRows.map(r => r.value).join(", ");
    order.serialCount = allSerialRows.length || order.quantity || 1;

    // Fetch template
    const [tplRows] = await mysqlPool.query("SELECT * FROM warranty_template WHERE id=1");
    const template = tplRows[0] || {};

    // Convert header image to base64 data URL so it renders reliably inside an iframe srcDoc
    let headerImgUrl = null;
    if (template.headerImagePath) {
      try {
        const imgPath = path.resolve(__dirname, "../uploads", template.headerImagePath);
        if (fs.existsSync(imgPath)) {
          const imgBuf = fs.readFileSync(imgPath);
          const ext    = path.extname(template.headerImagePath).toLowerCase().slice(1);
          const mime   = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "png" ? "image/png" : `image/${ext}`;
          headerImgUrl = `data:${mime};base64,${imgBuf.toString("base64")}`;
        }
      } catch (e) {
        console.warn("[warranty] Could not load header image:", e.message);
      }
    }

    // Check for existing saved certificate
    const [existing] = await mysqlPool.query(
      "SELECT guid, htmlContent, status FROM wc_certs WHERE orderGuid=? ORDER BY createdAt DESC LIMIT 1",
      [orderGuid]
    );

    let html, certGuid = null, certStatus = "draft";
    if (existing.length > 0) {
      html       = existing[0].htmlContent;
      certGuid   = existing[0].guid;
      certStatus = existing[0].status;
    } else {
      // Use saved htmlBody; only reset if it contains the old {{HEADER_IMAGE}} placeholder
      const isStale = !template.htmlBody || template.htmlBody.includes("{{HEADER_IMAGE}}");
      const bodyTemplate = isStale ? DEFAULT_CERT_HTML : template.htmlBody;

      if (isStale) {
        mysqlPool.query("UPDATE warranty_template SET htmlBody=?, headerHtml=NULL WHERE id=1", [DEFAULT_CERT_HTML]).catch(() => {});
      }

      const bodyHtml = renderTemplate(bodyTemplate, template, order);

      // Header image always goes first, body always follows — no {{HEADER_IMAGE}} placeholder needed
      html = headerImgUrl
        ? `<div style="margin:0;padding:0;line-height:0;font-size:0;width:100%;display:block;">`
          + `<img src="${headerImgUrl}" style="display:block;width:100%;height:auto;border:0;" />`
          + `</div>${bodyHtml}`
        : bodyHtml;
    }

    res.json({ orderData: order, html, certGuid, certStatus });
  } catch (err) {
    console.error("[warranty] GET /generate:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

// ── GET /api/warranty/generate-docx/:orderGuid ───────────────────────────────
// Fill the stored DOCX template with order data and return the filled .docx file.
router.get("/generate-docx/:orderGuid", async (req, res) => {
  try {
    const { orderGuid } = req.params;

    // Load template binary
    const [tplRows] = await mysqlPool.query(
      "SELECT docxBinary, docxFileName, headerImagePath FROM warranty_template WHERE id=1"
    );
    if (!tplRows[0]?.docxBinary) {
      return res.status(404).json({ message: "No DOCX template configured. Upload a template in Warranty Template Master." });
    }

    // Fetch order + first serial
    const [orderRows] = await mysqlPool.query(`
      SELECT
        o.guid AS orderGuid, o.orderid AS orderNumber,
        o.orderDate, o.dispatchDate, o.platform, o.gemOrderType, o.bidNumber,
        o.customerName AS customer, o.consigneeName,
        o.shippingAddress, o.address, o.buyerAddress,
        o.contactNumber, o.invoiceNumber, o.gstNumber,
        oi.sellingPrice, oi.warranty, oi.quantity,
        s.value AS serialValue, m.name AS modelName, m.company AS companyName
      FROM orders o
      LEFT JOIN order_items oi ON oi.orderGuid = o.guid
      LEFT JOIN serials s      ON oi.serialNumberGuid = s.guid
      LEFT JOIN models m       ON s.modelGuid = m.guid
      WHERE o.guid = ? LIMIT 1
    `, [orderGuid]);
    if (!orderRows.length) return res.status(404).json({ message: "Order not found" });
    const order = orderRows[0];

    // All serials
    const [allSerialRows] = await mysqlPool.query(`
      SELECT s.value FROM order_items oi
      LEFT JOIN serials s ON oi.serialNumberGuid = s.guid
      WHERE oi.orderGuid = ? AND s.value IS NOT NULL ORDER BY s.value
    `, [orderGuid]);
    order.allSerials  = allSerialRows.map(r => r.value).join(", ");
    order.serialCount = allSerialRows.length || order.quantity || 1;

    // Build render data — comprehensive mapping covering common naming conventions
    const warrantyPeriod = order.warranty || "1 Year";
    const fmt = d => d ? new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "2-digit", year: "numeric" }) : "";
    const address = [
      order.consigneeName || order.customer || "",
      order.shippingAddress || order.address || order.buyerAddress || "",
    ].filter(Boolean).join("\n");

    const fields = {
      GEM_NUMBER:            order.bidNumber    || order.orderNumber || "",
      TO_ADDRESS:            address,
      INVOICE_NUMBER:        order.invoiceNumber || "",
      PRODUCT_NAME:          order.modelName    || "",
      SERIAL_NUMBERS:        order.allSerials   || order.serialValue || "",
      SERIAL_NUMBERS_COUNTS: String(order.serialCount || order.quantity || ""),
      DATE:                  fmt(order.orderDate),
      DISPATCH_DATE:         fmt(order.dispatchDate || order.orderDate),
      WARRANTY_PERIOD:       warrantyPeriod,
      QUANTITY:              String(order.quantity || order.serialCount || ""),
      COMPANY_NAME:          order.companyName  || "",
      CUSTOMER_NAME:         order.customer     || order.consigneeName || "",
      CONSIGNEE_NAME:        order.consigneeName || order.customer    || "",
      MODEL_NAME:            order.modelName    || "",
      BID_NUMBER:            order.bidNumber    || order.orderNumber  || "",
      CONTRACT_NO:           order.bidNumber    || order.orderNumber  || "",
      ORDER_NUMBER:          String(order.orderNumber || ""),
    };

    // Include lowercase variants so both {GEM_NUMBER} and {gem_number} work
    const renderData = {};
    for (const [k, v] of Object.entries(fields)) {
      renderData[k]             = v;
      renderData[k.toLowerCase()] = v;
    }

    // Fill with docxtemplater (preserves all DOCX formatting / letterhead)
    const PizZip        = require("pizzip");
    const Docxtemplater = require("docxtemplater");

    const zip = new PizZip(tplRows[0].docxBinary);
    const doc = new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks:    true,
      nullGetter:    () => "",   // unknown tags → empty string, no throw
    });
    doc.render(renderData);

    let buffer = doc.getZip().generate({ type: "nodebuffer", compression: "DEFLATE" });

    // Resolve OOXML theme colors → direct hex so mammoth renders colored backgrounds correctly
    try {
      const AdmZip = require("adm-zip");
      const az = new AdmZip(buffer);
      const themeColors = parseThemeColors(az);
      if (Object.keys(themeColors).length > 0) {
        console.log("[warranty] Theme colors found:", themeColors);
        const resolveEntry = (name) => {
          const entry = az.getEntry(name);
          if (!entry) return;
          az.updateFile(name, Buffer.from(resolveThemeColorsInXml(az.readAsText(entry), themeColors), "utf8"));
        };
        resolveEntry("word/document.xml");
        resolveEntry("word/styles.xml");
        buffer = az.toBuffer();
      }
    } catch (themeErr) {
      console.warn("[warranty] Theme color resolution skipped:", themeErr.message);
    }

    // Convert filled DOCX → HTML with mammoth (preserves colors, table fills, images as base64)
    const htmlResult = await mammoth.convertToHtml(
      { buffer },
      {
        convertImage: mammoth.images.imgElement(async (image) => {
          const buf = await image.read("base64");
          return { src: `data:${image.contentType};base64,${buf}` };
        }),
      }
    );

    let previewHtml = htmlResult.value || "";

    // Prepend header image if one is saved — convert to base64 so iframe works without cross-origin issues
    if (tplRows[0].headerImagePath) {
      try {
        const imgPath = path.resolve(__dirname, "../uploads", tplRows[0].headerImagePath);
        if (fs.existsSync(imgPath)) {
          const imgBuf  = fs.readFileSync(imgPath);
          const ext     = path.extname(tplRows[0].headerImagePath).toLowerCase().slice(1);
          const mime    = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "png" ? "image/png" : `image/${ext}`;
          const imgSrc  = `data:${mime};base64,${imgBuf.toString("base64")}`;
          previewHtml   = `<div style="line-height:0;padding:0;margin:0 0 0 0;"><img src="${imgSrc}" style="max-width:100%;width:100%;height:auto;display:block;" /></div>${previewHtml}`;
        }
      } catch (imgErr) {
        console.warn("[warranty] Could not prepend header image:", imgErr.message);
      }
    }

    res.json({
      docxBase64:  buffer.toString("base64"),
      previewHtml,
      fileName:    `warranty-${String(order.orderNumber || orderGuid).replace(/[^a-zA-Z0-9-_]/g, "")}.docx`,
    });
  } catch (err) {
    console.error("[warranty] GET /generate-docx:", err);
    res.status(500).json({ message: err.message || "An internal server error occurred." });
  }
});

// ── POST /api/warranty/certificates ──────────────────────────────────────────
router.post("/certificates", async (req, res) => {
  try {
    const { orderGuid, orderNumber, htmlContent, status, certGuid } = req.body;
    const createdBy = req.user?.username || "unknown";

    if (certGuid) {
      await mysqlPool.query(
        "UPDATE wc_certs SET htmlContent=?, status=?, updatedAt=NOW() WHERE guid=?",
        [htmlContent, status || "draft", certGuid]
      );
      res.json({ message: "Certificate saved", guid: certGuid });
    } else {
      const newGuid = uuidv4();
      await mysqlPool.query(
        "INSERT INTO wc_certs (guid, orderGuid, orderNumber, htmlContent, status, createdBy) VALUES (?,?,?,?,?,?)",
        [newGuid, orderGuid, orderNumber, htmlContent, status || "draft", createdBy]
      );
      res.json({ message: "Certificate created", guid: newGuid });
    }
    await logUserActivity(mysqlPool, req.user, "Save Warranty Certificate", [{ field: "orderGuid", newValue: orderGuid }], req.ip);
  } catch (err) {
    console.error("[warranty] POST /certificates:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

// ── GET /api/warranty/certificates ───────────────────────────────────────────
router.get("/certificates", async (req, res) => {
  try {
    const [rows] = await mysqlPool.query(`
      SELECT
        wc.guid, wc.orderGuid, wc.orderNumber,
        wc.status, wc.createdBy, wc.createdAt, wc.updatedAt,
        o.customerName AS customerName,
        o.platform,
        o.gemOrderType
      FROM wc_certs wc
      LEFT JOIN orders o ON wc.orderGuid = o.guid
      ORDER BY wc.updatedAt DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error("[warranty] GET /certificates:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

// ── GET /api/warranty/certificates/:guid ─────────────────────────────────────
router.get("/certificates/:guid", async (req, res) => {
  try {
    const [rows] = await mysqlPool.query("SELECT * FROM wc_certs WHERE guid=?", [req.params.guid]);
    if (!rows.length) return res.status(404).json({ message: "Not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error("[warranty] GET /certificates/:guid:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

// ── DELETE /api/warranty/certificates/:guid ───────────────────────────────────
router.delete("/certificates/:guid", async (req, res) => {
  try {
    await mysqlPool.query("DELETE FROM wc_certs WHERE guid=?", [req.params.guid]);
    res.json({ message: "Deleted" });
  } catch (err) {
    console.error("[warranty] DELETE /certificates/:guid:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

// ── GET /api/warranty/email-preview/:orderGuid ───────────────────────────────
// Returns rendered email subject/body/to/cc/bcc for a given order
router.get("/email-preview/:orderGuid", async (req, res) => {
  try {
    const { orderGuid } = req.params;

    // Fetch order data (same query as generate)
    const [orderRows] = await mysqlPool.query(`
      SELECT
        o.guid AS orderGuid, o.orderid AS orderNumber,
        o.orderDate, o.dispatchDate,
        o.platform, o.gemOrderType, o.bidNumber,
        o.customerName AS customer, o.consigneeName,
        o.shippingAddress, o.address, o.buyerAddress,
        o.contactNumber, o.altContactNumber,
        o.invoiceNumber, o.gstNumber,
        oi.sellingPrice, oi.warranty, oi.quantity,
        s.value AS serialValue,
        m.name  AS modelName, m.company AS companyName
      FROM orders o
      LEFT JOIN order_items oi ON oi.orderGuid = o.guid
      LEFT JOIN serials s      ON oi.serialNumberGuid = s.guid
      LEFT JOIN models m       ON s.modelGuid = m.guid
      WHERE o.guid = ?
      LIMIT 1
    `, [orderGuid]);

    if (!orderRows.length) return res.status(404).json({ message: "Order not found" });
    const order = orderRows[0];

    // All serial numbers
    const [allSerialRows] = await mysqlPool.query(`
      SELECT s.value FROM order_items oi
      LEFT JOIN serials s ON oi.serialNumberGuid = s.guid
      WHERE oi.orderGuid = ? AND s.value IS NOT NULL ORDER BY s.value
    `, [orderGuid]);
    order.allSerials  = allSerialRows.map(r => r.value).join(", ");
    order.serialCount = allSerialRows.length || order.quantity || 1;

    // Fetch email template
    const [tplRows] = await mysqlPool.query("SELECT * FROM warranty_template WHERE id=1");
    const template = tplRows[0] || {};

    // Build placeholder values
    const wp  = order.warranty || "1 Year";
    const fmt = (d) => d ? new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "2-digit", year: "numeric" }) : "";
    let expiry = "";
    try {
      const base  = new Date(order.dispatchDate || order.orderDate || Date.now());
      const num   = parseInt(wp) || 1;
      const isMon = /month/i.test(wp);
      if (isMon) { base.setMonth(base.getMonth() + num); } else { base.setFullYear(base.getFullYear() + num); }
      expiry = fmt(base);
    } catch (_) {}

    const gem = order.bidNumber || order.orderNumber || order.invoiceNumber || "";
    const emailVars = {
      "{{COMPANY_NAME}}":    template.companyName   || "",
      "{{GEM_NUMBER}}":      gem,
      "{{BID_NUMBER}}":      gem,
      "{{ORDER_NUMBER}}":    String(order.orderNumber || ""),
      "{{INVOICE_NUMBER}}":  order.invoiceNumber    || "",
      "{{CUSTOMER_NAME}}":   order.customer         || order.consigneeName || "",
      "{{CONSIGNEE_NAME}}":  order.consigneeName    || order.customer      || "",
      "{{ADDRESS}}":         (order.shippingAddress || order.address || order.buyerAddress || "").replace(/\n/g, " "),
      "{{CONTACT_NUMBER}}":  order.contactNumber    || "",
      "{{MODEL_NAME}}":      order.modelName        || "",
      "{{SERIAL_NUMBER}}":   order.serialValue      || "",
      "{{SERIAL_NUMBERS}}":  order.allSerials       || order.serialValue  || "",
      "{{QUANTITY}}":        String(order.serialCount || order.quantity   || ""),
      "{{PURCHASE_DATE}}":   fmt(order.orderDate),
      "{{DISPATCH_DATE}}":   fmt(order.dispatchDate) || fmt(order.orderDate),
      "{{WARRANTY_PERIOD}}": wp,
      "{{WARRANTY_EXPIRY}}": expiry,
      "{{GST_NUMBER}}":      order.gstNumber        || "",
      "{{CERT_NUMBER}}":     "WC-" + String(order.orderNumber || "").padStart(6, "0"),
    };

    const fillText = (text) => {
      if (!text) return "";
      let out = text;
      for (const [k, v] of Object.entries(emailVars)) {
        out = out.split(k).join(v || "");
      }
      return out;
    };

    res.json({
      to:      template.emailTo  || "",
      cc:      template.emailCc  || "",
      bcc:     template.emailBcc || "",
      subject: fillText(template.emailSubject || ""),
      body:    fillText(template.emailBody    || ""),
    });
  } catch (err) {
    console.error("[warranty] GET /email-preview:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

// ── POST /api/warranty/send-email ─────────────────────────────────────────────
// Sends warranty email for an order via SMTP
router.post("/send-email", async (req, res) => {
  try {
    const { to, cc, bcc, subject, body, attachments } = req.body;
    if (!to) return res.status(400).json({ message: "\"To\" email is required" });
    if (!subject) return res.status(400).json({ message: "Subject is required" });
    const validEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s).trim());
    if (!validEmail(to)) return res.status(400).json({ message: "Invalid \"To\" email address" });
    if (cc && !cc.split(",").every(e => validEmail(e.trim()))) return res.status(400).json({ message: "Invalid CC email address" });
    if (bcc && !bcc.split(",").every(e => validEmail(e.trim()))) return res.status(400).json({ message: "Invalid BCC email address" });

    const { sendWarrantyEmail } = require("../utils/mailer");
    await sendWarrantyEmail({ to, cc, bcc, subject, body, attachments });

    await logUserActivity(mysqlPool, req.user, "Send Warranty Email", [{ to, subject }], req.ip);
    res.json({ message: "Email sent successfully" });
  } catch (err) {
    console.error("[warranty] POST /send-email:", err);
    res.status(500).json({ message: err.message || "Failed to send email" });
  }
});

module.exports = router;
