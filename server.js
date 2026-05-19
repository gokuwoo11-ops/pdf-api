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
// ─────────────────────────────────────────────
// GEMINI HELPER WITH AUTO FALLBACK
// Tries Gemini 3 Flash first.
// If Google returns 503 high-demand error,
// it automatically retries with Gemini 3.1 Flash-Lite.
// ─────────────────────────────────────────────
async function callGemini(prompt, maxTokens = 8192, temperature = 0.7) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error("GEMINI_API_KEY not set in Render");
  }

  const models = [
    "gemini-3-flash-preview",
    "gemini-3.1-flash-lite"
  ];

  let lastError = null;

  for (const model of models) {
    try {
      console.log(`🤖 Trying Gemini model: ${model}`);

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
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
        const code = data?.error?.code;
        const message = data?.error?.message || "Unknown Gemini error";

        console.log(`⚠️ ${model} failed: ${code} - ${message}`);

        lastError = new Error(
          `Gemini model ${model} failed: ${JSON.stringify(data)}`
        );

        // If 503, try next fallback model
        if (code === 503) {
          continue;
        }

        // For other errors, stop immediately
        throw lastError;
      }

      const text =
        data?.candidates?.[0]?.content?.parts?.[0]?.text;

      if (!text) {
        throw new Error(`${model} returned empty response`);
      }

      console.log(`✅ Gemini success with: ${model}`);
      return text;

    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("All Gemini models failed");
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
  // First: normalize bad Gemini outputs like:
  // <img src="[IMG:keywords]" alt="Background">
  // into plain:
  // [IMG:keywords]
  html = html.replace(
    /<img[^>]*\[IMG:([^\]]+)\][^>]*>/gi,
    "[IMG:$1]"
  );

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

              if (size > 11) {
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
    const currentPeriod = new Date().toLocaleString("en-IN", {
    month: "long",
    year: "numeric",
    timeZone: "Asia/Kolkata"
  });
  return `
You are a B2B growth analyst preparing a lead audit brief.

Read the input and produce a structured audit brief that will become a 4-page PDF sales document.

The brief must include:

CATEGORY: [CORPORATE / TECH / HEALTH / STARTUP / SPORTS / ACADEMIC / ECO]
CATEGORY SELECTION RULE:
- Use SPORTS for gyms, fitness centres, fitness studios, workout businesses, personal training brands, sports clubs, and athletic training businesses.
- Use HEALTH only for clinics, hospitals, dental practices, medical care, wellness clinics, and healthcare providers.
TOPIC: [business name or industry being audited — 5 words max]
TAGLINE: [one sharp sentence about the opportunity found]
AUDIENCE: [who this audit is for — the prospect's business type]
SERVICE PROVIDER: [who is sending this — extract from notes or write "Our Agency"]
CONTACT: [email or phone if mentioned, otherwise write "contact@youragency.com"]
CURRENT PERIOD: ${currentPeriod}
Use this exact current period. Do not change the year or invent another date.
OPPORTUNITY SCORE: [a number 60-95 representing how strong this lead is]

PROBLEMS SECTION:
SUMMARY: [2 sentences about what was found wrong]
PROBLEM 1 TITLE: [short sharp title]
PROBLEM 1 DETAIL: [2 sentences explaining this specific problem and its impact]
PROBLEM 2 TITLE: [short sharp title]
PROBLEM 2 DETAIL: [2 sentences]
PROBLEM 3 TITLE: [short sharp title]
PROBLEM 3 DETAIL: [2 sentences]
PROBLEM 4 TITLE: [short sharp title]
PROBLEM 4 DETAIL: [2 sentences]
IMPACT PERCENT: [number 40-85 representing % revenue at risk]

OPPORTUNITY SECTION:
OPPORTUNITY HEADLINE: [bold 6-word statement about the growth potential]
OPPORTUNITY SUMMARY: [2 sentences about the market opportunity]
STAT 1 VALUE: [number with unit — e.g. 3x or 68% or ₹2.4L]
STAT 1 LABEL: [what it measures — 3-4 words]
STAT 2 VALUE: [number]
STAT 2 LABEL: [3-4 words]
STAT 3 VALUE: [number]
STAT 3 LABEL: [3-4 words]

COMPARISON TABLE:
COL1: [first column header]
COL2: [second column header — e.g. "Current State"]
COL3: [third column header — e.g. "With Our Solution"]
ROW1: [aspect | current | improved]
ROW2: [aspect | current | improved]
ROW3: [aspect | current | improved]
ROW4: [aspect | current | improved]

SOLUTION SECTION:
SOLUTION SUMMARY: [2 sentences about what you will do for them]
SERVICE 1 TITLE: [3-4 words]
SERVICE 1 DETAIL: [2 sentences]
SERVICE 2 TITLE: [3-4 words]
SERVICE 2 DETAIL: [2 sentences]
SERVICE 3 TITLE: [3-4 words]
SERVICE 3 DETAIL: [2 sentences]
SERVICE 4 TITLE: [3-4 words]
SERVICE 4 DETAIL: [2 sentences]
STEP 1: [what happens in week 1 — 5 words]
STEP 2: [what happens in weeks 2-3 — 5 words]
STEP 3: [what happens in week 4 — 5 words]
STEP 4: [ongoing work — 5 words]
CTA HEADING: [3-5 word call to action]
CTA DESCRIPTION: [2 sentences — urgency, next step, benefit]

Input notes:
${rawNotes}
`;
}
async function generateBriefFromNotes(rawNotes) {
  const prompt = buildBriefPrompt(rawNotes);
  const brief = await callGemini(prompt, 8192, 0.7);
  return brief;
}

