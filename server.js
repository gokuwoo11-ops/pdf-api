const express = require("express");
const puppeteer = require("puppeteer-core");
const chromium = require("@sparticuz/chromium");
const path = require("path");
const fs = require("fs");

const app = express();

app.use(express.json({ limit: "50mb" }));

// Public PDF access
app.use("/files", express.static(path.join(__dirname, "public")));

// Health route
app.get("/", (req, res) => {
  res.send("PDF API is running");
});

// Main PDF route
app.post("/generate-pdf", async (req, res) => {

  let browser;

  try {

    console.log("BODY RECEIVED:");
    console.log(JSON.stringify(req.body, null, 2));

    let html = req.body.html;

    // Relevance AI sometimes sends nested object
    if (html && typeof html === "object" && html.answer) {
      html = html.answer;
    }

    // Fallbacks
    if (!html && req.body.answer) {
      html = req.body.answer;
    }

    if (!html && req.body.source) {
      html = req.body.source;
    }

    // Validation
    if (!html || typeof html !== "string") {

      return res.status(400).json({
        success: false,
        error: "Missing html field",
        received_body: req.body
      });

    }

    // Launch browser
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless
    });

    const page = await browser.newPage();

    // Load HTML
    await page.setContent(html, {
      waitUntil: "networkidle0",
      timeout: 60000
    });

    // Generate PDF
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true
    });

    // Close browser
    await browser.close();

    // Create public folder
    const publicDir = path.join(__dirname, "public");

    fs.mkdirSync(publicDir, {
      recursive: true
    });

    // File name
    const fileName = `report-${Date.now()}.pdf`;

    const filePath = path.join(publicDir, fileName);

    // Save PDF
    fs.writeFileSync(filePath, pdf);

    // Public URL
    const pdfUrl =
      `${req.protocol}://${req.get("host")}/files/${fileName}`;

    // Final response
    res.json({
      success: true,
      url: pdfUrl
    });

  } catch (error) {

    console.error("PDF ERROR:");
    console.error(error);

    if (browser) {
      await browser.close();
    }

    res.status(500).json({
      success: false,
      error: error.message
    });

  }

});

// Start server
app.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});