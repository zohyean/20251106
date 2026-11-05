/**
 * game.js —— 打砖块游戏（画布渲染 + 物理碰撞 + 键盘/鼠标/手势三种输入）
 * 对外提供 Game 类，由 main.js 驱动：
 *   - setPaddleTarget(v)  手势控制挡板（v 为镜像后的归一化 0~1）
 *   - launch()            发球/继续（握拳 / 空格 / 鼠标点击）
 *   - pause()             暂停（食指手势）
 *   - switchDifficulty()  切换难度（剪刀手手势）
 *   - callback.onUpdate   状态变化时回传 HUD 数据
 *   - callback.onEnd      游戏结束/通关时回传最终分数
 */

// 难度配置：影响球速与砖块行数（剪刀手手势循环切换）
const DIFFICULTIES = [
  { name: '简单', ballSpeed: 340, brickRows: 4 },
  { name: '普通', ballSpeed: 420, brickRows: 5 },
  { name: '困难', ballSpeed: 520, brickRows: 6 },
];

const MAX_LEVEL = 3;      // 总关卡数
const BRICK_COLS = 8;     // 砖块每行数量

// 砖块配色（按行循环取色）
const ROW_COLORS = ['#4cc9f0', '#f72585', '#ffb703', '#80ed99', '#c77dff', '#ff8c42'];

export class Game {
  constructor(canvas, callbacks = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cb = callbacks;

    // 固定逻辑分辨率，CSS 再做等比缩放
    this.W = 720;
    this.H = 520;
    canvas.width = this.W;
    canvas.height = this.H;

    // 挡板（x 为中心坐标）
    this.paddle = { x: this.W / 2, y: this.H - 46, w: 110, h: 14 };
    // 小球
    this.ball = { x: this.W / 2, y: this.H - 70, r: 9, vx: 0, vy: 0 };

    this.difficultyIndex = 0; // 0 简单 / 1 普通 / 2 困难
    this.level = 1;           // 当前关卡 1..3
    this.score = 0;
    this.lives = 3;

    this.state = 'ready';     // ready / playing / paused / gameover / won
    this.bricks = [];
    this.particles = [];      // 击碎动画粒子

    // 输入状态
    this.keys = { left: false, right: false };
    this.mouseX = null;       // 鼠标在画布逻辑坐标系中的 X（null 表示未使用）
    this.paddleTarget = null; // 手势挡板目标（归一化 0~1，null 表示无手）

    // 有效区域映射：只把画面中间 [effLeft, effRight] 映射到挡板整个移动范围，
    // 超出部分直接 clamp 到两端，玩家无需把手伸到画面边缘。
    this.effLeft = 0.15;
    this.effRight = 0.85;

    this.buildLevel();
    this.bindInput();

    this.lastTime = performance.now();
    requestAnimationFrame((t) => this.tick(t));
  }

  get difficulty() {
    return DIFFICULTIES[this.difficultyIndex];
  }