// ─────────────────────────────────────────────
// GENERATE RESEARCH BRIEF HELPER
// ─────────────────────────────────────────────
async function generateHtmlFromBrief(brief) {
  const prompt = buildHtmlPrompt(brief);

  // HTML output is huge, so allow Gemini to generate much more text
  let html = await callGemini(prompt, 50000, 0.5);

  html = cleanHtml(html);

  // Safety check: this report template should contain 9 .page sections
  const pageCount = (html.match(/class="page/g) || []).length;

  if (pageCount < 9) {
    throw new Error(
      `Generated HTML looks incomplete. Only ${pageCount} page sections found. Expected 9.`
    );
  }

  if (!html.includes("</html>")) {
    throw new Error("Generated HTML is incomplete. Closing </html> tag is missing.");
  }

  return html;
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
// ─────────────────────────────────────────────
// AUDIT HTML PROMPT BUILDER
// Designed for B2B lead audit PDFs
// 4 pages: Cover, Problems, Opportunity, Solution
// ─────────────────────────────────────────────
function buildHtmlPrompt(brief) {
  return `
RULES — NEVER BREAK:
1. Output ONLY raw HTML starting with <!DOCTYPE html> ending with </html>
2. Never output calculations, notes, or explanations anywhere
3. Every [IMG:] tag write 6 specific keywords: [IMG:k1 k2 k3 k4 k5 k6]
4. Replace every placeholder with real content from the brief
5. Never write placeholder text like FILL or REPLACE in final HTML

THEME — read CATEGORY from brief and set these exact CSS variables:
CORPORATE: --c1:#0D47A1  --c2:#1976D2  --dark:#0A1628  --bg:#F8FAFC
TECH:       --c1:#4A00E0  --c2:#00D4FF  --dark:#0D0020  --bg:#F5F0FF
HEALTH:     --c1:#1B5E20  --c2:#43A047  --dark:#0A1A0A  --bg:#F1F8E9
STARTUP:    --c1:#BF360C  --c2:#FF6D00  --dark:#1A0800  --bg:#FFF8F1
SPORTS:     --c1:#C62828  --c2:#FF6B35  --dark:#1A0A0A  --bg:#F9F9F9
ACADEMIC:   --c1:#4A148C  --c2:#7B1FA2  --dark:#0D0020  --bg:#F3E5F5
ECO:        --c1:#00695C  --c2:#00ACC1  --dark:#001A16  --bg:#E0F2F1

IMAGE RULES:
IMAGE RULES:
[IMG:keywords] goes on cover page and page 3 only.

The [IMG:...] marker must be written as plain standalone text, exactly like this:
[IMG:keyword1 keyword2 keyword3 keyword4 keyword5 keyword6]

Do NOT wrap [IMG:...] inside:
- <img>
- src=""
- quotes
- divs
- any HTML tag

Correct:
[IMG:modern dental clinic reception professional interior sunlight]

Wrong:
<img src="[IMG:modern dental clinic reception professional interior sunlight]" alt="Background">

Place the plain [IMG:...] marker as the first element inside that image container.

OUTPUT EXACTLY THIS 4-PAGE HTML — fill every field from brief:

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
  --gray: #6B7280;
  --light: #F3F4F6;
}
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family:'Inter',sans-serif; }

/* ── Every page = exactly one A4 page ── */
.page {
  width:210mm; height:297mm;
  overflow:hidden; position:relative;
  page-break-before:always; break-before:page;
}
.page-cover { page-break-before:avoid; break-before:avoid; }

/* ── PAGE 1: COVER ── */
.cover { background:var(--dark); }
.cover .bg-img {
  position:absolute; inset:0;
  width:100%; height:100%;
  object-fit:cover; opacity:0.35; display:block;
}
.cover .overlay {
  position:absolute; inset:0;
  background:linear-gradient(170deg, transparent 0%, var(--dark) 55%);
}
.cover .body {
  position:absolute; inset:0; z-index:2;
  display:flex; flex-direction:column;
  justify-content:space-between;
  padding:50px 60px 52px;
}
.cover-top { display:flex; justify-content:space-between; align-items:flex-start; }
.cover-badge {
  background:var(--c1); color:#fff;
  padding:8px 18px; border-radius:4px;
  font-size:10px; font-weight:700;
  letter-spacing:3px; text-transform:uppercase;
}
.cover-date {
  font-size:12px; color:rgba(255,255,255,0.62);
  font-weight:400;
}
.cover-middle { margin-top:auto; padding-bottom:40px; }
.cover-label {
  font-size:11px; font-weight:600;
  color:var(--c2); letter-spacing:2px;
  text-transform:uppercase; margin-bottom:16px;
}
.cover h1 {
  font-family:'Playfair Display',serif;
  font-size:54px; font-weight:900; line-height:1.05;
  color:#fff; margin-bottom:16px; max-width:680px;
}
.cover .tagline {
  font-size:16px; font-weight:300;
  color:rgba(255,255,255,0.6);
  max-width:500px; line-height:1.75;
}
.cover-footer {
  display:flex; justify-content:space-between;
  align-items:flex-end;
  padding-top:24px;
  border-top:1px solid rgba(255,255,255,0.1);
}
.cover-meta-row { display:flex; gap:40px; }
.cover-meta { font-size:11.5px; color:rgba(255,255,255,0.58); }
.cover-meta strong {
  display:block; color:#fff;
  font-size:13px; font-weight:600; margin-top:4px;
}
.cover-score {
  text-align:right;
}
.cover-score .score-num {
  font-family:'Playfair Display',serif;
  font-size:52px; font-weight:900;
  color:var(--c2); line-height:1;
}
.cover-score .score-label {
  font-size:10px; color:rgba(255,255,255,0.4);
  text-transform:uppercase; letter-spacing:1px;
}

/* ── PAGE 2: PROBLEMS FOUND ── */
.page-problems { background:var(--dark); }
.problems-header {
  width:100%; height:38mm;
  background:linear-gradient(135deg, rgba(255,255,255,0.03), rgba(255,255,255,0.01));
  border-bottom:1px solid rgba(255,255,255,0.07);
  display:flex; align-items:center;
  justify-content:space-between;
  padding:0 52px; overflow:hidden; position:relative;
}
.problems-header::after {
  content:''; position:absolute;
  right:-30px; top:-50px;
  width:180px; height:180px; border-radius:50%;
  background:var(--c1); opacity:0.08;
}
.ph-left { z-index:1; }
.section-lbl {
  font-size:10px; font-weight:700;
  letter-spacing:3px; text-transform:uppercase;
  color:rgba(255,255,255,0.35); margin-bottom:8px;
}
.section-h { 
  font-family:'Inter',sans-serif;
  font-size:26px; font-weight:800; color:#fff;
}
.ph-num {
  font-family:'Playfair Display',serif;
  font-size:80px; font-weight:900;
  color:var(--c1); opacity:0.15;
  font-style:italic; line-height:1;
}
.problems-body { padding:28px 52px 28px; overflow:hidden; }
.section-intro {
  font-size:14px; line-height:1.75;
  color:rgba(255,255,255,0.78);
  margin-bottom:22px; max-width:620px;
}

/* Problem cards */
.prob-list { display:flex; flex-direction:column; gap:10px; margin-bottom:22px; }
.prob-item {
  background:rgba(255,255,255,0.04);
  border-radius:10px; padding:16px 20px;
  border-left:3px solid var(--c1);
  display:flex; align-items:flex-start; gap:16px;
}
.prob-num {
  font-family:'Playfair Display',serif;
  font-size:28px; font-weight:900;
  color:var(--c1); opacity:0.5;
  line-height:1; flex-shrink:0;
  min-width:30px;
}
.prob-content {}
.prob-title {
  font-size:13px; font-weight:700;
  color:#fff; margin-bottom:5px;
  text-transform:uppercase; letter-spacing:0.5px;
}
.prob-desc {
  font-size:13px; color:rgba(255,255,255,0.76);
  line-height:1.6; margin:0;
}

/* Impact bar */
.impact-row {
  background:rgba(255,255,255,0.03);
  border-radius:8px; padding:14px 18px;
  display:flex; align-items:center; gap:16px;
}
.impact-label {
  font-size:10px; font-weight:700;
  text-transform:uppercase; letter-spacing:1px;
  color:rgba(255,255,255,0.35); white-space:nowrap;
}
.impact-bar-wrap {
  flex:1; height:6px;
  background:rgba(255,255,255,0.08); border-radius:3px;
}
.impact-bar {
  height:100%; border-radius:3px;
  background:linear-gradient(90deg, var(--c1), var(--c2));
}
.impact-val {
  font-size:12px; font-weight:700;
  color:var(--c2); white-space:nowrap;
}

/* ── PAGE 3: OPPORTUNITY ── */
.page-opp { background:var(--bg); display:flex; flex-direction:column; }
.opp-photo {
  width:100%; height:100mm;
  position:relative; overflow:hidden; flex-shrink:0;
}
.opp-photo img {
  width:100%; height:100%; object-fit:cover; display:block;
}
.opp-photo-overlay {
  position:absolute; inset:0;
  background:linear-gradient(180deg, transparent 20%, rgba(0,0,0,0.5) 100%);
}
.opp-photo-text {
  position:absolute; bottom:0; left:0; right:0;
  padding:20px 52px 24px;
}
.opp-photo-title {
  font-family:'Playfair Display',serif;
  font-size:28px; font-weight:900;
  color:#fff; line-height:1.2;
}
.opp-body { 
  flex:1; padding:24px 52px 28px; 
  overflow:hidden; background:var(--bg);
}

/* Opportunity stats */
.opp-stats { display:grid; grid-template-columns:1fr 1fr 1fr; gap:10px; margin-bottom:18px; }
.opp-stat {
  background:var(--white); border-radius:10px;
  padding:16px 14px; text-align:center;
  border-top:3px solid var(--c1);
  box-shadow:0 1px 6px rgba(0,0,0,0.07);
}
.opp-stat-num {
  font-family:'Playfair Display',serif;
  font-size:36px; font-weight:900;
  color:var(--c1); line-height:1;
}
.opp-stat-label {
  font-size:9px; color:var(--gray);
  margin-top:5px; text-transform:uppercase;
  letter-spacing:1px;
}

/* Comparison table */
.comp-table-wrap {
  border-radius:9px; overflow:hidden;
  box-shadow:0 2px 10px rgba(0,0,0,0.08);
}
.comp-table { width:100%; border-collapse:collapse; background:var(--white); }
.comp-table thead { background:var(--dark); }
.comp-table thead th {
  padding:10px 14px; text-align:left;
  font-size:10px; font-weight:700;
  letter-spacing:1.5px; text-transform:uppercase; color:#fff;
}
.comp-table tbody tr:nth-child(even) { background:var(--light); }
.comp-table tbody td {
  padding:9px 14px; font-size:12px;
  color:#374151; border-bottom:1px solid #E5E7EB;
  line-height:1.4;
}
.comp-table tbody tr:last-child td { border-bottom:none; }

/* ── PAGE 4: SOLUTION + CTA ── */
.page-solution { background:var(--dark); }
.solution-header {
  width:100%; height:38mm;
  background:linear-gradient(135deg, rgba(255,255,255,0.03), transparent);
  border-bottom:1px solid rgba(255,255,255,0.07);
  display:flex; align-items:center;
  justify-content:space-between; padding:0 52px;
  position:relative; overflow:hidden;
}
.solution-header::before {
  content:''; position:absolute;
  left:-30px; bottom:-40px;
  width:160px; height:160px; border-radius:50%;
  background:var(--c2); opacity:0.06;
}
.solution-body { padding:28px 52px 28px; overflow:hidden; }

/* Service cards */
.service-grid {
  display:grid; grid-template-columns:1fr 1fr;
  gap:10px; margin-bottom:18px;
}
.service-card {
  background:rgba(255,255,255,0.05);
  border-radius:10px; padding:16px 18px;
  border-top:2px solid var(--c1);
}
.service-card h3 {
  font-size:12px; font-weight:700;
  color:#fff; margin-bottom:6px;
  text-transform:uppercase; letter-spacing:0.5px;
}
.service-card p {
  font-size:12.5px; color:rgba(255,255,255,0.76);
  line-height:1.6; margin:0;
}

/* Timeline */
.timeline { margin-bottom:18px; }
.timeline-title {
  font-size:10px; font-weight:700;
  color:rgba(255,255,255,0.35);
  text-transform:uppercase; letter-spacing:2px;
  margin-bottom:12px;
}
.timeline-row {
  display:flex; gap:0; margin-bottom:8px;
}
.timeline-step {
  flex:1; background:rgba(255,255,255,0.04);
  padding:10px 14px; position:relative;
}
.timeline-step:first-child { border-radius:8px 0 0 8px; }
.timeline-step:last-child { border-radius:0 8px 8px 0; }
.timeline-step + .timeline-step { border-left:1px solid rgba(255,255,255,0.06); }
.step-num {
  font-size:9px; color:var(--c2);
  font-weight:700; margin-bottom:4px;
}
.step-label {
  font-size:12px; color:rgba(255,255,255,0.82);
  font-weight:500; line-height:1.4;
}

/* CTA box */
.cta-box {
  background:linear-gradient(135deg, var(--c1), var(--c2));
  border-radius:12px; padding:22px 28px;
  display:flex; align-items:center;
  justify-content:space-between; gap:24px;
}
.cta-left {}
.cta-heading {
  font-family:'Playfair Display',serif;
  font-size:20px; font-weight:900;
  color:#fff; margin-bottom:6px;
}
.cta-sub {
  font-size:12px; color:rgba(255,255,255,0.8);
  line-height:1.6; margin:0;
}
.cta-right { flex-shrink:0; text-align:right; }
.cta-contact {
  font-size:11px; color:rgba(255,255,255,0.6);
  margin-bottom:4px;
}
.cta-contact strong {
  display:block; color:#fff;
  font-size:14px; font-weight:700; margin-top:2px;
}
</style>
</head>
<body>

<!-- ═══════════════════════════
     PAGE 1: COVER
═══════════════════════════ -->
<div class="page page-cover cover">
[IMG:professional business industry photo matching the target business sector]
<div class="overlay"></div>
<div class="body">
  <div class="cover-top">
    <div class="cover-badge">Growth Audit Report</div>
    <div class="cover-date">Prepared: Copy current period from brief</div>
  </div>
  <div class="cover-middle">
    <div class="cover-label">Confidential — Prepared For</div>
    <h1>Copy the TARGET BUSINESS NAME or INDUSTRY from brief</h1>
    <p class="tagline">Copy TAGLINE from brief exactly here.</p>
  </div>
  <div class="cover-footer">
    <div class="cover-meta-row">
      <div class="cover-meta">Prepared By <strong>Copy SERVICE PROVIDER from brief</strong></div>
      <div class="cover-meta">Service <strong>Copy main service offered from brief</strong></div>
      <div class="cover-meta">Report Type <strong>Growth Opportunity Audit</strong></div>
    </div>
    <div class="cover-score">
      <div class="score-num">Copy SCORE from brief</div>
      <div class="score-label">Opportunity Score</div>
    </div>
  </div>
</div>
</div>

<!-- ═══════════════════════════
     PAGE 2: PROBLEMS FOUND
═══════════════════════════ -->
<div class="page page-problems">
<div class="problems-header">
  <div class="ph-left">
    <div class="section-lbl">02 / Analysis</div>
    <div class="section-h">Problems We Identified</div>
  </div>
  <div class="ph-num">02</div>
</div>
<div class="problems-body">
  <p class="section-intro">Copy SUMMARY sentence 1 and 2 from Problems section of brief.</p>
  <div class="prob-list">
    <div class="prob-item">
      <div class="prob-num">01</div>
      <div class="prob-content">
        <div class="prob-title">Copy PROBLEM 1 TITLE from brief</div>
        <p class="prob-desc">Copy PROBLEM 1 DETAIL from brief — 2 sentences max.</p>
      </div>
    </div>
    <div class="prob-item">
      <div class="prob-num">02</div>
      <div class="prob-content">
        <div class="prob-title">Copy PROBLEM 2 TITLE from brief</div>
        <p class="prob-desc">Copy PROBLEM 2 DETAIL from brief — 2 sentences max.</p>
      </div>
    </div>
    <div class="prob-item">
      <div class="prob-num">03</div>
      <div class="prob-content">
        <div class="prob-title">Copy PROBLEM 3 TITLE from brief</div>
        <p class="prob-desc">Copy PROBLEM 3 DETAIL from brief — 2 sentences max.</p>
      </div>
    </div>
    <div class="prob-item">
      <div class="prob-num">04</div>
      <div class="prob-content">
        <div class="prob-title">Copy PROBLEM 4 TITLE from brief</div>
        <p class="prob-desc">Copy PROBLEM 4 DETAIL from brief — 2 sentences max.</p>
      </div>
    </div>
  </div>
  <div class="impact-row">
    <div class="impact-label">Overall Impact Risk</div>
    <div class="impact-bar-wrap">
      <div class="impact-bar" style="width:IMPACT_PERCENT%;"></div>
    </div>
    <div class="impact-val">IMPACT_PERCENT% Revenue at Risk</div>
  </div>
</div>
</div>

<!-- ═══════════════════════════
     PAGE 3: OPPORTUNITY
═══════════════════════════ -->
<div class="page page-opp">
<div class="opp-photo">
[IMG:business growth success professional team working results opportunity]
<div class="opp-photo-overlay"></div>
<div class="opp-photo-text">
  <div class="opp-photo-title">Copy OPPORTUNITY HEADLINE from brief</div>
</div>
</div>
<div class="opp-body">
  <p class="section-intro" style="color:#374151;margin-bottom:16px;">Copy OPPORTUNITY SUMMARY sentence 1 and 2 from brief.</p>
  <div class="opp-stats">
    <div class="opp-stat">
      <div class="opp-stat-num">Copy STAT 1 VALUE</div>
      <div class="opp-stat-label">Copy STAT 1 LABEL</div>
    </div>
    <div class="opp-stat">
      <div class="opp-stat-num">Copy STAT 2 VALUE</div>
      <div class="opp-stat-label">Copy STAT 2 LABEL</div>
    </div>
    <div class="opp-stat">
      <div class="opp-stat-num">Copy STAT 3 VALUE</div>
      <div class="opp-stat-label">Copy STAT 3 LABEL</div>
    </div>
  </div>
  <div class="comp-table-wrap">
    <table class="comp-table">
      <thead>
        <tr><th>Copy COL1 from brief</th><th>Copy COL2 from brief</th><th>Copy COL3 from brief</th></tr>
      </thead>
      <tbody>
        <tr><td>ROW1 val1</td><td>ROW1 val2</td><td>ROW1 val3</td></tr>
        <tr><td>ROW2 val1</td><td>ROW2 val2</td><td>ROW2 val3</td></tr>
        <tr><td>ROW3 val1</td><td>ROW3 val2</td><td>ROW3 val3</td></tr>
        <tr><td>ROW4 val1</td><td>ROW4 val2</td><td>ROW4 val3</td></tr>
      </tbody>
    </table>
  </div>
</div>
</div>

<!-- ═══════════════════════════
     PAGE 4: SOLUTION + CTA
═══════════════════════════ -->
<div class="page page-solution">
<div class="solution-header">
  <div class="ph-left">
    <div class="section-lbl">04 / Solution</div>
    <div class="section-h">How We Fix This</div>
  </div>
  <div class="ph-num">04</div>
</div>
<div class="solution-body">
  <p class="section-intro">Copy SOLUTION SUMMARY sentence 1 and 2 from brief.</p>
  <div class="service-grid">
    <div class="service-card">
      <h3>Copy SERVICE 1 TITLE from brief</h3>
      <p>Copy SERVICE 1 DETAIL from brief — 2 sentences.</p>
    </div>
    <div class="service-card">
      <h3>Copy SERVICE 2 TITLE from brief</h3>
      <p>Copy SERVICE 2 DETAIL from brief — 2 sentences.</p>
    </div>
    <div class="service-card">
      <h3>Copy SERVICE 3 TITLE from brief</h3>
      <p>Copy SERVICE 3 DETAIL from brief — 2 sentences.</p>
    </div>
    <div class="service-card">
      <h3>Copy SERVICE 4 TITLE from brief</h3>
      <p>Copy SERVICE 4 DETAIL from brief — 2 sentences.</p>
    </div>
  </div>
  <div class="timeline">
    <div class="timeline-title">Implementation Timeline</div>
    <div class="timeline-row">
      <div class="timeline-step">
        <div class="step-num">WEEK 1</div>
        <div class="step-label">Copy STEP 1 from brief</div>
      </div>
      <div class="timeline-step">
        <div class="step-num">WEEK 2-3</div>
        <div class="step-label">Copy STEP 2 from brief</div>
      </div>
      <div class="timeline-step">
        <div class="step-num">WEEK 4</div>
        <div class="step-label">Copy STEP 3 from brief</div>
      </div>
      <div class="timeline-step">
        <div class="step-num">ONGOING</div>
        <div class="step-label">Copy STEP 4 from brief</div>
      </div>
    </div>
  </div>
  <div class="cta-box">
    <div class="cta-left">
      <div class="cta-heading">Copy CTA HEADING from brief</div>
      <p class="cta-sub">Copy CTA DESCRIPTION from brief — 2 sentences max.</p>
    </div>
    <div class="cta-right">
      <div class="cta-contact">Contact Us
        <strong>Copy CONTACT from brief</strong>
      </div>
    </div>
  </div>
</div>
</div>

</body>
</html>

Research brief for this audit:
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
// SIMPLE HTML → READABLE TEXT CLEANER
// Used for website analysis
// ─────────────────────────────────────────────
function extractReadableTextFromHtml(html) {
  if (!html || typeof html !== "string") return "";

  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 12000);
}

// ─────────────────────────────────────────────
// ROUTE 5 — ANALYZE A LEAD WEBSITE
// POST /analyze-lead
// Body:
// {
//   "business_name": "...",
//   "website": "...",
//   "service_offered": "..."
// }
// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
// ROUTE 5 — ANALYZE A LEAD
// Supports:
// - website available
// - no website
// - Instagram only
// - Google Maps only
// - phone/manual notes
// POST /analyze-lead
// ─────────────────────────────────────────────
app.post("/analyze-lead", async (req, res) => {
  try {
    const {
      business_name,
      website,
      google_maps_url,
      instagram_url,
      phone,
      notes,
      service_offered
    } = req.body;

    if (!business_name || typeof business_name !== "string") {
      return res.status(400).json({
        success: false,
        error: "business_name is required"
      });
    }

    if (!service_offered || typeof service_offered !== "string") {
      return res.status(400).json({
        success: false,
        error: "service_offered is required"
      });
    }

    const hasAnyContext =
      website ||
      google_maps_url ||
      instagram_url ||
      phone ||
      notes;

    if (!hasAnyContext) {
      return res.status(400).json({
        success: false,
        error:
          "Provide at least one of: website, google_maps_url, instagram_url, phone, or notes"
      });
    }

    console.log(`🔎 Analyzing lead: ${business_name}`);

    let websiteText = "";
    let websiteFetchStatus = "No website provided";

    if (website && typeof website === "string") {
      try {
        console.log(`🌐 Fetching website: ${website}`);

        const siteResponse = await axios.get(website, {
          timeout: 15000,
          headers: {
            "User-Agent":
              "Mozilla/5.0 (compatible; LeadResearchBot/1.0)"
          }
        });

        websiteText = extractReadableTextFromHtml(siteResponse.data);

        if (!websiteText || websiteText.length < 120) {
          websiteFetchStatus =
            "Website loaded, but readable content was limited.";
        } else {
          websiteFetchStatus =
            "Website content extracted successfully.";
        }
      } catch (siteError) {
        console.log("⚠️ Website fetch failed:", siteError.message);
        websiteFetchStatus =
          "Website was provided but could not be fetched automatically.";
      }
    }

    const prompt = `
You are a B2B lead qualification analyst.

Your job is to assess whether this business is a good prospect for the sender's service and identify realistic outreach angles.

BUSINESS:
Name: ${business_name}
Website: ${website || "No official website provided"}
Google Maps URL: ${google_maps_url || "Not provided"}
Instagram URL: ${instagram_url || "Not provided"}
Phone: ${phone || "Not provided"}
Manual Notes: ${notes || "None"}

SERVICE OFFERED BY SENDER:
${service_offered}

WEBSITE FETCH STATUS:
${websiteFetchStatus}

WEBSITE TEXT EXTRACTED:
${websiteText || "No readable website text available."}

Return ONLY valid JSON. No markdown. No explanations outside JSON.

Use this exact structure:

{
  "business_name": "",
  "website": "",
  "has_website": true,
  "lead_score": 0,
  "lead_quality": "Low | Medium | High",
  "one_line_opportunity": "",
  "visible_strengths": [
    "",
    ""
  ],
  "problems_found": [
    {
      "title": "",
      "detail": "",
      "severity": "Low | Medium | High"
    },
    {
      "title": "",
      "detail": "",
      "severity": "Low | Medium | High"
    },
    {
      "title": "",
      "detail": "",
      "severity": "Low | Medium | High"
    },
    {
      "title": "",
      "detail": "",
      "severity": "Low | Medium | High"
    }
  ],
  "why_they_may_need_this_service": "",
  "personalization_angle": "",
  "best_outreach_channel": "Email | Instagram DM | Phone | WhatsApp | Unknown",
  "audit_pdf_raw_notes": ""
}

Rules:
- lead_score must be from 1 to 100.
- If no website is provided, treat that as a major opportunity when the sender service includes website or lead funnel work.
- If website exists, analyze based on the extracted evidence.
- If evidence is limited, use careful language like "possible", "appears", or "may".
- Do not invent specific claims like review counts or rankings unless they appear in the provided text or notes.
- best_outreach_channel must only use contact channels that are actually provided.
- If phone is provided, Phone or WhatsApp may be used.
- If instagram_url is provided, Instagram DM may be used.
- If website/contact email is clearly available in provided data, Email may be used.
- If no usable contact channel is provided, return "Unknown".
- audit_pdf_raw_notes must be a strong paragraph that can directly generate a 4-page audit PDF.
- The audit notes should include:
  business name,
  available online presence,
  whether they lack a website,
  key problems,
  growth opportunity,
  and the service offered.
`;

    const geminiText = await callGemini(prompt, 8192, 0.4);

    let analysis;

    try {
      const cleaned = geminiText
        .replace(/```json\s*/gi, "")
        .replace(/```\s*/gi, "")
        .trim();

      analysis = JSON.parse(cleaned);
    } catch (parseError) {
      return res.status(500).json({
        success: false,
        error: "Gemini returned analysis, but JSON parsing failed",
        raw_response: geminiText
      });
    }

    return res.json({
      success: true,
      website_fetch_status: websiteFetchStatus,
      analysis
    });

  } catch (error) {
    console.error("ANALYZE LEAD ERROR:", error);

    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});
// ─────────────────────────────────────────────
// ROUTE 6 — GENERATE OUTREACH + AUDIT PDF
// POST /generate-outreach
// Body:
// {
//   "analysis": { ...result from /analyze-lead... },
//   "sender_name": "Sri Nath",
//   "sender_business": "Your Agency Name",
//   "sender_service": "website redesign, local SEO, and booking automation"
// }
// ─────────────────────────────────────────────
app.post("/generate-outreach", async (req, res) => {
  try {
    const {
      analysis,
      sender_name,
      sender_business,
      sender_service
    } = req.body;

    if (!analysis || typeof analysis !== "object") {
      return res.status(400).json({
        success: false,
        error: "analysis object is required"
      });
    }

    if (!sender_name || typeof sender_name !== "string") {
      return res.status(400).json({
        success: false,
        error: "sender_name is required"
      });
    }

    if (!sender_business || typeof sender_business !== "string") {
      return res.status(400).json({
        success: false,
        error: "sender_business is required"
      });
    }

    if (!sender_service || typeof sender_service !== "string") {
      return res.status(400).json({
        success: false,
        error: "sender_service is required"
      });
    }

    console.log(`✉️ Generating outreach for: ${analysis.business_name}`);

    // ── Step 1: Generate personalized outreach email ──
    const outreachPrompt = `
You are an expert B2B cold email copywriter.

Write a personalized outreach message for this lead.

LEAD ANALYSIS:
${JSON.stringify(analysis, null, 2)}

SENDER:
Name: ${sender_name}
Business: ${sender_business}
Service Offered: ${sender_service}

Return ONLY valid JSON. No markdown. No explanation.

Use exactly this structure:

{
  "subject": "",
  "opening_line": "",
  "email_body": "",
  "call_to_action": "",
  "why_personalized": ""
}

Rules:
- Sound human and professional, not spammy.
- Mention one specific problem from the lead analysis.
- Keep the full email concise and useful.
- Do not exaggerate.
- Do not claim you reviewed anything that the analysis did not support.
- The CTA should invite a short call or reply.
- Do not mention AI.
`;

    const outreachText = await callGemini(outreachPrompt, 4096, 0.5);

    let outreach;

    try {
      const cleaned = outreachText
        .replace(/```json\s*/gi, "")
        .replace(/```\s*/gi, "")
        .trim();

      outreach = JSON.parse(cleaned);
    } catch (parseError) {
      return res.status(500).json({
        success: false,
        error: "Gemini outreach JSON parsing failed",
        raw_response: outreachText
      });
    }

    // ── Step 2: Generate 4-page audit PDF from audit notes ──
    const auditNotes = analysis.audit_pdf_raw_notes;

    if (!auditNotes || typeof auditNotes !== "string") {
      return res.status(400).json({
        success: false,
        error: "analysis.audit_pdf_raw_notes is missing"
      });
    }

    console.log("📄 Generating personalized audit PDF...");

    const brief = await generateBriefFromNotes(auditNotes);
    const html = await generateHtmlFromBrief(brief);
    const pdfUrl = await createPdfFromHtml(html, req);

    console.log("✅ Outreach + PDF complete");

    return res.json({
      success: true,
      outreach,
      pdf_url: pdfUrl
    });

  } catch (error) {
    console.error("GENERATE OUTREACH ERROR:", error);

    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});
// ─────────────────────────────────────────────
// ROUTE 7 — PROCESS ONE LEAD FULLY
// Analyze lead → Generate outreach → Generate PDF
// POST /process-lead
// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
// ROUTE 7 — PROCESS ONE LEAD FULLY
// Analyze lead → Generate outreach → Generate PDF
// Works with or without a website
// POST /process-lead
// ─────────────────────────────────────────────
app.post("/process-lead", async (req, res) => {
  try {
    const {
      business_name,
      website,
      google_maps_url,
      instagram_url,
      phone,
      notes,
      service_offered,
      sender_name,
      sender_business
    } = req.body;

    if (!business_name || typeof business_name !== "string") {
      return res.status(400).json({
        success: false,
        error: "business_name is required"
      });
    }

    if (!service_offered || typeof service_offered !== "string") {
      return res.status(400).json({
        success: false,
        error: "service_offered is required"
      });
    }

    if (!sender_name || typeof sender_name !== "string") {
      return res.status(400).json({
        success: false,
        error: "sender_name is required"
      });
    }

    if (!sender_business || typeof sender_business !== "string") {
      return res.status(400).json({
        success: false,
        error: "sender_business is required"
      });
    }

    const hasAnyContext =
      website ||
      google_maps_url ||
      instagram_url ||
      phone ||
      notes;

    if (!hasAnyContext) {
      return res.status(400).json({
        success: false,
        error:
          "Provide at least one of: website, google_maps_url, instagram_url, phone, or notes"
      });
    }

    console.log(`\n=== PROCESSING FULL LEAD: ${business_name} ===`);

    const baseUrl = `${req.protocol}://${req.get("host")}`;

    console.log("Step 1: Analyzing lead...");

    const analyzeRes = await axios.post(
      `${baseUrl}/analyze-lead`,
      {
        business_name,
        website,
        google_maps_url,
        instagram_url,
        phone,
        notes,
        service_offered
      },
      { timeout: 180000 }
    );

    if (!analyzeRes.data.success) {
      throw new Error("Lead analysis failed");
    }

    const analysis = analyzeRes.data.analysis;

    console.log("✅ Lead analysis complete");

    console.log("Step 2: Generating outreach + PDF...");

    const outreachRes = await axios.post(
      `${baseUrl}/generate-outreach`,
      {
        analysis,
        sender_name,
        sender_business,
        sender_service: service_offered
      },
      { timeout: 300000 }
    );

    if (!outreachRes.data.success) {
      throw new Error("Outreach generation failed");
    }

    console.log("🎉 Full lead processing complete");

    return res.json({
      success: true,
      lead: {
        business_name,
        website: website || "",
        google_maps_url: google_maps_url || "",
        instagram_url: instagram_url || "",
        phone: phone || ""
      },
      analysis,
      outreach: outreachRes.data.outreach,
      pdf_url: outreachRes.data.pdf_url
    });

  } catch (error) {
    console.error("PROCESS LEAD ERROR:", error.message);

    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});
// ─────────────────────────────────────────────
// ROUTE 8 — PROCESS MULTIPLE LEADS
// Max 3 leads per request for stability
// POST /process-leads
// ─────────────────────────────────────────────
app.post("/process-leads", async (req, res) => {
  try {
    const {
      leads,
      service_offered,
      sender_name,
      sender_business
    } = req.body;

    if (!Array.isArray(leads) || leads.length === 0) {
      return res.status(400).json({
        success: false,
        error: "leads must be a non-empty array"
      });
    }

    if (leads.length > 3) {
      return res.status(400).json({
        success: false,
        error: "Maximum 3 leads allowed per request for now"
      });
    }

    if (!service_offered || typeof service_offered !== "string") {
      return res.status(400).json({
        success: false,
        error: "service_offered is required"
      });
    }

    if (!sender_name || typeof sender_name !== "string") {
      return res.status(400).json({
        success: false,
        error: "sender_name is required"
      });
    }

    if (!sender_business || typeof sender_business !== "string") {
      return res.status(400).json({
        success: false,
        error: "sender_business is required"
      });
    }

    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const results = [];

    console.log(`\n=== PROCESSING ${leads.length} LEADS ===`);

    for (let i = 0; i < leads.length; i++) {
      const lead = leads[i];

      const business_name = lead.business_name;
      const website = lead.website;

      if (!business_name || !website) {
        results.push({
          success: false,
          business_name: business_name || "Unknown",
          website: website || "Missing",
          error: "business_name and website are required"
        });
        continue;
      }

      try {
        console.log(`\n▶ Lead ${i + 1}/${leads.length}: ${business_name}`);

        const processRes = await axios.post(
          `${baseUrl}/process-lead`,
          {
            business_name,
            website,
            service_offered,
            sender_name,
            sender_business
          },
          {
            timeout: 600000
          }
        );

        results.push({
          success: true,
          ...processRes.data
        });

        console.log(`✅ Finished: ${business_name}`);

      } catch (leadError) {
        console.error(`❌ Failed: ${business_name}`, leadError.message);

        results.push({
          success: false,
          business_name,
          website,
          error:
            leadError.response?.data?.error ||
            leadError.message ||
            "Unknown lead processing error"
        });
      }
    }

    const successCount = results.filter(r => r.success).length;
    const failedCount = results.length - successCount;

    console.log(`🎉 Batch complete: ${successCount} success, ${failedCount} failed`);

    return res.json({
      success: true,
      processed_count: results.length,
      success_count: successCount,
      failed_count: failedCount,
      results
    });

  } catch (error) {
    console.error("PROCESS LEADS ERROR:", error.message);

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