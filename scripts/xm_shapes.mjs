// 从仓库里已有的 js/geo_xm.js 推导厦门图的历史边界形状（不抓任何 OSM）。
//
// 背景：data_xm.js 早期用「经纬度矩形」近似 4 个片区与 11 组填海的范围。矩形会横跨海岸线——
// 未开放时看着像一块直角方块压在陆地和海面之间，填海区还会被画成一块纯蓝的矩形水面。
// 这里把每个矩形换成「原近似范围 ∩ 现代陆地（OSM 岸线）」的折线：边界沿海岸线走。
//
// 用法（在仓库根目录）：
//   node scripts/xm_shapes.mjs            # 打印每个形状的格数与顶点数 + 可直接粘贴的 JS 字面量
//   node scripts/xm_shapes.mjs --json x   # 只把字面量写成 JSON（给批量改 data_xm.js 的脚本用）
//
// 约定：坐标单位仍是格（250 m/格，原点左上，x 东 y 南），与 geo_xm.js 一致，不改坐标语义。
import { readFileSync, writeFileSync } from 'node:fs';

// ── 载入 geo_xm.js + geo.js（浏览器文件，用最小 window/CM 桩）───────────────
const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const read = (p) => readFileSync(ROOT + p, 'utf8');
const CM = { U: { clamp: (v, a, b) => (v < a ? a : v > b ? b : v) } };
const window = { CM };
new Function('window', read('js/geo_xm.js'))(window);
const G = CM.GEOS.xm;
CM.CFG = { W: 208, H: 164 };
CM.GEO = G;
new Function('window', read('js/geo.js'))(window);
const Geo = CM.Geo.init();

const W = 208, H = 164;
const S = 8;                       // 每格子格数（31 m）
const FW = W * S, FH = H * S;

// 现代水域掩膜（与 city.js buildWater 同参数）→ 陆地掩膜
const wm = new Uint8Array(FW * FH);
Geo.fill(wm, FW, FH, S, Geo.water, () => 1);
Geo.waterLines.forEach((l) => Geo.stroke(wm, FW, FH, S, l.p, Math.max(l.w / 2, 0.025), 1));
const land = new Uint8Array(FW * FH);
for (let i = 0; i < land.length; i++) if (!wm[i]) land[i] = 1;

// ── 投影 / 小工具 ───────────────────────────────────────────────────────
const P = G.proj;
const ll = (lon, lat) => [+((lon - P.lon0) * P.kx).toFixed(2), +((P.lat0 - lat) * P.ky).toFixed(2)];
const rectLL = (n, s, w, e) => [[w, n], [e, n], [e, s], [w, s]].map((p) => ll(p[0], p[1]));
const box = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const flat = (a, out) => { out = out || []; for (const v of a) { if (Array.isArray(v)) flat(v, out); else out.push(v); } return out; };
const featRings = (f) => f.rings.map((r) => { const o = []; for (let k = 0; k + 1 < r.p.length; k += 2) o.push([r.p[k], r.p[k + 1]]); return o; });
const r2 = (v) => +v.toFixed(2);

function rasterize(polys) {
  const m = new Uint8Array(FW * FH);
  const feats = polys.map((pl) => { const p = new Float32Array(flat(pl, [])); return { rings: [{ outer: true, p }], bbox: Geo.bbox(p) }; });
  Geo.fill(m, FW, FH, S, feats, () => 1);
  return m;
}
function and(a, b) { const o = new Uint8Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] & b[i]; return o; }
function dilate(m, r) {
  const tmp = new Uint8Array(m.length), out = new Uint8Array(m.length);
  for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) {
    if (!m[y * FW + x]) continue;
    for (let k = Math.max(0, x - r); k <= Math.min(FW - 1, x + r); k++) tmp[y * FW + k] = 1;
  }
  for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) {
    if (!tmp[y * FW + x]) continue;
    for (let k = Math.max(0, y - r); k <= Math.min(FH - 1, y + r); k++) out[k * FW + x] = 1;
  }
  return out;
}
const erode = (m, r) => { const inv = new Uint8Array(m.length); for (let i = 0; i < m.length; i++) inv[i] = m[i] ? 0 : 1; return dilate(inv, r).map((v) => (v ? 0 : 1)); };
const closeMask = (m, r) => erode(dilate(m, r), r);

