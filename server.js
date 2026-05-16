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
    return res.status(400).json({ success: false, error: "Invalid JSON body" });
  }
  next(err);
});

app.use("/files", express.static(path.join(__dirname, "public")));

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.send("PDF API is running");
});

// ── TEST ENDPOINT — visit this to verify Pexels works ────────────────────────
// Open this in browser: https://YOUR-RENDER-URL.onrender.com/test-pexels
app.get("/test-pexels", async (req, res) => {
  const apiKey = process.env.PEXELS_API_KEY;

  if (!apiKey) {
    return res.json({
      success: false,
      error: "PEXELS_API_KEY environment variable is NOT set in Render",
      fix: "Go to Render dashboard → your service → Environment → add PEXELS_API_KEY"
    });
  }

  try {
    const response = await axios.get("https://api.pexels.com/v1/search", {
      headers: { Authorization: apiKey },
      params: { query: "nature", per_page: 1 },
      timeout: 8000
    });

    const photo = response.data.photos[0];
    return res.json({
      success: true,
      message: "Pexels API is working correctly",
      sample_image_url: photo.src.large,
      photographer: photo.photographer
    });

  } catch (err) {
    return res.json({
      success: false,
      error: "Pexels API call failed",
      detail: err.message,
      api_key_first_5: apiKey.substring(0, 5) + "..."
    });
  }
});

// ── Fetch image from Pexels → return as base64 ───────────────────────────────
async function fetchImageAsBase64(searchQuery) {
  const apiKey = process.env.PEXELS_API_KEY;

  if (!apiKey) {
    console.log("❌ PEXELS_API_KEY not set — set it in Render environment variables");
    return null;
  }

  try {
    console.log(`🔍 Searching Pexels for: "${searchQuery}"`);

    const searchRes = await axios.get("https://api.pexels.com/v1/search", {
      headers: { Authorization: apiKey },
      params: { query: searchQuery, per_page: 1, orientation: "landscape" },
      timeout: 8000
    });

    const photos = searchRes.data.photos;
    if (!photos || photos.length === 0) {
      console.log(`⚠️ No photos found for: "${searchQuery}"`);
      return null;
    }

    const imageUrl = photos[0].src.large;
    console.log(`📥 Downloading image for: "${searchQuery}"`);

    const imgRes = await axios.get(imageUrl, {
      responseType: "arraybuffer",
      timeout: 12000
    });

    const base64 = Buffer.from(imgRes.data).toString("base64");
    const mime = imgRes.headers["content-type"] || "image/jpeg";

    console.log(`✅ Image ready for: "${searchQuery}"`);
    return `data:${mime};base64,${base64}`;

  } catch (err) {
    console.log(`❌ Pexels failed for "${searchQuery}": ${err.message}`);
    return null;
  }
}

// ── Find [IMG:keywords] and replace with real photos ─────────────────────────
async function embedImages(html) {
  const pattern = /\[IMG:([^\]]+)\]/g;
  const matches = [...html.matchAll(pattern)];

  if (matches.length === 0) {
    console.log("⚠️ No [IMG:...] placeholders found in HTML");
    return html;
  }

  console.log(`🖼️ Found ${matches.length} image placeholders — fetching all in parallel`);

  const fetches = matches.map(async (match) => {
    const fullMatch = match[0];
    const keywords = match[1].trim();
    const base64 = await fetchImageAsBase64(keywords);
    return { fullMatch, keywords, base64 };
  });

  const results = await Promise.all(fetches);

  let updatedHtml = html;
  let successCount = 0;
  let failCount = 0;

  for (const { fullMatch, keywords, base64 } of results) {
    if (base64) {
      const imgTag = `
        <img
          src="${base64}"
          alt="${keywords}"
          style="
            width: 100%;
            height: 220px;
            object-fit: cover;
            border-radius: 12px;
            margin: 16px 0;
            display: block;
          "
        />`;
      updatedHtml = updatedHtml.split(fullMatch).join(imgTag);
      successCount++;
    } else {
      // Gradient fallback if Pexels fails
      const colors = [
        ["#1a73e8", "#0d47a1"],
        ["#2e7d32", "#1b5e20"],
        ["#e65100", "#bf360c"],
        ["#6a1b9a", "#4a148c"],
        ["#00695c", "#004d40"],
        ["#c62828", "#b71c1c"]
      ];
      const [c1, c2] = colors[failCount % colors.length];
      const gradient = `
        <div style="
          width: 100%;
          height: 220px;
          background: linear-gradient(135deg, ${c1}, ${c2});
          border-radius: 12px;
          margin: 16px 0;
          display: flex;
          align-items: center;
          justify-content: center;
        ">
          <span style="color:white; font-size:16px; font-weight:bold; padding:20px; text-align:center;">
            ${keywords}
          </span>
        </div>`;
      updatedHtml = updatedHtml.split(fullMatch).join(gradient);
      failCount++;
    }
  }

  console.log(`✅ Images done: ${successCount} real photos, ${failCount} gradients`);
  return updatedHtml;
}

// ── Main PDF route ────────────────────────────────────────────────────────────
app.post("/generate-pdf", async (req, res) => {
  let browser;

  try {
    console.log("\n=== NEW PDF REQUEST ===");
    console.log("Content-Type:", req.headers["content-type"]);

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

    console.log(`📄 HTML received: ${html.length} characters`);

    // Fetch and embed real images
    html = await embedImages(html);

    console.log("🚀 Launching Puppeteer...");

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

    const publicDir = path.join(__dirname, "public");
    fs.mkdirSync(publicDir, { recursive: true });

    const fileName = `report-${Date.now()}.pdf`;
    const filePath = path.join(publicDir, fileName);
    fs.writeFileSync(filePath, pdf);

    const pdfUrl = `${req.protocol}://${req.get("host")}/files/${fileName}`;
    console.log("🎉 PDF ready:", pdfUrl);

    return res.json({ success: true, url: pdfUrl });

  } catch (error) {
    console.error("💥 PDF ERROR:", error.message);
    if (browser) {
      try { await browser.close(); } catch {}
    }
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log("✅ Server running on port", process.env.PORT || 3000);
});