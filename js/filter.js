/**
 * filter.js —— 关键点平滑滤波
 * 提供三种滤波方式：无滤波 / 指数滑动平均(EMA) / One Euro Filter
 * 并提供"手掌中心点"的计算（手腕 + 四指根部均值，用于减少抖动）
 */

/**
 * 判断某个关键点是否越界：x 或 y 超出 [0,1] 归一化范围，视为越界点。
 * 越界点通常出现在"手只有一部分在画面内"时，其坐标会被模型拉扯、剧烈跳动。
 * @param {{x:number,y:number}} lm 关键点
 * @returns {boolean}
 */
export function isOutOfBounds(lm) {
  return lm.x < 0 || lm.x > 1 || lm.y < 0 || lm.y > 1;
}

/**
 * 统计越界关键点数量
 * @param {Array} landmarks 21 个关键点
 * @returns {number}
 */
export function countOutOfBounds(landmarks) {
  let n = 0;
  for (let i = 0; i < landmarks.length; i++) {
    if (isOutOfBounds(landmarks[i])) n++;
  }
  return n;
}

/**
 * 计算手掌中心：
 * 取 手腕(0) 与 四指根部(食指5、中指9、无名指13、小指17) 的均值。
 * 相比只用手腕单点，取均值能显著减小抖动。
 * @param {Array} landmarks 21 个关键点，每个含 {x, y}（归一化 0~1）
 * @returns {{x: number, y: number}}
 */
export function palmCenter(landmarks) {
  const idx = [0, 5, 9, 13, 17];
  let x = 0;
  let y = 0;
  for (const i of idx) {
    x += landmarks[i].x;
    y += landmarks[i].y;
  }
  return { x: x / idx.length, y: y / idx.length };
}

/**
 * 计算"可靠关键点加权平均"后的手掌中心（用于手部分越界时的稳定控制）。
 * 策略：
 *   1) 优先取 四指根部(5、9、13、17) 中未越界的点；
 *   2) 四个指根都不在画面内时，退化为手腕(0)；
 *   3) 连手腕也越界时，退化为"所有未越界点"的均值；
 *   4) 全越界时返回画面中心（0.5, 0.5），交由丢失容错逻辑处理。
 * 越界的点一律忽略，避免被抖动的坏点拖垮。
 * @param {Array} landmarks 21 个关键点
 * @returns {{x: number, y: number}}
 */
export function palmCenterReliable(landmarks) {
  // 第一步：四个指根
  let idx = [5, 9, 13, 17].filter((i) => !isOutOfBounds(landmarks[i]));
  // 第二步：退化为手腕
  if (idx.length === 0 && !isOutOfBounds(landmarks[0])) idx = [0];
  // 第三步：所有未越界点
  if (idx.length === 0) {
    idx = [];
    for (let i = 0; i < landmarks.length; i++) {
      if (!isOutOfBounds(landmarks[i])) idx.push(i);
    }
  }
  // 第四步：真的全越界
  if (idx.length === 0) return { x: 0.5, y: 0.5 };

  let x = 0;
  let y = 0;
  for (const i of idx) {
    x += landmarks[i].x;
    y += landmarks[i].y;
  }
  return { x: x / idx.length, y: y / idx.length };
}

/**
 * EMA（指数滑动平均）滤波器
 * 递推公式：value = alpha * cur + (1 - alpha) * prev
 * alpha 越大越"跟手"（平滑弱），alpha 越小越平滑（延迟大）。
 */
export class EmaFilter {
  constructor(alpha = 0.5) {
    this.alpha = alpha;
    this.value = null; // 上一次滤波后的值
  }

  setAlpha(alpha) {
    this.alpha = alpha;
  }

  reset() {
    this.value = null;
  }

  filter(cur) {
    if (this.value === null) {
      // 首帧没有历史值，直接采用当前值，避免从 0 缓慢爬升
      this.value = cur;
    } else {
      this.value = this.alpha * cur + (1 - this.alpha) * this.value;
    }
    return this.value;
  }
}

/**
 * One Euro Filter —— 低延迟自适应滤波
 * 参考：Casiez, Roussel, Vogel (2012) "1€ Filter"
 * 核心思想：速度越快，截止频率自动调高；静止时自动调低，从而同时做到"平滑"和"跟手"。
 */
export class OneEuroFilter {
  constructor({ minCutoff = 1.2, beta = 0.06, freq = 30 } = {}) {
    this.minCutoff = minCutoff; // 最小截止频率(Hz)：静止时的平滑程度，越小越平滑
    this.beta = beta;           // 速度系数：越大越跟手（抖动也越大）
    this.freq = freq;           // 采样频率(Hz)，一般取帧率
    this.x = null;              // 上一次滤波值
    this.dx = 0;                // 上一次估算的速度
    this.lastTime = null;       // 上一次时间戳(ms)
  }

  setParams({ minCutoff, beta, freq }) {
    if (minCutoff !== undefined) this.minCutoff = minCutoff;
    if (beta !== undefined) this.beta = beta;
    if (freq !== undefined) this.freq = freq;
  }

  reset() {
    this.x = null;
    this.dx = 0;
    this.lastTime = null;
  }

  // 由截止频率与时间间隔计算平滑系数 alpha
  alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  filter(cur, time = performance.now()) {
    if (this.x === null) {
      this.x = cur;
      this.lastTime = time;
      return cur;
    }

    // 时间间隔(秒)；异常值用默认采样频率兜底
    let dt = (time - this.lastTime) / 1000;
    if (dt <= 0 || dt > 1) dt = 1 / this.freq;

    // 1) 先对"速度"做一次低通，得到平滑后的速度
    const dAlpha = this.alpha(1.0, dt); // 速度通道采用固定截止频率 1Hz
    const dx = (cur - this.x) / dt;
    this.dx = dAlpha * dx + (1 - dAlpha) * this.dx;

    // 2) 根据速度动态调整截止频率
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);

    // 3) 对"位置"做低通
    const vAlpha = this.alpha(cutoff, dt);
    this.x = vAlpha * cur + (1 - vAlpha) * this.x;
    this.lastTime = time;
    return this.x;
  }
}

/** 滤波方式常量 */
export const FILTER_TYPE = {
  NONE: 'none',
  EMA: 'ema',
  ONE_EURO: 'oneEuro',
};