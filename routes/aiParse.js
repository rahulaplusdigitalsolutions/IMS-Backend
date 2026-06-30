const router = require("express").Router();
const https  = require("https");
const pdfParse = require("pdf-parse");

const EXTRACTION_PROMPT = `You are an order-data extractor for an Indian inventory system.
Extract the following fields from the provided order text/document and return ONLY a valid JSON object.
If a field is not found, return null for that field.

Fields to extract:
- platform: one of "GeM", "Amazon", "Flipkart", "Other" (guess from context)
- orderId: Order ID / customer name / GeM order number (the main identifier)
- gemOrderType: one of "Direct Order", "Bid", "PBP" (default "Direct Order")
- gemBidNo: Bid number / contract number / GeM order number
- gemOrderDate: Order date in YYYY-MM-DD format
- gemLastDate: Last delivery date / supply date in YYYY-MM-DD format
- gemAddress: Consignee / delivery / shipping address (full multi-line is fine)
- gemBuyerAddress: Buyer address if different from shipping
- consigneeName: Consignee / delivery person / organization name
- gemGst: GST number of buyer/consignee
- gemContact: Contact / phone number
- gemAltContact: Alternate contact number
- gemBuyerEmail: Buyer email
- gemConsigneeEmail: Consignee email
- paymentAuthorityEmail: Payment authority email
- invoiceNo: Invoice number
- invoiceDate: Invoice date in YYYY-MM-DD format
- invoiceGst: Seller GST number
- warranty: Warranty period e.g. "1 Year", "3 Years"
- modelName: Product model name / part number
- companyName: Manufacturer / brand name (e.g. HP, Dell, Canon)
- sellingPrice: Unit price as a number (no currency symbol)
- quantity: Quantity as a number

Return ONLY JSON, no markdown, no explanation.`;

function openAiRequest(body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.openai.com",
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Length": Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => { data += chunk; });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message));
          const content = parsed.choices?.[0]?.message?.content || "{}";
          const cleaned = content.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
          resolve(JSON.parse(cleaned));
        } catch (e) {
          reject(new Error("Failed to parse OpenAI response: " + e.message));
        }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function callOpenAI(userText) {
  const body = JSON.stringify({
    model: "gpt-4o-mini",
    temperature: 0,
    messages: [
      { role: "system", content: EXTRACTION_PROMPT },
      { role: "user", content: userText }
    ]
  });
  return openAiRequest(body);
}

function callOpenAIVision(base64, mimeType) {
  const body = JSON.stringify({
    model: "gpt-4o-mini",
    temperature: 0,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: EXTRACTION_PROMPT },
          { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}`, detail: "high" } }
        ]
      }
    ]
  });
  return openAiRequest(body);
}

function checkKey() {
  return process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== "REPLACE_WITH_NEW_KEY";
}

// POST /api/ai/parse-order  — parse plain text
router.post("/parse-order", async (req, res) => {
  try {
    if (!checkKey()) return res.status(503).json({ message: "OpenAI API key not configured. Add OPENAI_API_KEY to .env" });
    const { text } = req.body;
    if (!text?.trim()) return res.status(400).json({ message: "No text provided" });
    const result = await callOpenAI(text.trim());
    res.json(result);
  } catch (err) {
    console.error("[ai] parse-order error:", err.message);
    res.status(500).json({ message: err.message || "AI parsing failed" });
  }
});

// POST /api/ai/parse-file  — parse uploaded PDF or image
router.post("/parse-file", async (req, res) => {
  try {
    if (!checkKey()) return res.status(503).json({ message: "OpenAI API key not configured. Add OPENAI_API_KEY to .env" });
    const { fileBase64, mimeType } = req.body;
    if (!fileBase64 || !mimeType) return res.status(400).json({ message: "fileBase64 and mimeType are required" });

    let result;

    if (mimeType === "application/pdf") {
      const buffer = Buffer.from(fileBase64, "base64");
      if (buffer.length > 15 * 1024 * 1024) {
        return res.status(413).json({ message: "File too large (max 15 MB)" });
      }
      const pdfData = await pdfParse(buffer);
      const text = (pdfData.text || "").trim();
      if (!text) return res.status(422).json({ message: "Could not extract text from PDF — it may be a scanned image PDF. Try uploading as JPG/PNG." });
      result = await callOpenAI(text);
    } else if (mimeType.startsWith("image/")) {
      result = await callOpenAIVision(fileBase64, mimeType);
    } else {
      return res.status(400).json({ message: "Unsupported file type. Upload a PDF or image (JPG, PNG, WebP)." });
    }

    res.json(result);
  } catch (err) {
    console.error("[ai] parse-file error:", err.stack || err.message);
    res.status(500).json({ message: err.message || "AI file parsing failed" });
  }
});

module.exports = router;
