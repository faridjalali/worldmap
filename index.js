
import { SOURCES, CONTINENTS, pad3, fetchFirstOk, resolveContinent } from "./utils.js";

const mapContainer = document.getElementById("continent-map");
const tooltip = document.getElementById("continent-tooltip");

let svg, g, projection, path, features = [];

window.addEventListener("load", init);

async function init() {
  if (!mapContainer) return;

  if (!window.d3 || !window.topojson) {
    mapContainer.innerHTML = `<div class="map-error">D3 or TopoJSON failed to load.</div>`;
    return;
  }

  try {
    const topo = await fetchFirstOk(SOURCES.topo, "World Atlas");
    const countries = await fetchFirstOk(SOURCES.countries, "World Countries");

    const byCcn3 = new Map();
    for (const c of countries) {
      if (!c.ccn3) continue;
      byCcn3.set(pad3(c.ccn3), c);
    }

    const world = topojson.feature(topo, topo.objects.countries);
    features = world.features
      .map(f => {
        const idKey = pad3(f.id);
        const meta = byCcn3.get(idKey);
        const continent = meta ? resolveContinent(meta) : null;
        return { ...f, __id: idKey, __meta: meta, __continent: continent };
      })
      .filter(f => f.__continent);

    buildSvg();
    render();
  } catch (err) {
    console.error(err);
    mapContainer.innerHTML = `<div class="map-error">${err.message}</div>`;
  }
}

function buildSvg() {
  svg = d3.select(mapContainer)
    .append("svg")
    .attr("class", "world-svg")
    .attr("preserveAspectRatio", "xMidYMid meet");

  g = svg.append("g");

  g.selectAll("path")
    .data(features)
    .enter()
    .append("path")
    .attr("class", "country")
    .attr("data-continent", d => d.__continent)
    .attr("fill", "rgba(120,180,220,0.25)")
    .attr("stroke", "rgba(255,255,255,0.15)")
    .on("mouseover", handleHover)
    .on("mousemove", moveTooltip)
    .on("mouseout", clearHover)
    .on("click", handleClick);
}

function render() {
  const rect = mapContainer.getBoundingClientRect();
  const width = Math.max(360, rect.width || 0);
  const height = Math.max(360, rect.height || 0);

  svg.attr("width", width).attr("height", height).attr("viewBox", `0 0 ${width} ${height}`);

  projection = d3.geoNaturalEarth1().fitSize([width, height], {
    type: "FeatureCollection",
    features
  });

  path = d3.geoPath().projection(projection);
  g.selectAll("path").attr("d", path);
}

window.addEventListener("resize", render);

function handleHover(event, d) {
  const key = d.__continent;
  if (!key) return;

  d3.selectAll(".country")
    .classed("highlight", f => f.__continent === key)
    .classed("dim", f => f.__continent !== key);

  tooltip.textContent = CONTINENTS[key].label;
  tooltip.style.opacity = 1;
  moveTooltip(event);
}

function clearHover() {
  d3.selectAll(".country").classed("highlight", false).classed("dim", false);
  tooltip.style.opacity = 0;
}

function moveTooltip(event) {
  const bounds = mapContainer.getBoundingClientRect();
  tooltip.style.left = `${event.clientX - bounds.left + 12}px`;
  tooltip.style.top = `${event.clientY - bounds.top - 12}px`;
}

function handleClick(event, d) {
  const key = d.__continent;
  if (!key) return;
  window.location.href = `./quiz.html?continent=${key}`;
}
