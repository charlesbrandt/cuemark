/*{
  "DESCRIPTION": "Layered sine-wave color field, pulses with bass",
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
  float t = TIME * 0.4;
  float r = sin(uv.x * 4.0 + t) * 0.5 + 0.5;
  float g = sin(uv.y * 3.0 + t * 1.3 + 1.0) * 0.5 + 0.5;
  float b = sin(length(uv) * 5.0 - t * 2.0) * 0.5 + 0.5;
  float pulse = 1.0 + bass * 0.3;
  gl_FragColor = vec4(r * pulse, g, b, 1.0);
}
