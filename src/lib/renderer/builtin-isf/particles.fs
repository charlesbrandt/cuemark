/*{
  "DESCRIPTION": "80 drifting glowing particles, sized by high, sped up by bass",
  "CREDIT": "cuemark built-in",
  "ISFVSN": "2",
  "CATEGORIES": ["cuemark"],
  "INPUTS": [
    { "NAME": "bass", "TYPE": "float", "MIN": 0, "MAX": 1, "DEFAULT": 0, "CUEMARK_BIND": "bass" },
    { "NAME": "high", "TYPE": "float", "MIN": 0, "MAX": 1, "DEFAULT": 0, "CUEMARK_BIND": "high" }
  ]
}*/

float hash(float n) { return fract(sin(n) * 43758.5453); }

void main() {
  vec2 uv = isf_FragNormCoord * 2.0 - 1.0;
  uv.x *= RENDERSIZE.x / RENDERSIZE.y;

  vec3 col = vec3(0.0);
  for (int i = 0; i < 80; i++) {
    float fi = float(i);
    float h1 = hash(fi);
    float h2 = hash(fi + 100.0);
    float h3 = hash(fi + 200.0);

    float speed = 0.04 + h3 * 0.06 + bass * 0.12;
    float px = fract(h1 + TIME * speed * 0.11) * 2.0 - 1.0;
    float py = fract(h2 + TIME * speed * 0.07) * 2.0 - 1.0;
    vec2 pos = vec2(px * RENDERSIZE.x / RENDERSIZE.y, py);

    float size = (0.004 + h3 * 0.008) * (1.0 + high * 1.5);
    float d = length(uv - pos);
    float glow = smoothstep(size * 2.5, 0.0, d);
    vec3 hue = 0.5 + 0.5 * cos(vec3(0.0, 2.09, 4.19) + h1 * 6.28 + TIME * 0.2);
    col += hue * glow;
  }
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