  // ============ 关卡与砖块 ============
  /** 依据当前关卡与难度构建砖块布局，并把球放回挡板 */
  buildLevel() {
    const rows = this.difficulty.brickRows;
    const gap = 6;
    const margin = 40;
    const topY = 70;
    const brickH = 22;
    const brickW = (this.W - margin * 2 - gap * (BRICK_COLS - 1)) / BRICK_COLS;

    this.bricks = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < BRICK_COLS; c++) {
        // 三关布局不同：
        // 第 1 关：完整矩阵；第 2 关：中间一行留空；第 3 关：棋盘镂空
        let skip = false;
        if (this.level === 2 && r === Math.floor(rows / 2)) skip = true;
        if (this.level === 3 && (r + c) % 2 === 1) skip = true;
        if (skip) continue;

        this.bricks.push({
          x: margin + c * (brickW + gap),
          y: topY + r * (brickH + gap),
          w: brickW,
          h: brickH,
          color: ROW_COLORS[r % ROW_COLORS.length],
          alive: true,
        });
      }
    }
    this.resetBall();
  }

  /** 球放回挡板上方，进入发球准备状态 */
  resetBall() {
    this.ball.x = this.paddle.x;
    this.ball.y = this.paddle.y - this.paddle.h / 2 - this.ball.r - 1;
    this.ball.vx = 0;
    this.ball.vy = 0;
    this.state = 'ready';
  }

  // ============ 输入绑定 ============
  bindInput() {
    window.addEventListener('keydown', this.onKeyDown = (e) => {
      if (e.code === 'ArrowLeft') this.keys.left = true;
      else if (e.code === 'ArrowRight') this.keys.right = true;
      else if (e.code === 'Space') { e.preventDefault(); this.launch(); }
    });
    window.addEventListener('keyup', this.onKeyUp = (e) => {
      if (e.code === 'ArrowLeft') this.keys.left = false;
      else if (e.code === 'ArrowRight') this.keys.right = false;
    });
    this.canvas.addEventListener('mousemove', this.onMouseMove = (e) => {
      const rect = this.canvas.getBoundingClientRect();
      // 把鼠标 CSS 坐标映射回画布逻辑坐标系
      this.mouseX = ((e.clientX - rect.left) / rect.width) * this.W;
    });
    this.canvas.addEventListener('mousedown', this.onMouseDown = () => this.launch());
  }

  // ============ 外部控制接口（供 main.js 调用）============

  /** 手势控制挡板：v 为镜像后的归一化横坐标 0~1（null 表示无手，改用键盘/鼠标） */
  setPaddleTarget(v) {
    this.paddleTarget = v;
  }

  /** 设置手势有效控制区域的左右边界（归一化 0~1，用于挡板映射） */
  setEffectiveRegion(left, right) {
    this.effLeft = left;
    this.effRight = right;
  }

  /** 发球/继续：就绪时发球，暂停时继续，结束后重新开始 */
  launch() {
    if (this.state === 'ready') {
      // 以一定向上夹角发球，速度按当前难度
      const speed = this.difficulty.ballSpeed;
      const ang = -Math.PI / 2 + (Math.random() - 0.5) * 0.6; // 向上，略偏左右
      this.ball.vx = Math.cos(ang) * speed;
      this.ball.vy = Math.sin(ang) * speed;
      this.state = 'playing';
      playBeep(330, 0.08, 'square');
      this.emit();
    } else if (this.state === 'paused') {
      this.state = 'playing';
      this.emit();
    } else if (this.state === 'gameover' || this.state === 'won') {
      this.startGame();
    }
  }

  pause() {
    if (this.state === 'playing') {
      this.state = 'paused';
      this.emit();
    }
  }

  /** 剪刀手：循环切换难度，切换后重建当前关卡并回到就绪状态 */
  switchDifficulty() {
    this.difficultyIndex = (this.difficultyIndex + 1) % DIFFICULTIES.length;
    this.buildLevel();
    this.emit();
  }

  /** 重新开始一局（保留难度） */
  startGame() {
    this.score = 0;
    this.lives = 3;
    this.level = 1;
    this.buildLevel();
    this.emit();
  }

  // ============ 主循环 ============
  tick(t) {
    const dt = Math.min((t - this.lastTime) / 1000, 0.05); // 限制步长避免穿透
    this.lastTime = t;
    if (this.state === 'playing') this.update(dt);
    if (this.state !== 'paused') this.updateParticles(dt); // 暂停时粒子一并冻结
    this.draw();
    requestAnimationFrame((tt) => this.tick(tt));
  }

  update(dt) {
    this.updatePaddle(dt);

    // 球运动
    this.ball.x += this.ball.vx * dt;
    this.ball.y += this.ball.vy * dt;

    // 左右墙反弹
    if (this.ball.x - this.ball.r < 0) { this.ball.x = this.ball.r; this.ball.vx = Math.abs(this.ball.vx); }
    if (this.ball.x + this.ball.r > this.W) { this.ball.x = this.W - this.ball.r; this.ball.vx = -Math.abs(this.ball.vx); }
    // 顶墙反弹
    if (this.ball.y - this.ball.r < 0) { this.ball.y = this.ball.r; this.ball.vy = Math.abs(this.ball.vy); }

    // 碰到挡板
    this.collidePaddle();

    // 掉到底部：扣命
    if (this.ball.y - this.ball.r > this.H) {
      this.loseLife();
      return;
    }

    // 砖块碰撞
    this.collideBricks();
  }

  /** 挡板移动：手势优先，其次鼠标，再次键盘 */
  updatePaddle(dt) {
    const half = this.paddle.w / 2;
    if (this.paddleTarget !== null) {
      // 有效区域映射：只把 [effLeft, effRight] 映射到挡板全范围 [half, W-half]，
      // 超出区域 clamp 到两端。这样手在画面中间移动即可让挡板到达最左/最右。
      const width = this.effRight - this.effLeft;
      const t = clamp((this.paddleTarget - this.effLeft) / width, 0, 1);
      this.paddle.x = half + t * (this.W - this.paddle.w);
    } else if (this.mouseX !== null) {
      this.paddle.x = clamp(this.mouseX, half, this.W - half);
    } else {
      const dir = (this.keys.right ? 1 : 0) - (this.keys.left ? 1 : 0);
      if (dir !== 0) this.paddle.x += dir * 560 * dt;
      this.paddle.x = clamp(this.paddle.x, half, this.W - half);
    }
  }

  /** 挡板反弹：按击中位置改变反弹角度 */
  collidePaddle() {
    const b = this.ball;
    const p = this.paddle;
    if (b.vy <= 0) return; // 只在向下时判断
    const top = p.y - p.h / 2;
    if (b.y + b.r >= top && b.y - b.r <= p.y + p.h / 2 &&
        b.x >= p.x - p.w / 2 && b.x <= p.x + p.w / 2) {
      // 击中位置 -1(左) ~ 1(右)
      const rel = clamp((b.x - p.x) / (p.w / 2), -1, 1);
      const speed = Math.hypot(b.vx, b.vy);
      const angle = rel * 0.9; // 最大约 51 度
      b.vx = speed * Math.sin(angle);
      b.vy = -speed * Math.cos(angle);
      b.y = top - b.r; // 顶到挡板上方，避免粘连
      playBeep(560, 0.05, 'triangle', 0.1);
    }
  }

  /** 砖块碰撞（基于最小穿透轴的圆与矩形碰撞） */
  collideBricks() {
    const b = this.ball;
    for (let i = 0; i < this.bricks.length; i++) {
      const r = this.bricks[i];
      if (!r.alive) continue;
      const cx = r.x + r.w / 2;
      const cy = r.y + r.h / 2;
      const dx = b.x - cx;
      const dy = b.y - cy;
      const halfW = r.w / 2 + b.r;
      const halfH = r.h / 2 + b.r;
      if (Math.abs(dx) > halfW || Math.abs(dy) > halfH) continue;

      // 沿穿透更浅的轴反弹
      const ox = halfW - Math.abs(dx);
      const oy = halfH - Math.abs(dy);
      if (ox < oy) {
        b.vx = Math.sign(dx || 1) * Math.abs(b.vx);
        b.x += Math.sign(dx || 1) * ox;
      } else {
        b.vy = Math.sign(dy || 1) * Math.abs(b.vy);
        b.y += Math.sign(dy || 1) * oy;
      }

      // 打碎砖块
      r.alive = false;
      this.score += 10;
      this.spawnParticles(cx, cy, r.color);
      playBeep(880, 0.06, 'square', 0.12);
      this.emit();

      // 本帧只处理一块砖，避免一次穿多块
      this.checkClear();
      return;
    }
  }

  /** 判断当前关是否清空 */
  checkClear() {
    if (this.bricks.every((r) => !r.alive)) {
      if (this.level >= MAX_LEVEL) {
        this.state = 'won';
        playTune();
        this.cb.onEnd && this.cb.onEnd(this.score);
      } else {
        this.level += 1;
        this.buildLevel();
      }
      this.emit();
    }
  }

  loseLife() {
    this.lives -= 1;
    playBeep(160, 0.2, 'sawtooth', 0.15);
    if (this.lives <= 0) {
      this.state = 'gameover';
      this.cb.onEnd && this.cb.onEnd(this.score);
    } else {
      this.resetBall();
    }
    this.emit();
  }

  // ============ 粒子（击碎动画） ============
  spawnParticles(x, y, color) {
    for (let i = 0; i < 10; i++) {
      this.particles.push({
        x, y,
        vx: (Math.random() - 0.5) * 260,
        vy: (Math.random() - 0.5) * 260 - 40,
        life: 0.4 + Math.random() * 0.3,
        maxLife: 0.7,
        color,
      });
    }
  }

  updateParticles(dt) {
    for (const p of this.particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 500 * dt; // 轻微重力
      p.life -= dt;
    }
    this.particles = this.particles.filter((p) => p.life > 0);
  }

  // ============ 绘制 ============
  draw() {
    const ctx = this.ctx;
    // 背景
    ctx.fillStyle = '#0d1220';
    ctx.fillRect(0, 0, this.W, this.H);

    this.drawBricks(ctx);
    this.drawParticles(ctx);
    this.drawPaddle(ctx);
    this.drawBall(ctx);
    this.drawOverlay(ctx);
  }

  drawBricks(ctx) {
    for (const r of this.bricks) {
      if (!r.alive) continue;
      ctx.fillStyle = r.color;
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.fillRect(r.x, r.y, r.w, 4); // 顶部高光
    }
  }

  drawPaddle(ctx) {
    const p = this.paddle;
    ctx.fillStyle = '#7ee2ff';
    ctx.beginPath();
    const r = p.h / 2;
    roundRect(ctx, p.x - p.w / 2, p.y - p.h / 2, p.w, p.h, r);
    ctx.fill();
  }

  drawBall(ctx) {
    const b = this.ball;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
    ctx.fill();
  }

  drawParticles(ctx) {
    for (const p of this.particles) {
      ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - 2, p.y - 2, 4, 4);
    }
    ctx.globalAlpha = 1;
  }

  drawOverlay(ctx) {
    if (this.state === 'playing') return;
    ctx.fillStyle = 'rgba(6, 10, 18, 0.62)';
    ctx.fillRect(0, 0, this.W, this.H);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#e6e9ef';
    ctx.font = 'bold 34px "Microsoft YaHei", sans-serif';

    let title = '';
    let sub = '';
    switch (this.state) {
      case 'ready': title = '准备就绪'; sub = '握拳 / 空格 / 点击 发球'; break;
      case 'paused': title = '已暂停'; sub = '握拳 / 空格 继续'; break;
      case 'gameover': title = '游戏结束'; sub = '握拳 / 空格 重新开始（得分 ' + this.score + '）'; break;
      case 'won': title = '🎉 全部通关'; sub = '得分 ' + this.score + '，握拳 / 空格 再来一局'; break;
    }
    ctx.fillText(title, this.W / 2, this.H / 2 - 22);
    ctx.font = '16px "Microsoft YaHei", sans-serif';
    ctx.fillStyle = '#aab6c8';
    ctx.fillText(sub, this.W / 2, this.H / 2 + 24);
  }

  emit() {
    if (this.cb.onUpdate) {
      this.cb.onUpdate({
        score: this.score,
        lives: this.lives,
        level: this.level,
        difficulty: this.difficulty.name,
        state: this.state,
      });
    }
  }
}

// ============ 工具函数 ============
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ============ 音效（WebAudio 合成，无需外部文件） ============
let _audioCtx = null;
function audioCtx() {
  if (!_audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) _audioCtx = new AC();
  }
  if (_audioCtx && _audioCtx.state === 'suspended') _audioCtx.resume();
  return _audioCtx;
}

function playBeep(freq, dur = 0.06, type = 'square', vol = 0.15) {
  const ctx = audioCtx();
  if (!ctx) return;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.value = freq;
  g.gain.setValueAtTime(vol, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
  o.connect(g).connect(ctx.destination);
  o.start();
  o.stop(ctx.currentTime + dur);
}

function playTune() {
  const ctx = audioCtx();
  if (!ctx) return;
  const notes = [523, 659, 784, 1046];
  notes.forEach((f, i) => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'triangle';
    o.frequency.value = f;
    const t = ctx.currentTime + i * 0.12;
    g.gain.setValueAtTime(0.15, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    o.connect(g).connect(ctx.destination);
    o.start(t);
    o.stop(t + 0.2);
  });
}