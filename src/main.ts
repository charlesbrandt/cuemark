import { mount } from "svelte";
import App from "./App.svelte";
import "./app.css";
import { debugLog } from "./lib/debugLog";

// Uncaught JS exceptions/rejections previously left zero trace: only explicit
// debugLog() calls reach the Rust-side log file, console.error/warn do not, and a
// throw inside the rAF loop kills it permanently with total silence — see the
// 2026-07-24 UI-freeze-during-playback investigation. These are the last line of
// defense that turns that silence into an actual stack trace next time.
window.onerror = (message, source, lineno, colno, error) => {
  debugLog(`[uncaught-error] ${message} at ${source}:${lineno}:${colno} ${error?.stack ?? ""}`);
};
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  debugLog(`[unhandled-rejection] ${reason?.stack ?? reason}`);
});

const app = mount(App, { target: document.getElementById("app")! });

export default app;