function components(m) {
  const seen = new Uint8Array(m.length), out = [], st = [];
  for (let i0 = 0; i0 < m.length; i0++) {
    if (!m[i0] || seen[i0]) continue;
    const cells = []; st.length = 0; st.push(i0); seen[i0] = 1;
    while (st.length) {
      const i = st.pop(); cells.push(i);
      const x = i % FW, y = (i / FW) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= FW || ny >= FH) continue;
        const k = ny * FW + nx;
        if (m[k] && !seen[k]) { seen[k] = 1; st.push(k); }
      }
    }
    out.push(cells);
  }
  out.sort((a, b) => b.length - a.length);
  return out;
}
// Moore 邻域轮廓追踪（只走外轮廓）
function trace(cells) {
  const set = new Set(cells);
  const has = (x, y) => x >= 0 && y >= 0 && x < FW && y < FH && set.has(y * FW + x);
  let sx = 1e9, sy = 1e9;
  for (const i of cells) { const x = i % FW, y = (i / FW) | 0; if (y < sy || (y === sy && x < sx)) { sy = y; sx = x; } }
  const dirs = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  const ring = []; let x = sx, y = sy, d = 6;
  const startKey = y * FW + x;
  for (let guard = 0; guard < 4 * cells.length + 16; guard++) {
    ring.push([x, y]);
    let found = -1;
    for (let k = 0; k < 8; k++) {
      const nd = (d + 6 + k) % 8;
      const nx = x + dirs[nd][0], ny = y + dirs[nd][1];
      if (has(nx, ny)) { found = nd; x = nx; y = ny; d = nd; break; }
    }
    if (found < 0) break;
    if (y * FW + x === startKey && ring.length > 2) break;
  }
  return ring;
}
// Chaikin 平滑（闭合环）：把 31 m 的台阶磨成斜边
function chaikin(pts, iters) {
  let p = pts;
  for (let it = 0; it < iters; it++) {
    const out = [];
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      out.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]]);
      out.push([0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
    }
    p = out;
  }
  return p;
}
function rdpOpen(pts, eps) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let best = -1, bd = eps;
    const ax = pts[a][0], ay = pts[a][1], bx = pts[b][0], by = pts[b][1];
    const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1e-9;
    for (let k = a + 1; k < b; k++) {
      const d = Math.abs((pts[k][0] - ax) * dy - (pts[k][1] - ay) * dx) / L;
      if (d > bd) { bd = d; best = k; }
    }
    if (best > 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  const out = [];
  for (let k = 0; k < pts.length; k++) if (keep[k]) out.push(pts[k]);
  return out;
}
function rdp(pts, eps) {
  const n = pts.length;
  if (n < 5) return pts;
  let m = 1, far = -1;
  for (let k = 1; k < n; k++) {
    const d = Math.hypot(pts[k][0] - pts[0][0], pts[k][1] - pts[0][1]);
    if (d > far) { far = d; m = k; }
  }
  const a = rdpOpen(pts.slice(0, m + 1), eps);
  const b = rdpOpen(pts.slice(m).concat([pts[0]]), eps);
  return a.concat(b.slice(1, -1));
}
function maskToPolys(mask, minSub, eps) {
  const comps = components(mask).filter((c) => c.length >= minSub);
  const out = [];
  for (const comp of comps) {
    const ring = trace(comp);
    if (ring.length < 4) continue;
    const sm = chaikin(ring.map(([x, y]) => [x / S, y / S]), 2);
    const sp = rdp(sm, eps == null ? 0.07 : eps);
    if (sp.length >= 3) out.push(sp.map(([x, y]) => [r2(x), r2(y)]));
  }
  return out;
}
// 形状统计：覆盖到的陆地格 / 海面格（格按 50% 覆盖率计）
function stats(polys) {
  const m = rasterize(polys);
  let landN = 0, seaN = 0;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    let c = 0, l = 0;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const k = (j * S + y) * FW + i * S + x;
      if (m[k]) { c++; if (land[k]) l++; }
    }
    if (c >= 32) { if (l >= c / 2) landN++; else seaN++; }
  }
  return { land: landN, sea: seaN };
}

const out = {};
function build(key, seeds, o) {
  o = o || {};
  let m = rasterize(seeds);
  if (o.dilate) m = dilate(m, o.dilate);
  m = closeMask(and(m, land), 1);
  if (o.mask) m = and(m, o.mask);
  const polys = maskToPolys(m, o.minSub || 64, o.eps);
  const st = stats(polys);
  out[key] = { polys, ...st, verts: polys.reduce((a, p) => a + p.length, 0) };
  console.log(`${key.padEnd(24)} 陆地 ${String(st.land).padStart(4)} 格 · 海面 ${String(st.sea).padStart(3)} 格 · ${String(polys.length).padStart(2)} 环 · ${out[key].verts} 点`);
  return out[key];
}

// ── 4 个片区 ────────────────────────────────────────────────────────────
build('dongdu', [rectLL(24.4995, 24.4825, 118.0640, 118.0810)], { minSub: 128 });
const wuyWater = Geo.water.filter((f) => f.name === '五缘湾');
build('wuyuanwan', wuyWater.map(featRings), { dilate: 22, minSub: 128 });
build('xa_air', [box(184, 94, 206, 109)], { minSub: 128 });
// 角美：龙海区（角美所在行政区）在图内西缘的部分，边界即行政界
const lh = Geo.admin.filter((f) => f.name === '龙海区').map(featRings);
const jmPolys = maskToPolys(and(and(rasterize(lh), rasterize([[box(-1, 88, 44, 143)]])), land), 256, 0.1);
out.jiaomei = { polys: jmPolys, ...stats(jmPolys), verts: jmPolys.reduce((a, p) => a + p.length, 0) };
console.log(`jiaomei                  陆地 ${String(out.jiaomei.land).padStart(4)} 格 · 海面 ${String(out.jiaomei.sea).padStart(3)} 格 · ${String(jmPolys.length).padStart(2)} 环 · ${out.jiaomei.verts} 点`);

