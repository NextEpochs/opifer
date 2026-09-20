/**
 * Le venti invarianti di Opifer.
 *
 * Sono il contratto del sistema: ogni funzione, presente o futura, deve
 * rispettarle. Ognuna ha un test di contratto in `test/invariants.test.ts`
 * che diventa verde nella milestone indicata.
 */

export type InvariantArea = "nucleo" | "conversazione" | "lavoro" | "governo" | "apprendimento";

export interface Invariant {
  /** Identificativo stabile, usato nei test e nella documentazione. */
  readonly id: string;
  readonly area: InvariantArea;
  readonly title: string;
  readonly rule: string;
  /** Milestone in cui il test di contratto deve essere verde. */
  readonly milestone: "M0" | "M1" | "M2" | "M3" | "M4" | "M5" | "M6" | "M7";
}

export const INVARIANTS: readonly Invariant[] = [
  // Nucleo
  {
    id: "nucleo-stretto",
    area: "nucleo",
    title: "Nucleo stretto, capacità ai bordi",
    rule: "Il core contiene solo loop, dati, governo e scheduler. Provider, canali, tool, memorie esterne e sandbox sono plugin.",
    milestone: "M5",
  },
  {
    id: "un-solo-archivio",
    area: "nucleo",
    title: "Un solo archivio",
    rule: "Tutto lo stato vive in PostgreSQL: task, memoria, skill, costi, audit, code. Nessun secondo database obbligatorio.",
    milestone: "M0",
  },
  {
    id: "ogni-riga-a-una-azienda",
    area: "nucleo",
    title: "Ogni riga appartiene a un'azienda",
    rule: "Il campo company_id è presente ovunque dal primo giorno; l'isolamento tra aziende è verificato a livello di query e di test.",
    milestone: "M0",
  },
  {
    id: "un-solo-linguaggio",
    area: "nucleo",
    title: "Un solo linguaggio",
    rule: "TypeScript per server, UI, CLI e SDK.",
    milestone: "M0",
  },
  // Conversazione e costi
  {
    id: "prefisso-stabile",
    area: "conversazione",
    title: "Prefisso stabile",
    rule: "Il prompt di sistema non cambia per tutta la durata di una conversazione. Memoria e skill entrano come istantanea a inizio sessione.",
    milestone: "M1",
  },
  {
    id: "una-sola-rottura",
    area: "conversazione",
    title: "Una sola rottura ammessa",
    rule: "L'unica modifica al contesto passato è la compressione, eseguita a soglia e tracciata.",
    milestone: "M6",
  },
  {
    id: "alternanza-dei-ruoli",
    area: "conversazione",
    title: "Alternanza rigorosa dei ruoli",
    rule: "Mai due messaggi consecutivi dello stesso ruolo; i contenuti iniettati a metà turno viaggiano in un risultato di tool o in un messaggio utente al confine del turno.",
    milestone: "M1",
  },
  {
    id: "budget-prima-della-chiamata",
    area: "conversazione",
    title: "Budget prima della chiamata",
    rule: "Ogni chiamata al modello e ogni tool a pagamento passa da una prenotazione di spesa. Se il tetto è raggiunto, la chiamata non parte.",
    milestone: "M2",
  },
  // Lavoro
  {
    id: "checkout-atomico",
    area: "lavoro",
    title: "Checkout atomico",
    rule: "Un task in lavorazione ha un solo assegnatario; la presa in carico è una transazione unica, senza doppioni possibili.",
    milestone: "M3",
  },
  {
    id: "ogni-task-conosce-il-suo-perche",
    area: "lavoro",
    title: "Ogni task conosce il suo perché",
    rule: "Un task porta con sé la catena obiettivo → progetto → missione aziendale.",
    milestone: "M3",
  },
  {
    id: "al-piu-una-volta",
    area: "lavoro",
    title: "Al più una volta",
    rule: "Le esecuzioni schedulate avanzano la prossima scadenza prima di partire: un crash non genera mai una doppia esecuzione.",
    milestone: "M5",
  },
  {
    id: "niente-replay-dei-tool",
    area: "lavoro",
    title: "Niente replay automatico dei tool",
    rule: "Dopo un'interruzione si riprende la conversazione con la cronologia salvata, senza rieseguire azioni già compiute.",
    milestone: "M1",
  },
  {
    id: "finito-significa-verificato",
    area: "lavoro",
    title: "Finito significa verificato",
    rule: "Un task si chiude con un risultato controllabile (artefatto, test, decisione), non con un messaggio di stato.",
    milestone: "M3",
  },
  // Governo
  {
    id: "permesso-per-ruolo-su-ogni-tool",
    area: "governo",
    title: "Permesso per ruolo su ogni tool",
    rule: "Tre stati: automatico, con approvazione, bloccato. Il default è prudente.",
    milestone: "M2",
  },
  {
    id: "segreti-mai-nel-contesto",
    area: "governo",
    title: "Segreti mai nel contesto",
    rule: "Le credenziali sono legate ad agente e azienda, risolte al momento dell'uso, e ogni accesso è registrato.",
    milestone: "M2",
  },
  {
    id: "audit-immutabile",
    area: "governo",
    title: "Audit immutabile",
    rule: "Ogni azione che modifica stato registra chi, cosa, quando e per conto di quale task. Il registro non si modifica né si cancella.",
    milestone: "M0",
  },
  {
    id: "configurazione-versionata",
    area: "governo",
    title: "Configurazione versionata",
    rule: "Ogni cambio a un agente, a una skill o a una policy crea una revisione, ripristinabile.",
    milestone: "M2",
  },
  // Apprendimento
  {
    id: "imparare-fuori-dal-turno",
    area: "apprendimento",
    title: "Imparare fuori dal turno",
    rule: "La revisione che propone nuove memorie o skill gira in background, su una copia della conversazione, senza toccare il contesto vivo.",
    milestone: "M4",
  },
  {
    id: "mai-cancellare-cio-che-si-e-imparato",
    area: "apprendimento",
    title: "Mai cancellare ciò che si è imparato",
    rule: "Le skill inutilizzate vengono archiviate e restano ripristinabili; quelle fissate dall'utente non vengono toccate.",
    milestone: "M4",
  },
  {
    id: "la-conoscenza-sale-solo-con-governo",
    area: "apprendimento",
    title: "La conoscenza sale di livello solo con governo",
    rule: "Una skill passa da agente a team ad azienda secondo una policy: automatica, con revisione umana, o vietata.",
    milestone: "M4",
  },
] as const;

export function invariantById(id: string): Invariant {
  const found = INVARIANTS.find((i) => i.id === id);
  if (!found) throw new Error(`Invariante sconosciuta: ${id}`);
  return found;
}
