const SOURCES = {
  topo: [
    "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json",
    "https://unpkg.com/world-atlas@2/countries-110m.json"
  ],
  countries: [
    "https://cdn.jsdelivr.net/npm/world-countries@5.1.0/countries.json",
    "https://unpkg.com/world-countries@5.1.0/countries.json"
  ],
  cities: [
    "./cities.json"
  ]
};

const continentParam = new URLSearchParams(window.location.search).get("continent") || "world";

let svg, g, zoom, projection, path;
let width, height, currentScale = 1;
let currentTargetID = "", currentPhase = "MAP_SELECTION";
let score = 0, isCapitalMode = true, visited = new Set();
let targetCityName = "";
let gameData = {};
let features = [];
let cityDB = {};

const mapPadding = { top: 90, right: 40, bottom: 40, left: 40 };

// Dot sizing controls (screen-space targets)
const DOT_SCREEN_BASE = 6;
const DOT_SCREEN_EXP = 0.35;
const DOT_SCREEN_MIN = 2;
const DOT_SCREEN_MAX = 7;

window.addEventListener("load", initGame);

async function initGame() {
  width = window.innerWidth;
  height = window.innerHeight;

  const container = d3.select("#map-stage");
  svg = container.append("svg")
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("preserveAspectRatio", "xMidYMid meet");
  g = svg.append("g");

  zoom = d3.zoom().scaleExtent([1, 50]).on("zoom", (e) => {
    g.attr("transform", e.transform);
    currentScale = e.transform.k;

    updateCityNodeStyle();
    d3.selectAll(".state").attr("stroke-width", 0.5 / currentScale);
  });
  svg.call(zoom);

  document.getElementById("mode-toggle").onclick = toggleMode;

  try {
    const topo = await fetchFirstOk(SOURCES.topo, "World Atlas");
    const countries = await fetchFirstOk(SOURCES.countries, "World Countries");
    cityDB = await fetchFirstOk(SOURCES.cities, "Cities");

    const byCcn3 = new Map();
    for (const c of countries) {
      if (!c.ccn3) continue;
      byCcn3.set(pad3(c.ccn3), c);
    }

    // MANUAL INJECTION: Ensure Kosovo (383) exists in metadata if missing
    if (!byCcn3.has("383")) {
      byCcn3.set("383", {
        name: { common: "Kosovo", official: "Republic of Kosovo" },
        cca3: "XKX",
        ccn3: "383",
        region: "Europe",
        subregion: "Southeast Europe",
        capital: ["Pristina"],
        latlng: [42.6, 20.9]
      });
    }

    // MANUAL INJECTION: Ensure Kosovo has cities so it passes the 'playable' filter
    if (!cityDB["383"] || !cityDB["383"].cities || cityDB["383"].cities.length < 3) {
       cityDB["383"] = {
         cities: [
           { name: "Pristina", latlng: [42.6629, 21.1655], fact: "Pristina is the capital and largest city." },
           { name: "Prizren", latlng: [42.2141, 20.7365], fact: "Prizren is a historic city known for its fortress." },
           { name: "Peja", latlng: [42.6594, 20.2887], fact: "Peja is located near the Rugova Canyon." },
           { name: "Gjakova", latlng: [42.3804, 20.4309], fact: "Gjakova has a well-preserved Old Bazaar." }
         ]
       };
    }

    const world = topojson.feature(topo, topo.objects.countries);
    features = world.features;

    // PATCH: Fix Disputed Territories (Somaliland, Kosovo)
    // Natural Earth 110m often assigns ID -99 to disputed areas.
    // We identify them by geography and reassign IDs to merge/activate them.
    features.forEach(f => {
      if (f.id === -99 || f.id === "-99") {
        const centroid = d3.geoCentroid(f);
        // Centroid [lng, lat]
        
        // Somaliland (Africa): approx lat 9.5, lng 46
        // Bounding check: Lat 5-15, Lng 40-55
        if (centroid[1] > 5 && centroid[1] < 15 && centroid[0] > 40 && centroid[0] < 55) {
          f.id = "706"; // Somalia
        }
        
        // Kosovo (Europe): approx lat 42.5, lng 21
        // Bounding check: Lat 40-45, Lng 19-23
        else if (centroid[1] > 40 && centroid[1] < 45 && centroid[0] > 19 && centroid[0] < 23) {
          f.id = "383"; // Kosovo
        }
      }
    });

    gameData = buildGameData(features, byCcn3, continentParam, cityDB);

    if (Object.keys(gameData).length === 0) {
      throw new Error("No countries matched for this continent with valid city data.");
    }

    const filteredFeatures = features.filter(f => gameData[pad3(f.id)]);

    // Special Handling: Geometry adjustments for cleaner zoom
    adjustContinentGeometry(filteredFeatures, continentParam);

    // Filter features for "Fit Extent" only
    // This allows us to exclude distant territories (like Russia's Alaska tip) from the zoom calculation
    // while keeping them in the actual rendered map (off-screen logic).
    let featuresForFitting = filteredFeatures;
    if (continentParam === "europe") {
      featuresForFitting = filteredFeatures.map(f => {
        const id = pad3(f.id);
        if (id === "643") { // Russia
           // Create a clone to modify for fitting purposes only
           const clone = JSON.parse(JSON.stringify(f));
           if (clone.geometry && clone.geometry.type === "MultiPolygon") {
              clone.geometry.coordinates = clone.geometry.coordinates.filter(poly => {
                 // Exclude polygon if any point is < -40 (Western Hemisphere / Alaska Tip)
                 const ring = poly[0];
                 return !ring.some(pt => pt[0] < -40);
              });
           }
           return clone;
        }
        return f;
      });
    }

    const vp = getMapViewport();
    projection = d3.geoMercator().fitExtent([[vp.x0, vp.y0], [vp.x1, vp.y1]], {
      type: "FeatureCollection",
      features: featuresForFitting
    });

    // Special Handling: Shift Europe Left to center Mainland (compensating for Russia's width)
    if (continentParam === "europe") {
      const t = projection.translate();
      // Shift Left by 6% of screen width to pull Europe from the rightish position to center
      projection.translate([t[0] - (width * 0.06), t[1]]);
    }

    // Correction: Apply same shifts to Cities in gameData to match Land Geometry
    if (continentParam === "oceania") {
       Object.values(gameData).forEach(country => {
         const cid = pad3(country.id);

         // Fiji (242): Shift -15 lon for ALL cities
         if (cid === "242") {
            country.cities.forEach(c => {
               c.latlng[1] -= 15;
            });
            // Also shift the capital entry stored at root level if I added it? 
            // buildGameData adds capital to .cities list. 
            // But we should double check if anything else needs shifting.
         }

         // Vanuatu (548): Snap ALL cities to visible geometry? 
         // Realistically, only Port Vila (Capital) is the issue on the missing island.
         if (cid === "548") {
             const vFeature = filteredFeatures.find(f => pad3(f.id) === "548");
             if (vFeature) {
                 const center = d3.geoCentroid(vFeature); // [lng, lat]
                 
                 // Find capital and snap it
                 const capitalCity = country.cities.find(c => c.name === country.capital);
                 if (capitalCity) {
                     capitalCity.latlng = [center[1], center[0]]; // [lat, lng]
                 }
             }
         }
       });
    }

    // Draw cities (Initial view - usually cleared by startRound but good for debugging or background)
    // Only show capitals for the active countries in this quiz
    const activeCities = Object.values(gameData).map(country => {
       const capitalName = country.capital;
       const city = country.cities.find(c => c.name === capitalName) || country.cities[0];
       return {
         ...city,
         countryId: country.id,
         id: country.id
       };
    });

    g.selectAll(".city-node")
      .data(activeCities)
      .enter()
      .append("circle")
      .attr("class", "city-node")
      .attr("r", 2)
      .attr("cx", d => projection([d.latlng[1], d.latlng[0]])[0])
      .attr("cy", d => projection([d.latlng[1], d.latlng[0]])[1])
      .attr("id", d => "city-" + d.id)
      .on("click", handleCityClick);

    path = d3.geoPath().projection(projection);

    g.selectAll("path")
      .data(filteredFeatures)
      .enter().append("path")
      .attr("d", path)
      .attr("class", "state")
      .attr("id", d => `state-${pad3(d.id)}`)
      .attr("data-continent", d => gameData[pad3(d.id)]?.continent || "")
      .on("click", handleStateClick);

    startRound();
  } catch (err) {
    console.error(err);
    document.getElementById("main-prompt").innerText = "Error Loading Map";
    document.getElementById("sub-prompt").innerText = err.message;
  }
}

