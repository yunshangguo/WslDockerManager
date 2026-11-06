# WslDockerManager

![Build Windows EXE](https://github.com/yunshangguo/WslDockerManager/actions/workflows/build.yml/badge.svg)

在 Windows 上管理运行于 **WSL2 内部 Docker 引擎**（不依赖 Docker Desktop）的轻量级管理面板。
后端用 Express + dockerode 直连 WSL2 的 `dockerd`，前端是无构建步骤的 Vue 3 单页应用，
同时提供「网页版」与「Electron 桌面版」两种形态，桌面版自带托盘、设置窗口与开机自启式常驻。

> 适合：想用 WSL2 原生 Docker（而不是 Docker Desktop）、又想要一个图形化面板管理容器 / 镜像 / 卷 / 网络 / Compose 栈的用户。

---

## 功能特性

- **概览仪表盘（Dashboard）**：WSL 资源占用以圆形仪表盘展示 —— CPU 使用率（含型号 / 核数 / 1 分钟负载 / 架构）、内存（已用 / 总量 / 百分比）、磁盘（已用 / 总量 / 百分比），以及 Docker 引擎版本与运行状态。
- **容器管理**：列表、启动 / 停止 / 重启 / 删除、查看实时日志、进入交互式终端、创建容器。
- **镜像管理**：列表、拉取、删除、打标签、导出 / 导入，以及 **镜像更新检查**（比对远端 manifest digest，支持 1panel / Docker Hub 等多镜像源）。
- **卷 / 网络管理**：创建、删除、查看详情。
- **Compose 栈（Stacks）**：基于 `docker compose` 的栈列表、启动 / 停止 / 删除，配置文件存于 `data/compose`，操作前自动备份。
- **后台任务（Tasks）**：镜像拉取、更新检查、引擎升级等耗时操作以后台任务形式执行，前端轮询进度，任务完成后刷新。
- **用户与权限**：管理员（`admin`）与普通用户两套角色；管理员可在「设置 - 账户」中增删用户、重置密码、分配根目录与读写删权限。
- **操作审计（Audit）**：关键操作（登录、容器 / 镜像 / 引擎变更等）写入 `audit.log` 并可在「审计」页查看。
- **镜像站登录（Registry Login）**：在「设置 - 镜像站登录」中以 `docker login` 方式登录私有 / 加速镜像站（如 `docker.1panel.live`、`registry.cn` 等），凭据保存在 WSL 的 `~/.docker/config.json`，可一键退出。
- **Docker 引擎更新（Engine Update）**：在「概览 - Docker 引擎管理」中一键通过 `apt` 升级 WSL 内 Docker 组件（docker-ce / docker.io、CLI、containerd、buildx、compose 插件），以管理员权限执行。
- **桌面外壳（Electron）**：独立 `.exe` 应用，托盘常驻、关闭窗口询问「最小化到托盘 / 退出」、首跑引导设置端口与账户、设置可免重启热应用。
- **常驻保活（Always-On）**：通过两层机制确保 WSL2 发行版与 Docker 引擎在「安装后」始终保持活跃、不会被系统空闲自动休眠 —— ① 后端进程内置常驻保活子进程（`wsl ... sleep infinity`）在应用运行期间持续持有 WSL 实例；② 安装脚本创建 `WslDockerKeepAlive` 计划任务，在应用关闭 / 重启后依旧每分钟保活重试，Docker 随 systemd 自动拉起。
- **环境检测与一键安装（Setup Wizard）**：项目启动后自动检测运行前置依赖 —— CPU 虚拟化（VT-x/AMD-V + 虚拟机平台功能）、WSL2、Debian 发行版、Docker 引擎（及是否最新版）、`.wslconfig` 配置、`DOCKER_HOST`、dockerd 2375 覆盖、保活计划任务等。任一项缺失 / 过时 / 配置不当，均可在「环境检测」页查看明细与修复建议，并由项目**以管理员权限（UAC 提权）一键安装并自动配置**完整环境；环境未就绪时顶栏会弹出提示横幅。

---

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│   Windows 主机                                                 │
│                                                               │
│   Electron 外壳 (可选)                                          │
│     ├─ 托盘 (Tray) + 设置窗口                                   │
│     └─ fork server.js 子进程 (ELECTRON_RUN_AS_NODE)            │
│                                                               │
│   Web 模式: supervisor.js (单实例协调锁, 自愈重启) → server.js  │
│                                                               │
│   ┌─────────────────── Express (server.js, :5050) ─────────┐  │
│   │  routes: containers/images/volumes/networks/           │  │
│   │          compose/tasks/settings/users/audit/           │  │
│   │          host/system/wslconfig                         │  │
│   │  src/docker.js  ← dockerode + wsl 执行                  │  │
│   └───────────────┬──────────────────────────────────────┘  │
│                   │ TCP 127.0.0.1:2375                         │
└───────────────────┼──────────────────────────────────────────┘
                    │
          ┌─────────▼──────────┐
          │   WSL2 (Debian)     │
          │   dockerd (TCP)     │
          │   容器 / 镜像 / 卷   │
          └─────────────────────┘

前端: public/ (无构建步骤)
  index.html + styles.css + js/{app,api,ui,tasks,views}.js
  Vue 3 通过 CDN (vue.global.js) + ES Module 直接加载
```

**关键端口**
- `5050` —— HTTP API 与 Web UI
- `5051` —— supervisor 单实例协调锁（只有绑住它的才是 leader，负责管理 server 子进程）

**数据流**
- 后端经 `wsl -d <distro> -u root` 执行 `docker` / `bash -c` 命令，或被 dockerode 通过 `127.0.0.1:2375` 直连。
- 用户表 / 审计 / compose 配置等可变数据默认落在项目内 `data/`，桌面版落在 `%APPDATA%/WslDockerManager/data`。

---

## 环境要求

| 组件 | 要求 |
|------|------|
| Windows | 10/11 64 位，已启用 WSL2 |
| WSL2 发行版 | 推荐 Debian / Ubuntu（默认 `Debian`，可在 `config.json` 改） |
| WSL2 内 Docker | 已安装并让 `dockerd` 监听 TCP `0.0.0.0:2375`（见下方「WSL2 Docker 监听配置」） |
| Node.js | ≥ 18（开发 / 网页模式）；桌面版自带 Electron 运行时无需单独安装 |
| 网络 | 软件源可达（引擎更新依赖 `apt`）；镜像站登录需要能访问目标 registry |

> **WSL2 Docker 监听配置（一次性）**
> 在 WSL 内让 dockerd 暴露 TCP 2375（仅本机回环，安全可控）：
> ```bash
> # 在 WSL 中执行，编辑 /etc/docker/daemon.json
> {
>   "hosts": ["unix:///var/run/docker.sock", "tcp://0.0.0.0:2375"]
> }
> sudo systemctl restart docker   # 或 service docker restart
> ```
> 若本机 2375 不通，面板会显示 Docker 不可达，并在恢复后自动拉起此前运行的容器。

---

## 安装

```bash
git clone <your-repo-url> WslDockerManager
cd WslDockerManager
npm install
```

> 仅 `express` / `dockerode` / `ws` 为运行时依赖；`electron` / `electron-builder` 仅桌面版与打包时需要。

---

## 运行

### 方式一：网页版（推荐，带自愈与单实例）

```bash
npm run supervisor
```

打开浏览器访问 `http://127.0.0.1:5050`。supervisor 会：
- 通过 5051 端口选举 leader，避免重复启动 server；
- server 崩溃 1 秒后自动重启；
- 每 15 秒健康检查，连续失败则 SIGKILL 重启。

### 方式二：纯 server（调试用）

```bash
npm start
```

### 方式三：Electron 桌面版（开发模式）

```bash
npm run electron
```

首跑会弹出设置窗口要求填写端口与管理员账户 / 密码；保存后启动后端并打开主界面。
之后关闭窗口可选择「最小化到托盘」或「退出」，设置会持久化到 `%APPDATA%/WslDockerManager/settings.json`。

---

## 配置

### `config.json`（项目根）

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `port` | `5050` | HTTP 端口 |
| `coordinatorPort` | `5051` | supervisor 单实例锁端口 |
| `dockerHost` / `dockerPort` | `127.0.0.1` / `2375` | WSL2 dockerd 地址 |
| `distro` | `Debian` | WSL 发行版名（`wsl -d` 用） |
| `dataDir` | `data` | 可变数据目录（相对项目根） |
| `autostartContainers` | `true` | Docker 恢复后自动拉起此前运行的容器 |
| `session.ttlHours` | `12` | 登录会话有效期 |
| `session.secret` | `CHANGE_ME...` | 会话签名密钥，**生产环境务必修改或设 `SESSION_SECRET` 环境变量** |

> 修改 `config.json` / `src/**` / `server.js` 后 **必须重启后端** 才能生效（supervisor 不热重载）。
> 正确重启：用 `netstat -ano -p TCP` 找到 5050 的 PID，`taskkill /PID <pid> /F` 杀掉 server 子进程，
> supervisor 会自动用磁盘新代码重启它（**不要杀 supervisor 本身**，否则可能冒出第二个 leader 抢 5051）。

### 环境变量（覆盖 config）

| 变量 | 作用 |
|------|------|
| `WSLDM_PORT` | 覆盖 HTTP 端口 |
| `WSLDM_DATA_DIR` | 覆盖数据目录（绝对路径） |
| `SESSION_SECRET` | 覆盖会话密钥 |
| `PASSWORD_OVERRIDE` | 首次播种管理员密码（覆盖随机密码） |

### 管理员账户

首次运行在 `data/secrets/users.json` 播种一个 `admin` 用户：
- 密码优先用 `PASSWORD_OVERRIDE` 环境变量；
- 否则随机生成并打印到 `wsl-docker.log`；
- 若 `users.json` 已存在则不重新播种。
- 之后可在「设置 - 账户」修改用户名 / 密码，或新增普通用户并分配权限。

---

## 镜像站登录（Registry Login）

> 需要 **管理员** 权限。

1. 进入「设置 → 镜像站登录」。
2. 填写：镜像站地址（如 `docker.1panel.live`）、用户名、密码，点击「登录」。
3. 后端执行 `docker login <registry> -u <user> --password-stdin`（密码走 stdin，避免 shell 转义问题）。
4. 凭据写入 WSL 的 `~/.docker/config.json` 的 `auths`，页面下方「已登录镜像站」列表实时显示。
5. 点击某项后的「退出」即执行 `docker logout <registry>`。

登录后拉取 / 更新镜像时即可享受该镜像站的认证与加速。

---

## Docker 引擎更新（Engine Update）

> 需要 **管理员** 权限。依赖 WSL 内 Debian/Ubuntu 软件源可达。

1. 在「概览 → Docker 引擎管理」卡片点击「更新 Docker 引擎」。
2. 危险操作会二次确认；确认后以 **后台任务** 执行：
   - `apt-get update`
   - `apt-get install --only-upgrade docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin`
   - （若检测到 `docker.io` 包则同样升级，兼容系统自带 Docker）
3. 任务进度可在「任务」页查看，完成后自动刷新概览，显示新的引擎版本。

---

## 环境检测与一键安装（Setup Wizard）

> 检测对**所有登录用户**可见；「一键安装」需要 **应用管理员** 权限，实际系统级修改通过 UAC 提权完成（非管理员进程也会弹出提权窗口，点「是」即可）。

**检测项**（在侧栏「环境检测」页查看，启动后顶栏也会提示缺失项）：

| 检测项 | 含义 / 修复 |
| --- | --- |
| CPU 虚拟化 | BIOS/UEFI 开启 VT-x/AMD-V + Windows「虚拟机平台」功能 |
| WSL2 | 是否已安装 WSL（`wsl --install` 后重启） |
| Debian 发行版 | 是否已安装目标发行版（`wsl --install -d Debian`） |
| Docker 引擎 | 是否安装且为最新版（`apt` 升级） |
| WSL 内核/运行时 | 是否为最新（`wsl --update`） |
| .wslconfig | 含 `memory` / `systemd=true` / `localhostForwarding=true` |
| DOCKER_HOST | Windows 侧用户环境变量 `tcp://localhost:2375` |
| dockerd 2375 覆盖 | systemd 覆盖文件含 `-H tcp://127.0.0.1:2375` |
| 保活计划任务 | `WslDockerKeepAlive` 是否存在 |
| Windows docker.exe | 可选组件（项目 `bin/` 目录） |

**一键安装**：点击「一键安装并自动配置」后，项目会提权运行 `install/setup-prereqs.ps1`，依次完成：启用虚拟化功能 → 安装/更新 WSL → 安装 Debian（必要时迁移到 D:）→ 写入 `.wslconfig` → 启用 systemd → 在 WSL 内安装 Docker 引擎 → 安装 Windows 侧 docker.exe 并设置 DOCKER_HOST → 创建自启与保活计划任务 → 验证。安装以**后台任务**形式执行，进度与日志在「环境检测」页实时显示；部分步骤（启用 Windows 功能 / 安装 WSL）可能需要**重启电脑**才能最终生效。

手动安装入口（兼容旧文档）：以管理员运行 `install/setup-wsl-docker.ps1`（它只是 `setup-prereqs.ps1` 的薄封装，自动探测项目根目录）。

---

## 镜像更新检查（Image Update Check）

- 对每个被跟踪的容器镜像，执行 manifest 检查并比对 **digest**：
  - 优先取 `Descriptor.digest`；
  - 若镜像源返回 `{"errors":[...]}`（如 `UNAUTHORIZED 401`）会显式报错而非误报「无法解析 digest」；
  - 失败时回退 `buildx imagetools inspect` 兜底取 digest。
- 多镜像源（如 `docker.1panel.live`、`docker.io` 镜像）均能识别并正确解析。
- 检查日志示例：`[时间] 检查 docker.1panel.live/linuxserver/jackett:latest 失败：<真实错误>`，便于定位是网络、鉴权还是源问题。

---

## 构建（打包桌面版）

需先 `npm install`（含 devDependencies 的 electron / electron-builder）。

```bash
# 便携版（单目录，解压即跑）
npm run dist:portable

# 安装版（NSIS，带卸载程序）
npm run dist:nsis

# 或二合一
npm run dist
```

产物在 `dist/`。打包态数据目录固定为 `%APPDATA%/WslDockerManager`，确保跨重启持久化。

---

## CI 自动构建（GitHub Actions）

仓库自带 `.github/workflows/build.yml`：

- **push 到 `main` 或开 PR**：自动在 `windows-latest` runner 上 `npm install` 并构建**便携版** exe，作为 Workflow Artifact 上传（不发布 Release）。
- **推送 `v*` tag（如 `v0.1.0`）**：额外构建 **NSIS 安装包**，并自动创建 GitHub Release，把两个 exe 作为发布资产附上。

> 构建不签名（`requestedExecutionLevel: requireAdministrator` 仅标记清单，运行时由 Windows 弹出一次 UAC）。如需签名，配置 CI Secret `CSC_LINK` / `CSC_KEY_PASSWORD` 并删除 `electron-builder.yml` 中 `CSC_IDENTITY_AUTO_DISCOVERY: 'false'` 的抑制。
> 更多见 [electron-builder 文档](https://www.electron.build/)。

---

## 关于 `bin/` 目录与大型二进制

`bin/docker.exe` / `bin/dockerd.exe`（约 100MB）**不纳入版本库**（已在 `.gitignore` 排除），由 `install/setup-prereqs.ps1` 在第 7 步自动从 Docker 官方源下载到本地 `bin/` 并加入 PATH。clone 后首次运行「一键安装」即会自动补齐，无需手动放置。

---

## 目录结构

```
WslDockerManager/
├─ server.js              # Express API 入口 (BUILD 标记: 2026-11-06f)
├─ supervisor.js          # 单实例协调 + 自愈重启
├─ config.json            # 运行配置
├─ package.json
├─ src/
│  ├─ config.js           # 路径解析 (支持 WSLDM_PORT / WSLDM_DATA_DIR)
│  ├─ docker.js           # dockerode + wsl 执行、资源读取、引擎更新、镜像站登录
│  ├─ wsl.js              # WSL 命令执行、dockerd 自愈
│  ├─ auth.js             # 会话 / 用户 / 权限
│  ├─ tasks.js            # 后台任务框架
│  ├─ logger.js / updateSettings.js
│  └─ routes/             # containers/images/volumes/networks/compose/
│                         # tasks/settings/users/audit/system/wslconfig
├─ public/                # 前端 (无构建步骤)
│  ├─ index.html          # 缓存令牌 ?v=20261106f
│  ├─ styles.css
│  └─ js/{app,api,ui,tasks,views}.js
├─ electron/              # 桌面外壳 (main.js / settings.html / icon.png ...)
└─ data/                  # 可变数据 (git 忽略)
   ├─ secrets/users.json  # 用户表
   ├─ compose/            # Compose 栈与备份
   └─ audit.log
```

---

## 常见问题（FAQ）

**Q：页面打不开 / 显示 Docker 不可达？**
A：确认 WSL2 已启动、`dockerd` 监听 `2375` 且本机 `127.0.0.1:2375` 可达；面板会在 Docker 恢复后自动重连并拉起容器。

**Q：改了后端代码没生效？**
A：后端不热重载。杀掉 5050 上的 server 子进程，supervisor 会用新代码重启；或直接重启 supervisor。

**Q：镜像更新检查报「无法从 manifest 解析出 digest」？**
A：旧版会把镜像源的真实错误（如 `401 UNAUTHORIZED`、源不可达）吞掉误报。新版已显式抛出真实错误并回退 `buildx imagetools inspect`，按日志里的真实原因排查网络 / 鉴权即可。

**Q：镜像站登录失败？**
A：确认镜像站地址、用户名、密码正确，且 WSL 内能访问该 registry；私有站需先登录才能拉取。

**Q：引擎更新卡住 / 失败？**
A：更新经 `apt` 执行，需 WSL 内 `apt` 软件源可达（能 `apt-get update`）。网络受限时可能超时。

**Q：桌面版数据去哪了？**
A：打包态落在 `%APPDATA%/WslDockerManager`；开发态与网页版一致，落在项目 `data/`。

---

## License

内部工具，按项目约定使用。
