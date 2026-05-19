const express = require("express");
const puppeteer = require("puppeteer-core");
const chromium = require("@sparticuz/chromium");
const path = require("path");
const fs = require("fs");
const axios = require("axios");

const app = express();

// ─────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────
app.use(express.json({ limit: "50mb" }));
app.use(express.text({ type: "*/*", limit: "50mb" }));

app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({
      success: false,
      error: "Invalid JSON body"
    });
  }
  next(err);
});

app.use("/files", express.static(path.join(__dirname, "public")));

// ─────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────
app.get("/", (req, res) => {
  res.send("PDF API v7 running");
});

// ─────────────────────────────────────────────
// TEST PEXELS API
// ─────────────────────────────────────────────
app.get("/test-pexels", async (req, res) => {
  const apiKey = process.env.PEXELS_API_KEY;

  if (!apiKey) {
    return res.json({
      success: false,
      error: "No PEXELS_API_KEY set"
    });
  }

  try {
    const r = await axios.get("https://api.pexels.com/v1/search", {
      headers: { Authorization: apiKey },
      params: {
        query: "nature",
        per_page: 1
      },
      timeout: 8000
    });

    return res.json({
      success: true,
      photo: r.data.photos[0]?.src?.large || null
    });

  } catch (e) {
    return res.json({
      success: false,
      error: e.message
    });
  }
});

// ─────────────────────────────────────────────
// GEMINI HELPER
// ─────────────────────────────────────────────
async function callGemini(prompt, maxTokens = 8192, temperature = 0.7) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error("GEMINI_API_KEY not set in Render");
  }

  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: prompt
              }
            ]
          }
        ],
        generationConfig: {
          maxOutputTokens: maxTokens,
          temperature
        }
      })
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      "Gemini API failed: " + JSON.stringify(data)
    );
  }

  const text =
    data?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!text) {
    throw new Error("Gemini returned empty response");
  }

  return text;
}

