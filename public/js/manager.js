/*
 * Manager dashboard script:
 * - Handles stock, procurement, sales, and credit operations for one branch.
 * - Computes branch dashboard statistics and alert badges.
 * - Syncs data with scheduled polling for near-real-time updates.
 */

// ======================================================================
// SECTION 1: GLOBAL VARIABLES & CONSTANTS
// ======================================================================
// These variables hold the application state and configuration.
// They are accessible throughout the entire file.

let user = null;                // Logged-in user object from localStorage
let availableStock = [];        // Live stock from /api/procurement/available
let allSales = [];              // All cash sales for this branch
let allCredits = [];            // All credit sales for this branch
let stockPollInterval = null;   // Reference for background polling

// API_BASE is declared in common.js (loaded before this file)
// Do NOT redeclare — use the global from common.js

// Produce types for dropdown menus (used in procurement form)
if (typeof PRODUCE_TYPES === 'undefined') {
  var PRODUCE_TYPES = [
    'Grain', 'Legume', 'Herbs', 'Vegetable', 'Fruits',
    'Oilseeds', 'Spices', 'Nuts', 'Tubers', 'Other'
  ];
}

// Low stock threshold — items at or below this show warning (yellow)
if (typeof LOW_STOCK_THRESHOLD === 'undefined') { 
  var LOW_STOCK_THRESHOLD = 1000; 
}

// Background poll interval: 60 seconds (matches sales agent)
if (typeof STOCK_POLL_INTERVAL_MS === 'undefined') { 
  var STOCK_POLL_INTERVAL_MS = 60000; 
}

// ======================================================================
// SECTION 2: INITIALIZATION
// ======================================================================
// Runs when DOM is ready. Sets up the entire dashboard:
// - Authenticates user
// - Populates sidebar with user info
// - Sets up all event listeners
// - Loads initial data
// - Starts background polling

document.addEventListener('DOMContentLoaded', async () => {
  console.log('[MANAGER] Dashboard initializing...');

  // --------------------------------------------------------------------
  // 2.1 Authentication Check
  // --------------------------------------------------------------------
  user = JSON.parse(localStorage.getItem('user'));
  if (!user || user.role !== 'manager') {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.href = '../../index.html';
    return;
  }

  // --------------------------------------------------------------------
  // 2.2 Sidebar: Fill User Info
  // --------------------------------------------------------------------
  document.body.classList.add('dashboard');
  const nameEl   = document.getElementById('userName');
  const roleEl   = document.getElementById('userRole');
  const branchEl = document.getElementById('userBranch');
  
  if (nameEl)   nameEl.textContent   = user.full_name || 'User';
  if (roleEl)   roleEl.textContent   = 'manager';
  if (branchEl) branchEl.textContent = user.branch || '-';
  const saleAgentEl = document.getElementById('saleAgent');
  if (saleAgentEl) saleAgentEl.value = user.full_name || 'Manager';
  const creditAgentEl = document.getElementById('creditAgent');
  if (creditAgentEl) creditAgentEl.value = user.full_name || 'Manager';

  // --------------------------------------------------------------------
  // 2.3 Set Current Date/Time in Forms
  // --------------------------------------------------------------------
  setCurrentDateTime();
  
  // --------------------------------------------------------------------
  // 2.4 Populate Type Dropdowns
  // --------------------------------------------------------------------
  populateTypeDropdowns();
  
  // --------------------------------------------------------------------
  // 2.5 Setup Navigation
  // --------------------------------------------------------------------
  setupNavigation();
  
  // --------------------------------------------------------------------
  // 2.6 Setup Search Functionality
  // --------------------------------------------------------------------
  setupSearch();
  
  // --------------------------------------------------------------------
  // 2.7 Setup Procurement Form
  // --------------------------------------------------------------------
  setupProcurementForm();
  setupSaleForm();
  setupSalePriceCalculators();
  setupCreditForm();
  setupCreditPriceCalculators();
  setupNinAutoUppercase();
  
  // --------------------------------------------------------------------
  // 2.8 Setup Notification Bell
  // --------------------------------------------------------------------
  setupNotificationBell();

  // --------------------------------------------------------------------
  // 2.9 Logout Button
  // --------------------------------------------------------------------
  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) logoutBtn.addEventListener('click', showLogoutConfirm);

  // --------------------------------------------------------------------
  // 2.10 Load All Initial Data
  // --------------------------------------------------------------------
  await loadAvailableStock();
  await loadBranchSales();
  await loadCreditSales();
  await loadDashboardStats();

  // --------------------------------------------------------------------
  // 2.11 Start Background Polling
  // --------------------------------------------------------------------
  startStockPolling();

  // --------------------------------------------------------------------
  // 2.12 Show Default Section (Dashboard)
  // --------------------------------------------------------------------
  showSection('dashboard');
  console.log('[MANAGER] Dashboard ready.');
});

// ======================================================================
// SECTION 3: HELPER FUNCTIONS
// ======================================================================
// Utility functions used throughout the dashboard.

/**
 * Sets today's date and current time in disabled form fields.
 * Used for procurement form timestamps.
 */
function setCurrentDateTime() {
  const now = new Date();
  const date = now.toISOString().split('T')[0];
  const time = now.toTimeString().slice(0, 5);
  
  const dateInputs = ['procurementDate', 'saleDate', 'creditDispatchDate'];
  const timeInputs = ['procurementTime', 'saleTime'];
  
  dateInputs.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = date;
  });
  
  timeInputs.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = time;
  });
}

/**
 * Populates produce type dropdowns from PRODUCE_TYPES constant.
 * Used in procurement form.
 */
function populateTypeDropdowns() {
  const dropdowns = ['procurementType', 'saleType', 'creditType'];
  dropdowns.forEach(id => {
    const select = document.getElementById(id);
    if (!select) return;
    select.innerHTML = '<option value="">Select Type</option>' +
      PRODUCE_TYPES.map(t => `<option value="${t}">${t}</option>`).join('');
  });
}

/**
 * Retrieves JWT token from localStorage for API authorization.
 * @returns {string|null} The token or null if not found
 */
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
 * Safely sets textContent of an element by ID.
 * @param {string} id - Element ID
 * @param {string} value - Text to set
 */
