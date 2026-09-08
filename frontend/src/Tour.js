import React, { useState, useEffect, useCallback, useRef } from 'react';
import { api } from './api';

// Guided first-login tour. Hand-rolled spotlight walkthrough: each step names
// a tab and (optionally) a [data-tour] target; the tour switches tabs itself,
// dims the page, rings the target, and anchors a card near it. Steps whose
// target isn't on screen (staff can't see the Square tile; empty pages load
// async) degrade to a centered card. Seen-state is stamped server-side.
const STEPS = [
  {
    tab: 'dashboard', badge: null, center: true,
    title: 'Welcome to Dose', wordmark: true,
    copy: "Your window into your coffee's flow — what you're brewing, what you're burning, and when to reorder. This tour takes about a minute and walks the real app.",
  },
  {
    tab: 'stock', target: 'delivery-form', badge: 'start here — nothing to set up',
    title: 'Deliveries are the heartbeat',
    copy: "Log what arrived and what's still on the shelf — that's it, no tokens, no counting, thirty seconds. Each delivery closes the last cycle and settles its waste; your first one starts the clock.",
  },
  {
    tab: 'settings', target: 'square', badge: 'the unlock',
    title: 'Connect your Square',
    copy: "Dose reads what you SELL from Square and compares it to what you STOCK — that comparison is the whole product: burn rate, days left, waste. Without the token, Dose is a notebook; with it, it's a dashboard. Paste it once, verify, done. (This field needs an admin login.)",
  },
  {
    tab: 'recipes', target: 'add-recipe', badge: null,
    title: 'Recipes make the numbers real',
    copy: "Now that Square is connected, your menu is right here — pick a drink, say how it's brewed (espresso machine, batch, cold brew, pour-over), and every sale starts counting coffee automatically. No recipes, no numbers.",
  },
  {
    tab: 'dashboard', target: 'snapshot', badge: null,
    title: 'The payoff',
    copy: 'Burn rate per roast, days of coffee left, a suggested next order — live, from your real sales. Waste settles cycle to cycle, counted at each delivery, nothing extra to log.',
  },
  {
    tab: 'order', target: 'order-form', badge: null,
    title: 'Ordering, without the guesswork',
    copy: "Your personal price list from the roastery, a suggested order computed from your burn rate, one-click duplicate of last time — or a standing order that places itself weekly.",
  },
  {
    tab: 'dashboard', badge: null, center: true, finish: true,
    title: 'Three things, in this order',
    copy: 'Each one unlocks the next — the dashboard comes alive at step three.',
  },
];

const FINISH_ACTIONS = [
  { label: '1 · Log your latest coffee delivery →', tab: 'stock', primary: true },
  { label: '2 · Connect your Square token →', tab: 'settings' },
  { label: '3 · Add your first recipe →', tab: 'recipes' },
];

