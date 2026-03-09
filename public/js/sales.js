/*
 * Sales agent dashboard script:
 * - Handles cash sale, credit sale, and credit payment workflows.
 * - Maintains branch stock visibility and low/out-of-stock alerts.
 * - Refreshes branch data with scheduled polling.
 */

// ======================================================================
// SECTION 1: GLOBAL VARIABLES & CONSTANTS
// ======================================================================

let user             = null;  // Logged-in user from localStorage
let availableStock   = [];    // Live stock from /api/procurement/available
let allSales         = [];    // Cash sales for this branch
let allCredits       = [];    // Credit sales for this branch (from API)
let stockPollInterval = null; // setInterval ref for background polling

// API_BASE is declared in common.js (loaded before this file in dashboard.html).
// Do NOT re-declare it here — a duplicate const causes a SyntaxError that
// crashes the entire script before any code runs.

// Types for the produce dropdown in forms
if (typeof PRODUCE_TYPES === 'undefined') {
  var PRODUCE_TYPES = ['Grain', 'Legume', 'Herbs', 'Vegetable', 'Fruits',
                       'Oilseeds', 'Spices', 'Nuts', 'Tubers', 'Other'];
}

// Items at or below this remaining_kg show "Low Stock" (amber warning)
// Use window namespace so this is safe even if common.js declares it too
if (typeof LOW_STOCK_THRESHOLD === 'undefined') { var LOW_STOCK_THRESHOLD = 1000; }

// Background poll interval: shared across dashboards (default 30 seconds)
if (typeof STOCK_POLL_INTERVAL_MS === 'undefined') {
  var STOCK_POLL_INTERVAL_MS = Number(window.KGL_DASHBOARD_POLL_MS || 30000);
}

// ======================================================================
// SECTION 2: INITIALIZATION
// ======================================================================

document.addEventListener('DOMContentLoaded', async () => {
  console.log('[INIT] Sales dashboard starting...');

  // ── Auth check ────────────────────────────────────────────────────────
  user = JSON.parse(localStorage.getItem('user'));
  if (!user || !['sales_agent', 'agent'].includes(String(user.role || '').toLowerCase())) {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.href = '../../index.html';
    return;
  }

  // ── Sidebar: fill user info ───────────────────────────────────────────
  document.body.classList.add('dashboard');
  const nameEl   = document.getElementById('userName');
  const roleEl   = document.getElementById('userRole');
  const branchEl = document.getElementById('userBranch');
  if (nameEl)   nameEl.textContent   = user.full_name || 'User';
  if (roleEl)   roleEl.textContent   = (user.role || 'sales agent').replace('_', ' ');
  if (branchEl) branchEl.textContent = user.branch || '-';

  // ── Fill auto-fields in forms ─────────────────────────────────────────
  const agentFields = ['saleAgent', 'creditAgent'];
  agentFields.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = user.full_name || '';
  });

  // ── Setup all UI wiring ───────────────────────────────────────────────
  setCurrentDateTime();
  populateTypeDropdowns();
  setupNavigation();
  setupSearch();
  setupFormEventListeners();
  setupPriceCalculators();
  setupNotificationBell();
  setupNinAutoUppercase();

  // ── Logout ────────────────────────────────────────────────────────────
  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) logoutBtn.addEventListener('click', showLogoutConfirm);

  // ── Load all data ─────────────────────────────────────────────────────
  await loadAvailableStock();
  await loadRecentSales();
  await loadCreditSales();
  await loadDashboardStats();

  // ── Start background polling ──────────────────────────────────────────
  startStockPolling();

  setTimeout(setupInteractiveStats, 500);
  showSection('dashboard');
  console.log('[INIT] Dashboard ready.');
});

// ======================================================================
// SECTION 3: HELPERS
// ======================================================================

/** Sets today's date and current time in all disabled form fields. */
function setCurrentDateTime() {
  const today = new Date().toISOString().split('T')[0];
  const time  = new Date().toTimeString().slice(0, 5);

  ['saleDate', 'creditDispatchDate'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = today;
  });
  const timeEl = document.getElementById('saleTime');
  if (timeEl) timeEl.value = time;
  const dueEl = document.getElementById('creditDue');
  if (dueEl) dueEl.min = today;
}

/** Populates all produce-type dropdowns from the PRODUCE_TYPES constant. */
function populateTypeDropdowns() {
  document.querySelectorAll('.produce-type-select').forEach(select => {
    select.innerHTML = '<option value="">Select type</option>' +
      PRODUCE_TYPES.map(t => `<option value="${t}">${t}</option>`).join('');
  });
}

/** Returns JWT token from localStorage for Authorization headers. */
function getToken() {
  return localStorage.getItem('token') || null;
}

function escHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));
}

function escJs(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r?\n/g, ' ');
}

function apiFetch(url, options = {}) {
  const token = getToken();
  const headers = { ...(options.headers || {}) };
  if (token && !headers.Authorization && !headers.authorization) {
    headers.Authorization = `Bearer ${token}`;
  }
  return fetch(url, { ...options, headers });
}

/**
 * Auto-uppercases the National ID field as the agent types.
 * Prevents HTML5 pattern validation from rejecting lowercase input.
 * Called once on init — preserves cursor position while typing.
 */
function setupNinAutoUppercase() {
  const ninInput = document.getElementById('creditNin');
  if (!ninInput) return;
  ninInput.addEventListener('input', () => {
    const pos = ninInput.selectionStart;
    ninInput.value = ninInput.value.toUpperCase();
    ninInput.setSelectionRange(pos, pos);
  });
}

// ======================================================================
// SECTION 4: BACKGROUND POLLING
// ======================================================================

/**
 * Silently re-fetches stock, sales, and credits from the API.
 * If the manager restocked or marked a credit as paid, the agent's
 * dashboard picks it up without any page reload.
 */
function startStockPolling() {
  if (stockPollInterval) clearInterval(stockPollInterval);

  stockPollInterval = setInterval(async () => {
    console.log('[POLL] Silent stock refresh...');
    if (!isDashboardSectionVisible()) {
      await refreshNotificationsOnly();
      return;
    }
    await loadAvailableStock(true);
    await loadRecentSales();
    await loadCreditSales(true);
    await loadDashboardStats();
  }, STOCK_POLL_INTERVAL_MS);

  console.log(`[POLL] Stock polling started — every ${STOCK_POLL_INTERVAL_MS / 1000}s`);
}

function stopStockPolling() {
  if (stockPollInterval) {
    clearInterval(stockPollInterval);
    stockPollInterval = null;
    console.log('[POLL] Polling stopped');
  }
}

function isDashboardSectionVisible() {
  const dashboardSection = document.getElementById('dashboardSection');
  return Boolean(dashboardSection) && dashboardSection.style.display !== 'none';
}

async function refreshNotificationsOnly() {
  try {
    const res = await apiFetch(`${API_BASE}/procurement/available?branch=${user.branch}`);
    if (!res.ok) return;
    availableStock = await res.json();
    checkLowStockAndNotify();
  } catch (err) {
    console.warn('[POLL] Notification-only refresh failed:', err.message);
  }
}

// ======================================================================
// SECTION 5: NAVIGATION
// ======================================================================

function setupNavigation() {
  document.querySelectorAll('.sidebar-nav a[data-page]').forEach(link => {
    link.addEventListener('click', e => {
      e.preventDefault();
      document.querySelectorAll('.sidebar-nav a').forEach(a => a.classList.remove('active'));
      link.classList.add('active');
      showSection(link.dataset.page);
    });
  });
}

/**
 * Shows one content section and hides all others.
 * @param {string} name - 'dashboard' | 'record-sale' | 'record-credit'
 */
window.showSection = (name) => {
  document.querySelectorAll('.content-section').forEach(s => s.style.display = 'none');
  const target = document.getElementById(name === 'dashboard' ? 'dashboardSection' : `${name}Section`);
  if (target) target.style.display = 'block';

  const titleMap = {
    'dashboard':     'Sales Dashboard',
    'record-sale':   'Record Sale',
    'record-credit': 'Record Credit Sale'
  };
  const titleEl = document.getElementById('pageTitle');
  if (titleEl) titleEl.textContent = titleMap[name] || 'Sales Dashboard';
};

