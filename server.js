const express = require("express");
const puppeteer = require("puppeteer-core");
const chromium = require("@sparticuz/chromium");
const path = require("path");
const fs = require("fs");
const axios = require("axios");

const app = express();

app.use(express.json({ limit: "50mb" }));
app.use(express.text({ type: "*/*", limit: "50mb" }));

// JSON parse error handler
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

// ── Fetch image from Pexels and return as base64 ──────────────────────────────
async function fetchImageAsBase64(searchQuery) {
  try {
    const apiKey = process.env.PEXELS_API_KEY;
    if (!apiKey) {
      console.log("No Pexels API key found");
      return null;
    }

    // Search Pexels for the query
    const searchResponse = await axios.get(
      "https://api.pexels.com/v1/search",
      {
        headers: { Authorization: apiKey },
        params: {
          query: searchQuery,
          per_page: 1,
          orientation: "landscape"
        },
        timeout: 8000
      }
    );

    const photos = searchResponse.data.photos;
    if (!photos || photos.length === 0) {
      console.log("No photos found for:", searchQuery);
      return null;
    }

    // Get the medium-sized image URL
    const imageUrl = photos[0].src.large;
    console.log("Fetching image for:", searchQuery, "→", imageUrl);

    // Download the image
    const imageResponse = await axios.get(imageUrl, {
      responseType: "arraybuffer",
      timeout: 10000
    });

    // Convert to base64
    const base64 = Buffer.from(imageResponse.data).toString("base64");
    const mimeType = imageResponse.headers["content-type"] || "image/jpeg";

    return `data:${mimeType};base64,${base64}`;

  } catch (error) {
    console.log("Image fetch failed for:", searchQuery, "→", error.message);
    return null;
  }
}

// ── Replace all data-search images in HTML with real base64 images ────────────
async function embedRealImages(html) {
  // Find all <img> tags that have a data-search attribute
  const imgRegex = /<img[^>]*data-search="([^"]*)"[^>]*>/gi;
  const matches = [...html.matchAll(imgRegex)];

  if (matches.length === 0) {
    console.log("No data-search images found in HTML");
    return html;
  }

  console.log(`Found ${matches.length} images to fetch`);

  // Fetch all images at the same time (parallel = fast)
  const fetchPromises = matches.map(async (match) => {
    const fullTag = match[0];
    const searchQuery = match[1];
    const base64Src = await fetchImageAsBase64(searchQuery);
    return { fullTag, searchQuery, base64Src };
  });

  const results = await Promise.all(fetchPromises);

  // Replace each tag in the HTML
  let updatedHtml = html;

  for (const { fullTag, searchQuery, base64Src } of results) {
    if (base64Src) {
      // Build a new img tag with the real image
      const newTag = fullTag.replace(
        /src="[^"]*"/,
        `src="${base64Src}"`
      ).replace(
        /data-search="[^"]*"/,
        `alt="${searchQuery}"`
      );
      updatedHtml = updatedHtml.replace(fullTag, newTag);
      console.log("✓ Image embedded:", searchQuery);
    } else {
      // Fallback — replace with a gradient banner if image failed
      const fallbackDiv = `
        <div style="
          width:100%;
          height:220px;
          background:linear-gradient(135deg,#1a73e8,#0d47a1);
          border-radius:12px;
          display:flex;
          align-items:center;
          justify-content:center;
          margin:16px 0;
        ">
          <span style="color:white;font-size:20px;font-weight:bold;">
            ${searchQuery}
          </span>
        </div>`;
      updatedHtml = updatedHtml.replace(fullTag, fallbackDiv);
      console.log("✗ Used fallback gradient for:", searchQuery);
    }
  }

  return updatedHtml;
}

// ── Main PDF route ────────────────────────────────────────────────────────────
app.post("/generate-pdf", async (req, res) => {
  let browser;

  try {
    console.log("=== REQUEST ARRIVED ===");

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

    console.log("HTML received — length:", html.length);

    // ── Fetch and embed real images BEFORE generating PDF ─────────────────────
    console.log("Fetching images...");
    html = await embedRealImages(html);
    console.log("Images embedded. Launching Puppeteer...");

    // ── Launch Puppeteer ──────────────────────────────────────────────────────
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(30000);

    // Images are now base64 — no network needed — use domcontentloaded
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