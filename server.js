const express = require("express");
const puppeteer = require("puppeteer");

const app = express();

// IMPORTANT
app.use(express.json({ limit: "20mb" }));

app.post("/generate-pdf", async (req, res) => {

  try {

    console.log(req.body);

    const html = req.body.html;

    // CHECK HTML
    if (!html) {
      return res.status(400).json({
        success: false,
        error: "Missing html"
      });
    }

    // START BROWSER
    const browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    const page = await browser.newPage();

    // LOAD HTML
    await page.setContent(html, {
      waitUntil: "networkidle0"
    });

    // GENERATE PDF
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true
    });

    await browser.close();

    // SEND PDF
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