// ======================================================================
// SECTION 6: SEARCH
// ======================================================================

function setupSearch() {
  const searchInput = document.getElementById('tableSearch');
  if (!searchInput) return;
  searchInput.addEventListener('input', () => filterStockTable(searchInput.value.toLowerCase().trim()));
}

function filterStockTable(term) {
  if (!term) { displayStockTable(availableStock); return; }
  const filtered = availableStock.filter(item =>
    (item.name || '').toLowerCase().includes(term) ||
    (item.type || '').toLowerCase().includes(term) ||
    String(item.remaining_kg || 0).includes(term) ||
    String(item.price_to_sell || 0).includes(term)
  );
  displayStockTable(filtered);
}

// ======================================================================
// SECTION 7: STOCK LOADING & DISPLAY
// ======================================================================

/**
 * Fetches live stock from the API for the agent's branch.
 * @param {boolean} silent - If true, skips the loading spinner (used by polling)
 */
async function loadAvailableStock(silent = false) {
  const tbody = document.getElementById('stockTableBody');
  if (!tbody) return;

  if (!silent) {
    tbody.innerHTML = `<tr><td colspan="4" class="no-results">Loading stock...</td></tr>`;
  }

  try {
    const res = await apiFetch(`${API_BASE}/procurement/available?branch=${user.branch}`);
    if (!res.ok) throw new Error(`API returned ${res.status}`);

    const freshStock = await res.json();
    availableStock   = freshStock;
    console.log(`[STOCK] Loaded ${availableStock.length} items from API`);

  } catch (err) {
    console.warn('[STOCK] API error:', err.message);

    // If we have no data yet (first load), show error. On polling, keep existing data.
    if (availableStock.length === 0 && !silent) {
      tbody.innerHTML =
        '<tr><td colspan="4" class="no-results" style="color:#dc2626;padding:20px;">' +
        '<strong>⚠️ Backend not responding:</strong> ' + err.message + '<br><br>' +
        'Start your server with <code>npm run dev</code> then refresh.' +
        '</td></tr>';
    }
  }

  displayStockTable(availableStock);
  populateProduceDropdowns(availableStock);

  const branchEl = document.getElementById('stockBranch');
  if (branchEl) branchEl.textContent = user?.branch || 'Branch';

  checkLowStockAndNotify();
}

/**
 * Renders the Available Stock table.
 * Row colours: Red = out-of-stock, Amber = low stock, Normal = healthy
 */
