// Real-time 2D D2Q9 Lattice-Boltzmann Wind Tunnel (Smagorinsky LES, WebGL2)

export const LBM = {
  NX: 640,
  NY: 320,
  DX0: -0.8,
  DX1: 2.2,
  DY0: -0.75,
  DY1: 0.75,
  VX0: -0.42,
  VX1: 1.42,
  VY0: -0.46,
  VY1: 0.46,
  TAU0: 0.515,
  CS: 0.16,
  SPONGE_START: 0.80,
  SPONGE_TAU: 0.85,
  VORT_C: 7.4,
};

LBM.CHORD_L = LBM.NX / (LBM.DX1 - LBM.DX0);
LBM.NU = (LBM.TAU0 - 0.5) / 3;

export function lbmSimRe(U0) {
  return (U0 * LBM.CHORD_L) / LBM.NU;
}

export function lbmNaca4(m = 0, p = 4, t = 12, n = 60) {
  m /= 100;
  p /= 10;
  t /= 100;
  const up = [];
  const lo = [];
  for (let i = 0; i <= n; i++) {
    const b = (Math.PI * i) / n;
    const x = 0.5 * (1 - Math.cos(b));
    const yt =
      5 *
      t *
      (0.2969 * Math.sqrt(x) -
        0.126 * x -
        0.3516 * x * x +
        0.2843 * x ** 3 -
        0.1036 * x ** 4);
    let yc = 0;
    let dyc = 0;
    if (m > 0 && p > 0) {
      if (x < p) {
        yc = (m / (p * p)) * (2 * p * x - x * x);
        dyc = ((2 * m) / (p * p)) * (p - x);
      } else {
        yc = (m / (1 - p) ** 2) * (1 - 2 * p + 2 * p * x - x * x);
        dyc = ((2 * m) / (1 - p) ** 2) * (p - x);
      }
    }
    const th = Math.atan(dyc);
    up.push([x - yt * Math.sin(th), yc + yt * Math.cos(th)]);
    lo.push([x + yt * Math.sin(th), yc - yt * Math.cos(th)]);
  }
  up.reverse();
  return up.concat(lo.slice(1));
}

const LBM_NP = 200;

function lbmRotate(coords, aDeg) {
  const a = (-aDeg * Math.PI) / 180;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  return coords.map(([x, y]) => {
    const dx = x - 0.25;
    return [0.25 + dx * ca - y * sa, dx * sa + y * ca];
  });
}

function lbmPanelise(coords) {
  const xs = coords.map((p) => p[0]);
  const ys = coords.map((p) => p[1]);
  const arc = [0];
  for (let i = 1; i < coords.length; i++) {
    arc.push(arc[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]));
  }
  const L = arc[arc.length - 1];
  const xp = [];
  const yp = [];
  for (let i = 0; i <= LBM_NP; i++) {
    const s = L * 0.5 * (1 - Math.cos((Math.PI * i) / LBM_NP));
    let j = 0;
    while (j < arc.length - 2 && arc[j + 1] < s) j++;
    const t = (s - arc[j]) / (arc[j + 1] - arc[j] + 1e-12);
    xp.push(xs[j] + (xs[j + 1] - xs[j]) * t);
    yp.push(ys[j] + (ys[j + 1] - ys[j]) * t);
  }
  return { xp, yp };
}

