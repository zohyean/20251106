/**
 * handTracker.js —— 使用 MediaPipe HandLandmarker 做手部关键点检测
 * 负责：wasm/model 加载、GPU→CPU 自动降级、逐帧检测
 */
import { HandLandmarker, FilesetResolver } from '../lib/tasks-vision/vision_bundle.mjs';

/**
 * 21 个关键点之间的骨架连线（用于在画布上绘制手部骨架）
 * 顺序按 MediaPipe 手部拓扑：拇指→食指→中指→无名指→小指→掌底
 */
export const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],        // 拇指
  [0, 5], [5, 6], [6, 7], [7, 8],        // 食指
  [5, 9], [9, 10], [10, 11], [11, 12],   // 中指
  [9, 13], [13, 14], [14, 15], [15, 16], // 无名指
  [13, 17], [17, 18], [18, 19], [19, 20],// 小指
  [0, 17],                               // 手掌底边
];

export class HandTracker {
  constructor() {
    this.landmarker = null;    // HandLandmarker 实例
    this.backend = '未初始化';  // 当前推理后端：GPU / CPU
    this.detectTimeMs = 0;     // 单帧检测耗时(ms)
    this.lastResults = null;   // 最近一次检测结果
  }

  /**
   * 初始化检测器
   * @param {object} opt
   * @param {number} [opt.numHands=1]     最多检测手数（本项目固定为 1）
   * @param {string} [opt.wasmPath]       wasm 目录相对路径（相对 index.html）
   * @param {string} [opt.modelPath]      .task 模型相对路径（相对 index.html）
   * @param {number} [opt.minDetection=0.3]  最小检测置信度（0~1，越低越容易检出半只手）
   * @param {number} [opt.minPresence=0.3]   最小存在置信度（0~1）
   * @param {number} [opt.minTracking=0.3]   最小跟踪置信度（0~1）
   */
  async init({
    numHands = 1,
    wasmPath = './lib/tasks-vision/wasm',
    modelPath = './models/hand_landmarker.task',
    minDetection = 0.3,
    minPresence = 0.3,
    minTracking = 0.3,
  } = {}) {
    this.numHands = numHands;

    // 1. 加载 wasm 文件集
    let fileset;
    try {
      fileset = await FilesetResolver.forVisionTasks(wasmPath);
    } catch (err) {
      throw new Error('WASM 加载失败：' + (err && err.message ? err.message : err));
    }

    // 2. 优先使用 GPU delegate 创建（降低三个阈值，让"部分在画面外的手"也能被持续跟踪）
    try {
      this.landmarker = await HandLandmarker.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: modelPath,
          delegate: 'GPU',
          minHandDetectionConfidence: minDetection,
          minHandPresenceConfidence: minPresence,
          minTrackingConfidence: minTracking,
        },
        runningMode: 'VIDEO',
        numHands,
      });
      this.backend = 'GPU';
    } catch (gpuErr) {
      // 3. GPU 失败则自动降级为 CPU
      console.warn('[handTracker] GPU 初始化失败，自动降级为 CPU：', gpuErr);
      this.landmarker = await HandLandmarker.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: modelPath,
          delegate: 'CPU',
          minHandDetectionConfidence: minDetection,
          minHandPresenceConfidence: minPresence,
          minTrackingConfidence: minTracking,
        },
        runningMode: 'VIDEO',
        numHands,
      });
      this.backend = 'CPU';
    }
  }

  /**
   * 对当前视频帧做手部检测
   * @param {HTMLVideoElement} video 摄像头视频元素
   * @param {number} timestampMs 单调递增的时间戳(ms)，VIDEO 模式要求严格递增
   */
  detect(video, timestampMs) {
    const t0 = performance.now();
    this.lastResults = this.landmarker.detectForVideo(video, timestampMs);
    this.detectTimeMs = performance.now() - t0;
    return this.lastResults;
  }

  /** 释放底层资源 */
  close() {
    if (this.landmarker) {
      this.landmarker.close();
      this.landmarker = null;
    }
  }
}