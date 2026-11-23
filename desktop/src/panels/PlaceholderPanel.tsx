type Props = { title: string; deviceSn?: string };

export default function PlaceholderPanel({ title, deviceSn }: Props) {
  return (
    <div className="placeholder">
      <strong>{title}</strong>
      {deviceSn ? (
        <>
          <br />
          设备 {deviceSn}
        </>
      ) : null}
      <br />
      此页将在后续迁入；当前请用 Tk 版完整功能。
    </div>
  );
}
