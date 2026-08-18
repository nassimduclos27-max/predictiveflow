# PredictiveFlow — Demo (backend + frontend)

Contient un backend minimal (Express + lowdb + Nodemailer) et un frontend statique (public/index.html) pour prototype.

Important :
- C'est une solution de démonstration. Ne pas utiliser en production sans sécurité (hachage de mots de passe, CORS strict, TLS, etc.).
- L'envoi d'e-mails utilise les variables d'environnement SMTP (voir plus bas). Pour tester sans envoyer de vrais e-mails, utilise Mailtrap.

Fichiers principaux :
- server.js — backend API (auth, plans, devis)
- package.json — dépendances
- public/index.html — frontend (admin + client)
- db.json — base de données lowdb (créée automatiquement)
- .gitignore — recommandé

Variables d'environnement (à configurer sur Replit / Render / Railway) :
- JWT_SECRET
- ADMIN_EMAIL (optionnel)
- ADMIN_PASSWORD (optionnel)
- QUOTE_RECIPIENT (adresse qui reçoit les devis)
- SMTP_HOST
- SMTP_PORT
- SMTP_USER
- SMTP_PASS
- SMTP_SECURE (true|false)
- SMTP_FROM (ex: "PredictiveFlow <no-reply@predictiveflow.test>")

Déployer sur Replit (rapide) :
1. Crée un Repl Node.js (https://replit.com/new/nodejs)
2. Colle les fichiers (server.js, package.json) à la racine et place public/index.html dans le dossier `public/`.
3. Ajoute les variables d'environnement (Secrets) listées ci‑dessus.
4. Clique "Run". L'URL publique apparaît : ouvre-la pour voir le site.
  