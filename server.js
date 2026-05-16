const express = require("express");
const puppeteer = require("puppeteer-core");
const chromium = require("@sparticuz/chromium");
const path = require("path");
const fs = require("fs");
const axios = require("axios");

const app = express();

app.use(express.json({ limit: "50mb" }));
app.use(express.text({ type: "*/*", limit: "50mb" }));

app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({
      success: false,
      error: "Invalid JSON body",
      detail: err.message
    });
  }
  next(err);
});

app.use("/files", express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.send("PDF API is running");
});

// ── Fetch one image from Pexels and return as base64 ─────────────────────────
async function fetchImageAsBase64(searchQuery) {
  try {
    const apiKey = process.env.PEXELS_API_KEY;
    if (!apiKey) {
      console.log("No PEXELS_API_KEY set");
      return null;
    }

    const searchRes = await axios.get("https://api.pexels.com/v1/search", {
      headers: { Authorization: apiKey },
      params: { query: searchQuery, per_page: 1, orientation: "landscape" },
      timeout: 8000
    });

    const photos = searchRes.data.photos;
    if (!photos || photos.length === 0) {
      console.log("No photo found for:", searchQuery);
      return null;
    }

    const imageUrl = photos[0].src.large;
    console.log("Downloading:", searchQuery, "→", imageUrl);

    const imgRes = await axios.get(imageUrl, {
      responseType: "arraybuffer",
      timeout: 10000
    });

    const base64 = Buffer.from(imgRes.data).toString("base64");
    const mime = imgRes.headers["content-type"] || "image/jpeg";
    return `data:${mime};base64,${base64}`;

  } catch (err) {
    console.log("Image fetch failed:", searchQuery, "→", err.message);
    return null;
  }
}

// ── Find all [IMG:keywords] in HTML and replace with real images ──────────────
async function embedImages(html) {
  // Find every [IMG:something] pattern
  const pattern = /\[IMG:([^\]]+)\]/g;
  const matches = [...html.matchAll(pattern)];

  if (matches.length === 0) {
    console.log("No [IMG:...] placeholders found in HTML");
    return html;
  }

  console.log(`Found ${matches.length} image placeholders`);

  // Fetch all images at the same time (parallel = fast)
  const fetches = matches.map(async (match) => {
    const fullMatch = match[0];       // e.g. [IMG:badminton player smashing]
    const keywords = match[1].trim(); // e.g. badminton player smashing
    const base64 = await fetchImageAsBase64(keywords);
    return { fullMatch, keywords, base64 };
  });

  const results = await Promise.all(fetches);

  // Replace each placeholder in the HTML
  let updatedHtml = html;
  for (const { fullMatch, keywords, base64 } of results) {
    if (base64) {
      // Replace with a real embedded image
      const imgTag = `
        <img 
          src="${base64}" 
          alt="${keywords}"
          style="width:100%;height:220px;object-fit:cover;
                 border-radius:12px;margin:16px 0;display:block;"
        />`;
      updatedHtml = updatedHtml.split(fullMatch).join(imgTag);
      console.log("✓ Image embedded:", keywords);
    } else {
      // Fallback gradient if Pexels fails
      const gradient = `
        <div style="
          width:100%;height:220px;
          background:linear-gradient(135deg,#1a73e8,#0d47a1);
          border-radius:12px;margin:16px 0;
          display:flex;align-items:center;justify-content:center;
        ">
          <span style="color:white;font-size:18px;font-weight:bold;">
            ${keywords}
          </span>
        </div>`;
      updatedHtml = updatedHtml.split(fullMatch).join(gradient);
      console.log("✗ Used gradient fallback:", keywords);
    }
  }

  return updatedHtml;
}

// ── Main PDF route ────────────────────────────────────────────────────────────
app.post("/generate-pdf", async (req, res) => {
  let browser;

  try {
    console.log("=== REQUEST ARRIVED ===");
    console.log("Content-Type:", req.headers["content-type"]);

    // ── Extract HTML ──────────────────────────────────────────────────────────
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

    // Unwrap double-stringified HTML from Relevance AI JS step
    if (typeof html === "string" && html.startsWith('"') && html.endsWith('"')) {
      try { html = JSON.parse(html); } catch {}
    }

    if (html && typeof html === "object" && html.answer) {
      html = html.answer;
    }

    if (!html || typeof html !== "string") {
      return res.status(400).json({
        success: false,
        error: "Missing html field",
        body_type: typeof req.body,
        body_keys: typeof req.body === "object" ? Object.keys(req.body) : "n/a"
      });
    }

    console.log("HTML length:", html.length, "chars");

    // ── Replace [IMG:...] placeholders with real Pexels images ───────────────
    console.log("Fetching images from Pexels...");
    html = await embedImages(html);
    console.log("Images done. Starting Puppeteer...");

    // ── Generate PDF ──────────────────────────────────────────────────────────
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(30000);

    await page.setContent(html, {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });

    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "20px", bottom: "20px", left: "20px", right: "20px" }
    });

    await browser.close();
    browser = null;

    // ── Save and return URL ───────────────────────────────────────────────────
    const publicDir = path.join(__dirname, "public");
    fs.mkdirSync(publicDir, { recursive: true });

    const fileName = `report-${Date.now()}.pdf`;
    const filePath = path.join(publicDir, fileName);
    fs.writeFileSync(filePath, pdf);

    const pdfUrl = `${req.protocol}://${req.get("host")}/files/${fileName}`;
    console.log("PDF ready:", pdfUrl);

    return res.json({ success: true, url: pdfUrl });

  } catch (error) {
    console.error("PDF ERROR:", error.message);
    if (browser) {
      try { await browser.close(); } catch {}
    }
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running on port", process.env.PORT || 3000);
});