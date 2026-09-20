/**
 * Sicurezza dei comandi (prima parte, M1): pattern sempre vietati perché
 * distruttivi e irreversibili. I pattern pericolosi con approvazione e la
 * lista di permessi per azienda arrivano con il governo (M2).
 */

export interface CommandVerdict {
  allowed: boolean;
  reason?: string;
}

const ALWAYS_FORBIDDEN: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)[a-z]*\s+(\/|~|\$HOME|\*)(\s|$)/i, reason: "cancellazione ricorsiva della radice o della home" },
  { pattern: /\brm\s+-[a-z]*r[a-z]*\s+\/(\s|$)/i, reason: "cancellazione ricorsiva della radice" },
  { pattern: /\bmkfs(\.[a-z0-9]+)?\b/i, reason: "formattazione di un filesystem" },
  { pattern: /\bdd\b.*\bof=\/dev\/(sd|nvme|disk|hd|mmcblk)/i, reason: "scrittura diretta su un disco" },
  { pattern: />\s*\/dev\/(sd|nvme|disk|hd|mmcblk)/i, reason: "scrittura diretta su un disco" },
  { pattern: /:\(\)\s*\{\s*:\|:&\s*\};:/, reason: "fork bomb" },
  { pattern: /\b(shutdown|reboot|halt|poweroff)\b/i, reason: "spegnimento o riavvio della macchina" },
  { pattern: /\bchmod\s+(-R\s+)?[0-7]*777\s+\/(\s|$)/i, reason: "permessi aperti sulla radice" },
  { pattern: /\bgit\s+push\b.*\s--force\b.*\s(main|master)\b/i, reason: "push forzato su un ramo principale" },
  { pattern: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/i, reason: "esecuzione di script scaricati dalla rete" },
];

export function checkCommand(command: string): CommandVerdict {
  for (const { pattern, reason } of ALWAYS_FORBIDDEN) {
    if (pattern.test(command)) return { allowed: false, reason };
  }
  return { allowed: true };
}
