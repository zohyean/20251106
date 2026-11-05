/**
 * gesture.js —— 基于 21 个关键点的规则手势判定
 * 关键点索引（MediaPipe HandLandmarker）：
 *   0 手腕；1~4 拇指；5~8 食指；9~12 中指；13~16 无名指；17~20 小指
 */

/** 两点欧氏距离（归一化坐标，直接计算即可） */
function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * 拇指伸直判定（单独处理：拇指是横向伸展，不能用与其他手指相同的竖直比较）
 * 比较 拇指指尖(4) 与 拇指指间关节(3) 到 食指根(5) 的距离：
 * 拇指指尖比 IP 关节更远离食指根，说明拇指横向张开了。
 */
function thumbExtended(landmarks) {
  const idxMCP = landmarks[5];
  return dist(idxMCP, landmarks[4]) > dist(idxMCP, landmarks[3]);
}

/**
 * 其余四指伸直判定
 * 判据：指尖到手腕的距离 > 该指 PIP 关节到手腕的距离。
 * 该判据与手掌旋转、距离摄像头远近基本无关，比直接用 y 坐标比较更鲁棒。
 * @param {Array} landmarks 21 个关键点
 * @param {number} tipIdx 指尖索引
 * @param {number} pipIdx PIP 关节索引
 */
function fingerExtended(landmarks, tipIdx, pipIdx) {
  const wrist = landmarks[0];
  return dist(wrist, landmarks[tipIdx]) > dist(wrist, landmarks[pipIdx]);
}

/**
 * 计算 5 根手指的伸直/弯曲状态
 * @returns {{thumb:boolean, index:boolean, middle:boolean, ring:boolean, pinky:boolean}}
 *          true 表示伸直，false 表示弯曲
 */
export function computeFingerStates(landmarks) {
  return {
    thumb: thumbExtended(landmarks),
    index: fingerExtended(landmarks, 8, 6),    // 食指 TIP=8 PIP=6
    middle: fingerExtended(landmarks, 12, 10), // 中指 TIP=12 PIP=10
    ring: fingerExtended(landmarks, 16, 14),   // 无名指 TIP=16 PIP=14
    pinky: fingerExtended(landmarks, 20, 18),  // 小指 TIP=20 PIP=18
  };
}

/**
 * 手势分类（基于规则）
 * @param {object} states computeFingerStates 的返回值
 * @returns {string} open / fist / point / victory / none
 */
export function classifyGesture(states) {
  const { thumb, index, middle, ring, pinky } = states;
  // 除拇指外伸直的手指数量
  const fourExtended = [index, middle, ring, pinky].filter(Boolean).length;

  // 张开手掌：五指全伸直
  if (thumb && fourExtended === 4) return 'open';
  // 握拳：五指全弯曲
  if (!thumb && fourExtended === 0) return 'fist';
  // 剪刀手：食指、中指伸直，其余弯曲
  if (index && middle && !ring && !pinky) return 'victory';
  // 食指单指：仅食指伸直（指向时拇指常自然微张，故不强制拇指状态）
  if (index && !middle && !ring && !pinky) return 'point';

  return 'none';
}

/** 手势对应的中文名称 */
export const GESTURE_NAMES = {
  open: '张开手掌',
  fist: '握拳',
  point: '食指单指',
  victory: '剪刀手',
  none: '未识别',
  noHand: '无手',
};

/**
 * 置信度估算（启发式，0~1）
 * 用每根手指"伸直/弯曲"距判定阈值的余量来估计：关键手指越远离阈值，置信度越高。
 */
export function gestureConfidence(landmarks, states) {
  // [指尖索引, 参照关节索引, 是否期望伸直]
  const fingers = [
    [4, 3, states.thumb],
    [8, 6, states.index],
    [12, 10, states.middle],
    [16, 14, states.ring],
    [20, 18, states.pinky],
  ];
  const wrist = landmarks[0];
  let sum = 0;
  for (const [tipIdx, refIdx, wantExtended] of fingers) {
    const dTip = dist(wrist, landmarks[tipIdx]);
    const dRef = dist(wrist, landmarks[refIdx]);
    // 伸直时希望 dTip > dRef；弯曲时希望 dTip < dRef
    const ratio = wantExtended ? dTip / dRef : dRef / dTip;
    // ratio >= 1 表示符合预期；余量 0.5 时置信度拉满
    const c = Math.max(0, Math.min(1, (ratio - 1) / 0.5 + 0.5));
    sum += c;
  }
  return sum / fingers.length;
}

/**
 * 手势防抖器：连续 N 帧判出同一手势，才把它确认为"当前手势"。
 * 用于抑制单帧误判造成的手势来回跳动。
 */
export class GestureDebouncer {
  constructor(n = 5) {
    this.n = Math.max(1, n);
    this.current = 'none'; // 已确认的稳定手势
    this.pending = 'none'; // 正在累积中的候选手势
    this.count = 0;
  }

  setN(n) {
    this.n = Math.max(1, n);
  }

  reset() {
    this.current = 'none';
    this.pending = 'none';
    this.count = 0;
  }

  /**
   * 送入当前帧识别出的手势，返回经过防抖后的稳定手势
   */
  update(gesture) {
    if (gesture === this.pending) {
      this.count += 1;
      if (this.count >= this.n) {
        this.current = this.pending;
      }
    } else {
      this.pending = gesture;
      this.count = 1;
    }
    return this.current;
  }
}