const express = require("express");
const puppeteer = require("puppeteer-core");
const chromium = require("@sparticuz/chromium");

const app = express();

app.use(express.json({ limit: "20mb" }));

app.post("/generate-pdf", async (req, res) => {

  try {

    const { html } = req.body;

    const browser = await puppeteer.launch({
  args: chromium.args,
  defaultViewport: chromium.defaultViewport,
  executablePath: await chromium.executablePath(),
  headless: chromium.headless
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

    res.set({
      "Content-Type": "application/pdf",
      "Content-Length": pdf.length
    });

    res.send(pdf);

  } catch (error) {

    console.log(error);

    res.status(500).send("PDF generation failed");

  }

});

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});