// Daily / weekly study goal progress (pure).
export const GOAL_LIMITS = { dailyMin: 10, dailyMax: 960, weeklyMax: 6720 };

export function validateGoals(daily, weekly) {
  if (!Number.isInteger(daily) || daily < GOAL_LIMITS.dailyMin || daily > GOAL_LIMITS.dailyMax) return `Daily goal must be between ${GOAL_LIMITS.dailyMin} minutes and 16 hours`;
  if (!Number.isInteger(weekly) || weekly < daily || weekly > GOAL_LIMITS.weeklyMax) return "Weekly goal must be at least the daily goal and at most 112 hours";
  return null;
}

// minutesByDate: { "YYYY-MM-DD": minutes }; goal: { daily_minutes, weekly_minutes } | null
export function goalProgress({ goal, minutesByDate, today, weekDates, shift }) {
  const minutesOn = d => Number(minutesByDate[d] || 0);
  const todayMinutes = minutesOn(today);
  const weekMinutes = weekDates.reduce((sum, d) => sum + minutesOn(d), 0);
  const days = weekDates.map((date, i) => {
    const minutes = minutesOn(date);
    let status;
    if (!goal) status = date > today ? "upcoming" : "none";
    else if (date > today) status = "upcoming";
    else if (minutes >= goal.daily_minutes) status = "met";
    else status = date === today ? "today" : "missed";
    return { date, weekday: i + 1, minutes, status };
  });
  let streak = 0;
  if (goal) {
    let cursor = todayMinutes >= goal.daily_minutes ? today : shift(today, -1);
    while (minutesOn(cursor) >= goal.daily_minutes && streak < 400) { streak++; cursor = shift(cursor, -1); }
  }
  const percent = (value, goalValue) => (goalValue ? Math.min(100, Math.round(value * 100 / goalValue)) : 0);
  return {
    goal: goal ? { daily_minutes: goal.daily_minutes, weekly_minutes: goal.weekly_minutes } : null,
    daily: { minutes: todayMinutes, percent: percent(todayMinutes, goal?.daily_minutes), remaining: goal ? Math.max(0, goal.daily_minutes - todayMinutes) : 0 },
    weekly: { minutes: weekMinutes, percent: percent(weekMinutes, goal?.weekly_minutes), remaining: goal ? Math.max(0, goal.weekly_minutes - weekMinutes) : 0 },
    days,
    streak,
  };
}
