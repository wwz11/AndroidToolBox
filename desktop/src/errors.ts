/** 本机 API 失败。status 为 0 表示请求没有到达服务。 */
export class ApiError extends Error {
  readonly status: number;
  readonly path: string;

  constructor(message: string, status: number, path: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.path = path;
  }
}

const PERMISSION_DENIED_RE =
  /permission denied|access denied|operation not permitted|not allowed|eacces|eperm|无权限|权限不足|没有权限/i;

function withRootHint(msg: string): string {
  if (!PERMISSION_DENIED_RE.test(msg) || /root/i.test(msg)) return msg;
  const nl = msg.indexOf("\n");
  const hint = "（请尝试先点击设备「Root」后重试）";
  if (nl === -1) return `${msg}${hint}`;
  return `${msg.slice(0, nl)}${hint}${msg.slice(nl)}`;
}

export function toErrorMessage(error: unknown, fallback = "操作失败"): string {
  if (error instanceof Error && error.message.trim()) {
    return withRootHint(error.message);
  }
  if (typeof error === "string" && error.trim()) return withRootHint(error);
  return fallback;
}
