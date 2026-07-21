// Phase 3 bootstrap shader: fills a storage buffer with each thread's
// global invocation ID. Verifies adapter/device/dispatch/readback all work.

@group(0) @binding(0) var<storage, read_write> output: array<u32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= arrayLength(&output)) {
    return;
  }
  output[id.x] = id.x;
}