function safeSet(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

// ======================================================================
// SECTION 4: NAVIGATION
// ======================================================================
// Handles sidebar navigation and section visibility.

/**
 * Sets up click handlers for sidebar navigation links.
 */
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
 * Shows the selected section and hides others.
 * @param {string} sectionId - 'dashboard', 'procurement', or 'credits'
 */
function showSection(sectionId) {
  document.querySelectorAll('.content-section').forEach(s => s.style.display = 'none');
  const section = document.getElementById(`${sectionId}Section`);
  if (section) section.style.display = 'block';
}

// ======================================================================
// SECTION 5: GLOBAL SEARCH
// ======================================================================
// Searches across all tables (stock, credits, sales) in real-time.

/**
 * Sets up search input listener.
 */
function setupSearch() {
  const searchInput = document.getElementById('dashboardSearch');
  if (!searchInput) return;
  
  searchInput.addEventListener('input', e => {
    const query = e.target.value.toLowerCase().trim();
    performSearch(query);
  });
}

/**
 * Filters all tables based on search query.
 * @param {string} query - Lowercase search term
 */
function performSearch(query) {
  if (!query) {
    // Reset all tables
    displayStockTable(availableStock);
    renderCreditsTable(allCredits);
    renderSalesTable(allSales);
    return;
  }

  // Filter stock table
  const filteredStock = availableStock.filter(item =>
    (item.name || '').toLowerCase().includes(query) ||
    (item.type || '').toLowerCase().includes(query)
  );
  displayStockTable(filteredStock);

  // Filter credits table
  const filteredCredits = allCredits.filter(c =>
    (c.produce_name || '').toLowerCase().includes(query) ||
    (c.buyer_name || '').toLowerCase().includes(query) ||
    (c.national_id || '').toLowerCase().includes(query)
  );
  renderCreditsTable(filteredCredits);

  // Filter sales table
  const filteredSales = allSales.filter(s =>
    (s.produce_name || '').toLowerCase().includes(query) ||
    (s.buyer_name || '').toLowerCase().includes(query) ||
    (s.sales_agent || '').toLowerCase().includes(query)
  );
  renderSalesTable(filteredSales);
}

// ======================================================================
// SECTION 6: DATA LOADERS
// ======================================================================
// Functions that fetch data from the API.

/**
 * Loads available stock for the manager's branch.
 * @param {boolean} silent - If true, skips loading spinner (used by polling)
 */
async function loadAvailableStock(silent = false) {
  try {
    const res = await apiFetch(`${API_BASE}/procurement/available?branch=${user.branch}`);
    if (res.ok) {
      availableStock = await res.json();
      console.log(`[MANAGER] Loaded ${availableStock.length} stock items`);
      displayStockTable(availableStock);
      populateSaleProduceDropdown(availableStock);
      populateCreditProduceDropdown(availableStock);
      checkLowStockAndNotify();
    }
  } catch (err) {
    console.error('[MANAGER] Stock load error:', err);
  }
}

/**
 * Loads all cash sales for this branch.
 */
async function loadBranchSales() {
  try {
    const res = await apiFetch(`${API_BASE}/sales/branch?branch=${user.branch}`);
    if (res.ok) {
      allSales = await res.json();
      console.log(`[MANAGER] Loaded ${allSales.length} sales`);
      renderSalesTable(allSales.slice(0, 10)); // Show last 10
    }
  } catch (err) {
    console.error('[MANAGER] Sales load error:', err);
  }
}

/**
 * Loads all credit sales for this branch.
 */
async function loadCreditSales() {
  try {
    const res = await apiFetch(`${API_BASE}/credits/branch?branch=${user.branch}`);
    if (res.ok) {
      allCredits = await res.json();
      console.log(`[MANAGER] Loaded ${allCredits.length} credits`);
      renderCreditsTable(allCredits);
    }
  } catch (err) {
    console.error('[MANAGER] Credits load error:', err);
  }
}

// ======================================================================
// SECTION 7: DASHBOARD STATS CARDS
// ======================================================================
// Updates all 7 stat cards with current data.

async function loadDashboardStats() {
  const today = new Date(); 
  today.setHours(0, 0, 0, 0);

  // --------------------------------------------------------------------
  // 7.1 Today's Cash Sales
  // --------------------------------------------------------------------
  const todaySales = allSales.filter(s => {
    if (!s.date) return false;
    const saleDate = new Date(s.date); 
    saleDate.setHours(0, 0, 0, 0);
    return saleDate.getTime() === today.getTime();
  });
  const todayTotal = todaySales.reduce((sum, s) => sum + (s.amount_paid_ugx || 0), 0);
  const todayTonnage = todaySales.reduce((sum, s) => sum + (s.tonnage_kg || 0), 0);

  safeSet('todaySalesValue', `Ush ${todayTotal.toLocaleString()}`);
  safeSet('todaySalesCount', `${todaySales.length} ${todaySales.length === 1 ? 'TXN' : 'TXNS'}`);
  safeSet('todayTonnageValue', `${todayTonnage.toLocaleString()} kg`);
  safeSet('todayTonnageCount', `${todaySales.length} ${todaySales.length === 1 ? 'DISPATCH' : 'DISPATCHES'}`);

  // --------------------------------------------------------------------
  // 7.2 Today's Credit Sales
  // --------------------------------------------------------------------
  const todayCredits = allCredits.filter(c => {
    if (!c.date_of_dispatch) return false;
    const creditDate = new Date(c.date_of_dispatch); 
    creditDate.setHours(0, 0, 0, 0);
    return creditDate.getTime() === today.getTime();
  });
  const todayCreditsTotal = todayCredits.reduce((sum, c) => 
    sum + (c.amount_due_ugx || 0), 0);

  safeSet('todayCreditsValue', `Ush ${todayCreditsTotal.toLocaleString()}`);
  safeSet('todayCreditsCount', `${todayCredits.length} ${todayCredits.length === 1 ? 'CREDIT' : 'CREDITS'}`);

  // --------------------------------------------------------------------
  // 7.3 Available Stock
  // --------------------------------------------------------------------
  const totalStock = availableStock.reduce((sum, i) => sum + (i.remaining_kg ?? 0), 0);
  const inStockN = availableStock.filter(i => (i.remaining_kg ?? 0) > 0).length;
  safeSet('availableStockValue', `${totalStock.toLocaleString()} kg`);
  safeSet('availableStockCount', `${inStockN} ${inStockN === 1 ? 'PRODUCT' : 'PRODUCTS'}`);

  // --------------------------------------------------------------------
  // 7.4 Credit Statistics
  // --------------------------------------------------------------------
  const unpaid = allCredits.filter(c => c.status !== 'paid');
  const totalPending = unpaid.reduce((sum, c) => 
    sum + ((c.amount_due_ugx || 0) - (c.amount_paid_ugx || 0)), 0);
  const overdue = unpaid.filter(c => {
    if (!c.due_date) return false;
    const due = new Date(c.due_date); 
    due.setHours(0, 0, 0, 0);
    return due < today;
  }).length;

  safeSet('totalPendingValue', `Ush ${totalPending.toLocaleString()}`);
  safeSet('pendingCountValue', allCredits.length);
  safeSet('overdueValue', overdue);
}

// ======================================================================
// SECTION 8: STOCK TABLE WITH VISUAL INDICATORS
// ======================================================================
// Displays available stock with:
// - Yellow rows (.low-stock-row) for items ≤ 1000kg
// - Red rows (.out-of-stock-row) for items with 0kg
// - Warning badges with ⚠️/❌ icons
// - Restock buttons for each item

/**
 * Renders the stock table with color-coded rows and restock buttons.
 * @param {Array} stock - Array of stock items
 */
function displayStockTable(stock) {
  const tbody = document.getElementById('stockTableBody');
  if (!tbody) return;

  if (stock.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="no-results">No stock items found</td></tr>';
    return;
  }

  console.log('[MANAGER STOCK] Rendering with colors:', 
    stock.map(i => `${i.name}: ${i.remaining_kg}kg`));

  tbody.innerHTML = stock.map(item => {
    const remaining = item.remaining_kg ?? 0;
    const isLow = remaining > 0 && remaining <= LOW_STOCK_THRESHOLD;
    const isOut = remaining <= 0;
    const safeName = escJs(item.name || '');
    const safeType = escJs(item.type || '');

    // Apply CSS classes for row coloring
    let rowClass = '';
    if (isOut) {
      rowClass = 'out-of-stock-row';
    } else if (isLow) {
      rowClass = 'low-stock-row';
    }

    // Status badges using CSS classes
    let statusBadge = '';
    if (isOut) {
      statusBadge = '<span class="stock-danger">❌ Out of Stock</span>';
    } else if (isLow) {
      statusBadge = '<span class="stock-warning">⚠️ Low Stock</span>';
    }

    return `
      <tr class="${rowClass}" data-id="${item._id}" data-stock="${remaining}">
        <td>
          <div class="produce-name">${escHtml(item.name || 'Unknown')}</div>
          <div class="produce-type">${escHtml(item.type || 'N/A')}</div>
          ${statusBadge}
        </td>
        <td class="${isLow ? 'warning-text' : ''} ${isOut ? 'danger-text' : ''}">
          ${remaining.toLocaleString()} kg
        </td>
        <td>Ush ${(item.price_to_sell || 0).toLocaleString()}</td>
        <td>
          <button class="action-btn" onclick="openRestockModal('${escJs(item._id)}','${safeName}','${safeType}',${remaining})">
            <i class="bi bi-box-seam"></i> Restock
          </button>
        </td>
      </tr>`;
  }).join('');

  // Update branch name in title
  const branchEl = document.getElementById('stockBranch');
  if (branchEl && user && user.branch) {
    branchEl.textContent = user.branch;
  }
  
  // Update notifications after rendering
  checkLowStockAndNotify();
}

function populateSaleProduceDropdown(stock) {
  const saleSelect = document.getElementById('saleProduce');
  if (!saleSelect) return;
  const previousValue = saleSelect.value;

  const inStock = (stock || []).filter(i => (i.remaining_kg ?? 0) > 0);
  saleSelect.innerHTML = '<option value="">Select produce</option>' +
    inStock.map(i =>
      `<option value="${escHtml(i._id)}" data-price="${i.price_to_sell || 0}" data-name="${escHtml(i.name)}" data-type="${escHtml(i.type || '')}">
        ${escHtml(i.name)} (${(i.remaining_kg ?? 0).toLocaleString()} kg) - Ush ${(i.price_to_sell || 0).toLocaleString()}/kg
      </option>`
    ).join('');

  if (previousValue && inStock.some(i => String(i._id) === String(previousValue))) {
    saleSelect.value = previousValue;
    saleSelect.dispatchEvent(new Event('change'));
  }
}

function populateCreditProduceDropdown(stock) {
  const creditSelect = document.getElementById('creditProduce');
  if (!creditSelect) return;
  const previousValue = creditSelect.value;

  const inStock = (stock || []).filter(i => (i.remaining_kg ?? 0) > 0);
  creditSelect.innerHTML = '<option value="">Select produce</option>' +
    inStock.map(i =>
      `<option value="${escHtml(i._id)}" data-price="${i.price_to_sell || 0}" data-name="${escHtml(i.name)}" data-type="${escHtml(i.type || '')}">
        ${escHtml(i.name)} (${(i.remaining_kg ?? 0).toLocaleString()} kg available)
      </option>`
    ).join('');

  if (previousValue && inStock.some(i => String(i._id) === String(previousValue))) {
    creditSelect.value = previousValue;
    creditSelect.dispatchEvent(new Event('change'));
  }
}

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
// SECTION 9: RESTOCK MODAL
// ======================================================================
// Modal for adding stock to existing products.
// Requires full audit trail (dealer name, contact, cost).

/**
 * Opens modal for restocking an existing product.
 * @param {string} produceId - MongoDB _id
 * @param {string} produceName - Display name
 * @param {string} produceType - Category/type of the selected product
 * @param {number} currentStock - Current quantity in kg
 */
window.openRestockModal = (produceId, produceName, produceType, currentStock) => {
  const existing = document.getElementById('restockModal');
  if (existing) existing.remove();

  document.body.insertAdjacentHTML('beforeend', `
    <div class="custom-confirm" id="restockModal" style="z-index:10000;">
      <div class="confirm-dialog" style="text-align:left;max-width:480px;">

        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
          <h3 style="color:var(--text-dark);margin:0;font-size:1.1rem;">
            <i class="bi bi-box-seam"></i> Restock Item
          </h3>
          <button onclick="closeRestockModal()"
            style="background:#f1f5f9;border:none;border-radius:50%;width:32px;height:32px;
                   font-size:1.3rem;cursor:pointer;color:#374151;line-height:1;">
            &times;
          </button>
        </div>

        <div style="background:#f8fafc;border-radius:8px;padding:12px 16px;margin-bottom:20px;font-size:0.9rem;">
          <div style="margin-bottom:6px;"><strong>Product:</strong> ${escHtml(produceName)}</div>
          <div style="margin-bottom:6px;"><strong>Type:</strong> ${escHtml(produceType || 'N/A')}</div>
          <div style="color:var(--text-gray);"><strong>Current Stock:</strong> ${currentStock.toLocaleString()} kg</div>
        </div>

        <form id="restockForm" style="display:flex;flex-direction:column;gap:14px;">
          <div class="form-group">
            <label style="display:block;font-weight:600;margin-bottom:6px;font-size:0.9rem;">
              Add Tonnage (kg) <span style="color:#ef4444;">*</span>
            </label>
            <input type="number" id="restockTonnage" required min="1000" step="100"
              placeholder="e.g. 3000"
              style="width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:0.95rem;" />
            <small style="color:#6b7280;font-size:0.75rem;">Minimum: 1,000 kg</small>
          </div>

          <div class="form-group">
            <label style="display:block;font-weight:600;margin-bottom:6px;font-size:0.9rem;">
              Cost This Batch (UGX) <span style="color:#ef4444;">*</span>
            </label>
            <input type="number" id="restockCost" required min="10000" step="1000"
              placeholder="e.g. 2200000"
              style="width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:0.95rem;" />
            <small style="color:#6b7280;font-size:0.75rem;">Total cost for this restock batch</small>
          </div>

          <div class="form-group">
            <label style="display:block;font-weight:600;margin-bottom:6px;font-size:0.9rem;">
              New Sell Price (UGX/kg) <span style="color:#f59e0b;">(Optional but important)</span>
            </label>
            <input type="number" id="restockSellPrice" min="1000" step="100"
              placeholder="Leave blank to keep current sell price"
              style="width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:0.95rem;" />
            <small style="color:#6b7280;font-size:0.75rem;">
              Fill this only when the selling price changes after this restock
            </small>
          </div>

          <div class="form-group">
            <label style="display:block;font-weight:600;margin-bottom:6px;font-size:0.9rem;">
              Dealer Name <span style="color:#ef4444;">*</span>
            </label>
            <input type="text" id="restockDealer" required minlength="2"
              placeholder="e.g. John Supplier"
              style="width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:0.95rem;" />
          </div>

          <div class="form-group">
            <label style="display:block;font-weight:600;margin-bottom:6px;font-size:0.9rem;">
              Dealer Contact <span style="color:#ef4444;">*</span>
            </label>
            <input type="tel" id="restockContact" required pattern="0[1-9]\\d{8}"
              placeholder="0771234567"
              style="width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:0.95rem;" />
            <small style="color:#6b7280;font-size:0.75rem;">Format: 07XXXXXXXX or 03XXXXXXXX</small>
          </div>

          <input type="hidden" id="restockProduceId" value="${produceId}" />

          <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:10px;">
            <button type="button" onclick="closeRestockModal()"
              style="padding:9px 20px;background:#e2e8f0;border:none;border-radius:8px;cursor:pointer;font-weight:500;">
              Cancel
            </button>
            <button type="submit"
              style="padding:9px 20px;background:var(--purple-bright);color:white;border:none;border-radius:8px;cursor:pointer;font-weight:600;">
              <i class="bi bi-check-lg"></i> Confirm Restock
            </button>
          </div>
        </form>

      </div>
    </div>
  `);

  document.getElementById('restockForm').addEventListener('submit', submitRestock);
};

/**
 * Closes the restock modal.
 */
window.closeRestockModal = () => {
  const m = document.getElementById('restockModal');
  if (m) m.remove();
};

/**
 * Submits restock data to the API.
 * @param {Event} e - Form submit event
 */
async function submitRestock(e) {
  e.preventDefault();

  const produceId = document.getElementById('restockProduceId').value;
  const tonnage = Number(document.getElementById('restockTonnage').value);
  const cost = Number(document.getElementById('restockCost').value);
  const sellPriceRaw = document.getElementById('restockSellPrice').value.trim();
  const dealer = document.getElementById('restockDealer').value.trim();
  const contact = document.getElementById('restockContact').value.trim();
  const sellPrice = sellPriceRaw === '' ? null : Number(sellPriceRaw);

  // Validation
  if (!tonnage || tonnage < 1000) {
    showToast('Tonnage must be at least 1,000 kg', 'error');
    return;
  }
  if (!cost || cost < 10000) {
    showToast('Cost must be at least 10,000 UGX', 'error');
    return;
  }
  if (!dealer || dealer.length < 2) {
    showToast('Dealer name must be at least 2 characters', 'error');
    return;
  }
  if (!/^0[1-9]\d{8}$/.test(contact)) {
    showToast('Invalid phone format (10 digits starting with 0)', 'error');
    return;
  }
  if (sellPrice !== null && (!Number.isInteger(sellPrice) || sellPrice < 1000)) {
    showToast('New sell price must be at least 1,000 UGX/kg', 'error');
    return;
  }

  const payload = {
    tonnage_kg: tonnage,
    cost_ugx: cost,
    dealer_name: dealer,
    dealer_contact: contact,
    recorded_by: user.full_name
  };
  if (sellPrice !== null) {
    payload.price_to_sell = sellPrice;
  }

  try {
    const res = await apiFetch(`${API_BASE}/procurement/${produceId}/restock`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...(getToken() ? { 'Authorization': `Bearer ${getToken()}` } : {})
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const err = await res.json();
      showToast(`Error: ${err.error || 'Restock failed'}`, 'error');
      return;
    }

    const updated = await res.json();
    closeRestockModal();

    const newRemaining = updated?.data?.remaining_kg;
    if (typeof newRemaining === 'number') {
      showToast(`✅ Restocked: +${tonnage.toLocaleString()}kg. New stock: ${newRemaining.toLocaleString()}kg`, 'success');
    } else {
      showToast(`✅ Restocked: +${tonnage.toLocaleString()}kg`, 'success');
    }

    // Reload data
    await loadAvailableStock();
    await loadDashboardStats();

  } catch (err) {
    console.error('[RESTOCK]', err);
    showToast('Network error. Restock not saved.', 'error');
  }
}

// ======================================================================
// SECTION 10: CREDITS TABLE
// ======================================================================
// Displays credit sales with status badges and payment buttons.

/**
 * Renders the credits table with status badges.
 * @param {Array} credits - Array of credit sale objects
 */
function renderCreditsTable(credits) {
  const tbody = document.getElementById('creditsTableBody');
  const tbodyFull = document.getElementById('creditsTableBodyFull');
  
  if (!tbody && !tbodyFull) return;

  const recent = credits.slice(0, 20);
  const today = new Date(); 
  today.setHours(0, 0, 0, 0);

  if (recent.length === 0) {
    const emptyRow = '<tr><td colspan="6" class="no-results">No credit sales recorded</td></tr>';
    if (tbody) tbody.innerHTML = emptyRow;
    if (tbodyFull) tbodyFull.innerHTML = emptyRow;
    return;
  }

  const html = recent.map(c => {
    const due = new Date(c.due_date); 
    due.setHours(0, 0, 0, 0);
    const isOverdue = c.status !== 'paid' && due < today;
    const wasPaidLate = c.status === 'paid' && due < today;

    // Determine display status for badge color
    const displayStatus = wasPaidLate ? 'paid_late'
                        : c.status === 'paid' ? 'paid'
                        : isOverdue ? 'overdue'
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
  
  // Populate both tables (dashboard section + manage credits page)
  if (tbody) tbody.innerHTML = html;
  if (tbodyFull) tbodyFull.innerHTML = html;
}

// ======================================================================
// SECTION 11: PAYMENT MODAL
// ======================================================================
// Modal for recording payments against credit sales.

/**
 * Opens modal for recording a payment.
 * @param {string} creditId - MongoDB _id
 * @param {string} buyerName - Buyer's name
 * @param {number} amountDue - Total amount owed
 * @param {number} amountPaid - Amount already paid
 */
window.openPaymentModal = (creditId, buyerName, amountDue, amountPaid) => {
  const existing = document.getElementById('paymentModal');
  if (existing) existing.remove();

  const balance = Math.max(0, amountDue - amountPaid);

  document.body.insertAdjacentHTML('beforeend', `
    <div class="custom-confirm" id="paymentModal" style="z-index:10000;">
      <div class="confirm-dialog" style="text-align:left;max-width:440px;">

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

        <div style="background:#f8fafc;border-radius:8px;padding:12px 16px;margin-bottom:20px;font-size:0.9rem;">
          <div style="margin-bottom:6px;"><strong>Buyer:</strong> ${buyerName}</div>
          <div style="margin-bottom:6px;"><strong>Total owed:</strong> Ush ${amountDue.toLocaleString()}</div>
          <div style="margin-bottom:6px;"><strong>Already paid:</strong> Ush ${amountPaid.toLocaleString()}</div>
          <div style="color:#dc2626;font-weight:700;"><strong>Balance due:</strong> Ush ${balance.toLocaleString()}</div>
        </div>

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

        <div class="form-group" style="margin-bottom:20px;">
          <label style="display:block;font-weight:600;margin-bottom:6px;font-size:0.9rem;">
            Payment Note (Optional)
          </label>
          <input type="text" id="paymentNote"
            placeholder="e.g. Cash, MTN Mobile Money"
            style="width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:0.95rem;"
          />
        </div>

        <div style="display:flex;gap:10px;justify-content:flex-end;">
          <button onclick="closePaymentModal()"
            style="padding:9px 20px;background:#e2e8f0;border:none;border-radius:8px;cursor:pointer;font-weight:500;">
            Cancel
          </button>
          <button onclick="submitPayment('${creditId}')"
            style="padding:9px 20px;background:var(--purple-bright);color:white;border:none;border-radius:8px;cursor:pointer;font-weight:600;">
            <i class="bi bi-check-lg"></i> Confirm Payment
          </button>
        </div>

      </div>
    </div>
  `);
};

/**
 * Closes payment modal.
 */
window.closePaymentModal = () => {
  const m = document.getElementById('paymentModal');
  if (m) m.remove();
};

/**
 * Submits payment to API.
 * @param {string} creditId - MongoDB _id
 */
window.submitPayment = async (creditId) => {
  const amountEl = document.getElementById('paymentAmount');
  const noteEl = document.getElementById('paymentNote');

  const amount = Number(amountEl?.value);
  if (!amount || amount < 1000) {
    showToast('Amount must be at least 1,000 UGX', 'error');
    return;
  }

  const payload = {
    amount_ugx: amount,
    recorded_by: user.full_name,
    note: noteEl?.value?.trim() || ''
  };

  try {
    const res = await apiFetch(`${API_BASE}/credits/${creditId}/pay`, {
      method: 'PATCH',
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

    const today = new Date(); 
    today.setHours(0, 0, 0, 0);
    const due = new Date(updated.due_date); 
    due.setHours(0, 0, 0, 0);
    const displayStatus = updated.status === 'paid' ? 'paid'
                        : (due < today ? 'overdue' : updated.status);

    const statusMsg = {
      paid: '✅ Fully paid — credit settled!',
      partial: '🔶 Partial payment recorded',
      overdue: '🔴 Payment recorded (overdue)',
      pending: '✅ Payment recorded'
    };

    showToast(statusMsg[displayStatus] || '✅ Payment recorded', 'success');

    await loadCreditSales();
    await loadDashboardStats();

  } catch (err) {
    console.error('[PAYMENT]', err);
    showToast('Network error. Payment not saved.', 'error');
  }
};

// ======================================================================
// SECTION 12: SALES TABLE
// ======================================================================
// Displays recent cash sales.

/**
 * Renders the sales table.
 * @param {Array} sales - Array of sale objects
 */
function renderSalesTable(sales) {
  const tbody = document.getElementById('salesTableBody');
  if (!tbody) return;

  if (sales.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="no-results">No sales recorded</td></tr>';
    return;
  }

  tbody.innerHTML = sales.map(s => `
    <tr>
      <td>${escHtml(s.produce_name || 'N/A')}</td>
      <td>${(s.tonnage_kg || 0).toLocaleString()} kg</td>
      <td>Ush ${(s.amount_paid_ugx || 0).toLocaleString()}</td>
      <td>${escHtml(s.buyer_name || 'N/A')}</td>
      <td>${formatSaleDateTime(s)}</td>
    </tr>`).join('');
}

function formatSaleDateTime(sale) {
  if (!sale?.date) return sale?.time || 'N/A';

  const datePart = new Date(sale.date).toLocaleDateString();
  let timePart = '';

  if (sale.time) {
    const raw = String(sale.time).trim();
    if (/am|pm/i.test(raw)) {
      timePart = raw.toUpperCase();
    } else if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(raw)) {
      const pieces = raw.split(':');
      const hh = Number(pieces[0]);
      const mm = pieces[1] || '00';
      if (!Number.isNaN(hh)) {
        const suffix = hh >= 12 ? 'PM' : 'AM';
        const h12 = (hh % 12) || 12;
        timePart = `${h12}:${mm} ${suffix}`;
      } else {
        timePart = raw;
      }
    } else {
      timePart = raw;
    }
  } else {
    timePart = new Date(sale.date).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
  }

  return `${datePart} ${timePart}`.trim();
}

// ======================================================================
// SECTION 13: PROCUREMENT FORM
// ======================================================================
// Handles new product procurement with duplicate detection.

/**
 * Sets up procurement form with duplicate name detection.
 */
function setupProcurementForm() {
  const form = document.getElementById('procurementForm');
  if (!form) return;

  // Duplicate name detection on blur
  const nameInput = document.getElementById('procurementName');
  if (nameInput) {
    nameInput.addEventListener('blur', () => {
      const name = nameInput.value.trim();
      if (!name) return;

      const exists = availableStock.find(i => 
        i.name.toLowerCase() === name.toLowerCase()
      );

      if (exists) {
        showToast(`⚠️ "${name}" already exists. Use Restock instead.`, 'warning');
        nameInput.style.borderColor = '#f59e0b';
      } else {
        nameInput.style.borderColor = '#d1d5db';
      }
    });
  }

  form.addEventListener('submit', submitProcurement);
}

/**
 * Submits new procurement to API.
 * @param {Event} e - Form submit event
 */
async function submitProcurement(e) {
  e.preventDefault();

  const name = document.getElementById('procurementName')?.value.trim();
  const type = document.getElementById('procurementType')?.value;
  const tonnage = Number(document.getElementById('procurementTonnage')?.value);
  const cost = Number(document.getElementById('procurementCost')?.value);
  const priceToSell = Number(document.getElementById('procurementPrice')?.value);
  const dealer = document.getElementById('procurementDealer')?.value.trim();
  const contact = document.getElementById('procurementContact')?.value.trim();

  // Validation
  if (!name || name.length < 2) {
    showToast('Product name must be at least 2 characters', 'error');
    return;
  }
  if (!type) {
    showToast('Please select a product type', 'error');
    return;
  }
  if (!tonnage || tonnage < 1000) {
    showToast('Tonnage must be at least 1,000 kg', 'error');
    return;
  }
  if (!cost || cost < 10000) {
    showToast('Cost must be at least 10,000 UGX', 'error');
    return;
  }
  if (!priceToSell || priceToSell < 1000) {
    showToast('Selling price must be at least 1,000 UGX/kg', 'error');
    return;
  }
  if (!dealer || dealer.length < 2) {
    showToast('Dealer name must be at least 2 characters', 'error');
    return;
  }
  if (!/^0[1-9]\d{8}$/.test(contact)) {
    showToast('Invalid phone format (10 digits starting with 0)', 'error');
    return;
  }

  // Check for duplicate name (final check before submission)
  const exists = availableStock.find(i => 
    i.name.toLowerCase() === name.toLowerCase()
  );
  if (exists) {
    showToast(`"${name}" already exists. Use the Restock button instead.`, 'error');
    return;
  }

  const procurementData = {
    name: name,
    type: type,
    tonnage_kg: tonnage,
    cost_ugx: cost,
    price_to_sell: priceToSell,
    dealer_name: dealer,
    contact: contact,
    branch: user.branch,
    recorded_by: user.full_name
  };

  try {
    const res = await apiFetch(`${API_BASE}/procurement`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(getToken() ? { 'Authorization': `Bearer ${getToken()}` } : {})
      },
      body: JSON.stringify(procurementData)
    });

    if (!res.ok) {
      const err = await res.json();
      showToast(`Error: ${err.error || 'Procurement failed'}`, 'error');
      return;
    }

    await res.json();

    showToast(`✅ Procurement recorded: ${tonnage.toLocaleString()}kg of ${name}`, 'success');

    document.getElementById('procurementForm').reset();
    setCurrentDateTime();

    // Reload data
    await loadAvailableStock();
    await loadDashboardStats();

    // Navigate back to dashboard
    document.querySelectorAll('.sidebar-nav a').forEach(a => a.classList.remove('active'));
    document.querySelector('[data-page="dashboard"]')?.classList.add('active');
    showSection('dashboard');

  } catch (err) {
    console.error('[PROCUREMENT]', err);
    showToast('Network error. Procurement not saved.', 'error');
  }
}

function setupSalePriceCalculators() {
  const produceEl = document.getElementById('saleProduce');
  const tonnageEl = document.getElementById('saleTonnage');
  const amountEl = document.getElementById('saleAmount');
  const typeEl = document.getElementById('saleType');
  if (!produceEl || !tonnageEl || !amountEl) return;

  const recalc = () => {
    const option = produceEl.options[produceEl.selectedIndex];
    const price = Number(option?.dataset?.price || 0);
    const tonnage = Number(tonnageEl.value || 0);
    if (price > 0 && tonnage > 0) {
      amountEl.value = Math.round(price * tonnage);
    }
    if (typeEl && option?.dataset?.type) {
      typeEl.value = option.dataset.type;
    }
  };

  produceEl.addEventListener('change', recalc);
  tonnageEl.addEventListener('input', recalc);
}

function setupSaleForm() {
  const form = document.getElementById('saleForm');
  if (!form) return;
  form.addEventListener('submit', submitSale);
}

async function submitSale(e) {
  e.preventDefault();

  const produceId = document.getElementById('saleProduce')?.value;
  const selectedProduce = availableStock.find(i => String(i._id) === String(produceId));
  const produceName = selectedProduce?.name;
  const tonnage = Number(document.getElementById('saleTonnage')?.value);
  const amount = Number(document.getElementById('saleAmount')?.value);
  const buyer = document.getElementById('saleBuyer')?.value.trim();
  const contact = document.getElementById('saleContact')?.value.trim();
  const date = document.getElementById('saleDate')?.value;
  const time = document.getElementById('saleTime')?.value;

  if (!selectedProduce || !produceName) {
    showToast('Please select a produce item', 'error');
    return;
  }
  if (!tonnage || tonnage < 1000) {
    showToast('Tonnage must be at least 1,000 kg', 'error');
    return;
  }
  if ((selectedProduce.remaining_kg ?? 0) < tonnage) {
    showToast(`Insufficient stock. Only ${(selectedProduce.remaining_kg ?? 0).toLocaleString()} kg available`, 'error');
    return;
  }
  if (!amount || amount < 10000) {
    showToast('Amount must be at least 10,000 UGX', 'error');
    return;
  }
  if (!buyer || buyer.length < 2) {
    showToast('Buyer name must be at least 2 characters', 'error');
    return;
  }
  if (contact && !/^0[1-9]\d{8}$/.test(contact)) {
    showToast('Contact format must be 10 digits starting with 0', 'error');
    return;
  }

  const payload = {
    produce_name: produceName,
    tonnage_kg: tonnage,
    amount_paid_ugx: amount,
    buyer_name: buyer,
    sales_agent: user.full_name || 'Manager',
    buyer_contact: contact || '',
    date,
    time,
    branch: user.branch
  };

  try {
    const res = await apiFetch(`${API_BASE}/sales`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const err = await res.json();
      showToast(err.error || 'Failed to record sale', 'error');
      return;
    }

    await res.json();
    showToast(`Sale recorded: ${tonnage.toLocaleString()}kg of ${produceName}`, 'success');

    const form = document.getElementById('saleForm');
    if (form) form.reset();
    setCurrentDateTime();
    const saleAgentEl = document.getElementById('saleAgent');
    if (saleAgentEl) saleAgentEl.value = user.full_name || 'Manager';

    await loadAvailableStock();
    await loadBranchSales();
    await loadDashboardStats();

    document.querySelectorAll('.sidebar-nav a').forEach(a => a.classList.remove('active'));
    document.querySelector('[data-page="dashboard"]')?.classList.add('active');
    showSection('dashboard');
  } catch (err) {
    console.error('[MANAGER SALE]', err);
    showToast('Network error. Sale not saved.', 'error');
  }
}

function setupCreditPriceCalculators() {
  const produceEl = document.getElementById('creditProduce');
  const tonnageEl = document.getElementById('creditTonnage');
  const amountEl = document.getElementById('creditAmount');
  const typeEl = document.getElementById('creditType');
  if (!produceEl || !tonnageEl || !amountEl) return;

  const recalc = () => {
    const option = produceEl.options[produceEl.selectedIndex];
    const price = Number(option?.dataset?.price || 0);
    const tonnage = Number(tonnageEl.value || 0);
    if (price > 0 && tonnage > 0) {
      amountEl.value = Math.round(price * tonnage);
    }
    if (typeEl && option?.dataset?.type) {
      typeEl.value = option.dataset.type;
    }
  };

  produceEl.addEventListener('change', recalc);
  tonnageEl.addEventListener('input', recalc);
}

function setupCreditForm() {
  const form = document.getElementById('creditForm');
  if (!form) return;
  form.addEventListener('submit', submitCredit);
}

async function submitCredit(e) {
  e.preventDefault();

  const produceSelect = document.getElementById('creditProduce');
  const selectedOption = produceSelect?.selectedOptions?.[0];
  const selectedProduce = availableStock.find(i => String(i._id) === String(produceSelect?.value));
  const produceName = selectedOption?.dataset?.name || selectedProduce?.name;
  const produceType = document.getElementById('creditType')?.value;
  const tonnage = Number(document.getElementById('creditTonnage')?.value);
  const amountDue = Number(document.getElementById('creditAmount')?.value);
  const dueDate = document.getElementById('creditDue')?.value;
  const buyerName = document.getElementById('creditBuyer')?.value.trim();
  const ninEl = document.getElementById('creditNin');
  if (ninEl) ninEl.value = ninEl.value.trim().toUpperCase();
  const nationalId = ninEl?.value || '';
  const location = document.getElementById('creditLocation')?.value.trim();
  const contact = document.getElementById('creditContact')?.value.trim();

  if (!selectedProduce || !produceName) {
    showToast('Please select a produce item', 'error');
    return;
  }
  if (!produceType) {
    showToast('Please select produce type', 'error');
    return;
  }
  if (!tonnage || tonnage < 1000) {
    showToast('Tonnage must be at least 1,000 kg', 'error');
    return;
  }
  if ((selectedProduce.remaining_kg ?? 0) < tonnage) {
    showToast(`Insufficient stock. Only ${(selectedProduce.remaining_kg ?? 0).toLocaleString()} kg available`, 'error');
    return;
  }
  if (!amountDue || amountDue < 10000) {
    showToast('Amount due must be at least 10,000 UGX', 'error');
    return;
  }
  if (!dueDate) {
    showToast('Please select a payment due date', 'error');
    return;
  }
  if (!buyerName || buyerName.length < 2) {
    showToast('Buyer name must be at least 2 characters', 'error');
    return;
  }
  if (!nationalId || !/^[A-Z0-9]{14,16}$/.test(nationalId)) {
    showToast('Invalid National ID: must be 14-16 uppercase letters/numbers', 'error');
    return;
  }
  if (!location || location.length < 2) {
    showToast('Location must be at least 2 characters', 'error');
    return;
  }
  if (!contact || !/^0\d{9}$/.test(contact)) {
    showToast('Valid phone required (10 digits starting with 0)', 'error');
    return;
  }

  const payload = {
    produce_name: produceName,
    produce_type: produceType,
    tonnage_kg: tonnage,
    amount_due_ugx: amountDue,
    due_date: dueDate,
    buyer_name: buyerName,
    national_id: nationalId,
    location,
    buyer_contact: contact,
    sales_agent_name: user.full_name || 'Manager',
    branch: user.branch
  };

  try {
    const res = await apiFetch(`${API_BASE}/credits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const err = await res.json();
      showToast(err.error || 'Failed to record credit', 'error');
      return;
    }

    await res.json();
    showToast(`Credit recorded: ${tonnage.toLocaleString()}kg of ${produceName}`, 'success');

    const form = document.getElementById('creditForm');
    if (form) form.reset();
    setCurrentDateTime();
    const creditAgentEl = document.getElementById('creditAgent');
    if (creditAgentEl) creditAgentEl.value = user.full_name || 'Manager';

    await loadAvailableStock();
    await loadCreditSales();
    await loadDashboardStats();

    document.querySelectorAll('.sidebar-nav a').forEach(a => a.classList.remove('active'));
    document.querySelector('[data-page="dashboard"]')?.classList.add('active');
    showSection('dashboard');
  } catch (err) {
    console.error('[MANAGER CREDIT]', err);
    showToast('Network error. Credit not saved.', 'error');
  }
}

// ======================================================================
// SECTION 14: NOTIFICATION SYSTEM
// ======================================================================
// Handles low stock alerts, notification badge, and alerts panel.
// Matches sales agent notification system exactly.

/**
 * Sets up notification bell click handler.
 */
function setupNotificationBell() {
  const bell = document.querySelector('.notif-icon');
  if (!bell) return;
  
  bell.addEventListener('click', () => {
    const low = availableStock.filter(i => (i.remaining_kg ?? 0) > 0 && (i.remaining_kg ?? 0) <= LOW_STOCK_THRESHOLD);
    const out = availableStock.filter(i => (i.remaining_kg ?? 0) <= 0);
    
    if (low.length + out.length === 0) {
      showToast('All stock levels are healthy ✅', 'success');
      return;
    }
    showAlertsPanel(low, out);
  });
}

/**
 * Checks for low/out of stock items and updates notification badge.
 * Called after every stock change.
 * @returns {Object} Object containing low and out of stock items
 */
function checkLowStockAndNotify() {
  const low = availableStock.filter(i => (i.remaining_kg ?? 0) > 0 && (i.remaining_kg ?? 0) <= LOW_STOCK_THRESHOLD);
  const out = availableStock.filter(i => (i.remaining_kg ?? 0) <= 0);
  const total = low.length + out.length;

  console.log(`[MANAGER NOTIFY] Alerts — Low: ${low.length}, Out: ${out.length}`);
  updateNotificationBadge(total, low, out);
  
  if (total > 0) showStockAlertToast(low, out);
  
  return { low, out, total };
}

/**
 * Updates the notification badge and tooltip.
 * @param {number} count - Total alert count
 * @param {Array} low - Low stock items
 * @param {Array} out - Out of stock items
 */
function updateNotificationBadge(count, low = [], out = []) {
  const badge = document.querySelector('.badge');
  const bell = document.querySelector('.notif-icon');
  
  if (!badge || !bell) return;

  if (count > 0) {
    badge.textContent = count;
    badge.style.display = 'inline';
    bell.classList.add('has-notification');
    
    // Create detailed tooltip
    let tooltipText = '🔔 STOCK ALERTS:\n\n';
    
    if (low.length > 0) {
      tooltipText += '⚠️ LOW STOCK:\n';
      low.forEach(i => { 
        tooltipText += `  • ${i.name}: ${i.remaining_kg}kg\n`; 
      });
    }
    
    if (out.length > 0) {
      if (low.length > 0) tooltipText += '\n';
      tooltipText += '❌ OUT OF STOCK:\n';
      out.forEach(i => { 
        tooltipText += `  • ${i.name}\n`; 
      });
    }
    
    bell.setAttribute('title', tooltipText);
    
  } else {
    badge.textContent = '0';
    badge.style.display = 'none';
    bell.classList.remove('has-notification');
    bell.removeAttribute('title');
  }
}

/**
 * Shows the alerts panel modal with all low/out of stock items.
 * @param {Array} low - Low stock items
 * @param {Array} out - Out of stock items
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

/**
 * Closes the alerts panel.
 */
window.closeAlertsPanel = () => {
  const m = document.getElementById('alertsModal');
  if (m) m.remove();
};

/**
 * Shows toast notification for new stock alerts.
 * Uses sessionStorage to prevent duplicate toasts.
 * @param {Array} low - Low stock items
 * @param {Array} out - Out of stock items
 */
function showStockAlertToast(low, out) {
  const previous = JSON.parse(sessionStorage.getItem('previousAlerts') || '[]');
  const current = [...low, ...out].map(i => i._id);
  const newOnes = current.filter(id => !previous.includes(id));

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
// SECTION 15: BACKGROUND POLLING
// ======================================================================
// Syncs with backend every 60 seconds to reflect changes made by agents.

/**
 * Starts background polling for stock updates.
 */
function startStockPolling() {
  if (stockPollInterval) return; // Already running
  
  stockPollInterval = setInterval(async () => {
    console.log('[POLL] Silent refresh...');
    await loadAvailableStock(true); // silent mode
    await loadBranchSales();
    await loadCreditSales();
    await loadDashboardStats();
  }, STOCK_POLL_INTERVAL_MS);

  console.log(`[POLLING] Started (every ${STOCK_POLL_INTERVAL_MS / 1000}s)`);
}

/**
 * Stops background polling.
 */
function stopStockPolling() {
  if (stockPollInterval) {
    clearInterval(stockPollInterval);
    stockPollInterval = null;
    console.log('[POLLING] Stopped');
  }
}

// ======================================================================
// SECTION 16: TOAST NOTIFICATIONS
// ======================================================================

/**
 * Shows a toast notification.
 * @param {string} message - Message to display
 * @param {string} type - 'success', 'error', 'warning', or 'info'
 */
function showToast(message, type = 'success') {
  if (typeof Toastify !== 'function') {
    console.warn(`[Toast fallback] ${message}`);
    return;
  }

  const colors = { 
    success: '#10b981', 
    error: '#ef4444', 
    warning: '#f59e0b', 
    info: '#3b82f6' 
  };
  
  Toastify({
    text: message,
    duration: 3500,
    close: true,
    gravity: 'top',
    position: 'center',
    style: { background: colors[type] || colors.success }
  }).showToast();
}

// ======================================================================
// SECTION 17: LOGOUT
// ======================================================================

/**
 * Shows logout confirmation dialog.
 * @param {Event} e - Click event
 */
function showLogoutConfirm(e) {
  e.preventDefault();
  
  document.body.insertAdjacentHTML('beforeend', `
    <div class="custom-confirm" id="logoutConfirm">
      <div class="confirm-dialog">
        <i class="bi bi-box-arrow-right"></i>
        <h3>Logout from Karibu Groceries?</h3>
        <p>Are you sure you want to logout?</p>
        <div class="confirm-actions">
          <button class="confirm-btn no" onclick="hideLogoutConfirm()">No, Stay</button>
          <button class="confirm-btn yes" onclick="confirmLogout()">Yes, Logout</button>
        </div>
      </div>
    </div>
  `);
}

/**
 * Hides logout confirmation dialog.
 */
window.hideLogoutConfirm = () => {
  const el = document.getElementById('logoutConfirm');
  if (el) el.remove();
};

/**
 * Confirms logout and clears session.
 */
window.confirmLogout = () => {
  stopStockPolling();
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  try {
    showToast('Logged out successfully', 'success');
  } finally {
    setTimeout(() => window.location.href = '../../index.html', 900);
  }
};

// ======================================================================
// SECTION 18: EXPORT CSV
// ======================================================================

/**
 * Exports all branch sales to CSV file.
 */
window.exportSalesCSV = function() {
  if (!allSales || allSales.length === 0) {
    showToast('No sales data to export', 'warning');
    return;
  }

  const headers = ['Date', 'Time', 'Product', 'Tonnage (kg)', 'Amount (UGX)', 'Buyer', 'Sales Agent'];
  
  const rows = allSales.map(s => {
    const date = s.date ? new Date(s.date).toLocaleDateString() : 'N/A';
    const time = s.time || 'N/A';
    const product = (s.produce_name || 'N/A').replace(/,/g, ';');
    const tonnage = s.tonnage_kg || 0;
    const amount = s.amount_paid_ugx || 0;
    const buyer = (s.buyer_name || 'N/A').replace(/,/g, ';');
    const agent = (s.sales_agent || 'N/A').replace(/,/g, ';');
    
    return [date, time, product, tonnage, amount, buyer, agent].join(',');
  });

  const csv = [headers.join(','), ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  
  link.setAttribute('href', url);
  link.setAttribute('download', `sales_${user.branch}_${new Date().toISOString().split('T')[0]}.csv`);
  link.style.visibility = 'hidden';
  
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  showToast(`✅ Exported ${allSales.length} sales to CSV`, 'success');
};

// ======================================================================
// SECTION 19: PRINT REPORTS
// ======================================================================

/**
 * Prints stock report with clean formatting.
 */
window.printStockReport = function() {
  if (!availableStock || availableStock.length === 0) {
    showToast('No stock data to print', 'warning');
    return;
  }

  const today = new Date().toLocaleDateString();
  const totalStock = availableStock.reduce((sum, i) => sum + (i.remaining_kg ?? 0), 0);
  
  let printHTML = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Stock Report - ${user.branch} Branch</title>
      <style>
        @media print { @page { margin: 1cm; } body { font-family: Arial, sans-serif; } }
        body { font-family: Arial, sans-serif; padding: 20px; max-width: 1000px; margin: 0 auto; }
        .header { text-align: center; margin-bottom: 30px; border-bottom: 3px solid #0f2c6b; padding-bottom: 20px; }
        .header h1 { color: #0f2c6b; margin: 0; font-size: 28px; }
        .meta { display: flex; justify-content: space-between; margin-bottom: 20px; font-size: 14px; }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; }
        th { background: #0f2c6b; color: white; padding: 12px; text-align: left; }
        td { padding: 10px 12px; border-bottom: 1px solid #ddd; }
        tr:nth-child(even) { background: #f8f9fa; }
        .low-stock-row { background-color: #fff3cd !important; }
        .out-of-stock-row { background-color: #f8d7da !important; }
        .badge { display: inline-block; padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; margin-left: 8px; }
        .badge-low { background: #fef3c7; color: #92400e; }
        .badge-out { background: #fee2e2; color: #991b1b; }
        .summary { margin-top: 30px; padding: 15px; background: #f8f9fa; border-left: 4px solid #0f2c6b; }
        .footer { margin-top: 40px; text-align: center; font-size: 12px; color: #666; border-top: 1px solid #ddd; padding-top: 20px; }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>📦 STOCK REPORT</h1>
        <h2>Karibu Groceries LTD — ${user.branch} Branch</h2>
      </div>
      
      <div class="meta">
        <div><strong>Report Date:</strong> ${today}</div>
        <div><strong>Generated By:</strong> ${user.full_name}</div>
        <div><strong>Total Items:</strong> ${availableStock.length} products</div>
      </div>

      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Product Name</th>
            <th>Type</th>
            <th>Stock Level (kg)</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
  `;

  availableStock.forEach((item, index) => {
    const remaining = item.remaining_kg ?? 0;
    const isLow = remaining > 0 && remaining <= LOW_STOCK_THRESHOLD;
    const isOut = remaining <= 0;
    
    let rowClass = '';
    let badge = '';
    
    if (isOut) {
      rowClass = 'out-of-stock-row';
      badge = '<span class="badge badge-out">OUT</span>';
    } else if (isLow) {
      rowClass = 'low-stock-row';
      badge = '<span class="badge badge-low">LOW</span>';
    }

    printHTML += `
      <tr class="${rowClass}">
        <td>${index + 1}</td>
        <td>${item.name}</td>
        <td>${item.type}</td>
        <td>${remaining.toLocaleString()} kg</td>
        <td>${badge || '✓ Normal'}</td>
      </tr>
    `;
  });

  printHTML += `
        </tbody>
      </table>

      <div class="summary">
        <strong>Summary:</strong><br>
        Total Stock Available: <strong>${totalStock.toLocaleString()} kg</strong> across ${availableStock.length} products<br>
        Low Stock Items: <strong>${availableStock.filter(i => (i.remaining_kg ?? 0) > 0 && (i.remaining_kg ?? 0) <= LOW_STOCK_THRESHOLD).length}</strong><br>
        Out of Stock Items: <strong>${availableStock.filter(i => (i.remaining_kg ?? 0) <= 0).length}</strong>
      </div>

      <div class="footer">
        <p>Karibu Groceries LTD | ${user.branch} Branch</p>
        <p>This report was generated on ${today} by ${user.full_name}</p>
      </div>

      <script>
        window.onload = function() { window.print(); }
      <\/script>
    </body>
    </html>
  `;

  const printWindow = window.open('', '_blank', 'width=1000,height=800');
  printWindow.document.write(printHTML);
  printWindow.document.close();
  showToast('Stock report opened for printing', 'success');
};

/**
 * Prints credits report with clean formatting.
 */
window.printCreditsReport = function() {
  if (!allCredits || allCredits.length === 0) {
    showToast('No credits data to print', 'warning');
    return;
  }

  const today = new Date().toLocaleDateString();
  const totalDue = allCredits.reduce((sum, c) => sum + (c.amount_due_ugx || 0), 0);
  const totalPaid = allCredits.reduce((sum, c) => sum + (c.amount_paid_ugx || 0), 0);
  const totalPending = totalDue - totalPaid;
  
  const unpaid = allCredits.filter(c => c.status !== 'paid');
  const currentDate = new Date(); 
  currentDate.setHours(0, 0, 0, 0);
  const overdue = unpaid.filter(c => {
    if (!c.due_date) return false;
    const due = new Date(c.due_date); 
    due.setHours(0, 0, 0, 0);
    return due < currentDate;
  });

  let printHTML = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Credits Report - ${user.branch} Branch</title>
      <style>
        @media print { @page { margin: 1cm; } body { font-family: Arial, sans-serif; } }
        body { font-family: Arial, sans-serif; padding: 20px; max-width: 1200px; margin: 0 auto; }
        .header { text-align: center; margin-bottom: 30px; border-bottom: 3px solid #0f2c6b; padding-bottom: 20px; }
        .header h1 { color: #0f2c6b; margin: 0; font-size: 28px; }
        .meta { display: flex; justify-content: space-between; margin-bottom: 20px; font-size: 14px; }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; font-size: 13px; }
        th { background: #0f2c6b; color: white; padding: 10px; text-align: left; }
        td { padding: 8px 10px; border-bottom: 1px solid #ddd; }
        tr:nth-child(even) { background: #f8f9fa; }
        .status-pending { color: #1e40af; font-weight: 600; }
        .status-partial { color: #92400e; font-weight: 600; }
        .status-overdue { color: #991b1b; font-weight: 600; }
        .status-paid { color: #065f46; font-weight: 600; }
        .summary { margin-top: 30px; padding: 15px; background: #f8f9fa; border-left: 4px solid #0f2c6b; }
        .footer { margin-top: 40px; text-align: center; font-size: 12px; color: #666; border-top: 1px solid #ddd; padding-top: 20px; }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>💳 CREDITS REPORT</h1>
        <h2>Karibu Groceries LTD — ${user.branch} Branch</h2>
      </div>
      
      <div class="meta">
        <div><strong>Report Date:</strong> ${today}</div>
        <div><strong>Generated By:</strong> ${user.full_name}</div>
        <div><strong>Total Credits:</strong> ${allCredits.length}</div>
      </div>

      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Product</th>
            <th>Buyer</th>
            <th>Tonnage</th>
            <th>Amount Due</th>
            <th>Amount Paid</th>
            <th>Balance</th>
            <th>Due Date</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
  `;

  allCredits.forEach((c, index) => {
    const balance = Math.max(0, (c.amount_due_ugx || 0) - (c.amount_paid_ugx || 0));
    const dueDate = c.due_date ? new Date(c.due_date).toLocaleDateString() : 'N/A';
    
    const due = new Date(c.due_date); 
    due.setHours(0, 0, 0, 0);
    const isOverdue = c.status !== 'paid' && due < currentDate;
    
    let status = c.status;
    let statusClass = 'status-pending';
    
    if (c.status === 'paid') {
      status = '✅ Paid';
      statusClass = 'status-paid';
    } else if (isOverdue) {
      status = '🔴 Overdue';
      statusClass = 'status-overdue';
    } else if (c.status === 'partial') {
      status = '🔶 Partial';
      statusClass = 'status-partial';
    } else {
      status = '🔵 Pending';
    }

    printHTML += `
      <tr>
        <td>${index + 1}</td>
        <td>${c.produce_name || 'N/A'}</td>
        <td>${c.buyer_name || 'N/A'}</td>
        <td>${(c.tonnage_kg || 0).toLocaleString()} kg</td>
        <td>Ush ${(c.amount_due_ugx || 0).toLocaleString()}</td>
        <td>Ush ${(c.amount_paid_ugx || 0).toLocaleString()}</td>
        <td><strong>Ush ${balance.toLocaleString()}</strong></td>
        <td>${dueDate}</td>
        <td class="${statusClass}">${status}</td>
      </tr>
    `;
  });

  printHTML += `
        </tbody>
      </table>

      <div class="summary">
        <strong>Summary:</strong><br>
        Total Credits: <strong>${allCredits.length}</strong><br>
        Total Amount Due: <strong>Ush ${totalDue.toLocaleString()}</strong><br>
        Total Amount Paid: <strong>Ush ${totalPaid.toLocaleString()}</strong><br>
        Total Pending Balance: <strong>Ush ${totalPending.toLocaleString()}</strong><br>
        Unpaid Credits: <strong>${unpaid.length}</strong><br>
        Overdue Credits: <strong>${overdue.length}</strong>
      </div>

      <div class="footer">
        <p>Karibu Groceries LTD | ${user.branch} Branch</p>
        <p>This report was generated on ${today} by ${user.full_name}</p>
      </div>

      <script>
        window.onload = function() { window.print(); }
      <\/script>
    </body>
    </html>
  `;

  const printWindow = window.open('', '_blank', 'width=1200,height=800');
  printWindow.document.write(printHTML);
  printWindow.document.close();
  showToast('Credits report opened for printing', 'success');
};
