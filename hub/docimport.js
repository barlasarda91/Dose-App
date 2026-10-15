// Parses the roastery's product-pages Google Doc (exported as markdown/text)
// into info-sheet payloads. The doc's heading SIZES are inconsistent, so
// nothing here trusts levels: a heading whose text starts with a known
// section name is a section, a Draft/Active/Past heading is a grouping, and
// any other heading is a coffee title. Facts ride heading suffixes
// ("Region – Huila / Pitalito"); altitude is fished out of the Region prose.

const SECTION_RE = /^(intro|relationship|country|region|farm|processing station|station|variety|process|brew)/i;
const GROUP_RE = /^(draft|active|past)\b.*coffees?\s*$/i;

// "#### **Region – Huila / Pitalito**" → "Region – Huila / Pitalito"
function headingText(line) {
  const m = line.match(/^#{1,6}\s+(.*)$/);
  if (!m) return null;
  return m[1].replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\*\*/g, '').trim();
}

// "Region – Huila / Pitalito" → { name: "Region", suffix: "Huila / Pitalito" }
function splitHeading(text) {
  const m = text.match(/^(.*?)\s+[-–—:]\s+(.*)$/);
  if (m) return { name: m[1].trim(), suffix: m[2].trim() };
  return { name: text.trim(), suffix: '' };
}

// Canonical section name, or null if this heading is not a section.
function sectionName(name) {
  const n = name.toLowerCase();
  if (n.startsWith('processing station') || n === 'station') return 'Processing Station';
  if (n.startsWith('intro')) return 'Intro';
  if (n.startsWith('relationship')) return 'Relationship';
  if (n.startsWith('country')) return 'Country';
  if (n.startsWith('region')) return 'Region';
  if (n.startsWith('farm')) return 'Farm';
  if (n.startsWith('variety')) return 'Variety';
  if (n.startsWith('process')) return 'Process';
  if (n.startsWith('brew')) return 'Brewing';
  return null;
}

// "…from 1,230 to 1,250 meters above sea level" → "1,230–1,250 masl"
function findAltitude(text) {
  let m = text.match(/([\d][\d.,]*)\s*(?:to|[-–—])\s*([\d][\d.,]*)\s*(?:meters|metres|masl|m\.a\.s\.l)/i);
  if (m) return `${m[1]}–${m[2]} masl`;
  m = text.match(/([\d][\d.,]{2,})\s*(?:meters|metres|masl|m\.a\.s\.l)/i);
  if (m) return `${m[1]} masl`;
  return null;
}

const cleanBody = s => s.replace(/\*\*/g, '').replace(/^\s*\\?[-*]\s*$/gm, '').trim();

function parseProductDoc(text) {
  const lines = String(text || '').split(/\r?\n/);
  const coffees = [];
  let group = '';
  let coffee = null;
  let section = null; // { title, body: [] }

  const closeSection = () => {
    if (coffee && section) {
      const body = cleanBody(section.body.join('\n'));
      if (body) coffee.sections.push({ title: section.title, body });
    }
    section = null;
  };
  const closeCoffee = () => {
    closeSection();
    if (coffee && (coffee.sections.length || Object.values(coffee.facts).some(Boolean))) coffees.push(coffee);
    coffee = null;
  };

  for (const line of lines) {
    const h = headingText(line);
    if (h === null) {
      if (section) section.body.push(line);
      continue;
    }
    if (!h) continue; // bare "#" spacer lines in the doc
    if (GROUP_RE.test(h)) { closeCoffee(); group = h.replace(/\s+$/, ''); continue; }
    const { name, suffix } = splitHeading(h);
    const sec = SECTION_RE.test(name) ? sectionName(name) : null;
    if (!sec) {
      // A heading that isn't a section or a group starts a new coffee.
      closeCoffee();
      coffee = { title: h, group, facts: { country: '', region: '', producer: '', variety: '', process: '', altitude: '' }, sections: [] };
      continue;
    }
    if (!coffee) continue; // section before any coffee title — stray, skip
    closeSection();
    section = { title: sec, body: [] };
    if (suffix) {
      if (sec === 'Country') coffee.facts.country = coffee.facts.country || suffix;
      else if (sec === 'Region') coffee.facts.region = coffee.facts.region || suffix;
      else if (sec === 'Farm' || sec === 'Processing Station') coffee.facts.producer = coffee.facts.producer || suffix;
      else if (sec === 'Variety') coffee.facts.variety = coffee.facts.variety || suffix;
      else if (sec === 'Process') coffee.facts.process = coffee.facts.process || suffix;
    }
  }
  closeCoffee();

  for (const c of coffees) {
    // Country falls back to the title's first segment ("Ethiopia – Gerse").
    if (!c.facts.country) {
      const seg = c.title.split(/\s+[-–—]\s+/)[0].trim();
      if (seg && seg.length <= 40 && !/\d/.test(seg)) c.facts.country = seg;
    }
    const region = c.sections.find(s => s.title === 'Region');
    if (!c.facts.altitude && region) c.facts.altitude = findAltitude(region.body) || '';
  }
  return coffees;
}

// Best catalog match for a parsed coffee, by token overlap with the title.
function suggestMatch(title, catalogItems) {
  const tok = s => new Set(String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').split(' ').filter(w => w.length > 1));
  const t = tok(title);
  let best = null, bestScore = 0;
  for (const item of catalogItems) {
    const n = tok(item.name);
    if (!n.size) continue;
    let hit = 0;
    for (const w of n) if (t.has(w)) hit++;
    const score = hit / n.size;
    if (score > bestScore) { bestScore = score; best = item; }
  }
  return bestScore >= 0.5 ? best.id : null;
}

module.exports = { parseProductDoc, suggestMatch };