function lbmRasterMask(xp, yp) {
  const { NX, NY, DX0, DX1, DY0, DY1 } = LBM;
  const mask = new Uint8Array(NX * NY);
  const n = xp.length;
  for (let iy = 0; iy < NY; iy++) {
    const wy = DY0 + ((iy + 0.5) / NY) * (DY1 - DY0);
    const xs = [];
    for (let i = 0; i < n - 1; i++) {
      const y1 = yp[i];
      const y2 = yp[i + 1];
      if (y1 > wy !== y2 > wy) {
        xs.push(xp[i] + ((xp[i + 1] - xp[i]) * (wy - y1)) / (y2 - y1));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      let ix0 = Math.ceil(((xs[k] - DX0) / (DX1 - DX0)) * NX - 0.5);
      let ix1 = Math.floor(((xs[k + 1] - DX0) / (DX1 - DX0)) * NX - 0.5);
      ix0 = Math.max(0, ix0);
      ix1 = Math.min(NX - 1, ix1);
      for (let ix = ix0; ix <= ix1; ix++) mask[iy * NX + ix] = 255;
    }
  }
  return mask;
}

function lbmLerp(t, S) {
  t = Math.max(0, Math.min(1, t));
  const f = t * (S.length - 1);
  const i = Math.min(Math.floor(f), S.length - 2);
  const u = f - i;
  return [0, 1, 2].map((k) => S[i][k] * (1 - u) + S[i + 1][k] * u);
}

const LBM_SPEED = [
  [0, 0, 40], [0, 0, 180], [0, 80, 255], [0, 180, 255], [0, 255, 255],
  [0, 255, 140], [60, 255, 0], [255, 255, 0], [255, 140, 0], [255, 0, 0],
];
const LBM_CP = [
  [20, 50, 160], [40, 110, 210], [100, 175, 235], [190, 220, 245],
  [248, 248, 248], [248, 214, 140], [240, 150, 60], [205, 50, 25],
];

const LBM_GLSL_CONST = () => `
const int NX=${LBM.NX}; const int NY=${LBM.NY};
const float DX0=${LBM.DX0.toFixed(4)}; const float DXW=${(LBM.DX1 - LBM.DX0).toFixed(4)};
const float DY0=${LBM.DY0.toFixed(4)}; const float DYH=${(LBM.DY1 - LBM.DY0).toFixed(4)};
const float CELL=${((LBM.DX1 - LBM.DX0) / LBM.NX).toFixed(8)};
`;

const LBM_VS = `#version 300 es
const vec2 P[3]=vec2[3](vec2(-1.0,-1.0),vec2(3.0,-1.0),vec2(-1.0,3.0));
out vec2 vUV;
void main(){ vec2 p=P[gl_VertexID]; vUV=(p+1.0)*0.5; gl_Position=vec4(p,0.0,1.0); }`;

const LBM_STEP_FS = () => `#version 300 es
precision highp float; precision highp int;
${LBM_GLSL_CONST()}
uniform sampler2D texA, texB, texC, texMask;
uniform float tau0, cs, U0, spongeStart, spongeTau;
layout(location=0) out vec4 outA;
layout(location=1) out vec4 outB;
layout(location=2) out vec4 outC;

const ivec2 E[9]=ivec2[9](ivec2(0,0),ivec2(1,0),ivec2(0,1),ivec2(-1,0),ivec2(0,-1),ivec2(1,1),ivec2(-1,1),ivec2(-1,-1),ivec2(1,-1));
const int OPP[9]=int[9](0,3,4,1,2,7,8,5,6);
const float W[9]=float[9](4.0/9.0,1.0/9.0,1.0/9.0,1.0/9.0,1.0/9.0,1.0/36.0,1.0/36.0,1.0/36.0,1.0/36.0);

float fAt(int i, ivec2 q){
  if(i<4) return texelFetch(texA,q,0)[i];
  if(i<8) return texelFetch(texB,q,0)[i-4];
  return texelFetch(texC,q,0).r;
}
float feq(int i, float rho, vec2 u){
  float eu=dot(vec2(E[i]),u);
  return W[i]*rho*(1.0+3.0*eu+4.5*eu*eu-1.5*dot(u,u));
}
bool solidAt(ivec2 q){ return texelFetch(texMask,clamp(q,ivec2(0),ivec2(NX-1,NY-1)),0).r>0.5; }

void main(){
  ivec2 p=ivec2(gl_FragCoord.xy);
  if(solidAt(p)){
    float g[9]; for(int i=0;i<9;i++) g[i]=fAt(OPP[i],p);
    outA=vec4(g[0],g[1],g[2],g[3]); outB=vec4(g[4],g[5],g[6],g[7]); outC=vec4(g[8],1.0,0.0,0.0);
    return;
  }
  if(p.x==NX-1){
    ivec2 s=p-ivec2(1,0);
    vec4 a=texelFetch(texA,s,0), b=texelFetch(texB,s,0), c=texelFetch(texC,s,0);
    outA=a; outB=b; outC=c; return;
  }
  if(p.x==0||p.y==0||p.y==NY-1){
    vec2 u=vec2(U0,0.0); float g[9]; for(int i=0;i<9;i++) g[i]=feq(i,1.0,u);
    outA=vec4(g[0],g[1],g[2],g[3]); outB=vec4(g[4],g[5],g[6],g[7]); outC=vec4(g[8],1.0,U0,0.0);
    return;
  }
  float fin[9];
  for(int i=0;i<9;i++){
    ivec2 s=p-E[i];
    fin[i]= solidAt(s) ? fAt(OPP[i],p) : fAt(i,s);
  }
  float rho=0.0; vec2 u=vec2(0.0);
  for(int i=0;i<9;i++){ rho+=fin[i]; u+=vec2(E[i])*fin[i]; }
  u/=rho;
  rho=clamp(rho,0.5,2.0);
  float sp=length(u); if(sp>0.3) u*=0.3/sp;

  float Pxx=0.0,Pyy=0.0,Pxy=0.0;
  for(int i=0;i<9;i++){
    float fn=fin[i]-feq(i,rho,u); vec2 e=vec2(E[i]);
    Pxx+=e.x*e.x*fn; Pyy+=e.y*e.y*fn; Pxy+=e.x*e.y*fn;
  }
  float Q=sqrt(Pxx*Pxx+Pyy*Pyy+2.0*Pxy*Pxy);
  float xs=float(p.x)/float(NX);
  float tauL=mix(tau0,spongeTau,smoothstep(spongeStart,1.0,xs));
  float tauE=0.5*(tauL+sqrt(tauL*tauL+18.0*1.41421356*cs*cs*Q/rho));

  float fo[9];
  for(int i=0;i<9;i++) fo[i]=fin[i]-(fin[i]-feq(i,rho,u))/tauE;
  outA=vec4(fo[0],fo[1],fo[2],fo[3]); outB=vec4(fo[4],fo[5],fo[6],fo[7]);
  outC=vec4(fo[8],rho,u);
}`;

const LBM_DYE_FS = () => `#version 300 es
precision highp float;
${LBM_GLSL_CONST()}
uniform sampler2D texDye, texC, texMask;
uniform float steps;
out vec4 o;
void main(){
  ivec2 p=ivec2(gl_FragCoord.xy);
  vec2 uv=gl_FragCoord.xy/vec2(NX,NY);
  if(texelFetch(texMask,p,0).r>0.5){ o=vec4(0.0); return; }
  if(p.x<3){
    float y=gl_FragCoord.y;
    float band=1.0-smoothstep(1.0,2.2,abs(mod(y,12.0)-6.0));
    o=vec4(band,0.0,0.0,1.0); return;
  }
  vec2 u=texelFetch(texC,p,0).ba;
  vec2 mid=uv-0.5*u*steps/vec2(NX,NY);
  vec2 um=texture(texC,mid).ba;
  vec2 back=uv-um*steps/vec2(NX,NY);
  float d=texture(texDye,back).r;
  o=vec4(d*0.9995,0.0,0.0,1.0);
}`;

const LBM_FIELD_FS = () => `#version 300 es
precision highp float;
${LBM_GLSL_CONST()}
uniform sampler2D texC, texMask, texDye;
uniform int fieldMode;
uniform float U0, maxS, cpMin, cpMax, vortFull;
out vec4 o;
void main(){
  ivec2 p=ivec2(gl_FragCoord.xy);
  float solid=texelFetch(texMask,p,0).r;
  vec4 c=texelFetch(texC,p,0);
  float t=0.0;
  if(fieldMode==0) t=length(c.ba)/U0/max(maxS*0.92,1e-6);
  else if(fieldMode==1) t=((c.g-1.0)/(1.5*U0*U0)-cpMin)/max(cpMax-cpMin,1e-6);
  else if(fieldMode==2){
    ivec2 q=clamp(p,ivec2(1),ivec2(NX-2,NY-2));
    float w=0.5*(texelFetch(texC,q+ivec2(1,0),0).a-texelFetch(texC,q-ivec2(1,0),0).a)
           -0.5*(texelFetch(texC,q+ivec2(0,1),0).b-texelFetch(texC,q-ivec2(0,1),0).b);
    t=w/vortFull;
  } else t=texelFetch(texDye,p,0).r;
  o=vec4(t,solid,0.0,1.0);
}`;

const LBM_COMPOSITE_FS = () => `#version 300 es
precision highp float;
${LBM_GLSL_CONST()}
uniform sampler2D texField;
uniform int fieldMode;
uniform vec4 view;
in vec2 vUV; out vec4 o;
vec3 speedColor(float t){
  vec3 C[10]=vec3[10](vec3(0,0,40),vec3(0,0,180),vec3(0,80,255),vec3(0,180,255),vec3(0,255,255),vec3(0,255,140),vec3(60,255,0),vec3(255,255,0),vec3(255,140,0),vec3(255,0,0));
  t=clamp(t,0.0,1.0); float f=t*9.0; int i=min(int(floor(f)),8);
  return mix(C[i],C[i+1],f-float(i))/255.0;
}
vec3 cpColor(float t){
  vec3 C[8]=vec3[8](vec3(20,50,160),vec3(40,110,210),vec3(100,175,235),vec3(190,220,245),vec3(248,248,248),vec3(248,214,140),vec3(240,150,60),vec3(205,50,25));
  t=clamp(t,0.0,1.0); float f=t*7.0; int i=min(int(floor(f)),6);
  return mix(C[i],C[i+1],f-float(i))/255.0;
}
vec3 vortColor(float t){
  t=clamp(t,-1.0,1.0);
  vec3 bg=vec3(0.05,0.07,0.11);
  return t<0.0?mix(bg,vec3(0.15,0.5,0.98),-t):mix(bg,vec3(0.98,0.28,0.18),t);
}
void main(){
  vec2 w=view.xy+vUV*view.zw;
  vec2 g=vec2((w.x-DX0)/DXW,(w.y-DY0)/DYH);
  vec4 f=texture(texField,g);
  vec3 col;
  if(fieldMode==0) col=speedColor(f.r);
  else if(fieldMode==1) col=cpColor(f.r);
  else if(fieldMode==2) col=vortColor(f.r);
  else { vec3 bg=vec3(0.051,0.067,0.078); col=mix(bg,vec3(0.93,0.95,1.0),clamp(f.r*1.15,0.0,1.0)); }
  col=mix(col,vec3(0.051,0.067,0.078),smoothstep(0.35,0.65,f.g));
  o=vec4(col,1.0);
}`;

export function createWindTunnel2D(canvas, options = {}) {
  const {
    coords: initCoords = null,
    name: initName = "NACA 0012",
    alphaDeg: initAlpha = 6,
    u0: initU0 = 0.06,
    fieldMode: initField = 0,
    onStats,
    onSteps,
    onError,
  } = options;

  const { NX, NY, DX0, DX1, DY0, DY1, VX0, VX1, VY0, VY1 } = LBM;
  const W = 640;
  const H = 320;
  const dpr = typeof window !== "undefined" ? Math.min(Math.max(window.devicePixelRatio || 1, 2), 2.5) : 2;
  const PX = 32;
  const PY = 18;
  const RIGHT = 68;
  const PW = W - PX - RIGHT;
  const PH = 270;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const cx = canvas.getContext("2d");

  const state = {
    U0: initU0,
    aDeg: initAlpha,
    fieldMode: initField,
    maxS: 1.6,
    cpMin: -1.5,
    cpMax: 1.0,
    CL: null,
    CD: null,
    sep: 0,
    frame: 0,
    paused: false,
  };

  let foilName = initName;
  let baseCoords = initCoords && initCoords.length > 2 ? initCoords : lbmNaca4(0, 4, 12, 60);

  const glcv = document.createElement("canvas");
  glcv.width = PW * 2;
  glcv.height = PH * 2;
  let gl = null;
  let ok = false;
  let err = "";

  try {
    gl = glcv.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error("WebGL2 is not available in this browser.");
    if (!gl.getExtension("EXT_color_buffer_float")) {
      throw new Error("WebGL2 EXT_color_buffer_float support is required.");
    }
    ok = true;
  } catch (e) {
    err = e.message;
    onError?.(err);
  }

  const prog = {};
  const U = {};
  const createdTextures = [];
  const createdFbos = [];
  const createdPrograms = [];

  function compile(src, type) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error("Shader compile error: " + gl.getShaderInfoLog(s));
    }
    return s;
  }

  function program(key, vs, fs, uniforms) {
    const p = gl.createProgram();
    const s1 = compile(vs, gl.VERTEX_SHADER);
    const s2 = compile(fs, gl.FRAGMENT_SHADER);
    gl.attachShader(p, s1);
    gl.attachShader(p, s2);
    gl.linkProgram(p);
    gl.deleteShader(s1);
    gl.deleteShader(s2);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error("Shader link error: " + gl.getProgramInfoLog(p));
    }
    prog[key] = p;
    createdPrograms.push(p);
    U[key] = {};
    uniforms.forEach((n) => {
      U[key][n] = gl.getUniformLocation(p, n);
    });
  }

  function tex(w, h, ifmt, fmt, type, filter, data) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, w, h, 0, fmt, type, data || null);
    createdTextures.push(t);
    return t;
  }

  function fbo(texs) {
    const f = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    texs.forEach((t, i) =>
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0)
    );
    gl.drawBuffers(texs.map((_, i) => gl.COLOR_ATTACHMENT0 + i));
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error("WebGL2 framebuffer incomplete");
    }
    createdFbos.push(f);
    return f;
  }

  const f32 = (w, h, d, filt) => tex(w, h, gl.RGBA32F, gl.RGBA, gl.FLOAT, filt || gl.NEAREST, d);
  const f16 = (w, h, filt) => tex(w, h, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, filt, null);

  let lat = null;
  let cur = 0;
  let maskTex = null;
  let dye = null;
  let dyeCur = 0;
  let fieldT = null;
  let fieldF = null;

  function bind(unit, t, loc) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.uniform1i(loc, unit);
  }

  function populateLattice() {
    const u0 = state.U0;
    const w = [4 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 36, 1 / 36, 1 / 36, 1 / 36];
    const e = [[0, 0], [1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [-1, -1], [1, -1]];
    const f = e.map(([ex], i) => w[i] * (1 + 3 * ex * u0 + 4.5 * ex * ex * u0 * u0 - 1.5 * u0 * u0));
    const n = NX * NY;
    const a = new Float32Array(n * 4);
    const b = new Float32Array(n * 4);
    const c = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      a.set([f[0], f[1], f[2], f[3]], i * 4);
      b.set([f[4], f[5], f[6], f[7]], i * 4);
      c.set([f[8], 1, u0, 0], i * 4);
    }

    if (!lat) {
      lat = [0, 1].map(() => {
        const t = [f32(NX, NY, a), f32(NX, NY, b), f32(NX, NY, c)];
        return { t, f: fbo(t) };
      });
    } else {
      for (const slot of lat) {
        gl.bindTexture(gl.TEXTURE_2D, slot.t[0]);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, NX, NY, gl.RGBA, gl.FLOAT, a);
        gl.bindTexture(gl.TEXTURE_2D, slot.t[1]);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, NX, NY, gl.RGBA, gl.FLOAT, b);
        gl.bindTexture(gl.TEXTURE_2D, slot.t[2]);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, NX, NY, gl.RGBA, gl.FLOAT, c);
      }
      cur = 0;
    }

    if (dye) {
      for (const slot of dye) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, slot.f);
        gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 1]);
      }
      dyeCur = 0;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    state.CL = null;
    state.CD = null;
    state.sep = 0;
    state.maxS = 1.6;
    state.cpMin = -1.5;
    state.cpMax = 1.0;
    emitStats();
  }

  if (ok) {
    try {
      program("step", LBM_VS, LBM_STEP_FS(), [
        "texA", "texB", "texC", "texMask", "tau0", "cs", "U0", "spongeStart", "spongeTau",
      ]);
      program("dye", LBM_VS, LBM_DYE_FS(), ["texDye", "texC", "texMask", "steps"]);
      program("field", LBM_VS, LBM_FIELD_FS(), [
        "texC", "texMask", "texDye", "fieldMode", "U0", "maxS", "cpMin", "cpMax", "vortFull",
      ]);
      program("comp", LBM_VS, LBM_COMPOSITE_FS(), ["texField", "fieldMode", "view"]);
      dye = [0, 1].map(() => {
        const t = f16(NX, NY, gl.LINEAR);
        return { t, f: fbo([t]) };
      });
      fieldT = f16(NX, NY, gl.LINEAR);
      fieldF = fbo([fieldT]);
      populateLattice();
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    } catch (e) {
      ok = false;
      err = e.message;
      onError?.(err);
    }
  }

  let sol = null;
  function applyGeometry(aDeg) {
    state.aDeg = aDeg;
    const { xp, yp } = lbmPanelise(lbmRotate(baseCoords, aDeg));
    sol = { xp, yp, IN: lbmRasterMask(xp, yp) };
    if (ok) {
      if (!maskTex) {
        maskTex = tex(NX, NY, gl.R8, gl.RED, gl.UNSIGNED_BYTE, gl.NEAREST, sol.IN);
      } else {
        gl.bindTexture(gl.TEXTURE_2D, maskTex);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, NX, NY, gl.RED, gl.UNSIGNED_BYTE, sol.IN);
      }
    }
  }
  applyGeometry(state.aDeg);

  function quad() {
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function stepPass() {
    const s = lat[cur];
    const d = lat[1 - cur];
    const u = U.step;
    gl.bindFramebuffer(gl.FRAMEBUFFER, d.f);
    gl.viewport(0, 0, NX, NY);
    gl.useProgram(prog.step);
    bind(0, s.t[0], u.texA);
    bind(1, s.t[1], u.texB);
    bind(2, s.t[2], u.texC);
    bind(3, maskTex, u.texMask);
    gl.uniform1f(u.tau0, LBM.TAU0);
    gl.uniform1f(u.cs, LBM.CS);
    gl.uniform1f(u.U0, state.U0);
    gl.uniform1f(u.spongeStart, LBM.SPONGE_START);
    gl.uniform1f(u.spongeTau, LBM.SPONGE_TAU);
    quad();
    cur = 1 - cur;
  }

  function dyePass(steps) {
    const s = dye[dyeCur];
    const d = dye[1 - dyeCur];
    gl.bindFramebuffer(gl.FRAMEBUFFER, d.f);
    gl.viewport(0, 0, NX, NY);
    gl.useProgram(prog.dye);
    bind(0, s.t, U.dye.texDye);
    bind(1, lat[cur].t[2], U.dye.texC);
    bind(2, maskTex, U.dye.texMask);
    gl.uniform1f(U.dye.steps, steps);
    quad();
    dyeCur = 1 - dyeCur;
  }

  function displayPass() {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fieldF);
    gl.viewport(0, 0, NX, NY);
    gl.useProgram(prog.field);
    const u = U.field;
    bind(0, lat[cur].t[2], u.texC);
    bind(1, maskTex, u.texMask);
    bind(2, dye[dyeCur].t, u.texDye);
    gl.uniform1i(u.fieldMode, state.fieldMode);
    gl.uniform1f(u.U0, state.U0);
    gl.uniform1f(u.maxS, state.maxS);
    gl.uniform1f(u.cpMin, state.cpMin);
    gl.uniform1f(u.cpMax, state.cpMax);
    gl.uniform1f(u.vortFull, (LBM.VORT_C * state.U0) / LBM.CHORD_L);
    quad();

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, glcv.width, glcv.height);
    gl.useProgram(prog.comp);
    bind(0, fieldT, U.comp.texField);
    gl.uniform1i(U.comp.fieldMode, state.fieldMode);
    gl.uniform4f(U.comp.view, VX0, VY0, VX1 - VX0, VY1 - VY0);
    quad();
  }

  const macro = new Float32Array(NX * NY * 4);
  const FDX = [1, 0, -1, 0];
  const FDY = [0, 1, 0, -1];
  const vx0 = Math.floor(((VX0 - DX0) / (DX1 - DX0)) * NX);
  const vx1 = Math.ceil(((VX1 - DX0) / (DX1 - DX0)) * NX);
  const vy0 = Math.floor(((VY0 - DY0) / (DY1 - DY0)) * NY);
  const vy1 = Math.ceil(((VY1 - DY0) / (DY1 - DY0)) * NY);

  function emitStats() {
    onStats?.({
      cl: state.CL,
      cd: state.CD !== null ? Math.max(0, state.CD) : null,
      reynolds: Math.round(lbmSimRe(state.U0) / 10) * 10,
      separationPct: Math.round(state.sep * 100),
    });
  }

  function readStats() {
    gl.bindFramebuffer(gl.FRAMEBUFFER, lat[cur].f);
    gl.readBuffer(gl.COLOR_ATTACHMENT2);
    gl.readPixels(0, 0, NX, NY, gl.RGBA, gl.FLOAT, macro);
    const IN = sol.IN;
    const U0 = state.U0;
    let mx = 0;
    let cmin = Infinity;
    let cmax = -Infinity;
    for (let y = vy0; y < vy1; y++) {
      for (let x = vx0; x < vx1; x++) {
        const i = y * NX + x;
        if (IN[i]) continue;
        const o = i * 4;
        const s = Math.hypot(macro[o + 2], macro[o + 3]) / U0;
        const cp = (macro[o + 1] - 1) / (1.5 * U0 * U0);
        if (s > mx && s < 4) mx = s;
        if (cp > -6 && cp < 1.2) {
          if (cp < cmin) cmin = cp;
          if (cp > cmax) cmax = cp;
        }
      }
    }
    if (mx > 0) state.maxS = state.maxS * 0.7 + mx * 0.3;
    if (isFinite(cmin)) {
      state.cpMin = state.cpMin * 0.7 + cmin * 0.3;
      state.cpMax = state.cpMax * 0.7 + cmax * 0.3;
    }

    let fx = 0;
    let fy = 0;
    let surf = 0;
    let rev = 0;
    for (let y = 1; y < NY - 1; y++) {
      for (let x = 1; x < NX - 1; x++) {
        const c = y * NX + x;
        if (!IN[c]) continue;
        for (let j = 0; j < 4; j++) {
          const nc = (y + FDY[j]) * NX + x + FDX[j];
          if (IN[nc]) continue;
          const p = macro[nc * 4 + 1] / 3;
          fx -= p * FDX[j];
          fy -= p * FDY[j];
          surf++;
          if (macro[nc * 4 + 2] < 0) rev++;
        }
      }
    }
    if (surf) {
      const q = 0.5 * U0 * U0 * LBM.CHORD_L;
      const CL = fy / q;
      const CD = fx / q;
      if (isFinite(CL) && isFinite(CD)) {
        state.CL = state.CL === null ? CL : state.CL * 0.8 + CL * 0.2;
        state.CD = state.CD === null ? CD : state.CD * 0.8 + CD * 0.2;
      }
      state.sep = state.sep * 0.75 + (rev / surf) * 0.25;
    }
    emitStats();
  }

  const w2cX = (x) => PX + ((x - VX0) / (VX1 - VX0)) * PW;
  const w2cY = (y) => PY + (1 - (y - VY0) / (VY1 - VY0)) * PH;

  function drawFoil() {
    cx.beginPath();
    sol.xp.forEach((x, i) => {
      const px = w2cX(x);
      const py = w2cY(sol.yp[i]);
      if (i) cx.lineTo(px, py);
      else cx.moveTo(px, py);
    });
    cx.closePath();
    cx.fillStyle = "#0D1114";
    cx.fill();
    cx.strokeStyle = "rgba(241, 245, 249, 0.92)";
    cx.lineWidth = 1.4;
    cx.stroke();
  }

  function drawBar() {
    const bx = PX + PW + 8;
    const by = PY;
    const bw = 8;
    const bh = PH;
    const m = state.fieldMode;
    for (let i = 0; i < bh; i++) {
      let r;
      let g;
      let b;
      const t = 1 - i / bh;
      if (m === 1) [r, g, b] = lbmLerp(t, LBM_CP);
      else if (m === 2) {
        const v = 1 - (2 * i) / bh;
        const bg = [13, 17, 20];
        const end = v < 0 ? [38, 128, 250] : [250, 71, 46];
        [r, g, b] = lbmLerp(Math.abs(v), [bg, end]);
      } else if (m === 3) [r, g, b] = lbmLerp(t, [[13, 17, 20], [237, 242, 255]]);
      else [r, g, b] = lbmLerp(t, LBM_SPEED);
      cx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
      cx.fillRect(bx, by + i, bw, 1.5);
    }
    cx.fillStyle = "rgba(226, 232, 240, 0.78)";
    cx.font = "9.5px 'JetBrains Mono', ui-monospace, monospace";
    cx.textAlign = "left";
    let top;
    let bot;
    if (m === 1) {
      top = `Cp ${state.cpMax.toFixed(1)}`;
      bot = `Cp ${state.cpMin.toFixed(1)}`;
    } else if (m === 2) {
      top = `+${LBM.VORT_C} U/c`;
      bot = `-${LBM.VORT_C} U/c`;
    } else if (m === 3) {
      top = "Dense";
      bot = "Clear";
    } else {
      top = `${(state.maxS * 0.92).toFixed(2)}×U`;
      bot = "0.0×U";
    }
    cx.fillText(top, bx + bw + 5, by + 8);
    cx.fillText(bot, bx + bw + 5, by + bh - 1);
  }

  function drawLabels() {
    cx.strokeStyle = "rgba(148, 163, 184, 0.22)";
    cx.lineWidth = 1;
    cx.strokeRect(PX + 0.5, PY + 0.5, PW - 1, PH - 1);

    cx.fillStyle = "rgba(148, 163, 184, 0.72)";
    cx.font = "9.5px 'JetBrains Mono', ui-monospace, monospace";
    cx.textAlign = "center";
    for (const xv of [0, 0.5, 1.0]) cx.fillText(xv.toFixed(1), w2cX(xv), PY + PH + 16);
    cx.textAlign = "right";
    for (const yv of [VY0 * 0.85, 0, VY1 * 0.85]) cx.fillText(yv.toFixed(1), PX - 5, w2cY(yv) + 3);

    const alphaLabel = `α = ${state.aDeg.toFixed(1)}°`;
    cx.font = "600 10.5px 'JetBrains Mono', ui-monospace, monospace";
    const tw = cx.measureText(alphaLabel).width;
    cx.fillStyle = "rgba(13, 17, 20, 0.68)";
    cx.fillRect(PX + 6, PY + 6, tw + 12, 18);
    cx.fillStyle = "rgba(241, 245, 249, 0.94)";
    cx.textAlign = "left";
    cx.fillText(alphaLabel, PX + 12, PY + 18.5);
  }

  function drawFallback() {
    cx.fillStyle = "#0D1114";
    cx.fillRect(0, 0, W, H);
    cx.fillStyle = "rgba(241, 245, 249, 0.85)";
    cx.font = "13px 'Quicksand', system-ui, sans-serif";
    cx.textAlign = "center";
    cx.fillText("WebGL2 with floating-point render targets is required for the 2D tunnel.", W / 2, H / 2 - 8);
    cx.font = "11px 'Quicksand', system-ui, sans-serif";
    cx.fillStyle = "rgba(148, 163, 184, 0.7)";
    cx.fillText(err || "Your browser or GPU driver does not support it.", W / 2, H / 2 + 12);
  }

  function renderFrame(steps) {
    cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!ok) {
      drawFallback();
      return;
    }
    if (steps > 0) {
      for (let s = 0; s < steps; s++) stepPass();
      dyePass(steps);
      state.frame++;
      if (state.frame % 12 === 0) readStats();
    }
    displayPass();
    cx.fillStyle = "#0D1114";
    cx.fillRect(0, 0, W, H);
    cx.save();
    cx.beginPath();
    cx.rect(PX, PY, PW, PH);
    cx.clip();
    cx.imageSmoothingEnabled = true;
    cx.imageSmoothingQuality = "high";
    cx.drawImage(glcv, PX, PY, PW, PH);
    drawFoil();
    cx.restore();
    drawBar();
    drawLabels();
  }

  // Adaptive animation loop
  const MIN_STEPS = 2;
  const MAX_STEPS = 48;
  let steps = 10;
  let boost = 0;
  let last = null;
  let refresh = 16.7;
  let slowFrames = 0;
  const recent = [];
  let rafId = 0;
  let stopped = false;
  let lastReportedSteps = -1;

  const triggerBoost = (n) => {
    boost = Math.max(boost, Math.min(n, 40));
  };

  function loop(t) {
    if (stopped) return;
    const dt = last === null ? 16.7 : t - last;
    last = t;
    if (!state.paused && dt > 0 && dt < 200) {
      recent.push(dt);
      if (recent.length > 90) recent.shift();
      refresh = Math.max(6.5, Math.min(...recent));
      if (boost < 1) {
        if (dt > refresh * 1.45) {
          slowFrames++;
          if (slowFrames >= 3) {
            steps = Math.max(MIN_STEPS, Math.floor(steps * 0.85));
            slowFrames = 0;
          }
        } else {
          slowFrames = 0;
          if (dt < refresh * 1.2) steps = Math.min(MAX_STEPS, steps + 0.5);
        }
      }
    }
    const n = state.paused ? 0 : Math.round(steps + boost);
    if (!state.paused) boost = boost > 1 ? boost * 0.96 : 0;
    renderFrame(n);
    const rSteps = Math.round(steps);
    if (rSteps !== lastReportedSteps) {
      lastReportedSteps = rSteps;
      onSteps?.(rSteps);
    }
    rafId = requestAnimationFrame(loop);
  }
  rafId = requestAnimationFrame(loop);
  emitStats();

  return {
    setAlpha(a) {
      applyGeometry(a);
      triggerBoost(30);
    },
    setU0(u) {
      state.U0 = u;
      triggerBoost(40);
      emitStats();
    },
    setField(modeIdx) {
      state.fieldMode = modeIdx;
    },
    setCoords(coords, name) {
      baseCoords = coords && coords.length > 2 ? coords : lbmNaca4(0, 4, 12, 60);
      if (name) foilName = name;
      applyGeometry(state.aDeg);
      triggerBoost(30);
    },
    setPaused(paused) {
      state.paused = Boolean(paused);
    },
    resetFlow() {
      if (ok) populateLattice();
      triggerBoost(30);
    },
    savePng() {
      const aoa = state.aDeg.toFixed(1);
      const nm = (foilName || "airfoil").replace(/\.(dat|txt)$/i, "").replace(/\s+/g, "_");
      canvas.toBlob((blob) => {
        if (!blob) return;
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `${nm}_alpha${aoa}deg_2d_tunnel.png`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      }, "image/png");
    },
    getCoords: () => baseCoords,
    destroy() {
      stopped = true;
      cancelAnimationFrame(rafId);
      if (gl) {
        createdFbos.forEach((f) => gl.deleteFramebuffer(f));
        createdTextures.forEach((t) => gl.deleteTexture(t));
        createdPrograms.forEach((p) => gl.deleteProgram(p));
        gl.getExtension("WEBGL_lose_context")?.loseContext();
      }
    },
  };
}
