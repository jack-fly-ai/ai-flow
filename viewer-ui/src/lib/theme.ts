import { createTheme, type Theme, type ThemeOptions } from "@mui/material/styles";
import { PRIMARY } from "@/lib/palette";

/* Custom palette channels so code-block / surface colors can flip with the
 * light/dark mode. Declared on the MUI Palette so `theme.palette.surface` etc.
 * are typed everywhere they are read. */
declare module "@mui/material/styles" {
  interface Palette {
    surface: string;
    surfaceAlt: string;
    commentBg: string;
  }
  interface PaletteOptions {
    surface?: string;
    surfaceAlt?: string;
    commentBg?: string;
  }
}

/* Mode-independent design language. Component overrides reference mode-aware
 * tokens (primary.main, divider) so they read correctly in both themes. */
const base: ThemeOptions = {
  typography: {
    fontFamily: '"Roboto", "Helvetica", "Segoe UI", sans-serif',
    fontSize: 14,
    button: { textTransform: "none", fontWeight: 700, fontSize: 14 },
  },
  shape: { borderRadius: 4 },
  components: {
    MuiButton: { styleOverrides: { root: { borderRadius: 6 } } },
    MuiChip: { styleOverrides: { root: { borderRadius: 4 } } },
    MuiPaper: { styleOverrides: { root: { backgroundImage: "none" } } },
    MuiTabs: { styleOverrides: { indicator: { height: 3 } } },
    MuiTab: {
      styleOverrides: {
        root: {
          minHeight: 36,
          "&.Mui-selected": { color: "primary.main", fontWeight: 700 },
        },
      },
    },
  },
};

/* Dark is GitHub-dark inspired (canvas #0d1117, border, blue accent) — the
 * palette most developers already live in. Light keeps the original neutral
 * grays. Both share the same semantic structure. */
export type ColorMode = "light" | "dark";

/* Global scrollbar colors, derived from the active theme. Without this the
 * browser paints its light default scrollbar on the dark canvas, which reads as
 * a bright, out-of-place strip. Firefox uses scrollbar-color/width; Chromium and
 * Safari use the ::-webkit-scrollbar pseudo-elements. Both flip with the mode. */
export function scrollbarStyles(theme: Theme) {
  const dark = theme.palette.mode === "dark";
  return {
    "*": {
      scrollbarColor: dark ? "#30363d #0d1117" : "#c1c1c1 #f2f2f2",
      scrollbarWidth: "thin" as const,
    },
    "&::-webkit-scrollbar": { width: 10, height: 10 },
    "&::-webkit-scrollbar-track": { background: dark ? "#0d1117" : "#f2f2f2" },
    "&::-webkit-scrollbar-thumb": {
      background: dark ? "#30363d" : "#c1c1c1",
      borderRadius: 6,
      border: `2px solid ${dark ? "#0d1117" : "#f2f2f2"}`,
    },
    "&::-webkit-scrollbar-thumb:hover": { background: dark ? "#484f58" : "#a8a8a8" },
    "&::-webkit-scrollbar-corner": { background: dark ? "#0d1117" : "#f2f2f2" },
  };
}

export function buildTheme(mode: ColorMode): Theme {
  const dark = mode === "dark";
  return createTheme({
    ...base,
    palette: {
      mode,
      primary: dark
        ? { main: "#58a6ff", dark: "#2f81f7", light: "#79c0ff" }
        : { main: PRIMARY, dark: "#083887", light: "#4789C8" },
      secondary: { main: "#A4A4A4" },
      success: { main: dark ? "#3fb950" : "#319436" },
      error: { main: dark ? "#f85149" : "#E74C3C" },
      warning: { main: dark ? "#d29922" : "#FEC341" },
      info: { main: dark ? "#58a6ff" : "#3992D3" },
      background: dark
        ? { default: "#0d1117", paper: "#161b22" }
        : { default: "#F2F2F2", paper: "#ffffff" },
      text: dark
        ? { primary: "#e6edf3", secondary: "#9198a1" }
        : { primary: "#2b2b2b", secondary: "#5f6b7a" },
      divider: dark ? "rgba(240,246,252,0.15)" : "rgba(0,0,0,0.12)",
      surface: dark ? "#161b22" : "#f6f7f9",
      surfaceAlt: dark ? "#1c2128" : "#f6f8fb",
      commentBg: dark ? "#11161d" : "#f0f2f5",
    },
  });
}
