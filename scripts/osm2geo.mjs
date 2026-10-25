#!/usr/bin/env node
'use strict';
/**
 * scripts/osm2geo.mjs — 《城市与地铁》厦门地图（code = xm）geo 数据生成器
 *
 * 数据来源：OpenStreetMap（© OpenStreetMap 贡献者，ODbL 1.0）
 * 流程：Overpass 抓取 → 按 OSM id 去重 → 图层分类 → 投影到游戏格 → 裁剪 → Douglas–Peucker 简化
 *       → 1/64 格量化 → 增量编码（与 js/geo.js 的 dec() 严格互逆）→ 输出 IIFE 到 js/geo_xm.js
 *
 * 用法：
 *   node scripts/osm2geo.mjs                 # 用本地原始数据重建 js/geo_xm.js
 *   node scripts/osm2geo.mjs --fetch         # 先抓取缺失的原始 JSON（需要 curl.exe 出网）
 *   node scripts/osm2geo.mjs --raw=<目录>     # 指定原始 JSON 目录（含 q/ 子目录或直接 *.json）
 *   node scripts/osm2geo.mjs --out=<文件>     # 指定输出文件
 *   node scripts/osm2geo.mjs --stats=<文件>   # 额外把统计写成 JSON（供验收报告引用）
 *
 * 本机备注：Node 内置 fetch 连不上 overpass-api.de（TLS/代理层），故抓取阶段统一用 curl.exe。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

// ═════════════════════════════════ 1. 参数（改这里就够） ═════════════════════════════════
const CFG = {
  code: 'xm',
  city: '厦门',
  outFile: 'js/geo_xm.js',

  // 网格与投影：x 向东、y 向南，左上原点；单位=格（CELL_M 米）
  W: 208, H: 164, CELL_M: 250,          // 52 km × 41 km
  proj: { lon0: 117.870, lat0: 24.775, kx: 404.54, ky: 443.00 },
  bufferKm: 2,                          // 抓取时四周各加 2 km 缓冲（保证岸线/桥头完整）
  grid: { cols: 3, rows: 3, overlapDeg: 0.01 },   // Overpass 分块（块间重叠，最后按 OSM id 去重）

  // 简化：单位 = 1 个编码单位 = 1/64 格 ≈ 3.9 m
  simplify: { poly: 1.0, sea: 0.1, line: 1.0, street: 2.0, rail: 1.0 },   // 单位：格（sea 0.1 格 = 25 m，海岸线要保形）
  // 按名称覆盖简化容差（单位：格，绝对值；不参与下方预算轮次的整体放大，保证重跑结果恒定）
  // 背景：poly 1.0 格 = 250 m，对 1–2 km 的小水体过粗——Douglas–Peucker 会把整片湖抽成 4–6 个点的
  // 折线块（湖边水库原本只剩 6 点：一个三角 + 一条细长尾巴，完全没有湖岸弯曲）。
  // 这里对地标水体单独指定容差，取值与海岸线同档（0.1–0.15 格 = 25–37 m），顶点数落在同图层水库的 20–90 区间。
  // 只收「玩家视野内、且原始 OSM 有 30 点以上」的水体；金门侧与同名不同体的（慈湖/水头商港/石兜/九溪/西溪/西湖）待人工确认后再加。
  simplifyByName: {
    '湖边水库': 0.1,
    '五缘湾': 0.15,
    '马銮湾': 0.15,
    '坂头水库': 0.15,
    '石壁水库': 0.15,
    '后井水库': 0.15,
    '苏内水库': 0.15,
  },
  minRingPoints: 4,
  minRingAreaKm2: 0.02,                 // 闭合环面积阈值（≈0.32 格²）

  // 海面：coastline → 栅格洪水填充（水在岸线右侧）→ 边界追踪 → 简化
  sea: { pxPerCell: 24, seedOffsetPx: 2 },   // 24 px/格 ≈ 10.4 m

  // 预算（验收线）
  budget: { maxVerts: 200000, maxBytes: 1500000, decodeMs: 40 },

  // 抓取
  ua: 'city-metro-research/1.0',
  endpoints: [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
  ],
  rawDir: path.join(os.tmpdir(), 'osm2geo-xm'),
};

// 名称归一：OSM 里同一实体常有带英文/括号/繁体的写法，这里强制成简体纯名
const NAME_ALIAS = {
  '厦门跨海大桥': '厦门大桥', '厦门大桥（跨海）': '厦门大桥',
  '海沧跨海大桥': '海沧大桥', '海沧大桥（东渡）': '海沧大桥',
  '集美跨海大桥': '集美大桥', '杏林跨海大桥': '杏林大桥',
  '翔安海底隧道': '翔安隧道', '厦门翔安海底隧道': '翔安隧道',
  '海沧海底隧道': '海沧隧道', '海沧海底隧道（第二西通道）': '海沧隧道',
};
// 常见繁体 → 简体（OSM 里金门/厦门湾一带仍有繁体 name）
const HANT2HANS = {
  廈: '厦', 門: '门', 灣: '湾', 潯: '浔', 頭: '头', 圍: '围', 羅: '罗', 島: '岛', 嶼: '屿',
  崗: '岗', 雙: '双', 鯉: '鲤', 蓮: '莲', 蘭: '兰', 莒: '莒', 陽: '阳', 厙: '库', 習: '习',
  學: '学', 東: '东', 區: '区', 鎮: '镇', 橋: '桥', 線: '线', 鐵: '铁', 路: '路', 縣: '县',
  後: '后', 里: '里', 龍: '龙', 鳳: '凤', 龜: '龟', 鹽: '盐', 舊: '旧', 關: '关', 慶: '庆',
  興: '兴', 豐: '丰', 華: '华', 廬: '庐', 嶽: '岳', 雲: '云', 霧: '雾', 馬: '马', 鳥: '鸟',
  黃: '黄', 點: '点', 龍: '龙', 龜: '龟', 廟: '庙', 莊: '庄', 營: '营', 陳: '陈', 鄭: '郑',
  劉: '刘', 張: '张', 楊: '杨', 趙: '赵', 吳: '吴', 許: '许', 謝: '谢', 蘇: '苏', 葉: '叶',
  錦: '锦', 鏡: '镜', 鍾: '钟', 鐘: '钟', 灘: '滩', 澳: '澳', 溝: '沟', 滬: '沪', 淺: '浅',
  灘: '滩', 沖: '冲', 淨: '净', 澗: '涧', 瀝: '沥', 濾: '滤', 濱: '滨', 瀘: '泸', 瀟: '潇',
  潛: '潜', 澀: '涩', 澆: '浇', 澳: '澳', 濃: '浓', 濟: '济', 濤: '涛', 瀨: '濑', 瀰: '弥',
  巖: '岩', 嶺: '岭', 峽: '峡', 崙: '仑', 崠: '岽', 嵐: '岚', 嶗: '崂', 嶼: '屿', 巔: '巅',
  寧: '宁', 鄉: '乡', 員: '员', 義: '义', 親: '亲', 眾: '众', 麗: '丽', 鑽: '钻', 鐵: '铁',
  // 金门/周边村落常见的剩余繁体字（实测 names/places 里出现过）
  庫: '库', 瓊: '琼', 膽: '胆', 復: '复', 檳: '槟', 槳: '桨', 裡: '里', 隻: '只', 週: '周',
  廠: '厂', 廣: '广', 應: '应', 產: '产', 業: '业', 農: '农', 觀: '观', 見: '见', 貝: '贝',
  車: '车', 魚: '鱼', 電: '电', 氣: '气', 醫: '医', 場: '场', 號: '号', 處: '处', 衛: '卫',
  裝: '装', 規: '规', 視: '视', 計: '计', 訂: '订', 記: '记', 設: '设', 證: '证', 評: '评',
  試: '试', 話: '话', 認: '认', 說: '说', 調: '调', 談: '谈', 請: '请', 論: '论', 講: '讲',
  識: '识', 議: '议', 護: '护', 讀: '读', 變: '变', 費: '费', 資: '资', 貿: '贸', 質: '质',
  購: '购', 賽: '赛', 贊: '赞', 趕: '赶', 跡: '迹', 軍: '军', 較: '较', 載: '载', 輛: '辆',
  轉: '转', 辦: '办', 這: '这', 連: '连', 遊: '游', 運: '运', 過: '过', 達: '达', 遠: '远',
  選: '选', 邊: '边', 郵: '邮', 鉤: '钩', 銀: '银', 銅: '铜', 銷: '销', 鋼: '钢', 錄: '录',
  錢: '钱', 錫: '锡', 鍵: '键', 鏈: '链', 陣: '阵', 陸: '陆', 際: '际', 隊: '队', 階: '阶',
  隨: '随', 險: '险', 雞: '鸡', 離: '离', 難: '难', 電: '电', 靜: '静', 響: '响', 頁: '页',
  頂: '顶', 項: '项', 順: '顺', 須: '须', 預: '预', 領: '领', 頌: '颂', 頻: '频', 題: '题',
  顏: '颜', 願: '愿', 類: '类', 顧: '顾', 風: '风', 飛: '飞', 飯: '饭', 飲: '饮', 館: '馆',
  駐: '驻', 驗: '验', 體: '体', 髮: '发', 鬥: '斗', 麗: '丽', 點: '点', 黨: '党', 齒: '齿',
  業: '业', 產: '产', 農: '农', 開: '开', 閉: '闭', 間: '间', 閱: '阅', 階: '阶', 際: '际',
  陳: '陈', 陽: '阳', 陰: '阴', 隊: '队', 陸: '陆', 險: '险', 隨: '随', 雙: '双', 雜: '杂',
  雞: '鸡', 離: '离', 難: '难', 電: '电', 需: '需', 靜: '静', 韓: '韩', 順: '顺', 須: '须',
};
// 水系线宽（格）：实测五图出现的宽度集合 {0.024,0.032,0.048,0.06,0.088,0.192,0.244,0.28}
const WATER_LINE_W = { river: 0.088, canal: 0.06, stream: 0.032, drain: 0.024 };

// ═════════════════════════════════ 2. 命令行 ═════════════════════════════════
const ARGV = process.argv.slice(2);
const has = (k) => ARGV.includes('--' + k);
const opt = (k, d) => { const a = ARGV.find((x) => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
CFG.rawDir = opt('raw', CFG.rawDir);
CFG.outFile = opt('out', CFG.outFile);

const P = CFG.proj;
const BB = {
  w: P.lon0, n: P.lat0,
  e: P.lon0 + CFG.W / P.kx,
  s: P.lat0 - CFG.H / P.ky,
};
const BUF_LAT = CFG.bufferKm / 110.9;
const BUF_LON = CFG.bufferKm / (111.32 * Math.cos(((BB.n + BB.s) / 2) * Math.PI / 180));
const EXT = { w: BB.w - BUF_LON, e: BB.e + BUF_LON, s: BB.s - BUF_LAT, n: BB.n + BUF_LAT };

const f6 = (v) => v.toFixed(6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ═════════════════════════════════ 3. Overpass 抓取（curl.exe） ═════════════════════════════════
const QL_LAYER = {
  w: (b) => `[out:json][timeout:300][bbox:${b}];
(
  way["natural"="water"];
  relation["natural"="water"];
  way["landuse"="reservoir"];
  relation["landuse"="reservoir"];
  way["natural"="bay"];
  relation["natural"="bay"];
  way["waterway"~"^(river|canal|stream|drain)$"];
);
out geom;`,
  r: (b) => `[out:json][timeout:300][bbox:${b}];
(
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|motorway_link|trunk_link|primary_link|secondary_link)$"];
  way["highway"="service"]["service"!~"^(parking_aisle|driveway|emergency_access|alley|parking)$"];
  way["highway"~"^(residential|unclassified|living_street|tertiary_link)$"];
  way["railway"~"^(rail|light_rail|highspeed)$"];
);
out geom;`,
  g: (b) => `[out:json][timeout:300][bbox:${b}];
(
  way["leisure"~"^(park|garden)$"];
  relation["leisure"~"^(park|garden)$"];
  way["boundary"="protected_area"];
  relation["boundary"="protected_area"];
  way["leisure"="nature_reserve"];
  relation["leisure"="nature_reserve"];
  way["landuse"="forest"];
  relation["landuse"="forest"];
  way["natural"="wood"];
  relation["natural"="wood"];
);
out geom;`,
};
const QL_GLOBAL = {
  coastline: `[out:json][timeout:300][bbox:${f6(EXT.s)},${f6(EXT.w)},${f6(EXT.n)},${f6(EXT.e)}];
way["natural"="coastline"];
out geom;`,
  admin: `[out:json][timeout:300][bbox:${f6(EXT.s)},${f6(EXT.w)},${f6(EXT.n)},${f6(EXT.e)}];
relation["boundary"="administrative"]["admin_level"~"^(6|8)$"];
out geom;`,
  places: `[out:json][timeout:300][bbox:${f6(EXT.s)},${f6(EXT.w)},${f6(EXT.n)},${f6(EXT.e)}];
(
  node["place"~"^(city|town|suburb|quarter|village|hamlet|neighbourhood|island|islet)$"];
  node["railway"="station"];
  node["public_transport"="station"];
);
out;`,
};

function planJobs() {
  const jobs = [];
  const { cols, rows, overlapDeg } = CFG.grid;
  const dw = (EXT.e - EXT.w) / cols, dh = (EXT.n - EXT.s) / rows;
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const b = [Math.max(EXT.s, EXT.s + j * dh - overlapDeg), Math.max(EXT.w, EXT.w + i * dw - overlapDeg),
      Math.min(EXT.n, EXT.s + (j + 1) * dh + overlapDeg), Math.min(EXT.e, EXT.w + (i + 1) * dw + overlapDeg)]
      .map(f6).join(',');
    for (const k of Object.keys(QL_LAYER)) jobs.push({ name: `${k}_${i}_${j}`, ql: QL_LAYER[k](b) });
  }
  for (const [name, ql] of Object.entries(QL_GLOBAL)) jobs.push({ name, ql });
  return jobs;
}

function writeFetchPlan(rawDir) {
  const qd = path.join(rawDir, 'q');
  fs.mkdirSync(qd, { recursive: true });
  const jobs = planJobs();
  const cfgLines = [];
  for (const job of jobs) {
    const qf = path.join(qd, job.name + '.ql').replace(/\\/g, '/');
    fs.writeFileSync(qf, job.ql, 'utf8');
    cfgLines.push(
      `url = "${CFG.endpoints[0]}"`, 'get',
      `-A "${CFG.ua}"`, '--compressed', '--max-time 600',
      `--data-urlencode "data@${qf}"`,
      `-o "${path.join(rawDir, job.name + '.json').replace(/\\/g, '/')}"`,
      'next');
  }
  cfgLines.pop();
  const cfgPath = path.join(rawDir, 'curl.cfg');
  fs.writeFileSync(cfgPath, cfgLines.join('\n') + '\n', 'utf8');
  return { jobs, cfgPath };
}

async function stageFetch() {
  const { jobs, cfgPath } = writeFetchPlan(CFG.rawDir);
  const missing = jobs.filter((j) => {
    const f = path.join(CFG.rawDir, j.name + '.json');
    return !(fs.existsSync(f) && fs.statSync(f).size > 500);
  });
  console.log(`[fetch] 计划 ${jobs.length} 个请求，缺失 ${missing.length} 个 → ${CFG.rawDir}`);
  if (!missing.length) return;
  // 重试：整批跑 3 轮，每轮之间退避（Overpass 会 429/504）
  for (let round = 1; round <= 3; round++) {
    console.log(`[fetch] 第 ${round} 轮（curl --parallel 4）`);
    try {
      execFileSync(process.platform === 'win32' ? 'curl.exe' : 'curl',
        ['-sS', '-K', cfgPath, '--parallel', '--parallel-max', '4'], { stdio: 'inherit' });
    } catch (e) {
      console.log('[fetch] curl 退出码非 0：', e.status);
    }
    const still = jobs.filter((j) => {
      const f = path.join(CFG.rawDir, j.name + '.json');
      return !(fs.existsSync(f) && fs.statSync(f).size > 500);
    });
    console.log(`[fetch] 仍缺 ${still.length} 个`);
    if (!still.length) return;
    await sleep(15000 * round);
  }
}

// ═════════════════════════════════ 4. 读原始数据 ═════════════════════════════════
function loadRaw(rawDir) {
  // 只认真正的 JSON：失败的抓取块会落成 HTML 错误页（如 "# 502 Gateway Timeout"），必须先按首字符挡掉
  const all = fs.readdirSync(rawDir).filter((f) => f.endsWith('.json')).sort();
  const files = all.filter((f) => !/^probe/i.test(f));          // probe_* 是调试样本，正式跑排除
  const skippedProbe = all.length - files.length;
  const byId = new Map();
  const badFiles = [];
  const dup = new Set();
  for (const f of files) {
    const raw = fs.readFileSync(path.join(rawDir, f), 'utf8');
    const head = raw.trimStart().slice(0, 1);
    if (head !== '{' && head !== '[') {
      badFiles.push({ file: f, reason: 'not-json', head: raw.trim().split(/\r?\n/)[0].slice(0, 80) });
      continue;
    }
    let j;
    try { j = JSON.parse(raw); } catch (e) {
      badFiles.push({ file: f, reason: 'parse-error', head: String(e.message).slice(0, 80) });
      continue;
    }
    const els = j.elements;
    if (!Array.isArray(els)) { badFiles.push({ file: f, reason: 'no-elements' }); continue; }
    for (const el of els) {
      if (!el || !el.type || el.id == null) continue;
      const key = el.type[0] + el.id;              // w123 / r456 / n789（块间重叠 → 按 id 去重）
      if (byId.has(key)) { dup.add(key); continue; }
      byId.set(key, el);
    }
  }
  return { byId, files: files.length, skippedProbe, badFiles, dupIds: dup.size };
}

// ═════════════════════════════════ 5. 几何工具 ═════════════════════════════════
const projX = (lon) => (lon - P.lon0) * P.kx;
const projY = (lat) => (P.lat0 - lat) * P.ky;
const Q = 64;                                     // 1/64 格
const qz = (v) => Math.round(v * Q);

// 折线裁剪（Liang–Barsky，逐段），返回若干条子折线
function clipPolyline(pts) {
  const out = [];
  let cur = null;
  for (let i = 0; i + 1 < pts.length; i++) {
    const seg = clipSeg(pts[i], pts[i + 1]);
    if (!seg) { cur = null; continue; }
    const [a, b] = seg;
    if (cur && cur[cur.length - 1][0] === a[0] && cur[cur.length - 1][1] === a[1]) cur.push(b);
    else { cur = [a, b]; out.push(cur); }
  }
  return out.filter((p) => p.length >= 2);
}
function clipSeg(a, b) {
  let t0 = 0, t1 = 1;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const p = [-dx, dx, -dy, dy], q = [a[0], CFG.W - a[0], a[1], CFG.H - a[1]];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) { if (q[i] < 0) return null; continue; }
    const r = q[i] / p[i];
    if (p[i] < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
    else { if (r < t0) return null; if (r < t1) t1 = r; }
  }
  return [[a[0] + t0 * dx, a[1] + t0 * dy], [a[0] + t1 * dx, a[1] + t1 * dy]];
}
// 闭合环保留（Sutherland–Hodgman，对矩形裁剪）
function clipRing(ring) {
  const edges = [
    { axis: 0, v: 0, keep: (p) => p[0] >= 0 },
    { axis: 0, v: CFG.W, keep: (p) => p[0] <= CFG.W },
    { axis: 1, v: 0, keep: (p) => p[1] >= 0 },
    { axis: 1, v: CFG.H, keep: (p) => p[1] <= CFG.H },
  ];
  let out = ring;
  for (const e of edges) {
    const res = [];
    for (let i = 0; i < out.length; i++) {
      const cur = out[i], prv = out[(i + out.length - 1) % out.length];
      const cin = e.keep(cur), pin = e.keep(prv);
      if (cin) { if (!pin) res.push(cut(prv, cur, e)); res.push(cur); }
      else if (pin) res.push(cut(prv, cur, e));
    }
    out = res;
    if (out.length < 3) return null;
  }
  return out.length >= 3 ? out : null;
}
function cut(a, b, e) {
  const t = (e.v - a[e.axis]) / (b[e.axis] - a[e.axis]);
  return e.axis === 0 ? [e.v, a[1] + t * (b[1] - a[1])] : [a[0] + t * (b[0] - a[0]), e.v];
}

// Douglas–Peucker（pts: [[x,y],…]；tol 与坐标同单位）
function dp(pts, tol) {
  const n = pts.length;
  if (n < 3) return pts.slice();
  const keep = new Uint8Array(n); keep[0] = keep[n - 1] = 1;
  const tol2 = tol * tol;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop();
    let maxD = -1, idx = -1;
    const [x0, y0] = pts[i0], [x1, y1] = pts[i1];
    const dx = x1 - x0, dy = y1 - y0, L2 = dx * dx + dy * dy;
    for (let i = i0 + 1; i < i1; i++) {
      const [x, y] = pts[i];
      let dd;
      if (L2 === 0) { const ex = x - x0, ey = y - y0; dd = ex * ex + ey * ey; }
      else {
        let t = ((x - x0) * dx + (y - y0) * dy) / L2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = x0 + dx * t - x, ey = y0 + dy * t - y, q = ex * ex + ey * ey;
        dd = q;
      }
      if (dd > maxD) { maxD = dd; idx = i; }
    }
    if (maxD > tol2 && idx > 0) { keep[idx] = 1; stack.push([i0, idx], [idx, i1]); }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i]);
  return out;
}
// 闭合环简化：以最远点对切成两段分别 DP
function dpRing(pts, tol) {
  const n = pts.length;
  if (n < 4) return pts.slice();
  if (n < 8) return pts.slice();
  let far = 0, best = -1;
  for (let i = 0; i < n; i++) {
    const dx = pts[i][0] - pts[0][0], dy = pts[i][1] - pts[0][1];
    const d = dx * dx + dy * dy;
    if (d > best) { best = d; far = i; }
  }
  const a = dp(pts.slice(0, far + 1), tol);
  const b = dp(pts.slice(far).concat([pts[0]]), tol);
  const out = a.slice(0, -1).concat(b.slice(0, -1));
  return out.length >= 3 ? out : pts.slice();
}
function ringAreaCells(pts) {
  let s = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(s) / 2;                        // 格²
}

// 量化：[[x,y](格)] → Int32Array(1/64 格)，去重相邻同点
function quantize(pts) {
  const out = [];
  let px = null, py = null;
  for (const p of pts) {
    const x = qz(p[0]), y = qz(p[1]);
    if (x === px && y === py) continue;
    out.push(x, y); px = x; py = y;
  }
  return out;
}
function quantizeRingClosed(pts) {
  const q = quantize(pts);
  const n = q.length / 2;
  if (n > 1 && q[0] === q[(n - 1) * 2] && q[1] === q[(n - 1) * 2 + 1]) q.length -= 2;
  return q;
}

// ═════════════════════════════════ 6. 编码（与 js/geo.js dec() 互逆） ═════════════════════════════════
function zig(v) {
  let u = v < 0 ? ~(v << 1) : (v << 1);
  let s = '';
  while (u >= 32) { s += String.fromCharCode((32 | (u & 31)) + 63); u >>>= 5; }
  return s + String.fromCharCode(u + 63);
}
function enc(ints) {
  let s = '', px = 0, py = 0;
  for (let k = 0; k + 1 < ints.length; k += 2) {
    s += zig(ints[k] - px) + zig(ints[k + 1] - py);
    px = ints[k]; py = ints[k + 1];
  }
  return s;
}
// JS 单引号字符串字面量转义（编码只产出 63..126 的可见字符，只有反斜杠需要转义）
const lit = (s) => "'" + s.replace(/\\/g, '\\\\') + "'";

// ═════════════════════════════════ 7. 名称归一 ═════════════════════════════════
function toHans(s) {
  let out = '';
  for (const ch of s) out += HANT2HANS[ch] || ch;
  return out;
}
function normName(tags) {
  if (!tags) return '';
  let n = tags['name:zh-Hans'] || tags['name:nan-Hans'] || tags['name:zh'] || tags.name || '';
  n = String(n).split(';')[0].trim();
  n = n.replace(/\s*[-–—]\s*[A-Za-z].*$/, '');                 // "西溪 - Xixi" → "西溪"
  n = n.replace(/\s*[（(][^）)]*[A-Za-z][^）)]*[）)]\s*/g, '');   // "（Xiamen Bridge）"
  n = n.replace(/[\u3000\s]+/g, '').trim();
  // 命名契约：不留英文。紧贴中文的拉丁尾巴/前缀一律去掉（"嘉禾路JiaheRoad"→"嘉禾路"、"X416县道"→"416县道"）
  n = n.replace(/^[A-Za-z]\d+/, '');                            // "A2湖泊" → "湖泊"、"G15沈海高速" → "沈海高速"
  n = n.replace(/^[A-Za-z][A-Za-z0-9'’.\-]*/, '');              // 前导英文
  n = n.replace(/([\u4e00-\u9fa5])([A-Za-z][A-Za-z0-9'’.\-]*)$/, '$1');   // 中文后的英文尾巴
  n = n.replace(/[A-Za-z][A-Za-z0-9'’.\-]*/g, '');              // 夹在中间的英文
  n = toHans(n);
  if (!/[\u4e00-\u9fa5]/.test(n)) return '';                    // 纯拉丁名 → 视为无名（绝不编名字）
  if (NAME_ALIAS[n]) n = NAME_ALIAS[n];
  return n;
}
class NameTable {
  constructor() { this.list = ['']; this.map = new Map(); }
  id(n) {
    if (!n) return 0;
    if (this.map.has(n)) return this.map.get(n);
    const i = this.list.length;
    this.list.push(n); this.map.set(n, i);
    return i;
  }
}

// ═════════════════════════════════ 8. 从 OSM 元素取环 ═════════════════════════════════
const samePt = (a, b) => Math.abs(a[0] - b[0]) < 1e-7 && Math.abs(a[1] - b[1]) < 1e-7;

function wayCoords(el) {
  if (!el.geometry) return null;
  const pts = [];
  for (const g of el.geometry) { if (g && g.lat != null) pts.push([g.lon, g.lat]); }
  return pts.length >= 2 ? pts : null;
}
// 把若干线段首尾相接成环/链
function joinWays(list) {
  const pool = list.map((w) => w.slice());
  const out = [];
  while (pool.length) {
    let cur = pool.pop();
    let grew = true;
    while (grew && !(cur.length > 3 && samePt(cur[0], cur[cur.length - 1]))) {
      grew = false;
      const head = cur[0], tail = cur[cur.length - 1];
      for (let i = 0; i < pool.length; i++) {
        const w = pool[i], wh = w[0], wt = w[w.length - 1];
        if (samePt(tail, wh)) { cur = cur.concat(w.slice(1)); }
        else if (samePt(tail, wt)) { cur = cur.concat(w.slice(0, -1).reverse()); }
        else if (samePt(head, wt)) { cur = w.slice(0, -1).concat(cur); }
        else if (samePt(head, wh)) { cur = w.slice(1).reverse().concat(cur); }
        else continue;
        pool.splice(i, 1); grew = true; break;
      }
    }
    out.push(cur);
  }
  return out;
}
// 元素 → { outer: [[lon,lat]…], inner: [[lon,lat]…] }
function elementRings(el) {
  if (el.type === 'way') {
    const c = wayCoords(el);
    if (!c) return null;
    if (!samePt(c[0], c[c.length - 1])) return null;      // 面要素必须是闭合 way
    return { outer: [c], inner: [] };
  }
  const outerWays = [], innerWays = [];
  for (const m of el.members || []) {
    if (m.type !== 'way' || !m.geometry) continue;
    const pts = [];
    for (const g of m.geometry) if (g && g.lat != null) pts.push([g.lon, g.lat]);
    if (pts.length < 2) continue;
    (m.role === 'inner' ? innerWays : outerWays).push(pts);
  }
  if (!outerWays.length) return null;
  return { outer: joinWays(outerWays), inner: joinWays(innerWays) };
}

function pointInRing(pt, ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i][1], yj = ring[j][1];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (ring[j][0] - ring[i][0]) * (pt[1] - yi) / (yj - yi) + ring[i][0]) c = !c;
  }
  return c;
}
function signedAreaPts(pts) {
  let s = 0;
  for (let i = 0, n = pts.length; i < n; i++) { const a = pts[i], b = pts[(i + 1) % n]; s += a[0] * b[1] - b[0] * a[1]; }
  return s / 2;
}

// ═════════════════════════════════ 9. 海面：coastline → 栅格灌水 → 陆地边界 ═════════════════════════════════
// 海面：岸线栅格 → 自由空间连通块标记 → 用 OSM「陆在左、水在右」给每个连通块投票（逐段采样，少数服从多数）
// → 非海连通块 = 陆地 → 追踪陆地边界成环。逐块投票能容忍个别方向写反的岸线，也不需要猜全局法向或种子方向。
function buildSea(chains, stats) {
  const W = CFG.W, H = CFG.H;
  const S = CFG.sea.pxPerCell;
  const FW = Math.round(W * S), FH = Math.round(H * S);
  const VW = FW + 1;
  const bar = new Uint8Array(FW * FH);                       // 1 = 岸线
  const toPx = (ll) => [projX(ll[0]) * S, (H - projY(ll[1])) * S];

  // 1) 岸线栅格化（4 连通 + 膨胀 DIL）
  const DIL = +(process.env.SEA_DILATE || CFG.sea.dilate || 2);
  const plot1 = (x, y) => { if (x >= 0 && y >= 0 && x < FW && y < FH) bar[y * FW + x] = 1; };
  let segs = 0;
  for (const line of chains) {
    let prev = null;
    for (let i = 0; i + 1 < line.length; i++) {
      const a = toPx(line[i]), b = toPx(line[i + 1]);
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) * 2));
      segs++;
      let last = prev || [Math.round(a[0]), Math.round(a[1])];
      for (let k = 0; k <= n; k++) {
        const x = Math.round(a[0] + dx * k / n), y = Math.round(a[1] + dy * k / n);
        if (x === last[0] && y === last[1]) continue;
        if (x !== last[0] && y !== last[1]) {
          for (let d = -DIL; d <= DIL; d++) { plot1(x, last[1] + d); plot1(last[0], y + d); }
        }
        for (let d = -DIL; d <= DIL; d++) { plot1(x + d, y); plot1(x, y + d); }
        last = [x, y];
      }
      prev = last;
    }
  }
  let barrier = 0;
  for (let i = 0; i < bar.length; i++) if (bar[i] === 1) barrier++;

  // 2) 自由空间连通块标记（4 连通，扫描线 + 队列）
  const label = new Int32Array(FW * FH).fill(-1);            // -1 = 岸线
  let nLab = 0;
  const sizes = [];
  const q = [];
  for (let sy = 0; sy < FH; sy++) for (let sx = 0; sx < FW; sx++) {
    const s0 = sy * FW + sx;
    if (bar[s0] || label[s0] >= 0) continue;
    const id = nLab++;
    let cnt = 0;
    label[s0] = id;
    q.length = 0; q.push(sx, sy);
    while (q.length) {
      const y = q.pop(), x = q.pop();
      let xl = x, xr = x;
      while (xl > 0 && !bar[y * FW + xl - 1] && label[y * FW + xl - 1] < 0) xl--;
      while (xr < FW - 1 && !bar[y * FW + xr + 1] && label[y * FW + xr + 1] < 0) xr++;
      for (let k = xl; k <= xr; k++) { label[y * FW + k] = id; cnt++; }
      for (const ny of [y - 1, y + 1]) {
        if (ny < 0 || ny >= FH) continue;
        let k = xl;
        while (k <= xr) {
          while (k <= xr && (bar[ny * FW + k] || label[ny * FW + k] >= 0)) k++;
          if (k > xr) break;
          q.push(k, ny);
          while (k <= xr && !bar[ny * FW + k] && label[ny * FW + k] < 0) k++;
        }
      }
    }
    sizes[id] = cnt;
  }

  // 3) 逐连通块投票：岸线右侧样本落在哪个块，就给它 +1「海」；左侧 +1「陆」
  const voteSea = new Int32Array(nLab), voteLand = new Int32Array(nLab);
  const off = DIL + 3;
  for (const line of chains) {
    for (let i = 0; i + 1 < line.length; i++) {
      const a = toPx(line[i]), b = toPx(line[i + 1]);
      let dx = b[0] - a[0], dy = b[1] - a[1];
      const L = Math.hypot(dx, dy); if (L < 2) continue;
      dx /= L; dy /= L;
      for (const t of [0.3, 0.6, 0.85]) {
        const mx = a[0] + (b[0] - a[0]) * t, my = a[1] + (b[1] - a[1]) * t;
        const rp = [Math.round(mx + dy * off), Math.round(my - dx * off)];    // 右（水）
        const lp = [Math.round(mx - dy * off), Math.round(my + dx * off)];    // 左（陆）
        if (rp[0] >= 0 && rp[1] >= 0 && rp[0] < FW && rp[1] < FH) { const l = label[rp[1] * FW + rp[0]]; if (l >= 0) voteSea[l]++; }
        if (lp[0] >= 0 && lp[1] >= 0 && lp[0] < FW && lp[1] < FH) { const l = label[lp[1] * FW + lp[0]]; if (l >= 0) voteLand[l]++; }
      }
    }
  }
  const isSea = new Uint8Array(nLab);
  let seaComps = 0, landComps = 0;
  for (let i = 0; i < nLab; i++) {
    if (sizes[i] <= 2) continue;
    if (voteSea[i] > voteLand[i]) { isSea[i] = 1; seaComps++; } else landComps++;
  }
  let water = 0;
  for (let i = 0; i < FW * FH; i++) { const l = label[i]; if (l >= 0 && isSea[l]) water++; }
  const DEBUG = process.env.SEA_DEBUG;
  if (DEBUG) {
    const top = sizes.map((s, i) => ({ i, s, sea: isSea[i], vs: voteSea[i], vl: voteLand[i] })).sort((a, b) => b.s - a.s).slice(0, 6);
    console.log('[sea] top comps', JSON.stringify(top));
  }

  // 3b) 岸线邻域修正：只改岸线附近，远处仍用逐块投票结果
  //   OSM 岸线在湾口断开时，整个湾会跟着大陆被判成陆（同安湾就是这样）。
  //   岸线两侧 off px 处打"右=水 / 左=陆"标签，再在离标签 ≤ CORR px 内做多源 BFS 传播覆盖投票结果；
  //   超出 CORR 的内陆与外海保持原判，所以不会把内陆翻成海，也不动远海。
  const CORR = 38;
  const band = new Int8Array(FW * FH);            // 0 未知 1 陆 2 水
  {
    const off = DIL + 2;
    const plot2 = (x, y, v) => { if (x >= 0 && y >= 0 && x < FW && y < FH) { const i = y * FW + x; if (!bar[i] && !band[i]) band[i] = v; } };
    for (const line of chains) {
      for (let i = 0; i + 1 < line.length; i++) {
        const a = toPx(line[i]), b = toPx(line[i + 1]);
        let dx = b[0] - a[0], dy = b[1] - a[1];
        const L2 = Math.hypot(dx, dy);
        if (L2 < 1) continue;
        dx /= L2; dy /= L2;
        const nx = dy, ny = -dx;
        const steps = Math.max(1, Math.ceil(L2));
        for (let k = 0; k <= steps; k++) {
          const t = k / steps;
          const mx = a[0] + (b[0] - a[0]) * t, my = a[1] + (b[1] - a[1]) * t;
          const rx = Math.round(mx + nx * off), ry = Math.round(my + ny * off);
          const lx = Math.round(mx - nx * off), ly = Math.round(my - ny * off);
          for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
            plot2(rx + ox, ry + oy, 2);
            plot2(lx + ox, ly + oy, 1);
          }
        }
      }
    }
    // 距离受控的传播：用带层号的 BFS
    const q = new Int32Array(FW * FH), dep = new Uint8Array(FW * FH);
    let qh = 0, qt = 0;
    for (let i = 0; i < FW * FH; i++) if (band[i]) { q[qt++] = i; dep[i] = 0; }
    while (qh < qt) {
      const i = q[qh++], d = dep[i], v = band[i];
      if (d >= CORR) continue;
      const x = i % FW;
      const nb = [x > 0 ? i - 1 : -1, x < FW - 1 ? i + 1 : -1, i >= FW ? i - FW : -1, i + FW < FW * FH ? i + FW : -1];
      for (const j of nb) {
        if (j < 0 || band[j] || bar[j]) continue;
        band[j] = v; dep[j] = d + 1; q[qt++] = j;
      }
    }
    stats.sea && (stats.sea.bandCorr = CORR);
  }
  // 4) 追踪陆地（label>=0 且非海）的边界，陆在左
  const isL = (x, y) => {
    if (x < 0 || y < 0 || x >= FW || y >= FH) return false;
    const i = y * FW + x;
    if (band[i] === 1) return true;         // 岸线邻域判定：陆
    if (band[i] === 2) return false;        // 岸线邻域判定：水
    return label[i] >= 0 && !isSea[label[i]];   // 远处回落到逐块投票
  };
  const edges = new Map();
  const addE = (a, b, dx, dy) => { let arr = edges.get(a); if (!arr) edges.set(a, (arr = [])); arr.push({ to: b, dx, dy }); };
  for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) {
    if (!isL(x, y)) continue;
    if (!isL(x, y + 1)) addE((y + 1) * VW + x + 1, (y + 1) * VW + x, -1, 0);
    if (!isL(x, y - 1)) addE(y * VW + x, y * VW + x + 1, 1, 0);
    if (!isL(x + 1, y)) addE(y * VW + x + 1, (y + 1) * VW + x + 1, 0, 1);
    if (!isL(x - 1, y)) addE((y + 1) * VW + x, y * VW + x, 0, -1);
  }
  const PRIORITY = [(d) => [-d[1], d[0]], (d) => d, (d) => [d[1], -d[0]], (d) => [-d[0], -d[1]]];
  const pickNext = (arr, cur) => {
    if (arr.length === 1) return arr.pop();
    for (const turn of PRIORITY) {
      const want = turn(cur);
      const k = arr.findIndex((e) => e.dx === want[0] && e.dy === want[1]);
      if (k >= 0) return arr.splice(k, 1)[0];
    }
    return arr.pop();
  };
  const rings = [];
  for (const [start, arr] of edges) {
    while (arr.length) {
      const ring = [start];
      let cur = pickNext(arr, [0, 1]);
      let guard = 0;
      while (cur.to !== start && guard++ < 2e7) {
        ring.push(cur.to);
        const nxt = edges.get(cur.to);
        if (!nxt || !nxt.length) { ring.push(start); break; }
        cur = pickNext(nxt, [cur.dx, cur.dy]);
      }
      if (ring.length >= 4) rings.push(ring);
    }
  }

  // 5) 栅格顶点 → 格坐标 → 简化 → 量化
  const MIN_AREA = Math.max(CFG.minRingAreaKm2, 0.02) / 0.0625;
  const tol = CFG.simplify.sea;
  const holes = [];
  let dropped = 0, dup = 0;
  for (const ring of rings) {
    const grids = ring.map((v) => { const x = v % VW; return [x / S, H - ((v - x) / VW) / S]; });
    const a = signedAreaPts(grids);
    if (Math.abs(a) < MIN_AREA) { dropped++; continue; }
    let pts = a < 0 ? grids.slice().reverse() : grids;
    pts = dpRing(pts, tol);
    if (pts.length < CFG.minRingPoints) { dropped++; continue; }
    holes.push({ pts, area: Math.abs(a), bb: bboxOfPts(pts) });
  }
  holes.sort((x, y) => y.area - x.area);
  const uniq = [];
  for (const r of holes) {
    const hit = uniq.find((u) => bboxIoU(u.bb, r.bb) > 0.9 && Math.abs(u.area - r.area) / Math.max(u.area, r.area) < 0.15);
    if (hit) { dup++; continue; }
    uniq.push(r);
  }

  const out = [quantizeRingClosed([[0, 0], [0, H], [W, H], [W, 0]])];
  let verts = 4;
  for (const r of uniq) {
    const q = quantizeRingClosed(r.pts);
    if (q.length / 2 < CFG.minRingPoints) continue;
    out.push(q);
    verts += q.length / 2;
  }
  const frac = water / (FW * FH);
  stats.sea = {
    FW, FH, S, DIL, barrier, segs, comps: nLab, seaComps, landComps,
    waterCells: water, waterFrac: +frac.toFixed(4), landFrac: +(1 - frac).toFixed(4),
    traced: rings.length, landRings: uniq.length, dropped, dup, verts, tol,
  };
  return out;
}