// ── 3 个「街道名与 OSM 对不上」的片区：改用街道界多边形 ─────────────
// 2021 年厦门撤镇设街道：新民镇→新民街道、西柯镇→西柯街道、马巷镇→马巷街道、新店镇→新店街道。
// data_xm.js 里写的是旧名（1990 年口径），OSM 的 admin_level=8 是现名，于是 city.js 按名字匹配不上，
// 这三个片区整片掉进「外围」。这里直接取现名街道的多边形，既不依赖名字表，也就不会随 OSM 改名再坏。
function streetsPoly(keys) {
  const feats = Geo.admin.filter((f) => keys.indexOf(f.name) >= 0).map(featRings);
  if (!feats.length) { console.log('!! 没有找到街道：' + keys.join('、')); return []; }
  return maskToPolys(closeMask(and(rasterize(feats), land), 1), 128, 0.08);
}
for (const [key, ks] of [['tongan_ind', ['新民街道', '西柯街道']], ['xindian', ['新店街道']], ['maxiang_mx', ['马巷街道']]]) {
  const polys = streetsPoly(ks);
  out[key] = { polys, ...stats(polys), verts: polys.reduce((a, p) => a + p.length, 0) };
  console.log(`${key.padEnd(24)} 陆地 ${String(out[key].land).padStart(4)} 格 · 海面 ${String(out[key].sea).padStart(3)} 格 · ${String(polys.length).padStart(2)} 环 · ${out[key].verts} 点（${ks.join('+')}）`);
}

// ── 11 组填海（每项只保留最大的一环：city.js 的 reclaim 只支持单环）────────
const RC = [
  ['rl06', 24.5045, 24.4940, 118.0660, 118.0800],
  ['rl07', 24.5245, 24.5120, 118.0825, 118.0975],
  ['rl08', 24.4720, 24.4470, 118.0280, 118.0470],
  ['rl09', 24.4480, 24.4270, 118.0180, 118.0330],
  ['rl10', 24.5450, 24.5280, 118.1670, 118.1860],
  ['rl11', 24.5005, 24.4840, 118.1800, 118.1980],
  ['rl12', 24.5990, 24.5760, 118.0560, 118.0760],
  ['rl13', 24.6420, 24.6100, 118.1120, 118.1520],
  ['rl14', 24.5760, 24.5480, 118.1760, 118.2180],
  ['rl15', 24.5620, 24.5310, 118.3240, 118.3600],
  ['rl16', 24.5620, 24.5280, 118.3560, 118.3800],
];
for (const [k, n, s, w, e] of RC) {
  const polys = maskToPolys(closeMask(and(rasterize([rectLL(n, s, w, e)]), land), 1), 128, 0.08);
  const big = polys[0] || [];
  const st = stats([big]);
  out[k] = { poly: big, ...st, rings: polys.length, dropped: polys.length - 1 };
  console.log(`${k.padEnd(24)} 陆地 ${String(st.land).padStart(4)} 格 · 海面 ${String(st.sea).padStart(3)} 格 · ${big.length} 点${polys.length > 1 ? `（丢弃 ${polys.length - 1} 个碎片）` : ''}`);
}

// ── 输出 ────────────────────────────────────────────────────────────────
const fmt = (pl) => {
  const parts = pl.map(([x, y]) => `[${x}, ${y}]`);
  const lines = [];
  for (let i = 0; i < parts.length; i += 5) lines.push('    ' + parts.slice(i, i + 5).join(', ') + (i + 5 < parts.length ? ',' : ''));
  return '[\n' + lines.join('\n') + '\n  ]';
};
const literals = {};
for (const k in out) {
  const e = out[k];
  if (e.poly) literals[k] = fmt(e.poly);                        // 填海：单环
  else if (e.polys.length === 1) literals[k] = fmt(e.polys[0]);  // 片区：单环
  else literals[k] = '[\n' + e.polys.map((pl) => '    ' + fmt(pl)).join(',\n') + '\n  ]';   // 片区：多环
}
const jf = process.argv.indexOf('--json');
if (jf > 0 && process.argv[jf + 1]) {
  writeFileSync(process.argv[jf + 1], JSON.stringify({ literals, stats: out }, null, 1));
  console.log('\n字面量已写入 ' + process.argv[jf + 1]);
} else {
  for (const k in literals) console.log(`\n// ${k}\nconst ${k} = ${literals[k]};`);
}