function displayStockTable(stock) {
  const tbody = document.getElementById('stockTableBody');
  if (!tbody) return;

  if (!stock || stock.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="no-results">No stock available</td></tr>`;
    return;
  }

  console.log('[STOCK TABLE] Rendering:', stock.map(i => `${i.name}: ${i.remaining_kg}kg`));

  tbody.innerHTML = stock.map(item => {
    const qty          = item.remaining_kg ?? 0;
    const isOut        = qty <= 0;
    const isLow        = qty > 0 && qty <= LOW_STOCK_THRESHOLD;
    const rowClass     = isOut ? 'out-of-stock-row' : isLow ? 'low-stock-row' : '';

    return `
      <tr class="${rowClass}" data-id="${item._id}" data-stock="${qty}">
        <td>
          <div class="produce-name">${escHtml(item.name || 'Unknown')}</div>
          <div class="produce-type">${escHtml(item.type || 'N/A')}</div>
          ${isLow ? '<span class="stock-warning">⚠️ Low Stock</span>'   : ''}
          ${isOut ? '<span class="stock-danger">❌ Out of Stock</span>' : ''}
        </td>
        <td class="${isLow ? 'warning-text' : ''} ${isOut ? 'danger-text' : ''}">
          ${qty.toLocaleString()} kg
        </td>
        <td>Ush ${(item.price_to_sell || 0).toLocaleString()}</td>
        <td>
          ${isOut
            ? '<span class="out-of-stock">Out of Stock</span>'
            : `<button class="action-btn" onclick="quickSell('${escJs(item._id)}','${escJs(item.name)}',${qty})">
                 <i class="bi bi-cart-plus"></i> Quick Sell
               </button>`}
        </td>
      </tr>`;
  }).join('');
}

/**
 * Fills produce dropdowns in the Sale and Credit forms.
 * Only in-stock items appear in the cash sale dropdown.
 * All items appear in credit dropdown (you may still want to log dispatch).
 * Each option carries data-price and data-name for the price calculators.
 */
function populateProduceDropdowns(stock) {
  const saleSelect   = document.getElementById('saleProduce');
  const creditSelect = document.getElementById('creditProduce');
  const inStock      = stock.filter(i => (i.remaining_kg ?? 0) > 0);
  const previousSaleValue = saleSelect?.value || '';
  const previousCreditValue = creditSelect?.value || '';

  if (saleSelect) {
    saleSelect.innerHTML = '<option value="">Select produce</option>' +
      inStock.map(i =>
        `<option value="${escHtml(i._id)}" data-price="${i.price_to_sell || 0}" data-name="${escHtml(i.name)}" data-type="${escHtml(i.type || '')}">
           ${escHtml(i.name)} (${(i.remaining_kg ?? 0).toLocaleString()} kg) — Ush ${(i.price_to_sell || 0).toLocaleString()}/kg
         </option>`
      ).join('');
    if (previousSaleValue && inStock.some(i => String(i._id) === String(previousSaleValue))) {
      saleSelect.value = previousSaleValue;
      saleSelect.dispatchEvent(new Event('change'));
    }
  }

  if (creditSelect) {
    creditSelect.innerHTML = '<option value="">Select produce</option>' +
      stock.map(i =>
        `<option value="${escHtml(i._id)}" data-price="${i.price_to_sell || 0}" data-name="${escHtml(i.name)}" data-type="${escHtml(i.type || '')}">
           ${escHtml(i.name)} (${(i.remaining_kg ?? 0).toLocaleString()} kg available)
         </option>`
      ).join('');
    if (previousCreditValue && stock.some(i => String(i._id) === String(previousCreditValue))) {
      creditSelect.value = previousCreditValue;
      creditSelect.dispatchEvent(new Event('change'));
    }
  }
}

// ======================================================================
// SECTION 8: DASHBOARD STATS
// ======================================================================

async function loadDashboardStats() {
  try {
    const today = new Date().toISOString().split('T')[0];

    // Today's cash sales
    const todaySales = allSales.filter(s =>
      s.date ? new Date(s.date).toISOString().split('T')[0] === today : false
    );
    const todayTotal = todaySales.reduce((sum, s) => sum + (s.amount_paid_ugx || 0), 0);

    safeSet('todaySalesValue', `Ush ${todayTotal.toLocaleString()}`);
    safeSet('todaySalesCount', `${todaySales.length} ${todaySales.length === 1 ? 'TXN' : 'TXNS'}`);

    // Today's total tonnage sold (cash sales only)
    const todayTonnage = todaySales.reduce((sum, s) => sum + (s.tonnage_kg || 0), 0);
    safeSet('todayTonnageValue', `${todayTonnage.toLocaleString()} kg`);
    safeSet('todayTonnageCount', `${todaySales.length} ${todaySales.length === 1 ? 'DISPATCH' : 'DISPATCHES'}`);

    // Today's credit sales
    const todayCredits = allCredits.filter(c =>
      c.date_of_dispatch ? new Date(c.date_of_dispatch).toISOString().split('T')[0] === today : false
    );
    const todayCreditTotal = todayCredits.reduce((sum, c) => sum + (c.amount_due_ugx || 0), 0);

    safeSet('todayCreditsValue', `Ush ${todayCreditTotal.toLocaleString()}`);
    safeSet('todayCreditsCount', `${todayCredits.length} ${todayCredits.length === 1 ? 'TXN' : 'TXNS'}`);

    updateAvailableStockStat();
    updateCreditStats();

  } catch (err) {
    console.error('[STATS]', err);
  }
}

function updateAvailableStockStat() {
  const total    = availableStock.reduce((sum, i) => sum + (i.remaining_kg ?? 0), 0);
  const inStockN = availableStock.filter(i => (i.remaining_kg ?? 0) > 0).length;
  safeSet('availableStockValue', `${total.toLocaleString()} kg`);
  safeSet('availableStockCount', `${inStockN} ${inStockN === 1 ? 'PRODUCT' : 'PRODUCTS'}`);
}

function updateCreditStats() {
  const today   = new Date(); today.setHours(0, 0, 0, 0);

  // Only count unsettled credits in "Total Pending" and "Overdue"
  const unpaid  = allCredits.filter(c => c.status !== 'paid');
  const totalPending = unpaid.reduce((sum, c) => sum + ((c.amount_due_ugx || 0) - (c.amount_paid_ugx || 0)), 0);
  const overdue = unpaid.filter(c => {
    if (!c.due_date) return false;
    const due = new Date(c.due_date); due.setHours(0, 0, 0, 0);
    return due < today;
  }).length;

  safeSet('totalPendingValue', `Ush ${totalPending.toLocaleString()}`);
  safeSet('pendingCountValue', allCredits.length);
  safeSet('overdueValue',      overdue);
}

/** Sets textContent of an element by id — ignores silently if not found. */
function safeSet(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

// ======================================================================
// SECTION 9: TABLE LOADERS
// ======================================================================

/** Loads recent cash sales from API, falls back to localStorage. */
async function loadRecentSales() {
  try {
    let sales = [];
    try {
      const res = await apiFetch(`${API_BASE}/sales/branch?branch=${user.branch}`);
      if (res.ok) { sales = await res.json(); console.log(`[SALES] Loaded ${sales.length} from API`); }
    } catch { console.warn('[SALES] API unavailable, using localStorage'); }

    if (sales.length === 0) {
      const local = JSON.parse(localStorage.getItem('localSales') || '[]');
      sales = local.filter(s => s.branch === user.branch);
    }

    allSales = sales;
    const tbody  = document.getElementById('recentSalesBody');
    if (!tbody) return;
    const recent = sales.slice(0, 5);

    if (recent.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="no-results">No recent sales</td></tr>';
      return;
    }

    tbody.innerHTML = recent.map(s => `
      <tr>
        <td>${escHtml(s.produce_name || 'N/A')}</td>
        <td>${(s.tonnage_kg || 0).toLocaleString()} kg</td>
        <td>Ush ${(s.amount_paid_ugx || 0).toLocaleString()}</td>
        <td>${escHtml(s.buyer_name || 'N/A')}</td>
        <td>${s.date ? new Date(s.date).toLocaleDateString() : ''} ${s.time || ''}</td>
      </tr>`).join('');

  } catch (err) { console.error('[SALES] Load error:', err); }
}

/**
 * Loads credit sales from the API.
 * Each row has an "Update Payment" action button for recording payments.
 * Status badge is colour-coded: pending=blue, partial=amber, paid=green, overdue=red.
 *
 * @param {boolean} silent - If true, skips showing a loading spinner
 */
async function loadCreditSales(silent = false) {
  try {
    let credits = [];

    try {
      const res = await apiFetch(`${API_BASE}/credits/branch?branch=${user.branch}`);
      if (res.ok) {
        credits = await res.json();
        console.log(`[CREDITS] Loaded ${credits.length} from API`);
      }
    } catch {
      console.warn('[CREDITS] API unavailable — credits table may be empty');
    }

    allCredits = credits;
    renderCreditsTable(allCredits);

  } catch (err) { console.error('[CREDITS] Load error:', err); }
}

/**
 * Renders the Recent Credits table with payment action buttons.
 * Status is computed at render time: overdue takes priority over pending/partial.
 *
 * STATUS BADGE COLOURS:
 *   paid     → green
 *   partial  → amber
 *   overdue  → red
 *   pending  → blue/grey
 */
function renderCreditsTable(credits) {
  const tbody  = document.getElementById('recentCreditsBody');
  if (!tbody) return;

  const recent = credits.slice(0, 10);
  const today  = new Date(); today.setHours(0, 0, 0, 0);

  if (recent.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="no-results">No credit sales recorded</td></tr>';
    return;
  }

  tbody.innerHTML = recent.map(c => {
    const due         = new Date(c.due_date); due.setHours(0, 0, 0, 0);
    const isOverdue   = c.status !== 'paid' && due < today;
    const wasPaidLate = c.status === 'paid' && due < today;

    // Determine the effective display status
    const displayStatus = wasPaidLate ? 'paid_late'
                        : c.status === 'paid' ? 'paid'
                        : isOverdue            ? 'overdue'
                        : c.status === 'partial' ? 'partial'
                        : 'pending';

    const statusColors = {
      paid:    { bg: '#d1fae5', color: '#065f46', label: '✅ Paid' },
      paid_late: { bg: '#fef3c7', color: '#92400e', label: '✅ Paid (Late)' },
      partial: { bg: '#fef3c7', color: '#92400e', label: '🔶 Partial' },
      overdue: { bg: '#fee2e2', color: '#991b1b', label: '🔴 Overdue' },
      pending: { bg: '#eff6ff', color: '#1e40af', label: '🔵 Pending' }
    };
    const sc = statusColors[displayStatus];

    const balance = Math.max(0, (c.amount_due_ugx || 0) - (c.amount_paid_ugx || 0));

    // Action button — hidden if already paid
    const actionBtn = c.status !== 'paid'
      ? `<button class="action-btn" style="font-size:0.78rem;padding:5px 10px;"
           onclick="openPaymentModal('${escJs(c._id)}','${escJs(c.buyer_name)}',${c.amount_due_ugx},${c.amount_paid_ugx})">
           <i class="bi bi-cash-coin"></i> Record Payment
         </button>`
      : '<span style="color:#6b7280;font-size:0.8rem;">Settled</span>';

    return `
      <tr>
        <td>
          <div class="produce-name">${escHtml(c.produce_name || 'N/A')}</div>
          <div class="produce-type" style="font-size:0.75rem;color:#6b7280;">${escHtml(c.buyer_name || '')}</div>
        </td>
        <td>${(c.tonnage_kg || 0).toLocaleString()} kg</td>
        <td>
          <div>Ush ${(c.amount_due_ugx || 0).toLocaleString()}</div>
          <div style="font-size:0.75rem;color:${balance > 0 ? '#dc2626' : '#065f46'};">
            Balance: Ush ${balance.toLocaleString()}
          </div>
        </td>
        <td>${c.due_date ? new Date(c.due_date).toLocaleDateString() : 'N/A'}</td>
        <td>
          <span style="background:${sc.bg};color:${sc.color};padding:3px 10px;border-radius:12px;font-size:0.78rem;font-weight:600;">
            ${sc.label}
          </span>
        </td>
        <td>${actionBtn}</td>
      </tr>`;
  }).join('');
}

// ======================================================================
// SECTION 10: QUICK SELL
// ======================================================================

window.quickSell = (produceId, produceName, maxTonnage) => {
  document.querySelectorAll('.sidebar-nav a').forEach(a => a.classList.remove('active'));
  document.querySelector('[data-page="record-sale"]')?.classList.add('active');
  showSection('record-sale');

  const select = document.getElementById('saleProduce');
  if (select) { select.value = produceId; select.dispatchEvent(new Event('change')); }

  const tonnageInput = document.getElementById('saleTonnage');
  if (tonnageInput) {
    tonnageInput.max = maxTonnage;
    tonnageInput.placeholder = `Max ${maxTonnage.toLocaleString()} kg`;
  }
  showToast(`Ready to sell ${produceName}`, 'success');
};

// ======================================================================
// SECTION 11: PAYMENT MODAL
// ======================================================================

/**
 * Opens a modal dialog for recording a payment against a credit sale.
 *
 * @param {string} creditId      - MongoDB _id of the CreditSale
 * @param {string} buyerName     - For display in the modal title
 * @param {number} amountDue     - Original full debt
 * @param {number} amountPaid    - How much has been paid so far
 */
window.openPaymentModal = (creditId, buyerName, amountDue, amountPaid) => {
  // Remove any existing modal
  const existing = document.getElementById('paymentModal');
  if (existing) existing.remove();

  const balance = Math.max(0, amountDue - amountPaid);

  document.body.insertAdjacentHTML('beforeend', `
    <div class="custom-confirm" id="paymentModal" style="z-index:10000;">
      <div class="confirm-dialog" style="text-align:left;max-width:440px;">

        <!-- Header -->
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
          <h3 style="color:#1a237e;margin:0;font-size:1.1rem;">
            <i class="bi bi-cash-coin"></i> Record Payment
          </h3>
          <button onclick="closePaymentModal()"
            style="background:#f1f5f9;border:none;border-radius:50%;width:32px;height:32px;
                   font-size:1.3rem;cursor:pointer;color:#374151;line-height:1;">
            &times;
          </button>
        </div>

        <!-- Credit summary -->
        <div style="background:#f8fafc;border-radius:8px;padding:12px 16px;margin-bottom:20px;font-size:0.9rem;">
          <div style="margin-bottom:6px;"><strong>Buyer:</strong> ${buyerName}</div>
          <div style="margin-bottom:6px;"><strong>Total owed:</strong> Ush ${amountDue.toLocaleString()}</div>
          <div style="margin-bottom:6px;"><strong>Already paid:</strong> Ush ${amountPaid.toLocaleString()}</div>
          <div style="color:#dc2626;font-weight:700;"><strong>Balance due:</strong> Ush ${balance.toLocaleString()}</div>
        </div>

        <!-- Payment amount -->
        <div class="form-group" style="margin-bottom:16px;">
          <label style="display:block;font-weight:600;margin-bottom:6px;font-size:0.9rem;">
            Amount Paid Now (UGX) <span style="color:#ef4444;">*</span>
          </label>
          <input type="number" id="paymentAmount"
            min="1000" max="${balance}" step="1000"
            value="${balance}"
            placeholder="Enter amount received"
            style="width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:0.95rem;"
          />
          <small style="color:#6b7280;font-size:0.78rem;">Maximum: Ush ${balance.toLocaleString()}</small>
        </div>

        <!-- Optional note -->
        <div class="form-group" style="margin-bottom:20px;">
          <label style="display:block;font-weight:600;margin-bottom:6px;font-size:0.9rem;">
            Payment Note (Optional)
          </label>
          <input type="text" id="paymentNote"
            placeholder="e.g. Cash, MTN Mobile Money, partial before market day"
            style="width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:0.95rem;"
          />
        </div>

        <!-- Actions -->
        <div style="display:flex;gap:10px;justify-content:flex-end;">
          <button onclick="closePaymentModal()"
            style="padding:9px 20px;background:#e2e8f0;border:none;border-radius:8px;cursor:pointer;font-weight:500;">
            Cancel
          </button>
          <button onclick="submitPayment('${creditId}')"
            style="padding:9px 20px;background:#1a237e;color:white;border:none;border-radius:8px;cursor:pointer;font-weight:600;">
            <i class="bi bi-check-lg"></i> Confirm Payment
          </button>
        </div>

      </div>
    </div>
  `);
};

window.closePaymentModal = () => {
  const m = document.getElementById('paymentModal');
  if (m) m.remove();
};

/**
 * Submits a payment to PATCH /api/credits/:id/pay.
 * On success: closes modal, reloads credits table, updates stats.
 * Status badge auto-updates: pending → partial → paid.
 *
 * @param {string} creditId - MongoDB _id of the CreditSale
 */
window.submitPayment = async (creditId) => {
  const amountEl = document.getElementById('paymentAmount');
  const noteEl   = document.getElementById('paymentNote');

  const amount = Number(amountEl?.value);
  if (!amount || amount < 1000) {
    showToast('Amount must be at least 1,000 UGX', 'error');
    return;
  }

  const payload = {
    amount_ugx:  amount,
    recorded_by: user.full_name,
    note:        noteEl?.value?.trim() || ''
  };

  try {
    const res = await apiFetch(`${API_BASE}/credits/${creditId}/pay`, {
      method:  'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...(getToken() ? { 'Authorization': `Bearer ${getToken()}` } : {})
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const err = await res.json();
      const balanceHint = err.balance_due_ugx
        ? ` | Remaining balance: Ush ${Number(err.balance_due_ugx).toLocaleString()}`
        : '';
      showToast(`Error: ${err.error || 'Payment failed'}${balanceHint}`, 'error');
      return;
    }

    const updated = await res.json();
    closePaymentModal();

    // Determine the new display status for the toast message
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const due   = new Date(updated.due_date); due.setHours(0, 0, 0, 0);
    const displayStatus = updated.status === 'paid' ? 'paid'
                        : (due < today ? 'overdue' : updated.status);

    const statusMsg = {
      paid:    '✅ Fully paid — credit settled!',
      partial: '🔶 Partial payment recorded',
      overdue: '🔴 Payment recorded (overdue)',
      pending: '✅ Payment recorded'
    };

    showToast(statusMsg[displayStatus] || '✅ Payment recorded', 'success');

    // Reload credits and stats
    await loadCreditSales();
    await loadDashboardStats();

  } catch (err) {
    console.error('[PAYMENT]', err);
    showToast('Network error. Payment not saved.', 'error');
  }
};

// ======================================================================
// SECTION 12: FORM SETUP & PRICE CALCULATORS
// ======================================================================

function setupFormEventListeners() {
  const saleForm   = document.getElementById('saleForm');
  const creditForm = document.getElementById('creditForm');
  if (saleForm)   saleForm.addEventListener('submit',   submitSale);
  if (creditForm) creditForm.addEventListener('submit', submitCredit);
}

/**
 * Wires price auto-calculation for BOTH the sale and credit forms.
 * When produce or tonnage changes, Amount is auto-filled: price × tonnage.
 * Agent can still override the amount manually.
 */
function setupPriceCalculators() {
  // Cash sale
  const sProduce = document.getElementById('saleProduce');
  const sTonnage = document.getElementById('saleTonnage');
  if (sProduce) sProduce.addEventListener('change', calculateSaleAmount);
  if (sTonnage) sTonnage.addEventListener('input',  calculateSaleAmount);

  // Credit sale
  const cProduce = document.getElementById('creditProduce');
  const cTonnage = document.getElementById('creditTonnage');
  if (cProduce) cProduce.addEventListener('change', calculateCreditAmount);
  if (cTonnage) cTonnage.addEventListener('input',  calculateCreditAmount);
}

function calculateSaleAmount() {
  const produce  = document.getElementById('saleProduce');
  const tonnage  = document.getElementById('saleTonnage');
  const amountEl = document.getElementById('saleAmount');
  const typeEl   = document.getElementById('saleType');
  if (!produce || !tonnage || !amountEl) return;
  const option = produce.selectedOptions[0];
  const price = parseFloat(option?.dataset?.price || 0);
  const kg    = parseFloat(tonnage.value);
  if (price > 0 && kg > 0) amountEl.value = Math.round(price * kg);
  if (typeEl && option?.dataset?.type) typeEl.value = option.dataset.type;
}

function calculateCreditAmount() {
  const produce  = document.getElementById('creditProduce');
  const tonnage  = document.getElementById('creditTonnage');
  const amountEl = document.getElementById('creditAmount');
  const typeEl   = document.getElementById('creditType');
  if (!produce || !tonnage || !amountEl) return;
  const option = produce.selectedOptions[0];
  const price = parseFloat(option?.dataset?.price || 0);
  const kg    = parseFloat(tonnage.value);
  if (price > 0 && kg > 0) amountEl.value = Math.round(price * kg);
  if (typeEl && option?.dataset?.type) typeEl.value = option.dataset.type;
}

// ======================================================================
// SECTION 13: SUBMIT CASH SALE
// ======================================================================

/**
 * Handles the Record Sale form.
 * POST /api/sales → backend deducts stock → we update local state.
 */
async function submitSale(e) {
  e.preventDefault();

  const produceSelect  = document.getElementById('saleProduce');
  const selectedOption = produceSelect?.selectedOptions[0];
  if (!selectedOption || !produceSelect.value) { showToast('Please select a produce', 'error'); return; }

  const selectedProduce = availableStock.find(i => i._id === produceSelect.value);
  if (!selectedProduce) { showToast('Selected produce not found in stock', 'error'); return; }

  const tonnage = Number(document.getElementById('saleTonnage')?.value);
  if (!tonnage || tonnage < 1000) { showToast('Tonnage must be at least 1,000 kg', 'error'); return; }
  if (tonnage > (selectedProduce.remaining_kg ?? 0)) {
    showToast(`Only ${(selectedProduce.remaining_kg ?? 0).toLocaleString()} kg available`, 'error'); return;
  }

  const amount = Number(document.getElementById('saleAmount')?.value);
  if (!amount || amount < 10000) { showToast('Amount must be at least 10,000 UGX', 'error'); return; }

  const buyerName = document.getElementById('saleBuyer')?.value.trim();
  if (!buyerName || buyerName.length < 2) { showToast('Buyer name must be at least 2 characters', 'error'); return; }

  const saleData = {
    produce_name:    selectedOption.dataset.name || selectedProduce.name,
    tonnage_kg:      tonnage,
    amount_paid_ugx: amount,
    buyer_name:      buyerName,
    sales_agent:     user.full_name,
    branch:          user.branch,
    date:            new Date().toISOString(),
    time:            new Date().toLocaleTimeString()
  };

  try {
    const res = await apiFetch(`${API_BASE}/sales`, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(getToken() ? { 'Authorization': `Bearer ${getToken()}` } : {})
      },
      body: JSON.stringify(saleData)
    });

    if (!res.ok) { const err = await res.json(); showToast(`Error: ${err.error || 'Sale failed'}`, 'error'); return; }

    const response = await res.json();

    // Update local stock from the server's authoritative value
    const idx = availableStock.findIndex(i => i._id === produceSelect.value);
    if (idx !== -1) {
      availableStock[idx].remaining_kg =
        response.stock_remaining !== undefined ? response.stock_remaining
                                               : availableStock[idx].remaining_kg - tonnage;
    }

    // Refresh all UI that depends on stock
    displayStockTable([...availableStock]);
    populateProduceDropdowns(availableStock);
    updateAvailableStockStat();
    checkLowStockAndNotify();
    setTimeout(() => highlightUpdatedStock(produceSelect.value), 100);

    // Backup to localStorage
    const localSales = JSON.parse(localStorage.getItem('localSales') || '[]');
    localSales.unshift({ ...saleData, _id: response._id || Date.now().toString() });
    localStorage.setItem('localSales', JSON.stringify(localSales));

    allSales = [saleData, ...allSales];
    await loadRecentSales();
    await loadDashboardStats();

    showToast(`✅ Sale recorded: ${tonnage.toLocaleString()} kg of ${selectedProduce.name}`, 'success');

    // Offer to print receipt — non-blocking, agent can skip
    showSaleReceiptPrompt({
      produce:   saleData.produce_name,
      tonnage:   tonnage,
      amount:    amount,
      buyer:     buyerName,
      agent:     user.full_name,
      branch:    user.branch,
      ref:       response._id || ('S-' + Date.now()),
      date:      new Date().toLocaleString()
    });

    document.getElementById('saleForm').reset();
    setCurrentDateTime();
    document.getElementById('saleAgent').value = user.full_name;

    document.querySelectorAll('.sidebar-nav a').forEach(a => a.classList.remove('active'));
    document.querySelector('[data-page="dashboard"]')?.classList.add('active');
    showSection('dashboard');

  } catch (err) {
    console.error('[SALE]', err);
    showToast('Network error. Sale not saved.', 'error');
  }
}

function highlightUpdatedStock(produceId) {
  const row = document.querySelector(`#stockTableBody tr[data-id="${produceId}"]`);
  if (!row) return;
  row.classList.add('updated');
  setTimeout(() => row.classList.remove('updated'), 2000);
}

// ======================================================================
// SECTION 14: SUBMIT CREDIT SALE
// ======================================================================

/**
 * Handles the Record Credit form.
 * POST /api/credits → backend deducts stock AND saves credit to DB.
 * Returns stock_remaining so we can update the local stock table
 * immediately, exactly like a cash sale.
 *
 * WHY STOCK REDUCES ON CREDIT:
 * The goods physically leave the warehouse on dispatch day.
 * Whether payment is cash or credit is a finance question, not a
 * warehouse question. The warehouse loses the stock either way.
 */
async function submitCredit(e) {
  e.preventDefault();

  // ── Produce selection ──────────────────────────────────────────────────
  const produceSelect  = document.getElementById('creditProduce');
  const selectedOption = produceSelect?.selectedOptions[0];
  if (!selectedOption || !produceSelect.value) { showToast('Please select a produce', 'error'); return; }

  const selectedProduce = availableStock.find(i => i._id === produceSelect.value);
  if (!selectedProduce) { showToast('Selected produce not found', 'error'); return; }

  // ── Tonnage ────────────────────────────────────────────────────────────
  const tonnage = Number(document.getElementById('creditTonnage')?.value);
  if (!tonnage || tonnage < 1000) { showToast('Tonnage must be at least 1,000 kg', 'error'); return; }
  if (tonnage > (selectedProduce.remaining_kg ?? 0)) {
    showToast(`Only ${(selectedProduce.remaining_kg ?? 0).toLocaleString()} kg available`, 'error'); return;
  }

  // ── Amount ─────────────────────────────────────────────────────────────
  const amountDue = Number(document.getElementById('creditAmount')?.value);
  if (!amountDue || amountDue < 10000) { showToast('Amount must be at least 10,000 UGX', 'error'); return; }

  // ── Due date ───────────────────────────────────────────────────────────
  const dueDate = document.getElementById('creditDue')?.value;
  if (!dueDate) { showToast('Please select a payment due date', 'error'); return; }
  const today = new Date().toISOString().split('T')[0];
  if (dueDate < today) {
    showToast('You cannot select a due date before today', 'error');
    return;
  }

  // ── Buyer info ─────────────────────────────────────────────────────────
  const buyerName = document.getElementById('creditBuyer')?.value.trim();
  if (!buyerName || buyerName.length < 2) { showToast('Buyer name must be at least 2 characters', 'error'); return; }

  // NIN — auto-uppercase before validation
  const ninInput = document.getElementById('creditNin');
  if (ninInput) ninInput.value = ninInput.value.trim().toUpperCase();
  const nationalId = ninInput?.value || '';
  if (!nationalId || !/^[A-Z0-9]{14,16}$/.test(nationalId)) {
    showToast('Invalid National ID — must be 14–16 uppercase letters and numbers', 'error'); return;
  }

  const location = document.getElementById('creditLocation')?.value.trim();
  if (!location || location.length < 2) { showToast('Location must be at least 2 characters', 'error'); return; }

  const contact = document.getElementById('creditContact')?.value.trim();
  if (!contact || !/^0\d{9}$/.test(contact)) {
    showToast('Valid phone required (10 digits starting with 0)', 'error'); return;
  }

  const produceType = document.getElementById('creditType')?.value;
  if (!produceType) { showToast('Please select produce type', 'error'); return; }

  // ── Build payload ──────────────────────────────────────────────────────
  const creditData = {
    produce_name:     selectedOption.dataset.name || selectedProduce.name,
    produce_type:     produceType,
    tonnage_kg:       tonnage,
    amount_due_ugx:   amountDue,
    due_date:         dueDate,
    buyer_name:       buyerName,
    national_id:      nationalId,
    location:         location,
    buyer_contact:    contact,
    sales_agent_name: user.full_name,
    branch:           user.branch
  };

  try {
    const res = await apiFetch(`${API_BASE}/credits`, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(getToken() ? { 'Authorization': `Bearer ${getToken()}` } : {})
      },
      body: JSON.stringify(creditData)
    });

    if (!res.ok) { const err = await res.json(); showToast(`Error: ${err.error || 'Credit failed'}`, 'error'); return; }

    const response = await res.json();

    // ── Update local stock from backend's authoritative remaining value ────
    // This is why credit reduces stock: the backend deducted it atomically.
    const idx = availableStock.findIndex(i => i._id === produceSelect.value);
    if (idx !== -1) {
      availableStock[idx].remaining_kg =
        response.stock_remaining !== undefined ? response.stock_remaining
                                               : availableStock[idx].remaining_kg - tonnage;
    }

    // ── Refresh all UI that depends on stock ──────────────────────────────
    displayStockTable([...availableStock]);
    populateProduceDropdowns(availableStock);
    updateAvailableStockStat();
    checkLowStockAndNotify();
    setTimeout(() => highlightUpdatedStock(produceSelect.value), 100);

    await loadCreditSales();
    await loadDashboardStats();

    showToast(`✅ Credit recorded: ${tonnage.toLocaleString()} kg of ${selectedProduce.name}`, 'success');

    // Offer to print dispatch note — the physical paper the buyer receives
    showCreditDispatchPrompt({
      produce:    creditData.produce_name,
      type:       creditData.produce_type,
      tonnage:    tonnage,
      amountDue:  amountDue,
      dueDate:    dueDate,
      buyer:      buyerName,
      nationalId: nationalId,
      location:   location,
      contact:    contact,
      agent:      user.full_name,
      branch:     user.branch,
      ref:        response._id || ('C-' + Date.now()),
      dispatch:   new Date().toLocaleString()
    });

    document.getElementById('creditForm').reset();
    setCurrentDateTime();
    document.getElementById('creditAgent').value = user.full_name;

    document.querySelectorAll('.sidebar-nav a').forEach(a => a.classList.remove('active'));
    document.querySelector('[data-page="dashboard"]')?.classList.add('active');
    showSection('dashboard');

  } catch (err) {
    console.error('[CREDIT]', err);
    showToast('Network error. Credit not saved.', 'error');
  }
}

