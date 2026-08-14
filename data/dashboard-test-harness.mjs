// Longterm/data/dashboard-test-harness.mjs
// Headless harness for exercising dashboard_v5.html's render functions
// without a browser. Stubs document/window enough for the dashboard's
// <script> block to execute, then hands back every function/value named
// in exportNames so tests can call them directly.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dashboardPath = path.join(here, '..', 'dashboard_v5.html');
const dataJsPath = path.join(here, 'data.js');

class FakeEl {
  constructor() {
    this._html = '';
    this.style = {};
    this.dataset = {};
    // Actually tracks class membership (not a no-op) so tests can assert
    // which sub-page/sub-tab is active — dashboard_v5.html's show()/
    // showPosition() rely purely on classList + real CSS (.page.active,
    // .subpage.active) rather than inline style.display, matching how a
    // real browser applies it.
    const classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((n) => classes.add(n)),
      remove: (...names) => names.forEach((n) => classes.delete(n)),
      contains: (name) => classes.has(name),
      toggle: (name, force) => {
        const shouldHave = force === undefined ? !classes.has(name) : force;
        if (shouldHave) classes.add(name); else classes.delete(name);
        return shouldHave;
      },
    };
  }
  set innerHTML(v) { this._html = v; }
  get innerHTML() { return this._html; }
  set textContent(v) { this._text = v; }
  get textContent() { return this._text || ''; }
  addEventListener() {}
  querySelectorAll() { return []; }
  querySelector() { return null; }
  getContext() { return {}; }
}

// Stands in for dashboard-server.mjs's /api/month-plan-events endpoint —
// GET-only, since the dashboard displays Month Plan but never writes it (the
// Telegram bot writes month_plan_events.json directly). Seeded with an
// initial {events: {...}} shape (same as loadMonthPlanState()'s return value).
const EMPTY_ROUTINE_OVERRIDES = { family_dinner: null, date_night: null, weekend_social: null };

// Also stands in for dashboard-server.mjs's read-only
// /api/dining-routine-overrides route (2026-08-01) — seeded once, never
// written by the dashboard side (only the bot's set_routine_day writes the
// real file).
class FakeMonthPlanApi {
  constructor(seed, routineOverridesSeed) {
    this.events = seed ? JSON.parse(JSON.stringify(seed)) : {};
    this.routineOverrides = { ...EMPTY_ROUTINE_OVERRIDES, ...(routineOverridesSeed || {}) };
  }
  async fetch(url) {
    if (url === '/api/dining-routine-overrides') {
      return { ok: true, json: async () => this.routineOverrides };
    }
    if (url !== '/api/month-plan-events') return { ok: false, json: async () => ({}) };
    return { ok: true, json: async () => ({ events: this.events }) };
  }
}

const exportNames = [
  'D', 'computeProjection', 'phaseIncome', 'phaseExpenses', 'totalNW',
  'renderTrajectory', 'updateP6', 'show',
  'planRemainingMonth', 'recommendForSlot', 'effectiveDiningRoutine', 'renderMonthPlan', 'cycleEndDate', 'isoDate',
  'loadMonthPlanState', 'loadRoutineOverrides', 'TIER_SYMBOL',
  'buildEventChip',
  'renderBudgetTab', 'computeMonthPlanProjectedSpend', 'renderTodosSection',
  'buildPhaseCardsHTML', 'renderStatusSection', 'renderGoalsSection',
  'renderPositionTab', 'showPosition', 'jumpToTrajectory',
  'renderGoalsTab', 'renderDecisionsTab', 'milestoneLines',
  'computeTrackerPacing', 'renderCategoryDrilldown', 'toggleDrilldown',
  'renderSpendTracker', 'renderTravelSummary', 'renderJointKevinTrackers',
  'toggleExpPanel', 'initReady', 'showRowHTML',
  'groupShowsByAct', 'showsFindingsHTML',
];

export function loadDashboard(dataOverride, monthPlanEventsSeed, routineOverridesSeed) {
  let html;
  try {
    html = fs.readFileSync(dashboardPath, 'utf8');
  } catch (err) {
    throw new Error(`Could not read dashboard_v5.html at ${dashboardPath} — has it moved? (${err.message})`);
  }
  const match = html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);
  if (!match) throw new Error('Could not find main <script> block in dashboard_v5.html');
  const script = match[1];

  const elements = {};
  global.document = {
    getElementById(id) {
      if (!elements[id]) elements[id] = new FakeEl();
      return elements[id];
    },
    querySelectorAll() { return []; },
    querySelector() { return null; },
  };

  let dataJsRaw;
  try {
    dataJsRaw = fs.readFileSync(dataJsPath, 'utf8');
  } catch (err) {
    throw new Error(`Could not read data.js at ${dataJsPath} — has it moved? (${err.message})`);
  }

  let bundled;
  try {
    bundled = JSON.parse(
      dataJsRaw
        .replace(/^[\s\S]*?window\.DATA\s*=\s*/, '')
        .replace(/;\s*$/, '')
    );
  } catch (err) {
    throw new Error(`Failed to parse data.js's window.DATA — check the extraction regex against the file's current format (${err.message})`);
  }
  const monthPlanApi = new FakeMonthPlanApi(monthPlanEventsSeed, routineOverridesSeed);
  // scrollTo is a no-op recorder rather than absent: show()/showPosition()
  // reset scroll on every tab switch (see dashboard_v5.html), so a window stub
  // without it turns every tab switch into a TypeError.
  const scrollCalls = [];
  global.window = {
    DATA: dataOverride ? { ...bundled, ...dataOverride } : bundled,
    scrollTo: (x, y) => { scrollCalls.push([x, y]); },
    scrollCalls,
  };
  global.fetch = (url, opts) => monthPlanApi.fetch(url, opts);
  global.Chart = function (ctx, cfg) { this.data = cfg.data; this.update = () => {}; };

  const exportStatements = exportNames
    .map((n) => `global.__${n} = typeof ${n} !== 'undefined' ? ${n} : undefined;`)
    .join('\n');

  const fn = new Function(script + '\n' + exportStatements);
  fn();

  const result = {};
  for (const name of exportNames) result[name] = global[`__${name}`];
  return { ...result, elements, monthPlanApi };
}
