/* ─────────────────────────────────────────────
   WANTS.IO — App Logic v2
   Deposit-based savings model
   Firebase Firestore + localStorage fallback
───────────────────────────────────────────── */

// ─── Palette for allocation colors ───────────
const PALETTE = ['#38bdf8','#60a5fa','#06b6d4','#34d399','#818cf8','#f472b6','#fb923c','#4ade80','#a5f3fc','#93c5fd'];
function paletteColor(idx) { return PALETTE[idx % PALETTE.length]; }

// ─── State ───────────────────────────────────
const state = {
  wants:    [],      // [{id, name, price, allocationPercent, url, image, description, createdAt}]
  deposits: [],      // [{id, amount, savingsPercent, savedToReserve, allocations:[{wantId,wantName,allocPercent,amount}], unallocated, note, date}]
  theme:    localStorage.getItem('wio-theme') || 'dark',
  vaultId:  localStorage.getItem('wio-vault-id') || '',
  db:       null,
  unsubscribes: [],
  editingWantId: null,
};

// ─── Utils ───────────────────────────────────
const $ = (s, ctx = document) => ctx.querySelector(s);
const $$ = (s, ctx = document) => [...ctx.querySelectorAll(s)];
const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

function fmt(n) {
  if (n == null || isNaN(n)) return '$0';
  const abs = Math.abs(n);
  if (abs >= 1000) return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}
function fmtFull(n) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n || 0);
}
function fmtDate(iso) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function fmtDateShort(iso) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
function fmtMonthKey(iso) {
  const d = new Date(iso);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2,'0');
}

let toastTimer;
function toast(msg, duration = 3000) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), duration);
}

// ─── Computed helpers ─────────────────────────
function getLiquidSavings() {
  return state.deposits.reduce((s, d) => s + (d.savedToReserve || 0), 0);
}
function getTotalDeposited() {
  return state.deposits.reduce((s, d) => s + (d.amount || 0), 0);
}
function getTotalInWants() {
  return state.deposits.reduce((s, d) => {
    return s + (d.allocations || []).reduce((a, al) => a + (al.amount || 0), 0);
  }, 0);
}
function getWantSaved(wantId) {
  return state.deposits.reduce((s, d) => {
    const al = (d.allocations || []).find(a => a.wantId === wantId);
    return s + (al ? al.amount : 0);
  }, 0);
}
function getWantProgress(want) {
  if (!want.price || want.price === 0) return 0;
  return Math.min((getWantSaved(want.id) / want.price) * 100, 100);
}
function totalAllocPct() {
  return state.wants.reduce((s, w) => s + (w.allocationPercent || 0), 0);
}
function getAvailableBank() {
  return round2(getTotalDeposited() - getLiquidSavings());
}

// Split a deposit amount into parts
function calcDepositSplit(amount, savingsPct) {
  const savedToReserve = round2(amount * savingsPct / 100);
  const allocatable    = round2(amount - savedToReserve);
  const allocations    = state.wants
    .filter(w => (w.allocationPercent || 0) > 0)
    .map(w => ({
      wantId:       w.id,
      wantName:     w.name,
      allocPercent: w.allocationPercent,
      amount:       round2(allocatable * w.allocationPercent / 100),
    }));
  const totalAllocated = allocations.reduce((s, a) => s + a.amount, 0);
  const unallocated    = round2(allocatable - totalAllocated);
  return { savedToReserve, allocatable, allocations, unallocated };
}
function round2(n) { return Math.round(n * 100) / 100; }

// ETA for a want based on deposit history
function getWantETA(want) {
  const saved     = getWantSaved(want.id);
  const remaining = (want.price || 0) - saved;
  if (remaining <= 0) return { funded: true };
  if (!state.deposits.length) return { funded: false, months: null };

  const sorted = [...state.deposits].sort((a, b) => new Date(a.date) - new Date(b.date));
  const first  = new Date(sorted[0].date);
  const now    = new Date();
  const monthsElapsed = Math.max(0.25, (now - first) / (30.44 * 24 * 3600 * 1000));

  const totalToWant = sorted.reduce((s, d) => {
    const al = (d.allocations || []).find(a => a.wantId === want.id);
    return s + (al ? al.amount : 0);
  }, 0);

  // If no direct allocation yet, project from want alloc% and deposit rate
  let avgMonthly;
  if (totalToWant === 0) {
    const totalDeposited = getTotalDeposited();
    if (totalDeposited === 0 || !want.allocationPercent) return { funded: false, months: null };
    const lastSavingsPct = sorted[sorted.length - 1]?.savingsPercent || 20;
    const avgMonthlyDeposit = totalDeposited / monthsElapsed;
    avgMonthly = avgMonthlyDeposit * (1 - lastSavingsPct / 100) * (want.allocationPercent / 100);
  } else {
    avgMonthly = totalToWant / monthsElapsed;
  }

  if (avgMonthly <= 0) return { funded: false, months: null };
  return { funded: false, months: remaining / avgMonthly, avgMonthly, saved, remaining };
}

