const chartEl = document.getElementById('chart');
const tooltip = document.getElementById('tooltip');
const yearValue = document.getElementById('yearValue');
const totalValue = document.getElementById('totalValue');

const parentPalette = new Map([
  ['time_warner', '#5B8FF9'],
  ['sony', '#61DDAA'],
  ['disney', '#F6BD16'],
  ['seagram', '#9661BC'],
  ['news_corp', '#F6903D'],
  ['viacom', '#8b5cf6']
]);

function getStandaloneColor(id) {
  const colors = ['#78D3F8', '#65789B', '#008685', '#F08BB4', '#94a3b8', '#22c55e', '#f97316'];
  let total = 0;
  for (let i = 0; i < id.length; i += 1) total += id.charCodeAt(i);
  return colors[total % colors.length];
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

function buildHierarchy(rows) {
  const grouped = d3.group(rows, d => d.parent_id || `standalone__${d.distributor_id}`);

  const children = Array.from(grouped, ([groupKey, groupRows]) => {
    const first = groupRows[0];
    const hasParent = !!first.parent_id;

    if (!hasParent) {
      const row = first;
      return {
        id: row.distributor_id,
        name: row.distributor_label,
        value: row.title_count,
        type: 'distributor',
        isStandalone: true,
        year: row.year,
        color: getStandaloneColor(row.distributor_id)
      };
    }

    return {
      id: first.parent_id,
      name: first.parent_label,
      type: 'parent',
      color: parentPalette.get(first.parent_id) || '#6ea8fe',
      children: groupRows.map(row => ({
        id: row.distributor_id,
        name: row.distributor_label,
        value: row.title_count,
        parentId: row.parent_id,
        type: 'distributor',
        year: row.year,
        color: parentPalette.get(row.parent_id) || '#6ea8fe'
      }))
    };
  });

  return { name: 'root', children };
}

function render(rows) {
  chartEl.innerHTML = '';
  const width = chartEl.clientWidth;
  const height = Math.max(window.innerHeight * 0.7, 620);
  const totalTitles = d3.sum(rows, d => d.title_count);
  const year = rows[0]?.year || '2000';

  yearValue.textContent = year;
  totalValue.textContent = totalTitles;

  const data = buildHierarchy(rows);
  const root = d3.hierarchy(data)
    .sum(d => d.value || 0)
    .sort((a, b) => (b.value || 0) - (a.value || 0));

  d3.pack()
    .size([width, height])
    .padding(d => d.depth === 1 ? 16 : 6)(root);

  const svg = d3.select(chartEl)
    .append('svg')
    .attr('viewBox', `0 0 ${width} ${height}`)
    .attr('aria-hidden', 'true');

  const parentNodes = root.descendants().filter(d => d.depth === 1 && d.children);
  const standaloneNodes = root.descendants().filter(d => d.depth === 1 && !d.children);
  const distributorNodes = root.leaves().filter(d => d.depth === 2);

  const parentGroup = svg.append('g').attr('class', 'parents');
  const childGroup = svg.append('g').attr('class', 'children');

  const parents = parentGroup.selectAll('g.parent-node')
    .data(parentNodes, d => d.data.id)
    .join('g')
    .attr('class', 'parent-node')
    .attr('transform', d => `translate(${d.x},${d.y})`);

  parents.append('circle')
    .attr('r', 0)
    .attr('fill', d => d.data.color)
    .transition()
    .duration(900)
    .ease(d3.easeCubicOut)
    .attr('r', d => d.r);

  parents.each(function(d) {
    if (d.r < 52) return;
    const lines = wrapLabel(d.data.name, d.r > 110 ? 18 : 14);
    const label = d3.select(this).append('text').attr('class', 'parent-label');
    lines.forEach((line, index) => {
      label.append('tspan')
        .attr('x', 0)
        .attr('dy', index === 0 ? '-0.1em' : '1.05em')
        .text(line);
    });
  });

  const allLeaves = distributorNodes.concat(standaloneNodes);

  const nodes = childGroup.selectAll('g.child-node')
    .data(allLeaves, d => d.data.id)
    .join('g')
    .attr('class', d => `child-node${d.data.isStandalone ? ' is-standalone' : ''}`)
    .attr('transform', d => `translate(${d.x},${d.y})`)
    .attr('tabindex', 0);

  nodes.append('circle')
    .attr('r', 0)
    .attr('fill', d => d.data.color)
    .transition()
    .duration(950)
    .ease(d3.easeCubicOut)
    .attr('r', d => d.r);

  nodes.each(function(d) {
    const showLabel = d.r > 25;
    if (!showLabel) return;
    const lines = wrapLabel(d.data.name, d.r > 52 ? 16 : 12);
    const label = d3.select(this).append('text').attr('class', 'child-label');

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
      .text(`${d.data.value} films`);
  });

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

d3.csv('distributor_title_counts.csv', d => ({
  year: d.year,
  parent_id: d.parent_id?.trim() || '',
  parent_label: d.parent_label?.trim() || '',
  distributor_id: d.distributor_id?.trim(),
  distributor_label: d.distributor_label?.trim(),
  title_count: +d.title_count
})).then(rows => {
  render(rows);
  window.addEventListener('resize', () => render(rows));
}).catch(error => {
  chartEl.innerHTML = `<p style="color:#ffb4b4; padding: 1rem;">Could not load the CSV file. Make sure <code>distributor_title_counts.csv</code> is in the same folder as these files.</p>`;
  console.error(error);
});