// ─────────────────────────────────────────────
// GEMINI CONNECTION TEST
// ─────────────────────────────────────────────
app.get("/gemini-test", async (req, res) => {
  try {
    const text = await callGemini(
      "Reply with exactly this text only: GEMINI CONNECTED",
      64,
      0.1
    );

    return res.json({
      success: true,
      message: text
    });

  } catch (error) {
    console.error("GEMINI TEST ERROR:", error);

    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ─────────────────────────────────────────────
// HTML CLEANER
// ─────────────────────────────────────────────
function cleanHtml(html) {
  if (!html || typeof html !== "string") return html;

  html = html
    .replace(/```html\s*/gi, "")
    .replace(/```\s*/gi, "")
    .trim();

  const start = html.indexOf("<!DOCTYPE");
  if (start > 0) {
    html = html.substring(start);
  }

  const htmlClose = html.lastIndexOf("</html>");
  if (htmlClose !== -1) {
    html = html.substring(0, htmlClose + 7);
  }

  html = html.replace(/(<div class="pb"><\/div>\s*)+/g, "");

  html = html.replace(
    /(<\/div>)\s*([^<]{80,}?)\s*(<div)/g,
    (match, close, text, open) => {
      if (/[\d\=\×\→]/.test(text) || /calc|height|formula/i.test(text)) {
        return close + open;
      }
      return match;
    }
  );

  console.log(`🧹 HTML cleaned: ${html.length} chars`);

  return html;
}

// ─────────────────────────────────────────────
// FETCH PEXELS IMAGE AS BASE64
// ─────────────────────────────────────────────
async function fetchImageAsBase64(query) {
  const apiKey = process.env.PEXELS_API_KEY;

  if (!apiKey) {
    console.log("❌ No PEXELS_API_KEY");
    return null;
  }

  try {
    console.log(`🔍 Pexels: "${query}"`);

    const s = await axios.get("https://api.pexels.com/v1/search", {
      headers: { Authorization: apiKey },
      params: {
        query,
        per_page: 1,
        orientation: "landscape"
      },
      timeout: 8000
    });

    if (!s.data.photos || !s.data.photos.length) {
      console.log(`⚠️ No photo found for: "${query}"`);
      return null;
    }

    const url = s.data.photos[0].src.large;

    const img = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 12000
    });

    const b64 = Buffer.from(img.data).toString("base64");
    const mime = img.headers["content-type"] || "image/jpeg";

    console.log(`✅ Image fetched: "${query}"`);

    return `data:${mime};base64,${b64}`;

  } catch (e) {
    console.log(`❌ Image failed "${query}": ${e.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────
// REPLACE [IMG:...] WITH REAL IMAGES
// ─────────────────────────────────────────────
async function embedImages(html) {
  const pattern = /\[IMG:([^\]]+)\]/g;
  const matches = [...html.matchAll(pattern)];

  if (!matches.length) {
    console.log("⚠️ No [IMG:] tags found");
    return html;
  }

  console.log(`🖼️ Found ${matches.length} image markers`);

  const results = await Promise.all(
    matches.map(async (m) => ({
      full: m[0],
      kw: m[1].trim(),
      b64: await fetchImageAsBase64(m[1].trim())
    }))
  );

  let out = html;

  const fallbacks = [
    "#1A0A0A",
    "#0A1628",
    "#0D0020",
    "#0A1A0A",
    "#1A0800",
    "#001A16"
  ];

  results.forEach(({ full, kw, b64 }, i) => {
    if (b64) {
      out = out
        .split(full)
        .join(`<img src="${b64}" alt="${kw}" class="bg-img"/>`);

      console.log(`✅ Embedded image: "${kw}"`);
    } else {
      out = out
        .split(full)
        .join(
          `<div style="position:absolute;inset:0;background:linear-gradient(135deg,${fallbacks[i % 6]},${fallbacks[(i + 2) % 6]});"></div>`
        );

      console.log(`↩️ Used fallback gradient: "${kw}"`);
    }
  });

  console.log(
    `✅ Image embedding complete: ${results.filter(r => r.b64).length} real, ${results.filter(r => !r.b64).length} fallback`
  );

  return out;
}

// ─────────────────────────────────────────────
// AUTO-FIT OVERFLOWING PAGE CONTENT
// Works with your HTML classes:
// .content-band-split
// .content-band-dark
// .content-band-light
// ─────────────────────────────────────────────
async function autoFitPageContent(page) {
  await page.evaluate(() => {
    document.querySelectorAll(".page").forEach((pg) => {
      pg.querySelectorAll(
        ".content-band-split, .content-band-dark, .content-band-light, .content-band"
      ).forEach((band) => {
        let attempts = 0;

        while (
          band.scrollHeight > band.clientHeight + 4 &&
          attempts < 40
        ) {
          band
            .querySelectorAll(
              "p, li, h2, h3, .stat-num, td, th, .chart-title"
            )
            .forEach((el) => {
              const size = parseFloat(
                window.getComputedStyle(el).fontSize
              );

              if (size > 8) {
                el.style.fontSize = size - 0.3 + "px";
              }
            });

          band
            .querySelectorAll(
              ".card, .stat, .bullets li, .highlight"
            )
            .forEach((el) => {
              const pad = parseFloat(
                window.getComputedStyle(el).paddingTop
              );

              if (pad > 5) {
                el.style.paddingTop =
                  Math.max(5, pad - 1) + "px";

                el.style.paddingBottom =
                  Math.max(5, pad - 1) + "px";
              }
            });

          band
            .querySelectorAll(
              ".cards, .stats, .bullets, .chart-wrap, .table-wrap, .highlight"
            )
            .forEach((el) => {
              const style = window.getComputedStyle(el);

              const mb = parseFloat(style.marginBottom || 0);
              const mt = parseFloat(style.marginTop || 0);

              if (mb > 4) {
                el.style.marginBottom =
                  Math.max(4, mb - 2) + "px";
              }

              if (mt > 4) {
                el.style.marginTop =
                  Math.max(4, mt - 2) + "px";
              }
            });

          attempts++;
        }
      });
    });
  });
}

// ─────────────────────────────────────────────
// PDF GENERATOR HELPER
// HTML → Images → Puppeteer → PDF URL
// ─────────────────────────────────────────────
async function createPdfFromHtml(html, req) {
  let browser;

  try {
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

    await page.setContent(html, {
      waitUntil: "networkidle2",
      timeout: 45000
    });

    await autoFitPageContent(page);

    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: {
        top: "0",
        bottom: "0",
        left: "0",
        right: "0"
      }
    });

    await browser.close();
    browser = null;

    const dir = path.join(__dirname, "public");
    fs.mkdirSync(dir, { recursive: true });

    const name = `report-${Date.now()}.pdf`;
    fs.writeFileSync(path.join(dir, name), pdf);

    const url = `${req.protocol}://${req.get("host")}/files/${name}`;

    console.log("🎉 PDF ready:", url);

    return url;

  } catch (error) {
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }

    throw error;
  }
}

// ─────────────────────────────────────────────
// ROUTE 1 — GENERATE PDF FROM HTML DIRECTLY
// POST /generate-pdf
// Body: { "html": "<!DOCTYPE html>..." }
// ─────────────────────────────────────────────
app.post("/generate-pdf", async (req, res) => {
  try {
    console.log("\n=== PDF REQUEST ===");

    let html;

    if (typeof req.body === "string") {
      try {
        const p = JSON.parse(req.body);
        html = p.html || p.answer || p.source;
      } catch {
        html = req.body;
      }
    } else {
      html =
        req.body.html ||
        req.body.answer ||
        req.body.source;
    }

    if (
      typeof html === "string" &&
      html.startsWith('"') &&
      html.endsWith('"')
    ) {
      try {
        html = JSON.parse(html);
      } catch {}
    }

    if (html && typeof html === "object" && html.answer) {
      html = html.answer;
    }

    if (!html || typeof html !== "string") {
      return res.status(400).json({
        success: false,
        error: "No HTML found",
        body_type: typeof req.body
      });
    }

    console.log(`📄 HTML received: ${html.length} chars`);

    const url = await createPdfFromHtml(html, req);

    return res.json({
      success: true,
      url
    });

  } catch (e) {
    console.error("💥 PDF ROUTE ERROR:", e.message);

    return res.status(500).json({
      success: false,
      error: e.message
    });
  }
});

// ─────────────────────────────────────────────
// BRIEF PROMPT BUILDER
// ─────────────────────────────────────────────
function buildBriefPrompt(rawNotes) {
  return `
You are a professional research strategist and document planner.

Transform the user's rough notes into a rich, structured research brief that can later be converted into a premium PDF report.

The brief must include:

1. TOPIC
2. CATEGORY — choose exactly one:
   SPORTS, CORPORATE, TECH, HEALTH, ACADEMIC, STARTUP, ECO
3. TAGLINE
4. AUDIENCE
5. 7 strong main sections
6. For each section:
   - SECTION NAME
   - HEADING
   - SUMMARY with 4 concise sentences
   - 4 cards, each with:
     - CARD TITLE
     - CARD DETAIL with 3 concise sentences
   - 5 to 6 bullets where useful
7. 3 meaningful stats if the topic supports them
8. CHART DATA with 5 labeled values if relevant
9. COMPARISON TABLE with 5 rows if relevant
10. CONCLUSION HEADING
11. CONCLUSION SUMMARY with 4 sentences
12. 4 TAKEAWAYS
13. FINAL RECOMMENDATION with 3 sentences

Rules:
- Be specific and well-structured.
- Do not write HTML.
- Do not use markdown tables.
- Use clear labels so another AI can convert this into HTML later.
- Keep it rich enough to support a long premium PDF.

User notes:
${rawNotes}
`;
}

// ─────────────────────────────────────────────
// GENERATE RESEARCH BRIEF HELPER
// ─────────────────────────────────────────────
async function generateBriefFromNotes(rawNotes) {
  const prompt = buildBriefPrompt(rawNotes);
  return await callGemini(prompt, 8192, 0.7);
}

// ─────────────────────────────────────────────
// ROUTE 2 — GENERATE RESEARCH BRIEF
// POST /generate-brief
// Body: { "raw_notes": "..." }
// ─────────────────────────────────────────────
app.post("/generate-brief", async (req, res) => {
  try {
    const { raw_notes } = req.body;

    if (!raw_notes || typeof raw_notes !== "string") {
      return res.status(400).json({
        success: false,
        error:
          "Missing raw_notes. Send JSON like: { raw_notes: 'your topic here' }"
      });
    }

    console.log("📋 Generating research brief...");

    const brief = await generateBriefFromNotes(raw_notes);

    console.log("✅ Brief generated:", brief.length, "chars");

    return res.json({
      success: true,
      brief
    });

  } catch (error) {
    console.error("GENERATE BRIEF ERROR:", error);

    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ─────────────────────────────────────────────
// HTML PROMPT BUILDER
// This is based on your earlier Relevance AI HTML prompt structure
// ─────────────────────────────────────────────
function buildHtmlPrompt(brief) {
  return `
RULES — NEVER BREAK:
1. Output ONLY raw HTML starting with <!DOCTYPE html> ending with </html>
2. Never output calculations, notes, or explanations
3. Every [IMG:] tag: write 6 specific keywords: [IMG:keyword1 keyword2 keyword3 keyword4 keyword5 keyword6]
4. Copy ALL content from the brief exactly
5. Never output placeholder words like FILL or REPLACE

THEME FROM CATEGORY:
SPORTS:    --c1:#C62828  --c2:#FF6B35  --dark:#1A0A0A  --bg:#F9F9F9
CORPORATE: --c1:#0D47A1  --c2:#1976D2  --dark:#0A1628  --bg:#F8FAFC
TECH:      --c1:#4A00E0  --c2:#00D4FF  --dark:#0D0020  --bg:#F5F0FF
HEALTH:    --c1:#1B5E20  --c2:#43A047  --dark:#0A1A0A  --bg:#F1F8E9
ACADEMIC:  --c1:#4A148C  --c2:#7B1FA2  --dark:#0D0020  --bg:#F3E5F5
STARTUP:   --c1:#BF360C  --c2:#FF6D00  --dark:#1A0800  --bg:#FFF8F1
ECO:       --c1:#00695C  --c2:#00ACC1  --dark:#001A16  --bg:#E0F2F1

IMAGE RULES:
Write [IMG:keywords] ONLY for cover, section 01, section 04.
Place as FIRST element inside that section div.

CONTENT LIMITS per section:
Paragraph: max 2 sentences
Cards: exactly 4, max 2 sentences each
Bullets: exactly 5, max 10 words each
Stats: exactly 3 with real numbers
Chart SVG: height 160px
Table: exactly 5 rows
Highlight: max 2 sentences

OUTPUT THIS HTML STRUCTURE — fill every placeholder with real content from brief:

<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=Playfair+Display:wght@700;900&display=swap" rel="stylesheet">
<style>
:root {
  --c1: SET_FROM_THEME;
  --c2: SET_FROM_THEME;
  --dark: SET_FROM_THEME;
  --bg: SET_FROM_THEME;
  --white: #ffffff;
  --gray: #9CA3AF;
  --light: #F3F4F6;
}
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family:'Inter',sans-serif; }
.page { width:210mm; height:297mm; overflow:hidden; position:relative; page-break-before:always; break-before:page; }
.cover { background:var(--dark); page-break-before:avoid; break-before:avoid; }
.cover .bg-img { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; opacity:0.4; display:block; }
.cover .overlay { position:absolute; inset:0; background:linear-gradient(160deg,rgba(0,0,0,0.05) 0%,var(--dark) 62%); }
.cover .body { position:absolute; bottom:0; left:0; right:0; z-index:2; padding:48px 60px 52px; }
.cover-tag { display:inline-flex; align-items:center; background:var(--c1); color:#fff; padding:6px 16px; border-radius:3px; font-size:10px; font-weight:700; letter-spacing:3px; text-transform:uppercase; margin-bottom:20px; }
.cover h1 { font-family:'Playfair Display',serif; font-size:52px; font-weight:900; line-height:1.08; color:#fff; margin-bottom:14px; max-width:700px; }
.cover .tagline { font-size:15px; font-weight:300; color:rgba(255,255,255,0.65); max-width:500px; line-height:1.7; margin-bottom:28px; }
.cover-footer { display:flex; gap:44px; padding-top:18px; border-top:1px solid rgba(255,255,255,0.1); }
.meta { font-size:11px; color:rgba(255,255,255,0.4); }
.meta strong { display:block; color:#fff; font-size:13px; font-weight:600; margin-top:4px; }
.page-split { background:var(--bg); display:flex; flex-direction:column; }
.photo-band { width:100%; height:110mm; flex-shrink:0; position:relative; overflow:hidden; }
.photo-band img { width:100%; height:100%; object-fit:cover; display:block; }
.photo-band .photo-overlay { position:absolute; inset:0; background:linear-gradient(180deg,transparent 30%,rgba(0,0,0,0.45) 100%); }
.content-band-split { height:187mm; padding:22px 50px 24px; overflow:hidden; background:var(--bg); }
.page-dark { background:var(--dark); }
.top-band-dark { width:100%; height:40mm; background:linear-gradient(135deg,rgba(255,255,255,0.03),rgba(255,255,255,0.01)); border-bottom:1px solid rgba(255,255,255,0.07); display:flex; align-items:center; justify-content:space-between; padding:0 50px; position:relative; overflow:hidden; }
.top-band-dark::after { content:''; position:absolute; right:-40px; top:-60px; width:200px; height:200px; border-radius:50%; background:var(--c1); opacity:0.07; }
.section-num { font-family:'Playfair Display',serif; font-size:90px; font-weight:900; color:var(--c1); opacity:0.18; font-style:italic; line-height:1; }
.content-band-dark { height:257mm; padding:24px 50px 28px; overflow:hidden; }
.page-light { background:var(--bg); }
.top-band-light { width:100%; height:36mm; background:linear-gradient(135deg,var(--c1),var(--c2)); display:flex; align-items:center; justify-content:space-between; padding:0 50px; position:relative; overflow:hidden; }
.top-band-light::before { content:''; position:absolute; right:-30px; top:-40px; width:160px; height:160px; border-radius:50%; background:rgba(255,255,255,0.1); }
.light-num { font-family:'Playfair Display',serif; font-size:72px; font-weight:900; color:rgba(255,255,255,0.18); font-style:italic; line-height:1; }
.content-band-light { height:261mm; padding:22px 50px 24px; overflow:hidden; }
.lbl { font-size:10px; font-weight:700; letter-spacing:3px; text-transform:uppercase; margin-bottom:8px; display:flex; align-items:center; gap:8px; }
.lbl::after { content:''; width:40px; height:1px; opacity:0.25; background:currentColor; }
.lbl-dark { color:rgba(255,255,255,0.4); }
.lbl-light { color:var(--c1); }
.lbl-white { color:rgba(255,255,255,0.85); }
h2 { font-family:'Inter',sans-serif; font-size:28px; font-weight:800; line-height:1.2; margin-bottom:12px; }
.h2-dark { color:#fff; }
.h2-light { color:var(--dark); }
.h2-white { color:#fff; }
.intro { font-size:13px; line-height:1.75; margin-bottom:16px; max-width:640px; }
.intro-dark { color:rgba(255,255,255,0.6); }
.intro-light { color:#374151; }
.cards { display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:14px; }
.card { border-radius:9px; padding:14px 16px; border-left:3px solid var(--c1); }
.card-dark { background:rgba(255,255,255,0.05); }
.card-light { background:var(--white); box-shadow:0 1px 5px rgba(0,0,0,0.07); }
.card h3 { font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:6px; }
.card-dark h3 { color:rgba(255,255,255,0.85); }
.card-light h3 { color:var(--dark); }
.card p { font-size:12px; line-height:1.6; margin:0; }
.card-dark p { color:rgba(255,255,255,0.5); }
.card-light p { color:#6B7280; }
.stats { display:grid; grid-template-columns:1fr 1fr 1fr; gap:10px; margin-bottom:16px; }
.stat { background:rgba(255,255,255,0.05); border-radius:9px; padding:18px 14px; text-align:center; border-top:2px solid var(--c1); }
.stat-num { font-family:'Playfair Display',serif; font-size:38px; font-weight:900; color:var(--c2); line-height:1; }
.stat-label { font-size:9px; color:rgba(255,255,255,0.45); margin-top:6px; text-transform:uppercase; letter-spacing:1px; }
.bullets { list-style:none; margin-bottom:14px; }
.bullets li { font-size:12px; padding:9px 12px 9px 36px; border-radius:7px; margin-bottom:6px; position:relative; line-height:1.55; }
.bullets-dark li { background:rgba(255,255,255,0.05); color:rgba(255,255,255,0.7); }
.bullets-light li { background:var(--white); color:#374151; box-shadow:0 1px 3px rgba(0,0,0,0.05); }
.bullets li::before { content:''; position:absolute; left:13px; top:50%; transform:translateY(-50%); width:7px; height:7px; border-radius:50%; background:var(--c1); }
.highlight { background:linear-gradient(135deg,var(--c1),var(--c2)); border-radius:9px; padding:16px 22px; margin-top:14px; }
.highlight h3 { font-family:'Playfair Display',serif; font-size:16px; font-weight:700; color:#fff; margin-bottom:7px; }
.highlight p { font-size:12px; color:rgba(255,255,255,0.88); line-height:1.65; margin:0; }
.table-wrap { border-radius:9px; overflow:hidden; box-shadow:0 2px 10px rgba(0,0,0,0.1); margin-bottom:14px; }
table { width:100%; border-collapse:collapse; background:var(--white); }
thead { background:var(--dark); }
thead th { padding:11px 14px; text-align:left; font-size:10px; font-weight:700; letter-spacing:1.5px; text-transform:uppercase; color:#fff; }
tbody tr:nth-child(even) { background:var(--light); }
tbody td { padding:10px 14px; font-size:12px; color:#374151; border-bottom:1px solid #E5E7EB; line-height:1.4; }
tbody tr:last-child td { border-bottom:none; }
.chart-wrap { background:rgba(255,255,255,0.05); border-radius:9px; padding:16px 18px 12px; margin-bottom:14px; }
.chart-title { font-size:10px; font-weight:700; color:rgba(255,255,255,0.55); text-transform:uppercase; letter-spacing:1.5px; margin-bottom:14px; }
</style>
</head>
<body>

<!-- COVER -->
<div class="page cover">
[IMG:write 6 specific keywords for cover photo matching the topic]
<div class="overlay"></div>
<div class="body">
  <div class="cover-tag">◆ Professional Report</div>
  <h1>REPORT TITLE FROM TOPIC IN CAPS MAX 8 WORDS</h1>
  <p class="tagline">Copy TAGLINE from brief exactly.</p>
  <div class="cover-footer">
    <div class="meta">Prepared For <strong>Copy AUDIENCE</strong></div>
    <div class="meta">Document Type <strong>Executive Report</strong></div>
    <div class="meta">Status <strong>Final</strong></div>
  </div>
</div>
</div>

<!-- SECTION 01 -->
<div class="page page-split">
<div class="photo-band">
[IMG:write 6 specific keywords for section 1 photo different from cover]
<div class="photo-overlay"></div>
</div>
<div class="content-band-split">
  <div class="lbl lbl-light">01 / COPY SECTION 1 NAME</div>
  <h2 class="h2-light">Copy HEADING from Section 1</h2>
  <p class="intro intro-light">Copy SUMMARY sentences 1 and 2 from Section 1.</p>
  <div class="cards">
    <div class="card card-light"><h3>Copy CARD 1 TITLE</h3><p>Copy CARD 1 DETAIL sentences 1 and 2.</p></div>
    <div class="card card-light"><h3>Copy CARD 2 TITLE</h3><p>Copy CARD 2 DETAIL sentences 1 and 2.</p></div>
    <div class="card card-light"><h3>Copy CARD 3 TITLE</h3><p>Copy CARD 3 DETAIL sentences 1 and 2.</p></div>
    <div class="card card-light"><h3>Copy CARD 4 TITLE</h3><p>Copy CARD 4 DETAIL sentences 1 and 2.</p></div>
  </div>
</div>
</div>

<!-- SECTION 02 -->
<div class="page page-dark">
<div class="top-band-dark">
  <div><div class="lbl lbl-dark">02 / COPY SECTION 2 NAME</div><h2 class="h2-dark">Copy HEADING from Section 2</h2></div>
  <div class="section-num">02</div>
</div>
<div class="content-band-dark">
  <p class="intro intro-dark">Copy SUMMARY sentences 1 and 2 from Section 2.</p>
  <div class="stats">
    <div class="stat"><div class="stat-num">STAT 1 VALUE</div><div class="stat-label">STAT 1 LABEL</div></div>
    <div class="stat"><div class="stat-num">STAT 2 VALUE</div><div class="stat-label">STAT 2 LABEL</div></div>
    <div class="stat"><div class="stat-num">STAT 3 VALUE</div><div class="stat-label">STAT 3 LABEL</div></div>
  </div>
  <ul class="bullets bullets-dark">
    <li>Copy bullet 1 from Section 2</li>
    <li>Copy bullet 2 from Section 2</li>
    <li>Copy bullet 3 from Section 2</li>
    <li>Copy bullet 4 from Section 2</li>
    <li>Copy bullet 5 from Section 2</li>
  </ul>
</div>
</div>

<!-- SECTION 03 -->
<div class="page page-light">
<div class="top-band-light">
  <div><div class="lbl lbl-white">03 / COPY SECTION 3 NAME</div><h2 class="h2-white">Copy HEADING from Section 3</h2></div>
  <div class="light-num">03</div>
</div>
<div class="content-band-light">
  <p class="intro intro-light">Copy SUMMARY sentences 1 and 2 from Section 3.</p>
  <div class="cards">
    <div class="card card-light"><h3>Copy CARD 1 TITLE</h3><p>Copy CARD 1 DETAIL sentences 1 and 2.</p></div>
    <div class="card card-light"><h3>Copy CARD 2 TITLE</h3><p>Copy CARD 2 DETAIL sentences 1 and 2.</p></div>
    <div class="card card-light"><h3>Copy CARD 3 TITLE</h3><p>Copy CARD 3 DETAIL sentences 1 and 2.</p></div>
    <div class="card card-light"><h3>Copy CARD 4 TITLE</h3><p>Copy CARD 4 DETAIL sentences 1 and 2.</p></div>
  </div>
  <div class="highlight"><h3>Key Insight</h3><p>Write 2 sentences drawing key insight from Section 3.</p></div>
</div>
</div>

<!-- SECTION 04 -->
<div class="page page-split">
<div class="photo-band">
[IMG:write 6 specific keywords for section 4 different from all previous]
<div class="photo-overlay"></div>
</div>
<div class="content-band-split">
  <div class="lbl lbl-light">04 / COPY SECTION 4 NAME</div>
  <h2 class="h2-light">Copy HEADING from Section 4</h2>
  <p class="intro intro-light">Copy SUMMARY sentences 1 and 2 from Section 4.</p>
  <ul class="bullets bullets-light">
    <li>Copy bullet 1 from Section 4</li>
    <li>Copy bullet 2 from Section 4</li>
    <li>Copy bullet 3 from Section 4</li>
    <li>Copy bullet 4 from Section 4</li>
    <li>Copy bullet 5 from Section 4</li>
  </ul>
  <div class="highlight"><h3>Key Insight</h3><p>Write 2 sentences from Section 4 content.</p></div>
</div>
</div>

<!-- SECTION 05 -->
<div class="page page-dark">
<div class="top-band-dark">
  <div><div class="lbl lbl-dark">05 / DATA & INSIGHTS</div><h2 class="h2-dark">Copy CHART TITLE from brief</h2></div>
  <div class="section-num">05</div>
</div>
<div class="content-band-dark">
  <p class="intro intro-dark">Write 2 sentences explaining what this chart shows.</p>
  <div class="chart-wrap">
    <div class="chart-title">CHART TITLE UPPERCASE</div>
    <svg viewBox="0 0 500 185" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:160px;">
      <line x1="40" y1="18" x2="488" y2="18" stroke="rgba(255,255,255,0.05)" stroke-width="1"/>
      <line x1="40" y1="88" x2="488" y2="88" stroke="rgba(255,255,255,0.05)" stroke-width="1"/>
      <line x1="40" y1="158" x2="488" y2="158" stroke="rgba(255,255,255,0.1)" stroke-width="1"/>
      <rect x="58" y="CALC_Y1" width="44" height="CALC_H1" rx="4" fill="var(--c1)" opacity="0.95"/>
      <text x="80" y="CALC_LBL_Y1" font-size="10" font-weight="700" fill="var(--c2)" text-anchor="middle" font-family="Inter,sans-serif">VALUE1</text>
      <text x="80" y="175" font-size="9" fill="rgba(255,255,255,0.4)" text-anchor="middle" font-family="Inter,sans-serif">LABEL1</text>
      <rect x="148" y="CALC_Y2" width="44" height="CALC_H2" rx="4" fill="var(--c1)" opacity="0.78"/>
      <text x="170" y="CALC_LBL_Y2" font-size="10" font-weight="700" fill="var(--c2)" text-anchor="middle" font-family="Inter,sans-serif">VALUE2</text>
      <text x="170" y="175" font-size="9" fill="rgba(255,255,255,0.4)" text-anchor="middle" font-family="Inter,sans-serif">LABEL2</text>
      <rect x="238" y="CALC_Y3" width="44" height="CALC_H3" rx="4" fill="var(--c1)" opacity="0.62"/>
      <text x="260" y="CALC_LBL_Y3" font-size="10" font-weight="700" fill="var(--c2)" text-anchor="middle" font-family="Inter,sans-serif">VALUE3</text>
      <text x="260" y="175" font-size="9" fill="rgba(255,255,255,0.4)" text-anchor="middle" font-family="Inter,sans-serif">LABEL3</text>
      <rect x="328" y="CALC_Y4" width="44" height="CALC_H4" rx="4" fill="var(--c2)" opacity="0.85"/>
      <text x="350" y="CALC_LBL_Y4" font-size="10" font-weight="700" fill="var(--c2)" text-anchor="middle" font-family="Inter,sans-serif">VALUE4</text>
      <text x="350" y="175" font-size="9" fill="rgba(255,255,255,0.4)" text-anchor="middle" font-family="Inter,sans-serif">LABEL4</text>
      <rect x="418" y="CALC_Y5" width="44" height="CALC_H5" rx="4" fill="var(--c2)" opacity="1"/>
      <text x="440" y="CALC_LBL_Y5" font-size="10" font-weight="700" fill="var(--c2)" text-anchor="middle" font-family="Inter,sans-serif">VALUE5</text>
      <text x="440" y="175" font-size="9" fill="rgba(255,255,255,0.4)" text-anchor="middle" font-family="Inter,sans-serif">LABEL5</text>
      <text x="488" y="183" font-size="8" fill="rgba(255,255,255,0.25)" text-anchor="end" font-family="Inter,sans-serif">UNIT</text>
    </svg>
  </div>
  <ul class="bullets bullets-dark">
    <li>Write insight about the highest value bar</li>
    <li>Write insight about the trend across the data</li>
    <li>Write practical implication for the reader</li>
  </ul>
</div>
</div>

<!-- SECTION 06 -->
<div class="page page-light">
<div class="top-band-light">
  <div><div class="lbl lbl-white">06 / COMPARISON</div><h2 class="h2-white">Copy TABLE TITLE from brief</h2></div>
  <div class="light-num">06</div>
</div>
<div class="content-band-light">
  <p class="intro intro-light">Write 2 sentences introducing the comparison.</p>
  <div class="table-wrap">
    <table>
      <thead><tr><th>Copy COL1</th><th>Copy COL2</th><th>Copy COL3</th></tr></thead>
      <tbody>
        <tr><td>ROW1 val1</td><td>ROW1 val2</td><td>ROW1 val3</td></tr>
        <tr><td>ROW2 val1</td><td>ROW2 val2</td><td>ROW2 val3</td></tr>
        <tr><td>ROW3 val1</td><td>ROW3 val2</td><td>ROW3 val3</td></tr>
        <tr><td>ROW4 val1</td><td>ROW4 val2</td><td>ROW4 val3</td></tr>
        <tr><td>ROW5 val1</td><td>ROW5 val2</td><td>ROW5 val3</td></tr>
      </tbody>
    </table>
  </div>
  <div class="highlight"><h3>Key Finding</h3><p>Write 2 sentences drawing conclusion from comparison.</p></div>
</div>
</div>

<!-- SECTION 07 -->
<div class="page page-dark">
<div class="top-band-dark">
  <div><div class="lbl lbl-dark">07 / COPY SECTION 7 NAME</div><h2 class="h2-dark">Copy HEADING from Section 7</h2></div>
  <div class="section-num">07</div>
</div>
<div class="content-band-dark">
  <p class="intro intro-dark">Copy SUMMARY sentences 1 and 2 from Section 7.</p>
  <div class="cards">
    <div class="card card-dark"><h3>Copy CARD 1 TITLE</h3><p>Copy CARD 1 DETAIL sentences 1 and 2.</p></div>
    <div class="card card-dark"><h3>Copy CARD 2 TITLE</h3><p>Copy CARD 2 DETAIL sentences 1 and 2.</p></div>
    <div class="card card-dark"><h3>Copy CARD 3 TITLE</h3><p>Copy CARD 3 DETAIL sentences 1 and 2.</p></div>
    <div class="card card-dark"><h3>Copy CARD 4 TITLE</h3><p>Copy CARD 4 DETAIL sentences 1 and 2.</p></div>
  </div>
</div>
</div>

<!-- CONCLUSION -->
<div class="page page-dark">
<div class="top-band-dark">
  <div><div class="lbl lbl-dark">CONCLUSION</div><h2 class="h2-dark">Copy CONCLUSION HEADING</h2></div>
  <div class="section-num">✦</div>
</div>
<div class="content-band-dark">
  <p class="intro intro-dark">Copy CONCLUSION SUMMARY sentences 1 and 2.</p>
  <ul class="bullets bullets-dark">
    <li>Copy TAKEAWAY 1 exactly</li>
    <li>Copy TAKEAWAY 2 exactly</li>
    <li>Copy TAKEAWAY 3 exactly</li>
    <li>Copy TAKEAWAY 4 exactly</li>
  </ul>
  <div class="highlight"><h3>Final Recommendation</h3><p>Copy all 3 sentences of FINAL RECOMMENDATION.</p></div>
</div>
</div>

</body>
</html>

Research brief:
${brief}
`;
}

// ─────────────────────────────────────────────
// GENERATE HTML HELPER
// ─────────────────────────────────────────────
async function generateHtmlFromBrief(brief) {
  const prompt = buildHtmlPrompt(brief);

  let html = await callGemini(prompt, 8192, 0.5);

  html = cleanHtml(html);

  return html;
}

// ─────────────────────────────────────────────
// ROUTE 3 — GENERATE HTML FROM BRIEF
// POST /generate-html
// Body: { "brief": "..." }
// ─────────────────────────────────────────────
app.post("/generate-html", async (req, res) => {
  try {
    const { brief } = req.body;

    if (!brief || typeof brief !== "string") {
      return res.status(400).json({
        success: false,
        error:
          "Missing brief. Send JSON like: { brief: 'your research brief here' }"
      });
    }

    console.log("🎨 Generating HTML...");

    const html = await generateHtmlFromBrief(brief);

    console.log("✅ HTML generated:", html.length, "chars");

    return res.json({
      success: true,
      html
    });

  } catch (error) {
    console.error("GENERATE HTML ERROR:", error);

    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ─────────────────────────────────────────────
// ROUTE 4 — FULL PIPELINE
// Raw notes → Brief → HTML → Images → PDF URL
// POST /generate-report-pdf
// Body: { "raw_notes": "..." }
// ─────────────────────────────────────────────
app.post("/generate-report-pdf", async (req, res) => {
  try {
    const { raw_notes } = req.body;

    if (!raw_notes || typeof raw_notes !== "string") {
      return res.status(400).json({
        success: false,
        error:
          "Missing raw_notes. Send JSON like: { raw_notes: 'your topic here' }"
      });
    }

    console.log("\n=== FULL PDF PIPELINE START ===");

    console.log("Step 1: Generating research brief...");
    const brief = await generateBriefFromNotes(raw_notes);
    console.log("✅ Brief done:", brief.length, "chars");

    console.log("Step 2: Generating HTML...");
    const html = await generateHtmlFromBrief(brief);
    console.log("✅ HTML done:", html.length, "chars");

    console.log("Step 3: Generating PDF...");
    const url = await createPdfFromHtml(html, req);

    console.log("🎉 FULL PIPELINE COMPLETE:", url);

    return res.json({
      success: true,
      url
    });

  } catch (error) {
    console.error("💥 FULL PIPELINE ERROR:", error);

    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ─────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────
app.listen(process.env.PORT || 3000, () => {
  console.log("✅ Server v7 on port", process.env.PORT || 3000);
});