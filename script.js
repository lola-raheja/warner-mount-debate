const chartEl = document.getElementById('chart');
const tooltip = document.getElementById('tooltip');
const yearValue = document.getElementById('yearValue');
const totalValue = document.getElementById('totalValue');
const playButton = document.getElementById('playButton');
const prevButton = document.getElementById('prevButton');
const nextButton = document.getElementById('nextButton');

const TRANSITION_DURATION = 1200;
const EXIT_DURATION = 600;

// Fixed, resolution-independent coordinate space. The SVG scales to its
// container purely via CSS (viewBox + width:100%), so this never changes
// on resize -- which is what lets every bubble's position stay put.
const CANVAS_WIDTH = 1200;
const CANVAS_HEIGHT = 760;
const MAX_LEAF_RADIUS = 95;
const PARENT_TOP_PADDING = 12;
const PARENT_RING_PADDING = 16;
const CHILD_SUB_PADDING = 8;

const parentPalette = new Map([
  ['time_warner', '#5B8FF9'],
  ['sony', '#61DDAA'],
  ['disney', '#F6BD16'],
  ['seagram', '#9661BC'],
  ['news_corp', '#F6903D'],
  ['viacom', '#8b5cf6']
]);

// Brand colors for a distributor's own bubble, keyed by distributor_id so
// the color stays with the studio's identity even as its parent_id changes
// across ownership eras (e.g. Universal stays this teal whether its ring
// that year is Matsushita, Seagram, Vivendi Universal, or Comcast).
// Warner Bros., Universal, Paramount, Sony, and Disney are all
// historically blue-branded studios -- kept in the blue family for brand
// recognition, but spread across navy/teal/electric-blue/cyan/indigo so
// they stay distinguishable from each other at a glance.
const distributorBrandColors = new Map([
  ['warner_bros_pictures', '#003DA5'], // WB shield navy
  ['universal_pictures', '#0E7C86'], // globe teal
  ['paramount_pictures', '#0064FF'], // Paramount electric blue
  ['sony_pictures', '#00A8E1'], // Sony cyan
  ['walt_disney_studios', '#5B3A8E'], // Disney indigo-purple
  ['mgm', '#C9A227'], // MGM lion gold
  ['lionsgate_films', '#E8442C'], // Lionsgate red-orange
  ['netflix', '#E50914'], // Netflix red
  ['crunchyroll', '#F97300'], // Crunchyroll orange
  ['mubi', '#2A5CFF'] // MUBI blue
]);

function parentColor(parentId) {
  return parentPalette.get(parentId) || '#6ea8fe';
}

// Muted, lower-saturation palette for the many one-off independent
// distributors that don't have a real brand color -- deliberately soft so
// they recede next to the studios that do.
function getStandaloneColor(id) {
  const colors = ['#8FBFDA', '#7C8AA6', '#4D9B96', '#D9A0B8', '#9AA5B1', '#6FAE83', '#D68A56'];
  let total = 0;
  for (let i = 0; i < id.length; i += 1) total += id.charCodeAt(i);
  return colors[total % colors.length];
}

function leafColor(distributorId, fallback) {
  return distributorBrandColors.get(distributorId) || fallback;
}

function isBrandedDistributor(distributorId) {
  return distributorBrandColors.has(distributorId);
}

function wrapLabel(name, maxChars = 14) {
  if (name.length <= maxChars) return [name];
  const words = name.split(' ');
  const lines = [];
  let current = '';
  words.forEach(word => {
    const test = current ? `${current} ${word}` : word;
    if (test.length <= maxChars) current = test;
    else {
      if (current) lines.push(current);
      current = word;
    }
  });
  if (current) lines.push(current);
  return lines.slice(0, 2);
}

