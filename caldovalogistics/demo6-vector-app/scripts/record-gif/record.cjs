// Records the Caldova Knowledge Hub step-by-step walkthrough (Demo 6, the five
// steps on "/") from the deployed app into PNG frames plus frames.json
// (file + display duration). make-gif.py turns them into a GIF.
// Step 5 forces a REAL HorizonDB failover; pass --skip-failover to stop after step 4.
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const BASE = process.env.KNOWLEDGE_HUB_URL || 'https://caldova-knowledge-hub-d1229495.azurewebsites.net';
const OUT = path.join(__dirname, 'frames');
const SKIP_FAILOVER = process.argv.includes('--skip-failover');

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

async function waitFor(fn, timeoutMs, label) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        if (await fn()) return;
        await sleep(250);
    }
    throw new Error(`Timed out waiting for ${label}`);
}

// Capture at roughly real time until `until` is true (or the time runs out).
async function recordUntil(until, timeoutMs, intervalMs = 300) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        const started = Date.now();
        await capture(intervalMs);
        if (await until()) return true;
        await sleep(Math.max(0, intervalMs - (Date.now() - started)));
    }
    return false;
}

const nextEnabled = () => page.evaluate(() => {
    const next = document.querySelector('[data-next]');
    return Boolean(next && !next.hidden && !next.disabled);
});
const stepVisible = (n) => page.evaluate((s) => !document.querySelector(`[data-step="${s}"]`).hidden, n);
const reveal = (selector) => page.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: 'nearest' }), selector);
const next = () => page.click('[data-next]');

async function walkthrough() {
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await sleep(2500); // the page removes a leftover demo article on load
    await caption('Caldova Knowledge Hub on Azure HorizonDB · left: the app · right: the AI pipeline, live');
    await capture(3500);

    log('step 1');
    await caption('1 · Search for "frozen CO2 on passenger flights"');
    await capture(2200);
    await page.click('[data-step="1"] [data-action="search-before"]');
    await waitFor(nextEnabled, 30000, 'step 1');
    await sleep(400);
    await caption('1 · Answered from the vector index: no article covers dry ice on aircraft yet');
    await capture(4200);

    log('step 2');
    await next();
    await sleep(400);
    await caption('2 · Add an article. The app only saves a row; the AI pipeline does the rest');
    await capture(3200);
    await page.click('[data-step="2"] [data-action="change"]');
    await caption('2 · Saved: the on_change trigger starts the AI pipeline (right)');
    await recordUntil(() => stepVisible(3), 20000, 250);

    log('step 3');
    await caption('3 · Searched automatically while the pipeline runs: answered right away, new article not there yet');
    const step3Done = async () => (await stepVisible(3)) && (await nextEnabled());
    await recordUntil(step3Done, 90000, 300);
    await caption('3 · On the right: the same pipeline run, replayed stage by stage from pg_durable\'s recorded step times');
    const replayDone = () => page.evaluate(() => !/Replaying/i.test(document.querySelector('[data-caption]')?.textContent || ''));
    await sleep(600);
    await recordUntil(replayDone, 15000, 400);
    await reveal('[data-step="3"] [data-callout]');
    await caption('3 · Not blocked: the search answered while the pipeline was still embedding');
    await capture(4500);

    log('step 4');
    await next();
    await sleep(400);
    await caption('4 · Search again');
    await capture(2000);
    await page.click('[data-step="4"] [data-action="search-after"]');
    await waitFor(nextEnabled, 30000, 'step 4');
    await sleep(500);
    await caption('4 · The new article is #1, marked NEW: no reload, no re-index job, no embedding code in the app');
    await capture(4500);
    await reveal('[data-step="4"] [data-timeline]');
    await caption('4 · What happened, in order: saved → searched (not blocked) → pipeline finished → found');
    await capture(5000);

    if (SKIP_FAILOVER) return;

    log('step 5');
    await next();
    await waitFor(() => page.evaluate(() => !document.querySelector('[data-step="5"] [data-action]').hidden), 30000, 'failover button');
    await sleep(2500);
    await caption('5 · Update a 16-part handbook (one long pipeline run), then fail over HorizonDB for real');
    await capture(3800);
    await page.click('[data-step="5"] [data-action="failover"]');
    log('failover requested');

    const rowText = (name) => page.evaluate((n) => document.querySelector(`[data-monitor="${n}"] [data-monitor-value]`)?.textContent || '', name);
    const statusText = () => page.evaluate(() => document.querySelector('[data-failover-status]')?.textContent || '');
    const done = () => page.evaluate(() => !document.querySelector('[data-step="5"] [data-callout]').hidden);
    const end = Date.now() + 300000;
    let phase = '';
    while (Date.now() < end) {
        const primary = await rowText('primary');
        let text = '5 · Handbook updated: the on_change trigger starts one pipeline run · 4× speed';
        if (/requested|goes down/i.test(await statusText())) text = '5 · Run is in Embed: failover requested, the primary goes down for real · 4× speed';
        if (/^Down for/i.test(primary)) text = '5 · Primary down: searches keep answering; the run is paused, its finished steps saved in HorizonDB · 4× speed';
        if (/New primary/i.test(primary)) text = '5 · New primary took over: pg_durable picks the SAME run back up; finished steps are not redone · 4× speed';
        if (text !== phase) { phase = text; await caption(text); log(text); }
        const started = Date.now();
        await capture(250);
        if (await done()) break;
        await sleep(Math.max(0, 1000 - (Date.now() - started)));
    }
    await sleep(1500);
    await reveal('[data-step="5"] [data-callout]');
    await caption('5 · Failover survived: same run finished on the new primary, and the updated rule is searchable');
    await capture(6000);
    log('step 5 callout:', await page.evaluate(() => document.querySelector('[data-step="5"] [data-callout]')?.textContent || '(none)'));
}

async function removeDemoArticle() {
    // Same cleanup as the walkthrough's Start over: delete the demo article.
    await page.evaluate(async () => {
        const title = 'Dry ice in air shipments';
        for (let i = 0; i < 60; i += 1) {
            const status = await (await fetch('/api/status', { cache: 'no-store' })).json();
            if (status.run_status !== 'running') break;
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        const found = await (await fetch(`/api/search?${new URLSearchParams({ q: title, mode: 'keyword' })}`)).json();
        for (const item of found.results.filter((result) => result.title === title)) {
            await fetch(`/articles/${item.article_id}/delete`, { method: 'POST', body: new URLSearchParams({ q: '', mode: 'vector' }), redirect: 'manual' });
        }
    });
}

(async () => {
    const browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
        await walkthrough();
    } finally {
        fs.writeFileSync(path.join(OUT, 'frames.json'), JSON.stringify(frames, null, 1));
        log(`${frames.length} frames written`);
        await removeDemoArticle().catch((error) => log('cleanup failed:', error.message));
        await browser.close();
    }
})().catch((error) => { console.error(error); process.exit(1); });
