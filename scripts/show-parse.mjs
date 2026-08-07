/** Shared show line parser — keep in sync with dashboard_v5.html parseShowsFromText. */

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Pull structured shows out of LLM prose / dash-separated lines. */
export function parseShowsFromText(text, fallbackUrls = []) {
  if (!text) return [];
  const today = isoDate(new Date());
  const urlRe = /https?:\/\/\S+/gi;
  const dateRe = /\b(20\d{2}-\d{2}-\d{2})\b/;
  const junk = /^(i('ll| will) search|based on |here are the|most venue|note:|no current|for other artists|confirmed la|the search results|unfortunately|with my search)/i;
  const shows = [];
  const lines = text.replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean);

  let pendingVenue = null;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (junk.test(line)) continue;

    const venueOnly = line.match(/^\*\*(.+?)\*\*\s*[—–\-:]?\s*$/);
    if (venueOnly) {
      pendingVenue = venueOnly[1].trim();
      continue;
    }

    line = line
      .replace(/^[-*•]\s+/, '')
      .replace(/\*\*/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!line || junk.test(line)) continue;

    // Join short continuation lines that carry date/url after a venue header
    let combined = line;
    if (pendingVenue && !dateRe.test(combined) && i + 1 < lines.length) {
      const next = lines[i + 1].replace(/^[-*•]\s+/, '').replace(/\*\*/g, '').trim();
      if (dateRe.test(next) || urlRe.test(next)) {
        combined = `${line} ${next}`;
        i += 1;
      }
    }

    const dateMatch = combined.match(dateRe);
    if (!dateMatch) {
      pendingVenue = null;
      continue;
    }
    const date = dateMatch[1];
    if (date < today) {
      pendingVenue = null;
      continue;
    }

    const urls = combined.match(urlRe) || [];
    let rest = combined.replace(urlRe, '').replace(dateRe, '');
    rest = rest.replace(/[—–]/g, '|').replace(/,/g, '|');
    const parts = rest.split('|').map((p) => p.replace(/^[\s\-–—:]+|[\s\-–—:]+$/g, '').trim()).filter(Boolean);

    let act = '';
    let venue = pendingVenue || '';
    pendingVenue = null;

    if (parts.length >= 2) {
      if (venue) {
        act = parts[0];
      } else {
        // Spotify style: act — venue. Venue-pull often emits: Venue, Act, date.
        const venueHint = /\b(shop|cafe|café|troubadour|room|theatre|theater|stage|bowl|forum|stadium|typewriter|largo|whisky|roxy|echo|wiltern|sofi|hotel)\b/i;
        if (venueHint.test(parts[0]) && !venueHint.test(parts[1])) {
          venue = parts[0];
          act = parts[1];
        } else {
          act = parts[0];
          venue = parts[1];
        }
      }
    } else if (parts.length === 1) {
      act = parts[0];
    }

    if (!act && !venue) continue;
    shows.push({
      act: act || 'Show',
      venue: venue || '',
      date,
      sourceUrl: urls[0] || (fallbackUrls && fallbackUrls[0]) || null,
    });
  }
  return shows;
}

export function showDedupeKey(s) {
  const norm = (x) => String(x || '')
    .toLowerCase()
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return `${norm(s.act)}|${norm(s.venue)}|${s.date || ''}`;
}

export function dedupeShows(shows) {
  const map = new Map();
  for (const s of shows || []) {
    const k = showDedupeKey(s);
    if (!map.has(k)) map.set(k, s);
  }
  return [...map.values()];
}

export function maxOwnerScore(show, ownerIds = ['kevin', 'hanna']) {
  const nums = ownerIds
    .map((id) => show.scores?.[id])
    .filter((s) => s?.linked && typeof s.score === 'number')
    .map((s) => s.score);
  return nums.length ? Math.max(...nums) : null;
}

export function takeTopShows(shows, limit = 15, ownerIds) {
  return [...(shows || [])]
    .sort((a, b) => {
      const ma = maxOwnerScore(a, ownerIds);
      const mb = maxOwnerScore(b, ownerIds);
      if (ma == null && mb == null) return (a.date || '').localeCompare(b.date || '');
      if (ma == null) return 1;
      if (mb == null) return -1;
      return mb - ma || (a.date || '').localeCompare(b.date || '') || (a.act || '').localeCompare(b.act || '');
    })
    .slice(0, limit);
}
