# 手势控制打砖块（MediaPipe HandLandmarker）

《人工智能导论》课程期末大作业：纯网页项目（HTML + CSS + JavaScript），无需后端、无需 Python、无需 Node 构建工具。
用摄像头识别手部关键点，通过手势控制打砖块游戏，并提供实验分析页面用于撰写报告。

## 三步使用（对方拿到 zip 后）

1. **完整解压 zip**：右键 zip →「全部解压」到文件夹。不要在 zip 预览窗口里直接双击运行，否则依赖文件加载不全。
2. **双击 `start.bat`**（Windows）会自动启动本地服务器并打开浏览器；macOS 双击 `start.command`，Linux 运行 `./start.sh`。
3. **浏览器里允许摄像头权限**：出现「要访问您的摄像头」提示时点「允许」即可开始。

> 无需安装 Python、Node 或任何软件：Windows 用系统自带 PowerShell，macOS/Linux 用系统自带 python3。

## 功能一览

- **手部识别**：MediaPipe Tasks Vision `HandLandmarker`（VIDEO 模式），GPU 优先、自动降级 CPU；摄像头镜像显示，叠加绘制 21 个关键点与骨架；支持切换前后摄像头、选择设备、手势检测阈值/滤波/防抖等参数可调。
- **手势判定**（基于规则）：张开手掌（移动挡板）、握拳（发球/继续）、食指（暂停）、剪刀手（切换难度）、无手（自动暂停）；拇指做横向单独判定。
- **打砖块游戏**：3 关不同砖块布局、难度三档、球按挡板击中位置改变反弹角、音效与击碎粒子动画；同时支持键盘（左右方向键 + 空格）与鼠标作为备用。
- **自定义手势训练（KNN）**：采集 21 个关键点归一化样本，自实现 KNN 分类器识别自定义手势，支持样本导出/导入 JSON。
- **实验分析页**：滤波效果对比、规则 vs KNN 准确率对比、性能（FPS/耗时）实时折线图、手势识别测试（混淆矩阵）、环境影响手动记录；支持导出 CSV/JSON。
- **原理说明**：页面内折叠面板解释手部检测两阶段、21 关键点、规则判定、KNN、平滑滤波。

## 目录结构

```
Game_Project/
├── index.html
├── css/style.css
├── js/
│   ├── main.js          # 入口与调度
│   ├── handTracker.js   # HandLandmarker 加载与逐帧检测
│   ├── gesture.js       # 手势规则判定与防抖
│   ├── filter.js        # 关键点平滑滤波（无/EMA/One Euro）
│   ├── game.js          # 打砖块游戏
│   ├── stats.js         # 最近 10 局成绩存储
│   ├── knn.js           # KNN 分类器 + 关键点归一化
│   └── experiment.js    # 实验分析统计 / 混淆矩阵 / 手势测试 / 导出
├── lib/
│   ├── tasks-vision/
│   │   ├── vision_bundle.mjs
│   │   └── wasm/        # 4 个 wasm 相关文件
│   └── chart.umd.min.js
├── models/
│   └── hand_landmarker.task
├── start.bat        # Windows 双击启动（调用 serve.ps1，无需 Python）
├── serve.ps1        # 内置静态文件服务器（PowerShell）
├── start.command    # macOS 双击启动
└── start.sh         # Linux 启动
```

## 依赖文件下载清单（仅重新搭建项目时才需要）

> 已打包好的 zip（`GestureBreakout_v1.0.zip`）**无需执行本节**：依赖已全部内置，解压即用。
> 只有当你从源码/仓库重新搭建项目、或发现 `lib/`、`models/` 里的依赖文件缺失时，才需要按下面清单补全。

本项目运行时不访问外网，请把以下文件下载到对应路径，并固定版本。

### 1. MediaPipe Tasks Vision（JS + WASM）

- 版本：**@mediapipe/tasks-vision@0.10.14**
- 需要两个部分：
  - `vision_bundle.mjs` → 放到 `lib/tasks-vision/vision_bundle.mjs`
  - `wasm/` 整个目录（含 4 个文件）→ 放到 `lib/tasks-vision/wasm/`

通过 npm 包获取最方便（任选其一）：

```bash
# 方式 A：从 npm 下载
npm pack @mediapipe/tasks-vision@0.10.14
# 解压后取 package/vision_bundle.mjs 与 package/wasm/

# 方式 B：直接引用 CDN 下载（网络可达时）
# vision_bundle.mjs
#   https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs
# wasm 目录（4 个文件）
#   https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm/vision_wasm_internal.js
#   https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm/vision_wasm_internal.wasm
#   https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm/vision_wasm_nosimd_internal.js
#   https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm/vision_wasm_nosimd_internal.wasm
```

### 2. 手部关键点模型

- 文件：`hand_landmarker.task`（约 7.8 MB）
- 放到：`models/hand_landmarker.task`
- 下载地址：

```text
https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task
```

### 3. Chart.js

- 版本：**Chart.js 4.4.4**（UMD 构建）
- 放到：`lib/chart.umd.min.js`
- 下载地址：

```text
https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js
```

## 运行方法

> 摄像头权限要求「安全上下文」：必须是 `https://` 或 `http://localhost`（含 `127.0.0.1`）。
> 不能用 `file://` 直接打开，也不能用 `http://局域网IP`。

### 本机运行

方式一：一键脚本（Windows 双击 `start.bat`；macOS/Linux 运行 `./start.sh`）。

