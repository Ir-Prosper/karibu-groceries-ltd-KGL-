/*
 * Shared frontend utilities:
 * - API base URL constant.
 * - Token helpers.
 * - Auth guard for protected pages.
 * - Toast and logout helpers.
 */

const API_BASE = `${window.location.origin}/api`;

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
  Toastify({
    text: message,
    duration: 3000,
    close: true,
    gravity: 'top',
    position: 'center',
    backgroundColor: type === 'success' ? '#10b981' : '#ef4444'
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

  document.querySelectorAll('.sidebar-nav a[data-page]').forEach((link) => {
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
