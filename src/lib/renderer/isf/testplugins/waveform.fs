/*{
  "DESCRIPTION": "Oscilloscope drawn from the PCM tap's audio texture: left in red-pink, right in blue (test sample, not shipped)",
  "ISFVSN": "2",
  "CATEGORIES": ["Generator", "Audio Reactive"],
  "INPUTS": [
    { "NAME": "wave", "TYPE": "audio" }
  ]
}*/

void main() {
  vec2 uv = isf_FragNormCoord;
  // Texture rows: 0.25 = left, 0.75 = right (2 rows). Values are 0-1 centred on 0.5.
  float l = IMG_NORM_PIXEL(wave, vec2(uv.x, 0.25)).r;
  float r = IMG_NORM_PIXEL(wave, vec2(uv.x, 0.75)).r;
  float dl = abs(uv.y - l);
  float dr = abs(uv.y - r);
  float lineL = 1.0 - smoothstep(0.0, 0.012, dl);
  float lineR = 1.0 - smoothstep(0.0, 0.012, dr);
  vec3 col = vec3(1.0, 0.2, 0.5) * lineL + vec3(0.2, 0.5, 1.0) * lineR;
  gl_FragColor = vec4(col, 1.0);
}
