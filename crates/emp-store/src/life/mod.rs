//! Habits, recurrence, natural-language dates and the reminder scheduler (SPEC §15.8).
//!
//! * [`recurrence`]: RFC 5545 rules (`rrule` + `chrono-tz`), schedule / completion modes, business days.
//! * [`nlp_dates`]: the authoritative natural-language date parser ("next fri 3pm", "every 2 weeks", `#tag`).
//! * [`habits`]: streaks with grace modes and completion rates.
//! * [`scheduler`]: fires due reminders and computes the next wake-up.

pub mod habits;
pub mod nlp_dates;
pub mod recurrence;
pub mod scheduler;
