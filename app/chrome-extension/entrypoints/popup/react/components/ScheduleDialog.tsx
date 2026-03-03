import { useEffect, useState } from "react";
import { getMessage } from "@/utils/i18n";

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

export function ScheduleDialog({
  visible,
  flowId,
  schedules,
  onClose,
  onSave,
  onRemove,
}: ScheduleDialogProps) {
  const t = (key: string, fallback: string, substitutions?: string[]) =>
    getMessage(key, substitutions, fallback);

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

  const describe = (schedule: PopupSchedule): string => {
    if (schedule.type === "interval") {
      return t("scheduleDescribeInterval", "Every {0} minutes", [schedule.when]);
    }
    if (schedule.type === "daily") {
      return t("scheduleDescribeDaily", "Daily at {0}", [schedule.when]);
    }
    if (schedule.type === "once") {
      return t("scheduleDescribeOnce", "One time at {0}", [schedule.when]);
    }
    return "";
  };

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
          <div className="title">{t("scheduleDialogTitle", "Scheduled execution")}</div>
          <button type="button" className="close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="rr-body">
          <div className="row">
            <label>{t("scheduleEnableLabel", "Enable")}</label>
            <label className="chk">
              <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.currentTarget.checked)} />
              {t("scheduleEnableTiming", "Enable timing")}
            </label>
          </div>
          <div className="row">
            <label>{t("scheduleTypeLabel", "Type")}</label>
            <select value={type} onChange={(event) => setType(event.currentTarget.value as ScheduleType)}>
              <option value="interval">{t("scheduleTypeInterval", "Every N minutes")}</option>
              <option value="daily">{t("scheduleTypeDaily", "Fixed time every day")}</option>
              <option value="once">{t("scheduleTypeOnce", "Execute only once")}</option>
            </select>
          </div>
          {type === "interval" ? (
            <div className="row">
              <label>{t("scheduleIntervalLabel", "Interval (minutes)")}</label>
              <input
                type="number"
                value={intervalMinutes}
                onChange={(event) => setIntervalMinutes(Number(event.currentTarget.value || "0"))}
              />
            </div>
          ) : null}
          {type === "daily" ? (
            <div className="row">
              <label>{t("scheduleDailyTimeLabel", "Time (HH:mm)")}</label>
              <input
                value={dailyTime}
                placeholder={t("scheduleDailyTimePlaceholder", "For example 09:30")}
                onChange={(event) => setDailyTime(event.currentTarget.value)}
              />
            </div>
          ) : null}
          {type === "once" ? (
            <div className="row">
              <label>{t("scheduleOnceTimeLabel", "Time (ISO)")}</label>
              <input
                value={onceAt}
                placeholder={t("scheduleOnceTimePlaceholder", "For example 2025-10-05T10:00:00")}
                onChange={(event) => setOnceAt(event.currentTarget.value)}
              />
            </div>
          ) : null}
          <div className="row">
            <label>{t("scheduleParametersLabel", "Parameters (JSON)")}</label>
            <textarea
              value={argsJson}
              placeholder={t("scheduleParametersPlaceholder", '{ "username": "xx" }')}
              onChange={(event) => setArgsJson(event.currentTarget.value)}
            />
          </div>
          <div className="section">
            <div className="section-title">{t("scheduleExistingPlansTitle", "Already have plans")}</div>
            <div className="sched-list">
              {schedules.map((schedule) => (
                <div className="sched-row" key={schedule.id}>
                  <div className="meta">
                    <span className={`badge ${schedule.enabled ? "on" : "off"}`}>{schedule.type}</span>
                    <span className="desc">{describe(schedule)}</span>
                  </div>
                  <div className="actions">
                    <button type="button" className="small danger" onClick={() => onRemove(schedule.id)}>
                      {t("deleteButton", "Delete")}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="rr-footer">
          <button type="button" className="primary" onClick={save}>
            {t("saveButton", "Save")}
          </button>
        </div>
      </div>
    </div>
  );
}
