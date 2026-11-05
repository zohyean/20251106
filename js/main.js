/**
 * main.js —— 入口与调度
 * 负责：摄像头获取与自检、UI 事件绑定、检测循环、滤波、手势判定、关键点绘制、HUD 刷新
 */
import { HandTracker, HAND_CONNECTIONS } from './handTracker.js';
import { palmCenterReliable, countOutOfBounds, EmaFilter, OneEuroFilter, FILTER_TYPE } from './filter.js';
import {
  computeFingerStates,
  classifyGesture,
  gestureConfidence,
  GESTURE_NAMES,
  GestureDebouncer,
} from './gesture.js';
import { Game } from './game.js';
import { saveScore, getScores } from './stats.js';
import { KNN, normalizeHand } from './knn.js';
import {
  stddev,
  exportJSON,
  exportCSV,
  buildConfusionMatrix,
  leaveOneOutAccuracies,
  GestureTester,
} from './experiment.js';

// ===================== 配置（相对 index.html 的路径）=====================
const CONFIG = {
  wasmPath: './lib/tasks-vision/wasm',
  modelPath: './models/hand_landmarker.task',
  numHands: 1,
  filterType: FILTER_TYPE.EMA, // 默认使用 EMA
  emaAlpha: 0.5,
  oneEuro: { minCutoff: 1.2, beta: 0.06, freq: 30 },
  debounceN: 5,
  showSkeleton: true,
  // 检测阈值（0.1~0.7，越低越容易检出/跟踪"部分在画面外的手"）
  minDetection: 0.3,
  minPresence: 0.3,
  minTracking: 0.3,
  // 有效控制区域：只把画面中间这段映射到挡板全范围
  effLeft: 0.15,
  effRight: 0.85,
};

// ===================== 稳定性/容错常量（丢失时的时间线，单位：毫秒）=====================
const LOSS_HOLD_MS = 300;          // 丢失后前 300ms：挡板保持不动
const LOSS_EXTRAPOLATE_MS = 800;   // 300~800ms：按衰减速度外推；超过 800ms 才自动暂停
const EXTRAPOLATE_DECAY = 0.9;     // 外推阶段速度每帧乘以 0.9（匀速减速）
const MAX_JUMP = 0.25;             // 单帧位移超过画面宽度 25% 视为异常跳变，忽略该帧
const EDGE_SMOOTH_FACTOR = 0.4;    // 边缘态的平滑增强系数（EMA α 与 OneEuro minCutoff 缩小到 1-0.4=0.6 倍）
const SMOOTH_TRANSITION_RATE = 0.15; // 平滑系数在不同状态间渐变的速度（每帧）

// 手部画面状态
const HAND_STATUS = {
  NORMAL: 'normal', // 越界点 ≤ 2
  EDGE: 'edge',     // 越界点 3~10（手部分在画面外）
  LOST: 'lost',     // 未检测到手
};

// ===================== 运行状态 =====================
const state = {
  tracker: null,       // HandTracker 实例
  stream: null,        // 摄像头 MediaStream
  cameraOn: false,     // 摄像头是否已开启
  fallbackMode: false, // 是否处于键盘/鼠标备用模式（摄像头不可用）
  currentFacing: 'user', // 当前前后摄像头方向
  backend: '未初始化',

  // 滤波（手掌坐标 x、y 各用一套标量滤波器）
  filterX: null,
  filterY: null,
  filteringInited: false,

  // 手掌坐标
  palmRaw: { x: 0.5, y: 0.5 },
  palmFiltered: { x: 0.5, y: 0.5 },

  // 手部画面状态与越界统计
  handStatus: HAND_STATUS.LOST,
  outCount: 0,

  // 平滑强度（0=正常态，1=边缘态，随状态渐变而不突变）
  smoothStrength: 0,

  // 挡板目标（镜像后 0~1）与速度，用于丢失时的保持/外推
  lastTarget: 0.5,
  lastTargetTime: null,
  targetVel: 0,

  // 丢失容错时间线
  lostAt: null,     // 本段丢失的开始时间戳(ms)
  lossLastTs: null, // 丢失阶段上一次处理的时间戳(ms)

  // 单帧位移限制参考量
  prevRawX: null,
  prevRawTime: null,

  // 挡板抖动度缓冲区（最近 2 秒挡板 x 坐标）
  jitterBuf: [],

  // 手势
  rawGesture: 'none',
  gesture: 'noHand',
  confidence: 0,
  debouncer: new GestureDebouncer(CONFIG.debounceN),

  // 性能
  fps: 0,
  frameCount: 0,
  lastFpsTime: 0,
  detectTimeMs: 0,
  perfBuf: [],         // 性能统计滚动缓冲 [{ t, fps, detectMs }]

  // 自定义手势训练（KNN）
  trainSamples: [],    // 训练样本 [{ label, landmarks }]
  trainK: 5,           // KNN 近邻数
  trainKNN: new KNN(5),// 由 trainSamples 构建的分类器（predict 时用）
  lastLandmarks: null, // 最近一次成功检测到的关键点（引用，采集时再快照）

  // 滤波对比采样结果（手动记录）
  filterRecords: [],   // [{ filter, std }]
};

// 游戏与手势联动相关
let game = null;          // Game 实例
let prevGesture = 'none'; // 上一帧"稳定手势"，用于检测手势切换（只触发一次）

// 实验分析相关（第三阶段 4.3）
const TEST_GESTURES = ['open', 'fist', 'point', 'victory']; // 手势识别测试的顺序
const tester = new GestureTester(TEST_GESTURES);            // 手势测试状态机
let envRecords = [];                                        // 环境影响实验记录
const charts = { filter: null, compare: null, perf: null }; // Chart.js 实例

// 游戏状态的界面文案
const GAME_STATE_TEXT = {
  ready: '就绪',
  playing: '进行中',
  paused: '已暂停',
  gameover: '已结束',
  won: '通关',
};

