// Backend PredictiveFlow (Express + lowdb + jwt)
// Maintenance prédictive : paramètres, données brutes, alarmes auto, maintenance, Weibull
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { Low } = require('lowdb');
const { JSONFile } = require('lowdb/node');
const jwt = require('jsonwebtoken');
const { nanoid } = require('nanoid');
const path = require('path');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-jwt-secret';
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'db.json');

(async () => {
  const defaultData = {
    settings: {
      adminEmail: process.env.ADMIN_EMAIL || 'admin@predictiveflow.test',
      adminPassword: process.env.ADMIN_PASSWORD || 'demo1234'
    },
    plans: [
      { id: 'starter', name: 'Starter', price: 29, per: '/mois', features: ['limite machines: 5','limite utilisateurs: 3'], recommended: false },
      { id: 'pro', name: 'Pro', price: 129, per: '/mois', features: ['limite machines: 50','module Weibull'], recommended: true },
      { id: 'enterprise', name: 'Entreprise', price: 0, per: 'Sur devis', features: ['machines illimitées','support prioritaire'], recommended: false }
    ],
    users: [],
    machines: [],
    parameters: [],
    rawData: [],
    alarms: [],
    maintenance: [],
    adminLog: []
  };

  const adapter = new JSONFile(DB_FILE);
  const db = new Low(adapter, defaultData);
  await db.read();
  if (!db.data.machines) db.data.machines = [];
  if (!db.data.parameters) db.data.parameters = [];
  if (!db.data.rawData) db.data.rawData = [];
  if (!db.data.alarms) db.data.alarms = [];
  if (!db.data.maintenance) db.data.maintenance = [];
  await db.write();

  const app = express();
  app.use(cors());
  app.use(bodyParser.json({ limit: '5mb' }));
  app.use(express.static(path.join(__dirname, 'public')));

  // ---- AUTH MIDDLEWARE ----
  function authMiddleware(requiredAdmin = false) {
    return (req, res, next) => {
      const auth = req.headers.authorization;
      if (!auth || !auth.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      try {
        const token = auth.slice(7);
        const payload = jwt.verify(token, JWT_SECRET);
        if (requiredAdmin && payload.role !== 'admin') {
          return res.status(403).json({ error: 'Forbidden - Admin required' });
        }
        req.user = payload;
        next();
      } catch (e) {
        return res.status(401).json({ error: 'Invalid token' });
      }
    };
  }

  // ---- HELPERS ----
  function computeStatus(valeur, seuilBas, seuilHaut) {
    const v = parseFloat(valeur);
    const lb = parseFloat(seuilBas);
    const hb = parseFloat(seuilHaut);
    if (isNaN(v)) return 'N/A';
    if (!isNaN(lb) && v < lb) return 'ALARME_BAS';
    if (!isNaN(hb) && v > hb) return 'ALARME_HAUT';
    return 'OK';
  }

  function isAlarm(status) {
    return status && (status === 'ALARME_BAS' || status === 'ALARME_HAUT');
  }

  // Auto-generate alarms from raw data + parameters
  function regenerateAlarms() {
    const params = db.data.parameters;
    const raw = db.data.rawData;
    const newAlarms = [];

    for (const row of raw) {
      // Find matching parameter by tag or (composant + variable)
      const param = params.find(p =>
        (p.tag && row.tag && p.tag === row.tag) ||
        (p.composant === row.composant && p.variable === row.variable)
      );

      if (param) {
        const status = computeStatus(row.valeur, param.seuil_bas, param.seuil_haut);
        row.statut_auto = status;
        row.unite_auto = param.unite || row.unite_auto || '';
        row.seuil_bas_auto = param.seuil_bas || '';
        row.seuil_haut_auto = param.seuil_haut || '';

        if (isAlarm(status)) {
          newAlarms.push({
            id: nanoid(8),
            timestamp: row.date_mesure,
            ligne: row.ligne || '',
            zone: row.zone || '',
            composant: row.composant || '',
            tag: row.tag || '',
            variable: row.variable || '',
            valeur: row.valeur,
            unite_auto: row.unite_auto,
            statut_auto: status,
            seuil_bas_auto: row.seuil_bas_auto,
            seuil_haut_auto: row.seuil_haut_auto,
            lot_produit: row.lot_produit || '',
            commentaire: row.commentaire || ''
          });
        }
      } else {
        row.statut_auto = row.statut_auto || 'N/A';
      }
    }

    db.data.alarms = newAlarms;
  }

  // Compute Weibull parameters from maintenance data
  function computeWeibull(times) {
    if (!times || times.length === 0) return null;

    const sorted = [...times].map(Number).filter(n => !isNaN(n) && n > 0).sort((a, b) => a - b);
    const n = sorted.length;
    if (n === 0) return null;

    // Rank and median rank (F = (i - 0.3) / (n + 0.4))
    const points = sorted.map((t, i) => {
      const rank = i + 1;
      const F = (rank - 0.3) / (n + 0.4);
      const lnX = Math.log(t);
      const lnln = Math.log(-Math.log(1 - F));
      return { t, rank, F, lnX, lnln };
    });

    // Linear regression: Y = ln(-ln(1-F)) vs X = ln(t)
    // Y = beta * X - beta * ln(alpha)  =>  slope = beta, intercept = -beta*ln(alpha)
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    for (const p of points) {
      if (isNaN(p.lnX) || isNaN(p.lnln)) continue;
      sumX += p.lnX;
      sumY += p.lnln;
      sumXY += p.lnX * p.lnln;
      sumX2 += p.lnX * p.lnX;
    }
    const count = points.filter(p => !isNaN(p.lnX) && !isNaN(p.lnln)).length;
    if (count < 2) return null;

    const beta = (count * sumXY - sumX * sumY) / (count * sumX2 - sumX * sumX);
    const intercept = (sumY - beta * sumX) / count;
    const alpha = Math.exp(-intercept / beta);

    // Reliability at time t: R(t) = exp(-(t/alpha)^beta)
    // MTBF = alpha * gamma(1 + 1/beta)
    const mtbf = alpha * gammaFn(1 + 1 / beta);

    return { beta, alpha, mtbf, n, points };
  }

  // Simple gamma approximation (Lanczos)
  function gammaFn(z) {
    const g = 7;
    const c = [
      0.99999999999980993, 676.5203681218851, -1259.1392167224028,
      771.32342877765313, -176.61502916214059, 12.507343278686905,
      -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7
    ];
    if (z < 0.5) return Math.PI / (Math.sin(Math.PI * z) * gammaFn(1 - z));
    z -= 1;
    let x = c[0];
    for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
    const t = z + g + 0.5;
    return Math.sqrt(2 * Math.PI) * Math.pow(t, z + 0.5) * Math.exp(-t) * x;
  }

  // ============ SETTINGS ============
  app.get('/api/settings', (req, res) => res.json(db.data.settings));
  app.post('/api/settings', authMiddleware(true), async (req, res) => {
    db.data.settings = Object.assign(db.data.settings, req.body);
    await db.write();
    res.json({ ok: true, settings: db.data.settings });
  });

  // ============ AUTH ============
  app.post('/api/login', async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email & password required' });
    const s = db.data.settings;
    if (email === s.adminEmail && password === s.adminPassword) {
      const token = jwt.sign({ email, role: 'admin' }, JWT_SECRET, { expiresIn: '7d' });
      return res.json({ token, role: 'admin', email });
    }
    const user = db.data.users.find(u => u.email === email);
    if (user) {
      if (user.password && password !== user.password) return res.status(401).json({ error: 'Invalid credentials' });
      const token = jwt.sign({ email, role: 'client' }, JWT_SECRET, { expiresIn: '7d' });
      return res.json({ token, role: 'client', email, name: user.name, planId: user.planId });
    }
    return res.status(401).json({ error: 'Invalid credentials' });
  });

  app.post('/api/register', async (req, res) => {
    const { name, company, email, password, planId } = req.body || {};
    if (!email || !name) return res.status(400).json({ error: 'name & email required' });
    if (db.data.users.find(u => u.email === email)) return res.status(409).json({ error: 'User exists' });
    const user = { id: nanoid(8), name, company: company || '', email, password: password || '', planId: planId || null, created: new Date().toLocaleString('fr-FR') };
    db.data.users.unshift(user);
    await db.write();
    res.json({ ok: true, user });
  });

  app.get('/api/me', authMiddleware(false), (req, res) => res.json({ email: req.user.email, role: req.user.role }));

  // ============ PLANS ============
  app.get('/api/plans', (req, res) => res.json(db.data.plans));
  app.post('/api/plans', authMiddleware(true), async (req, res) => {
    const p = req.body;
    if (!p.name) return res.status(400).json({ error: 'name required' });
    p.id = p.id || nanoid(6);
    db.data.plans.unshift(p);
    await db.write();
    res.json({ ok: true, plan: p });
  });
  app.put('/api/plans/:id', authMiddleware(true), async (req, res) => {
    const plan = db.data.plans.find(p => p.id === req.params.id);
    if (!plan) return res.status(404).json({ error: 'Not found' });
    Object.assign(plan, req.body);
    await db.write();
    res.json({ ok: true, plan });
  });
  app.delete('/api/plans/:id', authMiddleware(true), async (req, res) => {
    db.data.plans = db.data.plans.filter(p => p.id !== req.params.id);
    await db.write();
    res.json({ ok: true });
  });

  // ============ MACHINES ============
  app.get('/api/machines', authMiddleware(false), (req, res) => res.json(db.data.machines || []));
  app.post('/api/machines', authMiddleware(false), async (req, res) => {
    const { name, type, status, location, lastInspection, nextPrediction, notes } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name required' });
    const machine = { id: nanoid(8), name, type: type || 'Autre', status: status || 'ok', location: location || '', lastInspection: lastInspection || '', nextPrediction: nextPrediction || '', notes: notes || '', created: new Date().toLocaleString('fr-FR') };
    db.data.machines.unshift(machine);
    await db.write();
    res.json({ ok: true, machine });
  });
  app.put('/api/machines/:id', authMiddleware(false), async (req, res) => {
    const m = db.data.machines.find(m => m.id === req.params.id);
    if (!m) return res.status(404).json({ error: 'Machine not found' });
    Object.assign(m, req.body);
    await db.write();
    res.json({ ok: true, machine: m });
  });
  app.delete('/api/machines/:id', authMiddleware(false), async (req, res) => {
    db.data.machines = db.data.machines.filter(m => m.id !== req.params.id);
    await db.write();
    res.json({ ok: true });
  });

  // ============ PARAMETERS (PARAMETRES) ============
  app.get('/api/parameters', authMiddleware(false), (req, res) => res.json(db.data.parameters || []));

  app.post('/api/parameters', authMiddleware(false), async (req, res) => {
    const p = {
      id: nanoid(8),
      composant: req.body.composant || '',
      zone: req.body.zone || '',
      variable: req.body.variable || '',
      tag: req.body.tag || '',
      unite: req.body.unite || '',
      type_signal: req.body.type_signal || 'Analogique',
      seuil_bas: req.body.seuil_bas !== undefined ? req.body.seuil_bas : '',
      seuil_haut: req.body.seuil_haut !== undefined ? req.body.seuil_haut : '',
      criticite: req.body.criticite || 'Moyenne',
      date_mise_en_service: req.body.date_mise_en_service || '',
      frequence_acquisition: req.body.frequence_acquisition || '',
      commentaire: req.body.commentaire || ''
    };
    db.data.parameters.unshift(p);
    await db.write();
    // Re-evaluate alarms with new parameter
    regenerateAlarms();
    await db.write();
    res.json({ ok: true, parameter: p });
  });

  app.put('/api/parameters/:id', authMiddleware(false), async (req, res) => {
    const p = db.data.parameters.find(p => p.id === req.params.id);
    if (!p) return res.status(404).json({ error: 'Parameter not found' });
    Object.assign(p, req.body);
    await db.write();
    regenerateAlarms();
    await db.write();
    res.json({ ok: true, parameter: p });
  });

  app.delete('/api/parameters/:id', authMiddleware(false), async (req, res) => {
    db.data.parameters = db.data.parameters.filter(p => p.id !== req.params.id);
    regenerateAlarms();
    await db.write();
    res.json({ ok: true });
  });

  // ============ RAW DATA (DONNEES_BRUTES) ============
  app.get('/api/raw-data', authMiddleware(false), (req, res) => res.json(db.data.rawData || []));

  app.post('/api/raw-data', authMiddleware(false), async (req, res) => {
    // Accept single or array
    const rows = Array.isArray(req.body) ? req.body : [req.body];
    const created = [];
    for (const body of rows) {
      const row = {
        id: nanoid(8),
        date_mesure: body.date_mesure || new Date().toLocaleString('fr-FR'),
        ligne: body.ligne || '',
        zone: body.zone || '',
        composant: body.composant || '',
        tag: body.tag || '',
        variable: body.variable || '',
        valeur: body.valeur,
        unite_auto: '',
        statut_auto: 'N/A',
        seuil_bas_auto: '',
        seuil_haut_auto: '',
        lot_produit: body.lot_produit || '',
        commentaire: body.commentaire || ''
      };
      // Auto-fill from parameters
      const param = db.data.parameters.find(p =>
        (p.tag && row.tag && p.tag === row.tag) ||
        (p.composant === row.composant && p.variable === row.variable)
      );
      if (param) {
        row.unite_auto = param.unite || '';
        row.seuil_bas_auto = param.seuil_bas || '';
        row.seuil_haut_auto = param.seuil_haut || '';
        row.statut_auto = computeStatus(row.valeur, param.seuil_bas, param.seuil_haut);
      }
      db.data.rawData.unshift(row);
      created.push(row);
    }
    regenerateAlarms();
    await db.write();
    res.json({ ok: true, rows: created });
  });

  app.put('/api/raw-data/:id', authMiddleware(false), async (req, res) => {
    const row = db.data.rawData.find(r => r.id === req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    Object.assign(row, req.body);
    // Re-evaluate status
    const param = db.data.parameters.find(p =>
      (p.tag && row.tag && p.tag === row.tag) ||
      (p.composant === row.composant && p.variable === row.variable)
    );
    if (param) {
      row.statut_auto = computeStatus(row.valeur, param.seuil_bas, param.seuil_haut);
      row.seuil_bas_auto = param.seuil_bas || '';
      row.seuil_haut_auto = param.seuil_haut || '';
    }
    regenerateAlarms();
    await db.write();
    res.json({ ok: true, row });
  });

  app.delete('/api/raw-data/:id', authMiddleware(false), async (req, res) => {
    db.data.rawData = db.data.rawData.filter(r => r.id !== req.params.id);
    regenerateAlarms();
    await db.write();
    res.json({ ok: true });
  });

  app.delete('/api/raw-data', authMiddleware(false), async (req, res) => {
    db.data.rawData = [];
    db.data.alarms = [];
    await db.write();
    res.json({ ok: true });
  });

  // ============ ALARMS (ALARMES_AUTO) ============
  app.get('/api/alarms', authMiddleware(false), (req, res) => res.json(db.data.alarms || []));
  app.delete('/api/alarms', authMiddleware(false), async (req, res) => {
    db.data.alarms = [];
    await db.write();
    res.json({ ok: true });
  });

  // ============ MAINTENANCE ============
  app.get('/api/maintenance', authMiddleware(false), (req, res) => res.json(db.data.maintenance || []));

  app.post('/api/maintenance', authMiddleware(false), async (req, res) => {
    const m = {
      id: nanoid(8),
      id_panne: req.body.id_panne || nanoid(6),
      date_panne: req.body.date_panne || new Date().toLocaleString('fr-FR'),
      composant: req.body.composant || '',
      type_panne: req.body.type_panne || '',
      temps_fonctionnement_avant_panne: req.body.temps_fonctionnement_avant_panne || 0,
      cycles_avant_panne: req.body.cycles_avant_panne || 0,
      action_realisee: req.body.action_realisee || '',
      piece_remplacee: req.body.piece_remplacee || '',
      duree_arret: req.body.duree_arret || 0,
      cout_estime: req.body.cout_estime || 0,
      commentaire: req.body.commentaire || ''
    };
    db.data.maintenance.unshift(m);
    await db.write();
    res.json({ ok: true, maintenance: m });
  });

  app.put('/api/maintenance/:id', authMiddleware(false), async (req, res) => {
    const m = db.data.maintenance.find(m => m.id === req.params.id);
    if (!m) return res.status(404).json({ error: 'Not found' });
    Object.assign(m, req.body);
    await db.write();
    res.json({ ok: true, maintenance: m });
  });

  app.delete('/api/maintenance/:id', authMiddleware(false), async (req, res) => {
    db.data.maintenance = db.data.maintenance.filter(m => m.id !== req.params.id);
    await db.write();
    res.json({ ok: true });
  });

  // ============ INDICATORS (INDICATEURS_AUTO) ============
  app.get('/api/indicators', authMiddleware(false), (req, res) => {
    const raw = db.data.rawData || [];
    const alarms = db.data.alarms || [];
    const maint = db.data.maintenance || [];

    // Global KPIs
    const totalMeasures = raw.length;
    const totalAlarms = alarms.length;
    const totalPannes = maint.length;
    const totalDowntime = maint.reduce((s, m) => s + (parseFloat(m.duree_arret) || 0), 0);
    const avgDowntime = totalPannes > 0 ? totalDowntime / totalPannes : 0;
    const totalCost = maint.reduce((s, m) => s + (parseFloat(m.cout_estime) || 0), 0);

    // Per-component stats
    const components = {};
    for (const m of maint) {
      const c = m.composant || 'Inconnu';
      if (!components[c]) components[c] = { nb_pannes: 0, temps_total: 0, cycles_total: 0, cout_total: 0, temps_list: [] };
      components[c].nb_pannes++;
      components[c].temps_total += parseFloat(m.temps_fonctionnement_avant_panne) || 0;
      components[c].cycles_total += parseFloat(m.cycles_avant_panne) || 0;
      components[c].cout_total += parseFloat(m.cout_estime) || 0;
      if (parseFloat(m.temps_fonctionnement_avant_panne) > 0) components[c].temps_list.push(parseFloat(m.temps_fonctionnement_avant_panne));
    }

    const perComponent = Object.entries(components).map(([composant, s]) => ({
      composant,
      nb_pannes: s.nb_pannes,
      temps_moyen_avant_panne: s.nb_pannes > 0 ? Math.round(s.temps_total / s.nb_pannes * 100) / 100 : 0,
      cycles_moyens_avant_panne: s.nb_pannes > 0 ? Math.round(s.cycles_total / s.nb_pannes * 100) / 100 : 0,
      cout_total: s.cout_total
    }));

    // Per-variable alarm counts
    const varAlarms = {};
    for (const a of alarms) {
      const key = `${a.composant || ''} / ${a.variable || ''}`;
      varAlarms[key] = (varAlarms[key] || 0) + 1;
    }
    const perVariable = Object.entries(varAlarms).map(([variable, nb_alarmes]) => ({ variable, nb_alarmes }));

    res.json({
      global: { totalMeasures, totalAlarms, totalPannes, avgDowntime, totalCost, totalDowntime },
      perComponent,
      perVariable
    });
  });

  // ============ WEIBULL ============
  app.get('/api/weibull', authMiddleware(false), (req, res) => {
    const maint = db.data.maintenance || [];
    const composant = req.query.composant;

    // Filter by component if specified
    let filtered = maint;
    if (composant && composant !== 'all') {
      filtered = maint.filter(m => m.composant === composant);
    }

    // Group by component
    const byComponent = {};
    for (const m of filtered) {
      const c = m.composant || 'Inconnu';
      if (!byComponent[c]) byComponent[c] = [];
      const t = parseFloat(m.temps_fonctionnement_avant_panne);
      if (!isNaN(t) && t > 0) byComponent[c].push(t);
    }

    const results = {};
    for (const [c, times] of Object.entries(byComponent)) {
      results[c] = computeWeibull(times);
    }

    // Also return all times if no component filter (for "all" view)
    if (!composant || composant === 'all') {
      const allTimes = filtered
        .map(m => parseFloat(m.temps_fonctionnement_avant_panne))
        .filter(t => !isNaN(t) && t > 0);
      results._global = computeWeibull(allTimes);
    }

    res.json({ components: results, availableComponents: Object.keys(byComponent) });
  });

  // ============ DASHBOARD ============
  app.get('/api/dashboard', authMiddleware(false), (req, res) => {
    const raw = db.data.rawData || [];
    const alarms = db.data.alarms || [];
    const maint = db.data.maintenance || [];
    const params = db.data.parameters || [];
    const machines = db.data.machines || [];

    const totalCost = maint.reduce((s, m) => s + (parseFloat(m.cout_estime) || 0), 0);
    const totalDowntime = maint.reduce((s, m) => s + (parseFloat(m.duree_arret) || 0), 0);

    // Recent alarms (last 10)
    const recentAlarms = alarms.slice(0, 10);

    // Status distribution
    const statusCounts = { OK: 0, ALARME_BAS: 0, ALARME_HAUT: 0, N_A: 0 };
    for (const r of raw) {
      if (r.statut_auto === 'OK') statusCounts.OK++;
      else if (r.statut_auto === 'ALARME_BAS') statusCounts.ALARME_BAS++;
      else if (r.statut_auto === 'ALARME_HAUT') statusCounts.ALARME_HAUT++;
      else statusCounts.N_A++;
    }

    res.json({
      totalMeasures: raw.length,
      totalAlarms: alarms.length,
      totalPannes: maint.length,
      totalCost,
      totalDowntime,
      totalParameters: params.length,
      totalMachines: machines.length,
      statusCounts,
      recentAlarms
    });
  });

  // ============ USERS (admin) ============
  app.get('/api/users', authMiddleware(true), (req, res) => res.json(db.data.users));
  app.delete('/api/users/:id', authMiddleware(true), async (req, res) => {
    db.data.users = db.data.users.filter(u => u.id !== req.params.id);
    await db.write();
    res.json({ ok: true });
  });

  // ============ ADMIN LOG ============
  app.get('/api/admin/log', authMiddleware(true), (req, res) => res.json(db.data.adminLog || []));

  // Fallback
  app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

  app.listen(PORT, () => console.log(`PredictiveFlow server listening on port ${PORT}`));
})();
