import * as d3 from "d3";
import * as topojson from "topojson-client";
import { SOURCES, pad3, fetchFirstOk, resolveContinent, clamp, CountryMeta } from "./utils";

// Global Game State
let svg: any;
let g: any;
let zoom: any;
let projection: d3.GeoProjection;
let path: d3.GeoPath;
let width: number, height: number, currentScale = 1;
let currentTargetID = "", currentPhase = "MAP_SELECTION";
let score = 0, isCapitalMode = true, visited = new Set<string>();
let targetCityName = "";
let gameData: Record<string, GameCountry> = {};
let features: any[] = [];
let cityDB: any = {};

// Caches for D3 selections
let cityNodeSelection: any;
let cityHaloSelection: any;
let stateSelection: any;

const mapPadding = { top: 90, right: 40, bottom: 40, left: 40 };

interface City {
  name: string;
  latlng: [number, number];
  fact?: string;
}

interface GameCountry {
  id: string;
  name: string;
  iso: string;
  capital: string;
  cities: City[];
  facts: string[];
  continent: string;
}

interface CityNode {
  name: string;
  x: number;
  y: number;
}

// Dot sizing controls (screen-space targets)
const DOT_SCREEN_BASE = 12;
const DOT_SCREEN_EXP = 0.35;
const DOT_SCREEN_MIN = 4;
const DOT_SCREEN_MAX = 14;

