// Backend PredictiveFlow (Express + lowdb + jwt) — sans module devis
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
    adminLog: []
  };
  const adapter = new JSONFile(DB_FILE);
  const db = new Low(adapter, defaultData);
  await db.read();
  // Ensure machines array exists (for existing db.json without it)
  if (!db.data.machines) db.data.machines = [];
  await db.write();

  const app = express();
  app.use(cors());
  app.use(bodyParser.json());
  app.use(express.static(path.join(__dirname, 'public')));

  function authMiddleware(requiredAdmin = false) {
    return (req, res, next) => {
      const auth = req.headers.authorization;
      if (!auth || !auth.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      const token = auth.slice(7);
      try {
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

  // --- SETTINGS ---
  app.get('/api/settings', (req, res) => {
    res.json(db.data.settings);
  });
  app.post('/api/settings', authMiddleware(true), (req, res) => {
    const s = req.body;
    db.data.settings = Object.assign(db.data.settings, s);
    db.write();
    db.data.adminLog.unshift({ date: new Date().toLocaleString('fr-FR'), text: 'Settings updated via API' });
    db.write();
    res.json({ ok: true, settings: db.data.settings });
  });

  // --- AUTH ---
  app.post('/api/login', async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email & password required' });

    const settings = db.data.settings;
    if (email === settings.adminEmail && password === settings.adminPassword) {
      const token = jwt.sign({ email, role: 'admin' }, JWT_SECRET, { expiresIn: '7d' });
      db.data.adminLog.unshift({ date: new Date().toLocaleString('fr-FR'), text: `Admin login: ${email}` });
      await db.write();
      return res.json({ token, role: 'admin', email });
    }

    const user = db.data.users.find(u => u.email === email);
    if (user) {
      if (user.password && password !== user.password) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      const token = jwt.sign({ email, role: 'client' }, JWT_SECRET, { expiresIn: '7d' });
      db.data.adminLog.unshift({ date: new Date().toLocaleString('fr-FR'), text: `Client login: ${email}` });
      await db.write();
      return res.json({ token, role: 'client', email, name: user.name, planId: user.planId });
    }

    return res.status(401).json({ error: 'Invalid credentials' });
  });

  app.post('/api/register', async (req, res) => {
    const { name, company, email, password, planId } = req.body || {};
    if (!email || !name) return res.status(400).json({ error: 'name & email required' });
    const exists = db.data.users.find(u => u.email === email);
    if (exists) return res.status(409).json({ error: 'User exists' });
    const user = { id: nanoid(8), name, company: company || '', email, password: password || '', planId: planId || null, created: new Date().toLocaleString('fr-FR') };
    db.data.users.unshift(user);
    await db.write();
    db.data.adminLog.unshift({ date: new Date().toLocaleString('fr-FR'), text: `User registered: ${email}` });
    await db.write();
    res.json({ ok: true, user });
  });

  // --- PLANS ---
  app.get('/api/plans', (req, res) => {
    res.json(db.data.plans);
  });

  app.post('/api/plans', authMiddleware(true), async (req, res) => {
    const p = req.body;
    if (!p.name) return res.status(400).json({ error: 'name required' });
    p.id = p.id || nanoid(6);
    db.data.plans.unshift(p);
    await db.write();
    db.data.adminLog.unshift({ date: new Date().toLocaleString('fr-FR'), text: `Plan created: ${p.name}` });
    await db.write();
    res.json({ ok: true, plan: p });
  });

  app.put('/api/plans/:id', authMiddleware(true), async (req, res) => {
    const id = req.params.id;
    const plan = db.data.plans.find(p => p.id === id);
    if (!plan) return res.status(404).json({ error: 'Not found' });
    Object.assign(plan, req.body);
    await db.write();
    db.data.adminLog.unshift({ date: new Date().toLocaleString('fr-FR'), text: `Plan updated: ${plan.name}` });
    await db.write();
    res.json({ ok: true, plan });
  });

  app.delete('/api/plans/:id', authMiddleware(true), async (req, res) => {
    const id = req.params.id;
    db.data.plans = db.data.plans.filter(p => p.id !== id);
    await db.write();
    db.data.adminLog.unshift({ date: new Date().toLocaleString('fr-FR'), text: `Plan deleted: ${id}` });
    await db.write();
    res.json({ ok: true });
  });

  // --- MACHINES ---
  app.get('/api/machines', authMiddleware(false), (req, res) => {
    res.json(db.data.machines || []);
  });

  app.post('/api/machines', authMiddleware(false), async (req, res) => {
    const { name, type, status, location, lastInspection, nextPrediction, notes } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name required' });
    const machine = {
      id: nanoid(8),
      name,
      type: type || 'Autre',
      status: status || 'ok',
      location: location || '',
      lastInspection: lastInspection || '',
      nextPrediction: nextPrediction || '',
      notes: notes || '',
      created: new Date().toLocaleString('fr-FR')
    };
    db.data.machines.unshift(machine);
    await db.write();
    db.data.adminLog.unshift({ date: new Date().toLocaleString('fr-FR'), text: `Machine created: ${name} (${machine.id})` });
    await db.write();
    res.json({ ok: true, machine });
  });

  app.put('/api/machines/:id', authMiddleware(false), async (req, res) => {
    const id = req.params.id;
    const machine = db.data.machines.find(m => m.id === id);
    if (!machine) return res.status(404).json({ error: 'Machine not found' });
    Object.assign(machine, req.body);
    await db.write();
    db.data.adminLog.unshift({ date: new Date().toLocaleString('fr-FR'), text: `Machine updated: ${machine.name} (${id})` });
    await db.write();
    res.json({ ok: true, machine });
  });

  app.delete('/api/machines/:id', authMiddleware(false), async (req, res) => {
    const id = req.params.id;
    const machine = db.data.machines.find(m => m.id === id);
    db.data.machines = db.data.machines.filter(m => m.id !== id);
    await db.write();
    db.data.adminLog.unshift({ date: new Date().toLocaleString('fr-FR'), text: `Machine deleted: ${machine ? machine.name : id} (${id})` });
    await db.write();
    res.json({ ok: true });
  });

  // --- USERS (admin) ---
  app.get('/api/users', authMiddleware(true), (req, res) => {
    res.json(db.data.users);
  });

  app.delete('/api/users/:id', authMiddleware(true), async (req, res) => {
    const id = req.params.id;
    db.data.users = db.data.users.filter(u => u.id !== id);
    await db.write();
    db.data.adminLog.unshift({ date: new Date().toLocaleString('fr-FR'), text: `User deleted: ${id}` });
    await db.write();
    res.json({ ok: true });
  });

  // --- ADMIN LOG ---
  app.get('/api/admin/log', authMiddleware(true), (req, res) => {
    res.json(db.data.adminLog || []);
  });

  // --- USER INFO ---
  app.get('/api/me', authMiddleware(false), (req, res) => {
    res.json({ email: req.user.email, role: req.user.role });
  });

  // Fallback: serve index.html for SPA
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  app.listen(PORT, () => {
    console.log(`PredictiveFlow server listening on port ${PORT}`);
  });
})();
