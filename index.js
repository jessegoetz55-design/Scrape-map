/*
 * ============================================================================
 * maps-scraper — Plan B Google Maps lead scraper
 * ============================================================================
 * WHAT THIS IS:
 *   A small web app. You type a search like "plumbers in Miami FL" into a
 *   web page, it opens Google Maps in a hidden (headless) Chrome browser,
 *   copies the business listings it finds, visits each listing's detail page
 *   to grab the phone number and website, and hands you a CSV file.
 *
 * HOW THE PIECES FIT:
 *   1. Express  = the web server. Serves the page you see + the API.
 *   2. Playwright = the tool that drives a real Chrome browser with code.
 *   3. The "job" system = scraping takes minutes, so the server starts the
 *      job in the background, gives you a job ID immediately, and you poll
 *      /api/status/<id> until it's done. Then you download the CSV.
 *   4. /data = persistent storage on Hugging Face Spaces. Files written here
 *      survive restarts. Your downloaded CSVs live here.
 * ============================================================================
 */

// --- Imports: the four tools this app needs ---
const express = require('express');   // Web server: serves pages + API endpoints
const fs = require('fs');             // File system: write CSV files to /data
const path = require('path');         // Path helper: joins folder + filename safely
const { chromium } = require('playwright'); // Playwright's Chrome driver
const { v4: uuidv4 } = require('uuid');     // Generates random job IDs

// --- Server setup ---
const app = express();
const PORT = process.env.PORT || 7860; // HF Spaces expects 7860; fallback for local runs

// --- Persistent storage ---
// On HF Spaces you enable "Persistent Storage" in settings with mount path /data.
// Anything saved here survives container restarts. Locally it just makes /data.
const DATA_DIR = '/data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// --- Job tracker (in-memory) ---
// Scraping takes 2-4 minutes, too long for one HTTP request. So:
//   POST /api/scrape  -> creates a job, returns { jobId } instantly
//   GET  /api/status/<jobId> -> { status: 'running'|'done'|'error', ... }
//   GET  /api/download/<jobId> -> the finished CSV file
// NOTE: this object lives in RAM, so job *statuses* reset on restart —
// but the CSV *files* in /data survive, which is what matters.
const jobs = {};

// --- Timing helpers ---
// Bots get caught by acting too fast and too regularly. These add
// human-like pauses: sleep() waits, jitter() makes each wait slightly random.
const sleep = ms => new Promise(r => setTimeout(r, ms));
const jitter = (base, spread) => base + Math.random() * spread;

/* ============================================================================
 * toCSV(rows)
 * Turns an array of objects into a CSV string.
 * Why the weird escaping: if a business name contains a quote or comma
 * (e.g.  Joe's "Best" Plumbing, LLC), raw output would break the columns.
 * Wrapping every field in quotes and doubling inner quotes is the CSV standard.
 * ========================================================================== */