// ======================================================================
// SECTION 15: NOTIFICATION SYSTEM
// ======================================================================

/**
 * Wires the bell button ONCE on init.
 * Click → opens alerts panel listing low/out-of-stock items.
 */
function setupNotificationBell() {
  const bell = document.querySelector('.notif-icon');
  if (!bell) return;
  bell.addEventListener('click', () => {
    const low = availableStock.filter(i => (i.remaining_kg ?? 0) > 0 && (i.remaining_kg ?? 0) <= LOW_STOCK_THRESHOLD);
    const out = availableStock.filter(i => (i.remaining_kg ?? 0) <= 0);
    if (low.length + out.length === 0) { showToast('All stock levels are healthy ✅', 'success'); return; }
    showAlertsPanel(low, out);
  });
}

/**
 * Recalculates stock alerts and updates the badge number.
 * Called after every stock change (sale, credit, poll).
 */
function checkLowStockAndNotify() {
  const low  = availableStock.filter(i => (i.remaining_kg ?? 0) > 0 && (i.remaining_kg ?? 0) <= LOW_STOCK_THRESHOLD);
  const out  = availableStock.filter(i => (i.remaining_kg ?? 0) <= 0);
  const total = low.length + out.length;

  console.log(`[NOTIFY] Alerts — Low: ${low.length}, Out: ${out.length}`);
  updateNotificationBadge(total, low, out);
  if (total > 0) showStockAlertToast(low, out);
}

