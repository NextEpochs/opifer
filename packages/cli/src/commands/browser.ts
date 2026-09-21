/**
 * The browser for the agents: Chrome, Chromium or Edge on this machine,
 * found at start (or named by `browser.executablePath` in config.json;
 * `"browser": null` turns the browser_* tools off).
 */

import type { BrowserOptions } from "@opifer/runtime";
import { findBrowser } from "@opifer/runtime";
import type { OpiferConfig } from "../home.js";

export function browserFromConfig(config: OpiferConfig): BrowserOptions | null {
  if (config.browser === null) return null;
  const executablePath = config.browser?.executablePath ?? findBrowser();
  return executablePath ? { executablePath } : null;
}
