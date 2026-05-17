// ── State ──────────────────────────────────────────────────────────────────
let map;
let districtLayer;
let roadsLayer;
let highlightLayer;

// Roads
let allSegments = [];
let roads = [];
let uniqueRoadNames = [];

// Communities
let communities = [];
let uniqueCommunityNames = [];

// Mode & quiz
let currentMode = 'roads';
let score = 0;
let streak = 0;
let questionNum = 0;
let currentAnswer = '';
let answered = false;

// ── Road color by category ─────────────────────────────────────────────────
function roadColor(category) {
  switch (category) {
    case 'US Highway':          return '#4a9eff';
    case 'State Highway':       return '#55dd55';
    case 'Primary County Road': return '#ffd700';
    default:                    return '#ffffff';
  }
}

// ── Road style: color from category, weight from rd_class ─────────────────
function roadStyle(rdClass, category) {
  const color = roadColor(category);
  const full = category !== 'Secondary Road';
  switch (rdClass) {
    case 'State':     return { color, weight: full ? 4   : 2.4, opacity: 1.00 };
    case 'County':    return { color, weight: full ? 2.5 : 1.5, opacity: 0.85 };
    case 'Municipal': return { color, weight: full ? 1.8 : 1.0, opacity: 0.80 };
    case 'Public':    return { color, weight: full ? 1.5 : 0.8, opacity: 0.70 };
    case 'Private':   return { color, weight: full ? 1   : 0.5, opacity: 0.50 };
    default:          return { color, weight: full ? 1.2 : 0.7, opacity: 0.55 };
  }
}

// ── Init ───────────────────────────────────────────────────────────────────
async function init() {
  try {
    const [boundaryData, roadsData, categoriesData, communitiesData, exclusionsData] = await Promise.all([
      fetch('/api/boundary').then(r => r.json()),
      fetch('/api/roads').then(r => r.json()),
      fetch('/api/road-categories').then(r => r.json()),
      fetch('/api/communities').then(r => r.json()),
      fetch('/api/community-exclusions').then(r => r.json()),
    ]);

    if (!boundaryData.features?.length) throw new Error('No boundary data returned');
    if (!roadsData.features?.length) throw new Error('No road data returned');

    const categoryMap = {};
    for (const r of categoriesData.roads ?? []) categoryMap[r.name] = r.category;

    initMap(boundaryData.features[0]);
    processRoads(roadsData.features, categoryMap);
    drawAllRoads();
    processCommunities(communitiesData.features ?? [], exclusionsData.excluded ?? []);

    document.getElementById('loading').classList.add('hidden');
    document.getElementById('game').classList.remove('hidden');
    map.invalidateSize();
    nextQuestion();
  } catch (err) {
    console.error(err);
    document.getElementById('loading').classList.add('hidden');
    document.getElementById('error-msg').classList.remove('hidden');
  }
}

// ── Map setup ──────────────────────────────────────────────────────────────
function initMap(districtFeature) {
  map = L.map('map');

  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Imagery © Esri',
    maxZoom: 19,
  }).addTo(map);

  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png', {
    subdomains: 'abcd',
    maxZoom: 19,
    opacity: 0.45,
  }).addTo(map);

  const geojson = {
    type: 'Feature',
    geometry: {
      type: districtFeature.geometry.rings.length > 1 ? 'MultiPolygon' : 'Polygon',
      coordinates: districtFeature.geometry.rings.length > 1
        ? districtFeature.geometry.rings.map(r => [r])
        : districtFeature.geometry.rings,
    },
  };

  districtLayer = L.geoJSON(geojson, {
    style: { color: '#f97316', weight: 2.5, fillColor: '#f97316', fillOpacity: 0.06, dashArray: '6 4' },
  }).addTo(map);

  map.fitBounds(districtLayer.getBounds(), { padding: [20, 20] });
}

// ── Road data processing ───────────────────────────────────────────────────
function processRoads(features, categoryMap) {
  allSegments = [];
  const byName = {};

  for (const f of features) {
    const name = f.attributes?.pstr_fulnam?.trim();
    const rdClass = f.attributes?.rd_class ?? null;
    const paths = f.geometry?.paths;
    if (!name || !paths?.length) continue;

    const category = categoryMap[name] ?? 'Secondary Road';
    if (category === 'Excluded') continue;

    const latlngPaths = paths.map(path => path.map(([lon, lat]) => [lat, lon]));
    allSegments.push({ name, rdClass, category, paths: latlngPaths });

    if (!byName[name]) byName[name] = [];
    for (const path of latlngPaths) byName[name].push(path);
  }

  roads = Object.entries(byName).map(([name, paths]) => ({ name, paths }));
  uniqueRoadNames = roads.map(r => r.name).sort();
  console.log(`Loaded ${allSegments.length} segments, ${roads.length} unique roads`);
}

// ── Community data processing ──────────────────────────────────────────────
function processCommunities(features, excluded) {
  const excludedSet = new Set(excluded);
  const byName = {};

  for (const f of features) {
    const name = f.attributes?.subdivision?.trim();
    const rings = f.geometry?.rings;
    if (!name || !rings?.length || excludedSet.has(name)) continue;

    if (!byName[name]) byName[name] = [];
    for (const ring of rings) {
      byName[name].push(ring.map(([lon, lat]) => [lat, lon]));
    }
  }

  communities = Object.entries(byName).map(([name, rings]) => ({ name, rings }));
  uniqueCommunityNames = communities.map(c => c.name).sort();
  console.log(`Loaded ${communities.length} communities`);
}