// ===================== DOM 引用 =====================
const dom = {};
function $(id) {
  return document.getElementById(id);
}
function grabDom() {
  dom.video = $('video');
  dom.overlay = $('overlay');
  dom.ctx = dom.overlay.getContext('2d');
  dom.backendBadge = $('backend-badge');
  dom.effLabel = $('eff-label');
  dom.fallbackBanner = $('fallback-banner');
  dom.status = $('status');

  dom.gesture = $('hud-gesture');
  dom.confidence = $('hud-confidence');
  dom.palmPos = $('hud-palm-pos');
  dom.fps = $('hud-fps');
  dom.detectTime = $('hud-detect-time');
  dom.backend = $('hud-backend');
  dom.handStatus = $('hud-hand-status');
  dom.outCount = $('hud-out-count');
  dom.jitter = $('hud-jitter');

  dom.cameraSelect = $('camera-select');
  dom.switchCamera = $('switch-camera');
  dom.showSkeleton = $('show-skeleton');

  dom.filterType = $('filter-type');
  dom.emaAlpha = $('ema-alpha');
  dom.emaAlphaVal = $('ema-alpha-val');
  dom.oneEuroParams = $('oneeuro-params');
  dom.oeMinCutoff = $('oe-mincutoff');
  dom.oeMinCutoffVal = $('oe-mincutoff-val');
  dom.oeBeta = $('oe-beta');
  dom.oeBetaVal = $('oe-beta-val');

  dom.debounceN = $('debounce-n');
  dom.debounceNVal = $('debounce-n-val');

  // 稳定性调优（阈值 / 有效区域）
  dom.minDetection = $('cfg-min-detection');
  dom.minDetectionVal = $('cfg-min-detection-val');
  dom.minPresence = $('cfg-min-presence');
  dom.minPresenceVal = $('cfg-min-presence-val');
  dom.minTracking = $('cfg-min-tracking');
  dom.minTrackingVal = $('cfg-min-tracking-val');
  dom.effLeft = $('cfg-eff-left');
  dom.effLeftVal = $('cfg-eff-left-val');
  dom.effRight = $('cfg-eff-right');
  dom.effRightVal = $('cfg-eff-right-val');

  // 游戏
  dom.gameCanvas = $('game-canvas');
  dom.gameScore = $('game-score');
  dom.gameLives = $('game-lives');
  dom.gameLevel = $('game-level');
  dom.gameDifficulty = $('game-difficulty');
  dom.gameState = $('game-state');
  dom.gameHandStatus = $('game-hand-status');
  dom.recentScores = $('recent-scores');
  dom.paneRecognize = $('pane-recognize');
  dom.paneGame = $('pane-game');
  dom.paneTrain = $('pane-train');
  dom.paneExperiment = $('pane-experiment');

  // 手势训练
  dom.trainLabel = $('train-label');
  dom.trainError = $('train-error');
  dom.trainCapture = $('train-capture');
  dom.trainCapture5 = $('train-capture5');
  dom.trainK = $('train-k');
  dom.trainKVal = $('train-k-val');
  dom.trainCounts = $('train-counts');
  dom.trainKnnResult = $('train-knn-result');
  dom.trainKnnConf = $('train-knn-conf');
  dom.trainExport = $('train-export');
  dom.trainImport = $('train-import');
  dom.trainImportFile = $('train-import-file');
  dom.trainClear = $('train-clear');

  // 实验分析
  dom.expFilterRecord = $('exp-filter-record');
  dom.expFilterClear = $('exp-filter-clear');
  dom.expFilterChart = $('exp-filter-chart');
  dom.expCompare = $('exp-compare');
  dom.expCompareResult = $('exp-compare-result');
  dom.expCompareChart = $('exp-compare-chart');
  dom.expPerfChart = $('exp-perf-chart');
  dom.expTestN = $('exp-test-n');
  dom.expTestNVal = $('exp-test-n-val');
  dom.expTestPrompt = $('exp-test-prompt');
  dom.expTestStart = $('exp-test-start');
  dom.expTestStop = $('exp-test-stop');
  dom.expTestResult = $('exp-test-result');
  dom.expConfusion = $('exp-confusion');
  dom.expTestExport = $('exp-test-export');
  dom.envLight = $('env-light');
  dom.envDist = $('env-dist');
  dom.envBg = $('env-bg');
  dom.envRate = $('env-rate');
  dom.envAdd = $('env-add');
  dom.envTable = $('env-table');
  dom.envExportCsv = $('env-export-csv');
  dom.envExportJson = $('env-export-json');
  dom.envClear = $('env-clear');
}

// ===================== 滤波 =====================
function createScalarFilter() {
  if (CONFIG.filterType === FILTER_TYPE.EMA) return new EmaFilter(CONFIG.emaAlpha);
  if (CONFIG.filterType === FILTER_TYPE.ONE_EURO) return new OneEuroFilter(CONFIG.oneEuro);
  return null; // 无滤波
}

function rebuildFilters() {
  state.filterX = createScalarFilter();
  state.filterY = createScalarFilter();
  resetFilters();
}

function resetFilters() {
  state.filteringInited = false;
  if (state.filterX) state.filterX.reset();
  if (state.filterY) state.filterY.reset();
}

/** 对手掌中心做平滑，返回滤波后的 {x, y} */
function applyFilter(cur) {
  if (!state.filterX) return cur; // 无滤波直接返回
  if (!state.filteringInited) {
    // 首帧直接采用当前值，避免从 0 开启缓慢爬升
    state.filterX.filter(cur.x);
    state.filterY.filter(cur.y);
    state.filteringInited = true;
    return cur;
  }
  return {
    x: state.filterX.filter(cur.x),
    y: state.filterY.filter(cur.y),
  };
}

/**
 * 依据当前 handStatus 平滑强度 增大/减小 滤波器的平滑程度。
 * 边缘态(强度≈1)会给更小的 EMA α / OneEuro minCutoff（更平滑），
 * 正常态(强度≈0)恢复用户设定的原始系数；smoothStrength 渐变保证切换不突变。
 */
function applySmoothingStrength() {
  const s = state.smoothStrength; // 0~1
  if (CONFIG.filterType === FILTER_TYPE.EMA) {
    const alpha = CONFIG.emaAlpha * (1 - EDGE_SMOOTH_FACTOR * s);
    if (state.filterX) state.filterX.setAlpha(alpha);
    if (state.filterY) state.filterY.setAlpha(alpha);
  } else if (CONFIG.filterType === FILTER_TYPE.ONE_EURO) {
    const minCutoff = CONFIG.oneEuro.minCutoff * (1 - EDGE_SMOOTH_FACTOR * s);
    const params = { minCutoff, beta: CONFIG.oneEuro.beta, freq: CONFIG.oneEuro.freq };
    if (state.filterX) state.filterX.setParams(params);
    if (state.filterY) state.filterY.setParams(params);
  }
}

/** 记录挡板 x 坐标并计算最近 2 秒的标准差（抖动度） */
function recordJitter(nowMs) {
  const x = game ? game.paddle.x : 0;
  state.jitterBuf.push({ t: nowMs, x });
  // 丢掉 2 秒以外的样本
  while (state.jitterBuf.length && nowMs - state.jitterBuf[0].t > 2000) {
    state.jitterBuf.shift();
  }
  const n = state.jitterBuf.length;
  if (n < 2) {
    dom.jitter.textContent = '—';
    return;
  }
  const mean = state.jitterBuf.reduce((s, p) => s + p.x, 0) / n;
  const variance = state.jitterBuf.reduce((s, p) => s + (p.x - mean) * (p.x - mean), 0) / n;
  dom.jitter.textContent = Math.sqrt(variance).toFixed(2);
}

/** 手部画面状态 → 中文显示文案 */
function handStatusText(status) {
  if (status === HAND_STATUS.NORMAL) return '正常';
  if (status === HAND_STATUS.EDGE) return '边缘（部分越界）';
  return '丢失（请把手放入画面）';
}

// ===================== 摄像头 =====================
function stopStream() {
  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
  }
}

