const fs = require('node:fs');
const path = require('node:path');

function read(rel) {
  return fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function assertMatch(text, regex, message) {
  if (!regex.test(text)) throw new Error(message);
}

function run() {
  const sales = read('public/pages/sales/dashboard.html');
  assertMatch(sales, /id="dashboardFiltersBar"/, 'Sales: dashboardFiltersBar missing');
  assertMatch(sales, /id="stockStatusFilter"/, 'Sales: stockStatusFilter missing');
  assertMatch(sales, /id="creditStatusFilter"/, 'Sales: creditStatusFilter missing');
  assertMatch(sales, /id="salesDateFilter"/, 'Sales: salesDateFilter missing');
  assertMatch(sales, /id="stockSectionTitle"/, 'Sales: stockSectionTitle missing');
  assertMatch(sales, /id="creditsSectionTitle"/, 'Sales: creditsSectionTitle missing');
  assertMatch(sales, /id="salesSectionTitle"/, 'Sales: salesSectionTitle missing');

  const manager = read('public/pages/manager/dashboard.html');
  assertMatch(manager, /id="dashboardFiltersBar"/, 'Manager: dashboardFiltersBar missing');
  assertMatch(manager, /id="stockStatusFilter"/, 'Manager: stockStatusFilter missing');
  assertMatch(manager, /id="creditStatusFilter"/, 'Manager: creditStatusFilter missing');
  assertMatch(manager, /id="salesDateFilter"/, 'Manager: salesDateFilter missing');
  assertMatch(manager, /id="stockSectionTitle"/, 'Manager: stockSectionTitle missing');
  assertMatch(manager, /id="creditsSectionTitle"/, 'Manager: creditsSectionTitle missing');
  assertMatch(manager, /id="salesSectionTitle"/, 'Manager: salesSectionTitle missing');

  const css = read('public/css/style.css');
  assertMatch(css, /sidebar-collapsed .*::after/, 'Tooltip ::after style missing');
  assertMatch(css, /sidebar-collapsed .*::before/, 'Tooltip ::before style missing');
  assertMatch(css, /sidebar-collapsed .*sidebar-nav a i/, 'Collapsed icon rule missing');

  const usersRoute = read('src/routes/users.js');
  const idxSafe = usersRoute.indexOf('const safeLimit');
  const idxSkip = usersRoute.indexOf('const skip');
  assert(idxSafe !== -1 && idxSkip !== -1, 'Users route missing safeLimit/skip');
  assert(idxSkip > idxSafe, 'Users route skip should be computed after safeLimit');
}

try {
  run();
  console.log('Tests: PASS');
} catch (err) {
  console.error('Tests: FAIL');
  console.error(err.message || err);
  process.exit(1);
}