function updateNotificationBadge(count, low = [], out = []) {
  const badge = document.querySelector('.badge');
  const bell  = document.querySelector('.notif-icon');
  if (!badge || !bell) return;

  if (count > 0) {
    badge.textContent  = count;
    badge.style.display = 'inline';
    bell.classList.add('has-notification');
  } else {
    badge.textContent  = '0';
    badge.style.display = 'none';
    bell.classList.remove('has-notification');
  }
}

/**
 * Renders the stock alerts panel (modal).
 * Close button is in the header — always visible even on long lists.
 */
function showAlertsPanel(low, out) {
  const existing = document.getElementById('alertsModal');
  if (existing) existing.remove();

  document.body.insertAdjacentHTML('beforeend', `
    <div class="custom-confirm" id="alertsModal" style="z-index:10000;">
      <div class="confirm-dialog" style="text-align:left;max-width:500px;">

        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
          <h3 style="color:#dc2626;margin:0;display:flex;align-items:center;gap:8px;">
            <i class="bi bi-bell-fill"></i> Stock Alerts (${low.length + out.length})
          </h3>
          <button onclick="closeAlertsPanel()"
            style="background:#f1f5f9;border:none;border-radius:50%;width:32px;height:32px;
                   font-size:1.3rem;cursor:pointer;color:#374151;line-height:1;">
            &times;
          </button>
        </div>

        ${low.length ? `
          <div style="margin-bottom:20px;">
            <h4 style="color:#f59e0b;margin-bottom:10px;font-size:0.95rem;">
              <i class="bi bi-exclamation-triangle-fill"></i>
              Low Stock — ${low.length} item${low.length > 1 ? 's' : ''}
            </h4>
            <div class="alert-list">
              ${low.map(i => `
                <div style="display:flex;justify-content:space-between;padding:8px 12px;border-bottom:1px solid #f0f0f0;">
                  <span>${escHtml(i.name)}</span>
                  <span style="font-weight:700;color:#f59e0b;">${(i.remaining_kg ?? 0).toLocaleString()} kg</span>
                </div>`).join('')}
            </div>
          </div>` : ''}

        ${out.length ? `
          <div>
            <h4 style="color:#dc2626;margin-bottom:10px;font-size:0.95rem;">
              <i class="bi bi-x-circle-fill"></i>
              Out of Stock — ${out.length} item${out.length > 1 ? 's' : ''}
            </h4>
            <div class="alert-list">
              ${out.map(i => `
                <div style="display:flex;justify-content:space-between;padding:8px 12px;border-bottom:1px solid #f0f0f0;">
                  <span>${escHtml(i.name)}</span>
                  <span style="font-weight:700;color:#dc2626;">0 kg</span>
                </div>`).join('')}
            </div>
          </div>` : ''}

        <div style="margin-top:20px;text-align:center;">
          <button class="btn-primary" onclick="closeAlertsPanel()" style="padding:8px 24px;">
            Close
          </button>
        </div>
      </div>
    </div>
  `);
}

