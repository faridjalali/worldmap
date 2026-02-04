
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
// ... rest of initGlobe logic unchanged ...
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
    .on("start", (event) => {
      isDragging = true;
      // No need to stop timer, it checks the flag
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
      // Delay resuming auto-rotation slightly for smoother feel
      setTimeout(() => { isDragging = false; }, 50);
    });

  svg.call(drag)
     .style("touch-action", "none");

  try {
    const topo = await fetchFirstOk(SOURCES.topo, "World Atlas");
    const countries = await fetchFirstOk(SOURCES.countries, "World Countries");

    // Build map from CCN3 to Continent
    const byCcn3 = new Map();
    countries.forEach(c => {
      if (c.ccn3) byCcn3.set(pad3(c.ccn3), c);
    });

    // MANUAL INJECTION: Ensure Kosovo (383) exists for Globe
    if (!byCcn3.has("383")) {
      byCcn3.set("383", {
        name: { common: "Kosovo" },
        ccn3: "383",
        region: "Europe",
        subregion: "Southeast Europe"
      });
    }

    const world = topojson.feature(topo, topo.objects.countries);
    features = world.features;

    // PATCH: Fix Disputed Territories (Somaliland, Kosovo)
    features.forEach(f => {
      if (f.id === -99 || f.id === "-99") {
        const centroid = d3.geoCentroid(f);
        // Somaliland -> Somalia
        if (centroid[1] > 5 && centroid[1] < 15 && centroid[0] > 40 && centroid[0] < 55) {
          f.id = "706";
        }
        // Kosovo
        else if (centroid[1] > 40 && centroid[1] < 45 && centroid[0] > 19 && centroid[0] < 23) {
          f.id = "383"; 
        }
      }
    });

    // Map features to continent/name AFTER patching IDs
    features = features.map(f => {
      const meta = byCcn3.get(pad3(f.id));
      if (meta) {
        f.properties.continent = resolveContinent(meta);
        f.properties.name = meta.name.common;
      }
      return f;
    });

    // Start Persistent Loop
    startRotationLoop();

  } catch (err) {
    console.error("Globe Init Error:", err);
    container.innerHTML = `<div class='map-error'>Failed to load globe: ${err.message}</div>`;
  }
}

// ... (GLOBE_COLORS and render function unchanged) ...

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
