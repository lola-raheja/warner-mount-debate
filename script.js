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
// on resize -- which is what lets every bubble's position stay put. Set
// once at load (see pickCanvasSize below) based on the device's own
// viewport, then left alone -- recomputing on every resize would fight
// the whole point of fixed positions.
let CANVAS_WIDTH = 1000;
let CANVAS_HEIGHT = 1000;
const MOBILE_BREAKPOINT = 780; // matches the CSS breakpoint in style.css

// The packed mosaic is circular, so its size is always bounded by
// whichever canvas dimension is smaller -- BASE_SIZE keeps that dimension
// fixed at the value already tuned for bubble legibility, regardless of
// device. The other dimension extends to give the canvas a device-
// appropriate rectangular frame (landscape on wide viewports, portrait on
// narrow ones) with the circular cluster centered in it, rather than
// distorting the packing itself into an ellipse. Because a circle can only
// ever fill the SHORTER side of a rectangle, the extension ratio is capped
// fairly tightly (1.3x) -- real device aspect ratios go much wider/taller
// than that, but following them exactly would surround the mosaic with
// large empty bands, reopening the "wasted space" problem already fixed
// once for the square canvas.
function pickCanvasSize() {
  const BASE_SIZE = 1000;
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  if (window.innerWidth < MOBILE_BREAKPOINT) {
    const ratio = clamp(window.innerHeight / window.innerWidth, 1.05, 1.3);
    return { width: BASE_SIZE, height: Math.round(BASE_SIZE * ratio) };
  }
  const ratio = clamp(window.innerWidth / window.innerHeight, 1.05, 1.3);
  return { width: Math.round(BASE_SIZE * ratio), height: BASE_SIZE };
}
const MAX_LEAF_RADIUS = 130;
const PARENT_TOP_PADDING = 12;
const PARENT_RING_PADDING = 16;
const CHILD_SUB_PADDING = 8;
const STANDALONE_PADDING = 4; // independents get a much tighter pad than parents -- less reserved space

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

