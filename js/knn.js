/**
 * knn.js —— 自实现的 KNN（K 近邻）分类器 + 关键点归一化
 * 不依赖任何库。用于"自定义手势训练"（第二阶段 4.2）：
 *   1) normalizeHand()：把 21 个关键点做归一化，消除"手离摄像头远近"带来的尺度差异
 *   2) KNN 类：保存已标注样本，对新样本按最近邻投票分类
 */

/**
 * 关键点归一化：以手腕(0)为原点、以"手腕到中指根(9)"的距离为手掌尺度。
 * 这样同一个手势，无论手离镜头近(手掌大)还是远(手掌小)，得到的特征向量都近似一致。
 * @param {Array} landmarks 21 个关键点，每个含 {x, y}（归一化 0~1）
 * @returns {number[]} 长度为 42 的特征向量（21 个点 × x,y）
 */
export function normalizeHand(landmarks) {
  const wrist = landmarks[0];

  // 手掌尺度：手腕到中指根(9)的距离；异常时退化为到食指根(5)的距离，再兜底一个极小值避免除零
  let scale = Math.hypot(landmarks[9].x - wrist.x, landmarks[9].y - wrist.y);
  if (scale < 1e-5) scale = Math.hypot(landmarks[5].x - wrist.x, landmarks[5].y - wrist.y);
  if (scale < 1e-5) scale = 1e-3;

  const feats = [];
  for (let i = 0; i < landmarks.length; i++) {
    feats.push((landmarks[i].x - wrist.x) / scale);
    feats.push((landmarks[i].y - wrist.y) / scale);
  }
  return feats;
}

/** 两向量欧氏距离 */
function euclidean(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s);
}

export class KNN {
  /**
   * @param {number} [k=5] 近邻个数
   */
  constructor(k = 5) {
    this.k = Math.max(1, k);
    this.samples = []; // 每个样本为 { label: string, features: number[] }
  }

  /** 设置 K 值（只取 >=1 的整数） */
  setK(k) {
    this.k = Math.max(1, Math.round(k));
  }

  /**
   * 添加一个已标注样本
   * 防御性校验：标签为空、特征缺失/非法时直接返回并告警，不依赖界面层校验，
   * 避免脏数据进入样本集。
   */
  addSample(label, features) {
    if (typeof label !== 'string' || label.trim() === '') {
      console.warn('[KNN] 忽略无效样本：label 为空或非字符串', label);
      return;
    }
    if (!Array.isArray(features) || features.length === 0) {
      console.warn('[KNN] 忽略无效样本：features 缺失或非法', features);
      return;
    }
    this.samples.push({ label, features });
  }

  /** 样本总数 */
  get count() {
    return this.samples.length;
  }

  /** 每个标签的样本数统计，返回 { label: 数量 } */
  countPerLabel() {
    const m = {};
    for (const s of this.samples) m[s.label] = (m[s.label] || 0) + 1;
    return m;
  }

  /**
   * 对特征向量做分类
   * @param {number[]} features 待分类特征
   * @returns {{label:string|null, confidence:number}} label 为 null 表示无样本；confidence ∈ [0,1]
   */
  predict(features) {
    if (this.samples.length === 0) return { label: null, confidence: 0 };

    // 计算到所有样本的距离并按升序排序
    const dists = this.samples
      .map((s) => ({ label: s.label, d: euclidean(features, s.features) }))
      .sort((a, b) => a.d - b.d);

    // 取最近的 K 个做多数投票
    const k = Math.min(this.k, dists.length);
    const votes = {};
    for (let i = 0; i < k; i++) {
      const l = dists[i].label;
      votes[l] = (votes[l] || 0) + 1;
    }

    let bestLabel = null;
    let bestCount = -1;
    for (const l in votes) {
      if (votes[l] > bestCount) {
        bestLabel = l;
        bestCount = votes[l];
      }
    }
    return { label: bestLabel, confidence: bestCount / k };
  }

  /** 序列化为可导出的 JSON 对象 */
  toJSON() {
    return { k: this.k, samples: this.samples };
  }

  /** 从 JSON 对象恢复 */
  fromJSON(obj) {
    this.k = Math.max(1, obj && obj.k || 5);
    this.samples = Array.isArray(obj && obj.samples) ? obj.samples : [];
    return this;
  }
}