function getCameraErrorMessage(err) {
  const name = err && err.name;
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return '摄像头权限被拒绝：请在浏览器地址栏允许摄像头权限后刷新页面。';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return '未检测到摄像头设备，请确认已连接摄像头。';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return '摄像头被其他程序占用或无法读取。';
  }
  return '摄像头初始化失败：' + (err && err.message ? err.message : '未知错误');
}

/** 枚举摄像头设备并填充下拉框（需先获得权限才能拿到 label） */
async function enumerateCameras() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter((d) => d.kind === 'videoinput');
    const sel = dom.cameraSelect;
    sel.innerHTML = '';
    cams.forEach((cam, i) => {
      const opt = document.createElement('option');
      opt.value = cam.deviceId;
      opt.textContent = cam.label || '摄像头 ' + (i + 1);
      sel.appendChild(opt);
    });
  } catch (err) {
    console.warn('枚举摄像头失败：', err);
  }
}

/** 启动摄像头 */
async function startCamera(constraints) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('浏览器不支持摄像头 API');
  }
  stopStream();
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  state.stream = stream;
  dom.video.srcObject = stream;

  // 等待视频元数据就绪，让画布尺寸与视频一致
  await new Promise((resolve) => {
    if (dom.video.videoWidth) resolve();
    else dom.video.addEventListener('loadedmetadata', resolve, { once: true });
  });
  dom.overlay.width = dom.video.videoWidth;
  dom.overlay.height = dom.video.videoHeight;

  try {
    await dom.video.play();
  } catch (err) {
    console.warn('自动播放被阻止：', err);
  }

  state.cameraOn = true;
  state.fallbackMode = false;
  dom.fallbackBanner.style.display = 'none';
  dom.status.textContent = '摄像头正常';
  dom.effLabel.style.display = 'block';
  updateEffLabel();
  await enumerateCameras();
}

/** 进入键盘/鼠标备用模式（摄像头不可用时的兜底） */
function enterFallback(err) {
  state.cameraOn = false;
  state.fallbackMode = true;
  dom.effLabel.style.display = 'none';
  const msg = getCameraErrorMessage(err);
  dom.fallbackBanner.textContent = '摄像头不可用，已切换到键盘/鼠标模式（游戏本体将在阶段二实现）。' + msg;
  dom.fallbackBanner.style.display = 'block';
  dom.status.textContent = '键盘/鼠标模式';
}

/** 切换前后摄像头 */
async function switchCamera() {
  const next = state.currentFacing === 'user' ? 'environment' : 'user';
  try {
    await startCamera({ video: { facingMode: { ideal: next } }, audio: false });
    state.currentFacing = next;
  } catch (err) {
    // 某些设备(如笔记本)没有后置摄像头，切换失败时回退
    alert('切换摄像头失败：\n' + getCameraErrorMessage(err));
  }
}

/** 根据下拉框选择的设备切换摄像头 */
async function onCameraSelectChange() {
  const deviceId = dom.cameraSelect.value;
  if (!deviceId) return;
  try {
    await startCamera({ video: { deviceId: { exact: deviceId } }, audio: false });
  } catch (err) {
    alert('切换摄像头失败：\n' + getCameraErrorMessage(err));
  }
}

// ===================== 检测循环 =====================
/** 把任意值限制到 0~1（用于外推后的挡板目标归一化） */
function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** 处理"检测到手"的一帧：越界统计、可靠中心、位移限制、平滑、手势、挡板联动 */
function handleDetectedFrame(landmarks, now) {
  state.lastLandmarks = landmarks; // 供训练采集与 KNN 实时分类使用（引用，采集时再快照）
  const wasLost = state.lostAt !== null;
  state.lostAt = null;
  state.lossLastTs = null;
  if (wasLost) {
    // 手重新出现：跳过首帧位移限制，以当前位置为基准；滤波会平滑过渡回真实位置
    state.prevRawX = null;
    state.prevRawTime = null;
  }

  // 1) 越界统计 → 判定手状态（边缘态只许保持手势、不许切换）
  const outCount = countOutOfBounds(landmarks);
  state.outCount = outCount;
  const handStatus = outCount <= 2 ? HAND_STATUS.NORMAL : HAND_STATUS.EDGE;
  state.handStatus = handStatus;

  // 2) 平滑强度随状态渐变（正常→0，边缘→1），避免参数突变
  const targetStrength = handStatus === HAND_STATUS.EDGE ? 1 : 0;
  state.smoothStrength += (targetStrength - state.smoothStrength) * SMOOTH_TRANSITION_RATE;

  // 3) 可靠关键点加权平均（越界点忽略）
  const raw = palmCenterReliable(landmarks);
  state.palmRaw = raw;

  // 4) 单帧位移限制：与上一帧相差超过 MAX_JUMP 视为异常跳变，本帧忽略（沿用上一滤波值）
  let accepted = raw;
  if (state.prevRawX !== null && state.prevRawTime !== null) {
    const dtSec = (now - state.prevRawTime) / 1000;
    if (dtSec > 0 && Math.abs(raw.x - state.prevRawX) > MAX_JUMP) {
      accepted = null;
    }
  }

  if (accepted) {
    state.prevRawX = accepted.x;
    state.prevRawTime = now;

    applySmoothingStrength();
    state.palmFiltered = applyFilter(accepted);

    // 镜像后目标与速度（供丢失时"保持/外推"使用）
    const target = 1 - state.palmFiltered.x;
    if (state.lastTargetTime !== null) {
      const dtSec = (now - state.lastTargetTime) / 1000;
      if (dtSec > 0) state.targetVel = (target - state.lastTarget) / dtSec;
    }
    state.lastTarget = target;
    state.lastTargetTime = now;

    if (game) game.setPaddleTarget(target);
  }
  // 被忽略的帧：palmFiltered / lastTarget / 挡板均保持上一帧不变

  // 5) 手势判定：仅"正常"状态允许切换，边缘态保持当前手势防误触发
  if (handStatus === HAND_STATUS.NORMAL) {
    const fingerStates = computeFingerStates(landmarks);
    const rawGesture = classifyGesture(fingerStates);
    state.rawGesture = rawGesture;
    state.gesture = state.debouncer.update(rawGesture);
    state.confidence = gestureConfidence(landmarks, fingerStates);
  }

  if (game) handleGameGestures(); // 手势未变化时内部直接 return，不会重复触发

  // 6) 绘制：先画骨架（可选），再画有效区域虚线框（始终显示，提示玩家把手放在框内）
  if (CONFIG.showSkeleton) drawLandmarks(landmarks);
  else clearOverlay();
  drawEffectiveRegion();
}