function appendChildLabel(node, d) {
  const showLabel = d.r > 25;
  if (!showLabel) return;
  const lines = wrapLabel(d.data.name, d.r > 52 ? 16 : 12);
  const label = d3.select(node).append('text').attr('class', 'child-label');

  lines.forEach((line, index) => {
    label.append('tspan')
      .attr('x', 0)
      .attr('dy', index === 0 ? (lines.length === 1 ? '-0.15em' : '-0.45em') : '1.05em')
      .style('font-size', `${Math.max(10, Math.min(17, d.r / 3.4))}px`)
      .text(line);
  });

  label.append('tspan')
    .attr('class', 'count')
    .attr('x', 0)
    .attr('dy', '1.15em')
    .style('font-size', `${Math.max(9, Math.min(14, d.r / 4.6))}px`)
    .text(d.data.value);
}

function appendParentLabel(node, d) {
  if (d.r < 40) return;
  const lines = wrapLabel(d.data.name, d.r > 110 ? 18 : 14);
  const label = d3.select(node).append('text').attr('class', 'parent-label');
  lines.forEach((line, index) => {
    label.append('tspan')
      .attr('x', 0)
      .attr('dy', index === 0 ? '0.8em' : '1.05em')
      .text(line);
  });
}

// Precompute a fixed "map" of anchor positions from the whole dataset, once,
// instead of letting d3.pack() re-solve the layout from scratch every year.
// Each parent company and each ever-standalone distributor gets one fixed
// (x, y) slot; each distributor gets a fixed offset within whichever
// parent(s) it's ever belonged to. Per-year renders only change radius
// (via a shared, constant value scale) -- position changes only when a
// distributor's actual parent_id changes between years, which is the
// visual cue for a merger/acquisition.
function computeFixedLayout(allRows) {
  const childMaxByParent = new Map(); // parent_id -> Map(distributor_id -> maxValue)
  const standaloneMax = new Map(); // distributor_id -> maxValue while standalone

  allRows.forEach(row => {
    if (row.parent_id) {
      if (!childMaxByParent.has(row.parent_id)) childMaxByParent.set(row.parent_id, new Map());
      const kids = childMaxByParent.get(row.parent_id);
      kids.set(row.distributor_id, Math.max(kids.get(row.distributor_id) || 0, row.title_count));
    } else {
      standaloneMax.set(row.distributor_id, Math.max(standaloneMax.get(row.distributor_id) || 0, row.title_count));
    }
  });

  const maxValue = d3.max(allRows, d => d.title_count) || 1;
  // Intrinsic (unscaled) radius for a title count -- fitting the whole
  // layout to the canvas below rescales this uniformly, so this is just
  // the shape of the value curve, not the final on-screen size.
  const rScale0 = d3.scaleSqrt().domain([0, maxValue]).range([0, MAX_LEAF_RADIUS]);

  // Each child gets a fixed offset sized to fit it at its own individual
  // peak (padded slots, packed once) -- this is what keeps a distributor's
  // position stable and gives it room to grow into.
  const childOffset = new Map(); // parent_id -> Map(distributor_id -> {dx, dy})
  childMaxByParent.forEach((kidsMap, parentId) => {
    const padded = Array.from(kidsMap, ([id, value]) => ({ id, r: rScale0(value) + CHILD_SUB_PADDING }));
    d3.packSiblings(padded);
    const enclosing = d3.packEnclose(padded);
    const offsets = new Map();
    padded.forEach(c => offsets.set(c.id, { dx: c.x - enclosing.x, dy: c.y - enclosing.y }));
    childOffset.set(parentId, offsets);
  });

  // Anchor spacing between parents needs enough room for the biggest ring
  // this parent ever ACTUALLY needed. Using every child's individual peak
  // simultaneously (i.e. the offset slots above) would reserve space for a
  // combination that likely never really happened; instead, replay real
  // history through the exact same enclosing-radius formula the per-year
  // renderer uses, and take the highest value it ever actually produced.
  const parentFootprint = new Map(); // parent_id -> historical peak ring radius
  const rowsByParent = d3.group(allRows.filter(r => r.parent_id), r => r.parent_id);
  childMaxByParent.forEach((kidsMap, parentId) => {
    const offsets = childOffset.get(parentId);
    const byYear = d3.group(rowsByParent.get(parentId) || [], r => r.year);
    let peakReach = 0;
    byYear.forEach(yearRows => {
      let reach = 0;
      yearRows.forEach(row => {
        const offset = offsets.get(row.distributor_id) || { dx: 0, dy: 0 };
        reach = Math.max(reach, Math.hypot(offset.dx, offset.dy) + rScale0(row.title_count));
      });
      peakReach = Math.max(peakReach, reach);
    });
    parentFootprint.set(parentId, peakReach + PARENT_RING_PADDING);
  });

  // Arrange parents (by worst-case footprint) and ever-standalone
  // distributors (by peak size) together, compactly and without overlap,
  // then fit that arrangement into the fixed canvas. The same fit scale
  // is applied to the leaf radius scale below, so real per-year bubbles
  // -- always smaller than this worst-case arrangement -- never collide.
  const masterCircles = [];
  parentFootprint.forEach((r, parentId) => masterCircles.push({ id: parentId, r: r + PARENT_TOP_PADDING, isParent: true }));
  standaloneMax.forEach((maxVal, distributorId) => masterCircles.push({ id: distributorId, r: rScale0(maxVal) + PARENT_TOP_PADDING, isParent: false }));

  d3.packSiblings(masterCircles);
  const masterEnclosing = d3.packEnclose(masterCircles);
  const fitScale = (Math.min(CANVAS_WIDTH, CANVAS_HEIGHT) / (2 * masterEnclosing.r)) * 0.94;
  const translateX = CANVAS_WIDTH / 2 - masterEnclosing.x * fitScale;
  const translateY = CANVAS_HEIGHT / 2 - masterEnclosing.y * fitScale;

  const parentAnchor = new Map();
  const standaloneAnchor = new Map();
  masterCircles.forEach(c => {
    const target = c.isParent ? parentAnchor : standaloneAnchor;
    target.set(c.id, { x: c.x * fitScale + translateX, y: c.y * fitScale + translateY, r: c.r * fitScale });
  });

  const scaledChildOffset = new Map();
  childOffset.forEach((offsets, parentId) => {
    const scaled = new Map();
    offsets.forEach((o, id) => scaled.set(id, { dx: o.dx * fitScale, dy: o.dy * fitScale }));
    scaledChildOffset.set(parentId, scaled);
  });

  const rScale = d3.scaleSqrt().domain([0, maxValue]).range([0, MAX_LEAF_RADIUS * fitScale]);

  // computeYearNodes adds this (rather than the raw PARENT_RING_PADDING
  // constant) so the ring padding it draws with matches, at the same
  // scale, the padding that was actually reserved for it above -- adding
  // the raw constant post-fit would apply full-size padding on top of a
  // shrunk reservation and reopen the overlap this function exists to fix.
  const ringPadding = PARENT_RING_PADDING * fitScale;

  return { parentAnchor, standaloneAnchor, childOffset: scaledChildOffset, rScale, ringPadding };
}

