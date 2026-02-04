
const SOURCES = {
  topo: [
    "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json",
    "https://unpkg.com/world-atlas@2/countries-110m.json"
  ],
  countries: [
    "https://cdn.jsdelivr.net/npm/world-countries@5.1.0/countries.json",
    "https://unpkg.com/world-countries@5.1.0/countries.json"
  ]
};

let width, height;
let svg, g, projection, path;
let features = [];
let gameData = {}; // To store continent mapping
let isDragging = false;
let rotationTimer;

window.addEventListener("load", initGlobe);
window.addEventListener("resize", handleResize);

async function initGlobe() {
  const container = document.getElementById("continent-map");
  if (!container) return;

  width = container.clientWidth;
  height = container.clientHeight;

  svg = d3.select(container).append("svg")
    .attr("class", "world-svg")
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("preserveAspectRatio", "xMidYMid meet");

  g = svg.append("g");

  // Setup Orthographic Projection (3D Globe)
  // Responsive Scale: Fit within the smaller dimension
  const size = Math.min(width, height);
  const scale = (size / 2) * 0.9;

  projection = d3.geoOrthographic()
    .scale(scale)
    .center([0, 0])
    .translate([width / 2, height / 2])
    .clipAngle(90); // Clips back-face

  path = d3.geoPath().projection(projection);

  // Drag behavior for rotation
  const drag = d3.drag()
    .on("start", () => {
      isDragging = true;
      if (rotationTimer) rotationTimer.stop();
    })
    .on("drag", (event) => {
      const sensitivity = 75 / projection.scale();
      const rotate = projection.rotate();
      const k = sensitivity; 
      projection.rotate([
        rotate[0] + event.dx * k,
        rotate[1] - event.dy * k
      ]);
      render();
    })
    .on("end", () => {
      isDragging = false;
      startRotation();
    });

  svg.call(drag);

  try {
    const topo = await fetchFirstOk(SOURCES.topo, "World Atlas");
    const countries = await fetchFirstOk(SOURCES.countries, "World Countries");

    // Build map from CCN3 to Continent
    const byCcn3 = new Map();
    countries.forEach(c => {
      if (c.ccn3) byCcn3.set(pad3(c.ccn3), c);
    });

    const world = topojson.feature(topo, topo.objects.countries);
    features = world.features.map(f => {
      const meta = byCcn3.get(pad3(f.id));
      if (meta) {
        f.properties.continent = resolveContinent(meta);
        f.properties.name = meta.name.common;
      }
      return f;
    });

    // Render Globe
    render();
    startRotation();

  } catch (err) {
    console.error("Globe Init Error:", err);
    container.innerHTML = `<div class='map-error'>Failed to load globe: ${err.message}</div>`;
  }
}

const GLOBE_COLORS = {
  ocean: "#006994", // Traditional Ocean Blue
  continents: {
    "north-america": "#e6c288", // Sandy/Yellow
    "south-america": "#a8c686", // Muted Green
    "europe": "#d8a499",        // Muted Pink/Red
    "africa": "#e8d8a5",        // Desert Yellow
    "asia": "#c4a484",          // Earthy Brown
    "oceania": "#99badd"        // Light Blue/Teal
  },
  default: "#d0d0d0",
  stroke: "rgba(0,0,0,0.3)" // Subtle dark borders
};

function render() {
  // Define sphere background (ocean)
  g.selectAll(".ocean").remove();
  g.insert("path", ".country")
    .datum({type: "Sphere"})
    .attr("class", "ocean")
    .attr("d", path)
    .attr("fill", GLOBE_COLORS.ocean)
    .attr("stroke", "rgba(0, 0, 0, 0.5)")
    .attr("stroke-width", 1);


  const countries = g.selectAll(".country")
    .data(features);

  countries.enter().append("path")
    .attr("class", "country globe-country") // Added specific class
    .merge(countries)
    .attr("d", path)
    .attr("data-continent", d => d.properties.continent)
    // Apply Traditional Colors using STYLE to override CSS
    .style("fill", d => GLOBE_COLORS.continents[d.properties.continent] || GLOBE_COLORS.default)
    .style("stroke", GLOBE_COLORS.stroke)
    .on("mouseover", function(e, d) {
       if (isDragging) return;
       const cont = d.properties.continent;
       if (!cont) return;
       
       // Highlight (brighten) all countries in this continent
       d3.selectAll(`.country[data-continent='${cont}']`)
         .style("filter", "brightness(1.5)") // Popped/Brighter
         .style("stroke", "rgba(255,255,255,0.8)") // Add white border pop
         .style("stroke-width", "1px");
       
       // Show Tooltip
       const tt = document.getElementById("continent-tooltip");
       tt.innerText = formatContinentName(cont);
       tt.style.opacity = 1;
       tt.style.left = (e.pageX + 10) + "px";
       tt.style.top = (e.pageY - 20) + "px";
    })
    .on("mouseout", function(e, d) {
       const cont = d.properties.continent;
       if (cont) {
          d3.selectAll(`.country[data-continent='${cont}']`)
            .style("filter", null)
            .style("stroke", GLOBE_COLORS.stroke)
            .style("stroke-width", null);
       }
       document.getElementById("continent-tooltip").style.opacity = 0;
    })
    .on("click", function(e, d) {
       if (isDragging) return;
       const cont = d.properties.continent;
       if (cont) {
         window.location.href = `./quiz.html?continent=${cont}`;
       }
    });
}

function startRotation() {
  if (rotationTimer) rotationTimer.stop();
  rotationTimer = d3.timer((elapsed) => {
    const rotate = projection.rotate();
    const k = 0.2; // Rotation speed
    projection.rotate([rotate[0] + k, rotate[1]]);
    render();
  });
}

function handleResize() {
  if (!svg) return;
  const container = document.getElementById("continent-map");
  if (!container) return;
  
  width = container.clientWidth;
  height = container.clientHeight;
  
  // Responsive Scale: Fit within the smaller dimension with some padding
  const size = Math.min(width, height);
  const scale = (size / 2) * 0.9; // 90% of radius

  svg.attr("viewBox", `0 0 ${width} ${height}`);
  projection.translate([width / 2, height / 2]).scale(scale);
  render();
}

// Reuse helpers from index.js / quiz.js (duplicated effectively since modules don't share easily without refactor)
function pad3(n) {
  const s = String(n);
  return s.length >= 3 ? s : s.padStart(3, "0");
}

function resolveContinent(meta) {
  const region = (meta.region || "").toLowerCase();
  const subregion = (meta.subregion || "").toLowerCase();

  if (region === "americas") {
    if (subregion.includes("south")) return "south-america";
    return "north-america";
  }
  if (region === "europe") return "europe";
  if (region === "africa") return "africa";
  if (region === "asia") return "asia";
  if (region === "oceania") return "oceania";
  return null;
}

function formatContinentName(slug) {
  if (!slug) return "";
  return slug.split("-")
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

async function fetchFirstOk(urls, label) {
  let lastErr = null;
  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${label} fetch failed`);
      return await res.json();
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`${label} failed.`);
}
