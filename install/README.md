# WslDockerManager · 阶段0 底座安装与验证清单

目标：在 **不装 Docker Desktop** 的前提下，于 WSL2 内直接运行 Docker Engine，
并从 Windows 侧（本项目后端 / docker.exe）通过 `tcp://localhost:2375` 管理它。
核心收益：去掉 Desktop 自身开销 + 用 `.wslconfig` 给 WSL2 内存封顶，根治「运行一段内存爆」。

---

## 一、脚本分工

| 脚本 | 运行位置 | 做什么 |
|---|---|---|
| `setup-wsl-docker.sh` | WSL2 Debian 内（root 或 sudo） | 装 Docker Engine + compose 插件；让 dockerd 监听 `unix socket + tcp://127.0.0.1:2375` |
| `setup-prereqs.ps1` | Windows 管理员 PowerShell | **完整环境安装向导（9 步）**：启用虚拟化功能 → 安装/更新 WSL → 安装 Debian → 写 `.wslconfig` → 启用 systemd → 调 .sh 装 Docker → 装 Windows 侧 docker.exe 设 `DOCKER_HOST` → 建自启 + 保活任务 → 验证。进度以 `##STEP` 写入日志，供后端轮询 |
| `setup-wsl-docker.ps1` | Windows 管理员 PowerShell | `setup-prereqs.ps1` 的**薄封装**（自动探测项目根目录后调用），保留以便兼容旧文档与手动运行 |

> 一般只需运行 `setup-prereqs.ps1` 这一个脚本；项目「环境检测」页的一键安装底层也是提权调用它。

---

## 二、执行步骤（在你本机，管理员 PowerShell）

```powershell
cd D:\WslDockerManager\install
.\setup-prereqs.ps1
# 或兼容旧文档：.\setup-wsl-docker.ps1
```

脚本会依次（共 9 步）：
1. 检测虚拟化并启用 WSL 所需 Windows 功能（VirtualMachinePlatform / WSL）；固件未开虚拟化则报错退出
2. 安装/更新 WSL 运行时（`wsl --update`）
3. 安装 Debian 发行版（winget 或 `wsl --install -d Debian`；落在 C: 时迁移到 D:）
4. 写 `%USERPROFILE%\.wslconfig`（内存上限；已备份原文件为 `.wslconfig.bak`）
5. 在 WSL2 开启 systemd 并重启 WSL
6. 在 WSL2 内安装 Docker Engine（运行 `setup-wsl-docker.sh`）
7. 下载 Windows 侧 docker.exe 到 `D:\WslDockerManager\bin` 并加入 PATH
8. 设 `DOCKER_HOST=tcp://localhost:2375` + 创建登录自启任务 `WslDockerStart` 与常驻保活任务 `WslDockerKeepAlive`
9. 验证并收尾（`##DONE`；若过程中启用了 Windows 功能则额外写 `##REBOOT` 提示重启）

> 第⑧步的 `WslDockerKeepAlive` 任务启动 `wsl -d Debian -u root sleep infinity` 并每分钟重试 / 失败重启，**防止 WSL2 发行版空闲后被自动休眠**——这是“安装后 Docker 与 Linux 一直保持活跃”的关键一步。

---

## 三、验证清单（逐项确认）

- [ ] `wsl -l -v` 显示 Debian 且 VERSION=2
- [ ] WSL2 内 `docker run --rm hello-world` 成功（脚本第④步应输出 Hello from Docker）
- [ ] Windows 侧 `docker ps` 能返回列表（空列表也算通）—— 证明 `localhost:2375` 通路 OK
- [ ] 浏览器/命令行访问 `http://localhost:2375/version` 返回 Engine 版本 JSON
- [ ] `%USERPROFILE%\.wslconfig` 含 `[wsl2]` 段且 `localhostForwarding=true`
- [ ] 任务计划程序里有 `WslDockerStart`（登录时启动 WSL2 内 docker）
- [ ] 任务计划程序里有 `WslDockerKeepAlive`（常驻保活，使 WSL2 / Docker 永不被自动休眠）
- [ ] 关闭所有窗口、甚至退出本程序后，过一段时间再 `docker ps` 仍可连通（验证未休眠）
- [ ] 重启 Windows 后，无需手动操作，`docker ps` 仍可连通（验证自启）

---

## 四、排障

- **dockerd 没起来**：在 WSL2 内 `sudo systemctl status docker`；若 systemd 未生效，检查 `/etc/wsl.conf` 有无 `[boot] systemd=true`，然后 `wsl --shutdown` 重进。
- **Windows 侧 `docker ps` 连不上**：确认 `DOCKER_HOST=tcp://localhost:2375`；在 WSL2 内 `sudo netstat -lntp | grep 2375` 确认 dockerd 在监听；检查 Windows 防火墙是否拦了 `wslhost.exe` 的 2375。
- **`/mnt/c` 挂载慢**：这是已知的 9P 文件系统桥接开销。数据库等高频 I/O 用**命名卷**（named volume），媒体/配置等想直接在 Windows 看的才 bind 到 `/mnt/*`。详见阶段4 的挂载翻译规则。
- **`.wslconfig` 没生效**：改完必须 `wsl --shutdown` 再重开；用 WSL2 内 `free -h` 看总内存是否被限制住。

---

## 五、安全提示

- dockerd 绑的是 `127.0.0.1`（仅 WSL2 内 + 经 localhost 转发到 Windows 本机），**不暴露到局域网**。
- 无 TLS 的 2375 等于把宿主机 root 权限敞开，因此**只允许本机 localhost 访问**；如需从其他机器访问，必须改用 2376 + TLS，切勿把 2375 映射到 `0.0.0.0`。

---

阶段0 完成后，即可进入阶段1（后端骨架 + dockerode 接入 `tcp://127.0.0.1:2375`）。
