import type { DeviceRow } from "../api/client";
import { adbStateLabel } from "../adbDevices";

type Props = {
  selected: string;
  options: string[];
  pendingRows: DeviceRow[];
  emptyText: string;
  title?: string;
  onBeginPick: () => void;
  onEndPick: () => void;
  onChange: (sn: string) => void;
};

export default function DevicePickSelect({
  selected,
  options,
  pendingRows,
  emptyText,
  title,
  onBeginPick,
  onEndPick,
  onChange,
}: Props) {
  return (
    <select
      className="field device-connect-sn"
      value={selected}
      title={title}
      aria-label="选择 ADB 设备"
      onPointerDown={onBeginPick}
      onFocus={onBeginPick}
      onBlur={onEndPick}
      onChange={(e) => onChange(e.target.value)}
    >
      {!options.length ? <option value="">{emptyText}</option> : null}
      {options.map((sn) => (
        <option key={sn} value={sn}>
          {sn}
        </option>
      ))}
      {pendingRows.map((row) => (
        <option key={`pending-${row.serial}`} value={row.serial} disabled>
          {row.serial}（{adbStateLabel(row.state)}）
        </option>
      ))}
    </select>
  );
}
