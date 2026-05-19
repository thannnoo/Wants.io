/* ─────────────────────────────────────────────
   WANTS.IO — App Logic
   Firebase (Firestore) + localStorage fallback
───────────────────────────────────────────── */

// ─── State ───────────────────────────────────
const state = {
  wants: [],
  currentSavings: 0,
  savingsHistory: [],
  theme: localStorage.getItem('wio-theme') || 'dark',
  vaultId: localStorage.getItem('wio-vault-id') || '',
  firebaseConfig: null,
  db: null,
  unsubscribes: [],
  editingWantId: null,
};

// ─── Utilities ───────────────────────────────
const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];
const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

function fmt(n) {
  if (n == null || isNaN(n)) return '$0.00';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}
function fmtDate(iso) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

let toastTimer;
function toast(msg, duration = 3000) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), duration);
}

// ─── Theme ───────────────────────────────────
function applyTheme(t) {
  state.theme = t;
  document.documentElement.setAttribute('data-theme', t);
  $('#icon-moon').style.display = t === 'dark' ? 'block' : 'none';
  $('#icon-sun').style.display  = t === 'light' ? 'block' : 'none';
  localStorage.setItem('wio-theme', t);
}

$('#theme-toggle').addEventListener('click', () => {
  applyTheme(state.theme === 'dark' ? 'light' : 'dark');
});

// ─── Tab Navigation ──────────────────────────
const panels = { home: $('#home-panel'), bank: $('#bank-panel'), wants: $('#wants-panel') };

function switchTab(name) {
  $$('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  Object.entries(panels).forEach(([k, el]) => {
    el.hidden = k !== name;
    if (!el.hidden) el.removeAttribute('hidden');
  });
  if (name === 'home') renderHome();
  if (name === 'bank') renderBank();
  if (name === 'wants') renderWants();
}

