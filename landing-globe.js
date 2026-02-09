
import { startQuiz, exitQuiz } from "./quiz.js";
import { SOURCES, GLOBE_COLORS, pad3, fetchFirstOk, resolveContinent, formatContinentName } from "./utils.js";

// Global Module State
let width, height;
let svg, g, projection, path;
let features = [];
let isDragging = false;
let hasMoved = false; // Shared state for Click vs Drag
let rotationTimer;

// Sub-selections for optimized updates
let oceanSelection, countriesSelection;

// Button Wiring
window.addEventListener("load", () => {
   // Wire up World Button
   const btnWorld = document.getElementById("btn-world-start");
   if (btnWorld) {
     btnWorld.onclick = (e) => {
       e.preventDefault();
       switchToQuiz("world");
     };
   }
   
   // Wire up Back Button
   const btnBack = document.getElementById("btn-quiz-back");
   if (btnBack) {
      btnBack.onclick = (e) => {
       e.preventDefault();
       exitQuiz();
     };
   }

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

function switchToQuiz(continent) {
  const landing = document.getElementById("view-landing");
  const quiz = document.getElementById("view-quiz");
  
  if (landing) landing.classList.add("hidden");
  if (quiz) quiz.classList.remove("hidden");
  
  startQuiz(continent);
}

async function initGlobe() {
  const container = document.getElementById("continent-map");
  if (!container) return;
  
  width = container.clientWidth;
  height = container.clientHeight;

  // Clear existing if any (re-init safety)
  d3.select(container).selectAll("*").remove();

  svg = d3.select(container).append("svg")
    .attr("class", "world-svg")
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("preserveAspectRatio", "xMidYMid meet")
    // Explicit pointer events for touch
    .style("touch-action", "none")
    .style("-webkit-tap-highlight-color", "transparent");

  g = svg.append("g");

  // Setup Orthographic Projection
  const size = Math.min(width, height);
  const isMobile = window.innerWidth < 768; 
  const scaleFactor = isMobile ? 0.99 : 0.9; // Practically full width on mobile
  const scale = (size / 2) * scaleFactor;

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
      if (rotationTimer) rotationTimer.stop(); // Pause rotation while dragging
    })
    .on("drag", (event) => {
      const dx = event.x - startX;
      const dy = event.y - startY;
      const dist = Math.sqrt(dx*dx + dy*dy);
      
      if (dist > 5) hasMoved = true;
      
      // Throttled Rotation using requestAnimationFrame
      const sensitivity = 75 / projection.scale();
      const rotate = projection.rotate();
      
      const nextRotate = [
        rotate[0] + event.dx * sensitivity,
        rotate[1] - event.dy * sensitivity
      ];
      
      projection.rotate(nextRotate);
      requestRender();
    })
    .on("end", () => {
      isDragging = false;
      startRotationLoop(); // Resume rotation
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

    // --- INITIAL DRAW (Create Elements Once) ---
    
    // Ocean Background
    oceanSelection = g.append("path")
     .datum({type: "Sphere"})
     .attr("class", "ocean")
     .attr("d", path)
     .attr("fill", GLOBE_COLORS.ocean)
     .attr("stroke", GLOBE_COLORS.stroke)
     .attr("stroke-width", 2);

    // Countries
    countriesSelection = g.selectAll(".country")
     .data(features)
     .enter().append("path")
     .attr("class", "country globe-country")
     .attr("d", path)
     .attr("data-continent", d => d.properties.continent)
     .style("fill", d => GLOBE_COLORS.continents[d.properties.continent] || GLOBE_COLORS.default)
     .style("stroke", GLOBE_COLORS.stroke)
     .style("stroke-width", "0.5px") // Half thickness default
     .style("stroke-opacity", 1)
     .on("mouseover", handleHover)
     .on("mouseout", handleMouseOut)
     .on("click", handleClick);

    // Start Loop
    startRotationLoop();

  } catch (err) {
    console.error("Globe Init Error:", err);
    container.innerHTML = `<div class='map-error'>Failed to load globe: ${err.message}</div>`;
  }
}

function handleHover(e, d) {
    if (isDragging) return; 
    const cont = d.properties.continent;
    if (!cont) return;
    
    // Efficiently select only the relevant group
    // Note: This still uses selectAll but it's scoped. 
    // Optimization: Add a class to the group directly if possible, or use data attributes.
    d3.selectAll(`.country[data-continent='${cont}']`)
      .classed("hovered-continent", true)
      .style("filter", "brightness(0.7)")
      .style("stroke", "#000000")
      .style("stroke-width", "1px");
    
    const tt = document.getElementById("continent-tooltip");
    if (tt) {
        tt.innerText = formatContinentName(cont);
        tt.style.opacity = 1;
        tt.style.left = (e.pageX + 10) + "px";
        tt.style.top = (e.pageY - 20) + "px";
    }
}

function handleMouseOut(e, d) {
    const cont = d.properties.continent;
    if (cont) {
       d3.selectAll(`.country[data-continent='${cont}']`)
         .classed("hovered-continent", false)
         .style("filter", null)
         .style("stroke", GLOBE_COLORS.stroke)
         .style("stroke-width", null);
    }
    const tt = document.getElementById("continent-tooltip");
    if (tt) tt.style.opacity = 0;
}

function handleClick(e, d) {
    if (hasMoved) return; 
    
    const cont = d.properties.continent;
    if (cont) {
      if (rotationTimer) rotationTimer.stop();
      switchToQuiz(cont);
    }
}

let renderRequested = false;
function requestRender() {
    if (!renderRequested) {
        renderRequested = true;
        requestAnimationFrame(() => {
            render();
            renderRequested = false;
        });
    }
}

function render() {
  if (!path || !oceanSelection) return;
  
  // Optimized Render: Only update 'd' attribute
  oceanSelection.attr("d", path);
  countriesSelection.attr("d", path);
}

function startRotationLoop() {
  if (rotationTimer) rotationTimer.stop();
  rotationTimer = d3.timer((elapsed) => {
    if (isDragging) return;
    
    // Smooth, slow rotation
    const rotate = projection.rotate();
    projection.rotate([rotate[0] + 0.2, rotate[1]]);
    render();
  });
}

// Window resize handler
window.addEventListener("resize", () => {
    if (!svg) return;
    const container = document.getElementById("continent-map");
    if (!container) return;
    
    width = container.clientWidth;
    height = container.clientHeight;
    const size = Math.min(width, height);
    const scale = (size / 2) * 0.9; 

    svg.attr("viewBox", `0 0 ${width} ${height}`);
    projection.translate([width / 2, height / 2]).scale(scale);
    requestRender();
});
