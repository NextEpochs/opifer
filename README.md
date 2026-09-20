# Opifer

**Un unico sistema in cui agenti AI lavorano, imparano e vengono governati come una vera organizzazione.**

Un'installazione, un database, un'interfaccia. Gli agenti imparano dal lavoro svolto, l'organizzazione li governa, l'operatore vede costi e risultati in tempo reale.

Opifer è un prodotto [NextEpochs](https://nextepochs.com). Sito e documentazione: [opifer.dev](https://opifer.dev).

> Stato: **in costruzione** (milestone M0, fondamenta). Il repository è privato fino alla fine dell'MVP.

## Avvio rapido

Requisiti: Node.js 22 o superiore e pnpm 10. Nessun altro prerequisito: il database PostgreSQL è incorporato.

```bash
pnpm install
pnpm build
pnpm o4r init --company "La mia azienda"   # installa il database locale, applica le migrazioni, crea la prima azienda
pnpm o4r up                                # avvia server e interfaccia su http://127.0.0.1:4700
```

Altri comandi: `pnpm o4r down`, `pnpm o4r doctor`, `pnpm o4r migrate status|up|down`.

## Struttura del monorepo

| Pacchetto | Contenuto |
| --- | --- |
| `packages/core` | Modello di dominio, invarianti, eventi |
| `packages/db` | Schema, migrazioni avanti e indietro, Postgres incorporato |
| `packages/runtime` | Loop dell'agente, provider di modelli, contesto |
| `packages/gateway` | Registro tool, client MCP, permessi, prenotazione budget |
| `packages/server` | API HTTP `/v1`, eventi WebSocket |
| `packages/ui` | Interfaccia web (React, Vite, Tailwind) |
| `packages/cli` | Comando `o4r` |
| `packages/sdk` | Contratti per plugin, canali, provider (MIT) |
| `plugins/*` | Plugin mantenuti da NextEpochs (MIT) |

## Le venti invarianti

Venti regole sono il contratto del sistema e valgono più di qualsiasi funzionalità. Sono elencate in `packages/core/src/invariants.ts` e ognuna è un test di contratto in `packages/core/test/invariants.test.ts`, che diventa verde milestone dopo milestone.

## Sviluppo

```bash
pnpm typecheck   # controllo dei tipi su tutti i pacchetti
pnpm test        # test unitari e di contratto (avvia un Postgres incorporato temporaneo)
pnpm dev         # server in modalità sviluppo
pnpm --filter @opifer/ui dev   # interfaccia in modalità sviluppo
```

Le regole di lavoro per persone e agenti sono in [AGENTS.md](./AGENTS.md).

## Licenze

Il core di Opifer è distribuito con licenza **AGPL-3.0-only** (vedi [LICENSE](./LICENSE)). L'SDK (`packages/sdk`) e i plugin (`plugins/*`) sono distribuiti con licenza **MIT**, così chi estende Opifer non è vincolato dall'AGPL. I pacchetti verticali NextEpochs sono proprietari e vivono in repository separati.

Le licenze delle dipendenze sono raccolte in `THIRD-PARTY-NOTICES`, rigenerato a ogni rilascio con `pnpm third-party-notices`.
