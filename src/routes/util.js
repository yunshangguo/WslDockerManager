// Shared helpers for route modules: async error wrapper + audit re-export.
const { audit } = require('../audit');

// 把 dockerode / docker CLI 常见的英文报错翻译成中文，降低理解门槛。
// 既匹配原始 message，也匹配 dockerode 包在 e.json.message / e.reason 里的信息。
const ERROR_MAP = [
  [/no such container/i, '容器不存在或已被删除'],
  [/no such image/i, '镜像不存在或已被删除'],
  [/no such network/i, '网络不存在或已被删除'],
  [/no such volume/i, '卷不存在或已被删除'],
  [/no such volume or volume driver/i, '卷不存在或卷驱动不可用'],
  [/conflict(:|\.|\s)/i, '资源冲突：名称或配置已存在'],
  [/permission denied/i, '权限不足（请确认运行身份或文件权限）'],
  [/port is already allocated/i, '端口已被占用，请更换宿主机端口'],
  [/bind: address already in use/i, '地址/端口已被占用'],
  [/driver failed programming external connectivity/i, '端口映射失败（可能端口被占用或防火墙拦截）'],
  [/denied: requested access to the resource is denied/i, '镜像拉取/推送被拒绝，请检查登录凭据或权限'],
  [/unauthorized/i, '未授权，请重新登录'],
  [/authentication required/i, '需要登录镜像仓库（请先 docker login）'],
  [/cannot connect to the docker daemon/i, '无法连接 Docker 守护进程，请确认 WSL / Docker 已启动'],
  [/is the docker daemon running/i, 'Docker 守护进程未运行，请确认 WSL 内 Docker 已启动'],
  [/network not found/i, '网络不存在'],
  [/invalid reference format/i, '镜像名格式非法（应为 repo:tag）'],
  [/unable to find a record/i, '未找到对应记录'],
  [/image is being used by/i, '镜像正在被容器使用，无法删除（请先删除相关容器）'],
  [/volume is in use/i, '卷正在被使用，无法删除'],
  [/container is running/i, '容器正在运行，请先停止再执行该操作'],
  [/you cannot remove a running container/i, '不能删除运行中的容器，请先停止'],
  [/no space left on device/i, '磁盘空间不足'],
  [/pull access denied/i, '拉取被拒绝（镜像不存在或无权限）'],
  [/manifest unknown/i, '镜像清单不存在（仓库/标签错误）'],
  [/tls: failed to verify certificate/i, '仓库证书校验失败（自签名证书需配置信任）'],
];

function extractMsg(e) {
  if (!e) return '未知错误';
  if (typeof e === 'string') return e;
  let msg = e.message || e.reason || '';
  if (!msg && e.json && e.json.message) msg = e.json.message;
  if (!msg && e.statusCode) msg = 'HTTP ' + e.statusCode;
  return msg || 'upstream error';
}

function localizeError(e) {
  const msg = extractMsg(e);
  for (const [re, zh] of ERROR_MAP) {
    if (re.test(msg)) return zh + (msg !== zh ? '（' + msg + '）' : '');
  }
  return msg;
}

function asyncHandler(fn) {
  return (req, res) => {
    Promise.resolve(fn(req, res)).catch((e) => {
      // 默认 500（应用内部错误）。仅当上游明确带有 statusCode（如 dockerode 的
      // 404/409）时才沿用，避免把「无法连接 Docker 守护进程」这类无 statusCode
      // 的错误误报成 502（Bad Gateway），误导用户以为是网关/代理问题。
      const code = e.statusCode || 500;
      res.status(code).json({ error: localizeError(e) });
    });
  };
}

module.exports = { asyncHandler, audit, localizeError };