/** 处理"未检测到手"的丢失容错时间线 */
function handleLoss(now) {
  if (state.lostAt === null) {
    state.lostAt = now;        // 丢失开始
    state.lossLastTs = now;
    // 下次恢复时以新位置为基准，跳过首帧位移限制
    state.prevRawX = null;
    state.prevRawTime = null;
  }
  const dtSec = Math.min((now - state.lossLastTs) / 1000, 0.05);
  state.lossLastTs = now;
  const elapsed = now - state.lostAt;

  state.handStatus = HAND_STATUS.LOST;
  state.outCount = 0;
  state.gesture = 'noHand';
  state.confidence = 0;
  state.debouncer.reset();
  prevGesture = 'none';

  if (elapsed <= LOSS_HOLD_MS) {
    // 前 300ms：保持上一帧位置不动（挡板停住）
    if (game) game.setPaddleTarget(state.lastTarget);
  } else if (elapsed <= LOSS_EXTRAPOLATE_MS) {
    // 300~800ms：按最后速度做衰减式外推（速度每帧 ×0.9）
    state.targetVel *= EXTRAPOLATE_DECAY;
    state.lastTarget = clamp01(state.lastTarget + state.targetVel * dtSec);
    if (game) game.setPaddleTarget(state.lastTarget);
  } else {
    // 超过 800ms：自动暂停并提示"请把手放入画面"
    if (game) {
      game.setPaddleTarget(null); // 交给键盘/鼠标
      game.pause();
    }
  }

  clearOverlay();
  drawEffectiveRegion();
}

function loop(timestamp) {
  requestAnimationFrame(loop);

  if (!state.tracker || !state.cameraOn || dom.video.readyState < 2) {
    if (!state.cameraOn) clearOverlay();
    return;
  }

  // 1. 检测
  let results;
  try {
    results = state.tracker.detect(dom.video, timestamp);
  } catch (err) {
    console.error('检测失败：', err);
    return;
  }
  state.detectTimeMs = state.tracker.detectTimeMs;

  // 2. FPS 统计（每秒刷新一次）
  state.frameCount += 1;
  const now = performance.now();
  if (now - state.lastFpsTime >= 1000) {
    state.fps = (state.frameCount * 1000) / (now - state.lastFpsTime);
    state.frameCount = 0;
    state.lastFpsTime = now;
    // 性能统计：每秒采一个点进滚动缓冲，并刷新实时折线图
    state.perfBuf.push({ t: now, fps: state.fps, detectMs: state.detectTimeMs });
    if (state.perfBuf.length > 120) state.perfBuf.shift();
    updatePerfChart();
  }

  // 3. 处理检测结果
  if (results && results.landmarks && results.landmarks.length > 0) {
    handleDetectedFrame(results.landmarks[0], now);
  } else {
    handleLoss(now);
  }

  // 4. 统计挡板抖动度（记录 game 里实际挡板 x 坐标）
  recordJitter(now);

  updateHud();
  updateTrainingLive();
  updateExperimentLive(now);
}

// ===================== 绘制 =====================
function clearOverlay() {
  if (dom.ctx) dom.ctx.clearRect(0, 0, dom.overlay.width, dom.overlay.height);
}

/**
 * 在叠加画布上绘制 21 个关键点与骨架连线。
 * 视频与画布都通过 CSS 做了水平镜像(scaleX(-1))，因此这里直接按原始归一化坐标绘制即可对齐。
 */
function drawLandmarks(landmarks) {
  const canvas = dom.overlay;
  const ctx = dom.ctx;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // 骨架连线
  ctx.strokeStyle = 'rgba(0, 255, 130, 0.9)';
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  for (const [a, b] of HAND_CONNECTIONS) {
    ctx.beginPath();
    ctx.moveTo(landmarks[a].x * canvas.width, landmarks[a].y * canvas.height);
    ctx.lineTo(landmarks[b].x * canvas.width, landmarks[b].y * canvas.height);
    ctx.stroke();
  }

  // 关键点
  for (let i = 0; i < landmarks.length; i++) {
    const x = landmarks[i].x * canvas.width;
    const y = landmarks[i].y * canvas.height;
    ctx.beginPath();
    ctx.arc(x, y, i === 0 ? 5 : 3, 0, Math.PI * 2);
    ctx.fillStyle = i === 0 ? '#ff5b5b' : '#ffffff';
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

/**
 * 在摄像头画面上画出"有效控制区域"半透明虚线框。
 * 注意坐标换算：游戏里的 effLeft/effRight 是"镜像后屏幕坐标"（与挡板映射一致），
 * 而本画布按"原始未镜像坐标"绘制（整个画布再被 CSS scaleX(-1) 镜像），
 * 原始坐标 x 在屏幕上显示为 (1-x)。所以要让框在屏幕上落在 [effLeft, effRight]，
 * 需画在原始坐标 [1-effRight, 1-effLeft]。
 * 文字标签不在此绘制（画布被镜像会导致文字反向），改由 DOM 元素 #eff-label 显示。
 */
function drawEffectiveRegion() {
  const canvas = dom.overlay;
  const ctx = dom.ctx;
  if (!ctx || !canvas.width) return;
  const x1 = (1 - CONFIG.effRight) * canvas.width;  // 原始坐标下的左边界
  const x2 = (1 - CONFIG.effLeft) * canvas.width;   // 原始坐标下的右边界
  const y1 = canvas.height * 0.08;
  const y2 = canvas.height * 0.92;

  ctx.save();
  ctx.strokeStyle = 'rgba(126, 226, 255, 0.65)';
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 6]);
  ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
  ctx.restore();
}

/** 更新"有效控制区"文字标签的位置（DOM 元素，不随画面镜像，文字始终正向） */
function updateEffLabel() {
  if (!dom.effLabel) return;
  // 屏幕坐标：框的左边界就是 effLeft（镜像后的挡板映射坐标）
  dom.effLabel.style.left = (CONFIG.effLeft * 100) + '%';
}

// ===================== HUD =====================
function updateHud() {
  dom.gesture.textContent = GESTURE_NAMES[state.gesture] || state.gesture;
  dom.confidence.textContent = state.gesture === 'noHand' ? '—' : (state.confidence * 100).toFixed(1) + '%';
  dom.palmPos.textContent =
    '(' + state.palmFiltered.x.toFixed(3) + ', ' + state.palmFiltered.y.toFixed(3) + ')';
  dom.fps.textContent = state.fps.toFixed(1);
  dom.detectTime.textContent = state.detectTimeMs.toFixed(2) + ' ms';
  dom.backend.textContent = state.backend;
  dom.handStatus.textContent = handStatusText(state.handStatus);
  dom.outCount.textContent = state.handStatus === HAND_STATUS.LOST ? '—' : state.outCount;
  dom.gameHandStatus.textContent = handStatusText(state.handStatus);
}

// ===================== 游戏集成 =====================
function initGame() {
  game = new Game(dom.gameCanvas, {
    onUpdate: (g) => {
      dom.gameScore.textContent = g.score;
      dom.gameLives.textContent = g.lives;
      dom.gameLevel.textContent = g.level + ' / ' + 3;
      dom.gameDifficulty.textContent = g.difficulty;
      dom.gameState.textContent = GAME_STATE_TEXT[g.state] || g.state;
    },
    onEnd: (score) => {
      saveScore(score);
      renderRecentScores();
    },
  });
  game.setEffectiveRegion(CONFIG.effLeft, CONFIG.effRight);
  renderRecentScores();
}

