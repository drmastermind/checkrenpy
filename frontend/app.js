// State
let allGames = [];
let sortKey = 'name';
let sortAsc = true;
let activeFilter = 'all';
let scanRunning = false;
let scanUpdatedNames = new Set();  // version changed this session
let scannedNames = new Set();      // scanned (checked) this session

// ---- Boot ----

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

// ---- API ----

async function loadGames() {
    const resp = await fetch('/games');
    allGames = await resp.json();
    renderTables();
}

async function scanAll() {
    if (scanRunning) return;
    scanRunning = true;

    prevVersions = Object.fromEntries(allGames.map(g => [g.name, g.scraped_version]));
    scanUpdatedNames.clear();
    scannedNames.clear();

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

let prevVersions = {};

function finishScan(btn) {
    scanRunning = false;
    btn.disabled = false;
    btn.textContent = 'Scan All';
    setStatus('Scan complete.');
}

async function scanOne(name) {
    const prev = allGames.find(g => g.name === name)?.scraped_version;
    const resp = await fetch(`/scan/${encodeURIComponent(name)}`, { method: 'POST' });
    const game = await resp.json();
    const wasUpdated = game.scraped_version !== prev && game.scraped_version != null;
    scannedNames.add(name);
    updateGame(game, wasUpdated);
}

async function markPlayed(name) {
    const resp = await fetch(`/games/${encodeURIComponent(name)}/played`, { method: 'POST' });
    const game = await resp.json();
    scanUpdatedNames.delete(name);
    updateGame(game, false);
}

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

async function toggleActive(name) {
    const resp = await fetch(`/games/${encodeURIComponent(name)}/toggle-active`, { method: 'POST' });
    if (resp.ok) {
        const game = await resp.json();
        updateGame(game, false);
    }
}

async function deleteGame(name) {
    if (!confirm(`Delete "${name}"?`)) return;
    const resp = await fetch(`/games/${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (resp.ok) {
        allGames = allGames.filter(g => g.name !== name);
        renderTables();
    }
}

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

// ---- State ----

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

// ---- Render ----

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

function buildRow(game) {
    const tr = document.createElement('tr');
    tr.dataset.name = game.name;

    if (game.error) tr.classList.add('has-error');
    if (scanUpdatedNames.has(game.name) && game.needs_update) tr.classList.add('row-updated');
    if (game.status === 'Abandoned') tr.classList.add('status-abandoned');
    if (game.status === 'Complete')  tr.classList.add('status-complete');

    // Scan-done checkbox
    const checkTd = document.createElement('td');
    checkTd.className = 'col-check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = scannedNames.has(game.name);
    cb.tabIndex = -1;
    checkTd.appendChild(cb);
    tr.appendChild(checkTd);

    // Name
    tr.appendChild(cell(game.name));

    // Updates since last played
    tr.appendChild(cell(game.update_count > 0 ? `${game.update_count}x` : ''));

    // Latest version
    tr.appendChild(cell(game.scraped_version ?? '—'));

    // Release date — read only
    const dateStr = game.release_date ? game.release_date.substring(0, 10) : '—';
    tr.appendChild(cell(dateStr));

    // URL link
    const linkTd = document.createElement('td');
    const a = document.createElement('a');
    a.href = game.url;
    a.target = '_blank';
    a.rel = 'noreferrer';
    a.textContent = '↗';
    a.title = game.url;
    linkTd.appendChild(a);
    tr.appendChild(linkTd);

    // Active checkbox (from JSON field — toggles scan inclusion)
    const activeTd = document.createElement('td');
    activeTd.className = 'col-active';
    const activeCb = document.createElement('input');
    activeCb.type = 'checkbox';
    activeCb.checked = game.active !== false;
    activeCb.title = activeCb.checked ? 'Active — click to exclude from scans' : 'Inactive — click to include in scans';
    activeCb.onchange = () => toggleActive(game.name);
    activeTd.appendChild(activeCb);
    tr.appendChild(activeTd);

    // Actions — always three fixed-width slots; "Mark as Updated" hidden when not needed
    const actionsTd = document.createElement('td');
    actionsTd.className = 'actions';

    const checkBtn = document.createElement('button');
    checkBtn.textContent = 'Check';
    checkBtn.className = 'btn btn-action';
    checkBtn.onclick = async () => {
        checkBtn.disabled = true;
        checkBtn.textContent = '...';
        await scanOne(game.name);
    };
    actionsTd.appendChild(checkBtn);

    const markBtn = document.createElement('button');
    markBtn.textContent = 'Mark as Updated';
    markBtn.className = 'btn btn-action btn-mark-updated';
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
    deleteBtn.textContent = 'Delete';
    deleteBtn.className = 'btn btn-action btn-delete';
    deleteBtn.onclick = () => deleteGame(game.name);
    actionsTd.appendChild(deleteBtn);

    tr.appendChild(actionsTd);
    return tr;
}

function cell(text) {
    const td = document.createElement('td');
    td.textContent = text;
    return td;
}

// ---- Filters ----

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

// ---- Add Form ----

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

// ---- Status bar ----

function setStatus(msg) {
    document.getElementById('scan-status').textContent = msg;
}
