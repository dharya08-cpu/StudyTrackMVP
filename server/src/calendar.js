// Merges classes, homework deadlines, tests, events and holidays into one calendar (pure).
export const MAX_RANGE_DAYS = 62;

export function dateRange(from, to, shift) {
  const out = [];
  for (let d = from; d <= to; d = shift(d, 1)) out.push(d);
  return out;
}
const eventAppliesTo = (event, cls) => (event.class_ids.length ? event.class_ids.includes(cls.id) : Boolean(event.institute_id) && cls.institute_id === event.institute_id);

// classes: [{id,name,institute_id}]  schedule: [{id,class_id,weekday,start_time,end_time,subject,room}]
// homework: [{id,class_id,title,due_date}]  tests: [{id,class_id,title,subject,test_date}]
// events: [{id,kind,title,description,start_date,end_date,start_time,end_time,institute_id,class_ids}]  exams: [{id,subject,title,exam_date}]
export function buildCalendar({ from, to, classes, schedule, homework, tests, events, exams = [], clock }) {
  const classById = new Map(classes.map(c => [c.id, c]));
  const dates = dateRange(from, to, clock.shift);
  const out = [];
  const holidayOn = (cls, date) => events.some(e => e.kind === "holiday" && e.start_date <= date && e.end_date >= date && eventAppliesTo(e, cls));
  for (const date of dates) {
    const weekday = clock.weekday(date);
    for (const slot of schedule) {
      if (slot.weekday !== weekday) continue;
      const cls = classById.get(slot.class_id);
      if (!cls) continue;
      out.push({ key: `class-${slot.id}-${date}`, kind: "class", title: slot.subject, date, start_time: slot.start_time, end_time: slot.end_time, class_id: cls.id, class_name: cls.name, detail: slot.room || "", on_holiday: holidayOn(cls, date) });
    }
  }
  for (const h of homework) {
    if (h.due_date && h.due_date >= from && h.due_date <= to && classById.has(h.class_id)) {
      out.push({ key: `homework-${h.id}`, kind: "homework", title: h.title, date: h.due_date, start_time: "", end_time: "", class_id: h.class_id, class_name: classById.get(h.class_id).name, detail: "Homework due" });
    }
  }
  for (const t of tests) {
    if (t.test_date && t.test_date >= from && t.test_date <= to && classById.has(t.class_id)) {
      out.push({ key: `test-${t.id}`, kind: "test", title: t.title, date: t.test_date, start_time: "", end_time: "", class_id: t.class_id, class_name: classById.get(t.class_id).name, detail: t.subject });
    }
  }
  for (const e of events) {
    const applicable = classes.filter(c => eventAppliesTo(e, c));
    if (!applicable.length) continue;
    for (const date of dates) {
      if (date < e.start_date || date > e.end_date) continue;
      out.push({ key: `event-${e.id}-${date}`, kind: e.kind, title: e.title, date, start_time: e.start_time || "", end_time: e.end_time || "", class_id: applicable.length === 1 ? applicable[0].id : null, class_name: applicable.map(c => c.name).join(", "), detail: e.description || "", event_id: e.id });
    }
  }
  for (const x of exams) {
    if (x.exam_date >= from && x.exam_date <= to) out.push({ key: `exam-${x.id}`, kind: "exam", title: x.title, date: x.exam_date, start_time: "", end_time: "", class_id: null, class_name: "", detail: x.subject });
  }
  const order = { holiday: 0, exam: 1, test: 2, homework: 3, event: 4, class: 5 };
  return out.sort((a, b) => a.date.localeCompare(b.date) || (a.start_time || "").localeCompare(b.start_time || "") || order[a.kind] - order[b.kind] || a.title.localeCompare(b.title));
}