window.closeAlertsPanel = () => { const m = document.getElementById('alertsModal'); if (m) m.remove(); };

/**
 * Shows a toast only for NEWLY flagged items (not ones already alerted).
 * Uses sessionStorage to track which items have triggered a toast.
 * Prevents the same alert repeating every 60 seconds on polling.
 */
function showStockAlertToast(low, out) {
  const previous = JSON.parse(sessionStorage.getItem('previousAlerts') || '[]');
  const current  = [...low, ...out].map(i => i._id);
  const newOnes  = current.filter(id => !previous.includes(id));

  if (newOnes.length > 0) {
    const msgs = newOnes.map(id => {
      const item = [...low, ...out].find(i => i._id === id);
      return item ? `${item.name} (${(item.remaining_kg ?? 0) > 0 ? `${item.remaining_kg}kg` : 'OUT'})` : null;
    }).filter(Boolean);
    if (msgs.length) showToast(`⚠️ Stock Alert: ${msgs.join(', ')}`, 'warning');
  }

  sessionStorage.setItem('previousAlerts', JSON.stringify(current));
}

// ======================================================================
// SECTION 16: INTERACTIVE STATS
// ======================================================================

function setupInteractiveStats() {
  const salesCard = document.querySelector('.stat-card .sales-icon')?.parentElement;
  if (salesCard) {
    salesCard.style.cursor = 'pointer';
    salesCard.classList.add('clickable');
    salesCard.addEventListener('click', () => filterRecentSales('today'));
  }
}

function filterRecentSales(filter) {
  document.querySelectorAll('#recentSalesBody tr').forEach(row => {
    const dateCell = row.cells[4]?.textContent;
    if (!dateCell) return;
    try {
      const rowDate = new Date(dateCell).toISOString().split('T')[0];
      const today   = new Date().toISOString().split('T')[0];
      if (filter === 'today' && rowDate === today) {
        row.classList.add('updated');
        setTimeout(() => row.classList.remove('updated'), 2000);
      }
    } catch (_) {}
  });
  showToast(`Showing ${filter} sales`, 'info');
}

// ======================================================================
// SECTION 17: TOAST
// ======================================================================

function showToast(message, type = 'success') {
  const colors = { success: '#10b981', error: '#ef4444', warning: '#f59e0b', info: '#3b82f6' };
  Toastify({
    text: message, duration: 3500, close: true,
    gravity: 'top', position: 'center',
    style: { background: colors[type] || colors.success }
  }).showToast();
}

// ======================================================================
// SECTION 18: LOGOUT
// ======================================================================

