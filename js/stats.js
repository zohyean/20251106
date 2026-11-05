/**
 * stats.js —— 最近 10 局成绩的本地存储（localStorage）
 * 每条记录为 { score: number, time: number|null }，time 为毫秒时间戳（旧数据为纯数字，读取时自动迁移为 time=null）
 */

const STORAGE_KEY = 'hand_brick_recent_scores';
const MAX_SCORES = 10;

/**
 * 保存一局成绩（分数从高到低排序；分数相同时时间新的在前，最多保留 10 条）
 * @param {number} score 本局得分
 * @returns {Array<{score:number,time:number|null}>} 保存后的最新成绩列表
 */
export function saveScore(score) {
  const list = getScores();
  list.push({ score, time: Date.now() });
  list.sort((a, b) => (b.score - a.score) || ((b.time || 0) - (a.time || 0)));
  const top = list.slice(0, MAX_SCORES);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(top));
  } catch (err) {
    console.warn('保存成绩失败（localStorage 不可用）：', err);
  }
  return top;
}

/**
 * 读取最近 10 局成绩（兼容旧格式：纯数字自动转为 {score, time:null}）
 * @returns {Array<{score:number,time:number|null}>}
 */
export function getScores() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .map((n) => {
        if (typeof n === 'number') return { score: n, time: null }; // 旧数据无时间
        if (n && typeof n.score === 'number') return { score: n.score, time: n.time || null };
        return null;
      })
      .filter(Boolean);
  } catch (err) {
    console.warn('读取成绩失败：', err);
    return [];
  }
}