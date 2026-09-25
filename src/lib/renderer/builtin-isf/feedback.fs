/*{
  "DESCRIPTION": "Simulated video feedback via layered zoom/rotate steps (no persistent buffer)",
  "CREDIT": "cuemark built-in",
  "ISFVSN": "2",
  "CATEGORIES": ["cuemark"],
  "INPUTS": [
    { "NAME": "bass", "TYPE": "float", "MIN": 0, "MAX": 1, "DEFAULT": 0, "CUEMARK_BIND": "bass" },
    { "NAME": "mid", "TYPE": "float", "MIN": 0, "MAX": 1, "DEFAULT": 0, "CUEMARK_BIND": "mid" },
    { "NAME": "high", "TYPE": "float", "MIN": 0, "MAX": 1, "DEFAULT": 0, "CUEMARK_BIND": "high" }
  ]
}*/

vec3 base(vec2 p, float t) {
  float r = sin(p.x * 3.0 + t) * 0.5 + 0.5;
  float g = sin(p.y * 4.0 + t * 1.3 + 1.0) * 0.5 + 0.5;
  float b = sin(length(p) * 5.0 - t * 2.0) * 0.5 + 0.5;
  return vec3(r, g, b);
}

void main() {
  vec2 uv = isf_FragNormCoord * 2.0 - 1.0;
  uv.x *= RENDERSIZE.x / RENDERSIZE.y;

  float zoomPerStep = 0.07 + mid * 0.05;
  float rotPerStep  = 0.03 + high * 0.04;

  vec3 col = vec3(0.0);
  float totalW = 0.0;
  for (int i = 0; i < 10; i++) {
    float fi = float(i);
    float zoom = pow(1.0 + zoomPerStep, fi);
    float rot  = fi * rotPerStep;
    float c = cos(rot), s = sin(rot);
    vec2 p = mat2(c, -s, s, c) * (uv * zoom);
    float t = TIME * (0.35 + bass * 0.2) - fi * 0.06;
    float w = pow(0.72, fi);
    col += base(p, t) * w;
    totalW += w;
  }
  gl_FragColor = vec4(col / totalW, 1.0);
}