/** 把时间戳格式化为 MM-DD HH:mm */
function formatScoreTime(ts) {
  const d = new Date(ts);
  const p2 = (n) => String(n).padStart(2, '0');
  return p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
}

function renderRecentScores() {
  const list = getScores();
  dom.recentScores.innerHTML = '';
  if (list.length === 0) {
    const li = document.createElement('li');
    li.className = 'scores-empty';
    li.textContent = '暂无记录，快来玩一局吧';
    dom.recentScores.appendChild(li);
    return;
  }
  list.forEach((s, i) => {
    const li = document.createElement('li');

    // 序号元素：明确生成，数字来自 index+1，不依赖 <ol> 自动序号
    const rank = document.createElement('span');
    rank.className = 'rank';
    rank.textContent = String(i + 1);
    li.appendChild(rank);

    // 分数：靠左主要位置
    const scoreSpan = document.createElement('span');
    scoreSpan.className = 'score';
    scoreSpan.textContent = s.score + ' 分';
    li.appendChild(scoreSpan);

    // 时间：旧数据无时间则留空，不显示 undefined
    const timeSpan = document.createElement('span');
    timeSpan.className = 'time';
    timeSpan.textContent = s.time ? formatScoreTime(s.time) : '';
    li.appendChild(timeSpan);

    dom.recentScores.appendChild(li);
  });
}

/** 在"稳定手势"发生切换时触发一次游戏动作 */
function handleGameGestures() {
  if (!game) return;
  const g = state.gesture;
  if (g === prevGesture) return;
  prevGesture = g;

  if (g === 'fist') game.launch();                 // 握拳：发球 / 继续
  else if (g === 'point') game.pause();            // 食指：暂停
  else if (g === 'victory') game.switchDifficulty(); // 剪刀手：切换难度
}

/** 切换顶部 Tab */
function switchTab(name) {
  const panes = {
    recognize: dom.paneRecognize,
    game: dom.paneGame,
    train: dom.paneTrain,
    experiment: dom.paneExperiment,
  };
  for (const key in panes) {
    if (panes[key]) panes[key].hidden = key !== name;
  }
  document.querySelectorAll('.tabs button').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === name);
  });
  // 切到实验页时按需初始化图表（隐藏的画布宽度为 0，直接创建会错位）
  if (name === 'experiment') ensureExperimentCharts();
}

// ===================== 手势训练（4.2，KNN） =====================

/** 依据 trainSamples 重建 KNN 分类器并刷新样本数统计 */
function syncKNN() {
  const knn = new KNN(state.trainK);
  for (const s of state.trainSamples) {
    knn.addSample(s.label, normalizeHand(s.landmarks));
  }
  state.trainKNN = knn;
  renderTrainCounts();
}

/** 渲染"每个手势的样本数"表格 */
function renderTrainCounts() {
  const counts = {};
  for (const s of state.trainSamples) counts[s.label] = (counts[s.label] || 0) + 1;
  const labels = Object.keys(counts);
  const table = dom.trainCounts;
  table.innerHTML = '';
  if (labels.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 2;
    td.textContent = '（暂无样本）';
    tr.appendChild(td);
    table.appendChild(tr);
    return;
  }
  for (const l of labels) {
    const tr = document.createElement('tr');
    const td1 = document.createElement('td'); td1.textContent = l;
    const td2 = document.createElement('td'); td2.textContent = counts[l] + ' 个';
    tr.appendChild(td1);
    tr.appendChild(td2);
    table.appendChild(tr);
  }
}

/** 快照当前关键点为一个样本（复制坐标，避免之后被覆盖） */
function snapshotLandmarks() {
  if (!state.lastLandmarks) return null;
  return state.lastLandmarks.map((p) => ({ x: p.x, y: p.y }));
}

// 采集冷却（毫秒）：防止连续快速点击造成重复采样或界面反复刷新
const CAPTURE_COOLDOWN_MS = 200;
let lastCaptureAt = 0;

/** 校验训练输入，返回错误消息；通过返回 null。只做两道前端校验，其余交给 try/catch 兜底。 */
function validateTrainInput(name) {
  if (!name) return '请先输入手势名称';
  if (name.length > 20) return '名称不能超过 20 个字';
  if (!state.lastLandmarks) return '请把手放入画面后再采集';
  return null;
}

/** 显示输入错误：红色小字 + 输入框变红 + 聚焦输入框 */
function showTrainError(msg) {
  if (dom.trainError) dom.trainError.textContent = msg;
  dom.trainLabel.classList.add('invalid');
  dom.trainLabel.focus();
}

/** 清除输入错误提示 */
function clearTrainError() {
  if (dom.trainError) dom.trainError.textContent = '';
  dom.trainLabel.classList.remove('invalid');
}

/** 依据"名称是否为空 / 是否检测到手"更新采集按钮的禁用状态与 title */
function updateTrainButtons() {
  const name = (dom.trainLabel.value || '').trim();
  let reason = '';
  if (!name) reason = '请先输入手势名称';
  else if (!state.lastLandmarks) reason = '请把手放入画面后再采集';
  dom.trainCapture.disabled = !!reason;
  dom.trainCapture5.disabled = !!reason;
  dom.trainCapture.title = reason;
  dom.trainCapture5.title = reason;
}

/** 采集单个样本 */
function captureOne(label) {
  const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  if (now - lastCaptureAt < CAPTURE_COOLDOWN_MS) return; // 冷却期内忽略连点
  try {
    const name = (label || '').trim();
    const err = validateTrainInput(name);
    if (err) { showTrainError(err); return; }
    const lm = snapshotLandmarks(); // 再次防御：关键点可能恰好被清空
    if (!lm) { showTrainError('请把手放入画面后再采集'); return; }
    state.trainSamples.push({ label: name, landmarks: lm });
    syncKNN();
    clearTrainError();
    lastCaptureAt = now;
  } catch (e) {
    console.error('采集样本失败：', e);
    showTrainError('采集失败，请重试');
  }
}

/** 连采多个样本（隔一小段时间，尽量采集略有差异的帧） */
function captureBurst(label, count, gapMs = 250) {
  const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  if (now - lastCaptureAt < CAPTURE_COOLDOWN_MS) return;
  try {
    const name = (label || '').trim();
    const err = validateTrainInput(name);
    if (err) { showTrainError(err); return; }
    lastCaptureAt = now;
    clearTrainError();
    let done = 0;
    const timer = setInterval(() => {
      const lm = snapshotLandmarks();
      if (lm) {
        state.trainSamples.push({ label: name, landmarks: lm });
        syncKNN();
      }
      done += 1;
      if (done >= count) clearInterval(timer);
    }, gapMs);
  } catch (e) {
    console.error('连采样本失败：', e);
    showTrainError('采集失败，请重试');
  }
}