// Muted color for the many one-off independent distributors that don't
// have a real brand color -- deliberately soft so they recede next to the
// studios that do, but spread continuously across the hue wheel (rather
// than picked from a handful of fixed swatches) so that with ~150 of them,
// neighbors don't keep landing on the same few colors. Saturation and
// lightness stay fixed so the "soft, receding" quality is consistent.
function getStandaloneColor(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 38%, 58%)`;
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

// Precompute a "home" position for every parent company and every
// ever-standalone distributor, once, plus a fixed offset for each
// distributor within whichever parent(s) it's ever belonged to. Homes are
// sized from each parent's *typical* (median) yearly footprint rather than
// its all-time peak -- computeYearNodes below resolves actual overlaps
// live with a force simulation, so home spacing no longer has to reserve
// space for a worst case that may never really happen. A distributor's
// on-screen position changes only when its actual parent_id changes
// between years (the visual cue for a merger/acquisition), or when a
// crowded year nudges it slightly off home to avoid overlapping a
// neighbor -- both are small, meaningful movements, not a full reshuffle.
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
  // position stable within its parent and gives it room to grow into.
  const childOffset = new Map(); // parent_id -> Map(distributor_id -> {dx, dy})
  childMaxByParent.forEach((kidsMap, parentId) => {
    const padded = Array.from(kidsMap, ([id, value]) => ({ id, r: rScale0(value) + CHILD_SUB_PADDING }));
    d3.packSiblings(padded);
    const enclosing = d3.packEnclose(padded);
    const offsets = new Map();
    padded.forEach(c => offsets.set(c.id, { dx: c.x - enclosing.x, dy: c.y - enclosing.y }));
    childOffset.set(parentId, offsets);
  });

  // Typical (median, not peak) ring radius this parent has actually needed
  // across its history, replaying real years through the same
  // enclosing-radius formula the per-year renderer uses.
  const parentFootprint = new Map(); // parent_id -> typical ring radius
  const rowsByParent = d3.group(allRows.filter(r => r.parent_id), r => r.parent_id);
  childMaxByParent.forEach((kidsMap, parentId) => {
    const offsets = childOffset.get(parentId);
    const byYear = d3.group(rowsByParent.get(parentId) || [], r => r.year);
    const reaches = [];
    byYear.forEach(yearRows => {
      let reach = 0;
      yearRows.forEach(row => {
        const offset = offsets.get(row.distributor_id) || { dx: 0, dy: 0 };
        reach = Math.max(reach, Math.hypot(offset.dx, offset.dy) + rScale0(row.title_count));
      });
      reaches.push(reach);
    });
    parentFootprint.set(parentId, (d3.median(reaches) || 0) + PARENT_RING_PADDING);
  });

  // Independents cluster together as ONE blob rather than being scattered
  // individually into whatever gaps the master pack finds -- same
  // fixed-offset-within-a-shared-anchor technique as childOffset above,
  // just with a single implicit "parent" (the independent cluster itself)
  // instead of a real studio. Sorting descending keeps the biggest
  // independents most central within their own cluster.
  const standalonePadded = Array.from(standaloneMax, ([id, value]) => ({ id, r: rScale0(value) + STANDALONE_PADDING }));
  standalonePadded.sort((a, b) => b.r - a.r);
  d3.packSiblings(standalonePadded);
  const standaloneEnclosing = d3.packEnclose(standalonePadded);
  const standaloneOffset = new Map();
  standalonePadded.forEach(c => standaloneOffset.set(c.id, { dx: c.x - standaloneEnclosing.x, dy: c.y - standaloneEnclosing.y }));

  // Typical (median) footprint of the whole independent cluster, same
  // replay-real-years approach as parentFootprint above.
  const standaloneByYear = d3.group(allRows.filter(r => !r.parent_id), r => r.year);
  const standaloneReaches = [];
  standaloneByYear.forEach(yearRows => {
    let reach = 0;
    yearRows.forEach(row => {
      const offset = standaloneOffset.get(row.distributor_id) || { dx: 0, dy: 0 };
      reach = Math.max(reach, Math.hypot(offset.dx, offset.dy) + rScale0(row.title_count));
    });
    standaloneReaches.push(reach);
  });
  const independentFootprint = (d3.median(standaloneReaches) || 0) + PARENT_RING_PADDING;

  // Pack every parent PLUS the single independent-cluster blob together in
  // ONE pass, sorted biggest-first, so the whole thing forms a single
  // touching mosaic -- no artificial boundary between "the parent zone"
  // and "the independents zone", just two (now internally-clustered)
  // macro-units bordering each other like any other pair of neighbors. A
  // front-chain packer (which is what packSiblings is) naturally keeps the
  // earliest (largest) circles most central and nests each new, smaller
  // circle into the gaps of the existing mass.
  const masterCircles = [];
  parentFootprint.forEach((r, parentId) => masterCircles.push({ id: parentId, r: r + PARENT_TOP_PADDING, isParent: true }));
  masterCircles.push({ id: '__independents__', r: independentFootprint, isParent: false, isIndependentCluster: true });
  masterCircles.sort((a, b) => b.r - a.r);

  d3.packSiblings(masterCircles);
  const masterEnclosing = d3.packEnclose(masterCircles);
  const fitScale = (Math.min(CANVAS_WIDTH, CANVAS_HEIGHT) / (2 * masterEnclosing.r)) * 0.985;
  const translateX = CANVAS_WIDTH / 2 - masterEnclosing.x * fitScale;
  const translateY = CANVAS_HEIGHT / 2 - masterEnclosing.y * fitScale;

  const parentHome = new Map();
  let independentClusterHome = null;
  masterCircles.forEach(c => {
    const pos = { x: c.x * fitScale + translateX, y: c.y * fitScale + translateY };
    if (c.isIndependentCluster) independentClusterHome = pos;
    else parentHome.set(c.id, pos);
  });

  const scaledChildOffset = new Map();
  childOffset.forEach((offsets, parentId) => {
    const scaled = new Map();
    offsets.forEach((o, id) => scaled.set(id, { dx: o.dx * fitScale, dy: o.dy * fitScale }));
    scaledChildOffset.set(parentId, scaled);
  });

  const rScale = d3.scaleSqrt().domain([0, maxValue]).range([0, MAX_LEAF_RADIUS * fitScale]);
  const ringPadding = PARENT_RING_PADDING * fitScale;

  return {
    parentHome,
    independentClusterHome,
    childOffset: scaledChildOffset,
    rScale,
    ringPadding
  };
}

// Resolves a set of entries (each with a fixed .home and .r) into actual
// this-year positions with a short, deterministic force simulation: every
// node starts pinned to its centroid-blended target and is pulled back
// toward it, while a collision force nudges apart only whichever nodes
// actually overlap at their real this-year size. Nodes are always given
// explicit starting x/y (never left for d3-force to randomize), so the
// same input always resolves to the exact same positions -- this is what
// keeps "2010 is loosely packed, 1996 is dense" from ever looking
// different between visits.
//
// Home positions are laid out once from *every* entity a group (all
// parents, or all ever-standalone distributors) has across all 36 years,
// but any single year only activates a fraction of them -- so the active
// ones can land in different neighborhoods of that full arrangement,
// separated by gaps where currently-dormant entities' homes sit. Blending
// each active node's home toward *this year's active* centroid pulls
// everything into one compact, bordering mass instead of leaving it
// scattered around old gaps. Used twice: once for the macro layout
// (parent rings + the independent cluster as a whole), and again inside
// the independent cluster itself (this year's active independents against
// each other) -- same gap, same fix, one level deeper.
function resolveCluster(entries, blendStrength, collidePad = 3, ticks = 300, forceStrength = 0.3) {
  if (entries.length === 0) return [];
  const centroid = entries.length > 1
    ? { x: d3.mean(entries, e => e.home.x), y: d3.mean(entries, e => e.home.y) }
    : null;

  const nodes = entries.map(e => {
    if (!centroid) return { ...e, target: e.home, x: e.home.x, y: e.home.y };
    const target = {
      x: e.home.x + (centroid.x - e.home.x) * blendStrength,
      y: e.home.y + (centroid.y - e.home.y) * blendStrength
    };
    return { ...e, target, x: target.x, y: target.y };
  });

  const simulation = d3.forceSimulation(nodes)
    .force('x', d3.forceX(d => d.target.x).strength(forceStrength))
    .force('y', d3.forceY(d => d.target.y).strength(forceStrength))
    .force('collide', d3.forceCollide(d => d.r + collidePad).strength(1))
    .stop();
  for (let i = 0; i < ticks; i += 1) simulation.tick();
  return nodes;
}

const MACRO_BLEND = 0.85; // parents + the independent cluster, against each other

function resolveMacroLayout(entries) {
  return resolveCluster(entries, MACRO_BLEND);
}

function computeYearNodes(rows, layout) {
  const parentGrouped = d3.group(rows.filter(d => d.parent_id), d => d.parent_id);
  const standaloneRows = rows.filter(d => !d.parent_id);
  const macroEntries = [];

  parentGrouped.forEach(groupRows => {
    const parentId = groupRows[0].parent_id;
    const home = layout.parentHome.get(parentId) || { x: CANVAS_WIDTH / 2, y: CANVAS_HEIGHT / 2 };
    const offsets = layout.childOffset.get(parentId) || new Map();
    let maxReach = 0;
    groupRows.forEach(row => {
      const offset = offsets.get(row.distributor_id) || { dx: 0, dy: 0 };
      maxReach = Math.max(maxReach, Math.hypot(offset.dx, offset.dy) + layout.rScale(row.title_count));
    });
    macroEntries.push({ kind: 'parent', parentId, groupRows, offsets, r: maxReach + layout.ringPadding, home });
  });

  if (standaloneRows.length) {
    // Only a fraction of all ever-standalone distributors are active in any
    // given year -- sometimes just a handful, out of ~124 across all 36
    // years -- so a fixed all-time offset (the childOffset technique used
    // for real parents above) leaves this year's few active ones scattered
    // across gaps left by whichever neighbors are currently dormant, with
    // no guarantee a short force simulation pulls severe outliers back in.
    // A real parent doesn't have this problem because it only ever has a
    // handful of children total. So instead: pack THIS YEAR's active
    // independents fresh, every year, with the same front-chain packer
    // used everywhere else in this layout -- guarantees a fully touching,
    // gap-free cluster by construction, at the cost of an independent's
    // exact spot inside the cluster (not its cluster membership, color, or
    // overall on-screen neighborhood) being free to shift slightly year to
    // year as the active set changes.
    const anchor = layout.independentClusterHome || { x: CANVAS_WIDTH / 2, y: CANVAS_HEIGHT / 2 };
    const padded = standaloneRows.map(row => ({ row, r: layout.rScale(row.title_count) }));
    padded.sort((a, b) => b.r - a.r);
    d3.packSiblings(padded);
    const enclosing = d3.packEnclose(padded);
    let clusterReach = 0;
    const relativeSub = padded.map(c => {
      const dx = c.x - enclosing.x;
      const dy = c.y - enclosing.y;
      clusterReach = Math.max(clusterReach, Math.hypot(dx, dy) + c.r);
      return { row: c.row, r: c.r, dx, dy };
    });
    macroEntries.push({ kind: 'independentCluster', relativeSub, r: clusterReach + layout.ringPadding, home: anchor });
  }

  const resolved = resolveMacroLayout(macroEntries);
  const parentNodes = [];
  const allLeaves = [];

  resolved.forEach(node => {
    if (node.kind === 'independentCluster') {
      node.relativeSub.forEach(sub => {
        const row = sub.row;
        allLeaves.push({
          x: node.x + sub.dx,
          y: node.y + sub.dy,
          r: sub.r,
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
      });
      return;
    }

    const children = node.groupRows.map(row => {
      const offset = node.offsets.get(row.distributor_id) || { dx: 0, dy: 0 };
      return {
        x: node.x + offset.dx,
        y: node.y + offset.dy,
        r: layout.rScale(row.title_count),
        data: {
          id: row.distributor_id,
          name: row.distributor_label,
          value: row.title_count,
          parentId: node.parentId,
          type: 'distributor',
          isBranded: isBrandedDistributor(row.distributor_id),
          year: row.year,
          color: leafColor(row.distributor_id, parentColor(node.parentId))
        }
      };
    });

    parentNodes.push({
      x: node.x,
      y: node.y,
      r: node.r,
      data: {
        id: node.parentId,
        name: node.groupRows[0].parent_label,
        type: 'parent',
        color: parentColor(node.parentId)
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

  const size = pickCanvasSize();
  CANVAS_WIDTH = size.width;
  CANVAS_HEIGHT = size.height;

  layout = computeFixedLayout(allRows);
  initChart();
  goToIndex(0);
}).catch(error => {
  chartEl.innerHTML = `<p style="color:#ffb4b4; padding: 1rem;">Could not load the CSV file. Make sure <code>distributor_title_counts.csv</code> is in the same folder as these files.</p>`;
  console.error(error);
});
