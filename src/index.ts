import * as d3 from "d3";
import * as topojson from "topojson-client";
import { SOURCES, CONTINENTS, pad3, fetchFirstOk, resolveContinent, CountryMeta } from "./utils";

const mapContainer = document.getElementById("continent-map");
const tooltip = document.getElementById("continent-tooltip");

let svg: any;
let g: any;
let projection: d3.GeoProjection;
let path: d3.GeoPath;
let features: any[] = [];

window.addEventListener("load", init);

async function init() {
  if (!mapContainer) return;

  try {
    const topo = await fetchFirstOk<any>(SOURCES.topo, "World Atlas");
    const countries = await fetchFirstOk<any[]>(SOURCES.countries, "World Countries");

    const byCcn3 = new Map<string, CountryMeta>();
    for (const c of countries) {
      if (!c.ccn3) continue;
      byCcn3.set(pad3(c.ccn3), c);
    }

    const world = topojson.feature(topo, topo.objects.countries) as any;
    features = world.features
      .map((f: any) => {
        const idKey = pad3(f.id);
        const meta = byCcn3.get(idKey);
        const continent = meta ? resolveContinent(meta) : null;
        return { ...f, __id: idKey, __meta: meta, __continent: continent };
      })
      .filter((f: any) => f.__continent);

    buildSvg();
    render();
  } catch (err: any) {
    console.error(err);
    if (mapContainer) mapContainer.innerHTML = `<div class="map-error">${err.message}</div>`;
  }
}

function buildSvg() {
  if (!mapContainer) return;

  svg = d3.select(mapContainer as HTMLElement)
    .append("svg")
    .attr("class", "world-svg")
    .attr("preserveAspectRatio", "xMidYMid meet");

  g = svg.append("g");

  g.selectAll("path")
    .data(features)
    .enter()
    .append("path")
    .attr("class", "country")
    .attr("data-continent", (d: any) => d.__continent)
    .attr("fill", "rgba(120,180,220,0.25)")
    .attr("stroke", "rgba(255,255,255,0.15)")
    .on("mouseover", handleHover)
    .on("mousemove", moveTooltip)
    .on("mouseout", clearHover)
    .on("click", handleClick);
}

function render() {
  if (!mapContainer || !svg) return;
  const rect = mapContainer.getBoundingClientRect();
  const width = Math.max(360, rect.width || 0);
  const height = Math.max(360, rect.height || 0);

  svg.attr("width", width).attr("height", height).attr("viewBox", `0 0 ${width} ${height}`);

  projection = d3.geoNaturalEarth1().fitSize([width, height], {
    type: "FeatureCollection",
    features
  } as any);

  path = d3.geoPath().projection(projection);
  g.selectAll("path").attr("d", path as any);
}

window.addEventListener("resize", render);

function handleHover(event: MouseEvent, d: any) {
  const key = d.__continent;
  if (!key) return;

  d3.selectAll(".country")
    .classed("highlight", (f: any) => f.__continent === key)
    .classed("dim", (f: any) => f.__continent !== key);

  if (tooltip) {
    tooltip.textContent = CONTINENTS[key].label;
    tooltip.style.opacity = "1";
    moveTooltip(event);
  }
}

function clearHover() {
  d3.selectAll(".country").classed("highlight", false).classed("dim", false);
  if (tooltip) tooltip.style.opacity = "0";
}

function moveTooltip(event: MouseEvent) {
  if (!tooltip || !mapContainer) return;
  const bounds = mapContainer.getBoundingClientRect();
  tooltip.style.left = `${event.clientX - bounds.left + 12}px`;
  tooltip.style.top = `${event.clientY - bounds.top - 12}px`;
}

function handleClick(_event: MouseEvent, d: any) {
  const key = d.__continent;
  if (!key) return;
  window.location.href = `./quiz.html?continent=${key}`;
}
