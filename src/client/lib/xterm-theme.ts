// xterm.js colour themes shared by the session terminal page and the Sessions
// list's inline preview, so the two always render a session alike.
export type XtermTheme = {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
};

export const XTERM_DARK: XtermTheme = {
  background: "#0b0c0e",
  foreground: "#e8e3da",
  cursor: "#ff8a3d",
  selectionBackground: "#484f58",
  black: "#0b0c0e",
  red: "#ff5f56",
  green: "#5fd38d",
  yellow: "#e0a44a",
  blue: "#ff8a3d",
  magenta: "#bc8cff",
  cyan: "#39c5cf",
  white: "#b1bac4",
  brightBlack: "#8b949e",
  brightRed: "#ff7b72",
  brightGreen: "#56d364",
  brightYellow: "#e3b341",
  brightBlue: "#ff8a3d",
  brightMagenta: "#d2a8ff",
  brightCyan: "#56d4dd",
  brightWhite: "#ffffff",
};
export const XTERM_LIGHT: XtermTheme = {
  background: "#faf7f2",
  foreground: "#1c1a17",
  cursor: "#c1521a",
  selectionBackground: "#afb8c1",
  black: "#24292f",
  red: "#cf222e",
  green: "#1a7f37",
  yellow: "#9a6700",
  blue: "#0969da",
  magenta: "#8250df",
  cyan: "#1b7c83",
  white: "#6e7781",
  brightBlack: "#57606a",
  brightRed: "#a40e26",
  brightGreen: "#116329",
  brightYellow: "#7d4e00",
  brightBlue: "#0550ae",
  brightMagenta: "#6e40c9",
  brightCyan: "#0e6fa5",
  brightWhite: "#ffffff",
};

/** The theme for the page's `data-theme`, falling back to the OS preference when unset. */
export function currentXtermTheme(): XtermTheme {
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr === "dark") return XTERM_DARK;
  if (attr === "light") return XTERM_LIGHT;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? XTERM_LIGHT : XTERM_DARK;
}
