/**
 * Command safety (first part, M1): patterns that are always forbidden because
 * they are destructive and irreversible. Dangerous patterns requiring approval
 * and the per-company allow list arrive with governance (M2).
 */

export interface CommandVerdict {
  allowed: boolean;
  reason?: string;
}

const ALWAYS_FORBIDDEN: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)[a-z]*\s+(\/|~|\$HOME|\*)(\s|$)/i, reason: "recursive deletion of the root or the home directory" },
  { pattern: /\brm\s+-[a-z]*r[a-z]*\s+\/(\s|$)/i, reason: "recursive deletion of the root" },
  { pattern: /\bmkfs(\.[a-z0-9]+)?\b/i, reason: "formatting a filesystem" },
  { pattern: /\bdd\b.*\bof=\/dev\/(sd|nvme|disk|hd|mmcblk)/i, reason: "direct write to a disk" },
  { pattern: />\s*\/dev\/(sd|nvme|disk|hd|mmcblk)/i, reason: "direct write to a disk" },
  { pattern: /:\(\)\s*\{\s*:\|:&\s*\};:/, reason: "fork bomb" },
  { pattern: /\b(shutdown|reboot|halt|poweroff)\b/i, reason: "shutting down or rebooting the machine" },
  { pattern: /\bchmod\s+(-R\s+)?[0-7]*777\s+\/(\s|$)/i, reason: "open permissions on the root" },
  { pattern: /\bgit\s+push\b.*\s--force\b.*\s(main|master)\b/i, reason: "force push to a main branch" },
  { pattern: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/i, reason: "running scripts downloaded from the network" },
];

export function checkCommand(command: string): CommandVerdict {
  for (const { pattern, reason } of ALWAYS_FORBIDDEN) {
    if (pattern.test(command)) return { allowed: false, reason };
  }
  return { allowed: true };
}

/** Patterns that are allowed but need a person's approval, whatever the tool permission says. */
const DANGEROUS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+-[a-z]*r/i, reason: "recursive deletion" },
  { pattern: /\bgit\s+(push\b.*--force|reset\s+--hard|clean\s+-[a-z]*f|branch\s+-D)/i, reason: "destructive git operation" },
  { pattern: /\b(sudo|doas)\b/i, reason: "privilege escalation" },
  { pattern: /\b(curl|wget)\b.*\s-(X\s*(POST|PUT|DELETE|PATCH)|d\s|-data)/i, reason: "network request that changes remote state" },
  { pattern: /\b(kill|pkill|killall)\b/i, reason: "terminating processes" },
  { pattern: /\b(npm|pnpm|yarn)\s+publish\b/i, reason: "publishing a package" },
  { pattern: /\b(docker|kubectl)\s+(rm|delete|prune|push)\b/i, reason: "destructive container operation" },
  { pattern: /\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA)\b/i, reason: "destructive SQL" },
  { pattern: /\bchmod\s+(-R\s+)?[0-7]*[27]7[0-7]?\b/i, reason: "loosening permissions" },
  { pattern: /(^|[;&|]\s*)mv\s+[^;&|]*\s\/(?!tmp)/i, reason: "moving files into system paths" },
];

export type CommandClass = "ok" | "dangerous" | "forbidden";

/** Three-way classification: forbidden never runs, dangerous needs approval, ok follows the tool permission. */
export function classifyCommand(command: string): { class: CommandClass; reason?: string } {
  const verdict = checkCommand(command);
  if (!verdict.allowed) return { class: "forbidden", ...(verdict.reason ? { reason: verdict.reason } : {}) };
  for (const { pattern, reason } of DANGEROUS) {
    if (pattern.test(command)) return { class: "dangerous", reason };
  }
  return { class: "ok" };
}