/** 导出训练样本 JSON */
function exportTrainSamples() {
  if (state.trainSamples.length === 0) { alert('没有样本可导出'); return; }
  exportJSON('手势训练样本.json', { k: state.trainK, samples: state.trainSamples });
}

/** 导入训练样本 JSON */
function importTrainSamples(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const obj = JSON.parse(reader.result);
      if (!obj || !Array.isArray(obj.samples)) throw new Error('bad format');
      const samples = obj.samples.filter(
        (s) => s && typeof s.label === 'string' && Array.isArray(s.landmarks)
      );
      if (samples.length === 0) throw new Error('no valid sample');
      state.trainSamples = samples;
      if (typeof obj.k === 'number') state.trainK = Math.max(1, Math.round(obj.k));
      dom.trainK.value = state.trainK;
      dom.trainKVal.textContent = state.trainK;
      syncKNN();
    } catch (err) {
      alert('导入失败：文件不是有效的手势样本 JSON');
    }
  };
  reader.readAsText(file);
}

/** 清空训练样本 */
function clearTrainSamples() {
  state.trainSamples = [];
  syncKNN();
}

/** 训练页实时 KNN 分类显示 */
function updateTrainingLive() {
  updateTrainButtons(); // 每帧更新采集按钮禁用态（反映名称与是否检测到手）
  const resultEl = dom.trainKnnResult;
  const confEl = dom.trainKnnConf;
  if (state.trainSamples.length === 0) {
    resultEl.textContent = '尚无样本';
    confEl.textContent = '—';
    return;
  }
  if (!state.lastLandmarks) {
    resultEl.textContent = '无手';
    confEl.textContent = '—';
    return;
  }
  const r = state.trainKNN.predict(normalizeHand(state.lastLandmarks));
  resultEl.textContent = r.label || '无法判断';
  confEl.textContent = (r.confidence * 100).toFixed(0) + '%';
}

// ===================== 实验分析（4.3） =====================

/** 当前 KNN 分类标签（无样本/无手时返回 null） */
function currentKnnLabel() {
  if (state.trainSamples.length === 0 || !state.lastLandmarks) return null;
  return state.trainKNN.predict(normalizeHand(state.lastLandmarks)).label;
}

/** 最近 2 秒挡板 x 标准差（无手/样本不足返回 null） */
function currentJitterStd() {
  if (state.jitterBuf.length < 2) return null;
  return stddev(state.jitterBuf.map((p) => p.x));
}

const FILTER_LABELS = { none: '无滤波', ema: 'EMA', oneEuro: 'One Euro' };

/** Chart.js 实例（可能未加载） */
function ChartLib() {
  return typeof window !== 'undefined' ? window.Chart : null;
}

/** 深色主题图表基础配置 */
function chartBaseOptions(yTitle) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { labels: { color: '#aebaca' } },
    },
    scales: {
      x: { ticks: { color: '#8fa1b8' }, grid: { color: 'rgba(255,255,255,0.05)' } },
      y: {
        ticks: { color: '#8fa1b8' },
        grid: { color: 'rgba(255,255,255,0.08)' },
        title: { display: true, text: yTitle, color: '#aebaca' },
      },
    },
  };
}

/** 进入实验页时按需创建图表 */
function ensureExperimentCharts() {
  const C = ChartLib();
  if (!C) {
    dom.expCompareResult.textContent = 'Chart.js 未加载，请确认 lib/chart.umd.min.js 存在';
    return;
  }

  if (!charts.filter) {
    charts.filter = new C(dom.expFilterChart, {
      type: 'bar',
      data: {
        labels: ['无滤波', 'EMA', 'One Euro'],
        datasets: [{ label: '挡板抖动标准差', data: [null, null, null], backgroundColor: '#4cc9f0' }],
      },
      options: chartBaseOptions('位置标准差'),
    });
  }

  if (!charts.compare) {
    const opts = chartBaseOptions('准确率');
    opts.scales.y.min = 0;
    opts.scales.y.max = 1;
    charts.compare = new C(dom.expCompareChart, {
      type: 'bar',
      data: {
        labels: ['规则判定', 'KNN 判定'],
        datasets: [{ label: '准确率', data: [0, 0], backgroundColor: ['#7ee2ff', '#80ed99'] }],
      },
      options: opts,
    });
  }

  if (!charts.perf) {
    const perfOpts = chartBaseOptions('FPS');
    perfOpts.scales.y.beginAtZero = true;
    perfOpts.scales.y1 = {
      position: 'right',
      beginAtZero: true,
      grid: { drawOnChartArea: false },
      title: { display: true, text: '耗时(ms)', color: '#aebaca' },
    };
    charts.perf = new C(dom.expPerfChart, {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          { label: 'FPS', data: [], borderColor: '#4cc9f0', backgroundColor: 'transparent', yAxisID: 'y', tension: 0.2 },
          { label: '耗时(ms)', data: [], borderColor: '#f72585', backgroundColor: 'transparent', yAxisID: 'y1', tension: 0.2 },
        ],
      },
      options: perfOpts,
    });
  }

  // 用已有数据回填
  updateFilterChart();
  updatePerfChart();
}

/** 聚合三种滤波的抖动标准差并更新柱状图 */
function updateFilterChart() {
  if (!charts.filter) return;
  const types = ['none', 'ema', 'oneEuro'];
  const data = types.map((t) => {
    const recs = state.filterRecords.filter((r) => r.filter === t);
    if (recs.length === 0) return null;
    return recs.reduce((s, r) => s + r.std, 0) / recs.length;
  });
  charts.filter.data.datasets[0].data = data;
  charts.filter.update();
}

/** 更新"规则 vs KNN"对比柱状图 */
function updateCompareChart(res) {
  if (!charts.compare) return;
  charts.compare.data.datasets[0].data = [res.rule, res.knn];
  charts.compare.update();
}

/** 用滚动缓冲更新性能折线图 */
function updatePerfChart() {
  if (!charts.perf) return;
  const buf = state.perfBuf;
  charts.perf.data.labels = buf.map((_, i) => String(i));
  charts.perf.data.datasets[0].data = buf.map((p) => Math.round(p.fps * 10) / 10);
  charts.perf.data.datasets[1].data = buf.map((p) => Math.round(p.detectMs * 10) / 10);
  charts.perf.update('none');
}

/** 每帧更新训练/实验页状态 */
function updateExperimentLive(now) {
  // 手势识别测试：喂入当前稳定判定（规则 + KNN）
  tester.feed(state.gesture, currentKnnLabel(), now);
  dom.expTestPrompt.textContent = tester.currentPrompt() || '点击「开始测试」后在此提示要做的动作';

  if (tester.running && !tester.done) {
    dom.expTestResult.textContent = '已记录 ' + tester.doneCount + ' 次';
  }
  // 测试刚完成：停止并渲染混淆矩阵
  if (tester.running && tester.done) {
    tester.stop();
    renderConfusionMatrix();
  }
}