方式二：手动启动：

```bash
cd Game_Project
python -m http.server 8000
# 或使用 VS Code 的 Live Server 扩展
```

浏览器访问：<http://localhost:8000>

### 在 Trae 内置浏览器中使用

Trae 的内置浏览器无法被脚本自动弹出新窗口，请手动打开：

1. 双击 `start-server-only.bat`（只启动服务，不自动打开浏览器）。
2. 复制窗口中 `serve.ps1` 输出的地址（如 `http://localhost:8000/`），粘贴到 Trae 内置浏览器地址栏打开。
3. 用完直接关闭那个命令行窗口，即停止服务。

### 其他设备访问（部署到 HTTPS）

局域网 IP 无法使用摄像头，必须部署到 HTTPS 站点。以下平台任选其一即可：

- **Netlify（推荐，最简单）**：把整个项目文件夹（注意 `index.html` 必须在**最外层**，不要在子目录里）拖到 <https://app.netlify.com/drop>，即可得到一个 `https://xxx.netlify.app` 地址。也可以连接 Git 仓库自动部署。

- **Cloudflare Pages（直接上传文件夹）**：登录 <https://dash.cloudflare.com> → `Workers & Pages → Create → Pages → Upload assets`，为项目命名后，把整个项目文件夹拖入上传区，部署完成即可得到 `https://xxx.pages.dev` 地址。

- **Vercel（连接 Git 或命令行）**：在 <https://vercel.com> 用 GitHub/GitLab 账号导入仓库（框架选「Other」，构建命令留空，输出目录填 `.`），或安装 Vercel CLI 后在项目根目录执行 `vercel`，按提示部署，得到 `https://xxx.vercel.app` 地址。

- **GitHub Pages**：仓库 `Settings → Pages`，Source 选分支、目录选 `/ (root)`，得到 `https://用户名.github.io/仓库名/`。注意：`github.io` 在国内访问可能不稳定，作为备选。

部署后直接用 HTTPS 地址访问即可，依赖已全部本地化，无外网请求。

> **部署后请实测**：分别用**手机流量**和**校园网**访问上面的 HTTPS 地址；如果某一个平台打不开，就换另一个平台（国内对部分国外托管服务的可达性不一）。

> **备用方案**：如果所有线上网址都打不开，就在本机用 `start.bat`（Windows）或 `./start.sh`（macOS/Linux）启动 localhost，完全离线运行演示（仅限本机，摄像头可用）。

## 测试方法

1. **手部识别**：允许摄像头权限，画面出现关键点骨架；右上角显示当前后端（GPU/CPU）。
2. **游戏**：切到「打砖块游戏」，张开手掌左右移动控制挡板，握拳发球，食指暂停，剪刀手切换难度；键盘/鼠标亦可。
3. **手势训练**：切到「手势训练」，输入名称 → 做手势 → 「采集当前手势」，多采几组；切换 K 值查看实时分类与置信度；可导出/导入 JSON。
4. **实验分析**：切到「实验分析」，按页面提示逐项操作，结果可导出 CSV/JSON。

## 常见问题

- **摄像头打不开**：确认地址是 `http://localhost:8000` 或 HTTPS；浏览器地址栏允许摄像头权限；确认没有其他程序占用摄像头。
- **模型加载失败**：确认 `models/hand_landmarker.task` 与 `lib/tasks-vision/` 文件齐全且路径正确；必须通过本地服务器访问，不能直接打开 HTML。
- **帧率低**：默认已优先 GPU；若设备 GPU 受限会自动降级 CPU。可调低检测分辨率敏感性、关闭骨架显示、减少检测手数（已固定为 1）来提升流畅度。
- **手势识别不准/抖动**：调整「检测阈值」滑块，把手放在画面中间「有效控制区」虚线框内移动；可切换滤波方式与平滑系数。
- **Windows SmartScreen 拦截 `start.bat`**：点击蓝字「更多信息」→「仍要运行」即可（未签名脚本触发系统拦截属正常现象）。
- **杀毒软件误报**：本项目脚本只调用系统自带能力启动本地服务器、不联网不作恶；被误报时选择「信任」或「加入白名单」，或临时暂停该软件实时防护。
- **摄像头被其他程序占用**：关闭正在用摄像头的程序（视频会议、系统相机、其他标签页），或刷新页面重新授予摄像头权限。
- **端口被占用**：直接关闭占用端口的程序后重试；Windows 版会自动在 8000~8019 之间自动换端口，无需手动修改。

## 打包 ZIP（分发前）

打包给同学时，把**整个项目文件夹**压成 zip。应包含：

- `index.html`、`css/`、`js/`
- `lib/`（`tasks-vision/` 及 `chart.umd.min.js`）
- `models/`（`hand_landmarker.task`）
- `data/`（如有本地数据依赖）
- `start.bat`、`serve.ps1`、`start.command`、`start.sh`、`README.md`

应排除：

- `.git/`（版本库）、`node_modules/`（本项目无需）
- 临时文件：`__pycache__/`、`*.pyc`、`.DS_Store`、`Thumbs.db`、`*.log`
- IDE 目录：`.vscode/`、`.idea/`、`.trae/`、`.build/`、`.screenshots/`
- 打包产物本身（避免 zip 套 zip）

打包时务必**保留 `index.html` 在 zip 最外层**，且不要删除任何 `.task`、`.wasm`、`.mjs` 文件。