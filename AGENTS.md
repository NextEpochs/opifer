# AGENTS.md — come si lavora in questo repository

Questo file è letto da persone e da agenti di sviluppo. Vale per tutto il monorepo.

## Cos'è Opifer

Opifer è una piattaforma in cui agenti AI lavorano, imparano e vengono governati come un'organizzazione. La specifica completa è il documento "Opifer — Specifica completa e piano MVP" (NextEpochs, settembre 2026). Il codice è una reimplementazione da specifica: si parte dai comportamenti descritti con parole nostre, mai da codice altrui. Nessun file, funzione, prompt o schema viene tradotto o adattato da progetti di terzi; gli standard aperti (MCP, agent skills, OpenAPI, OpenTelemetry) si implementano dalle rispettive specifiche pubbliche.

## Le venti invarianti

Ogni funzione, presente o futura, deve rispettarle. Sono in `packages/core/src/invariants.ts` e hanno un test di contratto ciascuna in `packages/core/test/invariants.test.ts`. Prima di toccare il core, rileggile. Una modifica che viola un'invariante non si fa: si discute la specifica.

## Regole di codice

- Un solo linguaggio: TypeScript strict, moduli ESM (`NodeNext`), Node.js 22.
- Tutto lo stato vive in PostgreSQL. Nessun secondo archivio obbligatorio.
- Ogni tabella con dati di dominio porta `company_id`, `created_at`, `updated_at`. `audit_log` accetta solo inserimenti.
- Le migrazioni sono coppie di file SQL `NNNN_nome.up.sql` / `NNNN_nome.down.sql` in `packages/db/migrations`; ogni `up` ha il suo `down` e la coppia viene provata in entrambe le direzioni dal test `migrate.test.ts`. Lo schema Drizzle in `packages/db/src/schema.ts` rispecchia le migrazioni e serve per le query tipizzate.
- File sotto 1.500 righe, funzioni sotto 200. Nessun test che fotografa valori destinati a cambiare.
- Nomi, testi dell'interfaccia e documentazione in italiano; identificatori di codice in inglese; l'interfaccia è bilingue (italiano e inglese) dal primo giorno.
- I segreti non entrano mai nel repository, nei log o nel contesto di un modello.
- Ogni dipendenza entra con licenza compatibile con la distribuzione commerciale; `THIRD-PARTY-NOTICES` si rigenera con `pnpm third-party-notices`.

## Comandi

```bash
pnpm install && pnpm build
pnpm typecheck
pnpm test
pnpm o4r init --company "Nome azienda"
pnpm o4r up
```

## Metodo di lavoro

- Il piano è in milestone (M0..M7). Ogni milestone si chiude con una dimostrazione e con i test di contratto delle invarianti toccate.
- La UI cresce con ogni milestone, una pagina alla volta.
- Nessuna funzione della colonna "Dopo" della roadmap entra nell'MVP senza toglierne un'altra.
- I commit descrivono il comportamento cambiato, in italiano, con riferimento alla milestone (es. `M0: migrazioni avanti e indietro`).

## Licenze

Core AGPL-3.0-only; `packages/sdk` e `plugins/*` MIT. Non spostare codice tra le due aree senza una decisione esplicita.
