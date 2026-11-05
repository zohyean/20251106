/**
 * experiment.js —— 实验分析相关的纯逻辑与工具（第二阶段 4.3）
 * 提供：统计辅助、混淆矩阵、规则 vs KNN 留一法对比、手势识别测试状态机、数据导出
 * 不直接操作 DOM，由 main.js 调用并在界面上渲染。
 */
import { KNN, normalizeHand } from './knn.js';
import { computeFingerStates, classifyGesture } from './gesture.js';

// ===================== 统计辅助 =====================

/** 均值 */
export function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

/** 总体标准差（用于衡量抖动程度） */
export function stddev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const variance = arr.reduce((a, b) => a + (b - m) * (b - m), 0) / arr.length;
  return Math.sqrt(variance);
}

// ===================== 数据导出 =====================

/** 触发浏览器下载一个文本文件 */
export function downloadText(filename, text, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** 导出 JSON 文件 */
export function exportJSON(filename, obj) {
  downloadText(filename, JSON.stringify(obj, null, 2), 'application/json;charset=utf-8');
}

/**
 * 导出 CSV 文件（自动加 BOM，方便 Excel 打开中文）
 * @param {string} filename 文件名
 * @param {string[]} headers 表头
 * @param {Array<Array|object>} rows 每行数据：数组按列顺序，对象按键名取列
 */
export function exportCSV(filename, headers, rows) {
  const esc = (v) => {
    const s = String(v === undefined || v === null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [headers.map(esc).join(',')];
  for (const r of rows) {
    if (Array.isArray(r)) lines.push(r.map(esc).join(','));
    else lines.push(headers.map((h) => esc(r[h])).join(','));
  }
  downloadText(filename, '\ufeff' + lines.join('\n'), 'text/csv;charset=utf-8');
}

// ===================== 混淆矩阵 =====================

/**
 * 由测试记录构建混淆矩阵
 * @param {string[]} labels 期望的"实际"手势顺序（作为行）
 * @param {Array} records 每条为 { actual, rule, knn }
 * @param {'rule'|'knn'} predKey 用哪一列作为预测
 * @returns {{rows:string[], cols:string[], matrix:number[][], accuracy:number, total:number}}
 *          matrix[r][c] = 实际为 rows[r] 却被预测为 cols[c] 的次数
 */
export function buildConfusionMatrix(labels, records, predKey) {
  const cols = new Set(labels);
  for (const r of records) {
    const p = r[predKey];
    if (p !== null && p !== undefined && p !== '') cols.add(p);
  }
  const colArr = Array.from(cols);

  const matrix = [];
  let totalCorrect = 0;
  let total = 0;
  for (const a of labels) {
    const row = colArr.map((c) => records.filter((r) => r.actual === a && r[predKey] === c).length);
    matrix.push(row);
    const correctCount = records.filter((r) => r.actual === a && r[predKey] === a).length;
    totalCorrect += correctCount;
    total += records.filter((r) => r.actual === a).length;
  }
  return {
    rows: labels,
    cols: colArr,
    matrix,
    accuracy: total ? totalCorrect / total : 0,
    total,
  };
}

// ===================== 规则 vs KNN（留一法） =====================

/**
 * 在训练样本上做"留一法"对比规则判定与 KNN 判定的准确率。
 * 说明：样本既可用规则判定（直接对原始关键点），也可用 KNN（先归一化）。
 * KNN 采用留一法（每次用除自己外的所有样本训练，再预测自己），避免"自己测自己"虚高。
 * @param {Array<{label:string, landmarks:Array}>} samples 训练样本
 * @param {number} k KNN 近邻数
 * @returns {{rule:number, knn:number, n:number}}
 */
export function leaveOneOutAccuracies(samples, k) {
  const n = samples.length;
  if (n === 0) return { rule: 0, knn: 0, n: 0 };

  const feats = samples.map((s) => normalizeHand(s.landmarks));
  let ruleCorrect = 0;
  let knnCorrect = 0;

  for (let i = 0; i < n; i++) {
    // 规则判定
    const rulePred = classifyGesture(computeFingerStates(samples[i].landmarks));
    if (rulePred === samples[i].label) ruleCorrect++;

    // KNN 留一法
    const knn = new KNN(k);
    for (let j = 0; j < n; j++) {
      if (j !== i) knn.addSample(samples[j].label, feats[j]);
    }
    const r = knn.predict(feats[i]);
    if (r.label === samples[i].label) knnCorrect++;
  }

  return { rule: ruleCorrect / n, knn: knnCorrect / n, n };
}

// ===================== 手势识别测试状态机 =====================

/**
 * 手势识别测试：
 * 依次提示用户做每种手势若干次，自动记录"实际提示手势 vs 规则判定 vs KNN 判定"。
 * 记录规则：检测到手且手势稳定、且上一次记录后经过冷却并出现"复位(无手/未识别)"，
 * 才记录下一次，避免一次持续手势被重复计数。
 */
export class GestureTester {
  /**
   * @param {string[]} [labels=['open','fist','point','victory']] 待测手势列表
   */
  constructor(labels = ['open', 'fist', 'point', 'victory']) {
    this.labels = labels;
    this.n = 3;              // 每种手势做多少次
    this.running = false;
    this.li = 0;             // 当前手势索引
    this.ri = 0;             // 当前手势已做次数
    this.records = [];       // [{ actual, rule, knn }]
    this.armed = true;       // 是否允许记录（需先时光复位）
    this.cooldownUntil = 0;  // 冷却截止时间戳(ms)
  }

  setN(n) {
    this.n = Math.max(1, Math.round(n));
  }

  /** 开始/重置测试 */
  start() {
    this.running = true;
    this.li = 0;
    this.ri = 0;
    this.records = [];
    this.armed = true;
    this.cooldownUntil = 0;
  }

  stop() {
    this.running = false;
  }

  /** 是否已测完全部手势 */
  get done() {
    return this.li >= this.labels.length;
  }

  /** 已记录次数 */
  get doneCount() {
    return this.records.length;
  }

  /** 当前该做什么的提示文案 */
  currentPrompt() {
    if (!this.running) return '测试未开始';
    if (this.done) return '测试完成！';
    return '请做手势「' + this.labels[this.li] + '」（第 ' + (this.ri + 1) + '/' + this.n + ' 次）';
  }

  /**
   * 每帧喂入当前稳定手势
   * @param {string} rule 当前规则判定（已防抖稳定值）
   * @param {string|null} knn 当前 KNN 判定（无样本时为 null）
   * @param {number} [now=performance.now()] 当前时间戳(ms)
   */
  feed(rule, knn, now = performance.now()) {
    if (!this.running || this.done) return;
    if (now < this.cooldownUntil) return;

    // 手复位（无手/未识别）时重新"武装"，等待下一次做手势
    if (rule === 'none' || rule === 'noHand' || rule === null) {
      this.armed = true;
      return;
    }
    if (!this.armed) return;

    // 记录一次：实际=提示手势，预测=当前稳定手势与 KNN 结果
    this.records.push({ actual: this.labels[this.li], rule, knn: knn || null });
    this.armed = false;
    this.cooldownUntil = now + 1200; // 冷却，让用户把手放下复位

    // 前进：当前手势次数 +1，做满 n 次进入下一个手势
    this.ri += 1;
    if (this.ri >= this.n) {
      this.ri = 0;
      this.li += 1;
    }
  }
}