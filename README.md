# WslDockerManager

![Build Windows EXE](https://github.com/yunshangguo/WslDockerManager/actions/workflows/build.yml/badge.svg)

> 在 Windows 上管理运行于 WSL2 内部的 Docker 引擎，不依赖 Docker Desktop。

后端用 Express + dockerode 直连 WSL2 的 `dockerd`，前端是无构建步骤的 Vue 3 单页应用。提供「网页版」与「Electron 桌面版」两种形态，桌面版自带托盘、设置窗口与开机常驻。

适合想用 WSL2 原生 Docker、同时需要一个图形界面管理容器 / 镜像 / 卷 / 网络 / Compose 栈的用户。

---

## 功能特性

- **概览仪表盘** —— WSL 的 CPU（型号 / 核数 / 负载 / 架构）、内存、磁盘以仪表盘展示，附 Docker 引擎版本与运行状态。
- **容器管理** —— 列表、启动 / 停止 / 重启 / 删除、实时日志、交互式终端、创建容器。
- **镜像管理** —— 拉取、删除、打标签、导入导出，以及比对远端 manifest digest 的镜像更新检查（支持多镜像源）。
- **卷与网络** —— 创建、删除、查看详情。
- **Compose 栈** —— 基于 `docker compose` 的栈管理，配置存于 `data/compose`，操作前自动备份。
- **后台任务** —— 镜像拉取、更新检查、引擎升级等耗时操作异步执行并轮询进度。
- **用户与权限** —— 管理员与普通用户两套角色，可为普通用户分配根目录与读写删权限。
- **操作审计** —— 登录与关键操作写入 `audit.log`，可在「审计」页查看。
- **镜像站登录** —— 通过 `docker login` 登录私有 / 加速镜像站，凭据保存在 WSL 的 `~/.docker/config.json`。
- **引擎更新** —— 通过 `apt` 一键升级 WSL 内的 Docker 组件（docker-ce / CLI / containerd / buildx / compose 插件）。
- **环境检测与一键安装** —— 自动检查 CPU 虚拟化、WSL2、发行版、Docker 引擎、`.wslconfig`、`DOCKER_HOST`、2375 端口、保活计划任务等，缺失项可以管理员权限一键安装配置。
- **常驻保活** —— 应用层保活子进程 + `WslDockerKeepAlive` 计划任务双层机制，防止 WSL 实例被系统空闲休眠。
- **桌面外壳** —— 独立 exe，托盘常驻、关窗询问「最小化 / 退出」、首跑引导、设置免重启热应用，数据目录可自定义并自动迁移。

---

## 技术栈

| 层 | 技术 |
|---|---|
| 后端 | Node.js + Express + dockerode，通过 `127.0.0.1:2375` 直连 WSL dockerd |
| 前端 | Vue 3（CDN 引入）+ 原生 ES Module，无构建步骤 |
| 进程守护 | supervisor 单实例协调锁（端口 5051）+ 崩溃自愈 |
| 桌面 | Electron + electron-builder |

关键端口：`5050`（Web UI / API）、`5051`（supervisor 协调锁）、`2375`（WSL dockerd）。

---

## 环境要求

| 组件 | 要求 |
|---|---|
| Windows | 10 / 11 64 位，已启用 WSL2 |
| WSL2 发行版 | 推荐 Debian / Ubuntu（默认 `Debian`，可在 `config.json` 修改） |
| WSL2 内 Docker | `dockerd` 监听 TCP `0.0.0.0:2375` |
| Node.js | ≥ 18（网页版 / 开发需要；桌面版自带运行时） |

WSL 内一次性配置 `/etc/docker/daemon.json`：

```json
{
  "hosts": ["unix:///var/run/docker.sock", "tcp://0.0.0.0:2375"]
}
```

改完重启 docker。若不想手动配，可在面板「环境检测」页用一键安装完成。

---

## 快速开始

```bash
git clone <repo-url> WslDockerManager
cd WslDockerManager
npm install
```

三种运行方式：

```bash
# 网页版（推荐，带单实例与自愈）
npm run supervisor

# 纯服务（调试）
npm start

# Electron 桌面版（开发）
npm run electron
```

浏览器访问 `http://127.0.0.1:5050`。首次运行会在数据目录播种 `admin` 账号：密码优先取 `PASSWORD_OVERRIDE`，否则随机生成并打印到日志；之后可在「设置 - 账户」中修改或新增用户。

桌面版打包：`npm run dist`（安装版）、`npm run dist:portable`（便携单目录版）、`npm run dist:nsis`（NSIS 安装版）。GitHub Actions 会自动构建并上传 Release 产物。

---

## 配置

`config.json` 主要字段：

| 字段 | 默认 | 说明 |
|---|---|---|
| `port` / `coordinatorPort` | `5050` / `5051` | HTTP 端口 / supervisor 协调端口 |
| `dockerHost` / `dockerPort` | `127.0.0.1` / `2375` | WSL dockerd 地址 |
| `distro` | `Debian` | WSL 发行版名 |
| `dataDir` | `data` | 可变数据目录 |
| `autostartContainers` | `true` | Docker 恢复后自动拉起原有容器 |
| `session.ttlHours` | `12` | 会话有效期 |
| `session.secret` | 默认值 | 生产环境务必修改，或设置 `SESSION_SECRET` 环境变量 |

环境变量覆盖：`WSLDM_PORT`、`WSLDM_DATA_DIR`、`SESSION_SECRET`、`PASSWORD_OVERRIDE`。

> 修改 `config.json` 或后端代码后需重启 server 进程；不要杀 supervisor 本身，它会自动用新代码拉起 server。

---

## 架构

```
Windows 主机
 ├─ Electron 外壳（可选）：托盘 + 设置窗口，fork server 子进程
 ├─ supervisor.js：单实例锁（5051）+ 自愈重启
 └─ Express server.js（5050）
      ├─ routes/*：containers / images / volumes / networks / compose / tasks
      │            settings / users / audit / host / system
      └─ dockerode ── TCP 127.0.0.1:2375
                          │
                    WSL2（Debian）dockerd
                    容器 / 镜像 / 卷 / 网络
```

前端位于 `public/`，`index.html` + `styles.css` + `js/{app,api,ui,tasks,views}.js`，Vue 3 通过 CDN 加载，无需构建。用户表、审计日志、Compose 配置等可变数据默认在 `data/`，桌面版在 `%APPDATA%/WslDockerManager/data`。

---

## 常见问题

**面板显示 Docker 不可达** —— 检查 WSL 内 `dockerd` 是否监听 2375、Windows 防火墙是否放行；可先在 WSL 里 `curl 127.0.0.1:2375/version` 验证。

**WSL 实例一段时间后休眠** —— 确认 `WslDockerKeepAlive` 计划任务存在且在运行；桌面版常驻时应用层保活也会持续持有实例。

**端口被占用** —— 用 `netstat -ano -p TCP` 找到占用 5050 / 5051 的 PID 并处理，或修改 `config.json` 中的端口。

---

## 许可证

内部工具，按项目约定使用。
