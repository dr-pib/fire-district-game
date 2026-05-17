const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

const GIS_BASE = 'https://gis.arkansas.gov/arcgis/rest/services/FEATURESERVICES';
const BOUNDARY_URL = `${GIS_BASE}/Boundaries/FeatureServer/59/query`;
const ROADS_URL = `${GIS_BASE}/Transportation/FeatureServer/18/query`;
// DATA_DIR can be set to a Railway Volume mount path (e.g. /data) for persistence across deploys.
// Falls back to the project root for local development.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const CATEGORIES_FILE = path.join(DATA_DIR, 'road-categories.json');

// ── Category persistence ───────────────────────────────────────────────────
function loadManualCategories() {
  try { return JSON.parse(fs.readFileSync(CATEGORIES_FILE, 'utf8')); }
  catch { return {}; }
}
function saveManualCategories(cats) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CATEGORIES_FILE, JSON.stringify(cats, null, 2));
}
let manualCategories = loadManualCategories();

// ── Auto-categorization rules ──────────────────────────────────────────────
const US_ROUTE_NUMS = new Set(['62', '65', '412']);

function autoCategory(name, pstrType) {
  const n = (name ?? '').trim().toUpperCase();
  if (n === 'RAMP' || n === 'RAMP E') return 'US Highway';
  if (n.startsWith('OLD ')) return 'Secondary Road';
  const m = n.match(/\bHWY\s+(\d+)/);
  if (m) return US_ROUTE_NUMS.has(m[1]) ? 'US Highway' : 'State Highway';
  if (pstrType === 'Rd') return 'Primary County Road';
  return 'Secondary Road';
}

app.use(express.static('public'));
app.use(express.json());

// ── District boundary (cached) ─────────────────────────────────────────────
let boundaryCache = null;
async function getBoundary() {
  if (boundaryCache) return boundaryCache;
  const params = new URLSearchParams({
    where: "fdid_nfirsid='05003'",
    outFields: 'name,fdid_nfirsid',
    f: 'json',
    returnGeometry: true,
    outSR: '4326',
  });
  const res = await fetch(`${BOUNDARY_URL}?${params}`);
  const data = await res.json();
  boundaryCache = data;
  return data;
}

app.get('/api/boundary', async (req, res) => {
  try { res.json(await getBoundary()); }
  catch (err) { console.error('Boundary fetch error:', err); res.status(500).json({ error: err.message }); }
});

// ── All road centerlines within the district (cached for the session) ──────
let roadsCache = null;
async function getAllRoads() {
  if (roadsCache) return roadsCache;

  const boundary = await getBoundary();
  const feature = boundary.features?.[0];
  if (!feature) throw new Error('District boundary not found');

  const geometryParam = JSON.stringify({
    rings: feature.geometry.rings,
    spatialReference: { wkid: 4326 },
  });

  const baseParams = {
    where: "cn_l_fips='009' AND pstr_fulnam IS NOT NULL AND pstr_fulnam <> ''",
    outFields: 'pstr_fulnam,rd_class,pstr_type',
    returnGeometry: 'true',
    geometry: geometryParam,
    geometryType: 'esriGeometryPolygon',
    spatialRel: 'esriSpatialRelIntersects',
    inSR: '4326',
    outSR: '4326',
    f: 'json',
    resultRecordCount: 200,
  };

  const allFeatures = [];
  let offset = 0;
  let exceededTransferLimit = true;
  while (exceededTransferLimit) {
    const body = new URLSearchParams({ ...baseParams, resultOffset: offset });
    // POST avoids URL-length limits with a large polygon geometry param
    const res = await fetch(ROADS_URL, { method: 'POST', body });
    const data = await res.json();
    const features = data.features || [];
    allFeatures.push(...features);
    exceededTransferLimit = data.exceededTransferLimit === true && features.length > 0;
    offset += features.length;
    if (features.length === 0) break;
  }

  console.log(`Fetched ${allFeatures.length} road centerline segments from GIS`);
  roadsCache = { features: allFeatures };
  return roadsCache;
}

app.get('/api/roads', async (req, res) => {
  try { res.json(await getAllRoads()); }
  catch (err) { console.error('Roads fetch error:', err); res.status(500).json({ error: err.message }); }
});

// ── Road category management ───────────────────────────────────────────────
app.get('/api/road-categories', async (req, res) => {
  try {
    const roadsData = await getAllRoads();

    // Unique road name → pstr_type (first segment wins)
    const seen = new Map();
    for (const f of roadsData.features) {
      const name = f.attributes?.pstr_fulnam?.trim();
      const pstrType = f.attributes?.pstr_type ?? null;
      if (name && !seen.has(name)) seen.set(name, pstrType);
    }

    const roads = [...seen.entries()]
      .map(([name, pstrType]) => {
        const auto = autoCategory(name, pstrType);
        const manual = manualCategories[name];
        return { name, pstrType, autoCategory: auto, category: manual ?? auto, isManual: !!manual };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    res.json({ roads });
  } catch (err) {
    console.error('Road categories error:', err);
    res.status(500).json({ error: err.message });
  }
});

const VALID_CATEGORIES = ['US Highway', 'State Highway', 'Primary County Road', 'Secondary Road', 'Excluded'];

app.post('/api/road-categories', (req, res) => {
  const { name, category } = req.body ?? {};
  if (!name || !VALID_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: 'Invalid name or category' });
  }
  manualCategories[name] = category;
  saveManualCategories(manualCategories);
  res.json({ ok: true });
});

// Reset a road back to its auto-detected category
app.delete('/api/road-categories/:name', (req, res) => {
  const name = decodeURIComponent(req.params.name);
  delete manualCategories[name];
  saveManualCategories(manualCategories);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Fire District Game running at http://localhost:${PORT}`);
});
