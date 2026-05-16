const express = require("express");
const puppeteer = require("puppeteer-core");
const chromium = require("@sparticuz/chromium");
const path = require("path");
const fs = require("fs");

const app = express();

// ── Body parsers ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: "50mb" }));
app.use(express.text({ type: "*/*", limit: "50mb" }));

// ── JSON parse error handler (shows real error instead of "Bad Request" page) ─
app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({
      success: false,
      error: "Invalid JSON — HTML characters broke the body",
      detail: err.message
    });
  }
  next(err);
});

// ── Static file serving ───────────────────────────────────────────────────────
app.use("/files", express.static(path.join(__dirname, "public")));

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.send("PDF API is running");
});

// ── Main PDF route ────────────────────────────────────────────────────────────
app.post("/generate-pdf", async (req, res) => {
  let browser;

  try {
    console.log("=== REQUEST ARRIVED ===");
    console.log("Content-Type:", req.headers["content-type"]);
    console.log("Body type:", typeof req.body);

    // ── Extract HTML from whatever shape the body arrives in ─────────────────
    let html;

    if (typeof req.body === "string") {
      // Arrived as plain text — try parsing as JSON first
      try {
        const parsed = JSON.parse(req.body);
        html = parsed.html || parsed.answer || parsed.source;
      } catch {
        // Not JSON — treat the whole string as raw HTML
        html = req.body;
      }
    } else {
      // Arrived as a parsed JSON object
      html = req.body.html || req.body.answer || req.body.source;
    }

    // ── Handle double-stringified HTML from Relevance AI JS step ─────────────
    // JSON.stringify() in the code step wraps the value in extra quotes
    // e.g.  "\"<html>...</html>\""  →  unwrap it
    if (typeof html === "string" && html.startsWith('"') && html.endsWith('"')) {
      try {
        html = JSON.parse(html);
      } catch {
        // Already a plain string — use as is
      }
    }

    // ── Nested object fallback ────────────────────────────────────────────────
    if (html && typeof html === "object" && html.answer) {
      html = html.answer;
    }

    // ── Validate ──────────────────────────────────────────────────────────────
    if (!html || typeof html !== "string") {
      console.log("ERROR: No HTML found. Body was:", JSON.stringify(req.body).slice(0, 300));
      return res.status(400).json({
        success: false,
        error: "Missing html field",
        body_type: typeof req.body,
        body_keys: typeof req.body === "object" ? Object.keys(req.body) : "n/a"
      });
    }

    console.log("HTML received — length:", html.length, "chars");

    // ── Launch Puppeteer ──────────────────────────────────────────────────────
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless
    });

    const page = await browser.newPage();

    // Prevent the page from hanging forever
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(30000);

    // Load HTML — domcontentloaded is fast and doesn't wait for broken images
    await page.setContent(html, {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });

    // ── Generate PDF ──────────────────────────────────────────────────────────
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: {
        top: "20px",
        bottom: "20px",
        left: "20px",
        right: "20px"
      }
    });

    await browser.close();
    browser = null;

    // ── Save PDF to /public folder ────────────────────────────────────────────
    const publicDir = path.join(__dirname, "public");
    fs.mkdirSync(publicDir, { recursive: true });

    const fileName = `report-${Date.now()}.pdf`;
    const filePath = path.join(publicDir, fileName);
    fs.writeFileSync(filePath, pdf);

    const pdfUrl = `${req.protocol}://${req.get("host")}/files/${fileName}`;

    console.log("PDF saved:", pdfUrl);

    return res.json({
      success: true,
      url: pdfUrl
    });

  } catch (error) {
    console.error("PDF ERROR:", error.message);

    if (browser) {
      try { await browser.close(); } catch {}
    }

    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ── Start server ──────────────────────────────────────────────────────────────
app.listen(process.env.PORT || 3000, () => {
  console.log("Server running on port", process.env.PORT || 3000);
});