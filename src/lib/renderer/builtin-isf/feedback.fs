/*{
  "DESCRIPTION": "Video feedback: a persistent buffer re-sampled each frame with a slight zoom and rotation, fresh colour injected near the centre",
  "CREDIT": "cuemark built-in",
  "ISFVSN": "2",
  "CATEGORIES": ["cuemark"],
  "INPUTS": [
    { "NAME": "bass", "TYPE": "float", "MIN": 0, "MAX": 1, "DEFAULT": 0, "CUEMARK_BIND": "bass" },
    { "NAME": "mid", "TYPE": "float", "MIN": 0, "MAX": 1, "DEFAULT": 0, "CUEMARK_BIND": "mid" },
    { "NAME": "high", "TYPE": "float", "MIN": 0, "MAX": 1, "DEFAULT": 0, "CUEMARK_BIND": "high" }
  ],
  "PASSES": [
    { "TARGET": "trail", "PERSISTENT": true, "FLOAT": true },
    {}
  ]
}*/

vec3 hue(float h) {
  return 0.5 + 0.5 * cos(6.2831853 * (h + vec3(0.0, 0.33, 0.67)));
}

void main() {
  if (PASSINDEX == 0) {
    // Read last frame's picture, pulled slightly inwards and turned, then faded.
    vec2 p = isf_FragNormCoord - 0.5;
    p.x *= RENDERSIZE.x / RENDERSIZE.y;
    float zoom = 0.985 - mid * 0.02;
    float rot = 0.01 + high * 0.03;
    float c = cos(rot), s = sin(rot);
    p = mat2(c, -s, s, c) * p * zoom;
    p.x /= RENDERSIZE.x / RENDERSIZE.y;
    vec3 prev = IMG_NORM_PIXEL(trail, p + 0.5).rgb * 0.965;

    // Fresh ring at the centre; it breathes with the bass and the trail carries it outwards.
    vec2 q = isf_FragNormCoord - 0.5;
    q.x *= RENDERSIZE.x / RENDERSIZE.y;
    float r = length(q);
    float ringR = 0.08 + bass * 0.12;
    float ring = smoothstep(0.03, 0.0, abs(r - ringR));
    vec3 fresh = hue(TIME * 0.05 + atan(q.y, q.x) / 6.2831853 + bass * 0.3) * ring;
    gl_FragColor = vec4(max(prev, fresh), 1.0);
  } else {
    gl_FragColor = vec4(IMG_NORM_PIXEL(trail, isf_FragNormCoord).rgb, 1.0);
  }
}
