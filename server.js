const express = require("express");
const puppeteer = require("puppeteer");

const app = express();

// IMPORTANT
app.use(express.json({ limit: "20mb" }));

app.post("/generate-pdf", async (req, res) => {
  try {

    console.log(req.body);

    const html = req.body?.html;

    if (!html) {
      return res.status(400).json({
        success: false,
        error: "Missing html in request body"
      });
    }

    const browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    const page = await browser.newPage();

    await page.setContent(html, {
      waitUntil: "networkidle0"
    });

    const pdf = await page.pdf({
      format: "A4",
      printBackground: true
    });

    await browser.close();

    res.setHeader("Content-Type", "application/pdf");

    res.setHeader(
      "Content-Disposition",
      "attachment; filename=output.pdf"
    );

    res.end(pdf);

  } catch (err) {

    console.log(err);

    res.status(500).json({
      success: false,
      error: err.toString()
    });

  }
});

// PORT
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`PDF API running on port ${PORT}`);
});