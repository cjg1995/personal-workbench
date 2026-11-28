const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

export function parseLocalDate(isoDate: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate || "");
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function weekdayChar(isoDate: string): string {
  const d = parseLocalDate(isoDate);
  return d ? WEEKDAYS[d.getDay()] : "";
}

export function formatChromeDate(isoDate: string): {
  date: string;
  weekday: string;
} {
  const d = parseLocalDate(isoDate) || new Date();
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return {
    date: `${y} 年 ${m} 月 ${day} 日`,
    weekday: `星期${WEEKDAYS[d.getDay()]}`,
  };
}

export function formatFullDate(isoDate: string | null | undefined): string {
  if (!isoDate) return "未填写日期";
  const d = parseLocalDate(isoDate);
  if (!d) return isoDate;
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日 · 星期${WEEKDAYS[d.getDay()]}`;
}

export const projectTypeLabels: Record<string, string> = {
  tomcat: "Java / Tomcat",
  spring: "Spring Boot",
  h5: "UniApp H5",
  vue: "Vue 前端",
  wechat: "微信原生小程序",
  "uni-wechat": "UniApp 小程序",
};

export function formatBytes(bytes: number | null | undefined): string {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "未指定";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatTimeHM(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatMonthTitle(monthStr: string): {
  year: string;
  monthNum: number;
  label: string;
} {
  const m = /^(\d{4})-(\d{2})$/.exec(monthStr || "");
  if (!m) {
    const now = new Date();
    const mn = now.getMonth() + 1;
    return { year: `${now.getFullYear()} 年`, monthNum: mn, label: `${now.getFullYear()} 年 ${mn} 月` };
  }
  const y = Number(m[1]);
  const mn = Number(m[2]);
  return { year: `${y} 年`, monthNum: mn, label: `${y} 年 ${mn} 月` };
}

export function formatMonthDay(
  isoDate: string | null | undefined,
  padded = false,
): string {
  const d = isoDate ? parseLocalDate(isoDate) : null;
  if (!d) return "未指定日期";
  const m = padded
    ? String(d.getMonth() + 1).padStart(2, "0")
    : String(d.getMonth() + 1);
  const day = padded ? String(d.getDate()).padStart(2, "0") : String(d.getDate());
  return `${m} 月 ${day} 日`;
}

export function formatGroupDate(
  isoDate: string,
  currentYear: number,
): { title: string; weekday: string } {
  const d = parseLocalDate(isoDate);
  if (!d) return { title: isoDate, weekday: "" };
  const y = d.getFullYear();
  const prefix = y !== currentYear ? `${y} 年 ` : "";
  return {
    title: `${prefix}${d.getMonth() + 1} 月 ${d.getDate()} 日`,
    weekday: `星期${WEEKDAYS[d.getDay()]}`,
  };
}

export interface CalendarDay {
  date: string;
  day: number;
  dayStr: string;
  weekday: string;
}

export function getMonthDays(monthStr: string): CalendarDay[] {
  const m = /^(\d{4})-(\d{2})$/.exec(monthStr || "");
  const year = m ? Number(m[1]) : new Date().getFullYear();
  const month = m ? Number(m[2]) : new Date().getMonth() + 1;
  const count = new Date(year, month, 0).getDate();
  const pad = (n: number) => String(n).padStart(2, "0");
  const mm = pad(month);
  const days: CalendarDay[] = [];
  for (let day = 1; day <= count; day++) {
    const dayStr = pad(day);
    const wd = WEEKDAYS[new Date(year, month - 1, day).getDay()];
    days.push({
      date: `${year}-${mm}-${dayStr}`,
      day,
      dayStr,
      weekday: wd,
    });
  }
  return days;
}

export {
  formatNoteLabel,
  formatNotePreview,
  formatNoteText,
} from "../shared/note-text";

export function splitFilePath(filePath: string): { dir: string; name: string } {
  const slash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  if (slash < 0) return { dir: "", name: filePath };
  return {
    dir: filePath.slice(0, slash + 1),
    name: filePath.slice(slash + 1),
  };
}
