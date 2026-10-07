# maps-scraper — Plan B Google Maps lead scraper

Express + Playwright app for Hugging Face Spaces (Docker). Occasional-use discovery
tool: scrape Google Maps listings, enrich via detail pages, download CSV.

## What it outputs

15 columns of raw listing data: Name, Category, Rating, Reviews, Phone, Address,
Website, Price_Level, Status, Services, Latitude, Longitude, Place_ID, Image_URL,
Detail_URL. Max 30 listings per run, top 25 enriched via detail pages.

This is **discovery data, not the premium product** — the sellable $29 packs are
the 31-column enriched ones (website audits, decision-makers, urgency scores).

## Improvements over the first draft

- **Validated card detection** instead of "walk up exactly 5 parents" (picks the
  smallest ancestor containing the business name with sane text size).
- **Detail-page enrichment**: visits each listing's page for phone + website,
  which are usually missing from the list view. Polite delays between visits.
- **Bot-check detection**: fails fast with a clear message instead of hanging.
- **Lightweight evasion**: realistic user agent, viewport, webdriver flag removal.
- **Broad category/address/phone parsing**, not hardcoded US-only keyword lists.
- **Progress reporting** via `/api/status/:jobId` so the UI shows enrichment progress.
- **Pinned `playwright@1.40.0`** to match the Docker image's preinstalled browsers.

## Deploy to Hugging Face Spaces

1. Create a new Space at huggingface.co → **Docker** SDK (blank).
2. In Space settings → **Storage**, enable Persistent Storage, mount path `/data`.
3. Push these files to the Space's repo:
   - `Dockerfile`
   - `package.json`
   - `index.js`
4. The Space builds and serves on port 7860 automatically.
5. Open `https://YOUR_USERNAME-SPACE_NAME.hf.space`, enter a query like
   `plumbers in Miami FL`, hit Scrape.

## Honest limits

- Google may show a "unusual traffic" bot check, especially on datacenter IPs.
  The app detects it and tells you to wait / retry from another network.
- Keep runs occasional and small — this is a Plan B, not a bulk pipeline.
- Parsing is US-centric (address/phone regexes); international results vary.
- Google changes its Maps DOM periodically; selectors may need touch-ups.