function computeYearNodes(rows, layout) {
  const grouped = d3.group(rows, d => d.parent_id || `standalone__${d.distributor_id}`);
  const parentNodes = [];
  const allLeaves = [];

  grouped.forEach(groupRows => {
    const first = groupRows[0];

    if (!first.parent_id) {
      const row = first;
      const anchor = layout.standaloneAnchor.get(row.distributor_id) || { x: CANVAS_WIDTH / 2, y: CANVAS_HEIGHT / 2 };
      allLeaves.push({
        x: anchor.x,
        y: anchor.y,
        r: layout.rScale(row.title_count),
        data: {
          id: row.distributor_id,
          name: row.distributor_label,
          value: row.title_count,
          type: 'distributor',
          isStandalone: true,
          isBranded: isBrandedDistributor(row.distributor_id),
          year: row.year,
          color: leafColor(row.distributor_id, getStandaloneColor(row.distributor_id))
        }
      });
      return;
    }

    const parentId = first.parent_id;
    const anchor = layout.parentAnchor.get(parentId) || { x: CANVAS_WIDTH / 2, y: CANVAS_HEIGHT / 2 };
    const offsets = layout.childOffset.get(parentId) || new Map();
    let maxReach = 0;

    const children = groupRows.map(row => {
      const offset = offsets.get(row.distributor_id) || { dx: 0, dy: 0 };
      const r = layout.rScale(row.title_count);
      maxReach = Math.max(maxReach, Math.hypot(offset.dx, offset.dy) + r);
      return {
        x: anchor.x + offset.dx,
        y: anchor.y + offset.dy,
        r,
        data: {
          id: row.distributor_id,
          name: row.distributor_label,
          value: row.title_count,
          parentId,
          type: 'distributor',
          isBranded: isBrandedDistributor(row.distributor_id),
          year: row.year,
          color: leafColor(row.distributor_id, parentColor(parentId))
        }
      };
    });

    parentNodes.push({
      x: anchor.x,
      y: anchor.y,
      r: maxReach + layout.ringPadding,
      data: {
        id: parentId,
        name: first.parent_label,
        type: 'parent',
        color: parentColor(parentId)
      }
    });
    allLeaves.push(...children);
  });

  return { parentNodes, allLeaves };
}

