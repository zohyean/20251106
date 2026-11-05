#!/bin/bash
# 一键启动本地服务器（macOS），无需安装任何额外软件
cd "$(dirname "$0")"

if command -v python3 >/dev/null 2>&1; then
    echo "正在启动本地服务器，浏览器将自动打开 http://localhost:8000"
    echo "请不要关闭本窗口，关闭窗口即停止服务（按 Ctrl+C 也可停止）。"
    open http://localhost:8000
    exec python3 -m http.server 8000
else
    echo "[错误] 未找到 python3，无法启动本地服务器。"
    echo "macOS 自带 python3，若提示未找到，请在终端运行以下命令安装命令行工具："
    echo "  xcode-select --install"
    read -r -p "按回车键退出..." _
fi