/*{
  "DESCRIPTION": "24-band VU spectrum bars plus an oscilloscope trace",
  "CREDIT": "cuemark built-in",
  "ISFVSN": "2",
  "CATEGORIES": ["cuemark"],
  "INPUTS": [
    { "NAME": "bass", "TYPE": "float", "MIN": 0, "MAX": 1, "DEFAULT": 0, "CUEMARK_BIND": "bass" },
    { "NAME": "mid", "TYPE": "float", "MIN": 0, "MAX": 1, "DEFAULT": 0, "CUEMARK_BIND": "mid" },
    { "NAME": "high", "TYPE": "float", "MIN": 0, "MAX": 1, "DEFAULT": 0, "CUEMARK_BIND": "high" }
  ]
}*/

// Lower 55%: 24-band VU spectrum bars (green->yellow->red, gaps between bars).
// Upper 45%: oscilloscope trace driven by bass/mid/high.
// isf_FragNormCoord.y=0 is the bottom of the screen, so bars rise naturally from the bottom.
void main() {
  float x = isf_FragNormCoord.x;
  float y = isf_FragNormCoord.y;
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
      level = mix(bass, mid, t * 2.0);
    } else {
      level = mix(mid, high, (t - 0.5) * 2.0);
    }
    level = clamp(level + sin(barIdx * 1.7 + TIME * 8.0) * 0.04 * level, 0.0, 1.0);

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
      0.5 + 0.35 * bass * sin(x * 18.0 + TIME * 3.0)
          + 0.20 * mid  * sin(x * 32.0 + TIME * 6.5)
          + 0.10 * high * sin(x * 56.0 + TIME * 11.0),
      0.05, 0.95);
    float dist = abs(normY - wave);
    float line = smoothstep(0.03, 0.0, dist);
    float glow = smoothstep(0.12, 0.0, dist) * 0.35;
    col = (line + glow) * vec3(0.15, 0.9, 0.5) * (1.0 + bass * 0.4);
  }

  gl_FragColor = vec4(col, 1.0);
}
