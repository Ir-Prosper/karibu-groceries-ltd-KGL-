/*
 * Shared frontend utilities:
 * - API base URL constant.
 * - Token helpers.
 * - Auth guard for protected pages.
 * - Toast and logout helpers.
 */

const API_BASE = 'http://localhost:5000/api';

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
