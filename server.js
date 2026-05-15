const express = require("express");
const puppeteer = require("puppeteer");

const app = express();
app.use(express.json({ limit: "20mb" }));

app.post("/generate-pdf", async (req, res) => {
  try {
    const { html } = req.body;

    const browser = await puppeteer.launch({
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
    res.send(pdf);

  } catch (err) {
    res.status(500).send(err.toString());
  }
});

app.listen(3000, () => {
  console.log("PDF API running at http://localhost:3000");
});