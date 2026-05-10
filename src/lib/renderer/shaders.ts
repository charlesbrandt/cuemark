export interface BuiltInShader {
  name: string;
  src: string;
}

const PLASMA_SRC = `#version 300 es
precision highp float;
uniform float u_time;
uniform vec2 u_resolution;
uniform float u_bass;
uniform float u_mid;
uniform float u_high;
in vec2 v_uv;
out vec4 fragColor;

void main() {
  vec2 uv = v_uv * 2.0 - 1.0;
  uv.x *= u_resolution.x / u_resolution.y;
  float t = u_time * 0.4;
  float r = sin(uv.x * 4.0 + t) * 0.5 + 0.5;
  float g = sin(uv.y * 3.0 + t * 1.3 + 1.0) * 0.5 + 0.5;
  float b = sin(length(uv) * 5.0 - t * 2.0) * 0.5 + 0.5;
  float pulse = 1.0 + u_bass * 0.3;
  fragColor = vec4(r * pulse, g, b, 1.0);
}`;

const TUNNEL_SRC = `#version 300 es
precision highp float;
uniform float u_time;
uniform vec2 u_resolution;
uniform float u_bass;
uniform float u_mid;
uniform float u_high;
in vec2 v_uv;
out vec4 fragColor;

void main() {
  vec2 uv = v_uv * 2.0 - 1.0;
  uv.x *= u_resolution.x / u_resolution.y;
  float r = length(uv);
  float a = atan(uv.y, uv.x);
  float t = u_time * 0.8 + u_bass * 0.5;
  float ring = sin(8.0 / max(r, 0.001) - t * 3.0 + a * 4.0);
  vec3 col = 0.5 + 0.5 * cos(vec3(0.0, 1.0, 2.0) + ring + t);
  col *= smoothstep(0.0, 0.25, r);
  fragColor = vec4(col, 1.0);
}`;

const PARTICLES_SRC = `#version 300 es
precision highp float;
uniform float u_time;
uniform vec2 u_resolution;
uniform float u_bass;
uniform float u_mid;
uniform float u_high;
in vec2 v_uv;
out vec4 fragColor;

float hash(float n) { return fract(sin(n) * 43758.5453); }

void main() {
  vec2 uv = v_uv * 2.0 - 1.0;
  uv.x *= u_resolution.x / u_resolution.y;

  vec3 col = vec3(0.0);
  for (int i = 0; i < 80; i++) {
    float fi = float(i);
    float h1 = hash(fi);
    float h2 = hash(fi + 100.0);
    float h3 = hash(fi + 200.0);

    float speed = 0.04 + h3 * 0.06 + u_bass * 0.12;
    float px = fract(h1 + u_time * speed * 0.11) * 2.0 - 1.0;
    float py = fract(h2 + u_time * speed * 0.07) * 2.0 - 1.0;
    vec2 pos = vec2(px * u_resolution.x / u_resolution.y, py);

    float size = (0.004 + h3 * 0.008) * (1.0 + u_high * 1.5);
    float d = length(uv - pos);
    float glow = smoothstep(size * 2.5, 0.0, d);
    vec3 hue = 0.5 + 0.5 * cos(vec3(0.0, 2.09, 4.19) + h1 * 6.28 + u_time * 0.2);
    col += hue * glow;
  }
  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

// Simulates video feedback by layering the same color field at successive
// zoom/rotate steps with exponential weight decay — no ping-pong buffers needed.
const FEEDBACK_SRC = `#version 300 es
precision highp float;
uniform float u_time;
uniform vec2 u_resolution;
uniform float u_bass;
uniform float u_mid;
uniform float u_high;
in vec2 v_uv;
out vec4 fragColor;

vec3 base(vec2 p, float t) {
  float r = sin(p.x * 3.0 + t) * 0.5 + 0.5;
  float g = sin(p.y * 4.0 + t * 1.3 + 1.0) * 0.5 + 0.5;
  float b = sin(length(p) * 5.0 - t * 2.0) * 0.5 + 0.5;
  return vec3(r, g, b);
}