function showLogoutConfirm(e) {
  e.preventDefault();
  document.body.insertAdjacentHTML('beforeend', `
    <div class="custom-confirm" id="logoutConfirm">
      <div class="confirm-dialog">
        <i class="bi bi-box-arrow-right"></i>
        <h3>Logout from Karibu Groceries?</h3>
        <p>Are you sure you want to logout?</p>
        <div class="confirm-actions">
          <button class="confirm-btn no"  onclick="hideLogoutConfirm()">No, Stay</button>
          <button class="confirm-btn yes" onclick="confirmLogout()">Yes, Logout</button>
        </div>
      </div>
    </div>
  `);
}

window.hideLogoutConfirm = () => { const el = document.getElementById('logoutConfirm'); if (el) el.remove(); };

window.confirmLogout = () => {
  stopStockPolling();
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  showToast('Logged out successfully', 'success');
  setTimeout(() => window.location.href = '../../index.html', 1500);
};

// ======================================================================
// SECTION 19: DEV TOOL — RESTOCK SIMULATOR
// ======================================================================

/**
 * For testing only — simulate the manager adding stock without the backend.
 * Call from browser console: simulateRestock('produceId', 5000)
 */
window.simulateRestock = (produceId, additionalKg) => {
  const idx = availableStock.findIndex(i => i._id === produceId);
  if (idx === -1) { console.warn('[RESTOCK] Item not found:', produceId); return; }
  const before = availableStock[idx].remaining_kg;
  availableStock[idx].remaining_kg = before + additionalKg;
  displayStockTable([...availableStock]);
  populateProduceDropdowns(availableStock);
  updateAvailableStockStat();
  checkLowStockAndNotify();
  setTimeout(() => highlightUpdatedStock(produceId), 100);
  showToast(`✅ Restocked: +${additionalKg.toLocaleString()}kg of ${availableStock[idx].name}`, 'success');
};
// ======================================================================
// SECTION 20: PRINT RECEIPT — CASH SALE
// ======================================================================

/**
 * Shows a small in-page prompt offering to print the receipt.
 * Agent can dismiss with one click — no friction if they don't need it.
 * Printing opens a styled window using window.open — no dependencies.
 */
function showSaleReceiptPrompt(data) {
  const existing = document.getElementById('receiptPrompt');
  if (existing) existing.remove();

  document.body.insertAdjacentHTML('beforeend', `
    <div id="receiptPrompt" style="
      position:fixed; bottom:24px; right:24px; z-index:9999;
      background:white; border-radius:12px; padding:16px 20px;
      box-shadow:0 8px 30px rgba(0,0,0,0.15); max-width:300px;
      border-left:4px solid #10b981; animation:slideIn 0.3s ease;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
        <strong style="color:#065f46;font-size:0.95rem;">
          <i class="bi bi-printer"></i> Print Receipt?
        </strong>
        <button onclick="document.getElementById('receiptPrompt')?.remove()"
          style="background:none;border:none;font-size:1.2rem;cursor:pointer;color:#6b7280;line-height:1;">
          &times;
        </button>
      </div>
      <p style="font-size:0.82rem;color:#4b5563;margin-bottom:12px;">
        ${data.tonnage.toLocaleString()} kg of <strong>${escHtml(data.produce)}</strong>
        sold to <strong>${escHtml(data.buyer)}</strong>
      </p>
      <div style="display:flex;gap:8px;">
        <button onclick="document.getElementById('receiptPrompt')?.remove()"
          style="flex:1;padding:7px;background:#f1f5f9;border:none;border-radius:6px;
                 font-size:0.82rem;cursor:pointer;">
          Skip
        </button>
        <button onclick="printSaleReceipt(${JSON.stringify(data).replace(/"/g,'&quot;')}); document.getElementById('receiptPrompt')?.remove();"
          style="flex:1;padding:7px;background:#10b981;color:white;border:none;border-radius:6px;
                 font-size:0.82rem;font-weight:600;cursor:pointer;">
          <i class="bi bi-printer-fill"></i> Print
        </button>
      </div>
    </div>
  `);

  // Auto-dismiss after 10 seconds
  setTimeout(() => document.getElementById('receiptPrompt')?.remove(), 10000);
}

/**
 * Opens a print-ready receipt in a new window.
 * Self-contained HTML — no external dependencies.
 * Matches Karibu Groceries branding colours.
 */
