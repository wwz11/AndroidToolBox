/** 状态栏提示色：按文案推断，避免各处手写 tone */
export type StatusTone = "neutral" | "ok" | "err" | "warn" | "busy";

export function inferStatusTone(text: string): StatusTone {
  const t = (text || "").trim();
  if (!t || t === "就绪") return "neutral";

  if (
    /失败|错误|无法|超时|不可用|未安装|未就绪|未连接设备|连接失败|WebSocket 失败|不支持|退出 \d+|Error|fail|Failed to fetch|aborted|Permission|denied|拒绝|禁止|无权限|权限不足|没有权限|not allowed|not permitted|Access is denied/i.test(
      t,
    )
  ) {
    return "err";
  }

  if (
    /请先|请填写|请至少|队列为空|未找到|无串口|无端口|尚无|无可|路径为空|浏览模式|已断开|已关闭|已停止|投屏已停止|已请求停止|版本过旧|未连接|OTA 路径不能为空|无法启动|未勾选 A\/B|将跳过 OTA/.test(
      t,
    )
  ) {
    return "warn";
  }

  if (
    /…$|中…|生成中|计算中|处理 |安装中|抓取中|连接中|正在连接|截图中|启动中|复制到|执行 |运行 \d+|U-Boot|投屏中|持续抓取|交互中|生成 bugreport/.test(
      t,
    ) ||
    (t.includes("…") && !/完成|已/.test(t))
  ) {
    return "busy";
  }

  if (
    /完成|已连接|已打开|已保存|已导出|已复制|已加入|已分析|已切换|已发送|成功|交互 Shell|root 完成|编码完成|解码完成|截图完成|个包|个端口|个文件|字符|bytes|×|按键 /.test(
      t,
    )
  ) {
    return "ok";
  }

  return "neutral";
}

/** 用于 status-text / remote-status / emmc-status-line */
export function statusToneClass(
  text: string,
  base: "status-text" | "remote-status" | "emmc-status-line" = "status-text",
): string {
  const tone = inferStatusTone(text);
  return tone === "neutral" ? base : `${base} is-${tone}`;
}
