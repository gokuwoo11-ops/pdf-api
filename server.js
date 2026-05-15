const express = require("express");
const puppeteer = require("puppeteer");

const app = express();

// IMPORTANT: allow large HTML input
app.use(express.json({ limit: "20mb" }));

app.post("/generate-pdf", async (req, res) => {
  let browser;

  try {
    const { html } = req.body;

    if (!html) {
      return res.status(400).json({
        success: false,
        error: "Missing 'html' in request body"
      });
    }

    browser = await puppeteer.launch({
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    const page = await browser.newPage();

    await page.setContent(html, {
      waitUntil: "networkidle0"
    });

    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true
    });

    await browser.close();

    // 🔥 FIX: convert PDF to base64 (works in workflows)
    const pdfBase64 = pdfBuffer.toString("base64");

    return res.json({
      success: true,
      pdf: pdfBase64
    });

  } catch (err) {
    if (browser) await browser.close();

    return res.status(500).json({
      success: false,
      error: err.toString()
    });
  }
});

// Health check route (IMPORTANT for Render)
app.get("/", (req, res) => {
  res.send("PDF API is running 🚀");
});

// Use Render port (VERY IMPORTANT)
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`PDF API running on port ${PORT}`);
});