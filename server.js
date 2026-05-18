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

app.get("/", (req, res) => res.send("PDF API v6 running"));

app.get("/test-pexels", async (req, res) => {
  const apiKey = process.env.PEXELS_API_KEY;
  if (!apiKey) return res.json({ success: false, error: "No API key set" });
  try {
    const r = await axios.get("https://api.pexels.com/v1/search", {
      headers: { Authorization: apiKey },
      params: { query: "nature", per_page: 1 },
      timeout: 8000
    });
    res.json({ success: true, photo: r.data.photos[0].src.large });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

function cleanHtml(html) {
  const htmlClose = html.lastIndexOf("</html>");
  if (htmlClose !== -1) html = html.substring(0, htmlClose + 7);
  html = html.replace(/(<div class="pb"><\/div>\s*)+/g, "");
  html = html.replace(/(<\/div>)\s*([^<]{80,}?)\s*(<div)/g, (match, close, text, open) => {
    if (/[\d\=\×\→]/.test(text) || /calc|height|formula/i.test(text)) return close + open;
    return match;
  });
  console.log(`🧹 HTML cleaned: ${html.length} chars`);
  return html;
}

async function fetchImageAsBase64(query) {
  const apiKey = process.env.PEXELS_API_KEY;
  if (!apiKey) { console.log("❌ No PEXELS_API_KEY"); return null; }
  try {
    console.log(`🔍 Pexels: "${query}"`);
    const s = await axios.get("https://api.pexels.com/v1/search", {
      headers: { Authorization: apiKey },
      params: { query, per_page: 1, orientation: "landscape" },
      timeout: 8000
    });
    if (!s.data.photos.length) { console.log(`⚠️ No photo: "${query}"`); return null; }
    const url = s.data.photos[0].src.large;
    const img = await axios.get(url, { responseType: "arraybuffer", timeout: 12000 });
    const b64 = Buffer.from(img.data).toString("base64");
    const mime = img.headers["content-type"] || "image/jpeg";
    console.log(`✅ Image: "${query}"`);
    return `data:${mime};base64,${b64}`;
  } catch (e) {
    console.log(`❌ Failed "${query}": ${e.message}`);
    return null;
  }
}

async function embedImages(html) {
  const pattern = /\[IMG:([^\]]+)\]/g;
  const matches = [...html.matchAll(pattern)];
  if (!matches.length) { console.log("⚠️ No [IMG:] tags found"); return html; }
  console.log(`🖼️ Found ${matches.length} images`);

  const results = await Promise.all(matches.map(async m => ({
    full: m[0], kw: m[1].trim(),
    b64: await fetchImageAsBase64(m[1].trim())
  })));

  let out = html;
  const fallbacks = ["#1A0A0A","#0A1628","#0D0020","#0A1A0A","#1A0800","#001A16"];

  results.forEach(({ full, kw, b64 }, i) => {
    if (b64) {
      out = out.split(full).join(`<img src="${b64}" alt="${kw}" class="bg-img"/>`);
      console.log(`✅ Embedded: "${kw}"`);
    } else {
      out = out.split(full).join(
        `<div style="position:absolute;inset:0;background:linear-gradient(135deg,${fallbacks[i%6]},${fallbacks[(i+2)%6]});"></div>`
      );
      console.log(`↩️ Fallback: "${kw}"`);
    }
  });

  console.log(`✅ Done: ${results.filter(r=>r.b64).length} real, ${results.filter(r=>!r.b64).length} fallback`);
  return out;
}

app.post("/generate-pdf", async (req, res) => {
  let browser;
  try {
    console.log("\n=== PDF REQUEST ===");

    let html;
    if (typeof req.body === "string") {
      try { const p = JSON.parse(req.body); html = p.html || p.answer; }
      catch { html = req.body; }
    } else {
      html = req.body.html || req.body.answer || req.body.source;
    }

    if (typeof html === "string" && html.startsWith('"') && html.endsWith('"')) {
      try { html = JSON.parse(html); } catch {}
    }
    if (html && typeof html === "object" && html.answer) html = html.answer;

    if (!html || typeof html !== "string") {
      return res.status(400).json({ success: false, error: "No HTML", body_type: typeof req.body });
    }

    console.log(`📄 HTML: ${html.length} chars`);
    html = cleanHtml(html);
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

    await page.setContent(html, { waitUntil: "networkidle2", timeout: 45000 });

    // ── Auto-fit overflowing content so nothing escapes to next page ──
    await page.evaluate(() => {
      document.querySelectorAll(".page").forEach(pg => {
        pg.querySelectorAll(".content-band").forEach(band => {
          let attempts = 0;
          while (band.scrollHeight > band.clientHeight + 4 && attempts < 40) {
            band.querySelectorAll("p, li, h2, h3, .stat-num, td, th, .chart-title").forEach(el => {
              const size = parseFloat(window.getComputedStyle(el).fontSize);
              if (size > 8) el.style.fontSize = (size - 0.3) + "px";
            });
            band.querySelectorAll(".card, .stat, .bullets li, .highlight").forEach(el => {
              const pad = parseFloat(window.getComputedStyle(el).paddingTop);
              if (pad > 5) {
                el.style.paddingTop = Math.max(5, pad - 1) + "px";
                el.style.paddingBottom = Math.max(5, pad - 1) + "px";
              }
            });
            band.querySelectorAll(".cards, .stats, .bullets, .chart-wrap, .table-wrap").forEach(el => {
              const mb = parseFloat(window.getComputedStyle(el).marginBottom);
              if (mb > 4) el.style.marginBottom = Math.max(4, mb - 2) + "px";
            });
            attempts++;
          }
        });
      });
    });

    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "0", bottom: "0", left: "0", right: "0" }
    });

    await browser.close();
    browser = null;

    const dir = path.join(__dirname, "public");
    fs.mkdirSync(dir, { recursive: true });
    const name = `report-${Date.now()}.pdf`;
    fs.writeFileSync(path.join(dir, name), pdf);

    const url = `${req.protocol}://${req.get("host")}/files/${name}`;
    console.log("🎉 PDF:", url);
    return res.json({ success: true, url });

  } catch (e) {
    console.error("💥 ERROR:", e.message);
    if (browser) try { await browser.close(); } catch {}
    return res.status(500).json({ success: false, error: e.message });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log("✅ Server v6 on port", process.env.PORT || 3000);
});