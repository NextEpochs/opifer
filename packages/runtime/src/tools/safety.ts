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
