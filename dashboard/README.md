# Tableau de bord Automaton

Petit tableau de bord Next.js (App Router) pour suivre en quasi temps réel l'agent
`automaton-sasha`. La machine de l'agent **pousse** un instantané JSON toutes les ~15 s
vers `POST /api/ingest` ; la page `/` interroge `GET /api/state` toutes les 15 s.

Projet autonome : son propre `package.json` / `package-lock.json` (npm), hors du
workspace pnpm du dépôt.

```bash
cd dashboard
npm install
npm run dev     # http://localhost:3000
npm run build
npm run lint    # vérification TypeScript (tsc --noEmit)
```

> Le cookie de session est `Secure` : en local, utilisez `http://localhost` (les navigateurs
> l'acceptent sur localhost) ou HTTPS.

## Déploiement sur Vercel (plan Hobby)

1. Importer le dépôt dans Vercel et choisir **Root Directory : `dashboard`**
   (framework détecté : Next.js). `vercel.json` fixe la région `cdg1` (Paris).
2. Définir les variables d'environnement ci-dessous, puis déployer.
3. Laisser **Fluid compute** activé (par défaut) : l'instantané est gardé en mémoire et
   l'instance est réutilisée entre les requêtes.
4. Configurer le pusher avec l'URL `https://<projet>.vercel.app/api/ingest` et le même
   `INGEST_TOKEN`.

## Variables d'environnement

| Variable | Obligatoire | Rôle |
| --- | --- | --- |
| `INGEST_TOKEN` | oui | Jeton du pusher (`Authorization: Bearer …`). Absent → `/api/ingest` répond 503. |
| `DASHBOARD_PASSWORD` | oui | Mot de passe de la page. Absent → la page affiche une erreur de configuration et rien n'est exposé. |
| `KV_REST_API_URL` + `KV_REST_API_TOKEN` | non | Redis Upstash (API REST). Alias acceptés : `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`. |
| `BLOB_READ_WRITE_TOKEN` | non | Vercel Blob (store **privé**) pour un point de sauvegarde, utilisé seulement si Redis n'est pas configuré. |

Générer des valeurs robustes, par exemple : `openssl rand -hex 32`.

Changer `DASHBOARD_PASSWORD` ou `INGEST_TOKEN` invalide toutes les sessions ouvertes
(la clé HMAC du cookie en est dérivée).

## Stockage et quotas gratuits

Toutes les routes API sont dans un seul fichier, `app/api/[action]/route.ts`, pour que
l'ingestion et la lecture partagent la même instance et donc la même mémoire.

1. **Mémoire** (toujours) : dernier instantané + `receivedAt` dans une variable de module.
2. **Redis Upstash** (si configuré) — une seule commande par opération :
   - envoi complet : `MSET automaton:latest … automaton:hash … automaton:received …` ;
   - battement : `SET automaton:received …` si l'instance connaît déjà le hash, sinon un
     `EVAL` qui ne met à jour `automaton:received` que si `automaton:hash` correspond ;
   - lecture : `MGET automaton:latest automaton:received`.

   Ordre de grandeur : 1 envoi / 15 s ≈ 173 000 commandes/mois, plus 1 lecture / 15 s par
   onglet ouvert. Le quota gratuit (~500 000 commandes/mois) suffit pour un usage normal
   (attention si plusieurs onglets restent ouverts en permanence ; la page ne
   s'actualise pas lorsqu'elle est en arrière-plan).
3. **Vercel Blob** (si configuré et sans Redis) : fichier privé `automaton/latest.json`,
   écrit **au plus une fois par heure par instance**, uniquement lors d'un envoi complet
   (Hobby : 2 000 opérations d'écriture par mois, ≈ 720 avec une instance). Une instance
   qui démarre à vide le lit **une seule fois** pour avoir quelque chose à afficher en
   attendant le prochain envoi. Aucun `list()` n'est jamais appelé.

`/api/state` indique l'origine des données : `source` = `memory`, `kv`, `blob` ou `none`.

Sans Redis, si Vercel répartit les requêtes sur plusieurs instances, l'une d'elles peut
répondre « aucune donnée » (ou une sauvegarde Blob plus ancienne) jusqu'à ce qu'elle reçoive
un envoi ; Redis supprime cette limite.

## API

### `POST /api/ingest`

- En-tête `Authorization: Bearer <INGEST_TOKEN>` (comparaison à temps constant) ; 401 sinon.
- `Content-Encoding: gzip` accepté ; 2 Mo maximum une fois décompressé (413 au-delà).
- **Instantané complet** (`"v": 1, "kind": "full"`) → `{"ok":true,"storage":"memory+kv"|"memory+blob"|"memory"}`.
  Si `hash` est absent, le serveur calcule le SHA-256 du corps.
- **Battement** `{"v":1,"kind":"heartbeat","generatedAt":"…","hash":"…"}` :
  - hash connu (mémoire ou Redis) → `receivedAt` mis à jour, `{"ok":true}` ;
  - sinon **409** `{"ok":false,"needFull":true}` : le pusher doit renvoyer un instantané complet.
- `receivedAt` est toujours l'heure du serveur.

Exemple :

```bash
gzip -c snapshot.json | curl -X POST https://<projet>.vercel.app/api/ingest \
  -H "Authorization: Bearer $INGEST_TOKEN" \
  -H "Content-Type: application/json" -H "Content-Encoding: gzip" \
  --data-binary @-
```

### `GET /api/state` (session requise)

```json
{ "snapshot": { … } | null, "receivedAt": "ISO|null", "serverNow": "ISO", "source": "memory|kv|blob|none" }
```

Réponse en `Cache-Control: no-store` ; 401 sans session valide.

### `POST /api/login` / `POST /api/logout`

- Login : corps JSON `{"password":"…"}`. En cas d'échec, réponse 401 après ~1 s.
  En cas de succès, cookie `automaton_session` (`HttpOnly; Secure; SameSite=Strict; Path=/`,
  30 jours) au format `<expiration>.<HMAC-SHA256>`.
- Logout : efface le cookie.

## Format de l'instantané (v1)

```json
{
  "v": 1,
  "kind": "full",
  "hash": "sha256 du contenu",
  "generatedAt": "2026-10-08T17:00:00Z",
  "agent": {
    "name": "automaton-sasha",
    "container": { "state": "running", "startedAt": "ISO|null", "finishedAt": "ISO|null", "exitCode": 0, "image": "automaton-x402:cf0b114" },
    "loopState": "running|sleeping|waking|…|null",
    "sleepUntil": "ISO|null",
    "tier": "high|null",
    "model": "deepseek/deepseek-v4-pro|null",
    "lastActivityAt": "ISO|null",
    "turnsToday": 12
  },
  "wallet": { "address": "0x…", "usdc": 14.69, "eth": 0.0, "checkedAt": "ISO|null" },
  "spend": { "day": "2026-10-08", "dayIsUtc": true, "todayUsd": 0.99, "capUsd": 5.0, "inferenceTodayUsd": 0.99, "inferenceCallsToday": 133, "lastHourUsd": 0.12 },
  "balanceHistory": [[1791478800, 14.69]],
  "goals": [{ "title": "…", "status": "active|completed|failed|paused", "createdAt": "ISO", "revenueUsd": 0 }],
  "heartbeats": [{ "name": "bounty-scan", "schedule": "0 */6 * * *", "enabled": true }],
  "events": [{ "t": "ISO", "kind": "think|thought|tool|result|state|sleep|wake|loop|warn|error|info", "text": "…" }],
  "warnings": [{ "t": "ISO", "level": "warn|error", "text": "…" }],
  "pusher": { "version": "1", "intervalSec": 15 }
}
```

- `balanceHistory` : paires `[epoch_secondes, usdc]` (≈ 1 point / 5 min, jusqu'à 7 jours).
- `events` : du plus ancien au plus récent (≤ 200).
- Tout champ peut manquer ou valoir `null` : l'interface le tolère.

## Gains

Le bloc « Gains », en haut de la page, lit le champ racine `earnings` de l'instantané
(pusher v4). Le pusher relève chaque minute les **transferts USDC entrants sur Base**
(lecture on-chain) vers le portefeuille de l'agent :

- `totalUsd`, `todayUsd`, `count`, `countToday` ne comptent que les **revenus**
  (paiements de clients), sur le même jour UTC que `spend.todayUsd` ;
- les **apports du créateur** sont à part (`deposits`) et ne sont **pas** comptés comme gains ;
- `netTodayUsd` = gains du jour − dépenses du jour (recalculé par la page s'il manque) ;
- `last` / `recent` (10 max, du plus récent au plus ancien) : `{ "t", "amountUsd", "from" }` ;
- `checkedAt`, `error`, `behindBlocks` alimentent le pied de carte (lecture impossible,
  rattrapage en cours au-delà de 300 blocs de retard).

Le bloc suit le même rafraîchissement que le reste (15 s), sans appel réseau
supplémentaire. Un ancien pusher sans `earnings` affiche « Données de gains pas encore
disponibles ».

## Sécurité

- `/` et `/api/state` exigent une session valide (vérifiée dans `proxy.ts` avec Web Crypto,
  puis à nouveau dans la page et la route). `/api/ingest` a son propre jeton.
- En-têtes sur toutes les réponses : `X-Robots-Tag: noindex, nofollow`,
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff` ;
  `robots.txt` interdit tout.
- Le contenu vient d'un agent autonome et est **non fiable** : il est affiché uniquement
  comme du texte (échappement React), jamais via `dangerouslySetInnerHTML`, sans lien
  cliquable ni image distante générés à partir du contenu.
- Toutes les heures sont affichées dans le fuseau `Europe/Paris`.
