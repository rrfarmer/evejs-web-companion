// The installed High generation pass starts with five weighted pairs. Its
// adaptive pass adds pairs from the same kernel at unit weight before halo weighting.
export const HIGH_TAPS = `
  // The native constant buffer stores the rotation and scale for each of
  // the five pixel subpasses in each plane. Preserve those values before rounding taps.
  const vec2 rotations[20] = vec2[](
    vec2( 0.866999984,  0.0),         vec2( 0.837880731, -0.272243977), vec2( 0.285222501, -0.877825081),
    vec2( 0.534296751, -0.735396445), vec2( 0.724070251, -0.526067793),
    vec2(-0.000000082, -0.936999977), vec2(-0.293875128, -0.904454708), vec2(-0.944399297, -0.306853682),
    vec2(-0.792027712, -0.575441718), vec2(-0.567212820, -0.780701458),
    vec2(-1.006999969,  0.000000088), vec2(-0.971028686,  0.315506339), vec2(-0.328485012,  1.010972977),
    vec2(-0.616586447,  0.848658979), vec2(-0.837332368,  0.608357787),
    vec2( 0.000000188,  1.077000022), vec2( 0.337137848,  1.037602544), vec2( 1.077547193,  0.350116193),
    vec2( 0.905290067,  0.657731712), vec2( 0.649503112,  0.893963635)
  );
  const vec4 taps[32] = vec4[](
    vec4( 0.784881,  0.566617, 1.50, -0.126083), vec4( 0.260222, -0.295752, 1.50, -1.064030),
    vec4( 0.104594,  0.083725, 1.11, -2.730563), vec4(-0.682868,  0.049630, 1.09, -0.498827),
    vec4(-0.135702, -0.641902, 1.25, -0.532765), vec4(-0.261938, -0.082051, 0.67, -1.783245),
    vec4(-0.611775,  0.666642, 0.71, -0.044234), vec4( 0.436756,  0.251190, 0.61, -1.167283),
    vec4( 0.078844,  0.866187, 0.64, -0.459002), vec4(-0.127909, -0.298690, 0.60, -1.729424),
    vec4(-0.040311,  0.024136, 0.60, -4.792042), vec4( 0.162012, -0.528514, 0.79, -1.067055),
    vec4(-0.709912,  0.473011, 0.64, -0.335236), vec4( 0.032777, -0.223497, 0.60, -1.982384),
    vec4( 0.689217,  0.368007, 0.63, -0.266718), vec4( 0.292518,  0.377754, 0.61, -1.422520),
    vec4(-0.122241,  0.965826, 0.60, -0.426142), vec4( 0.110715, -0.161311, 0.60, -2.165947),
    vec4( 0.465621, -0.597477, 0.60, -0.189760), vec4(-0.515488,  0.118042, 0.60, -1.246800),
    vec4( 0.891413, -0.420904, 0.60,  0.028192), vec4(-0.324025, -0.015915, 0.60, -1.543018),
    vec4( 0.607712,  0.416352, 0.60, -0.605411), vec4( 0.023796, -0.082398, 0.60, -3.809046),
    vec4( 0.489512, -0.236570, 0.60, -1.189011), vec4(-0.176116, -0.816969, 0.60, -0.513724),
    vec4(-0.339302, -0.207322, 0.60, -1.698047), vec4(-0.919744,  0.054032, 0.60,  0.062246),
    vec4(-0.150646, -0.149493, 0.60, -1.896062), vec4( 0.531810, -0.352104, 0.60, -0.758838),
    vec4( 0.414872,  0.814426, 0.60, -0.505648), vec4(-0.241070, -0.327215, 0.60, -1.665244)
  );
`;

export const GENERATE_IMPORTANCE = `
  uniform highp sampler2D source;
  void main() {
    ivec2 pixel = ivec2(gl_FragCoord.xy) * 2;
    ivec2 last = textureSize(source, 0) - 1;
    vec4 minVisibility = vec4(1.0), maxVisibility = vec4(0.0);
    for (int y = 0; y < 2; y++) for (int x = 0; x < 2; x++) {
      vec4 base = texelFetch(source, min(pixel + ivec2(x, y), last), 0);
      vec4 visibility = pow(clamp(1.0 - 4.3 * base, 0.0, 1.0), vec4(2.6));
      minVisibility = min(minVisibility, visibility);
      maxVisibility = max(maxVisibility, visibility);
    }
    float low = min(min(minVisibility.x, minVisibility.y), min(minVisibility.z, minVisibility.w));
    float high = max(max(maxVisibility.x, maxVisibility.y), max(maxVisibility.z, maxVisibility.w));
    gl_FragColor = vec4(pow(clamp(2.0 * (high - low), 0.0, 1.0), 0.8), 0.0, 0.0, 1.0);
  }
`;

export const FILTER_IMPORTANCE = `
  uniform highp sampler2D source;
  uniform bool secondFilter;
  void main() {
    vec2 scale = 1.0 / vec2(textureSize(source, 0));
    vec2 pixel = gl_FragCoord.xy;
    vec2 a = secondFilter ? vec2(-0.5, -1.5) : vec2(-1.5, -0.5);
    vec2 b = vec2(-a.y, a.x);
    float sum = texture(source, (pixel + a) * scale).r + texture(source, (pixel - a) * scale).r
              + texture(source, (pixel + b) * scale).r + texture(source, (pixel - b) * scale).r;
    gl_FragColor = vec4(0.25 * sum, 0.0, 0.0, 1.0);
  }
`;

// Accumulate the native counter from every third row and column. Reuse this
// shader with stride one to sum the tiles until only one texel remains.
export const SUM_IMPORTANCE = `
  uniform highp sampler2D source;
  uniform int stride;
  void main() {
    ivec2 size = textureSize(source, 0);
    ivec2 first = ivec2(gl_FragCoord.xy) * (4 * stride);
    float sum = 0.0;
    for (int y = 0; y < 4; y++) for (int x = 0; x < 4; x++) {
      ivec2 pixel = first + stride * ivec2(x, y);
      if (any(greaterThanEqual(pixel, size))) continue;
      float value = texelFetch(source, pixel, 0).r;
      sum += stride == 3 ? roundEven(value * 255.0) : value;
    }
    gl_FragColor = vec4(sum, 0.0, 0.0, 1.0);
  }
`;
