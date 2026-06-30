const router = require("express").Router();
const { mysqlPool } = require("../db");
const { requireAuth } = require("../middleware/auth");

router.use(requireAuth);

router.get("/", async (req, res) => {
  try {
    const [tags] = await mysqlPool.query("SELECT * FROM inventorytags");
    res.json({ printer: tags.filter((t) => t.module === "printer"), stationery: tags.filter((t) => t.module === "stationery") });
  } catch (err) {
    console.error("[tags] GET /:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

router.post("/", async (req, res) => {
  try {
    const { tagName, tagColor, module } = req.body;
    if (!tagName || !tagColor) return res.status(400).json({ message: "tagName and tagColor are required" });
    await mysqlPool.query("INSERT INTO inventorytags (tagName, tagColor, module) VALUES (?,?,?)", [tagName, tagColor, module || "printer"]);
    res.json({ message: "Tag created successfully" });
  } catch (err) {
    console.error("[tags] POST /:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    await mysqlPool.query("DELETE FROM inventorytags WHERE id=?", [req.params.id]);
    res.json({ message: "Tag deleted successfully" });
  } catch (err) {
    console.error("[tags] DELETE /:id:", err);
    res.status(500).json({ message: "An internal server error occurred." });
  }
});

module.exports = router;
