// Separable Lanczos-3 resize. Two entry points share one bind group layout:
// resizeHorizontal reads the source texture and writes an intermediate
// texture (dstWidth × srcHeight); resizeVertical reads that intermediate
// and writes the final output (dstWidth × dstHeight). When downsampling,
// the kernel support is widened by the scale factor to avoid aliasing
// (plain fixed-radius Lanczos rings/aliases badly under minification).

struct ResizeParams {
  srcSize: vec2<u32>,
  dstSize: vec2<u32>,
  radius: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
};

@group(0) @binding(0) var<uniform> params: ResizeParams;
@group(0) @binding(1) var sourceTex: texture_2d<f32>;
@group(0) @binding(2) var outputTex: texture_storage_2d<rgba16float, write>;

const PI: f32 = 3.14159265358979;

fn sinc(x: f32) -> f32 {
  if (abs(x) < 1e-6) {
    return 1.0;
  }
  let px = PI * x;
  return sin(px) / px;
}

fn lanczos(x: f32, a: f32) -> f32 {
  if (abs(x) >= a) {
    return 0.0;
  }
  return sinc(x) * sinc(x / a);
}

// Weighted sum of source texels along one axis around `center` (in source
// pixel space). `fixedCoord` is the unchanged coordinate on the other axis.
fn resample(center: f32, filterScale: f32, srcDim: i32, fixedCoord: i32, horizontal: bool) -> vec4<f32> {
  let support = params.radius * filterScale;
  let iStart = i32(floor(center - support));
  let iEnd = i32(ceil(center + support));

  var sumColor = vec4<f32>(0.0);
  var sumWeight = 0.0;
  for (var t = iStart; t <= iEnd; t = t + 1) {
    let w = lanczos((center - f32(t)) / filterScale, params.radius);
    let clampedT = clamp(t, 0, srcDim - 1);
    let coord = select(
      vec2<i32>(fixedCoord, clampedT),
      vec2<i32>(clampedT, fixedCoord),
      horizontal,
    );
    sumColor = sumColor + textureLoad(sourceTex, coord, 0) * w;
    sumWeight = sumWeight + w;
  }
  return sumColor / max(sumWeight, 1e-6);
}

@compute @workgroup_size(8, 8)
fn resizeHorizontal(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.dstSize.x || id.y >= params.srcSize.y) {
    return;
  }
  let scale = f32(params.srcSize.x) / f32(params.dstSize.x);
  let center = (f32(id.x) + 0.5) * scale - 0.5;
  let filterScale = max(scale, 1.0);
  let color = resample(center, filterScale, i32(params.srcSize.x), i32(id.y), true);
  textureStore(outputTex, vec2<i32>(i32(id.x), i32(id.y)), color);
}

@compute @workgroup_size(8, 8)
fn resizeVertical(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.dstSize.x || id.y >= params.dstSize.y) {
    return;
  }
  let scale = f32(params.srcSize.y) / f32(params.dstSize.y);
  let center = (f32(id.y) + 0.5) * scale - 0.5;
  let filterScale = max(scale, 1.0);
  let color = resample(center, filterScale, i32(params.srcSize.y), i32(id.x), false);
  textureStore(outputTex, vec2<i32>(i32(id.x), i32(id.y)), color);
}
