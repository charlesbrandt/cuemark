/**
 * The 5 built-in visualizations, ported from `../shaders.ts`'s GLSL 300 es
 * `BUILT_IN_SHADERS` to plain ISF files under `../builtin-isf/`. Built-ins
 * are ordinary ISF plugins — no separate code path — so they're loaded here
 * via Vite `?raw` the same way a discovered plugin's file would be read from
 * disk. `shaders.ts` itself is left untouched (see `docs/design/
 * visualization-plugins.md`, Phase 1, step 3).
 */
import plasmaSrc from "../builtin-isf/plasma.fs?raw";
import tunnelSrc from "../builtin-isf/tunnel.fs?raw";
import particlesSrc from "../builtin-isf/particles.fs?raw";
import feedbackSrc from "../builtin-isf/feedback.fs?raw";
import scopeSrc from "../builtin-isf/scope.fs?raw";

export interface BuiltinIsf {
  id: string;
  name: string;
  source: string;
}

export const BUILTIN_ISF: BuiltinIsf[] = [
  { id: "builtin:plasma", name: "Plasma", source: plasmaSrc },
  { id: "builtin:tunnel", name: "Tunnel", source: tunnelSrc },
  { id: "builtin:particles", name: "Particles", source: particlesSrc },
  { id: "builtin:feedback", name: "Feedback", source: feedbackSrc },
  { id: "builtin:scope", name: "Scope", source: scopeSrc },
];