/** 在手势测试完成后，用规则判定与 KNN 判定的混淆矩阵+准确率填充结果 */
function renderConfusionMatrix() {
  const labels = TEST_GESTURES;
  const ruleCM = buildConfusionMatrix(labels, tester.records, 'rule');
  const knnCM = buildConfusionMatrix(labels, tester.records, 'knn');
  dom.expTestResult.innerHTML =
    '测试完成，共 ' + tester.doneCount + ' 次。' +
    '规则准确率 <b>' + (ruleCM.accuracy * 100).toFixed(1) + '%</b> · ' +
    'KNN 准确率 <b>' + (knnCM.accuracy * 100).toFixed(1) + '%</b>';

  const container = dom.expConfusion;
  container.innerHTML = '';
  const title1 = document.createElement('h3'); title1.textContent = '规则判定混淆矩阵';
  container.appendChild(title1);
  container.appendChild(matrixTable(ruleCM));
  const title2 = document.createElement('h3'); title2.textContent = 'KNN 判定混淆矩阵';
  container.appendChild(title2);
  container.appendChild(matrixTable(knnCM));
}

/** 由混淆矩阵对象生成 HTML table 元素 */
function matrixTable(cm) {
  const table = document.createElement('table');
  table.className = 'matrix';

  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  const corner = document.createElement('th'); corner.textContent = '实际\\预测'; hr.appendChild(corner);
  for (const c of cm.cols) {
    const th = document.createElement('th'); th.textContent = GESTURE_NAMES[c] || c; hr.appendChild(th);
  }
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  cm.rows.forEach((a, ri) => {
    const tr = document.createElement('tr');
    const th = document.createElement('th'); th.textContent = GESTURE_NAMES[a] || a; tr.appendChild(th);
    cm.cols.forEach((c, ci) => {
      const td = document.createElement('td'); td.textContent = cm.matrix[ri][ci]; tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  return table;
}

/** 运行"规则 vs KNN"留一法对比 */
function runCompare() {
  if (state.trainSamples.length === 0) {
    dom.expCompareResult.textContent = '请先在「手势训练」页采集样本';
    return;
  }
  ensureExperimentCharts();
  const res = leaveOneOutAccuracies(state.trainSamples, state.trainK);
  dom.expCompareResult.innerHTML =
    '样本数 ' + res.n + ' · 规则准确率 <b>' + (res.rule * 100).toFixed(1) + '%</b> · ' +
    'KNN 准确率 <b>' + (res.knn * 100).toFixed(1) + '%</b>';
  updateCompareChart(res);
}

/** 记录当前滤波下的抖动度到对比表 */
function recordFilterSample() {
  const std = currentJitterStd();
  if (std === null) {
    alert('样本不足，请把手放稳约 2 秒再点记录');
    return;
  }
  state.filterRecords.push({ filter: CONFIG.filterType, std });
  ensureExperimentCharts();
  updateFilterChart();
}

// ===================== 环境影响实验（手动录入） =====================

/** 渲染环境影响记录表 */
function renderEnvTable() {
  const table = dom.envTable;
  table.innerHTML = '';
  if (envRecords.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 4;
    td.textContent = '（暂无记录）';
    tr.appendChild(td);
    table.appendChild(tr);
    return;
  }
  const header = ['光线', '距离', '背景', '成功率 %'].map((h) => {
    const th = document.createElement('th'); th.textContent = h; return th;
  });
  const hr = document.createElement('tr');
  header.forEach((th) => hr.appendChild(th));
  table.appendChild(hr);

  for (const r of envRecords) {
    const tr = document.createElement('tr');
    [r.light, r.dist, r.bg, r.rate].forEach((v) => {
      const td = document.createElement('td'); td.textContent = v; tr.appendChild(td);
    });
    table.appendChild(tr);
  }
}

/** 添加一条环境影响记录 */
function addEnvRecord() {
  const rate = parseFloat(dom.envRate.value);
  if (isNaN(rate)) { alert('请填写有效的成功率'); return; }
  envRecords.push({
    light: dom.envLight.value,
    dist: dom.envDist.value,
    bg: dom.envBg.value,
    rate: Math.min(100, Math.max(0, rate)),
  });
  renderEnvTable();
}

// ===================== 检测器重建（检测阈值调整后重建生效）=====================
/** 依据 CONFIG 里的当前阈值重建检测器（阈值是创建期参数，改动后需重建） */
async function reinitTracker() {
  if (!state.tracker) return;
  const tracker = state.tracker;
  try {
    tracker.close();
    await tracker.init({
      numHands: CONFIG.numHands,
      wasmPath: CONFIG.wasmPath,
      modelPath: CONFIG.modelPath,
      minDetection: CONFIG.minDetection,
      minPresence: CONFIG.minPresence,
      minTracking: CONFIG.minTracking,
    });
    state.backend = tracker.backend;
    dom.backendBadge.textContent = '后端：' + tracker.backend;
  } catch (err) {
    alert('更新检测阈值失败：\n' + err.message);
  }
}

// ===================== UI 事件 =====================
function bindEvents() {
  // Tab 切换
  document.querySelectorAll('.tabs button').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  dom.switchCamera.addEventListener('click', switchCamera);
  dom.cameraSelect.addEventListener('change', onCameraSelectChange);
  dom.showSkeleton.addEventListener('change', () => {
    CONFIG.showSkeleton = dom.showSkeleton.checked;
    if (!CONFIG.showSkeleton) clearOverlay();
  });

  // 滤波方式切换
  dom.filterType.addEventListener('change', () => {
    CONFIG.filterType = dom.filterType.value;
    dom.oneEuroParams.style.display = CONFIG.filterType === FILTER_TYPE.ONE_EURO ? 'block' : 'none';
    rebuildFilters();
  });

  // EMA 系数（防抖更新 + 显示）
  dom.emaAlpha.addEventListener('input', () => {
    const v = parseFloat(dom.emaAlpha.value);
    dom.emaAlphaVal.textContent = v.toFixed(2);
    CONFIG.emaAlpha = v;
    if (CONFIG.filterType === FILTER_TYPE.EMA) {
      if (state.filterX) state.filterX.setAlpha(v);
      if (state.filterY) state.filterY.setAlpha(v);
    }
  });

  // One Euro 参数
  function updateOneEuro() {
    const minCutoff = parseFloat(dom.oeMinCutoff.value);
    const beta = parseFloat(dom.oeBeta.value);
    dom.oeMinCutoffVal.textContent = minCutoff.toFixed(2);
    dom.oeBetaVal.textContent = beta.toFixed(2);
    CONFIG.oneEuro = { minCutoff, beta, freq: CONFIG.oneEuro.freq };
    if (CONFIG.filterType === FILTER_TYPE.ONE_EURO) {
      if (state.filterX) state.filterX.setParams(CONFIG.oneEuro);
      if (state.filterY) state.filterY.setParams(CONFIG.oneEuro);
    }
  }
  dom.oeMinCutoff.addEventListener('input', updateOneEuro);
  dom.oeBeta.addEventListener('input', updateOneEuro);

  // 防抖帧数
  dom.debounceN.addEventListener('input', () => {
    const n = parseInt(dom.debounceN.value, 10);
    dom.debounceNVal.textContent = n;
    CONFIG.debounceN = n;
    state.debouncer.setN(n);
  });

  // 检测阈值：input 只更新显示，change（松手）才重建检测器，避免频繁重载模型
  function bindThreshold(slider, valEl, key) {
    slider.addEventListener('input', () => {
      valEl.textContent = parseFloat(slider.value).toFixed(2);
    });
    slider.addEventListener('change', () => {
      CONFIG[key] = parseFloat(slider.value);
      reinitTracker();
    });
  }
  bindThreshold(dom.minDetection, dom.minDetectionVal, 'minDetection');
  bindThreshold(dom.minPresence, dom.minPresenceVal, 'minPresence');
  bindThreshold(dom.minTracking, dom.minTrackingVal, 'minTracking');

  // 有效控制区域：左右边界（保证 left < right - 0.1，避免区域过窄除零/反转）
  function applyEffRegion() {
    const right = parseFloat(dom.effRight.value);
    let left = parseFloat(dom.effLeft.value);
    if (left >= right - 0.1) left = Math.max(0.05, right - 0.1);
    CONFIG.effLeft = left;
    CONFIG.effRight = right;
    dom.effLeftVal.textContent = left.toFixed(2);
    dom.effRightVal.textContent = right.toFixed(2);
    if (game) game.setEffectiveRegion(left, right);
    updateEffLabel(); // 标签位置跟着左边界走
  }
  dom.effLeft.addEventListener('input', () => {
    dom.effLeftVal.textContent = parseFloat(dom.effLeft.value).toFixed(2);
    applyEffRegion();
  });
  dom.effRight.addEventListener('input', () => {
    dom.effRightVal.textContent = parseFloat(dom.effRight.value).toFixed(2);
    applyEffRegion();
  });

  // ===== 手势训练（4.2） =====
  dom.trainLabel.addEventListener('input', () => {
    clearTrainError();      // 用户开始输入后，错误提示自动消失
    updateTrainButtons();
  });
  dom.trainCapture.addEventListener('click', () => captureOne(dom.trainLabel.value));
  dom.trainCapture5.addEventListener('click', () => captureBurst(dom.trainLabel.value, 5));
  dom.trainClear.addEventListener('click', clearTrainSamples);
  dom.trainExport.addEventListener('click', exportTrainSamples);
  dom.trainImport.addEventListener('click', () => dom.trainImportFile.click());
  dom.trainImportFile.addEventListener('change', (e) => {
    if (e.target.files && e.target.files[0]) importTrainSamples(e.target.files[0]);
    e.target.value = '';
  });
  dom.trainK.addEventListener('input', () => {
    state.trainK = parseInt(dom.trainK.value, 10);
    dom.trainKVal.textContent = state.trainK;
    syncKNN();
  });

  // ===== 实验分析（4.3） =====
  dom.expFilterRecord.addEventListener('click', recordFilterSample);
  dom.expFilterClear.addEventListener('click', () => {
    state.filterRecords = [];
    updateFilterChart();
  });
  dom.expCompare.addEventListener('click', runCompare);

  dom.expTestN.addEventListener('input', () => {
    const n = parseInt(dom.expTestN.value, 10);
    dom.expTestNVal.textContent = n;
    tester.setN(n);
  });
  dom.expTestStart.addEventListener('click', () => {
    dom.expConfusion.innerHTML = '';
    dom.expTestResult.textContent = '';
    tester.start();
  });
  dom.expTestStop.addEventListener('click', () => {
    tester.stop();
    if (tester.doneCount > 0) renderConfusionMatrix();
  });
  dom.expTestExport.addEventListener('click', () => {
    if (tester.doneCount === 0) { alert('还没有测试记录'); return; }
    const ruleCM = buildConfusionMatrix(TEST_GESTURES, tester.records, 'rule');
    const knnCM = buildConfusionMatrix(TEST_GESTURES, tester.records, 'knn');
    exportJSON('手势识别测试结果.json', {
      n: tester.n,
      records: tester.records,
      ruleAccuracy: ruleCM.accuracy,
      knnAccuracy: knnCM.accuracy,
      ruleMatrix: ruleCM,
      knnMatrix: knnCM,
    });
  });

  // ===== 环境影响实验 =====
  dom.envAdd.addEventListener('click', addEnvRecord);
  dom.envClear.addEventListener('click', () => { envRecords = []; renderEnvTable(); });
  dom.envExportCsv.addEventListener('click', () => {
    if (envRecords.length === 0) { alert('还没有记录'); return; }
    exportCSV('环境影响实验.csv', ['光线', '距离', '背景', '成功率%'],
      envRecords.map((r) => [r.light, r.dist, r.bg, r.rate]));
  });
  dom.envExportJson.addEventListener('click', () => {
    if (envRecords.length === 0) { alert('还没有记录'); return; }
    exportJSON('环境影响实验.json', envRecords);
  });
}

// ===================== 启动 =====================
/** 开启摄像头（独立执行，失败则进入备用模式） */
async function initCamera() {
  try {
    await startCamera({ video: { facingMode: { ideal: 'user' } }, audio: false });
  } catch (err) {
    enterFallback(err); // 不白屏，进入备用模式
  }
}

/** 初始化手部检测器（独立执行，模型/wasm 加载不受摄像头影响） */
async function initTracker() {
  try {
    const tracker = new HandTracker();
    await tracker.init({
      numHands: CONFIG.numHands,
      wasmPath: CONFIG.wasmPath,
      modelPath: CONFIG.modelPath,
      minDetection: CONFIG.minDetection,
      minPresence: CONFIG.minPresence,
      minTracking: CONFIG.minTracking,
    });
    state.tracker = tracker;
    state.backend = tracker.backend;
    dom.backendBadge.textContent = '后端：' + tracker.backend;
    dom.backendBadge.style.display = 'block';
  } catch (err) {
    state.backend = '加载失败';
    dom.backendBadge.textContent = '后端：加载失败';
    dom.backendBadge.style.display = 'block';
    alert(
      '手部模型或 WASM 加载失败：\n' + err.message +
      '\n\n请确认项目里的 lib/tasks-vision 与 models/hand_landmarker.task 文件齐全，' +
      '并通过本地服务器（http://localhost）访问本页。'
    );
  }
}

function init() {
  grabDom();
  bindEvents();
  updateTrainButtons(); // 初始化采集按钮禁用态
  rebuildFilters();
  updateHud();
  initGame();
  syncKNN();        // 初始 KNN（空样本）并渲染样本数表
  renderEnvTable(); // 初始环境影响记录表
  switchTab('recognize');

  // 摄像头与模型检测相互独立、并行进行，避免摄像头挂起/被拒阻塞模型加载
  initCamera();
  initTracker();

  requestAnimationFrame(loop);
}

init();