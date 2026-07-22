// Per-pixel palette quantization with dithering. One thread per pixel:
// perturb the source color by a dither offset (blue-noise or ordered
// Bayer), then brute-force nearest-neighbor search over the palette.
//
// Palette is a storage buffer of vec4<f32> (rgb used, alpha unused), already
// pre-converted to the working color space by quantize.ts's
// createPaletteBuffer (cheaper than converting per palette entry per pixel
// here). When colorSpace is linear (q7), the sampled pixel is converted to
// linear light before the nearest-color distance calc against that
// pre-converted palette; histogram.wgsl performs the equivalent conversion
// before bucketing so the palette itself was built in that same space.
//
// R/G/B each sample a different offset into the 64×64 blue-noise texture
// (fixed prime-ish shifts) so channels don't all dither in the same
// direction — that would just look like brightness jitter along the (1,1,1)
// diagonal rather than genuine color dithering. Bayer dither, by contrast,
// applies the same threshold to all three channels — that's the classic
// ordered-dither look (visible crosshatch, color-neutral per pixel).

@group(0) @binding(0) var sourceTex: texture_2d<f32>;
@group(0) @binding(1) var noiseTex: texture_2d<f32>;
@group(0) @binding(2) var<storage, read> palette: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> outIndices: array<u32>;

struct Params {
  ditherMode: u32,
  colorSpace: u32,
  colorCount: u32,
};
@group(0) @binding(4) var<uniform> params: Params;

const NOISE_SIZE: u32 = 64u;
// Amplitude of the per-channel dither offset in 0-1 color space. Tuned by
// eye against a gradient test clip: smooth falloff, no visible banding, no
// visible tiling of the 64x64 noise pattern at 1x zoom.
const DITHER_AMPLITUDE: f32 = 0.10;

const DITHER_NONE: u32 = 0u;
const DITHER_BLUE_NOISE: u32 = 1u;
const DITHER_BAYER: u32 = 2u;
const COLOR_SPACE_LINEAR: u32 = 1u;

const BAYER_8X8: array<f32, 64> = array<f32, 64>(
   0.0, 32.0,  8.0, 40.0,  2.0, 34.0, 10.0, 42.0,
  48.0, 16.0, 56.0, 24.0, 50.0, 18.0, 58.0, 26.0,
  12.0, 44.0,  4.0, 36.0, 14.0, 46.0,  6.0, 38.0,
  60.0, 28.0, 52.0, 20.0, 62.0, 30.0, 54.0, 22.0,
   3.0, 35.0, 11.0, 43.0,  1.0, 33.0,  9.0, 41.0,
  51.0, 19.0, 59.0, 27.0, 49.0, 17.0, 57.0, 25.0,
  15.0, 47.0,  7.0, 39.0, 13.0, 45.0,  5.0, 37.0,
  63.0, 31.0, 55.0, 23.0, 61.0, 29.0, 53.0, 21.0,
);

fn srgbToLinear(c: vec3<f32>) -> vec3<f32> {
  let lo = c / 12.92;
  let hi = pow((c + 0.055) / 1.055, vec3<f32>(2.4));
  return select(hi, lo, c <= vec3<f32>(0.04045));
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let dims = textureDimensions(sourceTex);
  if (id.x >= dims.x || id.y >= dims.y) {
    return;
  }

  let texel = textureLoad(sourceTex, vec2<i32>(i32(id.x), i32(id.y)), 0);
  var color = texel.rgb;
  if (params.colorSpace == COLOR_SPACE_LINEAR) {
    color = srgbToLinear(color);
  }

  var offset = vec3<f32>(0.0);
  if (params.ditherMode == DITHER_BLUE_NOISE) {
    let nx = id.x % NOISE_SIZE;
    let ny = id.y % NOISE_SIZE;
    let n0 = textureLoad(noiseTex, vec2<i32>(i32(nx), i32(ny)), 0).r;
    let n1 = textureLoad(noiseTex, vec2<i32>(i32((nx + 17u) % NOISE_SIZE), i32((ny + 29u) % NOISE_SIZE)), 0).r;
    let n2 = textureLoad(noiseTex, vec2<i32>(i32((nx + 37u) % NOISE_SIZE), i32((ny + 43u) % NOISE_SIZE)), 0).r;
    offset = (vec3<f32>(n0, n1, n2) - 0.5) * DITHER_AMPLITUDE;
  } else if (params.ditherMode == DITHER_BAYER) {
    let bx = id.x % 8u;
    let by = id.y % 8u;
    let bv = BAYER_8X8[by * 8u + bx] / 64.0;
    offset = vec3<f32>((bv - 0.5) * DITHER_AMPLITUDE);
  }
  let dithered = color + offset;

  var bestIdx: u32 = 0u;
  var bestDist: f32 = 1e9;
  for (var i: u32 = 0u; i < params.colorCount; i = i + 1u) {
    let d = dithered - palette[i].rgb;
    let dist = dot(d, d);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }

  let idx = id.y * dims.x + id.x;
  outIndices[idx] = bestIdx;
}
