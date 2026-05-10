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

export const BUILT_IN_SHADERS: BuiltInShader[] = [
  { name: 'Plasma', src: PLASMA_SRC },
  { name: 'Tunnel', src: TUNNEL_SRC },
];