let svg, parentGroup, childGroup, labelGroup;
let allRows = [];
let years = [];
let layout = null;
let yearIndex = 0;
let playing = false;
let timer = null;

function initChart() {
  svg = d3.select(chartEl)
    .append('svg')
    .attr('viewBox', `0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}`)
    .attr('aria-hidden', 'true');

  parentGroup = svg.append('g').attr('class', 'parents');
  childGroup = svg.append('g').attr('class', 'children');
  // Parent-company labels live in their own top-most layer so distributor
  // bubbles packed inside a parent circle can never paint over the name.
  labelGroup = svg.append('g').attr('class', 'parent-labels');
}

function update(year) {
  const rows = allRows.filter(d => d.year === year);
  const totalTitles = d3.sum(rows, d => d.title_count);

  yearValue.textContent = year;
  totalValue.textContent = totalTitles;

  const { parentNodes, allLeaves } = computeYearNodes(rows, layout);

  // --- Parent circles ---
  parentGroup.selectAll('g.parent-node')
    .data(parentNodes, d => d.data.id)
    .join(
      enterSel => {
        const g = enterSel.append('g')
          .attr('class', 'parent-node')
          .attr('transform', d => `translate(${d.x},${d.y})`);
        g.append('circle').attr('r', 0).attr('fill', d => d.data.color);
        g.transition().duration(TRANSITION_DURATION).ease(d3.easeCubicOut)
          .select('circle').attr('r', d => d.r);
        return g;
      },
      updateSel => {
        updateSel.transition().duration(TRANSITION_DURATION).ease(d3.easeCubicOut)
          .attr('transform', d => `translate(${d.x},${d.y})`)
          .select('circle').attr('fill', d => d.data.color).attr('r', d => d.r);
        return updateSel;
      },
      exitSel => exitSel.transition().duration(EXIT_DURATION).ease(d3.easeCubicIn)
        .style('opacity', 0)
        .remove()
    );

  // --- Parent labels (own layer, always on top) ---
  labelGroup.selectAll('g.parent-label-node')
    .data(parentNodes, d => d.data.id)
    .join(
      enterSel => {
        const g = enterSel.append('g')
          .attr('class', 'parent-label-node')
          .attr('transform', d => `translate(${d.x},${Math.max(d.y - d.r + 22, 22)})`)
          .style('opacity', 0);
        g.each(function(d) { appendParentLabel(this, d); });
        g.transition().duration(TRANSITION_DURATION).style('opacity', 1);
        return g;
      },
      updateSel => {
        updateSel.selectAll('text.parent-label').remove();
        updateSel.each(function(d) { appendParentLabel(this, d); });
        updateSel.transition().duration(TRANSITION_DURATION).ease(d3.easeCubicOut)
          .style('opacity', 1)
          .attr('transform', d => `translate(${d.x},${Math.max(d.y - d.r + 22, 22)})`);
        return updateSel;
      },
      exitSel => exitSel.transition().duration(EXIT_DURATION).style('opacity', 0).remove()
    );

  // --- Distributor / standalone circles ---
  const childNodeClass = d => `child-node${d.data.isStandalone ? ' is-standalone' : ''}${d.data.isBranded ? ' is-branded' : ''}`;

  const nodes = childGroup.selectAll('g.child-node')
    .data(allLeaves, d => d.data.id)
    .join(
      enterSel => {
        const g = enterSel.append('g')
          .attr('class', childNodeClass)
          .attr('transform', d => `translate(${d.x},${d.y})`)
          .attr('tabindex', 0);
        g.append('circle').attr('r', 0).attr('fill', d => d.data.color);
        g.each(function(d) { appendChildLabel(this, d); });
        g.transition().duration(TRANSITION_DURATION).ease(d3.easeCubicOut)
          .select('circle').attr('r', d => d.r);
        return g;
      },
      updateSel => {
        updateSel.attr('class', childNodeClass);
        updateSel.selectAll('text.child-label').remove();
        updateSel.each(function(d) { appendChildLabel(this, d); });
        updateSel.transition().duration(TRANSITION_DURATION).ease(d3.easeCubicOut)
          .attr('transform', d => `translate(${d.x},${d.y})`)
          .select('circle').attr('fill', d => d.data.color).attr('r', d => d.r);
        return updateSel;
      },
      exitSel => exitSel.transition().duration(EXIT_DURATION).ease(d3.easeCubicIn)
        .style('opacity', 0)
        .remove()
    );

  nodes
    .on('mouseenter focus', function(event, d) {
      d3.selectAll('.child-node').classed('is-active', false);
      d3.select(this).classed('is-active', true);
      tooltip.hidden = false;
      const parentLine = d.data.parentId ? `<span class="tooltip-parent">Parent: ${rows.find(r => r.distributor_id === d.data.id)?.parent_label || ''}</span>` : '<span class="tooltip-parent">Standalone distributor</span>';
      tooltip.innerHTML = `
        <strong>${d.data.name}</strong>
        <span>${d.data.value} wide-release films in ${d.data.year}</span>
        ${parentLine}
      `;
    })
    .on('mouseleave blur', function() {
      d3.select(this).classed('is-active', false);
      tooltip.hidden = true;
    });
}

