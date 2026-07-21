// Per-pixel palette quantization with blue-noise dither. One thread per
// pixel: perturb the source color by a tiled blue-noise offset, then
// brute-force nearest-neighbor search over the 256-entry palette.
//
// Palette is a storage buffer of vec4<f32> (rgb used, alpha unused) in the
// same 0–1 space as the rgba16float source texture — keeps the nearest-color
// distance calc in one color space instead of mixing 0–255 and 0–1.
//
// R/G/B each sample a different offset into the 64×64 blue-noise texture
// (fixed prime-ish shifts) so channels don't all dither in the same
// direction — that would just look like brightness jitter along the (1,1,1)
// diagonal rather than genuine color dithering.

@group(0) @binding(0) var sourceTex: texture_2d<f32>;
@group(0) @binding(1) var noiseTex: texture_2d<f32>;
@group(0) @binding(2) var<storage, read> palette: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> outIndices: array<u32>;

struct Params {
  ditherEnabled: u32,
};
@group(0) @binding(4) var<uniform> params: Params;

const PALETTE_SIZE: u32 = 256u;
const NOISE_SIZE: u32 = 64u;
// Amplitude of the per-channel dither offset in 0-1 color space. Tuned by
// eye against a gradient test clip: smooth falloff, no visible banding, no
// visible tiling of the 64x64 noise pattern at 1x zoom.
const DITHER_AMPLITUDE: f32 = 0.10;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let dims = textureDimensions(sourceTex);
  if (id.x >= dims.x || id.y >= dims.y) {
    return;
  }

  let color = textureLoad(sourceTex, vec2<i32>(i32(id.x), i32(id.y)), 0);

  var offset = vec3<f32>(0.0);
  if (params.ditherEnabled != 0u) {
    let nx = id.x % NOISE_SIZE;
    let ny = id.y % NOISE_SIZE;
    let n0 = textureLoad(noiseTex, vec2<i32>(i32(nx), i32(ny)), 0).r;
    let n1 = textureLoad(noiseTex, vec2<i32>(i32((nx + 17u) % NOISE_SIZE), i32((ny + 29u) % NOISE_SIZE)), 0).r;
    let n2 = textureLoad(noiseTex, vec2<i32>(i32((nx + 37u) % NOISE_SIZE), i32((ny + 43u) % NOISE_SIZE)), 0).r;
    offset = (vec3<f32>(n0, n1, n2) - 0.5) * DITHER_AMPLITUDE;
  }
  let dithered = color.rgb + offset;

  var bestIdx: u32 = 0u;
  var bestDist: f32 = 1e9;
  for (var i: u32 = 0u; i < PALETTE_SIZE; i = i + 1u) {
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
