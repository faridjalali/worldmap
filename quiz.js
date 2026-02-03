const URLS = {
  topo: [
    "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json",
    "https://unpkg.com/world-atlas@2/countries-110m.json"
  ],
  rest: [
    "https://restcountries.com/v3.1/all?fields=name,cca3,region,subregion,capital,capitalInfo,population,area,languages,currencies",
    "https://restcountries.com/v3.1/all"
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

window.onload = initGame;

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
    const topo = await fetchFirstOk(URLS.topo, "TopoJSON");
    const rest = await fetchFirstOk(URLS.rest, "RestCountries");

    const world = topojson.feature(topo, topo.objects.countries);
    features = world.features;

    const restByName = buildRestLookup(rest);
    gameData = buildGameData(features, restByName, continentParam);

    if (Object.keys(gameData).length === 0) {
      throw new Error("No countries matched for this continent.");
    }

    const filteredFeatures = features.filter(f => gameData[f.id]);

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
      .attr("id", d => `state-${d.id}`)
      .on("click", handleStateClick);

    startRound();
  } catch (err) {
    console.error(err);
    document.getElementById("main-prompt").innerText = "Error Loading Map";
    document.getElementById("sub-prompt").innerText = err.message;
  }
}

async function fetchFirstOk(urls, label) {
  let lastErr = null;
  for (const url of urls) {
    try {
      const res = await fetch(url, { mode: "cors" });
      if (!res.ok) throw new Error(`${label} fetch failed (${res.status}) from ${url}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`${label} fetch failed on all sources. ${lastErr ? lastErr.message : ""}`);
}

function buildRestLookup(restCountries) {
  const map = new Map();
  for (const c of restCountries) {
    const name = c?.name?.common;
    if (!name) continue;
    map.set(normalizeName(name), c);
  }
  return map;
}

function buildGameData(features, restByName, continent) {
  const data = {};
  for (const f of features) {
    const name = f?.properties?.name;
    if (!name) continue;

    const rest = resolveCountry(name, restByName);
    if (!rest) continue;

    if (!continentMatch(rest, continent)) continue;

    const capital = (rest.capital && rest.capital[0]) ? rest.capital[0] : null;
    const capitalLatLng = rest.capitalInfo?.latlng || null;

    if (!capital || !capitalLatLng) continue;

    data[f.id] = {
      id: f.id,
      name,
      iso: rest.cca3,
      capital,
      capitalLatLng,
      facts: buildFacts(rest)
    };
  }
  return data;
}

function resolveCountry(name, restByName) {
  const key = normalizeName(name);
  if (restByName.has(key)) return restByName.get(key);

  const alias = aliasMap[key];
  if (alias && restByName.has(alias)) return restByName.get(alias);

  return null;
}

const aliasMap = {
  "bolivia": "bolivia (plurinational state of)",
  "brunei": "brunei darussalam",
  "cape verde": "cabo verde",
  "czechia": "czech republic",
  "cote d ivoire": "côte d'ivoire",
  "ivory coast": "côte d'ivoire",
  "democratic republic of the congo": "congo (democratic republic of the)",
  "republic of the congo": "congo",
  "iran": "iran (islamic republic of)",
  "laos": "lao people's democratic republic",
  "moldova": "moldova (republic of)",
  "north macedonia": "macedonia (the former yugoslav republic of)",
  "russia": "russian federation",
  "syria": "syrian arab republic",
  "tanzania": "tanzania, united republic of",
  "venezuela": "venezuela (bolivarian republic of)",
  "vietnam": "viet nam",
  "palestine": "palestine, state of"
};

function normalizeName(name) {
  return name.toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function continentMatch(rest, continent) {
  if (continent === "world") return true;
  const region = (rest.region || "").toLowerCase();
  const subregion = (rest.subregion || "").toLowerCase();

  switch (continent) {
    case "africa": return region === "africa";
    case "asia": return region === "asia";
    case "europe": return region === "europe";
    case "oceania": return region === "oceania";
    case "south-america": return subregion === "south america";
    case "north-america": return region === "americas" && subregion !== "south america";
    default: return true;
  }
}

function buildFacts(rest) {
  const pop = rest.population ? rest.population.toLocaleString() : "Unknown";
  const area = rest.area ? rest.area.toLocaleString() + " km²" : "Unknown";
  const languages = rest.languages ? Object.values(rest.languages).slice(0, 3).join(", ") : "Unknown";
  const currencies = rest.currencies ? Object.values(rest.currencies).map(c => c.name).slice(0, 2).join(", ") : "Unknown";

  return [
    `Population: ${pop}`,
    `Area: ${area}`,
    `Languages: ${languages}`,
    `Currencies: ${currencies}`
  ];
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

  const clickedID = d.id;
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
  const coords = [data.capitalLatLng[1], data.capitalLatLng[0]];
  const projected = projection(coords);
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
  const dx = b[1][0] - b[0][0], dy = b[1][1] - b[0][1];
  const x = (b[0][0] + b[1][0]) / 2, y = (b[0][1] + b[1][1]) / 2;
  const s = Math.max(1, Math.min(10, 0.7 / Math.max(dx / width, dy / height)));
  const t = [width / 2 - s * x, height / 2 - s * y];
  svg.transition().duration(1000).call(zoom.transform, d3.zoomIdentity.translate(t[0], t[1]).scale(s));
}

function resetZoom() { svg.transition().duration(1000).call(zoom.transform, d3.zoomIdentity); }
function flashState(el, type) {
  d3.select(el).classed(type + "-flash", true);
  setTimeout(() => d3.select(el).classed(type + "-flash", false), 500);
}
