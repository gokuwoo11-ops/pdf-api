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

app.get("/", (req, res) => {
  res.send("PDF API v5 running");
});

app.get("/test-pexels", async (req, res) => {
  const apiKey = process.env.PEXELS_API_KEY;
  if (!apiKey) {
    return res.json({ success: false, error: "PEXELS_API_KEY not set in Render environment" });
  }
  try {
    const response = await axios.get("https://api.pexels.com/v1/search", {
      headers: { Authorization: apiKey },
      params: { query: "nature", per_page: 1 },
      timeout: 8000
    });
    const photo = response.data.photos[0];
    return res.json({ success: true, message: "Pexels working", sample: photo.src.large });
  } catch (err) {
    return res.json({ success: false, error: err.message });
  }
});

// ── Clean up LLM HTML artifacts before rendering ─────────────────────────────
function cleanHtml(html) {
    html = html.replace(/<div class="pb"><\/div>/g, '');
  // Cut off anything after </html>
  const htmlClose = html.lastIndexOf("</html>");
  if (htmlClose !== -1) {
    html = html.substring(0, htmlClose + 7);
  }

  // Remove raw calculation/math text that appears between divs
  html = html.replace(/(<\/div>)\s*([^<]{50,}?)\s*(<div)/g, (match, close, text, open) => {
    if (/[\d\.\=\×\→×÷]/.test(text) || /formula|rounded|height|value|calc/i.test(text)) {
      return close + open;
    }
    return match;
  });

  // Remove duplicate consecutive page breaks
  html = html.replace(/(<div class="pb"><\/div>\s*){2,}/g, '<div class="pb"></div>');

  // Remove page break right before </body>
  html = html.replace(/<div class="pb"><\/div>\s*<\/body>/gi, "</body>");

  // Remove page break right after <body>
  html = html.replace(/(<body[^>]*>)\s*<div class="pb"><\/div>/gi, "$1");

  console.log(`🧹 HTML cleaned: ${html.length} chars`);
  return html;
}

// ── Fetch image from Pexels → base64 ─────────────────────────────────────────
async function fetchImageAsBase64(searchQuery) {
  const apiKey = process.env.PEXELS_API_KEY;
  if (!apiKey) {
    console.log("❌ PEXELS_API_KEY not set");
    return null;
  }
  try {
    console.log(`🔍 Searching Pexels: "${searchQuery}"`);
    const searchRes = await axios.get("https://api.pexels.com/v1/search", {
      headers: { Authorization: apiKey },
      params: { query: searchQuery, per_page: 1, orientation: "landscape" },
      timeout: 8000
    });
    const photos = searchRes.data.photos;
    if (!photos || photos.length === 0) {
      console.log(`⚠️ No photos found: "${searchQuery}"`);
      return null;
    }
    const imageUrl = photos[0].src.large;
    console.log(`📥 Downloading: "${searchQuery}"`);
    const imgRes = await axios.get(imageUrl, {
      responseType: "arraybuffer",
      timeout: 12000
    });
    const base64 = Buffer.from(imgRes.data).toString("base64");
    const mime = imgRes.headers["content-type"] || "image/jpeg";
    console.log(`✅ Image ready: "${searchQuery}"`);
    return `data:${mime};base64,${base64}`;
  } catch (err) {
    console.log(`❌ Pexels failed "${searchQuery}": ${err.message}`);
    return null;
  }
}

// ── Replace [IMG:keywords] with real Pexels photos ───────────────────────────
async function embedImages(html) {
  const pattern = /\[IMG:([^\]]+)\]/g;
  const matches = [...html.matchAll(pattern)];

  if (matches.length === 0) {
    console.log("⚠️ No [IMG:] placeholders found");
    return html;
  }

  console.log(`🖼️ Found ${matches.length} image placeholders — fetching in parallel`);

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

  const fallbackColors = [
    ["#1A0A0A", "#C62828"],
    ["#0A1628", "#0D47A1"],
    ["#0D0020", "#4A00E0"],
    ["#0A1A0A", "#1B5E20"],
    ["#1A0800", "#BF360C"],
    ["#001A16", "#00695C"]
  ];

  for (const { fullMatch, keywords, base64 } of results) {
    if (base64) {
      // Replaced as a plain <img> — CSS in the HTML template handles sizing
      const imgTag = `<img src="${base64}" alt="${keywords}" />`;
      updatedHtml = updatedHtml.split(fullMatch).join(imgTag);
      successCount++;
    } else {
      const [bg, accent] = fallbackColors[failCount % fallbackColors.length];
      const gradient = `
        <div style="
          width:100%; height:320px;
          background:linear-gradient(135deg, ${bg}, ${accent});
          display:flex; align-items:center; justify-content:center;
          flex-shrink:0;
        ">
          <span style="color:rgba(255,255,255,0.4); font-size:14px; font-family:sans-serif;">
            ${keywords}
          </span>
        </div>`;
      updatedHtml = updatedHtml.split(fullMatch).join(gradient);
      failCount++;
    }
  }

  console.log(`✅ Images done: ${successCount} real, ${failCount} gradients`);
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

    console.log(`📄 HTML received: ${html.length} chars`);

    // Step 1 — clean LLM artifacts
    html = cleanHtml(html);

    // Step 2 — embed real images
    html = await embedImages(html);

    console.log("🚀 Launching Puppeteer...");

    browser = await puppeteer.launch({
      args: [
        ...chromium.args,
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--font-render-hinting=none",
        "--disable-font-subpixel-positioning"
      ],
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(45000);
    page.setDefaultNavigationTimeout(45000);

    await page.setContent(html, {
      waitUntil: "networkidle2",
      timeout: 45000
    });

    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "0", bottom: "0", left: "0", right: "0" }
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
  console.log("✅ Server v5 running on port", process.env.PORT || 3000);
});