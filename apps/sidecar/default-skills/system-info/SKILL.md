---
name: "系统信息速查手册"
description: "通过 bash 命令获取系统信息：硬件、网络、磁盘、进程、电池等。不是工具，而是 bash 命令参考。"
when_to_use: "当需要查看系统信息、硬件配置、网络状态、磁盘空间、进程占用、电池状态、系统版本等"
allowed_tools: ["bash", "ip_location"]
version: "1.0"
---

## 系统信息 Bash 命令速查

以下命令均适用于 macOS，直接通过 bash 工具执行即可。

### 硬件与系统
| 需求 | 命令 |
|------|------|
| macOS 版本 | `sw_vers` |
| 芯片型号 | `sysctl -n machdep.cpu.brand_string` |
| CPU 核心数 | `sysctl -n hw.ncpu` |
| 内存总量 | `sysctl -n hw.memsize \| awk '{print $0/1073741824 " GB"}'` |
| 硬件概要 | `system_profiler SPHardwareDataType` |
| 运行时间 | `uptime` |
| 主机名 | `hostname` |

### 磁盘空间
| 需求 | 命令 |
|------|------|
| 磁盘使用总览 | `df -h /` |
| 当前目录大小 | `du -sh .` |
| 目录空间排行 | `du -sh * \| sort -rh \| head -20` |
| Homebrew 缓存 | `du -sh ~/Library/Caches/Homebrew 2>/dev/null` |
| node_modules 扫描 | `find ~ -name node_modules -type d -maxdepth 5 2>/dev/null \| head -10` |

### 网络
| 需求 | 命令 |
|------|------|
| 局域网 IP | `ipconfig getifaddr en0` |
| 公网 IP + 归属地 | **用 ip_location 工具**（更准确，含经纬度） |
| DNS 配置 | `scutil --dns \| head -20` |
| 活跃网络连接 | `netstat -an \| grep ESTABLISHED \| head -20` |
| 端口监听 | `lsof -i -P \| grep LISTEN` |
| 网络带宽测试 | `curl -o /dev/null -w '%{speed_download}' https://speed.cloudflare.com/__down?bytes=10000000 2>/dev/null` |
| Wi-Fi 名称 | `networksetup -getairportnetwork en0 2>/dev/null \|\| ipconfig getsummary en0 \| grep SSID` |

### 进程与性能
| 需求 | 命令 |
|------|------|
| CPU 占用 TOP 10 | `ps aux --sort=-%cpu \| head -11` |
| 内存占用 TOP 10 | `ps aux --sort=-%mem \| head -11` |
| 查找进程 | `ps aux \| grep <关键词>` |
| 杀死进程 | `kill -9 <PID>`（需确认） |

### 电池（MacBook）
| 需求 | 命令 |
|------|------|
| 电池状态 | `pmset -g batt` |
| 电池循环次数 | `system_profiler SPPowerDataType \| grep "Cycle Count"` |
| 电池健康度 | `system_profiler SPPowerDataType \| grep -E "Cycle|Condition|Maximum"` |

### 开发环境
| 需求 | 命令 |
|------|------|
| Node.js 版本 | `node -v` |
| Python 版本 | `python3.11 --version` |
| Git 版本 | `git --version` |
| Homebrew 已装包 | `brew list --formula \| wc -l` |
| 全局 npm 包 | `npm list -g --depth=0 2>/dev/null` |
| Xcode CLT 版本 | `xcode-select -p && pkgutil --pkg-info=com.apple.pkg.CLTools_Executables 2>/dev/null \| grep version` |
| Docker 状态 | `docker info 2>/dev/null \| head -5` |

### 时间与地区
| 需求 | 命令 |
|------|------|
| 当前时间 | `date` |
| 时区 | `date +%Z` |
| 日历 | `cal` |

### 注意事项
- 以上全是 macOS 命令，Linux 稍有不同
- 公网 IP 和归属地优先用 `ip_location` 工具（更准确，含经纬度和 ISP 信息）
- 需要精确天气数据时用 `weather` 工具，不要 curl 第三方网页
- 杀进程等破坏性命令需先确认
