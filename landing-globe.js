
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

window.addEventListener("load", () => {
   if (window.d3) {
      initGlobe();
   } else {
      // Fallback: wait a bit if D3 is racing
      const checkD3 = setInterval(() => {
         if (window.d3) {
            clearInterval(checkD3);
            initGlobe();
         }
      }, 50);
   }
});
window.addEventListener("resize", handleResize);

async function initGlobe() {
  const container = document.getElementById("continent-map");
  if (!container) return;
  // Safety check for D3 again
  if (!window.d3) {
     console.error("D3 loading failed.");
     return;
  }

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
  let hasMoved = false; 
  let startX = 0, startY = 0;
  
  const drag = d3.drag()
    .on("start", (event) => {
      isDragging = true;
      hasMoved = false;
      startX = event.x;
      startY = event.y;
    })
    .on("drag", (event) => {
      // Calculate total distance from start
      const dx = event.x - startX;
      const dy = event.y - startY;
      const dist = Math.sqrt(dx*dx + dy*dy);
      
      // If we moved more than 5 pixels total, it's a drag
      if (dist > 5) hasMoved = true;
      
      const sensitivity = 75 / projection.scale();
      const rotate = projection.rotate();
      const k = sensitivity; 
      // Use event.dx here for relative rotation update
      projection.rotate([
        rotate[0] + event.dx * k,
        rotate[1] - event.dy * k
      ]);
      render();
    })
    .on("end", () => {
      isDragging = false;
    });

  svg.call(drag)
     .style("touch-action", "none");

  // ... (rest of setup) ...

  // Render Logic - Ensure click works
  const countries = g.selectAll(".country")
    .data(features);

  countries.enter().append("path")
    .attr("class", "country globe-country")
    .merge(countries)
    .attr("d", path)
    .attr("data-continent", d => d.properties.continent)
    .style("fill", d => GLOBE_COLORS.continents[d.properties.continent] || GLOBE_COLORS.default)
    .style("stroke", GLOBE_COLORS.stroke)
    .on("mouseover", function(e, d) {
       if (isDragging || hasMoved) return; // Don't highlight if dragging
       const cont = d.properties.continent;
       if (!cont) return;
       d3.selectAll(`.country[data-continent='${cont}']`)
         .style("filter", "brightness(0.7)") 
         .style("stroke", "rgba(255,255,255,0.6)")
         .style("stroke-width", "1px");
       const tt = document.getElementById("continent-tooltip");
       tt.innerText = formatContinentName(cont);
       tt.style.opacity = 1;
       tt.style.left = (e.pageX + 10) + "px";
       tt.style.top = (e.pageY - 20) + "px";
    })
    .on("mouseout", function(e, d) {
       const cont = d.properties.continent;
       d3.selectAll(`.country[data-continent='${cont}']`)
         .style("filter", null)
         .style("stroke", GLOBE_COLORS.stroke)
         .style("stroke-width", null);
       document.getElementById("continent-tooltip").style.opacity = 0;
    })
    .on("click", function(e, d) {
       // Robust check: If we moved, it's a drag, ignore click.
       if (hasMoved) return; 
       
       const cont = d.properties.continent;
       if (cont) {
         window.location.href = `./quiz.html?continent=${cont}`;
       }
    });

function startRotationLoop() {
  // Single persistent timer
  d3.timer((elapsed) => {
    if (isDragging) return; // User is in control, do nothing
    
    // Auto-rotate
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
