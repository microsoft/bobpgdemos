// Records the Caldova Knowledge Hub (Demo 6) on Azure App Service into PNG frames
// plus frames.json (file + display duration). make-gif.py turns them into a GIF.
// Part B forces a REAL HorizonDB failover (walkthrough step 5); pass --skip-b to omit it.
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const BASE = process.env.KNOWLEDGE_HUB_URL || 'https://caldova-knowledge-hub-d1229495.azurewebsites.net';
const OUT = path.join(__dirname, 'frames');
const TITLE = 'Dry ice in air shipments';
const CONTENT = 'Carbon dioxide solid (dry ice, UN1845) used to chill perishables or pharma is limited to 200 kg per package on passenger aircraft. Mark the net weight on each box, use packaging that vents gas, and declare it on the air waybill.';
const SKIP_A = process.argv.includes('--skip-a');
const SKIP_B = process.argv.includes('--skip-b');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const frames = [];
let captionText = '';
let page;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);

async function applyCaption() {
    await page.evaluate((text) => {
        let box = document.getElementById('gif-caption');
        if (!text) { box?.remove(); return; }
        if (!box) {
            box = document.createElement('div');
            box.id = 'gif-caption';
            Object.assign(box.style, {
                position: 'fixed', left: '50%', bottom: '18px', transform: 'translateX(-50%)',
                maxWidth: '1180px', width: 'max-content', boxSizing: 'border-box',
                padding: '12px 20px', borderRadius: '10px', borderLeft: '6px solid #2ec4e6',
                background: 'rgba(8, 22, 48, 0.94)', color: '#ffffff', zIndex: '2147483647',
                font: '600 19px/1.35 "Segoe UI", system-ui, sans-serif', pointerEvents: 'none',
                boxShadow: '0 6px 24px rgba(0, 0, 0, 0.35)',
            });
            document.body.appendChild(box);
        }
        box.textContent = text;
    }, captionText).catch(() => {});
}

async function caption(text) {
    captionText = text;
    await applyCaption();
}

async function capture(ms) {
    await applyCaption();
    const file = `${String(frames.length).padStart(4, '0')}.png`;
    await page.screenshot({ path: path.join(OUT, file) });
    frames.push({ file, ms });
}

async function hold(ms) {
    await capture(ms);
}

async function typeInto(selector, text, every = 4) {
    await page.click(selector);
    for (let i = 0; i < text.length; i += every) {
        await page.type(selector, text.slice(i, i + every));
        await capture(90);
    }
}

async function recordFor(realMs, intervalMs, frameMs, until = null) {
    const end = Date.now() + realMs;
    while (Date.now() < end) {
        const started = Date.now();
        await capture(frameMs);
        if (until && (await until())) return true;
        await sleep(Math.max(0, intervalMs - (Date.now() - started)));
    }
    return false;
}

async function partA() {
    log('Part A: full app');
    await page.goto(`${BASE}/app?mode=keyword`, { waitUntil: 'networkidle' });
    await sleep(1200);
    await caption('Caldova Knowledge Hub on Azure HorizonDB · left: the app · right: the AI pipeline, live');
    await hold(2800);

    await caption('Keyword search (BM25 · pg_textsearch)');
    await typeInto('#q', 'our truck fridge died on the highway');
    await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle' }), page.click('.search-form button[type=submit]')]);
    await caption('Keyword search: no article uses these words, so nothing comes back');
    await hold(2600);

    await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle' }), page.click('a.mode-tab:has-text("Vector")')]);
    await caption('Vector search (DiskANN) matches meaning: "Reefer unit failure response" is #1');
    await hold(3000);

    await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle' }), page.click('a.mode-tab:has-text("Hybrid")')]);
    await caption('Hybrid search: reciprocal rank fusion of vector and keyword ranks');
    await hold(2600);

    await page.evaluate(() => {
        const line = [...document.querySelectorAll('#code-pipeline .code-line')].find((el) => el.textContent.includes('on_change'));
        if (line) {
            line.scrollIntoView({ block: 'center' });
            line.style.outline = '2px solid #ffd166';
        }
    });
    await caption("The pipeline is read live from ai.pipelines: trigger => 'on_change' keeps vectors fresh");
    await hold(3200);

    await page.fill('#q', '');
    await caption('Search for something no article covers yet');
    await typeInto('#q', 'frozen CO2 on passenger flights');
    await page.evaluate(() => { document.querySelector('.search-form input[name=mode]').value = 'vector'; });
    await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle' }), page.click('.search-form button[type=submit]')]);
    await caption('No good answer yet: nothing about dry ice on passenger aircraft');
    await hold(2600);

    await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle' }), page.click('a.button.primary:has-text("New article")')]);
    await sleep(500);
    await caption('Add an article. The app only saves a row: no embedding code in the app');
    await page.fill('#editor input[name=title]', '');
    await typeInto('#editor input[name=title]', TITLE, 5);
    await page.selectOption('#editor select[name=category]', 'Handling procedure');
    await page.fill('#editor textarea[name=content]', CONTENT);
    await hold(2200);

    await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.click('#editor button[type=submit]')]);
    await caption('Saved. on_change → pg_durable: changed rows → chunk → embed (Foundry) → upsert → DiskANN');
    const ready = () => page.evaluate(() => Boolean(document.querySelector('.notice-watch.is-ready')));
    await recordFor(20000, 350, 350, ready);
    await caption('Seconds later the new article is searchable, with no app code involved');
    await recordFor(5000, 400, 400);

    await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle' }), page.click('.notice-watch a')]);
    await caption('Run the search again: the new article is #1, ranked by meaning');
    await hold(3400);

    const row = page.locator('li.article', { has: page.locator('h3', { hasText: TITLE }) });
    if (await row.count()) {
        await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle' }), row.first().locator('button:has-text("Delete")').click()]);
        await caption('Delete it: it disappears from search immediately');
        await hold(2400);
    }
}