export async function startQuiz(continent: string | null) {
  const continentParam = continent || "world";
  
  // Cleanup any previous instance
  d3.select("#map-stage").selectAll("*").remove();

  width = window.innerWidth;
  height = window.innerHeight;

  const container = d3.select("#map-stage");
  svg = container.append("svg")
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("preserveAspectRatio", "xMidYMid meet");
  g = svg.append("g");

  zoom = d3.zoom<SVGSVGElement, unknown>().scaleExtent([1, 50]).on("zoom", (e) => {
    g.attr("transform", e.transform);
    currentScale = e.transform.k;

    updateCityNodeStyle();
    if (stateSelection) stateSelection.attr("stroke-width", 0.5 / currentScale);
  });
  svg.call(zoom);

  const modeToggle = document.getElementById("mode-toggle");
  if (modeToggle) modeToggle.onclick = toggleMode;

  try {
    const topo = await fetchFirstOk<any>(SOURCES.topo, "World Atlas");
    const countries = await fetchFirstOk<any[]>(SOURCES.countries, "World Countries");
    cityDB = await fetchFirstOk<any>(SOURCES.cities, "Cities");

    const byCcn3 = new Map<string, CountryMeta>();
    for (const c of countries) {
      if (!c.ccn3) continue;
      byCcn3.set(pad3(c.ccn3), c);
    }

    // MANUAL INJECTION: Ensure Kosovo (383) exists in metadata if missing
    if (!byCcn3.has("383")) {
      byCcn3.set("383", {
        name: { common: "Kosovo" },
        region: "Europe",
        subregion: "Southeast Europe",
        ccn3: "383"
      });
    }

    // MANUAL INJECTION: Ensure Kosovo has cities
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

    const world = topojson.feature(topo, topo.objects.countries) as any;
    features = world.features;

    // PATCH: Fix Disputed Territories (Somaliland, Kosovo)
    features.forEach(f => {
      // Use looser check for string/number id
      if (f.id == -99) {
        const centroid = d3.geoCentroid(f);
        // Somaliland (Africa)
        if (centroid[1] > 5 && centroid[1] < 15 && centroid[0] > 40 && centroid[0] < 55) {
          f.id = "706";
        }
        // Kosovo (Europe)
        else if (centroid[1] > 40 && centroid[1] < 45 && centroid[0] > 19 && centroid[0] < 23) {
          f.id = "383";
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

    // Filter features for "Fit Extent"
    let featuresForFitting = filteredFeatures;
    if (continentParam === "europe") {
      featuresForFitting = filteredFeatures.map(f => {
        const id = pad3(f.id);
        if (id === "643") { // Russia
           const clone = JSON.parse(JSON.stringify(f));
           if (clone.geometry && clone.geometry.type === "MultiPolygon") {
              clone.geometry.coordinates = clone.geometry.coordinates.filter((poly: any) => {
                 const ring = poly[0];
                 return !ring.some((pt: any) => pt[0] < -40); // Exclude Alaska tip
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
    } as any);

    // Special Handling: Shift Europe Left
    if (continentParam === "europe") {
      const t = projection.translate();
      projection.translate([t[0] - (width * 0.06), t[1]]);
    }

    // Correction: Apply same shifts to Cities in gameData to match Land Geometry
    if (continentParam === "oceania") {
       // Batch updates for specific countries
       const fiji = gameData["242"];
       if (fiji) {
           fiji.cities.forEach(c => c.latlng[1] -= 15);
       }
       
       const vanuatu = gameData["548"];
       if (vanuatu) {
             const vFeature = filteredFeatures.find(f => pad3(f.id) === "548");
             if (vFeature) {
                 const center = d3.geoCentroid(vFeature); // [lng, lat]
                 const capitalCity = vanuatu.cities.find(c => c.name === vanuatu.capital);
                 if (capitalCity) {
                     capitalCity.latlng = [center[1], center[0]]; // [lat, lng]
                 }
             }
       }
    }

    // Prepare active cities for initial view
    const activeCities = Object.values(gameData).map(country => {
       const capitalName = country.capital;
       const city = country.cities.find(c => c.name === capitalName) || country.cities[0];
       return {
         ...city,
         countryId: country.id,
         id: country.id
       };
    });

    path = d3.geoPath().projection(projection);

    // Render States
    stateSelection = g.selectAll(".state")
      .data(filteredFeatures)
      .enter().append("path")
      .attr("d", path)
      .attr("class", "state")
      .attr("id", (d: any) => `state-${pad3(d.id)}`)
      .attr("data-continent", (d: any) => gameData[pad3(d.id)]?.continent || "")
      .on("click", handleStateClick);

    // Initial Cities (Capital only mostly)
    cityNodeSelection = (g.selectAll(".city-node") as any)
      .data(activeCities as any) 
      .enter()
      .append("circle")
      .attr("class", "city-node")
      .attr("r", 2)
      .attr("cx", (d: any) => projection([d.latlng[1], d.latlng[0]])![0])
      .attr("cy", (d: any) => projection([d.latlng[1], d.latlng[0]])![1])
      .attr("id", (d: any) => "city-" + d.id)
      .on("click", (e: any, d: any) => handleCityClick(e, d as CityNode, d.id));

    startRound();
  } catch (err: any) {
    console.error(err);
    const mainPrompt = document.getElementById("main-prompt");
    const subPrompt = document.getElementById("sub-prompt");
    if (mainPrompt) mainPrompt.innerText = "Error Loading Map";
    if (subPrompt) subPrompt.innerText = err.message;
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

function buildGameData(features: any[], byCcn3: Map<string, any>, continentParam: string, cityDB: any) {
  const data: Record<string, GameCountry> = {};
  for (const f of features) {
    const idKey = pad3(f.id);
    const meta = byCcn3.get(idKey);
    if (!meta) continue;

    const continent = resolveContinent(meta);
    if (!continent) continue;
    if (continentParam !== "world" && continent !== continentParam) continue;

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

function getCitiesForCountry(idKey: string, capitalName: string, meta: any, feature: any, cityDB: any): City[] {
  const entry = cityDB[idKey];
  if (!entry || !Array.isArray(entry.cities)) return [];

  // Slice first to avoid mapping everything
  const topCities = entry.cities.slice(0, 7); // Grab a few more to filter
  
  const cities: City[] = topCities.map((c: any) => ({
    name: c.name,
    latlng: c.latlng,
    fact: c.fact || `${c.name} is one of the country’s major cities.`
  }));

  // Ensure capital is included
  const capitalLower = capitalName.toLowerCase();
  const hasCapital = cities.some(c => c.name.toLowerCase() === capitalLower);
  
  if (!hasCapital && cities.length > 0) {
    const capitalCoord = getCapitalCoord(meta, feature);
    // Insert at front
    cities.unshift({
      name: capitalName,
      latlng: [capitalCoord[1], capitalCoord[0]],
      fact: `${capitalName} is the national capital and political center.`
    });
  }

  return cities.slice(0, 6);
}

function getCapitalCoord(meta: any, feature: any) {
  if (Array.isArray(meta.capitalInfo?.latlng) && meta.capitalInfo.latlng.length === 2) {
    return [meta.capitalInfo.latlng[1], meta.capitalInfo.latlng[0]];
  }
  if (Array.isArray(meta.latlng) && meta.latlng.length === 2) {
    return [meta.latlng[1], meta.latlng[0]];
  }
  return d3.geoCentroid(feature);
}

function buildFacts(meta: any) {
  const region = meta.region || "Unknown";
  const subregion = meta.subregion || "Unknown";
  const area = meta.area ? `${meta.area.toLocaleString()} km²` : "Unknown";
  const languages = meta.languages ? Object.values(meta.languages).slice(0, 3).join(", ") : "Unknown";
  const currencies = meta.currencies
    ? Object.values(meta.currencies as any).map((c: any) => c.name).slice(0, 2).join(", ")
    : "Unknown";

  return [
    `Region: ${region}`,
    `Subregion: ${subregion}`,
    `Area: ${area}`,
    `Languages: ${languages}`,
    `Currencies: ${currencies}`
  ];
}

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
  if (cityNodeSelection) cityNodeSelection.attr("r", r);
  if (cityHaloSelection) cityHaloSelection.attr("r", r);
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
  
  // Cleanup artifacts
  g.selectAll(".city-node, .city-halo").remove(); 
  cityNodeSelection = g.selectAll(".city-node"); // Update cache to empty
  cityHaloSelection = g.selectAll(".city-halo");

  if (stateSelection) stateSelection.classed("active-focused", false);
  document.getElementById("fact-overlay")?.classList.remove("show");
  
  resetZoom();

  const targetData = gameData[currentTargetID];
  const findLabel = document.getElementById("find-label");
  const mainPrompt = document.getElementById("main-prompt");
  const targetState = document.getElementById("target-state");
  const subPrompt = document.getElementById("sub-prompt");
  
  if (findLabel) findLabel.innerText = "Find Country";
  if (mainPrompt) mainPrompt.innerText = targetData.name;
  if (targetState) targetState.innerText = targetData.iso;
  if (subPrompt) subPrompt.innerText = "";
  
  const toggle = document.getElementById("mode-toggle");
  if(toggle) toggle.classList.remove("disabled");
  
  updateScoreUI();
}

function handleStateClick(this: SVGPathElement, _event: MouseEvent, d: any) {
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
    showFeedback(`That is <span style="font-weight:900;">${wrongName}</span>.`);
  }
}

// Helper for Ephemeral Message
let feedbackTimer: ReturnType<typeof setTimeout>;
function showFeedback(html: string) {
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

function transitionToCityPhase(geoData: any, id: string) {
  currentPhase = "CITY_SELECTION";
  zoomToState(geoData);
  d3.select(`#state-${id}`).classed("active-focused", true);

  const data = gameData[id];
  const findLabel = document.getElementById("find-label");
  if (findLabel) findLabel.innerText = "Find City";
  
  const sp = document.getElementById("sub-prompt");
  if (sp) {
    sp.innerHTML = ""; 
    sp.classList.remove("persist", "show"); 
  }

  const cityChoices = data.cities.slice(0, 3);
  const mainPrompt = document.getElementById("main-prompt");

  if (isCapitalMode) {
    targetCityName = data.capital;
    if (mainPrompt) mainPrompt.innerText = "Capital";
  } else {
    const target = cityChoices[Math.floor(Math.random() * cityChoices.length)];
    targetCityName = target.name;
    if (mainPrompt) mainPrompt.innerText = "Identify City";
    if (sp) {
      sp.innerText = `"${target.fact}"`;
      sp.classList.add("persist"); 
    }
    if (feedbackTimer) clearTimeout(feedbackTimer);
  }

  // Lock toggle during city phase
  const toggle = document.getElementById("mode-toggle");
  if (toggle) toggle.classList.add("disabled");

  plotCities(id, cityChoices);
}

function plotCities(id: string, cityChoices: City[]) {
  const nodes: CityNode[] = cityChoices.map(c => {
    const projected = projection([c.latlng[1], c.latlng[0]]);
    return projected ? { name: c.name, x: projected[0], y: projected[1] } : null;
  }).filter((n): n is CityNode => n !== null);

  // Clear previous
  g.selectAll(".city-node, .city-halo").remove();

  const { r } = getDotStyle();

  // Halos (Throb Effect)
  cityHaloSelection = g.selectAll(".city-halo")
    .data(nodes)
    .enter().append("circle")
    .attr("class", "city-halo")
    .attr("cx", (d: any) => d.x)
    .attr("cy", (d: any) => d.y)
    .attr("r", r)
    .style("pointer-events", "none");

  cityNodeSelection = g.selectAll(".city-node")
    .data(nodes)
    .enter().append("circle")
    .attr("class", "city-node")
    .attr("cx", (d: any) => d.x)
    .attr("cy", (d: any) => d.y)
    .attr("r", r) // use calculated r immediately
    .on("mouseover", showTooltip)
    .on("mousemove", moveTooltip)
    .on("mouseout", hideTooltip)
    .on("click", (e: any, d: any) => handleCityClick(e, d, id))
    .style("pointer-events", "auto");
}

function handleCityClick(event: MouseEvent, cityNode: CityNode, id: string) {
  const isCorrect = cityNode.name === targetCityName;
  const dot = d3.select(event.currentTarget as Element);

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
    // Remove the throbbing halo for this wrong choice
    g.selectAll(".city-halo").filter((d: any) => d.name === cityNode.name).remove();

    score -= 10; updateScoreUI();
    
    if (!isCapitalMode) {
      const sp = document.getElementById("sub-prompt");
      if (sp) sp.innerText = `"${targetFact}"`;
      showFact(cityNode.name, id, "INCORRECT", "status-wrong", clickedCityFact, "Try Again", closeOverlay);
    } else {
       showFeedback(`That is <span style="font-weight:900;">${cityNode.name}</span>.`);
    }
  }
}

function showFact(cityName: string, id: string, status: string, statusClass: string, factText: string, btnLabel = "Next Country", btnAction: (() => void) | null = null) {
  const data = gameData[id];
  const overlay = document.getElementById("fact-overlay");
  const btn = document.getElementById("next-action-btn");
  const factStatus = document.getElementById("fact-status");
  const factCityName = document.getElementById("fact-city-name");
  const factTextEl = document.getElementById("fact-text");

  if (factStatus) {
    factStatus.innerText = status;
    factStatus.className = `fact-status ${statusClass}`;
  }
  if (factCityName) factCityName.innerText = cityName;
  if (factTextEl) factTextEl.innerText = factText || (isCapitalMode ? `Capital of ${data.name}` : "Major city.");

  if (btn) {
    btn.innerText = btnLabel;
    btn.onclick = btnAction || resetGameRound;
  }

  if (overlay) overlay.classList.add("show");
}

function closeOverlay() {
  const overlay = document.getElementById("fact-overlay");
  if (overlay) overlay.classList.remove("show");
}

function toggleMode() {
  if (currentPhase === "CITY_SELECTION") return;
  isCapitalMode = !isCapitalMode;
  document.getElementById("mode-toggle")?.classList.toggle("active");
  const label = document.getElementById("mode-label");
  if (label) label.innerText = isCapitalMode ? "Capital" : "Fact";
}

function updateScoreUI() { 
  const el = document.getElementById("score-val");
  if (el) el.innerText = String(score); 
}

function showTooltip(e: MouseEvent, d: any) {
  const tt = document.getElementById("city-tooltip");
  if (!tt) return;
  tt.innerText = d.name; 
  tt.style.opacity = "1";
  tt.style.left = (e.pageX + 10) + "px"; 
  tt.style.top = (e.pageY - 20) + "px";
}
function moveTooltip(e: MouseEvent) {
  const tt = document.getElementById("city-tooltip");
  if (!tt) return;
  tt.style.left = (e.pageX + 10) + "px"; 
  tt.style.top = (e.pageY - 20) + "px";
}
function hideTooltip() { 
  const tt = document.getElementById("city-tooltip");
  if (tt) tt.style.opacity = "0"; 
}
function resetGameRound() { startRound(); }

function zoomToState(d: any) {
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

function resetZoom() { 
  svg.transition().duration(1000).call(zoom.transform, d3.zoomIdentity); 
}
function flashState(el: Element, type: string) {
  d3.select(el).classed(type + "-flash", true);
  setTimeout(() => d3.select(el).classed(type + "-flash", false), 500);
}

function adjustContinentGeometry(features: any[], continent: string) {
  const isEurope = continent === "europe";
  const isOceania = continent === "oceania";

  if (!isEurope && !isOceania) return;

  for (const f of features) {
    const id = pad3(f.id);

    if (isEurope) {
      // France (250): Trim French Guiana
      if (id === "250" && f.geometry?.type === "MultiPolygon") {
        f.geometry.coordinates = f.geometry.coordinates.filter((polygon: any) => {
          // Simple centroid check for polygon ring
          // We can just check the first point of the first ring for speed
          const p = polygon[0][0];
          return p[0] > -20; // East of Atlantic
        });
      }
    }

    if (isOceania) {
      // Fiji (242): Shift 15 deg West (-15)
      if (id === "242" && f.geometry) {
         updateGeometryCoordinates(f.geometry, (pt: any) => pt[0] -= 15);
      }
    }
  }
}

function updateGeometryCoordinates(geometry: any, updateFn: (pt: any) => void) {
   if (geometry.type === "MultiPolygon") startRecursive(geometry.coordinates, 3, updateFn);
   else if (geometry.type === "Polygon") startRecursive(geometry.coordinates, 2, updateFn);
}

function startRecursive(coords: any, depth: number, updateFn: (pt: any) => void) {
   if (depth === 0) {
      // Coords is a point [x, y]
      updateFn(coords);
      return;
   }
   for (let i = 0; i < coords.length; i++) {
       startRecursive(coords[i], depth - 1, updateFn);
   }
}

export function exitQuiz() {
  d3.select("#map-stage").selectAll("*").remove();
  const quiz = document.getElementById("view-quiz");
  const landing = document.getElementById("view-landing");
  if(quiz) quiz.classList.add("hidden");
  if(landing) landing.classList.remove("hidden");
}

// Auto-start for standalone usage (not SPA)
if (!document.getElementById("view-landing")) {
   const params = new URLSearchParams(window.location.search);
   startQuiz(params.get("continent"));
}
