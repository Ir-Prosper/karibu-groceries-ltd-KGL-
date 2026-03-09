/*
 * Frontend runtime config:
 * - On Render frontend URL, use Render API
 * - On local Live Server, leave blank so common.js resolves to localhost:5000/api
 */
(() => {
  const host = String(window.location.hostname || '').toLowerCase();
  const isRenderFrontend = host === 'karibu-groceries-frontend.onrender.com';
  window.__KGL_API_BASE__ = isRenderFrontend
    ? 'https://karibu-groceries-api.onrender.com'
    : '';
})();
