// -----------------------------
// ICONS
// -----------------------------

const SVG_REFRESH = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>';
const SVG_CHECK   = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
const SVG_TRASH   = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>';

// -----------------------------
// STATE
// -----------------------------

let allGames = [];
let sortKey = 'name';
let sortAsc = true;
let activeFilter = 'all';
let scanRunning = false;
let scanUpdatedNames = new Set();  // games whose version changed this session
let scannedNames = new Set();      // games checked (checkbox) this session
let prevVersions = {};             // scraped_version snapshot before a bulk scan

// -----------------------------
// BOOT
// -----------------------------

document.addEventListener('DOMContentLoaded', async () => {
    setupFilters();
    setupAddForm();
    document.getElementById('btn-scan-all').addEventListener('click', scanAll);
    document.getElementById('btn-toggle-add').addEventListener('click', () => {
        const panel = document.getElementById('add-panel');
        panel.hidden = !panel.hidden;
    });
    await loadGames();
});

// -----------------------------
// API — server communication
// -----------------------------

/* Fetch all games from the server and render the tables. */
async function loadGames() {
    const resp = await fetch('/games');
    allGames = await resp.json();
    renderTables();
}

/*
 * Trigger a full scan via POST /scan, then open an SSE stream to receive
 * per-game results as they arrive. Updates each row in-place as events come in.
 * Guard flag prevents double-clicks from launching two concurrent scans.
 */
async function scanAll() {
    if (scanRunning) return;
    scanRunning = true;

    prevVersions = Object.fromEntries(allGames.map(g => [g.name, g.scraped_version]));
    scanUpdatedNames.clear();
    scannedNames.clear();
    document.querySelectorAll('td.col-check input[type="checkbox"]').forEach(cb => cb.checked = false);

    const btn = document.getElementById('btn-scan-all');
    btn.disabled = true;
    btn.textContent = 'Scanning...';
    setStatus('Scan started...');

    await fetch('/scan', { method: 'POST' });

    let done = 0;
    const total = allGames.filter(g => g.active !== false).length;
    const es = new EventSource('/scan/stream');

    es.onmessage = (e) => {
        const data = JSON.parse(e.data);
        if (data.type === 'result') {
            done++;
            /* Compare against the snapshot taken before the scan started, not the
               live allGames entry, which may already be mutated by a prior event. */
            const wasUpdated = data.game.scraped_version !== prevVersions[data.game.name]
                               && data.game.scraped_version != null;
            scannedNames.add(data.game.name);
            updateGame(data.game, wasUpdated);
            setStatus(`Checked ${done} / ${total}`);
        } else if (data.type === 'done') {
            es.close();
            finishScan(btn);
        } else if (data.type === 'error') {
            es.close();
            finishScan(btn);
            setStatus('Scan error: ' + (data.detail || 'unknown'));
        }
    };

    es.onerror = () => {
        es.close();
        finishScan(btn);
        setStatus('Scan stream disconnected.');
    };
}

/* Reset scan UI state after a bulk scan completes or errors. */
function finishScan(btn) {
    scanRunning = false;
    btn.disabled = false;
    btn.textContent = 'Scan All';
    setStatus('Scan complete.');
}

/* Check a single game by name; highlight its row if the version changed. */
async function scanOne(name) {
    const prev = allGames.find(g => g.name === name)?.scraped_version;
    const resp = await fetch(`/scan/${encodeURIComponent(name)}`, { method: 'POST' });
    const game = await resp.json();
    const wasUpdated = game.scraped_version !== prev && game.scraped_version != null;
    scannedNames.add(name);
    updateGame(game, wasUpdated);
}

/* Mark a game as played — resets needs_update and update_count on the server. */
async function markPlayed(name) {
    const resp = await fetch(`/games/${encodeURIComponent(name)}/played`, { method: 'POST' });
    const game = await resp.json();
    scanUpdatedNames.delete(name);
    updateGame(game, false);
}

/* PATCH arbitrary fields on a game (e.g. installed_version). */
async function updateField(name, fields) {
    const resp = await fetch(`/games/${encodeURIComponent(name)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
    });
    if (resp.ok) {
        const game = await resp.json();
        const idx = allGames.findIndex(g => g.name === name);
        if (idx >= 0) allGames[idx] = game;
        updateFilterCounts();
    }
}

/* Toggle whether a game is included in bulk scans. */
async function toggleActive(name) {
    const resp = await fetch(`/games/${encodeURIComponent(name)}/toggle-active`, { method: 'POST' });
    if (resp.ok) {
        const game = await resp.json();
        updateGame(game, false);
    }
}

/* Delete a game after user confirmation. */
async function deleteGame(name) {
    if (!confirm(`Delete "${name}"?`)) return;
    const resp = await fetch(`/games/${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (resp.ok) {
        allGames = allGames.filter(g => g.name !== name);
        renderTables();
    }
}

/* Add a new game entry via the form, then append its row without a full re-render. */
async function addGame(name, group, url) {
    const resp = await fetch('/games', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, group, url }),
    });
    if (!resp.ok) {
        const err = await resp.json();
        alert(err.detail || 'Error adding game');
        return;
    }
    const game = await resp.json();
    allGames.push(game);
    renderTables();
}

