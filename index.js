const express = require('express');
const { chromium } = require('playwright');
const { stringify } = require('csv-stringify/sync');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Maps Scraper</title>
    <style>body{font-family:sans-serif;padding:20px;background:#0a1a2d;color:#f8f9fa}input,button{padding:12px;font-size:16px}input{width:70%}button{background:#a48e5e;border:none;color:#0a1a2d;font-weight:bold}</style></head>
    <body><h2>Google Maps Adaptive Scraper</h2>
    <form action="/scrape" method="GET">
      <input name="q" placeholder="e.g., plumbers in Miami FL" required>
      <button type="submit">Scrape & Download CSV</button>
    </form>
    <p><small>Educational use only. May take up to 30 seconds.</small></p></body></html>
  `);
});

app.get('/scrape', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).send('Missing search query');
  
  try {
    const leads = await scrapeMaps(query);
    const csv = stringify(leads, { header: true });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="leads-${Date.now()}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error(err);
    res.status(500).send('Scraping failed: ' + err.message);
  }
});

async function scrapeMaps(query) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US'
  });
  const page = await context.newPage();

  try {
    await page.goto('https://www.google.com/maps', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000 + Math.random() * 2000);
    const searchBox = page.locator('#searchboxinput');
    await searchBox.waitFor({ state: 'visible', timeout: 15000 });
    await searchBox.fill(query);
    await page.waitForTimeout(1000);
    await searchBox.press('Enter');
    await page.waitForTimeout(5000);

    // Scroll feed to load many results
    const feed = page.locator('div[role="feed"]');
    for (let i = 0; i < 8; i++) {
      await feed.evaluate(el => el.scrollTop = el.scrollHeight);
      await page.waitForTimeout(1500 + Math.random() * 1000);
    }

    // Adaptive card finding via place links
    const linkHandles = await page.locator('a[href*="/maps/place/"]').elementHandles();
    const uniqueHrefs = new Set();
    const cardInfo = [];
    for (const link of linkHandles) {
      const href = await link.getAttribute('href');
      if (!href || uniqueHrefs.has(href)) continue;
      uniqueHrefs.add(href);
      // Walk up to find card container
      let card = link;
      for (let j = 0; j < 5; j++) {
        const parent = await card.evaluateHandle(el => el.parentElement);
        if (!parent) break;
        card = parent;
      }
      cardInfo.push({ card, link });
    }

    const leads = [];
    for (const { card, link } of cardInfo) {
      try {
        const name = (await link.innerText()).trim() || 'N/A';
        let rating = 'N/A';
        const ratingEl = card.locator('[aria-label*="stars"]').first();
        if (await ratingEl.count() > 0) {
          const aria = await ratingEl.getAttribute('aria-label');
          if (aria) {
            const match = aria.match(/([\d.]+)\s*stars?/i);
            if (match) rating = match[1];
          }
        }

        let reviews = 'N/A';
        const spans = card.locator('span, div, a');
        const spanCount = await spans.count();
        for (let k = 0; k < spanCount; k++) {
          const txt = (await spans.nth(k).innerText()).trim();
          const m = txt.match(/\(?([\d,]+)\)?\s*(?:Google\s*)?reviews?/i);
          if (m) { reviews = m[1].replace(/,/g, ''); break; }
        }

        let category = 'N/A';
        for (let k = 0; k < spanCount; k++) {
          const txt = (await spans.nth(k).innerText()).trim().toLowerCase();
          if (/plumber|dentist|doctor|lawyer|restaurant|cafe|hotel|electrician|contractor|landscaper|salon|barber|service|business/.test(txt)) {
            category = txt.charAt(0).toUpperCase() + txt.slice(1);
            break;
          }
        }

        let services = [];
        for (let k = 0; k < spanCount; k++) {
          const txt = (await spans.nth(k).innerText()).trim();
          if (txt.length >= 3 && txt.length <= 30 && /open|close|24|hour|service|offer|online|appointment|free|estimate/i.test(txt)) {
            services.push(txt);
          }
        }

        let imgUrl = 'N/A';
        const img = card.locator('img[src*="googleusercontent"]').first();
        if (await img.count() > 0) imgUrl = await img.getAttribute('src');

        const detailUrl = await link.getAttribute('href');

        leads.push({
          Name: name,
          Rating: rating,
          Reviews: reviews,
          Category: category,
          Services: services.join(', ') || 'N/A',
          Image_URL: imgUrl,
          Detail_URL: detailUrl
        });
      } catch (e) { /* skip card */ }
    }
    return leads;
  } finally {
    await browser.close();
  }
}

app.listen(PORT, () => console.log(`Scraper running on port ${PORT}`));