function fmtETA(eta) {
  if (!eta || eta.months == null) return null;
  const m = Math.ceil(eta.months);
  if (m <= 0) return 'This month';
  if (m === 1) return '~1 month';
  if (m < 12) return `~${m} months`;
  const y = Math.floor(m / 12);
  const rem = m % 12;
  return rem ? `~${y}y ${rem}mo` : `~${y} year${y > 1 ? 's' : ''}`;
}

// ─── Theme ───────────────────────────────────
function applyTheme(t) {
  state.theme = t;
  document.documentElement.setAttribute('data-theme', t);
  $('#icon-moon').style.display = t === 'dark'  ? 'block' : 'none';
  $('#icon-sun').style.display  = t === 'light' ? 'block' : 'none';
  localStorage.setItem('wio-theme', t);
}
$('#theme-toggle').addEventListener('click', () => applyTheme(state.theme === 'dark' ? 'light' : 'dark'));

// ─── Tab Navigation ──────────────────────────
const PANELS = { home: $('#home-panel'), bank: $('#bank-panel'), wants: $('#wants-panel'), stats: $('#stats-panel') };
let activeTab = 'home';

function switchTab(name) {
  activeTab = name;
  $$('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  Object.entries(PANELS).forEach(([k, el]) => {
    if (k === name) { el.removeAttribute('hidden'); }
    else            { el.hidden = true; }
  });
  if (name === 'home')  renderHome();
  if (name === 'bank')  renderBank();
  if (name === 'wants') renderWants();
  if (name === 'stats') renderStats();
}
$$('.tab-btn').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