async function waitFor(fn, timeoutMs, label) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        if (await fn()) return;
        await sleep(300);
    }
    throw new Error(`Timed out waiting for ${label}`);
}

const nextEnabled = () => page.evaluate(() => {
    const next = document.querySelector('[data-next]');
    return next && !next.hidden && !next.disabled;
});

async function partB() {
    log('Part B: walkthrough step 5 (real failover)');
    await caption('');
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await sleep(2500);
    // Steps 1-4 unlock step 5; they are not recorded.
    await page.click('[data-step="1"] [data-action="search-before"]');
    await waitFor(nextEnabled, 30000, 'step 1');
    await page.click('[data-next]');
    await page.click('[data-step="2"] [data-action="change"]');
    await waitFor(async () => (await page.evaluate(() => !document.querySelector('[data-step="3"]').hidden)) && (await nextEnabled()), 120000, 'step 3');
    await page.click('[data-next]');
    await page.click('[data-step="4"] [data-action="search-after"]');
    await waitFor(nextEnabled, 30000, 'step 4');
    await page.click('[data-next]');
    await waitFor(() => page.evaluate(() => !document.querySelector('[data-step="5"] [data-action]').hidden), 30000, 'failover button');
    await sleep(2500);

    await caption('Step 5: update a 16-part handbook (one long pipeline run), then fail over HorizonDB for real');
    await hold(3400);
    await page.click('[data-step="5"] [data-action="failover"]');
    log('failover requested');

    const rowText = (name) => page.evaluate((n) => document.querySelector(`[data-monitor="${n}"] [data-monitor-value]`)?.textContent || '', name);
    const done = () => page.evaluate(() => !document.querySelector('[data-step="5"] [data-callout]').hidden);
    const end = Date.now() + 300000;
    let phase = '';
    while (Date.now() < end) {
        const primary = await rowText('primary');
        const pipeline = await rowText('pipeline');
        let next = 'Handbook updated: the on_change trigger starts one pipeline run · 4× speed';
        if (/requested|goes down/i.test(await page.evaluate(() => document.querySelector('[data-failover-status]')?.textContent || ''))) {
            next = 'Run is in Embed: failover requested, the primary goes down for real · 4× speed';
        }
        if (/^Down for/i.test(primary)) next = 'Primary down: searches keep answering; the run is paused, its finished steps saved in HorizonDB · 4× speed';
        if (/New primary/i.test(primary)) next = 'New primary took over: pg_durable picks the SAME run back up; finished steps are not redone · 4× speed';
        if (next !== phase) { phase = next; await caption(next); log(next); }
        const started = Date.now();
        await capture(250);
        if (await done()) break;
        await sleep(Math.max(0, 1000 - (Date.now() - started)));
        if (/failed|rate limit/i.test(pipeline)) log('pipeline:', pipeline);
    }
    await sleep(1500);
    await caption('Failover survived: same run finished on the new primary, and the updated rule is searchable');
    await hold(6000);
    log('step 5 callout:', await page.evaluate(() => document.querySelector('[data-step="5"] [data-callout]')?.textContent || '(none)'));
}

(async () => {
    const browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
        if (!SKIP_A) await partA();
        if (!SKIP_B) await partB();
    } finally {
        fs.writeFileSync(path.join(OUT, 'frames.json'), JSON.stringify(frames, null, 1));
        log(`${frames.length} frames written`);
        await browser.close();
    }
})().catch((error) => { console.error(error); process.exit(1); });