function bboxOfPts(pts) {
  const bb = [1e9, 1e9, -1e9, -1e9];
  for (const [x, y] of pts) { if (x < bb[0]) bb[0] = x; if (y < bb[1]) bb[1] = y; if (x > bb[2]) bb[2] = x; if (y > bb[3]) bb[3] = y; }
  return bb;
}
function bboxIoU(a, b) {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return ua > 0 ? inter / ua : 0;
}

// ═════════════════════════════════ 10. 分层构建 ═════════════════════════════════
function build() {
  const t0 = Date.now();
  const { byId, files, skippedProbe, badFiles, dupIds } = loadRaw(CFG.rawDir);
  const N = new NameTable();
  const S = {};                                   // 统计
  let seaRings = [];

  // 把 way 元素按 id 索引（relation 成员过滤用）
  const memberWayIds = new Set();

  // ---- 分类容器 ----
  const waterPolys = [];    // {name, outer[[gridPts]], inner[[gridPts]]}
  const waterLines = [];    // {name, w, line}
  const roads = [];         // {name, cls, flags, line}
  const streets = [];       // line
  const rail = [];          // {name, flags, line, year}
  const parks = [], reserves = [], woods = [];
  const admin = [];         // {level, name, outer, inner}
  const places = [];
  const centres = [];
  const coastLines = [];

  const ROAD_CLS = {
    motorway: 4, motorway_link: 4, trunk: 4, trunk_link: 4,
    primary: 3, primary_link: 3,
    secondary: 2, secondary_link: 2, tertiary: 2,
  };
  const STREET_HW = new Set(['residential', 'unclassified', 'living_street', 'service', 'tertiary_link']);

  // 收集 relation 成员 way，避免重复成面
  for (const el of byId.values()) {
    if (el.type !== 'relation') continue;
    const t = el.tags || {};
    const interesting = t.natural === 'water' || t.landuse === 'reservoir' || t.natural === 'bay' ||
      t.leisure === 'park' || t.leisure === 'garden' || t.boundary === 'protected_area' ||
      t.leisure === 'nature_reserve' || t.landuse === 'forest' || t.natural === 'wood' ||
      (t.boundary === 'administrative' && /^(6|8)$/.test(t.admin_level || ''));
    if (!interesting) continue;
    for (const m of el.members || []) if (m.type === 'way' && m.geometry) memberWayIds.add(m.ref);
  }

  const toGrid = (lonlat) => lonlat.map(([lon, lat]) => [projX(lon), projY(lat)]);

  // 简化容差查表：按名称覆盖优先（绝对值），否则回落到图层默认容差
  const simpHits = new Map();                        // name → { tol, verts }，统计用
  function simpTolFor(name, key) {
    const byName = CFG.simplifyByName ? CFG.simplifyByName[name] : undefined;
    if (typeof byName === 'number' && byName > 0) return byName;
    return CFG.simplify[key || 'poly'];
  }
  function noteSimpHit(name, tol, verts) {
    if (CFG.simplifyByName && typeof CFG.simplifyByName[name] === 'number') simpHits.set(name, { tol, verts });
  }

  function polyFeature(el, buckets) {
    const rings = elementRings(el);
    if (!rings) return;
    const name = normName(el.tags);
    const tol = simpTolFor(name, 'poly');
    const outer = [];
    for (const r of rings.outer) {
      const g = toGrid(r);
      const clipped = clipRing(g);
      if (!clipped) continue;
      const simp = dpRing(clipped, tol);
      if (simp.length < CFG.minRingPoints) continue;
      if (!(el.tags && el.tags.natural === 'bay')) {
        if (ringAreaCells(simp) < CFG.minRingAreaKm2 / (CFG.CELL_M / 1000) ** 2) continue;
      }
      outer.push(simp);
    }
    if (!outer.length) return;
    const inner = [];
    for (const r of rings.inner) {
      const clipped = clipRing(toGrid(r));
      if (!clipped) continue;
      const simp = dpRing(clipped, tol);
      if (simp.length >= CFG.minRingPoints) inner.push(simp);
    }
    noteSimpHit(name, tol, outer.reduce((s, r) => s + r.length, 0));
    buckets.push({ name, outer, inner });
  }

  // ---- 遍历元素 ----
  for (const el of byId.values()) {
    const t = el.tags || {};
    const name = normName(t);

    if (el.type === 'node') {
      if (t.natural === 'coastline') continue;
      const x = projX(el.lon), y = projY(el.lat);
      if (x < 0 || y < 0 || x > CFG.W || y > CFG.H) continue;
      let type = -1;
      if (t.railway === 'station' || t.public_transport === 'station') {
        // 只有明确 station=subway / railway=subway 才算地铁站；subway=yes 只是『有地铁接驳』，不代表本体是地铁站（如厦门北站）
        type = (t.station === 'subway' || t.railway === 'subway') ? 0 : 1;
        // 地铁/轻轨站若来自 public_transport=station 且带 subway 标签也归 0
      } else if (t.place === 'island' || t.place === 'islet') type = 4;
      else if (t.place === 'suburb' || t.place === 'quarter' || t.place === 'city' || t.place === 'town') type = 2;
      else if (t.place === 'village' || t.place === 'hamlet' || t.place === 'neighbourhood') type = 3;
      if (type >= 0 && name) {
        // 铁路车站按中文惯例补「站」字（OSM 里 name=厦门 的 railway=station 就是厦门站）；
        // 地铁站不加（"镇海路" 不叫 "镇海路站"），已带「站」的不动。
        let pname = name;
        if (type === 1 && t.railway === 'station' && !/站$/.test(pname)) pname += '站';
        places.push([pname, +x.toFixed(2), +y.toFixed(2), type]);
      }
      continue;
    }

    if (t.natural === 'coastline') {
      const c = wayCoords(el);
      if (c) coastLines.push(c);
      continue;
    }

    if (el.type === 'relation') {
      // 湾区 relation（厦门湾/厦门港/浔江港…）面积巨大且与海面重叠，只保留面积小的 way 型湾区
      if (t.natural === 'water' || t.landuse === 'reservoir') {
        polyFeature(el, waterPolys);
      } else if (t.leisure === 'park' || t.leisure === 'garden') polyFeature(el, parks);
      else if (t.boundary === 'protected_area' || t.leisure === 'nature_reserve') polyFeature(el, reserves);
      else if (t.landuse === 'forest' || t.natural === 'wood') polyFeature(el, woods);
      else if (t.boundary === 'administrative' && /^(6|8)$/.test(t.admin_level || '')) {
        const level = +t.admin_level;
        const rings = elementRings(el);
        if (!rings) continue;
        const outer = [];
        for (const r of rings.outer) {
          const clipped = clipRing(toGrid(r));
          if (!clipped) continue;
          const simp = dpRing(clipped, simpTolFor(name, 'poly'));
          if (simp.length >= CFG.minRingPoints) outer.push(simp);
        }
        if (outer.length && name) admin.push({ level, name, outer });
        // places 还没抓到时，用 admin_centre 成员顶替区/街道中心点（绝不编造名字）
        if (name && Array.isArray(el.members)) {
          for (const m of el.members) {
            if (m.role !== 'admin_centre' || m.type !== 'node' || m.lat == null || m.lon == null) continue;
            const cx = projX(m.lon), cy = projY(m.lat);
            if (cx >= 0 && cy >= 0 && cx <= CFG.W && cy <= CFG.H) centres.push([name, +cx.toFixed(2), +cy.toFixed(2), 2]);
            break;
          }
        }
      }
      continue;
    }

    // ---- way ----
    const hw = t.highway;
    if (hw && ROAD_CLS[hw]) {
      const c = wayCoords(el);
      if (c) {
        let flags = 0;
        if (t.bridge && t.bridge !== 'no') flags |= 1;
        if (t.tunnel && t.tunnel !== 'no') flags |= 2;
        if (/_link$/.test(hw)) flags |= 4;
        if (t.oneway === 'yes' || t.oneway === '1' || t.oneway === 'true' || t.junction === 'roundabout') flags |= 8;
        for (const part of clipPolyline(toGrid(c))) {
          const simp = dp(part, CFG.simplify.line);
          if (simp.length >= 2) roads.push({ name, cls: ROAD_CLS[hw], flags, line: simp });
        }
      }
      continue;
    }
    if (hw && STREET_HW.has(hw)) {
      const c = wayCoords(el);
      if (c) for (const part of clipPolyline(toGrid(c))) {
        const simp = dp(part, CFG.simplify.street);
        if (simp.length >= 2) streets.push(simp);
      }
      continue;
    }
    if (t.railway && /^(rail|light_rail|highspeed)$/.test(t.railway)) {
      const c = wayCoords(el);
      if (c) {
        let flags = 0;
        if (t.bridge && t.bridge !== 'no') flags |= 1;
        if (t.tunnel && t.tunnel !== 'no') flags |= 2;
        const hs = t.railway === 'highspeed' || t.highspeed === 'yes' || /高铁|客专|高速铁路/.test(name);
        if (hs) flags |= 16;
        let year = 0;
        const m = /^(\d{4})/.exec(t.start_date || t.opening_date || '');
        if (m) year = +m[1];
        for (const part of clipPolyline(toGrid(c))) {
          const simp = dp(part, CFG.simplify.rail);
          if (simp.length >= 2) rail.push({ name, flags, line: simp, year });
        }
      }
      continue;
    }
    if (t.waterway && WATER_LINE_W[t.waterway]) {
      const c = wayCoords(el);
      if (c) {
        for (const part of clipPolyline(toGrid(c))) {
          const simp = dp(part, CFG.simplify.line);
          if (simp.length >= 2) {
            let w = WATER_LINE_W[t.waterway];
            const wm = parseFloat(t.width);
            if (isFinite(wm) && wm > 0) w = Math.min(0.28, Math.max(0.008, wm / CFG.CELL_M));
            waterLines.push({ name, w, line: simp });
          }
        }
      }
      continue;
    }
    if (memberWayIds.has(el.id)) continue;
    if (t.natural === 'water' || t.landuse === 'reservoir' || t.natural === 'bay') {
      if (t.natural === 'bay' && !name) continue;
      polyFeature(el, waterPolys);
    } else if (t.leisure === 'park' || t.leisure === 'garden') polyFeature(el, parks);
    else if (t.boundary === 'protected_area' || t.leisure === 'nature_reserve') polyFeature(el, reserves);
    else if (t.landuse === 'forest' || t.natural === 'wood') polyFeature(el, woods);
  }

  // ---- 海面 ----
  seaRings.push(...buildSea(joinWays(coastLines), S));

  // ═══════════ 输出 ═══════════
  const V = {};                                   // 每层顶点数（1/64 格整数点）
  let totalVerts = 0;
  const addV = (k, n) => { V[k] = (V[k] || 0) + n; totalVerts += n; };
  const vcount = (ints) => ints.length / 2;

  const waterRows = [];
  // 海：全部环放进同一个要素（render.js:620 按 evenodd 填充，环绕向不敏感）。
  // 环向由追踪方向决定：行进时水恒在左侧 → 北向上坐标系里是逆时针；换到游戏坐标（y 向南）后反号。
  function qToPts(q) { const p = []; for (let i = 0; i + 1 < q.length; i += 2) p.push([q[i] / Q, q[i + 1] / Q]); return p; }
  function signedArea(pts) {
    let s = 0;
    for (let i = 0, n = pts.length; i < n; i++) { const a = pts[i], b = pts[(i + 1) % n]; s += a[0] * b[1] - b[0] * a[1]; }
    return s / 2;
  }
  if (seaRings.length) {
    const row = [N.id(CFG.city + '湾')];
    seaRings.sort((a, b) => Math.abs(signedArea(qToPts(b))) - Math.abs(signedArea(qToPts(a))));
    let seaO = 0, seaI = 0;
    for (const r of seaRings) {
      const isWater = signedArea(qToPts(r)) < 0;      // 水环（外）/ 陆环（岛，内）
      if (isWater) seaO++; else seaI++;
      row.push((isWater ? 'o' : 'i') + enc(r));
      addV('sea', vcount(r));
    }
    S.sea = Object.assign(S.sea || {}, { waterRings: seaO, landHoles: seaI });
    waterRows.push(row);
  }

  for (const f of waterPolys) {
    const row = [N.id(f.name)];
    for (const r of f.outer) { const q = quantizeRingClosed(r); if (q.length / 2 >= CFG.minRingPoints) { row.push('o' + enc(q)); addV('water', vcount(q)); } }
    for (const r of f.inner) { const q = quantizeRingClosed(r); if (q.length / 2 >= CFG.minRingPoints) { row.push('i' + enc(q)); addV('water', vcount(q)); } }
    if (row.length > 1) waterRows.push(row);
  }
  const waterLineRows = waterLines.map((l) => {
    const q = quantize(l.line); addV('waterLine', vcount(q));
    return [N.id(l.name), l.w, enc(q)];
  });
  const roadRows = roads.map((r) => {
    const q = quantize(r.line); addV('roads', vcount(q));
    return [N.id(r.name), r.cls, r.flags, enc(q)];
  });
  const streetStrs = streets.map((s) => { const q = quantize(s); addV('streets', vcount(q)); return enc(q); });
  const railRows = rail.map((r) => {
    const q = quantize(r.line); addV('rail', vcount(q));
    return r.year ? [N.id(r.name), r.flags, enc(q), r.year] : [N.id(r.name), r.flags, enc(q)];
  });
  const polyRows = (key) => (arr2) => arr2.map((f) => {
    const row = [N.id(f.name)];
    for (const r of f.outer) { const q = quantizeRingClosed(r); if (q.length / 2 >= CFG.minRingPoints) { row.push('o' + enc(q)); addV(key, vcount(q)); } }
    for (const r of f.inner) { const q = quantizeRingClosed(r); if (q.length / 2 >= CFG.minRingPoints) { row.push('i' + enc(q)); addV(key, vcount(q)); } }
    return row.length > 1 ? row : null;
  }).filter(Boolean);
  const parkRows = polyRows('parks')(parks), reserveRows = polyRows('reserves')(reserves), woodRows = polyRows('woods')(woods);
  const adminRows = admin.map((a) => {
    const row = [a.level, N.id(a.name)];
    for (const r of a.outer) { const q = quantizeRingClosed(r); if (q.length / 2 >= CFG.minRingPoints) { row.push('o' + enc(q)); addV('admin', vcount(q)); } }
    return row.length > 2 ? row : null;
  }).filter(Boolean);
  // places 去重（同名保留一个）；节点地名太少时（places.json 还没抓到）用 admin_centre 顶替
  const allPlaces = places.length >= 8 ? places.slice() : places.concat(centres);
  const seenPlace = new Set();
  const placeRows = [];
  for (const p of allPlaces) {
    if (seenPlace.has(p[0])) continue;
    seenPlace.add(p[0]);
    placeRows.push(p);
  }

  // ═══════════ 拼文件 ═══════════
  const today = new Date().toISOString().slice(0, 10);
  const arr = (rows) => '[\n' + rows.map((r) => '      ' + '[' + r.map((v) => typeof v === 'string' ? lit(v) : v).join(',') + ']').join(',\n') + '\n    ]';
  const L = [];
  L.push(`'use strict';`);
  L.push(`// 由 OpenStreetMap 数据生成（© OpenStreetMap 贡献者，ODbL）。坐标为游戏格（250 m），折线为增量编码，1/64 格精度。地名已统一为简体中文。`);
  L.push(`// 生成器 scripts/osm2geo.mjs；OSM 数据抓取于 ${today}；bbox ${f6(BB.w)}–${f6(BB.e)}E / ${f6(BB.s)}–${f6(BB.n)}N；W=${CFG.W} H=${CFG.H}。`);
  L.push(`// 格网 ${CFG.CELL_M} m；投影 x=(lon-${CFG.proj.lon0})*${CFG.proj.kx}, y=(${CFG.proj.lat0}-lat)*${CFG.proj.ky}。`);
  L.push('// 图层 water / waterLines / roads / streets / rail / parks / reserves / woods / admin / places / names；海面 = 岸线邻域定侧 + 限距 BFS 判定后输出为矢量环。');
  L.push(`(function (CM) {`);
  L.push(`  (CM.GEOS = CM.GEOS || {}).${CFG.code} = {`);
  L.push(`    proj: { lon0: ${P.lon0}, lat0: ${P.lat0}, kx: ${P.kx}, ky: ${P.ky} },`);
  L.push(`    // 水域：[名称序号, 环…]（o 外环 / i 内环）或 [名称序号, 宽度(格), 中心线]`);
  L.push(`    water: ${arr(waterRows.concat(waterLineRows))},`);
  L.push(`    // 主要道路：[名称序号, 等级(4 快速路 / 3 主干道 / 2 次干道), 标记(1 桥 2 隧道 4 匝道 8 单行), 折线]`);
  L.push(`    roads: ${arr(roadRows)},`);
  L.push(`    // 支路（居住区道路等），以 ! 分隔`);
  L.push(`    streets: ${lit(streetStrs.join('!'))},`);
  L.push(`    // 铁路：[名称序号, 标记(1 桥 2 隧道 16 高速), 折线, 开通年?]`);
  L.push(`    rail: ${arr(railRows)},`);
  L.push(`    parks: ${arr(parkRows)},`);
  L.push(`    reserves: ${arr(reserveRows)},`);
  L.push(`    woods: ${arr(woodRows)},`);
  L.push(`    // 行政区界：[级别(6 区 / 8 街道), 名称序号, 环…]`);
  L.push(`    admin: ${arr(adminRows)},`);
  L.push(`    // 地名：[名称, x, y, 类型(0 地铁站 1 火车站 2 街区 3 村/社区 4 岛)]`);
  L.push(`    places: ${arr(placeRows)},`);
  L.push(`    names: [${N.list.map((s) => lit(s)).join(',')}],`);
  L.push(`  };`);
  L.push(`})(window.CM);`);

  const text = L.join('\n') + '\n';
  const outPath = path.resolve(REPO, CFG.outFile);
  fs.writeFileSync(outPath, text, 'utf8');

  const st = {
    generatedAt: new Date().toISOString(),
    rawDir: CFG.rawDir, rawFiles: files, rawSkippedProbe: skippedProbe, rawElements: byId.size, rawDupIds: dupIds, rawBadFiles: badFiles,
    bbox: { w: +f6(BB.w), e: +f6(BB.e), s: +f6(BB.s), n: +f6(BB.n) },
    bytes: Buffer.byteLength(text),
    verts: totalVerts,
    vertsByLayer: V,
    layers: {
      seaRings: seaRings.length,
      waterPoly: waterRows.length - (seaRings.length ? 1 : 0),
      waterLine: waterLineRows.length,
      roads: roadRows.length, streets: streetStrs.length,
      rail: railRows.length,
      parks: parkRows.length, reserves: reserveRows.length, woods: woodRows.length,
      admin: adminRows.length, places: placeRows.length, names: N.list.length,
    },
    simplify: Object.assign({}, CFG.simplify),
    simplifyByName: Object.assign({}, CFG.simplifyByName),
    simplifyByNameHits: Object.fromEntries(simpHits),
    sea: S.sea,
    seaDiag: S.seaDiag,
    elapsedMs: Date.now() - t0,
  };
  return { st, outPath, N, waterRows, waterLineRows, roadRows, railRows, parkRows, reserveRows, woodRows, adminRows, placeRows };
}

