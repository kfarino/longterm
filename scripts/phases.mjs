// Which phase is "now". The plan is an ordered list. The current phase is
// the latest one whose start has arrived — not whichever row sits first.
// The dashboard has its own copy of this rule (dashboard_v5.html's
// currentPhaseIndex) because that file is not an ES module. Keep them matched.

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

function periodStartText(period) {
  return String(period || '').split(/\s*(?:→|->|–|—)\s*/)[0].trim();
}

function parsePhaseDate(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const mdy = s.match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2}),?\s+(\d{4})$/i);
  if (mdy) return new Date(Number(mdy[3]), MONTHS[mdy[1].slice(0, 3).toLowerCase()], Number(mdy[2]));
  const my = s.match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{4})$/i);
  if (my) return new Date(Number(my[2]), MONTHS[my[1].slice(0, 3).toLowerCase()], 1);
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  const yr = s.match(/^(\d{4})$/);
  if (yr) return new Date(Number(yr[1]), 0, 1);
  return null;
}

function startOfDay(now) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

export function phaseHasStarted(phase, now = new Date()) {
  const left = periodStartText(phase?.period);
  if (!left) return false;
  if (/^now$/i.test(left)) return true;
  const start = parsePhaseDate(left);
  if (!start || Number.isNaN(start.getTime())) return false;
  return start <= startOfDay(now);
}

export function currentPhaseIndex(phases, now = new Date()) {
  const list = Array.isArray(phases) ? phases : [];
  let idx = 0;
  list.forEach((phase, i) => {
    if (phaseHasStarted(phase, now)) idx = i;
  });
  return idx;
}

export function currentPhase(phases, now = new Date()) {
  const list = Array.isArray(phases) ? phases : [];
  if (!list.length) return null;
  return list[currentPhaseIndex(list, now)];
}
