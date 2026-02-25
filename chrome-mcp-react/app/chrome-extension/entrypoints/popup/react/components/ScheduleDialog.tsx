import { useEffect, useState } from "react";

import "./ScheduleDialog.css";

type ScheduleType = "interval" | "daily" | "once";

export type PopupSchedule = {
  id: string;
  flowId: string;
  type: ScheduleType;
  enabled: boolean;
  when: string;
  args: Record<string, unknown>;
};

export type ScheduleDialogProps = {
  visible: boolean;
  flowId: string | null;
  schedules: PopupSchedule[];
  onClose: () => void;
  onSave: (schedule: PopupSchedule) => void;
  onRemove: (id: string) => void;
};

function safeParse(input: string): Record<string, unknown> {
  if (!input.trim()) return {};
  try {
    return JSON.parse(input);
  } catch {
    return {};
  }
}

function describe(schedule: PopupSchedule): string {
  if (schedule.type === "interval") return `每 ${schedule.when} 分钟`;
  if (schedule.type === "daily") return `每天 ${schedule.when}`;
  if (schedule.type === "once") return `一次 ${schedule.when}`;
  return "";
}

export function ScheduleDialog({
  visible,
  flowId,
  schedules,
  onClose,
  onSave,
  onRemove,
}: ScheduleDialogProps) {
  const [enabled, setEnabled] = useState(true);
  const [type, setType] = useState<ScheduleType>("interval");
  const [intervalMinutes, setIntervalMinutes] = useState(30);
  const [dailyTime, setDailyTime] = useState("09:00");
  const [onceAt, setOnceAt] = useState("");
  const [argsJson, setArgsJson] = useState("");

  useEffect(() => {
    if (!visible) {
      return;
    }
    setEnabled(true);
    setType("interval");
    setIntervalMinutes(30);
    setDailyTime("09:00");
    setOnceAt("");
    setArgsJson("");
  }, [visible]);

  if (!visible) {
    return null;
  }

  const save = () => {
    if (!flowId) {
      return;
    }

    const schedule: PopupSchedule = {
      id: `sch_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      flowId,
      type,
      enabled,
      when: type === "interval" ? String(intervalMinutes) : type === "daily" ? dailyTime : onceAt,
      args: safeParse(argsJson),
    };

    onSave(schedule);
  };

  return (
    <div className="rr-modal" onClick={onClose}>
      <div className="rr-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="rr-header">
          <div className="title">定时执行</div>
          <button type="button" className="close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="rr-body">
          <div className="row">
            <label>启用</label>
            <label className="chk">
              <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.currentTarget.checked)} />
              启用定时
            </label>
          </div>
          <div className="row">
            <label>类型</label>
            <select value={type} onChange={(event) => setType(event.currentTarget.value as ScheduleType)}>
              <option value="interval">每隔 N 分钟</option>
              <option value="daily">每天固定时间</option>
              <option value="once">只执行一次</option>
            </select>
          </div>
          {type === "interval" ? (
            <div className="row">
              <label>间隔(分钟)</label>
              <input
                type="number"
                value={intervalMinutes}
                onChange={(event) => setIntervalMinutes(Number(event.currentTarget.value || "0"))}
              />
            </div>
          ) : null}
          {type === "daily" ? (
            <div className="row">
              <label>时间(HH:mm)</label>
              <input value={dailyTime} placeholder="例如 09:30" onChange={(event) => setDailyTime(event.currentTarget.value)} />
            </div>
          ) : null}
          {type === "once" ? (
            <div className="row">
              <label>时间(ISO)</label>
              <input
                value={onceAt}
                placeholder="例如 2025-10-05T10:00:00"
                onChange={(event) => setOnceAt(event.currentTarget.value)}
              />
            </div>
          ) : null}
          <div className="row">
            <label>参数(JSON)</label>
            <textarea
              value={argsJson}
              placeholder='{ "username": "xx" }'
              onChange={(event) => setArgsJson(event.currentTarget.value)}
            />
          </div>
          <div className="section">
            <div className="section-title">已有计划</div>
            <div className="sched-list">
              {schedules.map((schedule) => (
                <div className="sched-row" key={schedule.id}>
                  <div className="meta">
                    <span className={`badge ${schedule.enabled ? "on" : "off"}`}>{schedule.type}</span>
                    <span className="desc">{describe(schedule)}</span>
                  </div>
                  <div className="actions">
                    <button type="button" className="small danger" onClick={() => onRemove(schedule.id)}>
                      删除
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="rr-footer">
          <button type="button" className="primary" onClick={save}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
