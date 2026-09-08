import React from 'react';

// House style for tasting notes regardless of how the roastery typed them:
// "buttery, chocolate · marzipan" → "Buttery · Chocolate · Marzipan"
const formatNotes = raw => String(raw || '')
  .split(/[.,·;|]+/).map(w => w.trim()).filter(Boolean)
  .map(w => w.charAt(0).toUpperCase() + w.slice(1))
  .join(' · ');

// The roastery's coffee info sheet, rendered for the shop: label facts,
// brewing notes first (that's what a busy bar needs), then the story
// sections in the roastery's own order. Prints as-is.
const FACTS = [
  ['country', 'Country'], ['region', 'Region'], ['producer', 'Station / Farm'],
  ['variety', 'Variety'], ['process', 'Process'], ['altitude', 'Altitude'],
];

export default function InfoSheet({ item, onClose }) {
  const s = item.info_sheet;
  if (!s) return null;
  const facts = FACTS.filter(([k]) => s[k]);
  const hasBrew = s.brew_filter || s.brew_espresso;

  const print = () => {
    document.body.classList.add('print-sheet');
    window.print();
    document.body.classList.remove('print-sheet');
  };

  return (
    <div className="isheet-bg" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="isheet">
        <div className="isheet-head">
          <div className="isheet-eyebrow">Boxx Coffee Roasters Co. · Coffee Info Sheet</div>
          <div className="isheet-name">{item.name}</div>
          {item.notes && <div className="isheet-notes">{formatNotes(item.notes)}</div>}
        </div>
        {facts.length > 0 && (
          <div className="isheet-facts">
            {facts.map(([k, label]) => (
              <div className="isheet-fact" key={k}>
                <div className="isheet-fact-lbl">{label}</div>
                <div className="isheet-fact-val">{s[k]}</div>
              </div>
            ))}
          </div>
        )}
        <div className="isheet-body">
          {hasBrew && (
            <>
              <div className="isheet-sec">Brewing Notes</div>
              <div className="isheet-brew">
                {s.brew_filter && <div className="isheet-brewcell"><div className="isheet-brew-lbl">Filter</div>{s.brew_filter}</div>}
                {s.brew_espresso && <div className="isheet-brewcell"><div className="isheet-brew-lbl">Espresso</div>{s.brew_espresso}</div>}
              </div>
            </>
          )}
          {(s.sections || []).map((sec, i) => (
            <div key={i}>
              {sec.title && <div className="isheet-sec">{sec.title}</div>}
              <div className="isheet-text">{sec.body}</div>
            </div>
          ))}
          <div className="isheet-foot">
            <span>Updated by the roastery · always current</span>
            <span className="isheet-actions">
              <button className="btn btn-ghost" onClick={print}>🖨 Print</button>
              <button className="btn btn-primary" onClick={onClose}>Close</button>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
