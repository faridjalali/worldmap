
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

// Global Module State
let width, height;
let svg, g, projection, path;
let features = [];
let isDragging = false;
let hasMoved = false; // Shared state for Click vs Drag
let rotationTimer;

window.addEventListener("load", () => {
   if (window.d3 && window.topojson) {
      initGlobe();
   } else {
      const checkDeps = setInterval(() => {
         if (window.d3 && window.topojson) {
            clearInterval(checkDeps);
            initGlobe();
         }
      }, 50);
   }
});
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

  // Setup Orthographic Projection
  const size = Math.min(width, height);
  const scale = (size / 2) * 0.9;

  projection = d3.geoOrthographic()
    .scale(scale)
    .center([0, 0])
    .translate([width / 2, height / 2])
    .clipAngle(90);

  path = d3.geoPath().projection(projection);

  // Drag Behavior with Euclidean Distance Check
  let startX = 0, startY = 0;
  
  const drag = d3.drag()
    .on("start", (event) => {
      isDragging = true;
      hasMoved = false; // Reset module-level flag
      startX = event.x;
      startY = event.y;
    })
    .on("drag", (event) => {
      const dx = event.x - startX;
      const dy = event.y - startY;
      const dist = Math.sqrt(dx*dx + dy*dy);
      
      if (dist > 5) hasMoved = true;
      
      const sensitivity = 75 / projection.scale();
      const rotate = projection.rotate();
      projection.rotate([
        rotate[0] + event.dx * sensitivity,
        rotate[1] - event.dy * sensitivity
      ]);
      render();
    })
    .on("end", () => {
      isDragging = false;
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

    // Manual Injection: Kosovo (383)
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

    // Patch Disputed Territories
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

    // Assign Metadata
    features = features.map(f => {
      const meta = byCcn3.get(pad3(f.id));
      if (meta) {
        f.properties.continent = resolveContinent(meta);
        f.properties.name = meta.name.common;
      }
      return f;
    });

    // Start Loop
    startRotationLoop();

  } catch (err) {
    console.error("Globe Init Error:", err);
    container.innerHTML = `<div class='map-error'>Failed to load globe: ${err.message}</div>`;
  }
}

// Traditional Palette
const GLOBE_COLORS = {
  ocean: "#004866", 
  continents: {
    "north-america": "#e6c288", 
    "south-america": "#a8c686", 
    "europe": "#d8a499",        
    "africa": "#e8d8a5",        
    "asia": "#c4a484",          
    "oceania": "#99badd"        
  },
  default: "#d0d0d0",
  stroke: "rgba(0,0,0,0.6)" // Darker/Blacker for Safari visibility
};

function render() {
  g.selectAll(".ocean").remove();
  g.insert("path", ".country")
    .datum({type: "Sphere"})
    .attr("class", "ocean")
    .attr("d", path)
    .attr("fill", GLOBE_COLORS.ocean)
    .attr("stroke", "rgba(0, 0, 0, 0.6)")
    .attr("stroke-width", 1);


  const countries = g.selectAll(".country")
    .data(features);

  countries.enter().append("path")
    .attr("class", "country globe-country")
    .merge(countries)
    .attr("d", path)
    .attr("data-continent", d => d.properties.continent)
    .style("fill", d => GLOBE_COLORS.continents[d.properties.continent] || GLOBE_COLORS.default)
    .style("stroke", GLOBE_COLORS.stroke)
    .style("stroke-width", "0.5px") // Explicit width for consistency
    .on("mouseover", function(e, d) {
       if (isDragging || hasMoved) return; // Ignore if moving
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
       if (cont) {
          d3.selectAll(`.country[data-continent='${cont}']`)
            .style("filter", null)
            .style("stroke", GLOBE_COLORS.stroke)
            .style("stroke-width", null);
       }
       document.getElementById("continent-tooltip").style.opacity = 0;
    })
    .on("click", function(e, d) {
       if (hasMoved) return; // Ignore if it was a drag
       
       const cont = d.properties.continent;
       if (cont) {
         window.location.href = `./quiz.html?continent=${cont}`;
       }
    });
}

function startRotationLoop() {
  d3.timer(() => {
    if (isDragging) return;
    const rotate = projection.rotate();
    projection.rotate([rotate[0] + 0.2, rotate[1]]);
    render();
  });
}

function handleResize() {
  if (!svg) return;
  const container = document.getElementById("continent-map");
  if (!container) return;
  
  width = container.clientWidth;
  height = container.clientHeight;
  const size = Math.min(width, height);
  const scale = (size / 2) * 0.9; 

  svg.attr("viewBox", `0 0 ${width} ${height}`);
  projection.translate([width / 2, height / 2]).scale(scale);
  render();
}

// Helpers
function pad3(n) {
  return String(n).padStart(3, "0");
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
  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch (err) {}
  }
  throw new Error(`${label} failed.`);
}