// ═════════════════════════════════ 11. main ═════════════════════════════════
if (has('fetch')) await stageFetch();

// 预算自调节：顶点/字节超线就整体放大简化容差重跑（最多 4 轮）
// 注意：CFG.simplifyByName 是绝对容差，不参与下面的整体放大，所以按名称覆盖的要素
// （如「湖边水库」）无论重跑几轮、是否触发预算兜底，输出的环都是同一个。
let res;
for (let round = 1; round <= 4; round++) {
  res = build();
  const over = res.st.verts > CFG.budget.maxVerts || res.st.bytes > CFG.budget.maxBytes;
  if (!over || round === 4) break;
  const k = 1.32;
  for (const key of ['poly', 'sea', 'line', 'street', 'rail']) CFG.simplify[key] *= k;
  console.log(`[budget] 第 ${round} 轮超预算：字节 ${res.st.bytes} / 顶点 ${res.st.verts} → 简化容差 ×${k}，重跑`);
}
console.log(JSON.stringify(res.st, null, 2));
if (res.st.bytes > CFG.budget.maxBytes || res.st.verts > CFG.budget.maxVerts) {
  console.log('!! 仍超预算：继续放大 CFG.simplify 或裁掉 service 支路');
}
const statsOut = opt('stats', '');
if (statsOut) fs.writeFileSync(statsOut, JSON.stringify(res.st, null, 2), 'utf8');