export default function Tour({ page, setPage, onClose }) {
  const [i, setI] = useState(0);
  const [rect, setRect] = useState(null); // spotlight rect, null → centered
  const pollRef = useRef(null);
  const step = STEPS[i];
  const isMobile = window.innerWidth < 700;

  const markSeen = useCallback(() => {
    api('/api/me/tour-done', { method: 'POST' }).catch(() => {});
  }, []);

  const close = useCallback((jumpTab) => {
    markSeen();
    onClose(jumpTab);
  }, [markSeen, onClose]);

  // Switch to the step's tab, then hunt for its target. Pages fetch data
  // before their targets exist, so poll briefly and fall back to centered.
  useEffect(() => {
    if (step.tab !== page) setPage(step.tab);
    setRect(null);
    if (!step.target) return undefined;
    let tries = 0;
    const hunt = () => {
      const el = document.querySelector(`[data-tour="${step.target}"]`);
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        const r = el.getBoundingClientRect();
        setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
        return;
      }
      if (++tries < 25) pollRef.current = setTimeout(hunt, 120);
    };
    hunt();
    return () => clearTimeout(pollRef.current);
  }, [i, page, setPage, step.tab, step.target]);

  // Track the target through resizes and scrolling.
  useEffect(() => {
    if (!step.target) return undefined;
    const sync = () => {
      const el = document.querySelector(`[data-tour="${step.target}"]`);
      if (el) { const r = el.getBoundingClientRect(); setRect({ top: r.top, left: r.left, width: r.width, height: r.height }); }
    };
    window.addEventListener('resize', sync);
    window.addEventListener('scroll', sync, true);
    return () => { window.removeEventListener('resize', sync); window.removeEventListener('scroll', sync, true); };
  }, [i, step.target]);

  // Card placement: below the target if there's room, else above; centered
  // when there's no target. Mobile docks to the bottom regardless.
  const cardStyle = {};
  if (!isMobile) {
    if (rect) {
      const roomBelow = window.innerHeight - (rect.top + rect.height) >= 340;
      const roomAbove = rect.top >= 340;
      if (roomBelow) {
        cardStyle.top = rect.top + rect.height + 18;
        cardStyle.left = Math.max(16, Math.min(rect.left + rect.width / 2 - 180, window.innerWidth - 400));
      } else if (roomAbove) {
        cardStyle.top = rect.top - 320;
        cardStyle.left = Math.max(16, Math.min(rect.left + rect.width / 2 - 180, window.innerWidth - 400));
      } else {
        // Tall target with no room either side: tuck to the top-right so the
        // least content is covered.
        cardStyle.top = 74;
        cardStyle.right = 20;
      }
    } else {
      cardStyle.top = Math.max(40, window.innerHeight * 0.16);
      cardStyle.left = '50%';
      cardStyle.transform = 'translateX(-50%)';
    }
  }

  return (
    <div className="tour-layer">
      {rect ? (
        <div className="tour-spot" style={{ top: rect.top - 6, left: rect.left - 6, width: rect.width + 12, height: rect.height + 12 }} />
      ) : (
        <div className="tour-dim" />
      )}
      <div className={`tour-card${step.center ? ' tour-card-center' : ''}`} style={cardStyle}>
        {step.wordmark && (
          <div className="tour-wordmark">
            <div>BOXX</div>
            <span>Coffee Roasters Co.</span>
          </div>
        )}
        <div className="tour-step">
          {step.finish ? "That's the tour" : `Step ${i + 1} of ${STEPS.length}`}
          {step.badge ? ` · ${step.badge}` : ''}
        </div>
        <div className="tour-title">{step.title}</div>
        <div className="tour-copy">{step.copy}</div>
        {step.finish && (
          <div className="tour-actions">
            {FINISH_ACTIONS.map(a => (
              <button key={a.tab} className={`btn ${a.primary ? 'btn-primary' : 'btn-secondary'}`} style={{ textAlign: 'left' }}
                onClick={() => close(a.tab)}>{a.label}</button>
            ))}
          </div>
        )}
        <div className="tour-foot">
          {step.finish
            ? <span className="tour-hint">Replay anytime from Settings.</span>
            : <span className="tour-skip" onClick={() => close()}>Skip the tour</span>}
          <span className="tour-btns">
            {i > 0 && !step.finish && <button className="btn btn-ghost" onClick={() => setI(i - 1)}>← Back</button>}
            {step.finish
              ? <span className="tour-skip" onClick={() => close()}>Done</span>
              : <button className="btn btn-primary" style={{ background: 'var(--olive)' }} onClick={() => setI(i + 1)}>
                  {i === 0 ? 'Show Me Around →' : 'Next →'}
                </button>}
          </span>
        </div>
        <div className="tour-dots">
          {STEPS.map((_, d) => <span key={d} className={`tour-dot${d <= i ? ' on' : ''}`} />)}
        </div>
      </div>
    </div>
  );
}
