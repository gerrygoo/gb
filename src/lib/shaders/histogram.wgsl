// 32×32×32 RGB histogram. One thread per pixel, atomicAdd straight to the
// global storage buffer — no shared-memory pre-accumulation (see Phase 5
// notes: the full 32³ histogram doesn't fit in the 16KB default workgroup
// storage limit, and this only ever runs on a single still frame, so
// atomic contention against global memory is a non-issue).
//
// Bin encoding: per channel, bucket = clamp(floor(value * 32), 0, 31);
// bin index = r*32*32 + g*32 + b. Must match palette.ts's decode.

@group(0) @binding(0) var sourceTex: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> histogram: array<atomic<u32>>;

const BINS_PER_CHANNEL: f32 = 32.0;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let dims = textureDimensions(sourceTex);
  if (id.x >= dims.x || id.y >= dims.y) {
    return;
  }

  let color = textureLoad(sourceTex, vec2<i32>(i32(id.x), i32(id.y)), 0);

  let r = u32(clamp(floor(color.r * BINS_PER_CHANNEL), 0.0, BINS_PER_CHANNEL - 1.0));
  let g = u32(clamp(floor(color.g * BINS_PER_CHANNEL), 0.0, BINS_PER_CHANNEL - 1.0));
  let b = u32(clamp(floor(color.b * BINS_PER_CHANNEL), 0.0, BINS_PER_CHANNEL - 1.0));

  let idx = r * 32u * 32u + g * 32u + b;
  atomicAdd(&histogram[idx], 1u);
}
