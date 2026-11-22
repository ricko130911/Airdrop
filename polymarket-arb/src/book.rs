//! Flat-array order book: O(1) level updates, no allocation on the hot path.
//!
//! Prices are stored as integer "pips" of 0.0001 (Polymarket's smallest tick), so a price
//! is an index into a fixed array of 10_001 slots.

pub const SCALE: u32 = 10_000;
const SLOTS: usize = SCALE as usize + 1;
const NONE: u32 = u32::MAX;

/// Parse a decimal price string such as `"0.523"` into pips (5230). Returns `None` for
/// anything outside `[0, 1]` or malformed. Much faster than going through a Decimal/f64.
#[inline]
pub fn parse_px(s: &str) -> Option<u32> {
    let b = s.as_bytes();
    let (int_part, frac) = match b.iter().position(|&c| c == b'.') {
        Some(i) => (&b[..i], &b[i + 1..]),
        None => (b, &b[..0]),
    };
    let mut whole: u32 = 0;
    for &c in int_part {
        if !c.is_ascii_digit() {
            return None;
        }
        whole = whole * 10 + u32::from(c - b'0');
        if whole > 1 {
            return None;
        }
    }
    let mut v = whole * SCALE;
    let mut mul = SCALE / 10;
    for &c in frac {
        if !c.is_ascii_digit() {
            return None;
        }
        if mul == 0 {
            // more precision than 1e-4: ignore trailing digits (must be zeros on Polymarket)
            break;
        }
        v += u32::from(c - b'0') * mul;
        mul /= 10;
    }
    (v <= SCALE).then_some(v)
}

#[inline]
pub fn px_to_f64(px: u32) -> f64 {
    f64::from(px) / f64::from(SCALE)
}

/// One side (asks) of a book. We only ever buy, so asks are all the arb logic needs.
pub struct AskBook {
    sizes: Box<[f64]>,
    best: u32,
}

impl Default for AskBook {
    fn default() -> Self {
        Self {
            sizes: vec![0.0; SLOTS].into_boxed_slice(),
            best: NONE,
        }
    }
}

impl AskBook {
    pub fn clear(&mut self) {
        self.sizes.fill(0.0);
        self.best = NONE;
    }

    /// Set the total resting size at `px` (0 removes the level).
    #[inline]
    pub fn set(&mut self, px: u32, size: f64) {
        let i = px as usize;
        if i >= SLOTS {
            return;
        }
        let size = if size > 0.0 { size } else { 0.0 };
        self.sizes[i] = size;
        if size > 0.0 {
            if self.best == NONE || px < self.best {
                self.best = px;
            }
        } else if px == self.best {
            self.best = self.scan_from(px + 1);
        }
    }

    /// Remove `size` from the level at `px` (used to mark liquidity we just took, so we
    /// don't fire twice on the same stale level before the exchange's update arrives).
    #[inline]
    pub fn consume(&mut self, px: u32, size: f64) {
        let i = px as usize;
        if i < SLOTS {
            let left = self.sizes[i] - size;
            self.set(px, if left > 1e-9 { left } else { 0.0 });
        }
    }

    fn scan_from(&self, start: u32) -> u32 {
        (start..=SCALE)
            .find(|&p| self.sizes[p as usize] > 0.0)
            .unwrap_or(NONE)
    }

    #[inline]
    pub fn size(&self, px: u32) -> f64 {
        self.sizes.get(px as usize).copied().unwrap_or(0.0)
    }

    #[inline]
    pub fn best(&self) -> Option<u32> {
        (self.best != NONE).then_some(self.best)
    }

    /// Iterate `(price_pips, size)` from the best ask upwards.
    pub fn levels(&self) -> impl Iterator<Item = (u32, f64)> + '_ {
        let start = if self.best == NONE { SCALE + 1 } else { self.best };
        (start..=SCALE).filter_map(move |p| {
            let s = self.sizes[p as usize];
            (s > 0.0).then_some((p, s))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_prices() {
        assert_eq!(parse_px("0.523"), Some(5230));
        assert_eq!(parse_px("0.01"), Some(100));
        assert_eq!(parse_px(".5"), Some(5000));
        assert_eq!(parse_px("1"), Some(10_000));
        assert_eq!(parse_px("1.0"), Some(10_000));
        assert_eq!(parse_px("0.0001"), Some(1));
        assert_eq!(parse_px("0.99000"), Some(9900));
        assert_eq!(parse_px("2"), None);
        assert_eq!(parse_px("abc"), None);
    }

    #[test]
    fn best_ask_tracking() {
        let mut b = AskBook::default();
        assert_eq!(b.best(), None);
        b.set(5000, 10.0);
        b.set(4800, 5.0);
        assert_eq!(b.best(), Some(4800));
        b.set(4800, 0.0);
        assert_eq!(b.best(), Some(5000));
        b.consume(5000, 4.0);
        assert_eq!(b.levels().collect::<Vec<_>>(), vec![(5000, 6.0)]);
        b.consume(5000, 6.0);
        assert_eq!(b.best(), None);
    }
}
