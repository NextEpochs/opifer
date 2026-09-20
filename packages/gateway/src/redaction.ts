/**
 * Redaction of secret values from text that goes back to the model or into
 * logs. Short values are not redacted (they would match everywhere).
 */

const MIN_LENGTH = 4;

export function redactSecrets(text: string, secrets: Record<string, string>): string {
  let result = text;
  const entries = Object.entries(secrets)
    .filter(([, value]) => value.length >= MIN_LENGTH)
    .sort((a, b) => b[1].length - a[1].length);
  for (const [name, value] of entries) {
    if (result.includes(value)) result = result.split(value).join(`[redacted:${name}]`);
  }
  return result;
}
