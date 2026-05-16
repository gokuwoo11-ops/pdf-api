const express = require("express");
const puppeteer = require("puppeteer-core");
const chromium = require("@sparticuz/chromium");

const app = express();

app.use(express.json({ limit: "20mb" }));

app.post("/generate-pdf", async (req, res) => {
  let browser;

  try {
    const { html } = req.body;

    if (!html) {
      return res.status(400).json({
        success: false,
        error: "Missing html in request body"
      });
    }

    browser = await puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless
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

// health check (Render needs this)
app.get("/", (req, res) => {
  res.send("PDF API running 🚀");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});