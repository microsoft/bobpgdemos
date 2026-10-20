// Step-by-step walkthrough. The app is on the left, the AI pipeline on the right.
// 1 search · 2 add an article · 3 the app searches automatically while the
// pipeline runs (not blocked) · 4 search again and see the new article ·
// 5 watch searches and pg_durable carry on through a real HorizonDB failover.
// Every value shown comes from the live app and HorizonDB.
(() => {
    const root = document.querySelector('[data-walk]');
    if (!root) return;

    const QUERY = 'frozen CO2 on passenger flights';
    const TITLE = 'Dry ice in air shipments';
    const CONTENT = 'Carbon dioxide solid (dry ice, UN1845) used to chill perishables or pharma is limited to 200 kg per package on passenger aircraft. Mark the net weight on each box, use packaging that vents gas, and declare it on the air waybill.';
    const CLEANUP_KEY = 'kh-walk-cleanup';
    const STEPS = [1, 2, 3, 4, 5];

    const card = (number) => root.querySelector(`[data-step="${number}"]`);
    const part = (number, name) => card(number).querySelector(`[data-${name}]`);
    const stepButtons = [...root.querySelectorAll('[data-goto]')];
    const backButton = root.querySelector('[data-back]');
    const nextButton = root.querySelector('[data-next]');
    const resetButton = root.querySelector('[data-reset]');
    const error = root.querySelector('[data-walk-error]');
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const clock = () => new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
    const seconds = (ms) => `+${(ms / 1000).toFixed(2)} s`;

    let current = 1;
    let done = new Set();
    let run = { token: 0, timeline: [] };
    let busy = false;

    // ---------- rendering helpers ----------

    function meta(text) {
        const line = document.createElement('p');
        line.className = 'walk-meta';
        line.textContent = text;
        return line;
    }

    function output(number, ...nodes) {
        const box = part(number, 'output');
        box.replaceChildren(...nodes);
        box.hidden = false;
    }

    function callout(number, message) {
        const box = part(number, 'callout');
        box.textContent = message;
        box.hidden = false;
    }

    function results(list, highlightId = null, badgeLabel = 'NEW') {
        const ordered = document.createElement('ol');
        ordered.className = 'walk-results';
        list.slice(0, 3).forEach((result) => {
            const item = document.createElement('li');
            const isNew = String(result.article_id) === String(highlightId);
            if (isNew) item.classList.add('is-highlight');
            const title = document.createElement('strong');
            title.textContent = result.title;
            item.append(title);
            if (isNew) {
                const badge = document.createElement('span');
                badge.className = `change-badge ${badgeLabel === 'NEW' ? 'change-new' : 'change-updated'}`;
                badge.textContent = badgeLabel;
                item.append(' ', badge);
            }
            const score = document.createElement('small');
            score.textContent = ` · similarity ${result.score.toFixed(3)}`;
            item.append(score);
            const snippet = document.createElement('p');
            snippet.textContent = result.snippet.startsWith(result.title)
                ? result.snippet.slice(result.title.length).trim()
                : result.snippet;
            item.append(snippet);
            ordered.append(item);
        });
        return ordered;
    }

    function addTimeline(at, text) {
        run.timeline.push({ at, text });
        run.timeline.sort((a, b) => a.at - b.at);
        part(4, 'timeline-list').replaceChildren(...run.timeline.map((entry) => {
            const item = document.createElement('li');
            const time = document.createElement('strong');
            time.textContent = seconds(entry.at);
            item.append(time, ` ${entry.text}`);
            return item;
        }));
    }

    function showError(message) {
        error.textContent = message;
        error.hidden = !message;
    }

    // ---------- navigation ----------

    const reachable = (number) => number === 1 || done.has(number - 1);

    function renderNav() {
        stepButtons.forEach((button) => {
            const number = Number(button.dataset.goto);
            button.disabled = !reachable(number);
            button.classList.toggle('is-done', done.has(number));
            if (number === current) button.setAttribute('aria-current', 'step');
            else button.removeAttribute('aria-current');
        });
        backButton.disabled = current === 1;
        nextButton.hidden = current === STEPS.length;
        nextButton.disabled = !done.has(current);
    }

    function show(number, { moveFocus = true } = {}) {
        current = number;
        STEPS.forEach((step) => { card(step).hidden = step !== number; });
        renderNav();
        if (moveFocus) card(number).querySelector('h2').focus({ preventScroll: true });
        if (number === 5) startWatch();
        else stopWatch();
    }

    function complete(number) {
        done.add(number);
        renderNav();
    }

    stepButtons.forEach((button) => button.addEventListener('click', () => show(Number(button.dataset.goto))));
    backButton.addEventListener('click', () => current > 1 && show(current - 1));
    nextButton.addEventListener('click', () => current < STEPS.length && done.has(current) && show(current + 1));

    // ---------- data ----------

    // A request that never answers (e.g. lost by a proxy) must not freeze the walkthrough.
    async function request(url, options = {}, timeoutMs = 10000) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            return await fetch(url, { cache: 'no-store', ...options, signal: controller.signal });
        } finally {
            clearTimeout(timer);
        }
    }

    // Searches are read-only, so a lost one is hedged: if no answer within 0.8 s,
    // send another alongside it and take the first answer. `retried` is shown, not hidden.
    async function search() {
        const url = `/api/search?${new URLSearchParams({ q: QUERY, mode: 'vector' })}`;
        let answered = false;
        const attempt = async (index) => {
            if (index) await sleep(800 * index);
            if (answered) throw new Error('not needed');
            const started = performance.now();
            const response = await request(url, {}, 6000);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const payload = await response.json();
            answered = true;
            const ms = Math.round(performance.now() - started);
            return { ms, at: performance.now(), pending: payload.embedding_pending, results: payload.results, retried: index > 0 };
        };
        try {
            return await Promise.any([0, 1, 2].map(attempt));
        } catch (failure) {
            console.warn('Search failed', failure);
            throw new Error('The search did not answer (network). Select Start over to try again.');
        }
    }

    const retryNote = (answer) => (answer.retried ? ' · after a network retry' : '');

    async function deleteArticle(id) {
        await request(`/articles/${id}/delete`, { method: 'POST', body: new URLSearchParams({ q: '', mode: 'vector' }), redirect: 'manual' });
    }

    // Remove the demo article from an earlier run (also after a page reload).
    async function cleanup() {
        const response = await request(`/api/search?${new URLSearchParams({ q: TITLE, mode: 'keyword' })}`);
        if (response.ok) {
            const { results: found } = await response.json();
            for (const result of found.filter((item) => item.title === TITLE)) await deleteArticle(result.article_id);
        }
        sessionStorage.removeItem(CLEANUP_KEY);
    }

    async function guarded(action) {
        if (busy) return;
        busy = true;
        resetButton.disabled = true;
        try {
            await action();
        } catch (failure) {
            console.error(failure);
            showError(failure.message || 'Something went wrong. Select Start over.');
        } finally {
            busy = false;
            resetButton.disabled = false;
        }
    }

    // ---------- steps ----------

    // 1. Search.
    part(1, 'action').addEventListener('click', () => guarded(async () => {
        part(1, 'action').disabled = true;
        const answer = await search();
        part(1, 'action').hidden = true;
        output(1, meta(`${clock()} · answered in ${answer.ms} ms${retryNote(answer)}`), results(answer.results));
        const already = answer.results.some((result) => result.title === TITLE);
        callout(1, already ? 'The demo article is already there from an earlier run. Select Start over.' : 'No article covers dry ice on aircraft yet.');
        complete(1);
    }));

    // 2. Add an article. Step 3 then runs on its own.
    // The on_change trigger does not start a run while one is active (and nothing
    // re-queues the change), so wait for any earlier run, e.g. step 5's, to finish.
    async function waitForIdlePipeline(number) {
        const deadline = performance.now() + 120000;
        while (performance.now() < deadline) {
            const response = await request('/api/status').catch(() => null);
            const snapshot = response?.ok ? await response.json() : null;
            if (snapshot && snapshot.run_status !== 'running') {
                part(number, 'output').hidden = true;
                return;
            }
            output(number, meta(snapshot ? `Waiting for the current pipeline run #${snapshot.run?.id ?? '?'} to finish…` : 'Waiting for HorizonDB…'));
            await sleep(1000);
        }
        throw new Error('A pipeline run is still in progress. Try again in a minute.');
    }

    part(2, 'action').addEventListener('click', () => guarded(async () => {
        part(2, 'action').disabled = true;
        await waitForIdlePipeline(2);
        const started = performance.now();
        const response = await request('/articles', {
            method: 'POST',
            body: new URLSearchParams({ title: TITLE, category: 'Handling procedure', content: CONTENT, author: 'Step by step' }),
            headers: { Accept: 'application/json' },
        });
        if (!response.ok) throw new Error('The article could not be saved.');
        const { article_id: id } = await response.json();
        run.articleId = id;
        run.t0 = performance.now();
        sessionStorage.setItem(CLEANUP_KEY, JSON.stringify({ id }));
        part(2, 'action').hidden = true;
        output(2, meta(`${clock()} · saved in ${Math.round(run.t0 - started)} ms`));
        callout(2, 'Saved. The on_change trigger started the AI pipeline on the right.');
        addTimeline(0, 'article saved, pipeline starts');
        complete(2);
        output(3, meta('Searching…'));
        autoSearch(run.token);
    }));

    // 3. Search automatically while the pipeline runs, then keep checking until it is done.
    async function autoSearch(token) {
        const stale = () => token !== run.token;
        try {
            let first = null;
            const deadline = performance.now() + 90000;
            while (performance.now() < deadline) {
                const answer = await search();
                if (stale()) return;
                if (!first) {
                    first = answer;
                    renderAutoSearch(answer);
                    if (current === 2) show(3);
                }
                if (!answer.pending) {
                    if (answer !== first) addTimeline(answer.at - run.t0, 'pipeline finished');
                    callout(3, answer === first
                        ? 'The pipeline had already finished this time. Select Next to search again, or Start over.'
                        : `Not blocked: the search answered in ${first.ms} ms while the pipeline was still running, so the new article is not in the results yet. Watch the run on the right, then select Next.`);
                    complete(3);
                    return;
                }
                await sleep(250);
            }
            throw new Error('The pipeline did not finish within 90 seconds.');
        } catch (failure) {
            if (!stale()) showError(failure.message || 'Something went wrong. Select Start over.');
        }
    }

    function renderAutoSearch(answer) {
        const at = seconds(answer.at - run.t0);
        output(3,
            meta(answer.pending
                ? `${at} after your save · answered in ${answer.ms} ms${retryNote(answer)} · pipeline still running`
                : `${at} after your save · answered in ${answer.ms} ms${retryNote(answer)}`),
            results(answer.results));
        if (answer.pending) {
            callout(3, `Not blocked: answered in ${answer.ms} ms with the rows already indexed. The new article is not there yet, because the pipeline is still working.`);
            addTimeline(answer.at - run.t0, `automatic search answered in ${answer.ms} ms, pipeline still running`);
        }
    }

    // 4. Search again.
    part(4, 'action').addEventListener('click', () => guarded(async () => {
        part(4, 'action').disabled = true;
        const answer = await search();
        part(4, 'action').hidden = true;
        const position = answer.results.findIndex((result) => String(result.article_id) === String(run.articleId)) + 1;
        output(4, meta(`${seconds(answer.at - run.t0)} after your save · answered in ${answer.ms} ms${retryNote(answer)}`), results(answer.results, run.articleId));
        callout(4, position
            ? `The new article is in your results at #${position}. No reload, no re-index job, no embedding code in the app.`
            : 'The new article is not in the top results for this search.');
        addTimeline(answer.at - run.t0, position ? `search again: new article at #${position}` : 'search again');
        part(4, 'timeline').hidden = false;
        complete(4);
    }));

    // 5. Survive a failover mid-run. The app revises the 16-part handbook (one long
    // pipeline run), waits until the run is in the middle of Embed, forces a real
    // HorizonDB failover, and shows the same pg_durable run picking back up.
    const RULE_QUERY = 'forklift speed limit in Dock 4';
    const STAGE_LABELS = [['source', 'Changed rows'], ['chunk', 'Chunk'], ['embed', 'Embed'], ['sink', 'Write vectors'], ['checkpoint', 'Checkpoint']];
    let watch = null;

    function setRow(name, text, state = '') {
        const row = root.querySelector(`[data-monitor="${name}"]`);
        row.querySelector('[data-monitor-value]').textContent = text;
        row.className = state ? `is-${state}` : '';
    }

    function failoverStatus(text) {
        const box = part(5, 'failover-status');
        box.textContent = text;
        box.hidden = !text;
    }

    // The app polls once a second, so outages are measured to about a second.
    const outageText = (ms) => (ms < 1500 ? 'about 1 s' : `${Math.round(ms / 1000)} s`);

    // Shown the moment a new primary answers, while the pipeline is still finishing.
    function showRecovered(state) {
        const { searches, newPrimary, first, downFor, run } = state;
        const head = document.createElement('strong');
        head.textContent = downFor != null ? `✓ App back online in ${outageText(downFor)}` : '✓ App stayed online';
        const detail = document.createElement('span');
        detail.textContent = `New primary ${newPrimary.server_id} took over from ${first.server_id}. Searches kept answering: ${searches.duringOutage} during the switch, ${searches.failed} failed.`;
        const note = document.createElement('span');
        note.textContent = run?.status === 'running'
            ? 'The AI pipeline is finishing its batch in the background on the new primary. The app does not wait for it.'
            : '';
        part(5, 'recovered').replaceChildren(head, detail, note);
        part(5, 'recovered').hidden = false;
        if (!state.recoveryShown) {
            state.recoveryShown = true;
            failoverStatus('');
        }
    }

    function resetWatchRows() {
        setRow('pipeline', 'Waiting for the update…');
        setRow('primary', 'Checking…');
        setRow('search', 'Starting…');
        part(5, 'failover-how').hidden = true;
        part(5, 'recovered').hidden = true;
        part(5, 'action').hidden = true;
        part(5, 'action').disabled = false;
        part(5, 'output').hidden = true;
        part(5, 'callout').hidden = true;
        failoverStatus('');
    }

    function stopWatch() {
        if (watch) watch.active = false;
        watch = null;
    }

    function startWatch() {
        stopWatch();
        resetWatchRows();
        const state = {
            active: true,
            done: false,
            searches: { ok: 0, failed: 0, last: null, duringOutage: 0 },
            first: null,
            newPrimary: null,
            downSince: null,
            downFor: null,
            run: null,
            runId: null,
            stagesBeforeDown: null,
            pausedAt: null,
            requested: false,
        };
        watch = state;
        watchSearches(state);
        watchCluster(state);
    }

    async function watchSearches(state) {
        // Step 5 only needs the answer, not the embedding status, so these
        // searches touch only the read endpoint.
        const url = `/api/search?${new URLSearchParams({ q: QUERY, mode: 'vector', pending: '0' })}`;
        while (state.active) {
            const started = performance.now();
            try {
                const response = await request(url, {}, 4000);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                await response.json();
                state.searches.ok += 1;
                state.searches.last = Math.round(performance.now() - started);
                if (state.downSince && !state.newPrimary) state.searches.duringOutage += 1;
            } catch {
                state.searches.failed += 1;
            }
            if (!state.active) return;
            renderWatch(state);
            await sleep(Math.max(0, 1000 - (performance.now() - started)));
        }
    }

    async function watchCluster(state) {
        while (state.active) {
            const started = performance.now();
            let info = null;
            try {
                const response = await request('/api/cluster', {}, 4000);
                if (response.ok) info = await response.json();
            } catch {
                info = null;
            }
            if (!state.active) return;
            if (info) {
                if (!state.first) {
                    state.first = info;
                    part(5, 'action').hidden = !info.failover_enabled;
                    part(5, 'failover-how').hidden = Boolean(info.failover_enabled);
                    if (info.failover_ready_in) failoverStatus(`The last failover was recent. The button works again in ${info.failover_ready_in} s.`);
                }
                if (state.downSince) {
                    state.downFor = Date.now() - state.downSince;
                    state.downSince = null;
                }
                if (!state.newPrimary && info.server_id !== state.first.server_id) state.newPrimary = info;
            } else if (state.first && !state.downSince) {
                state.downSince = Date.now();
            }
            if (state.runId) await pollRun(state);
            renderWatch(state);
            await sleep(Math.max(0, 1000 - (performance.now() - started)));
        }
    }

    async function pollRun(state) {
        try {
            const response = await request('/api/status', {}, 4000);
            if (!response.ok) return;
            const snapshot = await response.json();
            const runs = snapshot.runs || [];
            const mine = runs.find((item) => item.id === state.runId);
            if (!mine) return;
            const stages = snapshot.run?.id === state.runId ? snapshot.stages || {} : state.run?.stages || {};
            state.run = { status: mine.status, instance: mine.instance_id, rows: mine.rows_processed, error: mine.error, stages };
            if (!state.downSince && !state.newPrimary) state.stagesBeforeDown = state.run.stages;
        } catch {
            // The primary is failing over; the cluster loop shows that.
        }
    }

    const stageLine = (stages) => STAGE_LABELS
        .filter(([key]) => ['completed', 'running'].includes(stages?.[key]?.state))
        .map(([key, label]) => (stages[key].state === 'completed' ? `${label} ✓` : `${label} running…`))
        .join(' · ');
    const runningStage = (stages) => STAGE_LABELS.find(([key]) => stages?.[key]?.state === 'running')?.[1];
    const finishedBefore = (stages) => STAGE_LABELS.filter(([key]) => stages?.[key]?.state === 'completed').map(([, label]) => label);

    // Wait until the run is in the middle of Embed, so the failover interrupts it.
    async function waitForEmbed(state, timeoutMs = 20000) {
        const deadline = performance.now() + timeoutMs;
        while (state.active && performance.now() < deadline) {
            await pollRun(state);
            renderWatch(state);
            if (state.run?.stages?.embed?.state === 'running') return true;
            if (state.run && state.run.status !== 'running') return false;
            await sleep(400);
        }
        return false;
    }

    part(5, 'action').addEventListener('click', async () => {
        const state = watch;
        if (!state) return;
        const button = part(5, 'action');
        button.disabled = true;
        try {
            failoverStatus('Updating all 16 parts of the handbook in one statement…');
            const saved = await request('/api/handbook', { method: 'POST' }, 20000);
            const payload = await saved.json().catch(() => ({}));
            if (!saved.ok) throw new Error(payload.error || `The update failed (HTTP ${saved.status}).`);
            state.runId = payload.run_id;
            state.ruleArticle = payload.article_id;
            failoverStatus(`${clock()} · Handbook updated. Pipeline run #${payload.run_id ?? '?'} started on its own; waiting for it to reach Embed…`);
            if (!(await waitForEmbed(state))) throw new Error('The run did not reach Embed in time. Select Start over and try again.');
            const response = await request('/api/failover', { method: 'POST' }, 45000);
            const result = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(result.error || `The failover request failed (HTTP ${response.status}).`);
            state.requested = true;
            button.hidden = true;
            failoverStatus(`${clock()} · Failover requested while run #${state.runId} is in Embed. The primary in zone ${result.from_zone ?? '?'} goes down in about 15 seconds.`);
        } catch (failure) {
            failoverStatus(failure.message || 'Something went wrong.');
            button.disabled = false;
        }
    });

    function renderWatch(state) {
        if (watch !== state) return;
        const { searches, run } = state;
        if (searches.ok + searches.failed) {
            const during = searches.duringOutage ? ` (${searches.duringOutage} while the primary was down)` : '';
            setRow('search', `${searches.ok} answered${during} · last ${searches.last ?? '—'} ms · ${searches.failed} failed`, searches.failed ? 'warn' : 'ok');
        }

        if (state.newPrimary) {
            const outage = state.downFor != null ? `Back online after ${outageText(state.downFor)}` : 'Switched with no outage seen';
            setRow('primary', `${outage}: new primary ${state.newPrimary.server_id} (was ${state.first.server_id})`, 'ok');
            showRecovered(state);
        } else if (state.downSince) {
            setRow('primary', `Down for ${Math.round((Date.now() - state.downSince) / 1000)} s… failover in progress`, 'down');
        } else if (state.first) {
            setRow('primary', `Server ${state.first.server_id} · up since ${new Date(state.first.started_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`);
        }

        if (!state.runId || !run) return;
        const before = state.stagesBeforeDown;
        if (state.downSince && !state.newPrimary) {
            state.pausedAt = state.pausedAt || runningStage(before) || 'Embed';
            setRow('pipeline', `Primary down: run #${state.runId} paused at ${state.pausedAt}. Its finished steps are saved in HorizonDB.`, 'down');
        } else if (!state.newPrimary) {
            setRow('pipeline', `Run #${state.runId} (pg_durable ${run.instance ?? '?'}) · ${stageLine(run.stages) || 'starting…'}`);
        } else if (run.status === 'running') {
            const kept = finishedBefore(before);
            setRow('pipeline', `Same run #${state.runId} picked back up at ${state.pausedAt || runningStage(run.stages) || 'Embed'} on the new primary${kept.length ? ` (${kept.join(', ')} not redone)` : ''}…`, 'ok');
        } else if (run.status === 'completed') {
            const kept = finishedBefore(before);
            setRow('pipeline', state.pausedAt
                ? `Same run #${state.runId} finished on the new primary: ${run.rows ?? '?'} chunks. ${kept.join(' and ')} ran once.`
                : `Run #${state.runId} finished before the failover hit (${run.rows ?? '?'} chunks).`, 'ok');
        } else {
            const reason = /RateLimit/i.test(run.error || '') ? 'AI service rate limit' : (run.error || run.status).slice(0, 60);
            setRow('pipeline', `Run #${state.runId} ${run.status} (${reason}).`, 'warn');
        }

        if (!state.done && state.newPrimary && run.status && run.status !== 'running') {
            state.done = true;
            finish(state);
        }
    }

    async function finish(state) {
        failoverStatus('');
        try {
            const response = await request(`/api/search?${new URLSearchParams({ q: RULE_QUERY, mode: 'vector' })}`, {}, 15000);
            const payload = await response.json();
            // Show the revised sentence, not the start of the chunk it is in.
            const top = payload.results.slice(0, 1).map((result) => {
                const at = result.snippet.indexOf('Revised');
                return at >= 0 ? { ...result, snippet: `… ${result.snippet.slice(at)}` } : result;
            });
            output(5, meta(`Search "${RULE_QUERY}" on the new primary:`), results(top, state.ruleArticle, 'UPDATED'));
        } catch {
            output(5, meta(`Search "${RULE_QUERY}" did not answer. Try it in the full app.`));
        }
        const searchSummary = state.searches.failed ? `${state.searches.failed} searches failed during the switch` : 'searches never stopped';
        const back = state.downFor != null ? `The app was back online in ${outageText(state.downFor)}` : 'The app stayed online';
        const { run } = state;
        let message;
        if (run.status === 'completed' && state.pausedAt) {
            message = `Failover survived: ${back.charAt(0).toLowerCase()}${back.slice(1)} and ${searchSummary}. In the background, pg_durable finished the same run #${state.runId} on the new primary, and the update is searchable.`;
        } else if (run.status === 'completed') {
            message = `${back} and ${searchSummary}. Run #${state.runId} finished before the failover hit this time; select Start over to try again.`;
        } else {
            message = `${back} and ${searchSummary}, but run #${state.runId} ${run.status}. This preview does not retry a failed run on its own; select Start over to run step 5 again.`;
        }
        callout(5, message);
        complete(5);
    }

    // ---------- start over ----------

    function resetUi() {
        stopWatch();
        resetWatchRows();
        run = { token: run.token + 1, timeline: [] };
        done = new Set();
        STEPS.forEach((number) => {
            part(number, 'output').hidden = true;
            part(number, 'callout').hidden = true;
        });
        [1, 2, 4].forEach((number) => {
            part(number, 'action').disabled = false;
            part(number, 'action').hidden = false;
        });
        part(4, 'timeline').hidden = true;
        part(4, 'timeline-list').replaceChildren();
        showError('');
    }

    resetButton.addEventListener('click', () => guarded(async () => {
        resetUi();
        await cleanup();
        show(1);
    }));

    part(2, 'article').textContent = `${TITLE}: ${CONTENT}`;
    resetUi();
    show(1, { moveFocus: false });
    guarded(cleanup);
})();
