const express = require("express");
const puppeteer = require("puppeteer-core");
const chromium = require("@sparticuz/chromium");
const path = require("path");
const fs = require("fs");

const app = express();

app.use(express.json({ limit: "20mb" }));

// This makes generated PDFs accessible as public links
app.use("/files", express.static(path.join(__dirname, "public")));

app.post("/generate-pdf", async (req, res) => {
  let browser;

  try {
    const { html } = req.body;

    if (!html || typeof html !== "string") {
      return res.status(400).json({
        success: false,
        error: "Missing html field. Send JSON like: { html: '<html>...</html>' }"
      });
    }

    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless
    });

    const page = await browser.newPage();

    await page.setContent(html, {
      waitUntil: "networkidle0",
      timeout: 60000
    });

    const pdf = await page.pdf({
      format: "A4",
      printBackground: true
    });

    await browser.close();

    // Save PDF file
    const publicDir = path.join(__dirname, "public");
    fs.mkdirSync(publicDir, { recursive: true });

    const fileName = `report-${Date.now()}.pdf`;
    const filePath = path.join(publicDir, fileName);

    fs.writeFileSync(filePath, pdf);

    // Return PDF link
    const pdfUrl = `${req.protocol}://${req.get("host")}/files/${fileName}`;

    res.json({
      success: true,
      url: pdfUrl
    });

  } catch (error) {
    console.error("PDF ERROR:", error);

    if (browser) {
      await browser.close();
    }

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get("/", (req, res) => {
  res.send("PDF API is running");
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});