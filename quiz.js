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

const continentParam = new URLSearchParams(window.location.search).get("continent") || "world";

let svg, g, zoom, projection, path;
let width, height, currentScale = 1;
let currentTargetID = "", currentPhase = "MAP_SELECTION";
let score = 0, isCapitalMode = true, visited = new Set();
let targetCapital = "";
let gameData = {};
let features = [];

window.addEventListener("load", initGame);

async function initGame() {
  width = window.innerWidth;
  height = window.innerHeight;

  const container = d3.select("#map-stage");
  svg = container.append("svg")
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("preserveAspectRatio", "xMidYMid meet");
  g = svg.append("g");

  zoom = d3.zoom().scaleExtent([1, 15]).on("zoom", (e) => {
    g.attr("transform", e.transform);
    currentScale = e.transform.k;
    d3.selectAll(".city-node")
      .attr("r", 6 / currentScale)
      .attr("stroke-width", (2 / currentScale));
    d3.selectAll(".state").attr("stroke-width", 0.5 / currentScale);
  });
  svg.call(zoom);

  document.getElementById("mode-toggle").onclick = toggleMode;

  try {
    const topo = await fetchFirstOk(SOURCES.topo, "World Atlas");
    const countries = await fetchFirstOk(SOURCES.countries, "World Countries");

    const byCcn3 = new Map();
    for (const c of countries) {
      if (!c.ccn3) continue;
      byCcn3.set(pad3(c.ccn3), c);
    }

    const world = topojson.feature(topo, topo.objects.countries);
    features = world.features;

    gameData = buildGameData(features, byCcn3, continentParam);

    if (Object.keys(gameData).length === 0) {
      throw new Error("No countries matched for this continent.");
    }

    const filteredFeatures = features.filter(f => gameData[pad3(f.id)]);

    projection = d3.geoMercator().fitSize([width, height * 0.9], {
      type: "FeatureCollection",
      features: filteredFeatures
    });
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

function buildGameData(features, byCcn3, continentParam) {
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

    const capitalCoord = getCapitalCoord(meta, f);

    data[idKey] = {
      id: idKey,
      name: meta.name?.common || meta.name?.official || meta.name,
      iso: meta.cca3 || meta.cioc || meta.cca2 || meta.ccn3,
      capital: capitalName,
      capitalCoord,
      facts: buildFacts(meta),
      continent
    };
  }
  return data;
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
  updateScoreUI();
}

function handleStateClick(event, d) {
  if (currentPhase !== "MAP_SELECTION") return;

  const clickedID = pad3(d.id);
  if (!gameData[clickedID]) return;

  if (clickedID === currentTargetID) {
    score += 10; updateScoreUI();
    flashState(this, "correct");
    transitionToCapitalPhase(d, clickedID);
  } else {
    score -= 10; updateScoreUI();
    flashState(this, "wrong");
    const wrongName = gameData[clickedID].name;
    document.getElementById("sub-prompt").innerHTML =
      `That is <span style="color:var(--neon-amber)">${wrongName}</span>. Try again.`;
  }
}

function transitionToCapitalPhase(geoData, id) {
  currentPhase = "CITY_SELECTION";
  zoomToState(geoData);
  d3.select(`#state-${id}`).classed("active-focused", true);

  const data = gameData[id];
  document.getElementById("find-label").innerText = "Find Capital";
  document.getElementById("sub-prompt").innerText = "";

  targetCapital = data.capital;

  if (isCapitalMode) {
    document.getElementById("main-prompt").innerText = `Capital: ${targetCapital}`;
  } else {
    const fact = data.facts[Math.floor(Math.random() * data.facts.length)];
    document.getElementById("main-prompt").innerText = "Identify Capital";
    document.getElementById("sub-prompt").innerText = fact;
  }

  plotCapital(id);
  setTimeout(() => { d3.selectAll(".city-node").style("pointer-events", "auto"); }, 800);
}

function plotCapital(id) {
  const data = gameData[id];
  const projected = projection(data.capitalCoord);
  if (!projected) return;

  const node = { name: data.capital, x: projected[0], y: projected[1] };

  g.selectAll(".city-node")
    .data([node])
    .enter().append("circle")
    .attr("class", "city-node")
    .attr("cx", d => d.x)
    .attr("cy", d => d.y)
    .attr("r", 0)
    .on("mouseover", showTooltip)
    .on("mousemove", moveTooltip)
    .on("mouseout", hideTooltip)
    .on("click", (e, d) => handleCapitalClick(e, d, id))
    .transition().duration(500).delay(400).attr("r", 6 / currentScale);
}

function handleCapitalClick(event, cityNode, id) {
  const isCorrect = cityNode.name === targetCapital;
  const dot = d3.select(event.currentTarget);

  if (isCorrect) {
    dot.classed("correct-choice", true);
    score += 20; updateScoreUI();
    showFact(cityNode.name, id, "CORRECT", "status-correct");
  } else {
    dot.classed("wrong-choice", true);
    score -= 10; updateScoreUI();
    showFact(cityNode.name, id, "INCORRECT", "status-wrong");
  }
}

function showFact(cityName, id, status, statusClass) {
  const data = gameData[id];
  const overlay = document.getElementById("fact-overlay");
  const btn = document.getElementById("next-action-btn");

  document.getElementById("fact-status").innerText = status;
  document.getElementById("fact-status").className = `fact-status ${statusClass}`;
  document.getElementById("fact-city-name").innerText = cityName;
  document.getElementById("fact-text").innerText =
    isCapitalMode ? `Capital of ${data.name}` : data.facts[Math.floor(Math.random() * data.facts.length)];

  btn.innerText = (status === "CORRECT") ? "Next Country" : "Close";
  btn.onclick = (status === "CORRECT") ? resetGameRound : () => overlay.classList.remove("show");

  overlay.classList.add("show");
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
  const b = path.bounds(d);
  const dx = b[1][0] - b[0][0];
  const dy = b[1][1] - b[0][1];

  const boundsValid =
    Number.isFinite(dx) &&
    Number.isFinite(dy) &&
    dx > 0 && dy > 0 &&
    dx < width * 3 &&
    dy < height * 3;

  if (boundsValid) {
    const x = (b[0][0] + b[1][0]) / 2;
    const y = (b[0][1] + b[1][1]) / 2;
    const s = Math.max(1, Math.min(10, 0.75 / Math.max(dx / width, dy / height)));
    const t = [width / 2 - s * x, height / 2 - s * y];
    svg.transition().duration(900).call(
      zoom.transform,
      d3.zoomIdentity.translate(t[0], t[1]).scale(s)
    );
    return;
  }

  // Fallback for antimeridian-spanning or extreme geometries
  const centroid = projection(d3.geoCentroid(d));
  if (!centroid) return;

  const s = 4;
  const t = [width / 2 - s * centroid[0], height / 2 - s * centroid[1]];
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
