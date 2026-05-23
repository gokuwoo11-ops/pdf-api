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
// SUPABASE HELPERS — REAL SAAS STORAGE LAYER
// ─────────────────────────────────────────────
function getSupabaseConfig() {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const pdfBucket = process.env.SUPABASE_PDF_BUCKET || "pdf-reports";

  if (!url || !serviceRoleKey) {
    throw new Error("Supabase environment variables are missing");
  }

  return {
    url: url.replace(/\/$/, ""),
    serviceRoleKey,
    pdfBucket
  };
}

async function supabaseRequest({ method = "GET", table, query = "", body, headers = {} }) {
  const { url, serviceRoleKey } = getSupabaseConfig();

  const response = await axios({
    method,
    url: `${url}/rest/v1/${table}${query}`,
    data: body,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      ...headers
    },
    timeout: 60000,
    maxBodyLength: Infinity
  });

  return response.data;
}

async function insertOne(table, record) {
  const rows = await supabaseRequest({
    method: "POST",
    table,
    body: record,
    headers: {
      Prefer: "return=representation"
    }
  });

  return Array.isArray(rows) ? rows[0] : rows;
}

async function insertMany(table, records) {
  if (!records.length) return [];

  const rows = await supabaseRequest({
    method: "POST",
    table,
    body: records,
    headers: {
      Prefer: "return=representation"
    }
  });

  return Array.isArray(rows) ? rows : [];
}

async function updateRows(table, query, patch) {
  const rows = await supabaseRequest({
    method: "PATCH",
    table,
    query,
    body: patch,
    headers: {
      Prefer: "return=representation"
    }
  });

  return Array.isArray(rows) ? rows : [];
}

async function findCampaignById(campaignId) {
  if (!campaignId) return null;

  const rows = await supabaseRequest({
    table: "campaigns",
    query: `?id=eq.${encodeURIComponent(campaignId)}&select=*`
  });

  return Array.isArray(rows) ? rows[0] || null : null;
}

async function getCampaignLeadSummary(campaignId) {
  if (!campaignId) {
    return {
      total_leads: 0,
      new_leads: 0,
      processing_leads: 0,
      processed_leads: 0,
      failed_leads: 0
    };
  }

  const rows = await supabaseRequest({
    table: "leads",
    query: `?campaign_id=eq.${encodeURIComponent(campaignId)}&select=processing_status`
  });

  const leadRows = Array.isArray(rows) ? rows : [];
  const summary = {
    total_leads: leadRows.length,
    new_leads: 0,
    processing_leads: 0,
    processed_leads: 0,
    failed_leads: 0
  };

  leadRows.forEach((lead) => {
    const status = String(lead.processing_status || "").toLowerCase();
    if (status === "new") summary.new_leads++;
    else if (status === "processing") summary.processing_leads++;
    else if (status === "processed") summary.processed_leads++;
    else if (status === "failed") summary.failed_leads++;
  });

  return summary;
}

async function findLeadById(leadId) {
  if (!leadId) return null;

  const rows = await supabaseRequest({
    table: "leads",
    query: `?id=eq.${encodeURIComponent(leadId)}&select=*`
  });

  return Array.isArray(rows) ? rows[0] || null : null;
}

async function insertLeadsForCampaign(campaignId, leads) {
  if (!campaignId || !leads.length) return [];

  const campaign = await findCampaignById(campaignId);
  if (!campaign) {
    throw new Error("campaign_id does not exist in Supabase");
  }

  const records = leads.map((lead) => ({
    campaign_id: campaignId,
    business_name: lead.business_name,
    website: lead.website || null,
    google_maps_url: lead.google_maps_url || null,
    instagram_url: lead.instagram_url || null,
    phone: lead.phone || null,
    email: lead.email || null,
    address: lead.address || null,
    notes: lead.notes || null,
    source: lead.source || "openstreetmap",
    processing_status: "new"
  }));

  return await insertMany("leads", records);
}

async function saveLeadProcessingToSupabase({
  leadId,
  campaignId,
  leadPayload,
  analysis,
  outreach,
  pdfUrl
}) {
  let lead = null;

  if (leadId) {
    lead = await findLeadById(leadId);
    if (!lead) {
      throw new Error("lead_id does not exist in Supabase");
    }
  } else if (campaignId) {
    const campaign = await findCampaignById(campaignId);
    if (!campaign) {
      throw new Error("campaign_id does not exist in Supabase");
    }

    lead = await insertOne("leads", {
      campaign_id: campaignId,
      business_name: leadPayload.business_name,
      website: leadPayload.website || null,
      google_maps_url: leadPayload.google_maps_url || null,
      instagram_url: leadPayload.instagram_url || null,
      phone: leadPayload.phone || null,
      email: leadPayload.email || null,
      address: leadPayload.address || null,
      notes: leadPayload.notes || null,
      source: leadPayload.source || "manual_or_api",
      processing_status: "processing"
    });
  }

  if (!lead) {
    return {
      saved: false,
      lead_id: null
    };
  }

  await insertOne("lead_analyses", {
    lead_id: lead.id,
    lead_score: analysis.lead_score ?? null,
    lead_quality: analysis.lead_quality || null,
    one_line_opportunity: analysis.one_line_opportunity || null,
    visible_strengths: analysis.visible_strengths || [],
    problems_found: analysis.problems_found || [],
    why_they_may_need_this_service: analysis.why_they_may_need_this_service || null,
    personalization_angle: analysis.personalization_angle || null,
    best_outreach_channel: analysis.best_outreach_channel || null,
    audit_pdf_raw_notes: analysis.audit_pdf_raw_notes || null
  });

  await insertOne("outreach_messages", {
    lead_id: lead.id,
    subject: outreach.subject || null,
    opening_line: outreach.opening_line || null,
    email_body: outreach.email_body || null,
    call_to_action: outreach.call_to_action || null,
    why_personalized: outreach.why_personalized || null
  });

  await insertOne("reports", {
    lead_id: lead.id,
    pdf_url: pdfUrl,
    storage_bucket: process.env.SUPABASE_PDF_BUCKET || "pdf-reports"
  });

  await updateRows(
    "leads",
    `?id=eq.${encodeURIComponent(lead.id)}`,
    {
      processing_status: "processed",
      updated_at: new Date().toISOString()
    }
  );

  return {
    saved: true,
    lead_id: lead.id
  };
}