void main() {
  vec2 uv = v_uv * 2.0 - 1.0;
  uv.x *= u_resolution.x / u_resolution.y;

  float zoomPerStep = 0.07 + u_mid * 0.05;
  float rotPerStep  = 0.03 + u_high * 0.04;

  vec3 col = vec3(0.0);
  float totalW = 0.0;
  for (int i = 0; i < 10; i++) {
    float fi = float(i);
    float zoom = pow(1.0 + zoomPerStep, fi);
    float rot  = fi * rotPerStep;
    float c = cos(rot), s = sin(rot);
    vec2 p = mat2(c, -s, s, c) * (uv * zoom);
    float t = u_time * (0.35 + u_bass * 0.2) - fi * 0.06;
    float w = pow(0.72, fi);
    col += base(p, t) * w;
    totalW += w;
  }
  fragColor = vec4(col / totalW, 1.0);
}`;

// Lower 55%: 24-band VU spectrum bars (green→yellow→red, gaps between bars).
// Upper 45%: oscilloscope trace driven by bass/mid/high.
// v_uv.y=0 is the bottom of the screen, so bars rise naturally from the bottom.
const SCOPE_SRC = `#version 300 es
precision highp float;
uniform float u_time;
uniform vec2 u_resolution;
uniform float u_bass;
uniform float u_mid;
uniform float u_high;
in vec2 v_uv;
out vec4 fragColor;

void main() {
  float x = v_uv.x;
  float y = v_uv.y;
  float split = 0.55;
  vec3 col = vec3(0.0);

  if (y < split) {
    float normY  = y / split;
    float numBars = 24.0;
    float barX   = fract(x * numBars);
    float barIdx = floor(x * numBars);
    float t = barIdx / (numBars - 1.0);

    float level;
    if (t < 0.5) {
      level = mix(u_bass, u_mid, t * 2.0);
    } else {
      level = mix(u_mid, u_high, (t - 0.5) * 2.0);
    }
    level = clamp(level + sin(barIdx * 1.7 + u_time * 8.0) * 0.04 * level, 0.0, 1.0);

    float lit = step(normY, level);
    vec3 barColor;
    if (normY < 0.6) {
      barColor = mix(vec3(0.1, 0.85, 0.2), vec3(0.9, 0.85, 0.1), normY / 0.6);
    } else {
      barColor = mix(vec3(0.9, 0.85, 0.1), vec3(0.95, 0.1, 0.1), (normY - 0.6) / 0.4);
    }
    float gap = step(0.88, barX);
    col = barColor * mix(0.07, 1.0, lit) * (1.0 - gap * 0.95);
  } else {
    float normY = (y - split) / (1.0 - split);
    float wave = clamp(
      0.5 + 0.35 * u_bass * sin(x * 18.0 + u_time * 3.0)
          + 0.20 * u_mid  * sin(x * 32.0 + u_time * 6.5)
          + 0.10 * u_high * sin(x * 56.0 + u_time * 11.0),
      0.05, 0.95);
    float dist = abs(normY - wave);
    float line = smoothstep(0.03, 0.0, dist);
    float glow = smoothstep(0.12, 0.0, dist) * 0.35;
    col = (line + glow) * vec3(0.15, 0.9, 0.5) * (1.0 + u_bass * 0.4);
  }

  fragColor = vec4(col, 1.0);
}`;

export const BUILT_IN_SHADERS: BuiltInShader[] = [
  { name: 'Plasma', src: PLASMA_SRC },
  { name: 'Tunnel', src: TUNNEL_SRC },
  { name: 'Particles', src: PARTICLES_SRC },
  { name: 'Feedback', src: FEEDBACK_SRC },
  { name: 'Scope', src: SCOPE_SRC },
];
