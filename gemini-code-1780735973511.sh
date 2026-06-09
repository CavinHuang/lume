#!/bin/bash

# 1. 定义软件路径（请根据实际安装位置修改）
APP_EXECUTABLE="/Applications/Alice.app/Contents/MacOS/Alice"

# 2. 设置环境变量
# ELECTRON_ENABLE_LOGGING: 输出内核日志到终端
# ELECTRON_ENABLE_STACK_DUMPING: 崩溃时导出堆栈
# NODE_ENV: 设为开发模式，很多软件检测到这个会自动开启 DevTools
export ELECTRON_ENABLE_LOGGING=true
export ELECTRON_ENABLE_STACK_DUMPING=true
export NODE_ENV=development

echo "🚀 正在以调试模式启动 Alice..."

# 3. 带有参数启动二进制文件
# --remote-debugging-port: 开启远程调试端口
# --inspect: 开启 Node 主进程调试
# --auto-open-devtools-for-tabs: 强制 Chromium 启动时打开开发工具
"$APP_EXECUTABLE" --remote-debugging-port=9222 --inspect=5858 --auto-open-devtools-for-tabs