function goToIndex(index) {
  yearIndex = Math.max(0, Math.min(years.length - 1, index));
  update(years[yearIndex]);
  prevButton.disabled = yearIndex === 0;
  nextButton.disabled = yearIndex === years.length - 1;
}

function stopPlayback() {
  playing = false;
  playButton.textContent = 'Play';
  playButton.setAttribute('aria-pressed', 'false');
  if (timer) {
    timer.stop();
    timer = null;
  }
}

function startPlayback() {
  if (playing || years.length < 2) return;
  if (yearIndex >= years.length - 1) goToIndex(0);
  playing = true;
  playButton.textContent = 'Pause';
  playButton.setAttribute('aria-pressed', 'true');
  timer = d3.interval(() => {
    if (yearIndex >= years.length - 1) {
      stopPlayback();
      return;
    }
    goToIndex(yearIndex + 1);
    if (yearIndex >= years.length - 1) stopPlayback();
  }, TRANSITION_DURATION + 700);
}

playButton.addEventListener('click', () => {
  if (playing) stopPlayback();
  else startPlayback();
});

prevButton.addEventListener('click', () => {
  stopPlayback();
  goToIndex(yearIndex - 1);
});

nextButton.addEventListener('click', () => {
  stopPlayback();
  goToIndex(yearIndex + 1);
});

d3.csv('distributor_title_counts.csv', d => ({
  year: d.year,
  parent_id: d.parent_id?.trim() || '',
  parent_label: d.parent_label?.trim() || '',
  distributor_id: d.distributor_id?.trim(),
  distributor_label: d.distributor_label?.trim(),
  title_count: +d.title_count
})).then(rows => {
  allRows = rows;
  years = Array.from(new Set(rows.map(d => d.year))).sort();

  if (years.length < 2) {
    playButton.disabled = true;
    prevButton.disabled = true;
    nextButton.disabled = true;
  }

  layout = computeFixedLayout(allRows);
  initChart();
  goToIndex(0);
}).catch(error => {
  chartEl.innerHTML = `<p style="color:#ffb4b4; padding: 1rem;">Could not load the CSV file. Make sure <code>distributor_title_counts.csv</code> is in the same folder as these files.</p>`;
  console.error(error);
});
