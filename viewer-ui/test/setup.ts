import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

/* Vitest setup for the viewer-UI suite (jsdom environment).
 *
 * jsdom implements neither `matchMedia` (MUI's useMediaQuery) nor
 * `ResizeObserver` (popper-based overlays); stub the minimum surface the
 * components touch so a render never throws on a missing browser API. */

if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

if (typeof globalThis !== "undefined" && !("ResizeObserver" in globalThis)) {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

/* Unmount every rendered component between tests so a leaked tree from one
 * test never receives another test's timers/events. */
afterEach(() => {
  cleanup();
});