// ─── LocalStorage ─────────────────────────────
function saveLocal() {
  localStorage.setItem('wio-wants',    JSON.stringify(state.wants));
  localStorage.setItem('wio-deposits', JSON.stringify(state.deposits));
}
function loadLocal() {
  try {
    state.wants    = JSON.parse(localStorage.getItem('wio-wants')    || '[]');
    state.deposits = JSON.parse(localStorage.getItem('wio-deposits') || '[]');

    // Migrate old format: savingsHistory + currentSavings → single synthetic deposit
    const oldSavings = localStorage.getItem('wio-savings');
    const oldHistory = localStorage.getItem('wio-history');
    if (oldHistory && !state.deposits.length) {
      try {
        const hist = JSON.parse(oldHistory);
        if (hist.length) {
          hist.forEach(h => {
            const sp = calcDepositSplit(h.amount || 0, 20);
            state.deposits.push({ id: uid(), amount: h.amount || 0, savingsPercent: 20, ...sp, note: 'Imported', date: h.date || new Date().toISOString() });
          });
          saveLocal();
          localStorage.removeItem('wio-savings');
          localStorage.removeItem('wio-history');
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

// ─── Firebase Integration ────────────────────
function updateSyncBadge(connected) {
  const badge = $('#sync-badge');
  badge.classList.toggle('connected', connected);
  $('#sync-label').textContent = connected ? 'Synced' : 'Local';
}

function startFirestoreListeners() {
  if (!state.db || !state.vaultId) return;
  state.unsubscribes.forEach(u => u());
  state.unsubscribes = [];

  const vaultRef = state.db.collection('vaults').doc(state.vaultId);

  const unsubWants = vaultRef.collection('wants').orderBy('createdAt', 'desc').onSnapshot(snap => {
    state.wants = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    saveLocal(); renderActive();
  });

  const unsubDeposits = vaultRef.collection('deposits').orderBy('date', 'desc').onSnapshot(snap => {
    state.deposits = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    saveLocal(); renderActive();
  });

  state.unsubscribes.push(unsubWants, unsubDeposits);
  updateSyncBadge(true);
}

async function initFirebase() {
  const stored = localStorage.getItem('wio-firebase-config');
  if (!stored) { loadLocal(); updateSyncBadge(false); return; }
  try {
    const cfg = JSON.parse(stored);
    if (!cfg.apiKey) throw new Error('bad config');
    if (!firebase.apps.length) firebase.initializeApp(cfg);
    state.db = firebase.firestore();
    startFirestoreListeners();
  } catch (e) {
    console.warn('Firebase init failed:', e);
    loadLocal(); updateSyncBadge(false);
  }
}

// ─── Storage Abstraction ─────────────────────
const storage = {
  async saveWant(want) {
    if (state.db && state.vaultId) {
      await state.db.collection('vaults').doc(state.vaultId).collection('wants').doc(want.id).set(want);
    } else {
      const idx = state.wants.findIndex(w => w.id === want.id);
      if (idx >= 0) state.wants[idx] = want; else state.wants.unshift(want);
      saveLocal(); renderActive();
    }
  },
  async deleteWant(id) {
    if (state.db && state.vaultId) {
      await state.db.collection('vaults').doc(state.vaultId).collection('wants').doc(id).delete();
    } else {
      state.wants = state.wants.filter(w => w.id !== id);
      saveLocal(); renderActive();
    }
  },
  async saveDeposit(dep) {
    if (state.db && state.vaultId) {
      await state.db.collection('vaults').doc(state.vaultId).collection('deposits').doc(dep.id).set(dep);
    } else {
      state.deposits.unshift(dep);
      saveLocal(); renderActive();
    }
  },
  async deleteDeposit(id) {
    if (state.db && state.vaultId) {
      await state.db.collection('vaults').doc(state.vaultId).collection('deposits').doc(id).delete();
    } else {
      state.deposits = state.deposits.filter(d => d.id !== id);
      saveLocal(); renderActive();
    }
  },
};

// ─── Render: Active Tab ───────────────────────
function renderActive() {
  if (activeTab === 'home')  renderHome();
  if (activeTab === 'bank')  renderBank();
  if (activeTab === 'wants') renderWants();
  if (activeTab === 'stats') renderStats();
}

// ─── Render: Home ────────────────────────────
function renderHome() {
  const totalDeposited = getTotalDeposited();
  const totalInWants   = getTotalInWants();
  const liquid         = getLiquidSavings();
  const wantsPct       = totalDeposited > 0 ? (totalInWants / totalDeposited) * 100 : 0;
  const funded         = state.wants.filter(w => getWantProgress(w) >= 100).length;

  $('#home-savings').textContent        = fmt(totalDeposited);
  $('#home-allocated-pct').textContent  = wantsPct.toFixed(0) + '% allocated to wants (' + fmt(totalInWants) + ')';
  $('#home-bar-fill').style.width       = Math.min(wantsPct, 100) + '%';
  $('#home-liquid').textContent         = fmt(liquid);
  $('#home-want-count').textContent     = state.wants.length;
  $('#home-funded-count').textContent   = funded;

  const list = $('#home-wants-list');
  if (!state.wants.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26"/></svg></div><div class="empty-title">Nothing here yet</div><div class="empty-sub">Head to Wants to add your first item</div></div>`;
    return;
  }
  list.innerHTML = state.wants.map(w => {
    const pct   = getWantProgress(w).toFixed(0);
    const thumb = w.image
      ? `<img class="home-want-thumb" src="${escAttr(w.image)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><div class="home-want-thumb-placeholder" style="display:none"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg></div>`
      : `<div class="home-want-thumb-placeholder"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg></div>`;
    return `<div class="home-want-row glass-card">${thumb}<div class="home-want-info"><div class="home-want-name">${esc(w.name)}</div><div class="home-want-bar-track"><div class="home-want-bar-fill" style="width:${pct}%"></div></div></div><div class="home-want-pct">${pct}%</div></div>`;
  }).join('');
}

// ─── Render: Bank ────────────────────────────
function renderBank() {
  setDepositDateDefault();
  const liquid    = getLiquidSavings();
  const inWants   = getTotalInWants();
  const totalIn   = getTotalDeposited();
  const available = getAvailableBank();
  const unalloc   = Math.max(0, 100 - totalAllocPct());

  $('#bank-liquid').textContent    = fmt(liquid);
  $('#bank-in-wants').textContent  = fmt(inWants);
  $('#bank-total-in').textContent  = fmt(totalIn);
  $('#bank-available').textContent = fmt(available);
  $('#bank-unallocated').textContent = unalloc.toFixed(0) + '% unallocated';

  // Allocation setup list
  const allocEl = $('#allocation-list');
  if (!state.wants.length) {
    allocEl.innerHTML = `<div class="empty-state"><div class="empty-icon"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg></div><div class="empty-title">No wants yet</div><div class="empty-sub">Add wants and set their allocation %</div></div>`;
  } else {
    const hasAlloc = state.wants.some(w => (w.allocationPercent || 0) > 0);
    if (!hasAlloc) {
      allocEl.innerHTML = `<div class="empty-state"><div class="empty-icon"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg></div><div class="empty-title">No allocations set</div><div class="empty-sub">Edit your wants to add percentages</div></div>`;
    } else {
      allocEl.innerHTML = state.wants.filter(w => (w.allocationPercent || 0) > 0).map((w, i) => `
        <div class="alloc-row glass-card">
          <div class="alloc-color-dot" style="background:${paletteColor(i)}"></div>
          <div class="alloc-name">${esc(w.name)}</div>
          <div class="alloc-pct">${w.allocationPercent}%</div>
          <div class="alloc-amount">${fmt(getWantSaved(w.id))}</div>
        </div>`).join('');
    }
  }

  // Deposit history
  renderDepositHistory();
}

function renderDepositHistory() {
  const el = $('#deposit-history-list');
  if (!state.deposits.length) {
    el.innerHTML = `<div class="empty-state"><div class="empty-icon"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="8,12 12,16 16,12"/><line x1="12" y1="8" x2="12" y2="16"/></svg></div><div class="empty-title">No deposits yet</div><div class="empty-sub">Add your first deposit above</div></div>`;
    return;
  }

  const sorted = [...state.deposits].sort((a, b) => new Date(b.date) - new Date(a.date));
  el.innerHTML = sorted.map(dep => {
    const allRows = [
      { label: 'Kept in Savings', pct: dep.savingsPercent, amount: dep.savedToReserve, color: '#38bdf8' },
      ...(dep.allocations || []).map((al, i) => ({ label: esc(al.wantName), pct: al.allocPercent, amount: al.amount, color: paletteColor(i + 1) })),
      ...(dep.unallocated > 0 ? [{ label: 'Unallocated', pct: null, amount: dep.unallocated, color: 'var(--text3)' }] : []),
    ];

    const detailRows = allRows.map(r => `
      <div class="deposit-detail-row">
        <div class="deposit-detail-dot" style="background:${r.color}"></div>
        <div class="deposit-detail-label">${r.label}</div>
        ${r.pct != null ? `<div class="deposit-detail-pct">${r.pct}%</div>` : ''}
        <div class="deposit-detail-amount">${fmt(r.amount)}</div>
      </div>`).join('');

    const noteHtml = dep.note ? `<div class="deposit-history-note">${esc(dep.note)}</div>` : '';
    return `
      <div class="deposit-history-item glass-card" data-dep-id="${dep.id}">
        <div class="deposit-history-header" onclick="toggleDepositRow(this.parentElement)">
          <div class="deposit-history-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg></div>
          <div class="deposit-history-info">
            <div class="deposit-history-amount">${fmt(dep.amount)}</div>
            <div class="deposit-history-meta">${fmtDate(dep.date)} · ${dep.savingsPercent}% to savings</div>
            ${noteHtml}
          </div>
          <svg class="deposit-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="9,18 15,12 9,6"/></svg>
        </div>
        <div class="deposit-history-detail">
          ${detailRows}
          <div class="deposit-detail-row" style="justify-content:flex-end">
            <button class="want-card-btn danger" style="width:auto;padding:6px 14px;border-radius:8px;font-size:12px" onclick="confirmDeleteDeposit('${dep.id}')">Remove deposit</button>
          </div>
        </div>
      </div>`;
  }).join('');
}

window.toggleDepositRow = function(el) {
  el.classList.toggle('open');
};
window.confirmDeleteDeposit = function(id) {
  if (!confirm('Remove this deposit? This will reduce your saved amounts.')) return;
  storage.deleteDeposit(id).then(() => toast('Deposit removed'));
};

// ─── Render: Wants ───────────────────────────
function renderWants() {
  const grid = $('#wants-grid');
  if (!state.wants.length) {
    grid.innerHTML = `<div class="empty-state"><div class="empty-icon"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg></div><div class="empty-title">Your list is empty</div><div class="empty-sub">Drop a link or add manually</div></div>`;
    return;
  }
  grid.innerHTML = state.wants.map(w => buildWantCard(w)).join('');
  grid.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      if (btn.dataset.action === 'delete') confirmDeleteWant(btn.dataset.id);
      if (btn.dataset.action === 'edit')   openEditWant(btn.dataset.id);
    });
  });
}

function buildWantCard(w) {
  const pct    = getWantProgress(w);
  const saved  = getWantSaved(w.id);
  const funded = pct >= 100;
  const imgEl  = w.image
    ? `<img class="want-card-img" src="${escAttr(w.image)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><div class="want-card-img-placeholder" style="display:none"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg></div>`
    : `<div class="want-card-img-placeholder"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg></div>`;

  return `
    <div class="want-card glass-card">
      ${imgEl}
      <div class="want-card-body">
        <div class="want-card-name">${esc(w.name)} ${funded ? '<span class="funded-badge">✓ Funded</span>' : ''}</div>
        <div class="want-card-price">${fmt(w.price)}</div>
        <div class="want-card-bar-track"><div class="want-card-bar-fill" style="width:${pct.toFixed(1)}%"></div></div>
        <div class="want-card-meta">
          <div class="want-card-pct">${w.allocationPercent || 0}% alloc</div>
          <div class="want-card-saved">${fmt(saved)} saved</div>
        </div>
        <div class="want-card-actions">
          ${w.url ? `<a class="want-card-btn" href="${escAttr(w.url)}" target="_blank" rel="noopener">Buy</a>` : ''}
          <button class="want-card-btn" data-action="edit" data-id="${w.id}">Edit</button>
          <button class="want-card-btn danger" data-action="delete" data-id="${w.id}">✕</button>
        </div>
      </div>
    </div>`;
}

// ─── Render: Statistics ───────────────────────
function renderStats() {
  const totalDeposited = getTotalDeposited();
  const liquid   = getLiquidSavings();
  const inWants  = getTotalInWants();

  // Average monthly
  let avgMonthly = 0;
  if (state.deposits.length > 0) {
    const sorted = [...state.deposits].sort((a, b) => new Date(a.date) - new Date(b.date));
    const first  = new Date(sorted[0].date);
    const now    = new Date();
    const months = Math.max(0.25, (now - first) / (30.44 * 24 * 3600 * 1000));
    avgMonthly = totalDeposited / months;
  }

  $('#stats-total-deposited').textContent = fmt(totalDeposited);
  $('#stats-avg-monthly').textContent     = fmt(avgMonthly);
  $('#stats-liquid').textContent          = fmt(liquid);
  $('#stats-in-wants').textContent        = fmt(inWants);

  renderDonut(totalDeposited, liquid, inWants);
  renderVelocityChart();
  renderProjections();
}

function renderDonut(total, liquid, inWants) {
  if (total === 0) {
    $('#money-donut').style.background = `conic-gradient(var(--glass-strong) 0deg 360deg)`;
    $('#donut-center-val').textContent = '–';
    $('#donut-legend').innerHTML = `<div style="font-size:12px;color:var(--text3)">No deposits yet</div>`;
    return;
  }

  const segments = [];
  const wantColors = [];

  // Liquid savings segment
  if (liquid > 0) segments.push({ label: 'Savings', amount: liquid, color: '#a855f7' });

  // Per-want segments
  state.wants.forEach((w, i) => {
    const amt = getWantSaved(w.id);
    if (amt > 0) {
      const color = paletteColor(i + 1);
      wantColors.push(color);
      segments.push({ label: w.name, amount: amt, color });
    }
  });

  // Unallocated
  const accountedFor = segments.reduce((s, sg) => s + sg.amount, 0);
  const unalloc = round2(total - accountedFor);
  if (unalloc > 0.01) segments.push({ label: 'Unallocated', amount: unalloc, color: 'rgba(128,128,128,0.3)' });

  // Build conic gradient
  let currentDeg = 0;
  const stops = segments.map(sg => {
    const pct   = sg.amount / total;
    const start = currentDeg;
    currentDeg += pct * 360;
    return `${sg.color} ${start.toFixed(2)}deg ${currentDeg.toFixed(2)}deg`;
  });
  $('#money-donut').style.background = `conic-gradient(${stops.join(', ')})`;
  $('#donut-center-val').textContent = fmt(total);

  // Legend
  $('#donut-legend').innerHTML = segments.map(sg => `
    <div class="legend-row">
      <div class="legend-dot" style="background:${sg.color}"></div>
      <div class="legend-label">${esc(sg.label)}</div>
      <div class="legend-pct">${((sg.amount / total) * 100).toFixed(0)}%</div>
    </div>`).join('');
}

function renderVelocityChart() {
  const el = $('#velocity-chart');
  if (!state.deposits.length) {
    el.innerHTML = `<div class="velocity-empty">No deposits yet</div>`;
    return;
  }

  // Group by month, take last 6 months
  const byMonth = {};
  state.deposits.forEach(d => {
    const key = fmtMonthKey(d.date);
    byMonth[key] = (byMonth[key] || 0) + (d.amount || 0);
  });

  const keys   = Object.keys(byMonth).sort().slice(-6);
  const values = keys.map(k => byMonth[k]);
  const max    = Math.max(...values, 1);
  const total  = values.reduce((s, v) => s + v, 0);
  const avg    = total / keys.length;

  const bars = keys.map((k, i) => {
    const pct   = (values[i] / max) * 100;
    const label = new Date(k + '-02').toLocaleDateString('en-US', { month: 'short' });
    return `
      <div class="velocity-bar-wrap">
        <div class="velocity-bar-outer">
          <div class="velocity-bar-inner" style="height:${pct.toFixed(0)}%"></div>
        </div>
        <div class="velocity-bar-label">${label}</div>
      </div>`;
  }).join('');

  const depositCount = state.deposits.length;
  $('#stats-deposit-count').textContent = depositCount + ' deposit' + (depositCount !== 1 ? 's' : '');

  el.innerHTML = `
    <div class="velocity-bars">${bars}</div>
    <div class="velocity-summary">
      <span class="velocity-stat"><strong>${fmt(avg)}</strong> avg/mo</span>
      <span class="velocity-stat"><strong>${fmt(total)}</strong> shown period</span>
      <span class="velocity-stat"><strong>${depositCount}</strong> total deposits</span>
    </div>`;
}

function renderProjections() {
  const el = $('#projections-list');
  if (!state.wants.length) {
    el.innerHTML = `<div class="empty-state"><div class="empty-icon"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="22,7 13.5,15.5 8.5,10.5 2,17"/><polyline points="16,7 22,7 22,13"/></svg></div><div class="empty-title">No wants yet</div><div class="empty-sub">Add wants to see projections</div></div>`;
    return;
  }

  el.innerHTML = state.wants.map(w => {
    const pct   = getWantProgress(w);
    const saved = getWantSaved(w.id);
    const eta   = getWantETA(w);
    const etaStr = fmtETA(eta);

    let etaHtml;
    if (eta.funded) {
      etaHtml = `<span class="projection-eta funded">✓ Funded</span>`;
    } else if (etaStr) {
      etaHtml = `<span class="projection-eta active">${etaStr}</span>`;
    } else {
      etaHtml = `<span class="projection-eta no-data">No data</span>`;
    }

    const avgMonthlyStr = eta.avgMonthly ? fmt(eta.avgMonthly) + '/mo' : '–';
    const remainingStr  = !eta.funded && eta.remaining != null ? fmt(eta.remaining) + ' to go' : '';

    return `
      <div class="projection-card glass-card">
        <div class="projection-header">
          <div>
            <div class="projection-name">${esc(w.name)}</div>
            <div class="projection-price">${fmtFull(w.price)}</div>
          </div>
          ${etaHtml}
        </div>
        <div class="projection-bar-track">
          <div class="projection-bar-fill" style="width:${pct.toFixed(1)}%"></div>
        </div>
        <div class="projection-stats">
          <div class="projection-stat"><strong>${fmt(saved)}</strong>Saved so far</div>
          ${remainingStr ? `<div class="projection-stat"><strong>${remainingStr}</strong>Remaining</div>` : ''}
          <div class="projection-stat"><strong>${avgMonthlyStr}</strong>Avg/month</div>
          <div class="projection-stat"><strong>${(w.allocationPercent || 0)}%</strong>Allocation</div>
        </div>
      </div>`;
  }).join('');
}

// ─── Bank: Deposit Form ───────────────────────
function updateDepositPreview() {
  const amount = parseFloat($('#deposit-amount').value) || 0;
  const savPct = parseFloat($('#deposit-savings-pct').value) || 0;
  const preview = $('#deposit-preview');
  const rows    = $('#deposit-preview-rows');

  if (amount <= 0) { preview.hidden = true; return; }
  preview.removeAttribute('hidden');

  const { savedToReserve, allocations, unallocated } = calcDepositSplit(amount, savPct);

  const parts = [
    { label: 'Kept in Savings', pct: savPct, amount: savedToReserve, color: '#38bdf8' },
    ...allocations.map((al, i) => ({ label: al.wantName, pct: al.allocPercent, amount: al.amount, color: paletteColor(i + 1) })),
    ...(unallocated > 0.005 ? [{ label: 'Unallocated (Available)', pct: null, amount: unallocated, color: null }] : []),
  ];

  rows.innerHTML = parts.map(p => `
    <div class="preview-row${p.color ? '' : ' unallocated'}">
      <div class="preview-dot" style="background:${p.color || 'var(--text3)'}"></div>
      <div class="preview-label">${esc(p.label)}</div>
      ${p.pct != null ? `<div class="preview-pct">${p.pct}%</div>` : ''}
      <div class="preview-amount">${fmt(p.amount)}</div>
    </div>`).join('');
}

function setDepositDateDefault() {
  const el = $('#deposit-date');
  if (el && !el.value) el.value = new Date().toISOString().slice(0, 10);
}

$('#deposit-amount').addEventListener('input', updateDepositPreview);
$('#deposit-savings-pct').addEventListener('input', updateDepositPreview);

$('#add-deposit-btn').addEventListener('click', async () => {
  const amount    = parseFloat($('#deposit-amount').value);
  const savPct    = parseFloat($('#deposit-savings-pct').value);
  const note      = $('#deposit-note').value.trim();
  const dateInput = $('#deposit-date').value;

  if (isNaN(amount) || amount <= 0) { toast('Enter a valid deposit amount'); return; }
  if (isNaN(savPct) || savPct < 0 || savPct > 100) { toast('Savings % must be 0–100'); return; }
  if (!dateInput) { toast('Pick a date for this deposit'); return; }

  const date = new Date(dateInput + 'T12:00:00').toISOString();

  const { savedToReserve, allocations, unallocated } = calcDepositSplit(amount, savPct);
  const deposit = {
    id: uid(), amount, savingsPercent: savPct,
    savedToReserve, allocations, unallocated,
    note: note || '', date,
  };

  await storage.saveDeposit(deposit);
  $('#deposit-amount').value = '';
  $('#deposit-note').value   = '';
  $('#deposit-preview').hidden = true;
  setDepositDateDefault();
  toast('Deposit added ✓');
  renderBank();
});

// ─── Add/Edit Want Modal ──────────────────────
function openAddWant() {
  state.editingWantId = null;
  resetModal();
  $('#modal-title-text').textContent = 'Add a Want';
  $('#save-want-btn').textContent    = 'Save Want';
  showModal('#want-modal');
}
function openEditWant(id) {
  const want = state.wants.find(w => w.id === id);
  if (!want) return;
  state.editingWantId = id;
  resetModal();
  $('#modal-title-text').textContent = 'Edit Want';
  $('#save-want-btn').textContent    = 'Update Want';
  $('#want-url').value   = want.url || '';
  $('#want-name').value  = want.name || '';
  $('#want-price').value = want.price || '';
  $('#want-alloc').value = want.allocationPercent || '';
  $('#want-desc').value  = want.description || '';
  $('#want-img-url').value = want.image || '';
  if (want.image) {
    $('#want-img-preview').src = want.image;
    $('#img-preview-wrap').removeAttribute('hidden');
  }
  showModal('#want-modal');
}
function resetModal() {
  $('#want-url').value = ''; $('#want-name').value = '';
  $('#want-price').value = ''; $('#want-alloc').value = '';
  $('#want-desc').value = ''; $('#want-img-url').value = '';
  $('#img-preview-wrap').hidden = true; $('#want-img-preview').src = '';
  resetFetchBtn();
}
function resetFetchBtn() {
  $('#fetch-url-btn').disabled = false;
  $('#fetch-label').hidden = false; $('#fetch-spinner').hidden = true;
}

$('#open-add-want').addEventListener('click', openAddWant);
$('#close-modal').addEventListener('click', () => hideModal('#want-modal'));
$('#cancel-want-btn').addEventListener('click', () => hideModal('#want-modal'));

$('#fetch-url-btn').addEventListener('click', async () => {
  const url = $('#want-url').value.trim();
  if (!url) { toast('Paste a product URL first'); return; }
  $('#fetch-url-btn').disabled = true;
  $('#fetch-label').hidden = true; $('#fetch-spinner').hidden = false;
  try {
    const data = await fetchProductData(url);
    const filled = [];
    if (data?.title)       { $('#want-name').value  = data.title;       filled.push('name'); }
    if (data?.description) { $('#want-desc').value  = data.description; filled.push('description'); }
    if (data?.image)       { setPreviewImage(data.image);               filled.push('image'); }
    if (data?.price)       { $('#want-price').value = data.price;       filled.push('price'); }
    if (filled.length)  toast(`Filled: ${filled.join(', ')} ✓`);
    else toast('This retailer blocks auto-fill — enter details manually');
  } catch { toast('Could not auto-fill — fill in manually'); }
  finally { resetFetchBtn(); }
});

const BAD_TITLES = ['page not found','404','access denied','just a moment','are you a human','robot','captcha','blocked','unavailable'];
function isUsableTitle(t) {
  if (!t) return false;
  const lower = t.toLowerCase();
  return !BAD_TITLES.some(bad => lower.includes(bad));
}

async function fetchProductData(rawUrl) {
  // ── 1. Microlink ──────────────────────────────
  try {
    const res  = await fetch(`https://api.microlink.io/?url=${encodeURIComponent(rawUrl)}`);
    const json = await res.json();
    if (json.status === 'success') {
      const d = json.data;
      const title = isUsableTitle(d.title) ? d.title : null;
      let price = null;
      const priceRaw = d.price?.amount ?? d.price?.value ?? d.price?.text ?? null;
      if (priceRaw != null) price = parseFloat(String(priceRaw).replace(/[^0-9.]/g, '')) || null;
      const result = { title, description: d.description || null, image: d.image?.url || null, price };
      if (result.title || result.image) return result;
    }
  } catch { /* fall through */ }

  // ── 2. corsproxy.io (raw HTML) ────────────────
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    const res  = await fetch(`https://corsproxy.io/?${encodeURIComponent(rawUrl)}`, { signal: ctrl.signal });
    clearTimeout(t);
    const html = await res.text();
    const result = parseProductFromHTML(html);
    if (result.title || result.image) return result;
  } catch { /* fall through */ }

  // ── 3. allorigins.win (JSON wrapper) ──────────
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    const res  = await fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(rawUrl)}`, { signal: ctrl.signal });
    clearTimeout(t);
    const json = await res.json();
    const result = parseProductFromHTML(json.contents || '');
    if (result.title || result.image) return result;
  } catch { /* fall through */ }

  return null;
}

function parseProductFromHTML(html) {
  const doc  = new DOMParser().parseFromString(html, 'text/html');
  const meta = (...props) => {
    for (const p of props) {
      const v = doc.querySelector(`meta[property="${p}"]`)?.content
             || doc.querySelector(`meta[name="${p}"]`)?.content;
      if (v) return v;
    }
    return null;
  };

  const title       = meta('og:title','twitter:title') || doc.title || null;
  const description = meta('og:description','description','twitter:description') || null;
  const image       = meta('og:image','twitter:image:src','twitter:image') || null;

  // Price: structured meta → element scrape → body text scan
  let price = null;
  const priceMeta = meta('product:price:amount','og:price:amount','twitter:data1','price');
  if (priceMeta) price = parseFloat(priceMeta.replace(/[^0-9.]/g, '')) || null;

  if (!price) {
    const el = doc.querySelector('[itemprop="price"],[class*="price"],[id*="price"],[data-price],.a-price,.a-offscreen');
    if (el) {
      const txt = el.getAttribute('content') || el.textContent;
      const m = txt.match(/\$\s*[\d,]+(?:\.\d{2})?/);
      if (m) price = parseFloat(m[0].replace(/[$,\s]/g, '')) || null;
    }
  }
  if (!price) {
    const m = (doc.body?.textContent || '').match(/\$\s*[\d,]+\.\d{2}/);
    if (m) price = parseFloat(m[0].replace(/[$,\s]/g, '')) || null;
  }

  return { title, description, image, price };
}

$('#want-img-url').addEventListener('change', () => {
  const url = $('#want-img-url').value.trim();
  if (url) setPreviewImage(url);
});
function setPreviewImage(url) {
  $('#want-img-url').value = url;
  $('#want-img-preview').src = url;
  $('#img-preview-wrap').removeAttribute('hidden');
}
$('#img-clear-btn').addEventListener('click', () => {
  $('#want-img-preview').src = ''; $('#want-img-url').value = '';
  $('#img-preview-wrap').hidden = true;
});

$('#save-want-btn').addEventListener('click', async () => {
  const name  = $('#want-name').value.trim();
  const price = parseFloat($('#want-price').value);
  const alloc = parseFloat($('#want-alloc').value) || 0;
  const url   = $('#want-url').value.trim();
  const imgSrc = $('#want-img-preview').src;
  const img   = $('#want-img-url').value.trim() || (imgSrc && imgSrc !== window.location.href ? imgSrc : '');
  const desc  = $('#want-desc').value.trim();

  if (!name) { toast('Name is required'); return; }
  if (isNaN(price) || price <= 0) { toast('Enter a valid price'); return; }
  if (alloc < 0 || alloc > 100) { toast('Allocation must be 0–100%'); return; }

  const otherAlloc = state.wants.filter(w => w.id !== state.editingWantId).reduce((s, w) => s + (w.allocationPercent || 0), 0);
  if (otherAlloc + alloc > 100) { toast(`Total allocation would exceed 100% (${otherAlloc}% already used)`); return; }

  const want = {
    id: state.editingWantId || uid(),
    name, price, allocationPercent: alloc,
    url: url || '', image: img || '', description: desc || '',
    createdAt: state.editingWantId
      ? (state.wants.find(w => w.id === state.editingWantId)?.createdAt || new Date().toISOString())
      : new Date().toISOString(),
  };

  await storage.saveWant(want);
  hideModal('#want-modal');
  toast(state.editingWantId ? 'Want updated ✓' : 'Want added ✓');
  switchTab('wants');
});

function confirmDeleteWant(id) {
  const want = state.wants.find(w => w.id === id);
  if (!want || !confirm(`Remove "${want.name}"?`)) return;
  storage.deleteWant(id).then(() => toast('Removed'));
}

// ─── Vault Modal ─────────────────────────────
$('#vault-btn').addEventListener('click', () => {
  $('#vault-id-input').value = state.vaultId;
  const stored = localStorage.getItem('wio-firebase-config');
  $('#firebase-config-input').value = stored ? JSON.stringify(JSON.parse(stored), null, 2) : '';
  showModal('#vault-modal');
});
$('#sync-badge').addEventListener('click', () => $('#vault-btn').click());
$('#close-vault-modal').addEventListener('click', () => hideModal('#vault-modal'));
$('#close-vault-cancel').addEventListener('click', () => hideModal('#vault-modal'));
$('#gen-vault-id').addEventListener('click', () => {
  const words = ['sky','wave','neon','frost','solar','drift','prism','lune','ember','zest'];
  const pick  = () => words[Math.floor(Math.random() * words.length)];
  $('#vault-id-input').value = pick() + '-' + pick() + '-' + Math.floor(1000 + Math.random() * 9000);
});
$('#save-vault-btn').addEventListener('click', async () => {
  const vaultId   = $('#vault-id-input').value.trim();
  const configRaw = $('#firebase-config-input').value.trim();
  if (!vaultId) { toast('Enter a vault ID'); return; }
  state.vaultId = vaultId;
  localStorage.setItem('wio-vault-id', vaultId);
  if (configRaw) {
    try {
      const cfg = JSON.parse(configRaw);
      if (!cfg.apiKey) throw new Error('Missing apiKey');
      localStorage.setItem('wio-firebase-config', JSON.stringify(cfg));
      hideModal('#vault-modal');
      toast('Connecting to Firebase…');
      await initFirebase();
    } catch { toast('Invalid Firebase config JSON'); return; }
  } else {
    localStorage.removeItem('wio-firebase-config');
    updateSyncBadge(false);
    hideModal('#vault-modal');
    toast('Vault ID saved (local mode)');
  }
});

// ─── Modal helpers ────────────────────────────
function showModal(sel) { $(sel).removeAttribute('hidden'); document.body.style.overflow = 'hidden'; }
function hideModal(sel) { $(sel).hidden = true; document.body.style.overflow = ''; }
$$('.modal-overlay').forEach(o => {
  o.addEventListener('click', e => { if (e.target === o) { o.hidden = true; document.body.style.overflow = ''; } });
});

// ─── Escape helpers ───────────────────────────
function esc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function escAttr(str) { return esc(str); }

// ─── SVG gradient defs ────────────────────────
function injectSvgDefs() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.classList.add('svg-defs');
  svg.setAttribute('aria-hidden','true');
  svg.innerHTML = `<defs><linearGradient id="grad-stroke" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stop-color="#38bdf8"/><stop offset="50%" stop-color="#60a5fa"/><stop offset="100%" stop-color="#06b6d4"/></linearGradient></defs>`;
  document.body.prepend(svg);
}

// ─── Init ────────────────────────────────────
async function init() {
  injectSvgDefs();
  applyTheme(state.theme);
  await initFirebase();
  switchTab('home');
}
init();