// ─────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────
app.get("/", (req, res) => {
  res.send("AI Prospecting SaaS API v9 running");
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
// GEMINI HELPER WITH AUTO FALLBACK
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

        if (code === 503) {
          continue;
        }

        throw lastError;
      }

      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;

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
// CREATE CAMPAIGN — REAL SAAS ENTRY POINT
// POST /campaigns
// ─────────────────────────────────────────────
app.post("/campaigns", async (req, res) => {
  try {
    const {
      user_id,
      client_business_name,
      sender_name,
      sender_email,
      service_offer,
      ideal_target_customer,
      target_location,
      outreach_tone = "Professional and concise",
      lead_search_keyword,
      leads_requested = 10,
      status = "ready"
    } = req.body;

    const required = {
      client_business_name,
      sender_name,
      service_offer,
      ideal_target_customer,
      target_location,
      lead_search_keyword
    };

    const missing = Object.entries(required)
      .filter(([, value]) => !value || typeof value !== "string")
      .map(([key]) => key);

    if (missing.length) {
      return res.status(400).json({
        success: false,
        error: `Missing required campaign fields: ${missing.join(", ")}`
      });
    }

    const campaign = await insertOne("campaigns", {
      user_id: user_id || null,
      client_business_name,
      sender_name,
      sender_email: sender_email || null,
      service_offer,
      ideal_target_customer,
      target_location,
      outreach_tone,
      lead_search_keyword,
      leads_requested: Math.min(Math.max(Number(leads_requested) || 10, 1), 25),
      status
    });

    return res.json({
      success: true,
      campaign
    });

  } catch (error) {
    console.error("CREATE CAMPAIGN ERROR:", error.message);

    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get("/campaigns", async (req, res) => {
  try {
    const rows = await supabaseRequest({
      table: "campaigns",
      query: "?select=*&order=created_at.desc"
    });

    const campaigns = Array.isArray(rows) ? rows : [];

    const campaignsWithSummary = await Promise.all(
      campaigns.map(async (campaign) => {
        const summary = await getCampaignLeadSummary(campaign.id);

        return {
          id: campaign.id,
          client_business_name: campaign.client_business_name,
          sender_name: campaign.sender_name,
          sender_email: campaign.sender_email,
          service_offer: campaign.service_offer,
          ideal_target_customer: campaign.ideal_target_customer,
          target_location: campaign.target_location,
          lead_search_keyword: campaign.lead_search_keyword,
          leads_requested: campaign.leads_requested,
          status: campaign.status,
          created_at: campaign.created_at,
          updated_at: campaign.updated_at,
          summary
        };
      })
    );

    return res.json({
      success: true,
      campaigns: campaignsWithSummary
    });

  } catch (error) {
    console.error("GET CAMPAIGNS ERROR:", error.message);

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
      timeout: 30000
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
                el.style.paddingTop = Math.max(5, pad - 1) + "px";
                el.style.paddingBottom = Math.max(5, pad - 1) + "px";
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
                el.style.marginBottom = Math.max(4, mb - 2) + "px";
              }

              if (mt > 4) {
                el.style.marginTop = Math.max(4, mt - 2) + "px";
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

    const name = `report-${Date.now()}.pdf`;
    const { url: supabaseUrl, serviceRoleKey, pdfBucket } = getSupabaseConfig();

    console.log("☁️ Uploading PDF to Supabase Storage...");

    await axios.post(
      `${supabaseUrl}/storage/v1/object/${pdfBucket}/${name}`,
      pdf,
      {
        headers: {
          Authorization: `Bearer ${serviceRoleKey}`,
          apikey: serviceRoleKey,
          "Content-Type": "application/pdf",
          "x-upsert": "true"
        },
        maxBodyLength: Infinity,
        timeout: 60000
      }
    );

    const url = `${supabaseUrl}/storage/v1/object/public/${pdfBucket}/${name}`;

    console.log("🎉 Permanent PDF ready:", url);
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
      html = req.body.html || req.body.answer || req.body.source;
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
SERVICE PROVIDER: [Extract from notes if available. If notes contain "Prepared By:", use that value. If notes contain sender or agency name, use it. NEVER use "Our Agency" or placeholder text. Always use the actual business name provided in the notes.]
CONTACT: [Extract email or phone from notes if mentioned. If notes contain "Contact Email:" or "Contact:" or "Sender Email:", use that value. NEVER use "contact@youragency.com" placeholder. If no contact found, use empty string and let template handle it.]
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

EVIDENCE-SAFE WORDING RULES:
- If website/social data is missing from available sources, use "not found in available map data" or "not discoverable in automated search" instead of claiming "no Instagram" or "zero digital presence".
- Prefer respectful SaaS language: "limited discoverability", "missed online booking opportunity", "opportunity to strengthen digital presence".
- Always reference where information came from: "based on website analysis", "from map data", "from manual notes".
- Do not invent digital presence or capabilities not supported by the evidence provided.

Input notes:
${rawNotes}
`;
}

async function generateBriefFromNotes(rawNotes) {
  const prompt = buildBriefPrompt(rawNotes);
  return await callGemini(prompt, 8192, 0.7);
}

// ─────────────────────────────────────────────
// ROUTE 2 — GENERATE RESEARCH BRIEF
// ─────────────────────────────────────────────
app.post("/generate-brief", async (req, res) => {
  try {
    const { raw_notes } = req.body;

    if (!raw_notes || typeof raw_notes !== "string") {
      return res.status(400).json({
        success: false,
        error: "Missing raw_notes. Send JSON like: { raw_notes: 'your topic here' }"
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
// AUDIT HTML PROMPT BUILDER
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
:root { --c1: SET_FROM_THEME; --c2: SET_FROM_THEME; --dark: SET_FROM_THEME; --bg: SET_FROM_THEME; --white: #ffffff; --gray: #6B7280; --light: #F3F4F6; }
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family:'Inter',sans-serif; }
.page { width:210mm; height:297mm; overflow:hidden; position:relative; page-break-before:always; break-before:page; }
.page-cover { page-break-before:avoid; break-before:avoid; }
.cover { background:var(--dark); }
.cover .bg-img { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; opacity:0.35; display:block; }
.cover .overlay { position:absolute; inset:0; background:linear-gradient(170deg, transparent 0%, var(--dark) 55%); }
.cover .body { position:absolute; inset:0; z-index:2; display:flex; flex-direction:column; justify-content:space-between; padding:50px 60px 52px; }
.cover-top { display:flex; justify-content:space-between; align-items:flex-start; }
.cover-badge { background:var(--c1); color:#fff; padding:8px 18px; border-radius:4px; font-size:10px; font-weight:700; letter-spacing:3px; text-transform:uppercase; }
.cover-date { font-size:12px; color:rgba(255,255,255,0.62); font-weight:400; }
.cover-middle { margin-top:auto; padding-bottom:40px; }
.cover-label { font-size:11px; font-weight:600; color:var(--c2); letter-spacing:2px; text-transform:uppercase; margin-bottom:16px; }
.cover h1 { font-family:'Playfair Display',serif; font-size:54px; font-weight:900; line-height:1.05; color:#fff; margin-bottom:16px; max-width:680px; }
.cover .tagline { font-size:16px; font-weight:300; color:rgba(255,255,255,0.6); max-width:500px; line-height:1.75; }
.cover-footer { display:flex; justify-content:space-between; align-items:flex-end; padding-top:24px; border-top:1px solid rgba(255,255,255,0.1); }
.cover-meta-row { display:flex; gap:40px; }
.cover-meta { font-size:11.5px; color:rgba(255,255,255,0.58); }
.cover-meta strong { display:block; color:#fff; font-size:13px; font-weight:600; margin-top:4px; }
.cover-score { text-align:right; }
.cover-score .score-num { font-family:'Playfair Display',serif; font-size:52px; font-weight:900; color:var(--c2); line-height:1; }
.cover-score .score-label { font-size:10px; color:rgba(255,255,255,0.4); text-transform:uppercase; letter-spacing:1px; }
.page-problems { background:var(--dark); }
.problems-header { width:100%; height:38mm; background:linear-gradient(135deg, rgba(255,255,255,0.03), rgba(255,255,255,0.01)); border-bottom:1px solid rgba(255,255,255,0.07); display:flex; align-items:center; justify-content:space-between; padding:0 52px; overflow:hidden; position:relative; }
.problems-header::after { content:''; position:absolute; right:-30px; top:-50px; width:180px; height:180px; border-radius:50%; background:var(--c1); opacity:0.08; }
.ph-left { z-index:1; }
.section-lbl { font-size:10px; font-weight:700; letter-spacing:3px; text-transform:uppercase; color:rgba(255,255,255,0.35); margin-bottom:8px; }
.section-h { font-family:'Inter',sans-serif; font-size:26px; font-weight:800; color:#fff; }
.ph-num { font-family:'Playfair Display',serif; font-size:80px; font-weight:900; color:var(--c1); opacity:0.15; font-style:italic; line-height:1; }
.problems-body { padding:28px 52px 28px; overflow:hidden; }
.section-intro { font-size:14px; line-height:1.75; color:rgba(255,255,255,0.78); margin-bottom:22px; max-width:620px; }
.prob-list { display:flex; flex-direction:column; gap:10px; margin-bottom:22px; }
.prob-item { background:rgba(255,255,255,0.04); border-radius:10px; padding:16px 20px; border-left:3px solid var(--c1); display:flex; align-items:flex-start; gap:16px; }
.prob-num { font-family:'Playfair Display',serif; font-size:28px; font-weight:900; color:var(--c1); opacity:0.5; line-height:1; flex-shrink:0; min-width:30px; }
.prob-title { font-size:13px; font-weight:700; color:#fff; margin-bottom:5px; text-transform:uppercase; letter-spacing:0.5px; }
.prob-desc { font-size:13px; color:rgba(255,255,255,0.76); line-height:1.6; margin:0; }
.impact-row { background:rgba(255,255,255,0.03); border-radius:8px; padding:14px 18px; display:flex; align-items:center; gap:16px; }
.impact-label { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:1px; color:rgba(255,255,255,0.35); white-space:nowrap; }
.impact-bar-wrap { flex:1; height:6px; background:rgba(255,255,255,0.08); border-radius:3px; }
.impact-bar { height:100%; border-radius:3px; background:linear-gradient(90deg, var(--c1), var(--c2)); }
.impact-val { font-size:12px; font-weight:700; color:var(--c2); white-space:nowrap; }
.page-opp { background:var(--bg); display:flex; flex-direction:column; }
.opp-photo { width:100%; height:100mm; position:relative; overflow:hidden; flex-shrink:0; }
.opp-photo img { width:100%; height:100%; object-fit:cover; display:block; }
.opp-photo-overlay { position:absolute; inset:0; background:linear-gradient(180deg, transparent 20%, rgba(0,0,0,0.5) 100%); }
.opp-photo-text { position:absolute; bottom:0; left:0; right:0; padding:20px 52px 24px; }
.opp-photo-title { font-family:'Playfair Display',serif; font-size:28px; font-weight:900; color:#fff; line-height:1.2; }
.opp-body { flex:1; padding:24px 52px 28px; overflow:hidden; background:var(--bg); }
.opp-stats { display:grid; grid-template-columns:1fr 1fr 1fr; gap:10px; margin-bottom:18px; }
.opp-stat { background:var(--white); border-radius:10px; padding:16px 14px; text-align:center; border-top:3px solid var(--c1); box-shadow:0 1px 6px rgba(0,0,0,0.07); }
.opp-stat-num { font-family:'Playfair Display',serif; font-size:36px; font-weight:900; color:var(--c1); line-height:1; }
.opp-stat-label { font-size:9px; color:var(--gray); margin-top:5px; text-transform:uppercase; letter-spacing:1px; }
.comp-table-wrap { border-radius:9px; overflow:hidden; box-shadow:0 2px 10px rgba(0,0,0,0.08); }
.comp-table { width:100%; border-collapse:collapse; background:var(--white); }
.comp-table thead { background:var(--dark); }
.comp-table thead th { padding:10px 14px; text-align:left; font-size:10px; font-weight:700; letter-spacing:1.5px; text-transform:uppercase; color:#fff; }
.comp-table tbody tr:nth-child(even) { background:var(--light); }
.comp-table tbody td { padding:9px 14px; font-size:12px; color:#374151; border-bottom:1px solid #E5E7EB; line-height:1.4; }
.comp-table tbody tr:last-child td { border-bottom:none; }
.page-solution { background:var(--dark); }
.solution-header { width:100%; height:38mm; background:linear-gradient(135deg, rgba(255,255,255,0.03), transparent); border-bottom:1px solid rgba(255,255,255,0.07); display:flex; align-items:center; justify-content:space-between; padding:0 52px; position:relative; overflow:hidden; }
.solution-header::before { content:''; position:absolute; left:-30px; bottom:-40px; width:160px; height:160px; border-radius:50%; background:var(--c2); opacity:0.06; }
.solution-body { padding:28px 52px 28px; overflow:hidden; }
.service-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:18px; }
.service-card { background:rgba(255,255,255,0.05); border-radius:10px; padding:16px 18px; border-top:2px solid var(--c1); }
.service-card h3 { font-size:12px; font-weight:700; color:#fff; margin-bottom:6px; text-transform:uppercase; letter-spacing:0.5px; }
.service-card p { font-size:12.5px; color:rgba(255,255,255,0.76); line-height:1.6; margin:0; }
.timeline { margin-bottom:18px; }
.timeline-title { font-size:10px; font-weight:700; color:rgba(255,255,255,0.35); text-transform:uppercase; letter-spacing:2px; margin-bottom:12px; }
.timeline-row { display:flex; gap:0; margin-bottom:8px; }
.timeline-step { flex:1; background:rgba(255,255,255,0.04); padding:10px 14px; position:relative; }
.timeline-step:first-child { border-radius:8px 0 0 8px; }
.timeline-step:last-child { border-radius:0 8px 8px 0; }
.timeline-step + .timeline-step { border-left:1px solid rgba(255,255,255,0.06); }
.step-num { font-size:9px; color:var(--c2); font-weight:700; margin-bottom:4px; }
.step-label { font-size:12px; color:rgba(255,255,255,0.82); font-weight:500; line-height:1.4; }
.cta-box { background:linear-gradient(135deg, var(--c1), var(--c2)); border-radius:12px; padding:22px 28px; display:flex; align-items:center; justify-content:space-between; gap:24px; }
.cta-heading { font-family:'Playfair Display',serif; font-size:20px; font-weight:900; color:#fff; margin-bottom:6px; }
.cta-sub { font-size:12px; color:rgba(255,255,255,0.8); line-height:1.6; margin:0; }
.cta-right { flex-shrink:0; text-align:right; }
.cta-contact { font-size:11px; color:rgba(255,255,255,0.6); margin-bottom:4px; }
.cta-contact strong { display:block; color:#fff; font-size:14px; font-weight:700; margin-top:2px; }
</style>
</head>
<body>
<div class="page page-cover cover">
[IMG:professional industry photo matching sector — select gym fitness training for SPORTS category, medical healthcare professional for HEALTH category, restaurant food service dining for restaurants, corporate modern professional for CORPORATE]
<div class="overlay"></div>
<div class="body">
  <div class="cover-top"><div class="cover-badge">Growth Audit Report</div><div class="cover-date">Prepared: Copy current period from brief</div></div>
  <div class="cover-middle"><div class="cover-label">Confidential — Prepared For</div><h1>Copy the TARGET BUSINESS NAME or INDUSTRY from brief</h1><p class="tagline">Copy TAGLINE from brief exactly here.</p></div>
  <div class="cover-footer"><div class="cover-meta-row"><div class="cover-meta">Prepared By <strong>Copy SERVICE PROVIDER from brief</strong></div><div class="cover-meta">Service <strong>Copy main service offered from brief</strong></div><div class="cover-meta">Report Type <strong>Growth Opportunity Audit</strong></div></div><div class="cover-score"><div class="score-num">Copy SCORE from brief</div><div class="score-label">Opportunity Score</div></div></div>
</div>
</div>
<div class="page page-problems"><div class="problems-header"><div class="ph-left"><div class="section-lbl">02 / Analysis</div><div class="section-h">Problems We Identified</div></div><div class="ph-num">02</div></div><div class="problems-body"><p class="section-intro">Copy SUMMARY sentence 1 and 2 from Problems section of brief.</p><div class="prob-list"><div class="prob-item"><div class="prob-num">01</div><div class="prob-content"><div class="prob-title">Copy PROBLEM 1 TITLE from brief</div><p class="prob-desc">Copy PROBLEM 1 DETAIL from brief — 2 sentences max.</p></div></div><div class="prob-item"><div class="prob-num">02</div><div class="prob-content"><div class="prob-title">Copy PROBLEM 2 TITLE from brief</div><p class="prob-desc">Copy PROBLEM 2 DETAIL from brief — 2 sentences max.</p></div></div><div class="prob-item"><div class="prob-num">03</div><div class="prob-content"><div class="prob-title">Copy PROBLEM 3 TITLE from brief</div><p class="prob-desc">Copy PROBLEM 3 DETAIL from brief — 2 sentences max.</p></div></div><div class="prob-item"><div class="prob-num">04</div><div class="prob-content"><div class="prob-title">Copy PROBLEM 4 TITLE from brief</div><p class="prob-desc">Copy PROBLEM 4 DETAIL from brief — 2 sentences max.</p></div></div></div><div class="impact-row"><div class="impact-label">Overall Impact Risk</div><div class="impact-bar-wrap"><div class="impact-bar" style="width:IMPACT_PERCENT%;"></div></div><div class="impact-val">IMPACT_PERCENT% Revenue at Risk</div></div></div></div>
<div class="page page-opp"><div class="opp-photo">[IMG:opportunity success sector-specific — gym training results fitness growth for SPORTS, healthcare clinic patient success for HEALTH, restaurant revenue growth dining success for restaurants, business team achievement for corporate]<div class="opp-photo-overlay"></div><div class="opp-photo-text"><div class="opp-photo-title">Copy OPPORTUNITY HEADLINE from brief</div></div></div><div class="opp-body"><p class="section-intro" style="color:#374151;margin-bottom:16px;">Copy OPPORTUNITY SUMMARY sentence 1 and 2 from brief.</p><div class="opp-stats"><div class="opp-stat"><div class="opp-stat-num">Copy STAT 1 VALUE</div><div class="opp-stat-label">Copy STAT 1 LABEL</div></div><div class="opp-stat"><div class="opp-stat-num">Copy STAT 2 VALUE</div><div class="opp-stat-label">Copy STAT 2 LABEL</div></div><div class="opp-stat"><div class="opp-stat-num">Copy STAT 3 VALUE</div><div class="opp-stat-label">Copy STAT 3 LABEL</div></div></div><div class="comp-table-wrap"><table class="comp-table"><thead><tr><th>Copy COL1 from brief</th><th>Copy COL2 from brief</th><th>Copy COL3 from brief</th></tr></thead><tbody><tr><td>ROW1 val1</td><td>ROW1 val2</td><td>ROW1 val3</td></tr><tr><td>ROW2 val1</td><td>ROW2 val2</td><td>ROW2 val3</td></tr><tr><td>ROW3 val1</td><td>ROW3 val2</td><td>ROW3 val3</td></tr><tr><td>ROW4 val1</td><td>ROW4 val2</td><td>ROW4 val3</td></tr></tbody></table></div></div></div>
<div class="page page-solution"><div class="solution-header"><div class="ph-left"><div class="section-lbl">04 / Solution</div><div class="section-h">How We Fix This</div></div><div class="ph-num">04</div></div><div class="solution-body"><p class="section-intro">Copy SOLUTION SUMMARY sentence 1 and 2 from brief.</p><div class="service-grid"><div class="service-card"><h3>Copy SERVICE 1 TITLE from brief</h3><p>Copy SERVICE 1 DETAIL from brief — 2 sentences.</p></div><div class="service-card"><h3>Copy SERVICE 2 TITLE from brief</h3><p>Copy SERVICE 2 DETAIL from brief — 2 sentences.</p></div><div class="service-card"><h3>Copy SERVICE 3 TITLE from brief</h3><p>Copy SERVICE 3 DETAIL from brief — 2 sentences.</p></div><div class="service-card"><h3>Copy SERVICE 4 TITLE from brief</h3><p>Copy SERVICE 4 DETAIL from brief — 2 sentences.</p></div></div><div class="timeline"><div class="timeline-title">Implementation Timeline</div><div class="timeline-row"><div class="timeline-step"><div class="step-num">WEEK 1</div><div class="step-label">Copy STEP 1 from brief</div></div><div class="timeline-step"><div class="step-num">WEEK 2-3</div><div class="step-label">Copy STEP 2 from brief</div></div><div class="timeline-step"><div class="step-num">WEEK 4</div><div class="step-label">Copy STEP 3 from brief</div></div><div class="timeline-step"><div class="step-num">ONGOING</div><div class="step-label">Copy STEP 4 from brief</div></div></div></div><div class="cta-box"><div class="cta-left"><div class="cta-heading">Copy CTA HEADING from brief</div><p class="cta-sub">Copy CTA DESCRIPTION from brief — 2 sentences max.</p></div><div class="cta-right"><div class="cta-contact">Contact Us<strong>Copy CONTACT from brief</strong></div></div></div></div></div>
</body>
</html>

Research brief for this audit:
${brief}

IMAGE KEYWORD SELECTION RULES:
- For SPORTS category (gyms, fitness): Use keywords like "gym", "fitness", "training", "workout", "strength training", "personal trainer"
- For HEALTH category (clinics, dental): Use keywords like "clinic", "healthcare", "medical", "professional", "modern healthcare", "patient care"
- For restaurants/cafes: Use keywords like "restaurant", "dining", "food service", "customer experience", "modern eatery", "food business"
- For other categories: Use professional, industry-specific imagery keywords
`;
}

async function generateHtmlFromBrief(brief) {
  const prompt = buildHtmlPrompt(brief);
  let html = await callGemini(prompt, 50000, 0.5);
  html = cleanHtml(html);

  const pageCount = (html.match(/class="page/g) || []).length;
  if (pageCount < 4) {
    throw new Error(`Generated HTML looks incomplete. Only ${pageCount} page sections found. Expected at least 4.`);
  }

  if (!html.includes("</html>")) {
    throw new Error("Generated HTML is incomplete. Closing </html> tag is missing.");
  }

  return html;
}

// ─────────────────────────────────────────────
// ROUTE 3 — GENERATE HTML FROM BRIEF
// ─────────────────────────────────────────────
app.post("/generate-html", async (req, res) => {
  try {
    const { brief } = req.body;

    if (!brief || typeof brief !== "string") {
      return res.status(400).json({
        success: false,
        error: "Missing brief. Send JSON like: { brief: 'your research brief here' }"
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
// ROUTE 4 — FULL PDF PIPELINE
// ─────────────────────────────────────────────
app.post("/generate-report-pdf", async (req, res) => {
  try {
    const { raw_notes } = req.body;

    if (!raw_notes || typeof raw_notes !== "string") {
      return res.status(400).json({
        success: false,
        error: "Missing raw_notes. Send JSON like: { raw_notes: 'your topic here' }"
      });
    }

    console.log("\n=== FULL PDF PIPELINE START ===");
    const brief = await generateBriefFromNotes(raw_notes);
    const html = await generateHtmlFromBrief(brief);
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
// ROUTE 5 — ANALYZE A LEAD
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
      service_offered,
      source
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

    const hasAnyContext = website || google_maps_url || instagram_url || phone || notes;
    if (!hasAnyContext) {
      return res.status(400).json({
        success: false,
        error: "Provide at least one of: website, google_maps_url, instagram_url, phone, or notes"
      });
    }

    console.log(`🔎 Analyzing lead: ${business_name}`);

    let websiteText = "";
    let websiteFetchStatus = "No website provided";

    if (website && typeof website === "string") {
      try {
        const siteResponse = await axios.get(website, {
          timeout: 15000,
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; LeadResearchBot/1.0)"
          }
        });

        websiteText = extractReadableTextFromHtml(siteResponse.data);
        websiteFetchStatus = websiteText && websiteText.length >= 120
          ? "Website content extracted successfully."
          : "Website loaded, but readable content was limited.";
      } catch (siteError) {
        console.log("⚠️ Website fetch failed:", siteError.message);
        websiteFetchStatus = "Website was provided but could not be fetched automatically.";
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
Evidence Source: ${source || "manual_research"}

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
  "visible_strengths": ["", ""],
  "problems_found": [
    { "title": "", "detail": "", "severity": "Low | Medium | High" },
    { "title": "", "detail": "", "severity": "Low | Medium | High" },
    { "title": "", "detail": "", "severity": "Low | Medium | High" },
    { "title": "", "detail": "", "severity": "Low | Medium | High" }
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
- Evidence-safe wording: If website/social data is missing from available sources, say "not found in available map data" or "not discoverable in search results" instead of claiming "no Instagram" or "zero digital presence".
- Prefer respectful SaaS wording: "limited discoverability", "missed online booking opportunity", "opportunity to strengthen digital presence".
- audit_pdf_raw_notes MUST include: (1) Prospect business name and category, (2) Specific problems/opportunities found with evidence source (e.g. "based on website analysis", "from OpenStreetMap data", "from manual notes"), (3) Service being offered, (4) Why they need it, (5) Available contact channel.
- NEVER use "Our Agency" or "contact@youragency.com" placeholder text in audit_pdf_raw_notes.
- audit_pdf_raw_notes must be a strong paragraph (3-5 sentences) that can directly generate a 4-page audit PDF with specific business context.
`;

    const geminiText = await callGemini(prompt, 8192, 0.4);

    let analysis;
    try {
      const cleaned = geminiText.replace(/```json\s*/gi, "").replace(/```\s*/gi, "").trim();
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
// ─────────────────────────────────────────────
app.post("/generate-outreach", async (req, res) => {
  try {
    const { analysis, sender_name, sender_business, sender_service, sender_email } = req.body;

    if (!analysis || typeof analysis !== "object") {
      return res.status(400).json({ success: false, error: "analysis object is required" });
    }
    if (!sender_name || typeof sender_name !== "string") {
      return res.status(400).json({ success: false, error: "sender_name is required" });
    }
    if (!sender_business || typeof sender_business !== "string") {
      return res.status(400).json({ success: false, error: "sender_business is required" });
    }
    if (!sender_service || typeof sender_service !== "string") {
      return res.status(400).json({ success: false, error: "sender_service is required" });
    }

    const outreachPrompt = `
You are an expert B2B cold email copywriter.

Write a personalized outreach message for this lead.

LEAD ANALYSIS:
${JSON.stringify(analysis, null, 2)}

SENDER:
Name: ${sender_name}
Business: ${sender_business}
Service Offered: ${sender_service}
Email: ${sender_email || "Not provided"}

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
      const cleaned = outreachText.replace(/```json\s*/gi, "").replace(/```\s*/gi, "").trim();
      outreach = JSON.parse(cleaned);
    } catch (parseError) {
      return res.status(500).json({
        success: false,
        error: "Gemini outreach JSON parsing failed",
        raw_response: outreachText
      });
    }

    let auditNotes = analysis.audit_pdf_raw_notes;
    if (!auditNotes || typeof auditNotes !== "string") {
      return res.status(400).json({
        success: false,
        error: "analysis.audit_pdf_raw_notes is missing"
      });
    }

    // Prepend branding block to audit notes for PDF generation
    const brandingBlock = `
PREPARED BY: ${sender_business}
SENDER NAME: ${sender_name}
CONTACT EMAIL: ${sender_email || "Available upon request"}
SERVICE OFFERED: ${sender_service}
---
${auditNotes}`;

    const brief = await generateBriefFromNotes(brandingBlock);
    const html = await generateHtmlFromBrief(brief);
    const pdfUrl = await createPdfFromHtml(html, req);

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
// ROUTE 7 — PROCESS ONE LEAD FULLY + SAVE TO SUPABASE
// ─────────────────────────────────────────────
app.post("/process-lead", async (req, res) => {
  try {
    const {
      lead_id,
      campaign_id,
      business_name,
      website,
      google_maps_url,
      instagram_url,
      phone,
      email,
      address,
      notes,
      source,
      service_offered,
      sender_name,
      sender_business,
      sender_email
    } = req.body;

    if (!business_name || typeof business_name !== "string") {
      return res.status(400).json({ success: false, error: "business_name is required" });
    }
    if (!service_offered || typeof service_offered !== "string") {
      return res.status(400).json({ success: false, error: "service_offered is required" });
    }
    if (!sender_name || typeof sender_name !== "string") {
      return res.status(400).json({ success: false, error: "sender_name is required" });
    }
    if (!sender_business || typeof sender_business !== "string") {
      return res.status(400).json({ success: false, error: "sender_business is required" });
    }

    const hasAnyContext = website || google_maps_url || instagram_url || phone || email || address || notes;
    if (!hasAnyContext) {
      return res.status(400).json({
        success: false,
        error: "Provide at least one of: website, google_maps_url, instagram_url, phone, email, address, or notes"
      });
    }

    const baseUrl = `${req.protocol}://${req.get("host")}`;

    const analyzeRes = await axios.post(
      `${baseUrl}/analyze-lead`,
      {
        business_name,
        website,
        google_maps_url,
        instagram_url,
        phone,
        notes,
        service_offered,
        source
      },
      { timeout: 180000 }
    );

    const analysis = analyzeRes.data.analysis;

    const outreachRes = await axios.post(
      `${baseUrl}/generate-outreach`,
      {
        analysis,
        sender_name,
        sender_business,
        sender_service: service_offered,
        sender_email
      },
      { timeout: 300000 }
    );

    const outreach = outreachRes.data.outreach;
    const pdfUrl = outreachRes.data.pdf_url;

    const persistence = await saveLeadProcessingToSupabase({
      leadId: lead_id,
      campaignId: campaign_id,
      leadPayload: {
        business_name,
        website,
        google_maps_url,
        instagram_url,
        phone,
        email,
        address,
        notes,
        source
      },
      analysis,
      outreach,
      pdfUrl
    });

    return res.json({
      success: true,
      lead: {
        business_name,
        website: website || "",
        google_maps_url: google_maps_url || "",
        instagram_url: instagram_url || "",
        phone: phone || "",
        email: email || "",
        address: address || ""
      },
      analysis,
      outreach,
      pdf_url: pdfUrl,
      database: persistence
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
// ─────────────────────────────────────────────
app.post("/process-leads", async (req, res) => {
  try {
    const { leads, campaign_id, service_offered, sender_name, sender_business, sender_email } = req.body;

    if (!Array.isArray(leads) || leads.length === 0) {
      return res.status(400).json({ success: false, error: "leads must be a non-empty array" });
    }
    if (leads.length > 3) {
      return res.status(400).json({ success: false, error: "Maximum 3 leads allowed per request for now" });
    }

    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const results = [];

    for (const lead of leads) {
      try {
        const processRes = await axios.post(
          `${baseUrl}/process-lead`,
          {
            lead_id: lead.lead_id || lead.id || null,
            campaign_id,
            business_name: lead.business_name,
            website: lead.website,
            google_maps_url: lead.google_maps_url,
            instagram_url: lead.instagram_url,
            phone: lead.phone,
            email: lead.email,
            address: lead.address,
            notes: lead.notes,
            source: lead.source,
            service_offered,
            sender_name,
            sender_business,
            sender_email
          },
          { timeout: 600000 }
        );

        results.push(processRes.data);
      } catch (leadError) {
        results.push({
          success: false,
          business_name: lead.business_name || "Unknown",
          error: leadError.response?.data?.error || leadError.message
        });
      }
    }

    return res.json({
      success: true,
      processed_count: results.length,
      success_count: results.filter(r => r.success).length,
      failed_count: results.filter(r => !r.success).length,
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
// LEAD FINDER HELPERS — STRONG OSM VERSION
// ─────────────────────────────────────────────

const OSM_CONTACT_EMAIL =
  process.env.OVERPASS_CONTACT_EMAIL ||
  process.env.CONTACT_EMAIL ||
  "gokuwoo11@gmail.com";

const OSM_USER_AGENT =
  process.env.OSM_USER_AGENT ||
  `LeadFlowStudio/1.0 contact:${OSM_CONTACT_EMAIL}`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function titleCase(str) {
  return String(str || "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ");
}

function normalizeLeadSearch({
  lead_search_keyword,
  ideal_target_customer,
  target_business,
  location
}) {
  const raw_target = (
    lead_search_keyword ||
    target_business ||
    ideal_target_customer ||
    ""
  ).toString();

  const raw_location = (location || "").toString();

  const t = raw_target.toLowerCase().trim();

  const mappings = [
    {
      keys: [
        "gym",
        "gyms",
        "fitness",
        "fitness center",
        "fitness centre",
        "fitness studio",
        "personal trainer",
        "workout",
        "training studio",
        "gym owner",
        "gym owners"
      ],
      normalized: "gyms"
    },
    {
      keys: [
        "restaurant",
        "restaurants",
        "cafe",
        "cafes",
        "coffee shop",
        "food business",
        "food shop",
        "eatery",
        "fast food",
        "dining"
      ],
      normalized: "restaurants"
    },
    {
      keys: [
        "salon",
        "salons",
        "beauty",
        "beauty salon",
        "hair salon",
        "spa",
        "makeup",
        "barber"
      ],
      normalized: "salons"
    },
    {
      keys: ["dental", "dentist", "dentists", "dental clinic", "orthodontist"],
      normalized: "dentists"
    },
    {
      keys: ["clinic", "clinics", "doctor", "doctors", "medical clinic", "health clinic"],
      normalized: "clinics"
    },
    {
      keys: ["hotel", "hotels", "guest house", "hostel", "lodging"],
      normalized: "hotels"
    },
    {
      keys: ["school", "schools", "college", "academy", "tuition", "coaching"],
      normalized: "schools"
    },
    {
      keys: ["pharmacy", "pharmacies", "medical store"],
      normalized: "pharmacies"
    },
    {
      keys: ["bakery", "bakeries"],
      normalized: "bakeries"
    }
  ];

  let normalized_target = "";

  for (const m of mappings) {
    if (m.keys.some((k) => t.includes(k))) {
      normalized_target = m.normalized;
      break;
    }
  }

  if (!normalized_target) {
    const maybe = t.split(/[,\-\/\\]/)[0].trim();
    normalized_target = maybe || t;
  }

  return {
    raw_target,
    normalized_target,
    raw_location,
    normalized_location: raw_location ? titleCase(raw_location) : ""
  };
}

function normalizeLeadIdentity(value = "") {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function makeLeadDedupeKey(lead = {}) {
  const name = normalizeLeadIdentity(lead.business_name || "");
  const website = normalizeLeadIdentity(lead.website || "");
  const phone = normalizeLeadIdentity(lead.phone || "");
  const address = normalizeLeadIdentity(lead.address || "");

  if (website) return `website:${website}`;
  if (phone) return `phone:${phone}`;
  return `name-address:${name}:${address}`;
}

function buildLeadSearchVariants(target = "") {
  const t = String(target || "").toLowerCase().trim();
  const variants = new Set();

  const add = (items) => items.forEach((item) => variants.add(item));

  if (t) {
    variants.add(t);
    variants.add(t.replace(/s$/, ""));
  }

  const fallbackMap = {
    restaurants: ["restaurant", "cafe", "fast_food", "food_court"],
    restaurant: ["restaurant", "cafe", "fast_food", "food_court"],
    cafes: ["cafe", "restaurant"],
    cafe: ["cafe", "restaurant"],

    gyms: ["fitness_centre", "sports_centre", "gym"],
    gym: ["fitness_centre", "sports_centre", "gym"],
    fitness: ["fitness_centre", "sports_centre", "gym"],

    salons: ["hairdresser", "beauty", "spa"],
    salon: ["hairdresser", "beauty", "spa"],

    dentists: ["dentist"],
    dentist: ["dentist"],

    clinics: ["clinic", "doctors", "hospital"],
    clinic: ["clinic", "doctors", "hospital"],

    hotels: ["hotel", "guest_house", "hostel"],
    hotel: ["hotel", "guest_house", "hostel"],

    schools: ["school", "college", "university", "kindergarten"],
    school: ["school", "college", "university", "kindergarten"],

    pharmacies: ["pharmacy"],
    pharmacy: ["pharmacy"],

    bakeries: ["bakery"],
    bakery: ["bakery"]
  };

  if (fallbackMap[t]) {
    add(fallbackMap[t]);
  }

  // Safe generic fallbacks for local business discovery
  if (variants.size < 3) {
    add(["restaurant", "cafe", "shop"]);
  }

  return Array.from(variants).filter(Boolean).slice(0, 10);
}

function getOverpassTagSelectors(keyword = "") {
  const k = String(keyword || "").toLowerCase().trim();

  const selectorMap = {
    restaurant: ['["amenity"="restaurant"]'],
    cafe: ['["amenity"="cafe"]'],
    fast_food: ['["amenity"="fast_food"]'],
    food_court: ['["amenity"="food_court"]'],

    fitness_centre: ['["leisure"="fitness_centre"]'],
    sports_centre: ['["leisure"="sports_centre"]'],
    gym: ['["leisure"="fitness_centre"]', '["sport"="fitness"]'],

    hairdresser: ['["shop"="hairdresser"]'],
    beauty: ['["shop"="beauty"]'],
    spa: ['["leisure"="spa"]'],

    dentist: ['["amenity"="dentist"]'],
    clinic: ['["amenity"="clinic"]'],
    doctors: ['["amenity"="doctors"]'],
    hospital: ['["amenity"="hospital"]'],

    hotel: ['["tourism"="hotel"]'],
    guest_house: ['["tourism"="guest_house"]'],
    hostel: ['["tourism"="hostel"]'],

    school: ['["amenity"="school"]'],
    college: ['["amenity"="college"]'],
    university: ['["amenity"="university"]'],
    kindergarten: ['["amenity"="kindergarten"]'],

    pharmacy: ['["amenity"="pharmacy"]'],
    bakery: ['["shop"="bakery"]'],
    shop: ['["shop"]']
  };

  if (selectorMap[k]) return selectorMap[k];

  const safeRegex = k.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\s+/g, ".*");
  return [`["name"~"${safeRegex}",i]`];
}

async function geocodeLocationForLeadSearch(location = "") {
  const cleanLocation = String(location || "").trim();

  if (!cleanLocation) {
    throw new Error("Target location is required for lead search.");
  }

  const response = await axios.get("https://nominatim.openstreetmap.org/search", {
    params: {
      q: cleanLocation,
      format: "json",
      limit: 1,
      addressdetails: 1
    },
    headers: {
      "User-Agent": OSM_USER_AGENT,
      Accept: "application/json"
    },
    timeout: 20000
  });

  const results = response.data;

  if (!Array.isArray(results) || !results.length) {
    throw new Error(`Could not geocode location: ${cleanLocation}`);
  }

  const first = results[0];

  return {
    lat: Number(first.lat),
    lon: Number(first.lon),
    display_name: first.display_name || cleanLocation
  };
}

function buildOverpassAroundQuery({ lat, lon, radius, keyword }) {
  const selectors = getOverpassTagSelectors(keyword);

  const selectorLines = selectors
    .map((selector) => {
      return `
  node${selector}(around:${radius},${lat},${lon});
  way${selector}(around:${radius},${lat},${lon});
  relation${selector}(around:${radius},${lat},${lon});`;
    })
    .join("\n");

  return `
[out:json][timeout:40];
(
${selectorLines}
);
out center tags 100;
`;
}

async function requestOverpassWithFallback(overpassQuery) {
  const endpoints = [
    "https://overpass-api.de/api/interpreter",
    "https://lz4.overpass-api.de/api/interpreter",
    "https://z.overpass-api.de/api/interpreter"
  ];

  const headers = {
    "Content-Type": "text/plain",
    Accept: "application/json",
    "User-Agent": OSM_USER_AGENT,
    Referer: "https://pdf-api-bw6a.onrender.com/"
  };

  let lastError = null;

  for (const endpoint of endpoints) {
    try {
      const response = await axios.post(endpoint, overpassQuery, {
        headers,
        timeout: 90000
      });

      return response;
    } catch (error) {
      const status = error?.response?.status;
      const shouldRetry = [429, 500, 502, 503, 504].includes(status);

      console.error(
        `OVERPASS REQUEST FAILED (${endpoint}):`,
        error.message,
        `status=${status}`
      );

      lastError = error;

      if (!shouldRetry) {
        throw error;
      }

      await sleep(1200);
    }
  }

  throw lastError || new Error("All Overpass lead discovery endpoints failed");
}

function mapOverpassElementToLead(element = {}, fallbackLocation = "", label = "local business") {
  const tags = element.tags || {};

  const lat = element.lat || element.center?.lat || "";
  const lon = element.lon || element.center?.lon || "";

  const businessName = tags.name || tags["name:en"] || "";
  if (!businessName) return null;

  const website = tags.website || tags["contact:website"] || "";
  const phone = tags.phone || tags["contact:phone"] || "";
  const email = tags.email || tags["contact:email"] || "";
  const instagram = tags.instagram || tags["contact:instagram"] || "";

  const addressParts = [
    tags["addr:housenumber"],
    tags["addr:street"],
    tags["addr:suburb"],
    tags["addr:city"],
    tags["addr:postcode"]
  ].filter(Boolean);

  const address = addressParts.length ? addressParts.join(", ") : fallbackLocation;

  const googleMapsSearchUrl =
    lat && lon
      ? `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`
      : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
          `${businessName} ${fallbackLocation}`
        )}`;

  return {
    business_name: businessName,
    website,
    phone,
    email,
    instagram_url: instagram,
    google_maps_url: googleMapsSearchUrl,
    address,
    source: "openstreetmap",
    notes: `Found automatically from OpenStreetMap as a ${label}. ${
      website
        ? "Official website available in map data."
        : "Website not found in available map data."
    } ${
      phone
        ? "Phone number available in map data."
        : "Phone number not found in available map data."
    }`
  };
}

async function discoverLeadsFromOpenStreetMap({
  normalizedTarget,
  rawLocation,
  requestedCount
}) {
  const safeLimit = Math.min(Math.max(Number(requestedCount) || 10, 1), 25);

  const geo = await geocodeLocationForLeadSearch(rawLocation);

  const variants = buildLeadSearchVariants(normalizedTarget);
  const radiuses = [8000, 15000, 25000];

  const dedupe = new Map();
  const attempts = [];

  for (const radius of radiuses) {
    for (const variant of variants) {
      if (dedupe.size >= safeLimit) break;

      const query = buildOverpassAroundQuery({
        lat: geo.lat,
        lon: geo.lon,
        radius,
        keyword: variant
      });

      attempts.push({
        variant,
        radius
      });

      try {
        const response = await requestOverpassWithFallback(query);
        const elements = response.data?.elements || [];

        for (const element of elements) {
          const lead = mapOverpassElementToLead(element, geo.display_name, variant);
          if (!lead) continue;

          const key = makeLeadDedupeKey(lead);
          if (!dedupe.has(key)) {
            dedupe.set(key, lead);
          }

          if (dedupe.size >= safeLimit) break;
        }
      } catch (error) {
        console.error(
          `OSM discovery failed for variant='${variant}', radius=${radius}:`,
          error.message
        );
      }

      // Production caution: avoid hammering free OSM infrastructure.
      await sleep(900);
    }

    if (dedupe.size >= safeLimit) break;
  }

  const leads = Array.from(dedupe.values()).slice(0, safeLimit);

  return {
    leads,
    requested_count: safeLimit,
    found_count: leads.length,
    shortfall: Math.max(safeLimit - leads.length, 0),
    search_location: geo.display_name,
    search_variants: variants,
    search_attempts: attempts
  };
}
// ─────────────────────────────────────────────
// ROUTE 9 — FIND LEADS + OPTIONAL SUPABASE SAVE
// ─────────────────────────────────────────────
app.post("/find-leads", async (req, res) => {
  try {
    const {
      campaign_id,
      target_business,
      lead_search_keyword,
      ideal_target_customer,
      location,
      target_location,
      max_results = 10,
      leads_requested,
      requested_count,
      save_to_database = true
    } = req.body;

    const rawTargetProvided = (
      lead_search_keyword ||
      target_business ||
      ideal_target_customer ||
      ""
    ).toString();

    const rawLocationProvided = (
      location ||
      target_location ||
      ""
    ).toString();

    if (!rawTargetProvided) {
      return res.status(400).json({
        success: false,
        error: "target_business or lead_search_keyword is required"
      });
    }

    if (!rawLocationProvided) {
      return res.status(400).json({
        success: false,
        error: "location or target_location is required"
      });
    }

    const finalRequestedCount =
      max_results ||
      leads_requested ||
      requested_count ||
      10;

    const normalized = normalizeLeadSearch({
      lead_search_keyword,
      ideal_target_customer,
      target_business,
      location: rawLocationProvided
    });

    const { normalized_target, normalized_location } = normalized;

    console.log("🔎 FIND LEADS START");
    console.log("raw target:", rawTargetProvided);
    console.log("normalized target:", normalized_target);
    console.log("raw location:", rawLocationProvided);
    console.log("normalized location:", normalized_location);
    console.log("requested count:", finalRequestedCount);

    const discovery = await discoverLeadsFromOpenStreetMap({
      normalizedTarget: normalized_target,
      rawLocation: normalized_location || rawLocationProvided,
      requestedCount: finalRequestedCount
    });

    const leads = discovery.leads;

    let savedLeads = [];
    let insertError = null;

    if (save_to_database && campaign_id) {
      try {
        savedLeads = await insertLeadsForCampaign(campaign_id, leads);
      } catch (e) {
        console.error("❌ Supabase insert error:", e.message);
        insertError = e.message;
      }
    }

    const search_used = {
      raw_target_business: rawTargetProvided,
      normalized_target,
      raw_location: rawLocationProvided,
      normalized_location,
      search_location: discovery.search_location,
      search_variants: discovery.search_variants
    };

    return res.json({
      success: true,
      search_used,

      requested_count: discovery.requested_count,
      found_count: discovery.found_count,
      shortfall: discovery.shortfall,

      warning:
        discovery.shortfall > 0
          ? `Only found ${discovery.found_count} out of ${discovery.requested_count}. OpenStreetMap data may be limited for this keyword/location.`
          : null,

      leads,

      database: {
        saved: Boolean(save_to_database && campaign_id && !insertError),
        campaign_id: campaign_id || null,
        saved_count: savedLeads.length,
        saved_leads: savedLeads,
        insert_error: insertError
      }
    });

  } catch (error) {
    console.error("FIND LEADS ERROR:", error.message);

    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});
// ═════════════════════════════════════════════
// V10 CAMPAIGN RUNNER + RESULTS API
// Paste this entire block ABOVE:
// // START SERVER
// ═════════════════════════════════════════════

async function getCampaignLeads(campaignId, processingStatus = null) {
  const statusFilter = processingStatus
    ? `&processing_status=eq.${encodeURIComponent(processingStatus)}`
    : "";

  const rows = await supabaseRequest({
    table: "leads",
    query: `?campaign_id=eq.${encodeURIComponent(campaignId)}${statusFilter}&select=*&order=created_at.asc`
  });

  return Array.isArray(rows) ? rows : [];
}

async function getRowsByLeadIds(table, leadIds) {
  if (!leadIds.length) return [];

  const ids = leadIds.map(id => encodeURIComponent(id)).join(",");

  const rows = await supabaseRequest({
    table,
    query: `?lead_id=in.(${ids})&select=*`
  });

  return Array.isArray(rows) ? rows : [];
}

async function buildCampaignResults(campaignId) {
  const campaign = await findCampaignById(campaignId);

  if (!campaign) {
    throw new Error("campaign_id does not exist in Supabase");
  }

  const leads = await getCampaignLeads(campaignId);
  const leadIds = leads.map(lead => lead.id);

  const [analyses, outreachMessages, reports] = await Promise.all([
    getRowsByLeadIds("lead_analyses", leadIds),
    getRowsByLeadIds("outreach_messages", leadIds),
    getRowsByLeadIds("reports", leadIds)
  ]);

  const analysisByLeadId = new Map(analyses.map(row => [row.lead_id, row]));
  const outreachByLeadId = new Map(outreachMessages.map(row => [row.lead_id, row]));
  const reportByLeadId = new Map(reports.map(row => [row.lead_id, row]));

  return {
    campaign,
    summary: {
      total_leads: leads.length,
      new_leads: leads.filter(lead => lead.processing_status === "new").length,
      processing_leads: leads.filter(lead => lead.processing_status === "processing").length,
      processed_leads: leads.filter(lead => lead.processing_status === "processed").length,
      failed_leads: leads.filter(lead => lead.processing_status === "failed").length
    },
    results: leads.map(lead => ({
      lead,
      analysis: analysisByLeadId.get(lead.id) || null,
      outreach: outreachByLeadId.get(lead.id) || null,
      report: reportByLeadId.get(lead.id) || null
    }))
  };
}

async function runCampaignInBackground(campaignId, baseUrl) {
  try {
    console.log(`🚀 Campaign run started: ${campaignId}`);

    const campaign = await findCampaignById(campaignId);

    if (!campaign) {
      throw new Error("campaign_id does not exist in Supabase");
    }

    await updateRows(
      "campaigns",
      `?id=eq.${encodeURIComponent(campaignId)}`,
      {
        status: "running",
        updated_at: new Date().toISOString()
      }
    );

    // Step 1: reuse already-saved new leads if they exist.
    let leads = await getCampaignLeads(campaignId, "new");

    // Step 2: if this campaign has no saved new leads yet, find and save fresh leads.
    if (!leads.length) {
      console.log(`🔍 No unprocessed leads found. Discovering new leads for campaign: ${campaignId}`);

      // Prepare and log discovery context
      const discoveryContext = {
        campaign_id: campaignId,
        client_business_name: campaign.client_business_name,
        raw_lead_search_keyword: campaign.lead_search_keyword || "",
        ideal_target_customer: campaign.ideal_target_customer || "",
        raw_target_location: campaign.target_location || "",
        leads_requested: campaign.leads_requested || 20
      };

      const normalizedPreview = normalizeLeadSearch({
        lead_search_keyword: campaign.lead_search_keyword,
        ideal_target_customer: campaign.ideal_target_customer,
        target_business: campaign.lead_search_keyword,
        location: campaign.target_location
      });

      console.log("--- Campaign discovery context ---");
      console.log("campaign id:", discoveryContext.campaign_id);
      console.log("campaign client:", discoveryContext.client_business_name);
      console.log("raw lead_search_keyword:", discoveryContext.raw_lead_search_keyword);
      console.log("ideal_target_customer:", discoveryContext.ideal_target_customer);
      console.log("raw target_location:", discoveryContext.raw_target_location);
      console.log("normalized target:", normalizedPreview.normalized_target);
      console.log("normalized location:", normalizedPreview.normalized_location);

      let findRes;
      try {
        findRes = await axios.post(
          `${baseUrl}/find-leads`,
          {
            campaign_id: campaignId,
            lead_search_keyword: campaign.lead_search_keyword,
            ideal_target_customer: campaign.ideal_target_customer,
            target_business: campaign.lead_search_keyword,
            location: campaign.target_location,
            max_results: campaign.leads_requested || 20,
            save_to_database: true
          },
          { timeout: 30000 }
        );
      } catch (findErr) {
        console.error("❌ Lead discovery request failed:", findErr.response?.data?.error || findErr.message);
        findRes = findErr.response?.data ? { data: findErr.response.data } : null;
      }

      const rawFound = findRes?.data?.found_count || (findRes?.data?.leads || []).length || 0;
      const savedCount = (findRes?.data?.database?.saved_leads || []).length || 0;
      const insertError = findRes?.data?.database?.insert_error || null;

      console.log(`🔎 Discovery results — raw found: ${rawFound}, saved: ${savedCount}`);
      if (insertError) console.error("❌ Supabase insert error:", insertError);

      leads = findRes?.data?.database?.saved_leads || [];
    }

    if (!leads.length) {
      await updateRows(
        "campaigns",
        `?id=eq.${encodeURIComponent(campaignId)}`,
        {
          status: "completed",
          updated_at: new Date().toISOString()
        }
      );

      console.log(`✅ Campaign completed with no leads to process: ${campaignId}`);
      return;
    }

    // Step 3: process each saved lead one by one and persist outputs.
    for (const lead of leads) {
      try {
        console.log(`⚙️ Processing campaign lead: ${lead.business_name}`);

        await updateRows(
          "leads",
          `?id=eq.${encodeURIComponent(lead.id)}`,
          {
            processing_status: "processing",
            updated_at: new Date().toISOString()
          }
        );

        await axios.post(
          `${baseUrl}/process-lead`,
          {
            lead_id: lead.id,
            campaign_id: campaignId,
            business_name: lead.business_name,
            website: lead.website || "",
            google_maps_url: lead.google_maps_url || "",
            instagram_url: lead.instagram_url || "",
            phone: lead.phone || "",
            email: lead.email || "",
            address: lead.address || "",
            notes: lead.notes || "",
            source: lead.source || "openstreetmap",
            service_offered: campaign.service_offer,
            sender_name: campaign.sender_name,
            sender_business: campaign.client_business_name,
            sender_email: campaign.sender_email
          },
          { timeout: 700000 }
        );

        console.log(`✅ Lead processed: ${lead.business_name}`);

      } catch (leadError) {
        console.error(`❌ Lead failed: ${lead.business_name}`, leadError.response?.data?.error || leadError.message);

        await updateRows(
          "leads",
          `?id=eq.${encodeURIComponent(lead.id)}`,
          {
            processing_status: "failed",
            updated_at: new Date().toISOString()
          }
        );
      }
    }

    await updateRows(
      "campaigns",
      `?id=eq.${encodeURIComponent(campaignId)}`,
      {
        status: "completed",
        updated_at: new Date().toISOString()
      }
    );

    console.log(`🎉 Campaign fully completed: ${campaignId}`);

  } catch (error) {
    console.error(`💥 Campaign run failed: ${campaignId}`, error.message);

    try {
      await updateRows(
        "campaigns",
        `?id=eq.${encodeURIComponent(campaignId)}`,
        {
          status: "failed",
          updated_at: new Date().toISOString()
        }
      );
    } catch (statusError) {
      console.error("Failed to update campaign status:", statusError.message);
    }
  }
}

// ─────────────────────────────────────────────
// ROUTE 10 — RUN A FULL CAMPAIGN AUTOMATICALLY
// POST /campaigns/:id/run
// ─────────────────────────────────────────────
app.post("/campaigns/:id/run", async (req, res) => {
  try {
    const campaignId = req.params.id;
    const campaign = await findCampaignById(campaignId);

    if (!campaign) {
      return res.status(404).json({
        success: false,
        error: "Campaign not found"
      });
    }

    if (campaign.status === "running") {
      return res.status(409).json({
        success: false,
        error: "This campaign is already running"
      });
    }

    const baseUrl = `${req.protocol}://${req.get("host")}`;

    // Start background work without blocking the HTTP response.
    setImmediate(() => {
      runCampaignInBackground(campaignId, baseUrl);
    });

    return res.json({
      success: true,
      message: "Campaign run started",
      campaign_id: campaignId,
      status: "running"
    });

  } catch (error) {
    console.error("RUN CAMPAIGN ERROR:", error.message);

    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ─────────────────────────────────────────────
// ROUTE 11 — GET COMPLETE CAMPAIGN RESULTS
// GET /campaigns/:id/results
// ─────────────────────────────────────────────
app.get("/campaigns/:id/results", async (req, res) => {
  try {
    const campaignId = req.params.id;
    const payload = await buildCampaignResults(campaignId);

    return res.json({
      success: true,
      ...payload
    });

  } catch (error) {
    console.error("GET CAMPAIGN RESULTS ERROR:", error.message);

    const status = error.message.includes("does not exist") ? 404 : 500;

    return res.status(status).json({
      success: false,
      error: error.message
    });
  }
});
// ─────────────────────────────────────────────
// ROUTE 12 — RETRY ONE FAILED LEAD
// POST /leads/:id/retry
// ─────────────────────────────────────────────
app.post("/leads/:id/retry", async (req, res) => {
  try {
    const leadId = req.params.id;
    const lead = await findLeadById(leadId);

    if (!lead) {
      return res.status(404).json({
        success: false,
        error: "Lead not found"
      });
    }

    const campaign = await findCampaignById(lead.campaign_id);

    if (!campaign) {
      return res.status(404).json({
        success: false,
        error: "Campaign not found for this lead"
      });
    }

    await updateRows(
      "leads",
      `?id=eq.${encodeURIComponent(leadId)}`,
      {
        processing_status: "processing",
        updated_at: new Date().toISOString()
      }
    );

    const baseUrl = `${req.protocol}://${req.get("host")}`;

    const processRes = await axios.post(
      `${baseUrl}/process-lead`,
      {
        lead_id: lead.id,
        campaign_id: campaign.id,
        business_name: lead.business_name,
        website: lead.website || "",
        google_maps_url: lead.google_maps_url || "",
        instagram_url: lead.instagram_url || "",
        phone: lead.phone || "",
        email: lead.email || "",
        address: lead.address || "",
        notes: lead.notes || "",
        source: lead.source || "openstreetmap",
        service_offered: campaign.service_offer,
        sender_name: campaign.sender_name,
        sender_business: campaign.client_business_name,
        sender_email: campaign.sender_email || ""
      },
      { timeout: 700000 }
    );

    return res.json({
      success: true,
      message: "Lead retried successfully",
      result: processRes.data
    });

  } catch (error) {
    console.error("RETRY LEAD ERROR:", error.response?.data?.error || error.message);

    await updateRows(
      "leads",
      `?id=eq.${encodeURIComponent(req.params.id)}`,
      {
        processing_status: "failed",
        updated_at: new Date().toISOString()
      }
    );

    return res.status(500).json({
      success: false,
      error: error.response?.data?.error || error.message
    });
  }
});


// ─────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────
app.listen(process.env.PORT || 3000, () => {
  console.log("✅ AI Prospecting SaaS API v9 on port", process.env.PORT || 3000);
});