// ── Background road rendering ──────────────────────────────────────────────
function drawAllRoads() {
  const order = ['Secondary Road', 'Primary County Road', 'State Highway', 'US Highway'];
  const sorted = [...allSegments].sort(
    (a, b) => order.indexOf(a.category) - order.indexOf(b.category)
  );
  const lines = sorted.flatMap(seg =>
    seg.paths.map(path => L.polyline(path, roadStyle(seg.rdClass, seg.category)))
  );
  roadsLayer = L.layerGroup(lines).addTo(map);
}

// ── Mode switching ─────────────────────────────────────────────────────────
function switchMode(mode) {
  if (mode === currentMode) return;
  currentMode = mode;
  score = 0; streak = 0; questionNum = 0;
  document.getElementById('score').textContent = 0;
  document.getElementById('streak').textContent = 0;
  document.getElementById('question-num').textContent = 0;
  document.getElementById('feedback').classList.add('hidden');
  document.getElementById('feedback').className = 'hidden';
  document.getElementById('next-btn').classList.add('hidden');
  if (highlightLayer) { map.removeLayer(highlightLayer); highlightLayer = null; }
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
  nextQuestion();
}

// ── Quiz logic ─────────────────────────────────────────────────────────────
function nextQuestion() {
  answered = false;
  if (highlightLayer) { map.removeLayer(highlightLayer); highlightLayer = null; }
  document.getElementById('feedback').classList.add('hidden');
  document.getElementById('feedback').className = 'hidden';
  document.getElementById('next-btn').classList.add('hidden');

  if (currentMode === 'roads') {
    const road = roads[Math.floor(Math.random() * roads.length)];
    currentAnswer = road.name;
    questionNum++;
    document.getElementById('question-num').textContent = questionNum;
    document.getElementById('question-text').textContent = 'What road is highlighted on the map?';
    document.getElementById('map-hint').textContent = 'Find the highlighted road';
    document.getElementById('next-btn').textContent = 'Next Road →';
    highlightRoad(road);
    renderChoices(uniqueRoadNames, road.name);
  } else {
    const community = communities[Math.floor(Math.random() * communities.length)];
    currentAnswer = community.name;
    questionNum++;
    document.getElementById('question-num').textContent = questionNum;
    document.getElementById('question-text').textContent = 'What community or subdivision is highlighted?';
    document.getElementById('map-hint').textContent = 'Find the highlighted area';
    document.getElementById('next-btn').textContent = 'Next Community →';
    highlightCommunity(community);
    renderChoices(uniqueCommunityNames, community.name);
  }
}

function highlightRoad(road) {
  const lines = road.paths.map(path =>
    L.polyline(path, { color: '#e63000', weight: 7, opacity: 1 })
  );
  highlightLayer = L.layerGroup(lines).addTo(map);

  const allPoints = road.paths.flat();
  map.fitBounds(L.latLngBounds(allPoints), { padding: [60, 60], maxZoom: 16, animate: true });
}

function highlightCommunity(community) {
  const layers = community.rings.map(ring =>
    L.polygon(ring, { color: '#06b6d4', weight: 3, fillColor: '#06b6d4', fillOpacity: 0.3 })
  );
  highlightLayer = L.layerGroup(layers).addTo(map);

  const allPoints = community.rings.flat();
  map.fitBounds(L.latLngBounds(allPoints), { padding: [40, 40], animate: true });
}

function renderChoices(pool, correctName) {
  const wrong = pool
    .filter(n => n !== correctName)
    .sort(() => Math.random() - 0.5)
    .slice(0, 3);

  const options = [...wrong, correctName].sort(() => Math.random() - 0.5);
  const container = document.getElementById('choices');
  container.innerHTML = '';
  for (const name of options) {
    const btn = document.createElement('button');
    btn.className = 'choice-btn';
    btn.textContent = name;
    btn.addEventListener('click', () => handleAnswer(name, btn));
    container.appendChild(btn);
  }
}

function handleAnswer(chosen, btn) {
  if (answered) return;
  answered = true;

  const correct = chosen === currentAnswer;
  const feedback = document.getElementById('feedback');
  document.querySelectorAll('.choice-btn').forEach(b => {
    b.disabled = true;
    if (b.textContent === currentAnswer) b.classList.add('correct');
  });

  if (correct) {
    score++; streak++;
    btn.classList.add('correct');
    feedback.className = 'correct';
    document.getElementById('feedback-icon').textContent = '✅';
    document.getElementById('feedback-text').textContent = `Correct! ${currentAnswer}`;
  } else {
    streak = 0;
    btn.classList.add('wrong');
    feedback.className = 'wrong';
    document.getElementById('feedback-icon').textContent = '❌';
    document.getElementById('feedback-text').textContent = `It was: ${currentAnswer}`;
  }

  feedback.classList.remove('hidden');
  document.getElementById('score').textContent = score;
  document.getElementById('streak').textContent = streak;
  document.getElementById('next-btn').classList.remove('hidden');
}

document.getElementById('next-btn').addEventListener('click', nextQuestion);

document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => switchMode(btn.dataset.mode));
});

init();
