import { useMemo, useState } from "react";
import { useDialog } from "../components/dialog";
import { useStatusNotify } from "../components/toast";
import { Button } from "../ui";

type SerialRemoteAction = {
  label: string;
  /** 经串口发出的整行命令（末尾换行由发送侧补） */
  cmd: string;
  hint: string;
  confirm?: string;
  danger?: boolean;
};

type Props = {
  /** 串口是否已打开 */
  serialOpen: boolean;
  /** 向当前串口会话写入原始字节 */
  onSend: (text: string) => void;
  onClose: () => void;
};

const DPAD_LAYOUT: Array<Array<string | null>> = [
  ["主页", "返回", "设置"],
  [null, "上", null],
  ["左", "确定", "右"],
  [null, "下", null],
];

const DPAD_GLYPH: Record<string, string> = {
  上: "▲",
  下: "▼",
  左: "◀",
  右: "▶",
  确定: "OK",
};

/** Android shell 在串口上的按键 / 快捷命令（与 ADB 遥控同码） */
const KEY_ACTIONS: SerialRemoteAction[] = [
  { label: "主页", cmd: "input keyevent 3", hint: "KEYCODE_HOME" },
  { label: "返回", cmd: "input keyevent 4", hint: "KEYCODE_BACK" },
  {
    label: "设置",
    cmd: "am start -n com.android.tv.settings/.MainSettings",
    hint: "打开 TV Settings",
  },
  { label: "上", cmd: "input keyevent 19", hint: "KEYCODE_DPAD_UP" },
  { label: "下", cmd: "input keyevent 20", hint: "KEYCODE_DPAD_DOWN" },
  { label: "左", cmd: "input keyevent 21", hint: "KEYCODE_DPAD_LEFT" },
  { label: "右", cmd: "input keyevent 22", hint: "KEYCODE_DPAD_RIGHT" },
  { label: "确定", cmd: "input keyevent 23", hint: "KEYCODE_DPAD_CENTER" },
];

const APP_ACTIONS: SerialRemoteAction[] = [
  {
    label: "Netflix",
    cmd: "am start -n com.netflix.ninja/.MainActivity",
    hint: "启动 Netflix",
  },
  {
    label: "YouTube",
    cmd: "am start -n com.google.android.youtube.tv/.HomeActivity",
    hint: "启动 YouTube",
  },
  {
    label: "重启",
    cmd: "reboot",
    hint: "串口发送 reboot",
    confirm: "将通过串口发送 reboot，设备会重启。确定继续？",
    danger: true,
  },
  {
    label: "格式化",
    cmd: "am broadcast -a android.intent.action.FACTORY_RESET android",
    hint: "恢复出厂（需权限）",
    confirm:
      "将通过串口下发恢复出厂广播，用户数据可能被清除且不可恢复。\n请确认已进入 Android shell。\n\n确定继续？",
    danger: true,
  },
];

/** 串口页侧栏遥控器：经当前串口发 shell 命令，不走 ADB。 */
export default function SerialRemotePad({
  serialOpen,
  onSend,
  onClose,
}: Props) {
  const dialog = useDialog();
  const setStatus = useStatusNotify();
  const [busy, setBusy] = useState(false);

  const actionMap = useMemo(() => {
    const m = new Map<string, SerialRemoteAction>();
    for (const a of KEY_ACTIONS) m.set(a.label, a);
    return m;
  }, []);

  async function fire(act: SerialRemoteAction) {
    if (!serialOpen) {
      setStatus("请先打开串口");
      return;
    }
    if (act.confirm) {
      const ok = await dialog.confirm({
        title: act.label,
        message: act.confirm,
        confirmLabel: "发送",
        cancelLabel: "取消",
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      // 与串口终端 Enter 一致：CR，便于 Android shell / getty
      onSend(`${act.cmd}\r`);
      setStatus(`串口 → ${act.label}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="serial-remote" aria-label="串口遥控器">
      <header className="serial-remote-head">
        <strong>遥控器</strong>
        <button
          type="button"
          className="serial-remote-close"
          title="收起遥控器"
          onClick={onClose}
        >
          ×
        </button>
      </header>

      <p className="serial-remote-hint">
        {serialOpen
          ? "经当前串口发送 shell（input keyevent / am …）"
          : "请先打开串口后再遥控"}
      </p>

      <div className="remote-pad serial-remote-pad" role="group" aria-label="方向键">
        <div className="remote-dpad">
          {DPAD_LAYOUT.map((row, ri) =>
            row.map((label, ci) => {
              if (!label) {
                return (
                  <span key={`e-${ri}-${ci}`} className="remote-dpad-gap" />
                );
              }
              const act = actionMap.get(label);
              const isOk = label === "确定";
              const isNav =
                label === "上" ||
                label === "下" ||
                label === "左" ||
                label === "右";
              const isSys =
                label === "主页" || label === "返回" || label === "设置";
              return (
                <button
                  key={label}
                  type="button"
                  className={`remote-key${isOk ? " ok" : ""}${
                    isNav ? " nav" : ""
                  }${isSys ? " sys" : ""}`}
                  disabled={!serialOpen || busy || !act}
                  title={act ? `${act.hint}\n${act.cmd}` : label}
                  aria-label={label}
                  onClick={() => {
                    if (act) void fire(act);
                  }}
                >
                  <span className="remote-key-glyph">
                    {DPAD_GLYPH[label] || label}
                  </span>
                </button>
              );
            }),
          )}
        </div>

        <div className="remote-apps" role="group" aria-label="快捷">
          {APP_ACTIONS.map((a) => (
            <button
              key={a.label}
              type="button"
              className={`remote-key remote-key-app${a.danger ? " danger" : ""}`}
              disabled={!serialOpen || busy}
              title={`${a.hint}\n${a.cmd}`}
              onClick={() => void fire(a)}
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>

      <div className="serial-remote-foot">
        <Button size="sm" variant="ghost" onClick={onClose}>
          收起
        </Button>
      </div>
    </aside>
  );
}
