/*
 * Shared frontend utilities:
 * - API base URL constant.
 * - Token helpers.
 * - Auth guard for protected pages.
 * - Toast and logout helpers.
 */

const API_BASE = (() => {
  const overrideBase = String(window.__KGL_API_BASE__ || '').trim().replace(/\/+$/, '');
  if (overrideBase) {
    return overrideBase.endsWith('/api') ? overrideBase : `${overrideBase}/api`;
  }

  const { protocol, hostname, port, origin } = window.location;
  const isLocalHost = hostname === 'localhost' || hostname === '127.0.0.1';

  // Support local frontend served via Live Server (e.g., :5500) with backend on :5000.
  if (isLocalHost && port === '5500') {
    return `${protocol}//${hostname}:5000/api`;
  }

  return `${origin}/api`;
})();

// Shared dashboard polling interval (30s) for sales, manager, and director.
if (typeof window.KGL_DASHBOARD_POLL_MS === 'undefined') {
  window.KGL_DASHBOARD_POLL_MS = 30000;
}

function getToken() {
  return localStorage.getItem('token');
}

function checkAuth() {
  if (window.location.pathname.includes('index.html')) return;
  if (!getToken()) {
    window.location.href = 'index.html';
  }
}

function showToast(message, type = 'success') {
  if (typeof Toastify !== 'function') {
    console.warn(`[Toast fallback] ${message}`);
    return;
  }

  Toastify({
    text: message,
    duration: 3000,
    close: true,
    gravity: 'top',
    position: 'center',
    style: {
      background: type === 'success' ? '#10b981' : '#ef4444'
    }
  }).showToast();
}

function logout() {
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  showToast('Logged out successfully', 'success');
  setTimeout(() => {
    window.location.href = 'index.html';
  }, 1500);
}

function isMobileLayout() {
  return window.matchMedia('(max-width: 768px)').matches;
}

// Shared dashboard sidebar controller:
// - Injects a hamburger button into the header
// - On mobile: opens/closes the sidebar drawer with backdrop
// - On desktop: collapses/expands the fixed sidebar
// This keeps behavior centralized for sales, manager, and director pages.
function initDashboardSidebarToggle() {
  if (!document.body.classList.contains('dashboard')) return;

  const sidebar = document.querySelector('.sidebar');
  const header = document.querySelector('.content-header');
  if (!sidebar || !header) return;
  if (document.getElementById('sidebarToggleBtn')) return;

  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.id = 'sidebarToggleBtn';
  toggleBtn.className = 'sidebar-toggle-btn';
  toggleBtn.setAttribute('aria-label', 'Toggle sidebar');
  toggleBtn.setAttribute('aria-expanded', 'true');
  toggleBtn.innerHTML = '<i class="bi bi-list"></i>';

  const title = header.querySelector('h1');
  const leftWrap = document.createElement('div');
  leftWrap.className = 'header-left';
  if (title) {
    title.parentNode.insertBefore(leftWrap, title);
    leftWrap.appendChild(toggleBtn);
    leftWrap.appendChild(title);
  } else {
    header.insertBefore(leftWrap, header.firstChild);
    leftWrap.appendChild(toggleBtn);
  }

  let backdrop = document.querySelector('.sidebar-backdrop');
  if (!backdrop) {
    backdrop = document.createElement('div');
    backdrop.className = 'sidebar-backdrop';
    document.body.appendChild(backdrop);
  }

  // Mobile close helper so we reuse one source of truth
  // for nav clicks, backdrop clicks, and resize transitions.
  const closeMobileMenu = () => {
    sidebar.classList.remove('open');
    document.body.classList.remove('sidebar-open');
    backdrop.classList.remove('active');
    toggleBtn.setAttribute('aria-expanded', 'false');
  };

  // Resets state when crossing breakpoints:
  // avoids stale "open" mobile drawer or stale desktop collapse flags.
  const syncLayoutState = () => {
    if (isMobileLayout()) {
      document.body.classList.remove('sidebar-collapsed');
      closeMobileMenu();
    } else {
      closeMobileMenu();
      const expanded = !document.body.classList.contains('sidebar-collapsed');
      toggleBtn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    }
  };

  toggleBtn.addEventListener('click', () => {
    if (isMobileLayout()) {
      const opening = !sidebar.classList.contains('open');
      sidebar.classList.toggle('open', opening);
      document.body.classList.toggle('sidebar-open', opening);
      backdrop.classList.toggle('active', opening);
      toggleBtn.setAttribute('aria-expanded', opening ? 'true' : 'false');
      return;
    }

    const collapsing = !document.body.classList.contains('sidebar-collapsed');
    document.body.classList.toggle('sidebar-collapsed', collapsing);
    toggleBtn.setAttribute('aria-expanded', collapsing ? 'false' : 'true');
  });

  backdrop.addEventListener('click', closeMobileMenu);

  document.querySelectorAll('.sidebar-nav a').forEach((link) => {
    let label = link.dataset.label || link.getAttribute('aria-label') || '';
    if (!label) {
      label = link.textContent.replace(/\s+/g, ' ').trim();
    }
    if (label) {
      link.dataset.label = label;
      link.setAttribute('aria-label', label);
      link.setAttribute('title', label);
    }
    link.addEventListener('click', () => {
      if (isMobileLayout()) closeMobileMenu();
    });
  });

  window.addEventListener('resize', syncLayoutState);
  syncLayoutState();
}

document.addEventListener('DOMContentLoaded', () => {
  initDashboardSidebarToggle();
});