function toCSV(rows) {
  if (!rows.length) return 'name\n';
  const cols = Object.keys(rows[0]);                       // column headers from first row
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`; // escape each cell
  return [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n');
}

/* ============================================================================
 * scrapeMaps(query, onProgress)
 * The core. Does the actual Google Maps scraping. Steps:
 *   1. Launch a hidden Chrome with anti-detection flags
 *   2. Open Google Maps search for the query
 *   3. Check for Google's "unusual traffic" bot wall — fail fast if present
 *   4. Scroll the results feed to load more listings
 *   5. Extract list-view data (name, rating, address...) with resilient selectors
 *   6. Visit each listing's detail page for phone + website (the valuable fields)
 *   7. Close the browser no matter what (finally block)
 * ========================================================================== */
async function scrapeMaps(query, onProgress) {
  // --headless: no visible window (servers have no screen)
  // --no-sandbox: required inside Docker containers (Chrome sandbox needs privileges Docker blocks)
  // --disable-blink-features=AutomationControlled: removes the flag Chrome sets when
  //   driven by automation — one of the main things bot detection looks for
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  try {
    // A "browser context" is like an incognito profile: fresh cookies, own settings.
    // userAgent: identifies as normal desktop Chrome. The default Playwright UA
    //   screams "I'm a bot" — this one looks like a real Windows user.
    // viewport: window size. Headless defaults to tiny; real users aren't 800x600.
    // locale: makes Google serve English results.
    const ctx = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      viewport: { width: 1366, height: 900 },
      locale: 'en-US',
    });
    const page = await ctx.newPage();

    // Runs BEFORE any page loads. navigator.webdriver is true when automation
    // drives Chrome — another classic bot signal. This hides it.
    // navigator.plugins is empty headless; real Chrome has entries. Fake it.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
    });

    // Open the search. domcontentloaded = don't wait for every image/ad;
    // faster and less suspicious than waiting for full load.
    await page.goto('https://www.google.com/maps/search/' + encodeURIComponent(query), {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await sleep(4000); // let results render

    // --- Bot-check tripwire ---
    // If Google flags the IP, it serves an "unusual traffic" page instead of results.
    // Detect it and fail with a clear message rather than scraping garbage / hanging.
    const earlyHtml = await page.content();
    if (/unusual traffic|our systems have detected/i.test(earlyHtml)) {
      throw new Error('Google showed a bot check ("unusual traffic"). Wait a while and try again from a different network.');
    }

    // --- Load more results by scrolling the feed ---
    // Google Maps lazy-loads: only ~8 listings render until you scroll.
    // div[role="feed"] is the scrollable results panel. Scroll in steps with
    // random pauses (a human doesn't scroll in perfect rhythm).
    try {
      await page.waitForSelector('div[role="feed"]', { timeout: 15000 });
      for (let i = 0; i < 6; i++) {
        await page.evaluate(() => {
          const feed = document.querySelector('div[role="feed"]');
          if (feed) feed.scrollBy(0, 1200);
        });
        await sleep(jitter(1200, 900));
      }
    } catch {
      /* feed not found — continue with whatever loaded */
    }

    /* ------------------------------------------------------------------
     * LIST-VIEW EXTRACTION
     * page.evaluate runs the function INSIDE the browser page, where it can
     * touch Google's DOM directly, then returns plain data back to Node.
     *
     * SELECTOR STRATEGY (why this survives Google redesigns):
     * Google obfuscates CSS class names (e.g. ".hfpxzc") and changes them
     * often. So instead of classes, we anchor on things Google CAN'T easily
     * change without breaking accessibility:
     *   - a[href*="/maps/place/"]  -> listing links (URL structure is stable)
     *   - [aria-label*="star"]     -> rating (screen readers need this)
     *   - regexes over visible text for address/phone (text content is stable)
     * ------------------------------------------------------------------ */
    const listData = await page.evaluate(() => {
      const results = [];
      const seen = new Set(); // dedupe: same listing can appear twice in the DOM
      const links = Array.from(document.querySelectorAll('a[href*="/maps/place/"]'));

      // findCard: locate the listing's "card" (its visual box) without assuming
      // a fixed DOM depth. The old code did "walk up exactly 5 parents" — one
      // Google redesign and every field reads from the wrong box silently.
      // Instead: climb parents and take the SMALLEST ancestor that (a) contains
      // the business name and (b) has a plausible card-sized amount of text.
      // Too small = just the link itself; too big = the whole results list.
      function findCard(link, name) {
        let el = link;
        for (let i = 0; i < 8; i++) {
          el = el.parentElement;
          if (!el) break;
          const txt = (el.innerText || '').trim();
          if (name && name !== 'N/A' && txt.includes(name) && txt.length > name.length + 10 && txt.length < 1500) {
            return el;
          }
        }
        return link.parentElement || link; // fallback: best guess
      }

      // --- Regexes: pattern-match visible text instead of trusting DOM structure ---
      // Address: starts with a house number, ends with a street suffix (St, Ave, Blvd...)
      const isAddr = t =>
        /\d+\s+[\w\s.'-]+(street|st\.?|road|rd\.?|avenue|ave\.?|boulevard|blvd\.?|drive|dr\.?|lane|ln\.?|way|court|ct\.?|place|pl\.?|highway|hwy|parkway|pkwy|trail|circle|cir\.?)/i.test(t);
      // Phone: US formats — (305) 555-1234, 305-555-1234, 305.555.1234
      const isPhone = t => /(\(\d{3}\)\s*|\d{3}[-.\s])\d{3}[-.\s]\d{4}/.test(t);
      // Price: Google shows $, $$, $$$, $$$$ alone on a line
      const isPrice = t => /^\${1,4}$/.test(t.trim());
      // Status: "Open", "Closed", "Opens 8 AM" — short lines starting with these words
      const isStatus = t => /^(open|closed|opens|closes)/i.test(t) && t.length < 30;

      links.forEach(link => {
        const href = link.getAttribute('href');
        if (!href || seen.has(href)) return; // skip empties + duplicates
        seen.add(href);

        // Name: aria-label is most reliable; innerText as backup
        const name = (link.getAttribute('aria-label') || link.innerText || '').trim() || 'N/A';

        // Lat/lng/place ID are baked into Google's place URLs:
        //   ...!3d25.7617!4d-80.1918...!1s0x88d9b0...  -> lat, lng, place id
        let lat = 'N/A', lng = 'N/A', placeId = 'N/A';
        const latM = href.match(/!3d(-?\d+\.\d+)/);
        const lngM = href.match(/!4d(-?\d+\.\d+)/);
        const idM = href.match(/!1s([^!/?]+)/);
        if (latM) lat = latM[1];
        if (lngM) lng = lngM[1];
        if (idM) { try { placeId = decodeURIComponent(idM[1]); } catch { placeId = idM[1]; } }

        const card = findCard(link, name);

        // Rating: Google puts "4.8 stars" in an aria-label for screen readers
        let rating = 'N/A';
        const rEl = card.querySelector('[aria-label*="star" i]'); // the " i" = case-insensitive
        if (rEl) {
          const m = (rEl.getAttribute('aria-label') || '').match(/([\d.]+)/);
          if (m) rating = m[1];
        }
        // Review count: aria-label like "1,234 reviews"
        let reviews = 'N/A';
        const rvEl = card.querySelector('[aria-label*="review" i]');
        if (rvEl) {
          const m = (rvEl.getAttribute('aria-label') || '').match(/([\d,]+)/);
          if (m) reviews = m[1].replace(/,/g, '');
        }

        // Grab every short text snippet in the card, deduped. Then classify
        // each line with the regexes above. This is resilient because it doesn't
        // care WHERE in the card the text sits — only WHAT it looks like.
        const lines = [
          ...new Set(
            Array.from(card.querySelectorAll('div,span'))
              .map(e => (e.innerText || '').trim())
              .filter(t => t.length > 1 && t.length < 100 && !t.includes('\n'))
          ),
        ];

        let category = 'N/A', address = 'N/A', phone = 'N/A', price = 'N/A', status = 'N/A';
        const services = [];
        for (const t of lines) {
          if (t === name) continue;                       // skip the name itself
          if (phone === 'N/A' && isPhone(t)) { phone = t; continue; }
          if (address === 'N/A' && isAddr(t)) { address = t; continue; }
          if (price === 'N/A' && isPrice(t)) { price = t; continue; }
          if (status === 'N/A' && isStatus(t)) { status = t; continue; }
          // Service attributes Google lists ("Free estimates", "Open 24 hours"...)
          if (/wheelchair|delivery|takeout|takeaway|dine-?in|online|appointment|free estimate|24 hours|emergency|women-?led|veteran-?led|latino-?led/i.test(t)) services.push(t);
        }
        // Category: NOT a hardcoded keyword list (the old code only knew
        // plumber/dentist/lawyer/...). Instead: first short digit-free line that
        // isn't the name or a status line — works for ANY business type.
        for (const t of lines) {
          if (t !== name && t.length < 45 && !/\d/.test(t) && !isStatus(t)) {
            category = t;
            break;
          }
        }

        // Website button, if shown in the list card
        let website = 'N/A';
        const siteEl = card.querySelector('a[data-value="Website" i], a[aria-label*="ebsite" i]');
        if (siteEl) website = siteEl.getAttribute('href') || 'N/A';

        // Listing photo, if present
        let imgUrl = 'N/A';
        const img = card.querySelector('img[src*="googleusercontent"]');
        if (img) imgUrl = img.getAttribute('src') || 'N/A';

        results.push({
          Name: name, Category: category, Rating: rating, Reviews: reviews,
          Phone: phone, Address: address, Website: website, Price_Level: price,
          Status: status, Services: [...new Set(services)].join(', ') || 'N/A',
          Latitude: lat, Longitude: lng, Place_ID: placeId,
          Image_URL: imgUrl, Detail_URL: href,
        });
      });

      return results.slice(0, 30); // cap: keep memory + runtime sane
    });

    /* ------------------------------------------------------------------
     * DETAIL-PAGE ENRICHMENT
     * The list view usually does NOT show phone or website — the two fields
     * you actually need. They live on each listing's detail page. So we visit
     * up to 25 listings one by one, with polite random delays (hammering pages
     * as fast as possible is exactly what gets IPs flagged).
     * Failures are swallowed per-listing: a dead page keeps its list-view data.
     * ------------------------------------------------------------------ */
    const ENRICH_LIMIT = 25;
    const total = Math.min(listData.length, ENRICH_LIMIT);
    for (let i = 0; i < total; i++) {
      const lead = listData[i];
      try {
        if (lead.Detail_URL && lead.Detail_URL.startsWith('http')) {
          await page.goto(lead.Detail_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
          await sleep(jitter(2200, 1800)); // human-like pause between pages
          const detail = await page.evaluate(() => {
            let phone = 'N/A', website = 'N/A';
            // Detail pages expose a tel: link — most reliable phone source
            const telEl = document.querySelector('a[href^="tel:"]');
            if (telEl) {
              phone = (telEl.innerText || '').trim() || telEl.getAttribute('href').replace(/^tel:/, '');
            }
            // Website button carries the real outbound URL
            const siteEl = document.querySelector('a[data-value="Website" i], a[data-item-id="authority"]');
            if (siteEl) website = siteEl.getAttribute('href') || 'N/A';
            return { phone, website };
          });
          if (detail.phone !== 'N/A') lead.Phone = detail.phone;
          if (detail.website !== 'N/A') lead.Website = detail.website;
        }
      } catch {
        /* keep list-view data on failure */
      }
      if (onProgress) onProgress(i + 1, total); // feeds the UI progress bar
    }

    return listData;
  } finally {
    // ALWAYS close the browser, even on error — otherwise headless Chrome
    // processes pile up and eat the server's RAM until it crashes.
    await browser.close();
  }
}

/* ============================================================================
 * API ROUTES
 * ========================================================================== */

// GET /api/scrape?q=plumbers+in+Miami+FL
// Starts a scrape job in the background and returns { jobId } immediately.
// The heavy work runs AFTER res.json — that's the "background job" pattern.
app.get('/api/scrape', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: 'Missing search query' });

  const jobId = uuidv4();                       // random ID so jobs don't collide
  jobs[jobId] = { status: 'running', progress: null };
  res.json({ jobId });                          // respond NOW, scrape after

  try {
    const leads = await scrapeMaps(query, (done, total) => {
      jobs[jobId].progress = { done, total };   // UI polls this for progress
    });
    const filePath = path.join(DATA_DIR, jobId + '.csv');
    fs.writeFileSync(filePath, toCSV(leads));   // CSV lands in persistent storage
    jobs[jobId] = { status: 'done', count: leads.length, file: filePath };
  } catch (err) {
    jobs[jobId] = { status: 'error', error: err.message };
  }
});

// GET /api/status/<jobId> — the UI polls this every 3 seconds
app.get('/api/status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Unknown job' });
  res.json(job);
});

// GET /api/download/<jobId> — sends the finished CSV as a file download
app.get('/api/download/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job || job.status !== 'done' || !fs.existsSync(job.file)) {
    return res.status(404).send('File not found or job still running');
  }
  res.download(job.file, 'leads-' + req.params.jobId + '.csv');
});

/* ============================================================================
 * UI — GET /
 * Single-page frontend: input + button + status + download. Vanilla JS, no
 * framework (keeps the Docker image small and there's nothing to build).
 * Flow: startScrape() -> fetch /api/scrape -> poll /api/status every 3s ->
 * on 'done', reveal the download button + the Gumroad upsell button.
 * ========================================================================== */
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Maps Scraper</title>
<style>
  body{font-family:sans-serif;padding:20px;background:#0a1a2d;color:#f8f9fa;text-align:center;}
  input,button{padding:12px;font-size:16px;margin:5px;border-radius:5px;border:none;}
  input{width:80%;max-width:400px;}
  button{background:#a48e5e;color:#0a1a2d;font-weight:bold;cursor:pointer;}
  button:disabled{opacity:.5;}
  #status{margin-top:20px;font-weight:bold;min-height:24px;}
  .btn-group{margin-top:20px;display:flex;flex-direction:column;align-items:center;gap:10px;}
  #download-btn,#buy-btn{display:none;text-decoration:none;padding:15px;border-radius:5px;width:80%;max-width:300px;font-weight:bold;}
  #download-btn{background:#28a745;color:white;}
  #buy-btn{background:#ffc107;color:#0a1a2d;}
  .note{margin-top:30px;font-size:12px;opacity:.6;max-width:420px;margin-left:auto;margin-right:auto;}
</style>
<script>
  async function startScrape(){
    const q=document.getElementById('query').value;
    if(!q) return alert('Please enter a search query');
    const status=document.getElementById('status');
    document.getElementById('download-btn').style.display='none';
    document.getElementById('buy-btn').style.display='none';
    document.getElementById('scrape-btn').disabled=true;
    try{
      status.innerText='Starting scraper...';
      const res=await fetch('/api/scrape?q='+encodeURIComponent(q));
      const data=await res.json();
      if(data.error) throw new Error(data.error);
      const jobId=data.jobId;
      status.innerText='Scraping in progress... this takes 2-4 minutes (detail pages are visited for phone + website).';
      const interval=setInterval(async()=>{
        const s=await (await fetch('/api/status/'+jobId)).json();
        if(s.progress) status.innerText='Enriching '+s.progress.done+' of '+s.progress.total+' listings...';
        if(s.status==='done'){
          clearInterval(interval);
          status.innerText='Done — '+s.count+' leads scraped.';
          const dl=document.getElementById('download-btn');
          dl.href='/api/download/'+jobId; dl.style.display='inline-block';
          const buy=document.getElementById('buy-btn');
          buy.href='https://goetzian61.gumroad.com/'; buy.style.display='inline-block';
          document.getElementById('scrape-btn').disabled=false;
        }else if(s.status==='error'){
          clearInterval(interval);
          status.innerText='Error: '+s.error;
          document.getElementById('scrape-btn').disabled=false;
        }
      },3000);
    }catch(e){
      status.innerText='Error: '+e.message;
      document.getElementById('scrape-btn').disabled=false;
    }
  }
</script>
</head>
<body>
  <h2>Google Maps Scraper</h2>
  <input id="query" placeholder="e.g., plumbers in Miami FL" required>
  <button id="scrape-btn" onclick="startScrape()">Scrape Maps</button>
  <div id="status"></div>
  <div class="btn-group">
    <a id="download-btn" href="#">&#x2B07;&#xFE0F; Download Your CSV</a>
    <a id="buy-btn" href="#" target="_blank">&#x1F4B3; Buy a Premium Lead Pack</a>
  </div>
  <p class="note">Plan B tool: for occasional discovery runs. Raw listing data only — premium packs (31-column enriched) are sold separately.</p>
</body></html>`);
});

// --- Start the server ---
app.listen(PORT, () => console.log('maps-scraper listening on port ' + PORT));
