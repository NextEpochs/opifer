/** Messaggi a terminale, con colori disattivabili (`--no-color` o `NO_COLOR`). */

let colorEnabled = !process.env["NO_COLOR"] && process.stdout.isTTY === true;

export function setColor(enabled: boolean): void {
  colorEnabled = enabled;
}

function paint(code: string, text: string): string {
  return colorEnabled ? `\u001b[${code}m${text}\u001b[0m` : text;
}

export const c = {
  bold: (t: string) => paint("1", t),
  dim: (t: string) => paint("2", t),
  green: (t: string) => paint("32", t),
  yellow: (t: string) => paint("33", t),
  red: (t: string) => paint("31", t),
  cyan: (t: string) => paint("36", t),
};

export const say = {
  info: (t: string) => console.log(t),
  step: (t: string) => console.log(`${c.cyan("›")} ${t}`),
  ok: (t: string) => console.log(`${c.green("✓")} ${t}`),
  warn: (t: string) => console.log(`${c.yellow("!")} ${t}`),
  fail: (t: string) => console.error(`${c.red("✗")} ${t}`),
};