$$('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

// ─── LocalStorage Persistence ────────────────
function saveLocal() {
  localStorage.setItem('wio-wants', JSON.stringify(state.wants));
  localStorage.setItem('wio-savings', JSON.stringify(state.currentSavings));
  localStorage.setItem('wio-history', JSON.stringify(state.savingsHistory));
}

function loadLocal() {
  try {
    state.wants          = JSON.parse(localStorage.getItem('wio-wants') || '[]');
    state.currentSavings = JSON.parse(localStorage.getItem('wio-savings') || '0');
    state.savingsHistory = JSON.parse(localStorage.getItem('wio-history') || '[]');
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

  // Clear old listeners
  state.unsubscribes.forEach(u => u());
  state.unsubscribes = [];

  const vaultRef = state.db.collection('vaults').doc(state.vaultId);

  // Wants listener
  const unsubWants = vaultRef.collection('wants')
    .orderBy('createdAt', 'desc')
    .onSnapshot(snap => {
      state.wants = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      saveLocal();
      renderActive();
    }, err => console.error('Wants listener error:', err));

  // Bank listener
  const unsubBank = vaultRef.collection('settings').doc('bank')
    .onSnapshot(snap => {
      if (snap.exists) {
        const data = snap.data();
        state.currentSavings = data.currentSavings || 0;
        state.savingsHistory  = data.history || [];
      } else {
        state.currentSavings = 0;
        state.savingsHistory = [];
      }
      saveLocal();
      renderActive();
    }, err => console.error('Bank listener error:', err));

  state.unsubscribes.push(unsubWants, unsubBank);
  updateSyncBadge(true);
}

async function initFirebase() {
  const stored = localStorage.getItem('wio-firebase-config');
  if (!stored) { loadLocal(); updateSyncBadge(false); return; }

  try {
    const cfg = JSON.parse(stored);
    if (!cfg.apiKey) throw new Error('Invalid config');

    // Only init once
    if (!firebase.apps.length) {
      firebase.initializeApp(cfg);
    } else {
      firebase.app(); // re-use
    }
    state.db = firebase.firestore();
    state.firebaseConfig = cfg;
    startFirestoreListeners();
  } catch (e) {
    console.warn('Firebase init failed:', e);
    loadLocal();
    updateSyncBadge(false);
  }
}

// ─── Storage Abstraction ─────────────────────
const storage = {
  async saveWant(want) {
    if (state.db && state.vaultId) {
      await state.db.collection('vaults').doc(state.vaultId)
        .collection('wants').doc(want.id).set(want);
    } else {
      const idx = state.wants.findIndex(w => w.id === want.id);
      if (idx >= 0) state.wants[idx] = want;
      else state.wants.unshift(want);
      saveLocal();
      renderActive();
    }
  },
  async deleteWant(id) {
    if (state.db && state.vaultId) {
      await state.db.collection('vaults').doc(state.vaultId)
        .collection('wants').doc(id).delete();
    } else {
      state.wants = state.wants.filter(w => w.id !== id);
      saveLocal();
      renderActive();
    }
  },
  async updateBank(savings, history) {
    const payload = { currentSavings: savings, history, updatedAt: new Date().toISOString() };
    if (state.db && state.vaultId) {
      await state.db.collection('vaults').doc(state.vaultId)
        .collection('settings').doc('bank').set(payload);
    } else {
      state.currentSavings = savings;
      state.savingsHistory = history;
      saveLocal();
      renderActive();
    }
  },
};

// ─── Calculations ────────────────────────────
function getAllocated(want) {
  return (state.currentSavings * (want.allocationPercent || 0)) / 100;
}
function getProgress(want) {
  if (!want.price || want.price === 0) return 0;
  return Math.min((getAllocated(want) / want.price) * 100, 100);
}
function totalAllocPct() {
  return state.wants.reduce((sum, w) => sum + (w.allocationPercent || 0), 0);
}

// ─── URL Metadata Fetch ───────────────────────
async function fetchMeta(url) {
  const endpoint = `https://api.microlink.io/?url=${encodeURIComponent(url)}&screenshot=false&palette=false`;
  const res = await fetch(endpoint);
  if (!res.ok) throw new Error('Fetch failed');
  const json = await res.json();
  if (json.status !== 'success') throw new Error(json.message || 'Microlink error');
  return json.data;
}

// ─── Render: Home ────────────────────────────
function renderHome() {
  const totalCost = state.wants.reduce((s, w) => s + (parseFloat(w.price) || 0), 0);
  const funded    = state.wants.filter(w => getProgress(w) >= 100).length;
  const allocPct  = totalAllocPct();
  const allocAmt  = (state.currentSavings * allocPct) / 100;

  $('#home-savings').textContent = fmt(state.currentSavings);
  $('#home-allocated-pct').textContent = allocPct + '% allocated (' + fmt(allocAmt) + ')';
  $('#home-bar-fill').style.width = Math.min(allocPct, 100) + '%';
  $('#home-want-count').textContent = state.wants.length;
  $('#home-total-cost').textContent = fmt(totalCost);
  $('#home-funded-count').textContent = funded;

  const list = $('#home-wants-list');
  if (!state.wants.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">✨</div><div class="empty-title">Nothing here yet</div><div class="empty-sub">Head to Wants to add your first item</div></div>`;
    return;
  }
  list.innerHTML = state.wants.map(w => {
    const pct = getProgress(w).toFixed(0);
    const thumb = w.image
      ? `<img class="home-want-thumb" src="${escAttr(w.image)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
        + `<div class="home-want-thumb-placeholder" style="display:none">🛍️</div>`
      : `<div class="home-want-thumb-placeholder">🛍️</div>`;
    return `
      <div class="home-want-row glass-card">
        ${thumb}
        <div class="home-want-info">
          <div class="home-want-name">${esc(w.name)}</div>
          <div class="home-want-bar-track"><div class="home-want-bar-fill" style="width:${pct}%"></div></div>
        </div>
        <div class="home-want-pct">${pct}%</div>
      </div>`;
  }).join('');
}

// ─── Render: Bank ────────────────────────────
function renderBank() {
  $('#bank-savings-display').textContent = fmt(state.currentSavings);

  const lastEntry = state.savingsHistory[state.savingsHistory.length - 1];
  $('#bank-last-updated').textContent = lastEntry
    ? 'Last updated ' + fmtDate(lastEntry.date)
    : 'Never updated';

  // Pre-fill input
  if (state.currentSavings > 0) {
    $('#savings-input').value = state.currentSavings;
  }

  // Allocation list
  const allocList = $('#allocation-list');
  const unallocated = Math.max(0, 100 - totalAllocPct());
  $('#bank-unallocated').textContent = unallocated.toFixed(0) + '% unallocated';

  if (!state.wants.length) {
    allocList.innerHTML = `<div class="empty-state"><div class="empty-icon">📊</div><div class="empty-title">No allocations yet</div><div class="empty-sub">Add wants and set allocation percentages</div></div>`;
  } else {
    allocList.innerHTML = state.wants
      .filter(w => (w.allocationPercent || 0) > 0)
      .map(w => `
        <div class="alloc-row glass-card">
          <div class="alloc-name">${esc(w.name)}</div>
          <div class="alloc-pct">${w.allocationPercent}%</div>
          <div class="alloc-amount">${fmt(getAllocated(w))}</div>
        </div>`)
      .join('') || `<div class="empty-state"><div class="empty-icon">📊</div><div class="empty-title">No allocations set</div><div class="empty-sub">Edit your wants to add percentages</div></div>`;
  }

  // History
  const histEl = $('#savings-history');
  if (!state.savingsHistory.length) {
    histEl.innerHTML = '';
    return;
  }
  histEl.innerHTML = [...state.savingsHistory].reverse().slice(0, 10).map(h => `
    <div class="history-row glass-card">
      <div class="history-date">${fmtDate(h.date)}</div>
      <div class="history-amount">${fmt(h.amount)}</div>
    </div>`).join('');
}

// ─── Render: Wants ───────────────────────────
function renderWants() {
  const grid = $('#wants-grid');
  if (!state.wants.length) {
    grid.innerHTML = `<div class="empty-state"><div class="empty-icon">🛍️</div><div class="empty-title">Your list is empty</div><div class="empty-sub">Drop a link or add manually</div></div>`;
    return;
  }
  grid.innerHTML = state.wants.map(want => buildWantCard(want)).join('');

  // Bind card action buttons
  grid.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const action = btn.dataset.action;
      const id = btn.dataset.id;
      if (action === 'delete') confirmDelete(id);
      if (action === 'edit') openEditWant(id);
    });
  });
}

function buildWantCard(w) {
  const pct = getProgress(w);
  const saved = getAllocated(w);
  const funded = pct >= 100;
  const imgEl = w.image
    ? `<img class="want-card-img" src="${escAttr(w.image)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><div class="want-card-img-placeholder" style="display:none">🛍️</div>`
    : `<div class="want-card-img-placeholder">🛍️</div>`;

  return `
    <div class="want-card glass-card">
      ${imgEl}
      <div class="want-card-body">
        <div class="want-card-name">${esc(w.name)} ${funded ? '<span class="funded-badge">✓ Funded</span>' : ''}</div>
        <div class="want-card-price">${fmt(w.price)}</div>
        <div class="want-card-bar-track">
          <div class="want-card-bar-fill" style="width:${pct.toFixed(1)}%"></div>
        </div>
        <div class="want-card-meta">
          <div class="want-card-pct">${(w.allocationPercent || 0)}% alloc</div>
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

function renderActive() {
  const activeTab = $$('.tab-btn').find(b => b.classList.contains('active'))?.dataset.tab || 'home';
  if (activeTab === 'home') renderHome();
  if (activeTab === 'bank') renderBank();
  if (activeTab === 'wants') renderWants();
  // Always keep home stats fresh
  if (activeTab !== 'home') {
    // Update stat numbers silently
    const totalCost = state.wants.reduce((s, w) => s + (parseFloat(w.price) || 0), 0);
    const funded = state.wants.filter(w => getProgress(w) >= 100).length;
    const el = $('#home-savings');
    if (el) el.textContent = fmt(state.currentSavings);
    const hc = $('#home-want-count');
    if (hc) hc.textContent = state.wants.length;
    const htc = $('#home-total-cost');
    if (htc) htc.textContent = fmt(totalCost);
    const hf = $('#home-funded-count');
    if (hf) hf.textContent = funded;
  }
}

// ─── Bank: Update Savings ────────────────────
$('#update-savings-btn').addEventListener('click', async () => {
  const val = parseFloat($('#savings-input').value);
  if (isNaN(val) || val < 0) { toast('Enter a valid savings amount'); return; }

  const entry = { amount: val, date: new Date().toISOString() };
  const history = [...state.savingsHistory, entry];

  await storage.updateBank(val, history);
  toast('Savings updated ✓');
  renderBank();
  renderHome();
});

// ─── Add/Edit Want Modal ──────────────────────
function openAddWant() {
  state.editingWantId = null;
  resetModal();
  $('#modal-title-text').textContent = 'Add a Want';
  $('#save-want-btn').textContent = 'Save Want';
  showModal('#want-modal');
}

function openEditWant(id) {
  const want = state.wants.find(w => w.id === id);
  if (!want) return;
  state.editingWantId = id;
  resetModal();
  $('#modal-title-text').textContent = 'Edit Want';
  $('#save-want-btn').textContent = 'Update Want';
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
  $('#want-url').value = '';
  $('#want-name').value = '';
  $('#want-price').value = '';
  $('#want-alloc').value = '';
  $('#want-desc').value = '';
  $('#want-img-url').value = '';
  $('#img-preview-wrap').hidden = true;
  $('#want-img-preview').src = '';
  resetFetchBtn();
}

function resetFetchBtn() {
  const btn = $('#fetch-url-btn');
  btn.disabled = false;
  $('#fetch-label').hidden = false;
  $('#fetch-spinner').hidden = true;
}

$('#open-add-want').addEventListener('click', openAddWant);
$('#close-modal').addEventListener('click', () => hideModal('#want-modal'));
$('#cancel-want-btn').addEventListener('click', () => hideModal('#want-modal'));

// URL Fetch
$('#fetch-url-btn').addEventListener('click', async () => {
  const url = $('#want-url').value.trim();
  if (!url) { toast('Paste a product URL first'); return; }

  const btn = $('#fetch-url-btn');
  btn.disabled = true;
  $('#fetch-label').hidden = true;
  $('#fetch-spinner').hidden = false;

  try {
    const meta = await fetchMeta(url);
    if (meta.title)            $('#want-name').value = meta.title;
    if (meta.description)      $('#want-desc').value = meta.description;
    if (meta.image?.url)       setPreviewImage(meta.image.url);
    if (meta.price?.amount)    $('#want-price').value = parseFloat(meta.price.amount);
    toast('Details fetched ✓');
  } catch (e) {
    toast('Could not auto-fill — fill in manually');
  } finally {
    resetFetchBtn();
  }
});

// Image URL override → update preview
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
  $('#want-img-preview').src = '';
  $('#want-img-url').value = '';
  $('#img-preview-wrap').hidden = true;
});

// Save Want
$('#save-want-btn').addEventListener('click', async () => {
  const name  = $('#want-name').value.trim();
  const price = parseFloat($('#want-price').value);
  const alloc = parseFloat($('#want-alloc').value) || 0;
  const url   = $('#want-url').value.trim();
  const img   = $('#want-img-url').value.trim() || ($('#want-img-preview').src !== window.location.href ? $('#want-img-preview').src : '');
  const desc  = $('#want-desc').value.trim();

  if (!name) { toast('Name is required'); return; }
  if (isNaN(price) || price <= 0) { toast('Enter a valid price'); return; }
  if (alloc < 0 || alloc > 100) { toast('Allocation must be 0–100%'); return; }

  const totalOtherAlloc = state.wants
    .filter(w => w.id !== state.editingWantId)
    .reduce((s, w) => s + (w.allocationPercent || 0), 0);
  if (totalOtherAlloc + alloc > 100) {
    toast(`Total allocation would exceed 100% (${totalOtherAlloc}% already used)`);
    return;
  }

  const want = {
    id: state.editingWantId || uid(),
    name, price, allocationPercent: alloc,
    url: url || '',
    image: img || '',
    description: desc || '',
    createdAt: state.editingWantId
      ? (state.wants.find(w => w.id === state.editingWantId)?.createdAt || new Date().toISOString())
      : new Date().toISOString(),
  };

  await storage.saveWant(want);
  hideModal('#want-modal');
  toast(state.editingWantId ? 'Want updated ✓' : 'Want added ✓');
  switchTab('wants');
});

function confirmDelete(id) {
  const want = state.wants.find(w => w.id === id);
  if (!want) return;
  if (!confirm(`Remove "${want.name}" from your wants?`)) return;
  storage.deleteWant(id).then(() => toast('Removed'));
}

// ─── Vault Modal ─────────────────────────────
$('#vault-btn').addEventListener('click', () => {
  $('#vault-id-input').value = state.vaultId;
  const stored = localStorage.getItem('wio-firebase-config');
  $('#firebase-config-input').value = stored ? JSON.stringify(JSON.parse(stored), null, 2) : '';
  showModal('#vault-modal');
});
$('#close-vault-modal').addEventListener('click', () => hideModal('#vault-modal'));
$('#close-vault-cancel').addEventListener('click', () => hideModal('#vault-modal'));

$('#sync-badge').addEventListener('click', () => {
  $('#vault-btn').click();
});

$('#gen-vault-id').addEventListener('click', () => {
  const words = ['sky', 'wave', 'neon', 'frost', 'solar', 'drift', 'prism', 'lune', 'ember', 'zest'];
  const pick = () => words[Math.floor(Math.random() * words.length)];
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
    } catch {
      toast('Invalid Firebase config JSON');
      return;
    }
  } else {
    // Vault ID only, no Firebase (still useful for future use)
    localStorage.removeItem('wio-firebase-config');
    updateSyncBadge(false);
    hideModal('#vault-modal');
    toast('Vault ID saved (local mode)');
  }
});

// ─── Modal Helpers ───────────────────────────
function showModal(sel) {
  const el = $(sel);
  el.removeAttribute('hidden');
  document.body.style.overflow = 'hidden';
}
function hideModal(sel) {
  $(sel).hidden = true;
  document.body.style.overflow = '';
}

// Close modal on overlay click
$$('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', e => {
    if (e.target === overlay) {
      overlay.hidden = true;
      document.body.style.overflow = '';
    }
  });
});

// ─── Escape Helpers ──────────────────────────
function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escAttr(str) { return esc(str); }

// ─── SVG Gradient Defs for stroke ────────────
function injectSvgDefs() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('svg-defs');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = `
    <defs>
      <linearGradient id="grad-stroke" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%"   stop-color="#a855f7"/>
        <stop offset="50%"  stop-color="#ec4899"/>
        <stop offset="100%" stop-color="#f97316"/>
      </linearGradient>
    </defs>`;
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