function printSaleReceipt(data) {
  const win = window.open('', '_blank', 'width=420,height=600');
  win.document.write(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>Sale Receipt — ${escHtml(data.ref)}</title>
      <style>
        * { margin:0; padding:0; box-sizing:border-box; }
        body { font-family:'Segoe UI',sans-serif; padding:24px; color:#1a1a1a; font-size:13px; }
        .header { text-align:center; margin-bottom:20px; padding-bottom:16px; border-bottom:2px solid #1a2744; }
        .header h1 { font-size:1.3rem; color:#1a2744; font-weight:700; }
        .header p { color:#6b7280; font-size:0.82rem; margin-top:4px; }
        .badge { display:inline-block; background:#d1fae5; color:#065f46; padding:3px 10px;
                 border-radius:20px; font-size:0.75rem; font-weight:600; margin-top:6px; }
        .section { margin-bottom:16px; }
        .row { display:flex; justify-content:space-between; padding:6px 0;
               border-bottom:1px solid #f0f0f0; }
        .row:last-child { border-bottom:none; }
        .label { color:#6b7280; font-size:0.82rem; }
        .value { font-weight:600; color:#1a1a1a; text-align:right; }
        .total-row { background:#f0fdf4; padding:10px 12px; border-radius:8px;
                     display:flex; justify-content:space-between; margin:16px 0; }
        .total-label { font-weight:700; color:#065f46; }
        .total-value { font-weight:800; font-size:1.1rem; color:#065f46; }
        .footer { text-align:center; margin-top:20px; padding-top:16px;
                  border-top:1px dashed #d1d5db; color:#9ca3af; font-size:0.75rem; }
        .ref { font-size:0.7rem; color:#9ca3af; letter-spacing:0.5px; }
        @media print { body { padding:10px; } }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>Karibu Groceries LTD</h1>
        <p>${escHtml(data.branch)} Branch</p>
        <span class="badge">✅ CASH SALE</span>
      </div>

      <div class="section">
        <div class="row">
          <span class="label">Produce</span>
          <span class="value">${escHtml(data.produce)}</span>
        </div>
        <div class="row">
          <span class="label">Tonnage</span>
          <span class="value">${data.tonnage.toLocaleString()} kg</span>
        </div>
        <div class="row">
          <span class="label">Buyer</span>
          <span class="value">${escHtml(data.buyer)}</span>
        </div>
        <div class="row">
          <span class="label">Sales Agent</span>
          <span class="value">${escHtml(data.agent)}</span>
        </div>
        <div class="row">
          <span class="label">Date & Time</span>
          <span class="value">${escHtml(data.date)}</span>
        </div>
      </div>

      <div class="total-row">
        <span class="total-label">Amount Paid</span>
        <span class="total-value">Ush ${data.amount.toLocaleString()}</span>
      </div>

      <div class="footer">
        <p>Thank you for trading with Karibu Groceries LTD</p>
        <p class="ref">Ref: ${escHtml(data.ref)}</p>
      </div>

      <script>window.onload = () => { window.print(); }<\/script>
    </body>
    </html>
  `);
  win.document.close();
}

// ======================================================================
// SECTION 21: PRINT DISPATCH NOTE — CREDIT SALE
// ======================================================================

/**
 * Shows a prompt to print the credit dispatch note after recording a credit.
 * This is the physical document the buyer receives as proof of dispatch.
 */
function showCreditDispatchPrompt(data) {
  const existing = document.getElementById('dispatchPrompt');
  if (existing) existing.remove();

  document.body.insertAdjacentHTML('beforeend', `
    <div id="dispatchPrompt" style="
      position:fixed; bottom:24px; right:24px; z-index:9999;
      background:white; border-radius:12px; padding:16px 20px;
      box-shadow:0 8px 30px rgba(0,0,0,0.15); max-width:300px;
      border-left:4px solid #7c3aed;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
        <strong style="color:#5b21b6;font-size:0.95rem;">
          <i class="bi bi-file-earmark-text"></i> Print Dispatch Note?
        </strong>
        <button onclick="document.getElementById('dispatchPrompt')?.remove()"
          style="background:none;border:none;font-size:1.2rem;cursor:pointer;color:#6b7280;line-height:1;">
          &times;
        </button>
      </div>
      <p style="font-size:0.82rem;color:#4b5563;margin-bottom:12px;">
        Credit for <strong>${escHtml(data.buyer)}</strong> —
        due <strong>${new Date(data.dueDate).toLocaleDateString()}</strong>
      </p>
      <div style="display:flex;gap:8px;">
        <button onclick="document.getElementById('dispatchPrompt')?.remove()"
          style="flex:1;padding:7px;background:#f1f5f9;border:none;border-radius:6px;
                 font-size:0.82rem;cursor:pointer;">
          Skip
        </button>
        <button onclick="printCreditDispatchNote(${JSON.stringify(data).replace(/"/g,'&quot;')}); document.getElementById('dispatchPrompt')?.remove();"
          style="flex:1;padding:7px;background:#7c3aed;color:white;border:none;border-radius:6px;
                 font-size:0.82rem;font-weight:600;cursor:pointer;">
          <i class="bi bi-printer-fill"></i> Print
        </button>
      </div>
    </div>
  `);

  setTimeout(() => document.getElementById('dispatchPrompt')?.remove(), 10000);
}

/**
 * Opens the credit dispatch note for printing.
 * Includes all buyer details, NIN, due date — legal proof of dispatch.
 */
function printCreditDispatchNote(data) {
  const win = window.open('', '_blank', 'width=420,height=700');
  win.document.write(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>Dispatch Note — ${escHtml(data.ref)}</title>
      <style>
        * { margin:0; padding:0; box-sizing:border-box; }
        body { font-family:'Segoe UI',sans-serif; padding:24px; color:#1a1a1a; font-size:13px; }
        .header { text-align:center; margin-bottom:20px; padding-bottom:16px; border-bottom:2px solid #1a2744; }
        .header h1 { font-size:1.3rem; color:#1a2744; font-weight:700; }
        .header p { color:#6b7280; font-size:0.82rem; margin-top:4px; }
        .badge { display:inline-block; background:#ede9fe; color:#5b21b6; padding:3px 10px;
                 border-radius:20px; font-size:0.75rem; font-weight:600; margin-top:6px; }
        h3 { font-size:0.8rem; text-transform:uppercase; color:#6b7280; letter-spacing:0.8px;
             margin:14px 0 6px; padding-bottom:4px; border-bottom:1px solid #e5e7eb; }
        .row { display:flex; justify-content:space-between; padding:5px 0; }
        .label { color:#6b7280; font-size:0.82rem; }
        .value { font-weight:600; color:#1a1a1a; text-align:right; max-width:55%; }
        .amount-box { background:#faf5ff; border:1px solid #e9d5ff; border-radius:8px;
                      padding:12px 14px; margin:14px 0; }
        .amount-box .due { font-size:1.15rem; font-weight:800; color:#5b21b6; }
        .amount-box .date { font-size:0.8rem; color:#7c3aed; margin-top:4px; }
        .sign-section { margin-top:20px; display:flex; gap:20px; }
        .sign-box { flex:1; text-align:center; }
        .sign-line { border-top:1px solid #374151; margin-bottom:4px; }
        .sign-label { font-size:0.72rem; color:#6b7280; }
        .footer { text-align:center; margin-top:20px; padding-top:16px;
                  border-top:1px dashed #d1d5db; color:#9ca3af; font-size:0.72rem; }
        .ref { font-size:0.68rem; color:#9ca3af; letter-spacing:0.5px; margin-top:4px; }
        @media print { body { padding:10px; } }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>Karibu Groceries LTD</h1>
        <p>${escHtml(data.branch)} Branch — Credit Dispatch Note</p>
        <span class="badge">📋 CREDIT SALE</span>
      </div>

      <h3>Goods Dispatched</h3>
      <div class="row"><span class="label">Produce</span><span class="value">${escHtml(data.produce)} (${escHtml(data.type)})</span></div>
      <div class="row"><span class="label">Tonnage</span><span class="value">${data.tonnage.toLocaleString()} kg</span></div>
      <div class="row"><span class="label">Dispatch Date</span><span class="value">${escHtml(data.dispatch)}</span></div>

      <h3>Buyer Details</h3>
      <div class="row"><span class="label">Full Name</span><span class="value">${escHtml(data.buyer)}</span></div>
      <div class="row"><span class="label">National ID (NIN)</span><span class="value">${escHtml(data.nationalId)}</span></div>
      <div class="row"><span class="label">Location</span><span class="value">${escHtml(data.location)}</span></div>
      <div class="row"><span class="label">Phone</span><span class="value">${escHtml(data.contact)}</span></div>

      <div class="amount-box">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div>
            <div style="font-size:0.75rem;color:#7c3aed;font-weight:600;text-transform:uppercase;">Amount Due</div>
            <div class="due">Ush ${data.amountDue.toLocaleString()}</div>
          </div>
          <div style="text-align:right;">
            <div style="font-size:0.75rem;color:#7c3aed;font-weight:600;text-transform:uppercase;">Payment Due By</div>
            <div class="date">${new Date(data.dueDate).toLocaleDateString('en-UG', {day:'numeric',month:'long',year:'numeric'})}</div>
          </div>
        </div>
      </div>

      <h3>Recorded By</h3>
      <div class="row"><span class="label">Sales Agent</span><span class="value">${escHtml(data.agent)}</span></div>

      <div class="sign-section">
        <div class="sign-box">
          <div class="sign-line" style="margin-top:30px;"></div>
          <div class="sign-label">Agent Signature</div>
        </div>
        <div class="sign-box">
          <div class="sign-line" style="margin-top:30px;"></div>
          <div class="sign-label">Buyer Signature</div>
        </div>
      </div>

      <div class="footer">
        <p>This note is proof of goods received on credit from Karibu Groceries LTD</p>
        <p class="ref">Ref: ${escHtml(data.ref)}</p>
      </div>

      <script>window.onload = () => { window.print(); }<\/script>
    </body>
    </html>
  `);
  win.document.close();
}

// ======================================================================
// SECTION 22: EXPORT RECENT SALES AS CSV
// ======================================================================

/**
 * Exports today's sales from allSales[] as a downloadable CSV file.
 * No server call needed — works from the already-loaded allSales array.
 * Agent can open it in Excel to share with the manager or keep records.
 *
 * Called by the "Export CSV" button in the Recent Sales table header.
 */
window.exportSalesCSV = () => {
  const today = new Date().toISOString().split('T')[0];

  // Filter to today's sales only (or all sales if none today)
  let rows = allSales.filter(s =>
    s.date ? new Date(s.date).toISOString().split('T')[0] === today : false
  );

  // Fall back to all sales if nothing today (e.g. testing on old data)
  if (rows.length === 0) rows = allSales;

  if (rows.length === 0) {
    showToast('No sales data to export', 'warning');
    return;
  }

  // Build CSV content
  const headers = ['Date', 'Time', 'Produce', 'Tonnage (kg)', 'Amount (UGX)', 'Buyer', 'Agent', 'Branch'];
  const csvRows = rows.map(s => [
    s.date ? new Date(s.date).toLocaleDateString() : '',
    s.time || '',
    `"${s.produce_name || ''}"`,
    s.tonnage_kg || 0,
    s.amount_paid_ugx || 0,
    `"${s.buyer_name || ''}"`,
    `"${s.sales_agent || s.sales_agent_name || ''}"`,
    `"${s.branch || ''}"`
  ]);

  // Add summary row
  const totalTonnage = rows.reduce((sum, s) => sum + (s.tonnage_kg || 0), 0);
  const totalAmount  = rows.reduce((sum, s) => sum + (s.amount_paid_ugx || 0), 0);
  csvRows.push([]);
  csvRows.push(['TOTAL', '', '', totalTonnage, totalAmount, '', '', '']);

  const csvContent = [
    `Karibu Groceries LTD — ${user?.branch || ''} Branch — Sales Report`,
    `Generated: ${new Date().toLocaleString()}`,
    '',
    headers.join(','),
    ...csvRows.map(r => r.join(','))
  ].join('\n');

  // Trigger download
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `karibu-sales-${today}-${user?.branch || 'branch'}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  showToast(`✅ Exported ${rows.length} sale${rows.length !== 1 ? 's' : ''} to CSV`, 'success');
};
