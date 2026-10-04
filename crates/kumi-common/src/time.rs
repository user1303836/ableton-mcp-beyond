//! Clocks as the TypeScript used them: `Date.now()` (milliseconds since the epoch) and
//! `performance.now()` (monotonic milliseconds since the process started).

use std::sync::OnceLock;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

/// `Date.now()`: milliseconds since the Unix epoch.
pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// `Date.now()` as JavaScript's number: whole milliseconds, as an `f64`.
pub fn now_ms_f64() -> f64 {
    now_ms() as f64
}

static START: OnceLock<Instant> = OnceLock::new();

/// `performance.now()`: monotonic milliseconds (fractional) since this clock was first read.
pub fn perf_now() -> f64 {
    let start = START.get_or_init(Instant::now);
    start.elapsed().as_secs_f64() * 1000.0
}

/// `new Date(ms).toISOString()`, for the few places the TypeScript wrote one.
pub fn iso_string(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z", rem / 3600, (rem % 3600) / 60, rem % 60)
}

/// Howard Hinnant's days-to-civil algorithm.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_strings_match_javascript() {
        assert_eq!(iso_string(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_string(1_759_500_000_123), "2025-10-03T14:00:00.123Z");
        assert_eq!(iso_string(-1), "1969-12-31T23:59:59.999Z");
    }

    #[test]
    fn perf_now_is_monotonic() {
        let a = perf_now();
        let b = perf_now();
        assert!(b >= a);
    }
}
