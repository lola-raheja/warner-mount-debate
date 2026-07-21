const chartEl = document.getElementById('chart');
const tooltip = document.getElementById('tooltip');
const yearValue = document.getElementById('yearValue');
const totalValue = document.getElementById('totalValue');

const palette = [
  '#5B8FF9', '#61DDAA', '#65789B', '#F6BD16', '#7262FD', '#78D3F8',
  '#9661BC', '#F6903D', '#008685', '#F08BB4', '#3b82f6', '#8b5cf6'
];

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function wrapLabel(name, maxChars = 14) {
  if (name.length <= maxChars) return [name];
  const words = name.split(' ');
  const lines = [];
  let current = '';
  words.forEach(word => {
    const test = current ? current + ' ' + word : word;
    if (test.length <= maxChars) {
      current = test;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  });
  if (current) lines.push(current);
  return lines.slice(0, 2);
}

function render(data) {
  chartEl.innerHTML = '';
  const width = chartEl.clientWidth;
  const height = Math.max(window.innerHeight * 0.68, 560);

  const totalTitles = d3.sum(data, d => d.value);
  const year = data[0]?.year || '2000';
  yearValue.textContent = year;
  totalValue.textContent = totalTitles;

  const color = d3.scaleOrdinal()
    .domain(data.map(d => d.name))
    .range(palette.concat(palette));

  const root = d3.hierarchy({ children: data }).sum(d => d.value);
  d3.pack().size([width, height]).padding(10)(root);

  const svg = d3.select(chartEl)
    .append('svg')
    .attr('viewBox', `0 0 ${width} ${height}`)
    .attr('aria-hidden', 'true');

  const defs = svg.append('defs');
  const gradient = defs.append('linearGradient')
    .attr('id', 'bubbleGradient')
    .attr('x1', '0%')
    .attr('x2', '100%')
    .attr('y1', '0%')
    .attr('y2', '100%');

  gradient.append('stop').attr('offset', '0%').attr('stop-color', '#7dd3fc');
  gradient.append('stop').attr('offset', '100%').attr('stop-color', '#8b5cf6');

  const nodes = svg.selectAll('g.node')
    .data(root.leaves(), d => d.data.id)
    .join('g')
    .attr('class', 'node')
    .attr('transform', d => `translate(${d.x},${d.y})`);

  nodes.append('circle')
    .attr('r', 0)
    .style('fill', d => color(d.data.name))
    .transition()
    .duration(900)
    .ease(d3.easeCubicOut)
    .attr('r', d => d.r);

  nodes.each(function(d) {
    const group = d3.select(this);
    const lines = wrapLabel(d.data.name, d.r > 55 ? 16 : 12);
    const showLabel = d.r > 28;
    if (!showLabel) return;

    const label = group.append('text').attr('class', 'label');
    lines.forEach((line, index) => {
      label.append('tspan')
        .attr('x', 0)
        .attr('dy', index === 0 ? (lines.length === 1 ? '-0.1em' : '-0.4em') : '1.05em')
        .style('font-size', `${Math.max(10, Math.min(18, d.r / 3.2))}px`)
        .text(line);
    });
    label.append('tspan')
      .attr('class', 'count')
      .attr('x', 0)
      .attr('dy', '1.15em')
      .style('font-size', `${Math.max(9, Math.min(15, d.r / 4.4))}px`)
      .text(`${d.data.value} films`);
  });

  nodes
    .on('mouseenter focus', function(event, d) {
      d3.selectAll('.node').classed('is-active', false);
      d3.select(this).classed('is-active', true);
      tooltip.hidden = false;
      tooltip.innerHTML = `<strong>${d.data.name}</strong><span>${d.data.value} wide-release films in ${d.data.year}</span>`;
    })
    .on('mouseleave blur', function() {
      d3.select(this).classed('is-active', false);
      tooltip.hidden = true;
    });
}

d3.csv('distributor_title_counts.csv', d => ({
  id: slugify(d.distributor_norm),
  name: d.distributor_norm,
  value: +d.title_count,
  year: d.year
})).then(data => {
  render(data.sort((a, b) => d3.descending(a.value, b.value)));
  window.addEventListener('resize', () => render(data));
}).catch(error => {
  chartEl.innerHTML = `<p style="color:#ffb4b4; padding: 1rem;">Could not load the CSV file. Make sure <code>distributor_title_counts.csv</code> is in the same folder as these files.</p>`;
  console.error(error);
});