// -----------------------------
// STATE UPDATES
// -----------------------------

/*
 * Merge an updated game object into allGames, then patch the existing DOM row
 * in-place. Falls back to a full re-render if the row isn't found (e.g. first
 * appearance of a game).
 */
function updateGame(game, wasUpdated = false) {
    const idx = allGames.findIndex(g => g.name === game.name);
    if (idx >= 0) {
        allGames[idx] = game;
    } else {
        allGames.push(game);
    }
    if (wasUpdated) scanUpdatedNames.add(game.name);

    const row = document.querySelector(`tr[data-name="${CSS.escape(game.name)}"]`);
    if (row) {
        row.replaceWith(buildRow(game));
    } else {
        renderTables();
    }
    updateFilterCounts();
}

// -----------------------------
// RENDER
// -----------------------------

/*
 * Return the filtered + sorted game list.
 * Inactive games always sort to the bottom regardless of the active sort column.
 */
function filteredAndSorted() {
    let games = [...allGames];
    switch (activeFilter) {
        case 'needs-update': games = games.filter(g => g.needs_update); break;
        case 'abandoned':    games = games.filter(g => g.status === 'Abandoned'); break;
        case 'complete':     games = games.filter(g => g.status === 'Complete'); break;
        case 'errors':       games = games.filter(g => g.error); break;
    }
    games.sort((a, b) => {
        const aActive = a.active !== false ? 0 : 1;
        const bActive = b.active !== false ? 0 : 1;
        if (aActive !== bActive) return aActive - bActive;
        const av = a[sortKey] ?? '';
        const bv = b[sortKey] ?? '';
        if (av < bv) return sortAsc ? -1 : 1;
        if (av > bv) return sortAsc ? 1 : -1;
        return 0;
    });
    return games;
}

/* Build one <section> per group and inject them into #games-container. */
function renderTables() {
    const container = document.getElementById('games-container');
    container.innerHTML = '';

    const games = filteredAndSorted();
    const groups = [...new Set(allGames.map(g => g.group))].sort();

    for (const group of groups) {
        const groupGames = games.filter(g => g.group === group);
        if (groupGames.length === 0) continue;

        const section = document.createElement('section');
        section.className = 'group-section';

        const heading = document.createElement('h2');
        heading.className = 'group-heading';
        heading.textContent = group;
        section.appendChild(heading);

        section.appendChild(buildTable(groupGames));
        container.appendChild(section);
    }

    updateFilterCounts();
}

/* Build a sortable <table> for a single group of games. */
function buildTable(games) {
    const table = document.createElement('table');

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    const cols = [
        { label: '',                          key: null },
        { label: 'Name',                      key: 'name' },
        { label: 'Updates Since Last Played', key: 'update_count' },
        { label: 'Latest Version',            key: 'scraped_version' },
        { label: 'Release Date',              key: 'release_date' },
        { label: 'URL',                       key: null },
        { label: 'Active',                    key: null },
        { label: 'Actions',                   key: null },
    ];
    for (const col of cols) {
        const th = document.createElement('th');
        th.textContent = col.label;
        if (col.key) {
            th.dataset.sort = col.key;
            if (sortKey === col.key) th.classList.add(sortAsc ? 'sort-asc' : 'sort-desc');
            th.addEventListener('click', () => {
                if (sortKey === col.key) {
                    sortAsc = !sortAsc;
                } else {
                    sortKey = col.key;
                    /* update_count sorts descending by default so the most-missed
                       games appear at the top immediately on first click. */
                    sortAsc = col.key !== 'update_count';
                }
                renderTables();
            });
        }
        headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const game of games) {
        tbody.appendChild(buildRow(game));
    }
    table.appendChild(tbody);

    return table;
}

