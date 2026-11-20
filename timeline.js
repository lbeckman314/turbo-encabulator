// Lays the write-up's timeline out to scale: the space between consecutive
// entries is proportional to the time between them, so the long gaps read as
// long. Where entries crowd together (three between Dec 1944 and Apr 1946) the
// scale stretches just enough to fit the text, and the decade ticks on the
// line follow the same mapping, so they show where it does. Each dot stays
// level with its own entry. Without this script the timeline is a plain list.

const SVG = 'http://www.w3.org/2000/svg';

// "1944-12" -> 1944.96 (mid-month), "1946-04-15" -> 1946.29, "1946" -> 1946.0.
// A date known only to the year sits at the start of that year.
function decimalYear(s) {
  const [y, m, d] = s.split('-').map(Number);
  if (!m) return y;
  const t = Date.UTC(y, m - 1, d || 15);
  return y + (t - Date.UTC(y, 0, 1)) / (Date.UTC(y + 1, 0, 1) - Date.UTC(y, 0, 1));
}

function scaleTimeline(ol) {
  const items = [...ol.children].map((li) => ({ li, t: decimalYear(li.querySelector('time').getAttribute('datetime')) }));
  if (items.length < 2) return;
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('tl-axis');
  ol.classList.add('scaled');
  ol.prepend(svg);

  const t0 = items[0].t;
  const t1 = items[items.length - 1].t;

  function layout() {
    // The axis runs midway between the date column and the text column.
    const { li: first } = items[0];
    const [date, text] = first.children;
    const textX = text.offsetLeft;
    const axisX = (date.offsetLeft + date.offsetWidth + textX) / 2;
    const lh = parseFloat(getComputedStyle(first).lineHeight);
    const pad = parseFloat(getComputedStyle(first).paddingTop);
    // Pixels per year: enough that the long gaps read as long, without making
    // the whole thing much taller than a screen.
    const k = ol.clientWidth < 560 ? 7 : 9;

    // Row tops: each a fixed number of pixels per year after the one before,
    // or just below it if that wouldn't leave room for its text.
    let rowTop = 0;
    const ys = items.map(({ li, t }, i) => {
      if (i > 0) {
        const prev = items[i - 1];
        rowTop = Math.max(rowTop + prev.li.offsetHeight + 4, rowTop + (t - prev.t) * k);
      }
      li.style.top = `${rowTop}px`;
      return rowTop + pad + lh / 2; // the dot, level with the first line of text
    });
    const last = items[items.length - 1].li;
    const height = rowTop + last.offsetHeight;
    ol.style.height = `${height}px`;

    // Time -> y, piecewise linear through the entries.
    const yAt = (t) => {
      let i = 0;
      while (i < items.length - 2 && t > items[i + 1].t) i++;
      const a = items[i], b = items[i + 1];
      return ys[i] + ((t - a.t) / (b.t - a.t)) * (ys[i + 1] - ys[i]);
    };

    const parts = [`<line class="tl-line" x1="${axisX}" x2="${axisX}" y1="${ys[0]}" y2="${ys[ys.length - 1]}" />`];
    for (let y = Math.ceil(t0 / 10) * 10; y <= t1; y += 10) {
      const ty = yAt(y);
      parts.push(`<line class="tl-tick" x1="${axisX - 5}" x2="${axisX + 5}" y1="${ty}" y2="${ty}" />`);
    }
    for (const y of ys) parts.push(`<circle class="tl-dot" cx="${axisX}" cy="${y}" r="5" />`);
    svg.setAttribute('width', ol.clientWidth);
    svg.setAttribute('height', height);
    svg.innerHTML = parts.join('');
  }

  let queued = false;
  const relayout = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      layout();
    });
  };
  // Widths change with the viewport; heights change as the web fonts arrive.
  const ro = new ResizeObserver(relayout);
  ro.observe(ol);
  items.forEach(({ li }) => ro.observe(li));
  layout();
}

document.querySelectorAll('ol.timeline').forEach(scaleTimeline);
