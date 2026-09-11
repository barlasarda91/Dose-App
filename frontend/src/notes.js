// House style for tasting notes, however the roastery typed them:
// "Jammy. Raisin, Bergamot, peach," → "Jammy. Raisin. Bergamot. Peach."
// Split on any separator, Title Case each note, join with periods.
export const formatNotes = raw => {
  const tokens = String(raw || '')
    .split(/[.,·;|/]+/)
    .map(t => t.trim())
    .filter(Boolean)
    .map(t => t.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' '));
  return tokens.length ? tokens.join('. ') + '.' : '';
};
