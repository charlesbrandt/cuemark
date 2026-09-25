/*{
  "DESCRIPTION": "Polar ring tunnel, speeds up with bass",
  "CREDIT": "cuemark built-in",
  "ISFVSN": "2",
  "CATEGORIES": ["cuemark"],
  "INPUTS": [
    { "NAME": "bass", "TYPE": "float", "MIN": 0, "MAX": 1, "DEFAULT": 0, "CUEMARK_BIND": "bass" }
  ]
}*/

void main() {
  vec2 uv = isf_FragNormCoord * 2.0 - 1.0;
  uv.x *= RENDERSIZE.x / RENDERSIZE.y;
  float r = length(uv);
  float a = atan(uv.y, uv.x);
  float t = TIME * 0.8 + bass * 0.5;
  float ring = sin(8.0 / max(r, 0.001) - t * 3.0 + a * 4.0);
  vec3 col = 0.5 + 0.5 * cos(vec3(0.0, 1.0, 2.0) + ring + t);
  col *= smoothstep(0.0, 0.25, r);
  gl_FragColor = vec4(col, 1.0);
}
