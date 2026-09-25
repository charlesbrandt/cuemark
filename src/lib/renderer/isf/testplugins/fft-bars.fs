/*{
  "DESCRIPTION": "32 vertical spectrum bars driven by the routed audioFFT texture (test sample, not shipped)",
  "ISFVSN": "2",
  "CATEGORIES": ["Generator", "Audio Reactive"],
  "INPUTS": [
    { "NAME": "spectrum", "TYPE": "audioFFT", "MAX": 32 }
  ]
}*/

void main() {
  float bins = 32.0;
  vec2 uv = isf_FragNormCoord;
  float idx = floor(uv.x * bins);
  float x = (idx + 0.5) / bins;
  float level = IMG_NORM_PIXEL(spectrum, vec2(x, 0.5)).r;
  float f = fract(uv.x * bins);
  float gap = step(0.12, f) * step(f, 0.88);
  float bar = step(uv.y, level) * gap;
  vec3 col = mix(vec3(0.1, 0.4, 1.0), vec3(1.0, 0.2, 0.5), uv.y);
  gl_FragColor = vec4(col * bar, 1.0);
}
