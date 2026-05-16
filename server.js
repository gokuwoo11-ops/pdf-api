const express = require("express");
const puppeteer = require("puppeteer-core");
const chromium = require("@sparticuz/chromium");
const path = require("path");
const fs = require("fs");

const app = express();

app.use(express.json({ limit: "50mb" }));
app.use(express.text({ type: "*/*", limit: "50mb" }));

app.use("/files", express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.send("PDF API is running");
});

app.post("/generate-pdf", async (req, res) => {
  let browser;

  try {
    console.log("BODY RECEIVED:", req.body);

    let html;

    if (typeof req.body === "string") {
      try {
        const parsed = JSON.parse(req.body);
        html = parsed.html || parsed.answer || parsed.source;
      } catch {
        html = req.body;
      }
    } else {
      html = req.body.html || req.body.answer || req.body.source;
    }

    if (html && typeof html === "object" && html.answer) {
      html = html.answer;
    }

    if (!html || typeof html !== "string") {
      return res.status(400).json({
        success: false,
        error: "Missing html field",
        received_body: req.body
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

    const publicDir = path.join(__dirname, "public");
    fs.mkdirSync(publicDir, { recursive: true });

    const fileName = `report-${Date.now()}.pdf`;
    const filePath = path.join(publicDir, fileName);

    fs.writeFileSync(filePath, pdf);

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

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});