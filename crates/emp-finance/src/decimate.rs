//! Largest-Triangle-Three-Buckets downsampling for charts (§13.5: above 500 points, Rust decimates to at
//! most 2× the pixel width).

/// Point budget for a chart `pixel_width` wide.
pub fn budget_for_width(pixel_width: u32) -> usize {
    (pixel_width as usize).saturating_mul(2).max(3)
}

/// Downsamples `(x, y)` points (sorted by x) to at most `threshold` points with LTTB. Inputs at or below the
/// threshold (or a threshold below 3) are returned unchanged. First and last points are always kept.
/// Non-finite points are dropped first.
pub fn lttb(points: &[(f64, f64)], threshold: usize) -> Vec<(f64, f64)> {
    let pts: Vec<(f64, f64)> = points
        .iter()
        .copied()
        .filter(|(x, y)| x.is_finite() && y.is_finite())
        .collect();
    let n = pts.len();
    if threshold < 3 || n <= threshold {
        return pts;
    }
    let mut out = Vec::with_capacity(threshold);
    out.push(pts[0]);
    let every = (n - 2) as f64 / (threshold - 2) as f64;
    let mut a = 0usize;
    for i in 0..threshold - 2 {
        let start = (i as f64 * every).floor() as usize + 1;
        let end = (((i + 1) as f64 * every).floor() as usize + 1).min(n - 1);
        let next_start = end;
        let next_end = ((((i + 2) as f64) * every).floor() as usize + 1).min(n);
        let (mut ax, mut ay, mut cnt) = (0.0, 0.0, 0.0);
        for p in &pts[next_start..next_end.max(next_start + 1).min(n)] {
            ax += p.0;
            ay += p.1;
            cnt += 1.0;
        }
        let (avg_x, avg_y) = if cnt > 0.0 {
            (ax / cnt, ay / cnt)
        } else {
            pts[n - 1]
        };
        let (px, py) = pts[a];
        let mut best = start;
        let mut best_area = -1.0;
        for (j, p) in pts.iter().enumerate().take(end.max(start + 1)).skip(start) {
            let area = ((px - avg_x) * (p.1 - py) - (px - p.0) * (avg_y - py)).abs();
            if area > best_area {
                best_area = area;
                best = j;
            }
        }
        out.push(pts[best]);
        a = best;
    }
    out.push(pts[n - 1]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_shape_and_bounds() {
        let pts: Vec<(f64, f64)> = (0..5000)
            .map(|i| {
                (
                    i as f64,
                    if i == 2500 {
                        1000.0
                    } else {
                        (i as f64 / 100.0).sin()
                    },
                )
            })
            .collect();
        let d = lttb(&pts, 200);
        assert_eq!(d.len(), 200);
        assert_eq!(d[0], pts[0]);
        assert_eq!(*d.last().unwrap(), pts[4999]);
        assert!(d.iter().any(|p| p.1 == 1000.0), "spike must survive");
        assert!(d.windows(2).all(|w| w[0].0 < w[1].0), "x stays increasing");
        assert_eq!(lttb(&pts[..10], 200).len(), 10);
        assert_eq!(lttb(&[(0.0, f64::NAN), (1.0, 1.0)], 10).len(), 1);
        assert_eq!(budget_for_width(640), 1280);
    }
}
