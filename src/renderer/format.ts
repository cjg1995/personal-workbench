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

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "未指定";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}　${pad(d.getHours())}:${pad(d.getMinutes())}`;
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

export function splitNoteText(raw: string): { title: string; body: string } {
  const normalized = (raw || "").replace(/\r\n/g, "\n").trim();
  if (!normalized) return { title: "", body: "" };
  const lines = normalized.split("\n");
  if (lines.length > 1) {
    const first = lines[0].trim();
    const rest = lines.slice(1).join("\n").trim();
    return { title: first || rest, body: first ? rest : "" };
  }
  if (normalized.length > 22) {
    // Split on Chinese colon or period when prefix looks like a concise heading.
    const colon = normalized.indexOf("：");
    if (colon >= 3 && colon <= 36 && normalized.length - colon - 1 >= 6) {
      return {
        title: normalized.slice(0, colon).trim(),
        body: normalized.slice(colon + 1).trim(),
      };
    }
    const period = normalized.indexOf("。");
    if (period >= 4 && period <= 36 && normalized.length - period - 1 >= 6) {
      return {
        title: normalized.slice(0, period).trim(),
        body: normalized.slice(period + 1).trim(),
      };
    }
  }
  return { title: normalized, body: "" };
}

export function splitFilePath(filePath: string): { dir: string; name: string } {
  const slash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  if (slash < 0) return { dir: "", name: filePath };
  return {
    dir: filePath.slice(0, slash + 1),
    name: filePath.slice(slash + 1),
  };
}