/* Build a single table row for a game. */
function buildRow(game) {
    const tr = document.createElement('tr');
    tr.dataset.name = game.name;

    if (game.error) tr.classList.add('has-error');
    if (scanUpdatedNames.has(game.name) && game.needs_update) tr.classList.add('row-updated');
    if (game.status === 'Abandoned') tr.classList.add('status-abandoned');
    if (game.status === 'Complete')  tr.classList.add('status-complete');

    // Scan-done indicator — checked once the game has been scanned this session
    const checkTd = document.createElement('td');
    checkTd.className = 'col-check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = scannedNames.has(game.name);
    cb.tabIndex = -1;
    checkTd.appendChild(cb);
    tr.appendChild(checkTd);

    tr.appendChild(cell(game.name));
    tr.appendChild(cell(game.update_count > 0 ? `${game.update_count}x` : ''));
    tr.appendChild(cell(game.scraped_version ?? '—'));

    const dateStr = game.release_date ? game.release_date.substring(0, 10) : '—';
    tr.appendChild(cell(dateStr));

    // External link to the game page
    const linkTd = document.createElement('td');
    const a = document.createElement('a');
    a.href = game.url;
    a.target = '_blank';
    a.rel = 'noreferrer';
    a.textContent = '↗';
    a.title = game.url;
    linkTd.appendChild(a);
    tr.appendChild(linkTd);

    // Active toggle — controls whether the game is included in bulk scans
    const activeTd = document.createElement('td');
    activeTd.className = 'col-active';
    const activeCb = document.createElement('input');
    activeCb.type = 'checkbox';
    activeCb.checked = game.active !== false;
    activeCb.title = activeCb.checked ? 'Active — click to exclude from scans' : 'Inactive — click to include in scans';
    activeCb.onchange = () => toggleActive(game.name);
    activeTd.appendChild(activeCb);
    tr.appendChild(activeTd);

    // Actions — "Mark as Updated" uses visibility:hidden (not display:none) to
    // keep column width stable whether or not the button is showing.
    const actionsTd = document.createElement('td');
    actionsTd.className = 'actions';

    const checkBtn = document.createElement('button');
    checkBtn.innerHTML = SVG_REFRESH;
    checkBtn.className = 'btn btn-icon';
    checkBtn.title = 'Check for update';
    checkBtn.onclick = async () => {
        checkBtn.disabled = true;
        await scanOne(game.name);
    };
    actionsTd.appendChild(checkBtn);

    const markBtn = document.createElement('button');
    markBtn.innerHTML = SVG_CHECK;
    markBtn.className = 'btn btn-icon btn-mark-updated';
    markBtn.title = 'Mark as Played';
    markBtn.style.visibility = game.needs_update ? 'visible' : 'hidden';
    markBtn.onclick = () => markPlayed(game.name);
    actionsTd.appendChild(markBtn);

    if (game.error) {
        const errSpan = document.createElement('span');
        errSpan.className = 'error-tip';
        errSpan.title = game.error;
        errSpan.textContent = '⚠';
        actionsTd.appendChild(errSpan);
    }

    const deleteBtn = document.createElement('button');
    deleteBtn.innerHTML = SVG_TRASH;
    deleteBtn.className = 'btn btn-icon btn-delete';
    deleteBtn.title = 'Delete Game';
    deleteBtn.onclick = () => deleteGame(game.name);
    actionsTd.appendChild(deleteBtn);

    tr.appendChild(actionsTd);
    return tr;
}

/* Create a plain <td> with text content. */
function cell(text) {
    const td = document.createElement('td');
    td.textContent = text;
    return td;
}

// -----------------------------
// FILTERS
// -----------------------------

/* Wire filter buttons; clicking one sets activeFilter and re-renders. */
function setupFilters() {
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            activeFilter = btn.dataset.filter;
            document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            renderTables();
        });
    });
}

/* Update the count badge on each filter button to reflect current allGames. */
function updateFilterCounts() {
    const counts = {
        all:            allGames.length,
        'needs-update': allGames.filter(g => g.needs_update).length,
        abandoned:      allGames.filter(g => g.status === 'Abandoned').length,
        complete:       allGames.filter(g => g.status === 'Complete').length,
        errors:         allGames.filter(g => g.error).length,
    };
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.querySelector('.filter-count').textContent = counts[btn.dataset.filter] ?? 0;
    });
}

// -----------------------------
// ADD FORM
// -----------------------------

/* Handle the Add Game form submission. */
function setupAddForm() {
    document.getElementById('add-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const name  = document.getElementById('add-name').value.trim();
        const group = document.getElementById('add-group').value;
        const url   = document.getElementById('add-url').value.trim();
        await addGame(name, group, url);
        e.target.reset();
    });
}

// -----------------------------
// STATUS BAR
// -----------------------------

function setStatus(msg) {
    document.getElementById('scan-status').textContent = msg;
}