function getMapViewport() {
  let top = mapPadding.top;
  const hud = document.getElementById("top-hud");
  if (hud) {
    const rect = hud.getBoundingClientRect();
    top = Math.max(top, rect.bottom + 12);
  }

  return {
    x0: mapPadding.left,
    y0: top,
    x1: width - mapPadding.right,
    y1: height - mapPadding.bottom
  };
}

function buildGameData(features, byCcn3, continentParam, cityDB) {
  const data = {};
  for (const f of features) {
    const idKey = pad3(f.id);
    const meta = byCcn3.get(idKey);
    if (!meta) continue;

    const continent = resolveContinent(meta);
    if (!continent) continue;
    if (!continentMatches(continent, continentParam)) continue;

    const capitalName = Array.isArray(meta.capital) ? meta.capital[0] : meta.capital;
    if (!capitalName) continue;

    const cities = getCitiesForCountry(idKey, capitalName, meta, f, cityDB);
    if (cities.length < 3) continue;

    data[idKey] = {
      id: idKey,
      name: meta.name?.common || meta.name?.official || meta.name,
      iso: meta.cca3 || meta.cioc || meta.cca2 || meta.ccn3,
      capital: capitalName,
      cities,
      facts: buildFacts(meta),
      continent
    };
  }
  return data;
}

function getCitiesForCountry(idKey, capitalName, meta, feature, cityDB) {
  const entry = cityDB[idKey];
  if (!entry || !Array.isArray(entry.cities)) return [];

  const cities = entry.cities.slice(0, 6).map(c => ({
    name: c.name,
    latlng: c.latlng,
    fact: c.fact || `${c.name} is one of the country’s major cities.`
  }));

  // Ensure capital is included
  const hasCapital = cities.some(c => c.name.toLowerCase() === capitalName.toLowerCase());
  if (!hasCapital) {
    const capitalCoord = getCapitalCoord(meta, feature);
    cities.unshift({
      name: capitalName,
      latlng: [capitalCoord[1], capitalCoord[0]],
      fact: `${capitalName} is the national capital and political center.`
    });
  }

  return cities.slice(0, 6);
}

function getCapitalCoord(meta, feature) {
  if (Array.isArray(meta.capitalInfo?.latlng) && meta.capitalInfo.latlng.length === 2) {
    return [meta.capitalInfo.latlng[1], meta.capitalInfo.latlng[0]];
  }
  if (Array.isArray(meta.latlng) && meta.latlng.length === 2) {
    return [meta.latlng[1], meta.latlng[0]];
  }
  return d3.geoCentroid(feature);
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

function continentMatches(continent, param) {
  if (param === "world") return true;
  return continent === param;
}

function buildFacts(meta) {
  const region = meta.region || "Unknown";
  const subregion = meta.subregion || "Unknown";
  const area = meta.area ? `${meta.area.toLocaleString()} km²` : "Unknown";
  const languages = meta.languages ? Object.values(meta.languages).slice(0, 3).join(", ") : "Unknown";
  const currencies = meta.currencies
    ? Object.values(meta.currencies).map(c => c.name).slice(0, 2).join(", ")
    : "Unknown";

  return [
    `Region: ${region}`,
    `Subregion: ${subregion}`,
    `Area: ${area}`,
    `Languages: ${languages}`,
    `Currencies: ${currencies}`
  ];
}

function pad3(n) {
  const s = String(n);
  return s.length >= 3 ? s : s.padStart(3, "0");
}

async function fetchFirstOk(urls, label) {
  let lastErr = null;
  for (const url of urls) {
    try {
      const res = await fetch(url, { mode: "cors" });
      if (!res.ok) throw new Error(`${label} fetch failed (${res.status})`);
      return await res.json();
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`${label} failed on all sources. ${lastErr ? lastErr.message : ""}`);
}

// --- DOT SIZE HELPERS ---
function clamp(min, max, v) { return Math.max(min, Math.min(max, v)); }

function getDotStyle() {
  const screenR = clamp(
    DOT_SCREEN_MIN,
    DOT_SCREEN_MAX,
    DOT_SCREEN_BASE / Math.pow(currentScale, DOT_SCREEN_EXP)
  );

  return {
    r: (screenR / currentScale) * 2
  };
}

function updateCityNodeStyle() {
  const { r } = getDotStyle();
  d3.selectAll(".city-node")
    .attr("r", r);
}

// --- GAME LOGIC ---
function startRound() {
  const keys = Object.keys(gameData);
  const available = keys.filter(k => !visited.has(k));
  if (available.length === 0) {
    alert("Game Complete! Final Score: " + score);
    visited.clear(); score = 0; startRound(); return;
  }

  currentTargetID = available[Math.floor(Math.random() * available.length)];
  visited.add(currentTargetID);

  currentPhase = "MAP_SELECTION";
  resetZoom();
  d3.selectAll(".state").classed("active-focused", false);
  d3.selectAll(".city-node").remove();
  document.getElementById("fact-overlay").classList.remove("show");

  const targetData = gameData[currentTargetID];
  document.getElementById("find-label").innerText = "Find Country";
  document.getElementById("main-prompt").innerText = targetData.name;
  document.getElementById("target-state").innerText = targetData.iso;
  document.getElementById("sub-prompt").innerText = "";
  document.getElementById("mode-toggle").classList.remove("disabled");
  updateScoreUI();
}

function handleStateClick(event, d) {
  if (currentPhase !== "MAP_SELECTION") return;

  const clickedID = pad3(d.id);
  if (!gameData[clickedID]) return;

  if (clickedID === currentTargetID) {
    score += 10; updateScoreUI();
    flashState(this, "correct");
    transitionToCityPhase(d, clickedID);
  } else {
    score -= 10; updateScoreUI();
    flashState(this, "wrong");
    const wrongName = gameData[clickedID].name;
    // Show ephemeral feedback
    showFeedback(`That is <span style="color:#000000; font-weight:bold;">${wrongName}</span>. Try again.`);
  }
}

// Helper for Ephemeral Message
let feedbackTimer;
function showFeedback(html) {
  const el = document.getElementById("sub-prompt");
  if (!el) return;
  el.innerHTML = html;
  el.classList.add("show");
  // Force reflow
  void el.offsetWidth;
  
  if (feedbackTimer) clearTimeout(feedbackTimer);
  feedbackTimer = setTimeout(() => {
    el.classList.remove("show");
  }, 3000);
}

function transitionToCityPhase(geoData, id) {
  currentPhase = "CITY_SELECTION";
  zoomToState(geoData);
  d3.select(`#state-${id}`).classed("active-focused", true);

  const data = gameData[id];
  document.getElementById("find-label").innerText = "Find City";
  const sp = document.getElementById("sub-prompt");
  sp.innerText = "";
  sp.classList.remove("persist"); // Reset state

  const cityChoices = data.cities.slice(0, 3);

  if (isCapitalMode) {
    targetCityName = data.capital;
    document.getElementById("main-prompt").innerText = "Capital";
  } else {
    const target = cityChoices[Math.floor(Math.random() * cityChoices.length)];
    targetCityName = target.name;
    document.getElementById("main-prompt").innerText = "Identify City";
    const sp = document.getElementById("sub-prompt");
    sp.innerText = `"${target.fact}"`;
    sp.classList.add("persist"); // Keep visible indefinitely
    // Clear any pending timeout from previous errors to avoid auto-hide
    if (feedbackTimer) clearTimeout(feedbackTimer);
  }

  // Lock toggle during city phase
  document.getElementById("mode-toggle").classList.add("disabled");

  plotCities(id, cityChoices);
}

function plotCities(id, cityChoices) {
  const nodes = cityChoices.map(c => {
    const projected = projection([c.latlng[1], c.latlng[0]]);
    return projected ? { name: c.name, x: projected[0], y: projected[1] } : null;
  }).filter(Boolean);

  const { r } = getDotStyle();

  // Halos (Throb Effect)
  g.selectAll(".city-halo")
    .data(nodes)
    .enter().append("circle")
    .attr("class", "city-halo")
    .attr("cx", d => d.x)
    .attr("cy", d => d.y)
    .attr("r", r)
    .style("pointer-events", "none");

  g.selectAll(".city-node")
    .data(nodes)
    .enter().append("circle")
    .attr("class", "city-node")
    .attr("cx", d => d.x)
    .attr("cy", d => d.y)
    .attr("r", 0)
    .on("mouseover", showTooltip)
    .on("mousemove", moveTooltip)
    .on("mouseout", hideTooltip)
    .on("click", (e, d) => handleCityClick(e, d, id))
    .attr("r", r)
    .style("pointer-events", "auto");
}

function handleCityClick(event, cityNode, id) {
  const isCorrect = cityNode.name === targetCityName;
  const dot = d3.select(event.currentTarget);

  if (dot.classed("wrong-choice") || dot.classed("correct-choice")) return;

  const data = gameData[id];
  const clickedCityFact = data.cities.find(c => c.name === cityNode.name)?.fact || "Major city.";
  const targetFact = data.cities.find(c => c.name === targetCityName)?.fact || "Major city.";

  if (isCorrect) {
    dot.classed("correct-choice", true);
    score += 20; updateScoreUI();
    
    // Clear the Fact Pillbox immediately on success
    const sp = document.getElementById("sub-prompt");
    if (sp) {
       sp.innerText = "";
       sp.classList.remove("persist", "show");
    }
    
    const correctFact = isCapitalMode ? `Capital of ${data.name}` : clickedCityFact;
    showFact(cityNode.name, id, "CORRECT", "status-correct", correctFact);
  } else {
    dot.classed("wrong-choice", true);
    score -= 10; updateScoreUI();
    
    if (!isCapitalMode) {
      // In Fact mode, enforce showing the target fact so user can focus on it
      document.getElementById("sub-prompt").innerText = `"${targetFact}"`;
      // Show modal with target fact as reminder
      showFact(cityNode.name, id, "INCORRECT", "status-wrong", clickedCityFact, "Try Again", closeOverlay);
    } else {
       // Capital mode - standard feedback (Redirection to Error Pill)
       showFeedback(`That is <span style="color:#000000; font-weight:bold;">${cityNode.name}</span>. Try again.`);
    }
  }
}


function showFact(cityName, id, status, statusClass, factText, btnLabel = "Next Country", btnAction = null) {
  const data = gameData[id];
  const overlay = document.getElementById("fact-overlay");
  const btn = document.getElementById("next-action-btn");

  document.getElementById("fact-status").innerText = status;
  document.getElementById("fact-status").className = `fact-status ${statusClass}`;
  document.getElementById("fact-city-name").innerText = cityName;
  document.getElementById("fact-text").innerText = factText || (isCapitalMode ? `Capital of ${data.name}` : "Major city.");

  btn.innerText = btnLabel;
  btn.onclick = btnAction || resetGameRound;

  overlay.classList.add("show");
}

function closeOverlay() {
  document.getElementById("fact-overlay").classList.remove("show");
}

function toggleMode() {
  if (currentPhase === "CITY_SELECTION") return;
  isCapitalMode = !isCapitalMode;
  document.getElementById("mode-toggle").classList.toggle("active");
  document.getElementById("mode-label").innerText = isCapitalMode ? "Capital" : "Fact";
}

function updateScoreUI() { document.getElementById("score-val").innerText = score; }
function showTooltip(e, d) {
  const tt = document.getElementById("city-tooltip");
  tt.innerText = d.name; tt.style.opacity = 1;
  tt.style.left = (e.pageX + 10) + "px"; tt.style.top = (e.pageY - 20) + "px";
}
function moveTooltip(e) {
  const tt = document.getElementById("city-tooltip");
  tt.style.left = (e.pageX + 10) + "px"; tt.style.top = (e.pageY - 20) + "px";
}
function hideTooltip() { document.getElementById("city-tooltip").style.opacity = 0; }
function resetGameRound() { startRound(); }

function zoomToState(d) {
  const vp = getMapViewport();
  const vpWidth = vp.x1 - vp.x0;
  const vpHeight = vp.y1 - vp.y0;

  const b = path.bounds(d);
  const dx = b[1][0] - b[0][0];
  const dy = b[1][1] - b[0][1];

  const boundsValid =
    Number.isFinite(dx) &&
    Number.isFinite(dy) &&
    dx > 0 && dy > 0 &&
    dx < width * 3 &&
    dy < height * 3;

  const targetX = (vp.x0 + vp.x1) / 2;
  const targetY = (vp.y0 + vp.y1) / 2;

  if (boundsValid) {
    const x = (b[0][0] + b[1][0]) / 2;
    const y = (b[0][1] + b[1][1]) / 2;
    const s = Math.max(1, Math.min(10, 0.78 / Math.max(dx / vpWidth, dy / vpHeight)));
    const t = [targetX - s * x, targetY - s * y];
    svg.transition().duration(900).call(
      zoom.transform,
      d3.zoomIdentity.translate(t[0], t[1]).scale(s)
    );
    return;
  }

  const centroid = projection(d3.geoCentroid(d));
  if (!centroid) return;

  const s = 4;
  const t = [targetX - s * centroid[0], targetY - s * centroid[1]];
  svg.transition().duration(900).call(
    zoom.transform,
    d3.zoomIdentity.translate(t[0], t[1]).scale(s)
  );
}

function resetZoom() { svg.transition().duration(1000).call(zoom.transform, d3.zoomIdentity); }
function flashState(el, type) {
  d3.select(el).classed(type + "-flash", true);
  setTimeout(() => d3.select(el).classed(type + "-flash", false), 500);
}

function adjustContinentGeometry(features, continent) {
  for (const f of features) {
    const id = pad3(f.id);

    if (continent === "europe") {
      // France (250): Trim French Guiana (South America)
      // Filter polygons based on Centroid Longitude
      if (id === "250" && f.geometry && f.geometry.type === "MultiPolygon") {
        f.geometry.coordinates = f.geometry.coordinates.filter(polygon => {
          const centroid = d3.geoCentroid({type: "Polygon", coordinates: polygon});
          return centroid[0] > -20; // Keep if East of Atlantic
        });
      }

      // Russia (643): Logic removed (Handled by Viewport Fitting instead)
    }

    if (continent === "oceania") {
      // Fiji (242): Shift 15 deg West (-15)
      if (id === "242" && f.geometry) {
        const shiftRecursive = (coords, depth) => {
          if (depth === 0) {
            coords[0] -= 15;
            return;
          }
          for (const child of coords) shiftRecursive(child, depth - 1);
        };

        if (f.geometry.type === "MultiPolygon") {
          shiftRecursive(f.geometry.coordinates, 3);
        } else if (f.geometry.type === "Polygon") {
          shiftRecursive(f.geometry.coordinates, 2);
        }
      }
    }
  }
}
