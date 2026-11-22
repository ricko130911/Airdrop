//! Complete-set arbitrage math.
//!
//! In a binary UP/DOWN market exactly one side pays $1 per share at resolution. If we can buy
//! one UP share and one DOWN share for less than $1 in total (including taker fees), the
//! profit is locked in regardless of the outcome.
//!
//! `find` walks both ask ladders at the same time (cheapest first) and takes as many shares
//! as possible while the *marginal* pair cost stays under the threshold.

use crate::book::{AskBook, px_to_f64};

/// Polymarket V2 platform taker fee: `rate * (p * (1 - p))^exponent` USDC per share.
#[derive(Clone, Copy, Debug, Default)]
pub struct FeeModel {
    pub rate: f64,
    pub exponent: u32,
}

impl FeeModel {
    #[inline]
    pub fn per_share(&self, p: f64) -> f64 {
        if self.rate == 0.0 {
            return 0.0;
        }
        let base = p * (1.0 - p);
        self.rate * base.powi(self.exponent as i32)
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    /// Max total cost per share pair (both asks + both fees).
    pub max_pair_cost: f64,
    pub max_shares: f64,
    /// Max USDC (both legs incl. fees) for this trade.
    pub max_usdc: f64,
    /// Exchange minimum order size in shares.
    pub min_shares: f64,
    /// Minimum notional per leg.
    pub min_leg_usdc: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Opportunity {
    /// Shares to buy on each leg (2-decimal lot size).
    pub shares: f64,
    /// Limit price (pips) for the UP leg: the worst level we need to sweep.
    pub up_px: u32,
    /// Limit price (pips) for the DOWN leg.
    pub down_px: u32,
    /// Expected USDC paid for the UP leg (excl. fees).
    pub up_cost: f64,
    /// Expected USDC paid for the DOWN leg (excl. fees).
    pub down_cost: f64,
    /// Expected total fees.
    pub fees: f64,
}

impl Opportunity {
    pub fn total_cost(&self) -> f64 {
        self.up_cost + self.down_cost + self.fees
    }
    pub fn avg_pair_cost(&self) -> f64 {
        self.total_cost() / self.shares
    }
    /// Locked-in profit at resolution (payout is `shares * $1`).
    pub fn expected_profit(&self) -> f64 {
        self.shares - self.total_cost()
    }
}

#[inline]
fn floor_lot(x: f64) -> f64 {
    (x * 100.0 + 1e-9).floor() / 100.0
}

pub fn find(
    up: &AskBook,
    down: &AskBook,
    fee_up: &FeeModel,
    fee_down: &FeeModel,
    lim: &Limits,
) -> Option<Opportunity> {
    // Cheap reject: best asks alone already too expensive.
    let (bu, bd) = (up.best()?, down.best()?);
    let (pu0, pd0) = (px_to_f64(bu), px_to_f64(bd));
    if pu0 + pd0 + fee_up.per_share(pu0) + fee_down.per_share(pd0) > lim.max_pair_cost {
        return None;
    }

    let mut ui = up.levels();
    let mut di = down.levels();
    let (mut u, mut d) = (ui.next()?, di.next()?);

    let mut shares = 0.0_f64;
    let mut spent = 0.0_f64;
    let (mut up_px, mut down_px) = (u.0, d.0);
    // (price, shares) taken per level, to recompute exact costs after lot rounding
    let mut up_fills: [(u32, f64); 32] = [(0, 0.0); 32];
    let mut down_fills: [(u32, f64); 32] = [(0, 0.0); 32];
    let (mut nu, mut nd) = (0usize, 0usize);

    loop {
        let (pu, pd) = (px_to_f64(u.0), px_to_f64(d.0));
        let unit = pu + pd + fee_up.per_share(pu) + fee_down.per_share(pd);
        if unit > lim.max_pair_cost {
            break;
        }
        let mut take = u.1.min(d.1).min(lim.max_shares - shares);
        let budget = lim.max_usdc - spent;
        if take * unit > budget {
            take = budget / unit;
        }
        if take <= 0.0 {
            break;
        }
        let new_u = nu == 0 || up_fills[nu - 1].0 != u.0;
        let new_d = nd == 0 || down_fills[nd - 1].0 != d.0;
        if (new_u && nu == up_fills.len()) || (new_d && nd == down_fills.len()) {
            break; // swept 32 levels already: plenty
        }
        if new_u {
            up_fills[nu] = (u.0, 0.0);
            nu += 1;
        }
        if new_d {
            down_fills[nd] = (d.0, 0.0);
            nd += 1;
        }
        up_fills[nu - 1].1 += take;
        down_fills[nd - 1].1 += take;
        shares += take;
        spent += take * unit;
        up_px = u.0;
        down_px = d.0;

        if shares >= lim.max_shares - 1e-9 || spent >= lim.max_usdc - 1e-9 {
            break;
        }
        u.1 -= take;
        d.1 -= take;
        if u.1 <= 1e-9 {
            match ui.next() {
                Some(x) => u = x,
                None => break,
            }
        }
        if d.1 <= 1e-9 {
            match di.next() {
                Some(x) => d = x,
                None => break,
            }
        }
    }

    let shares = floor_lot(shares);
    if shares < lim.min_shares.max(0.01) {
        return None;
    }

    // Exact expected cost of `shares` shares on each ladder (cheapest levels first).
    let cost = |fills: &[(u32, f64)], fee: &FeeModel| {
        let (mut left, mut px_cost, mut fee_cost) = (shares, 0.0, 0.0);
        for &(px, sz) in fills {
            let t = sz.min(left);
            let p = px_to_f64(px);
            px_cost += t * p;
            fee_cost += t * fee.per_share(p);
            left -= t;
            if left <= 1e-9 {
                break;
            }
        }
        (px_cost, fee_cost)
    };
    let (up_cost, up_fee) = cost(&up_fills[..nu], fee_up);
    let (down_cost, down_fee) = cost(&down_fills[..nd], fee_down);

    if up_cost < lim.min_leg_usdc || down_cost < lim.min_leg_usdc {
        return None;
    }

    Some(Opportunity {
        shares,
        up_px,
        down_px,
        up_cost,
        down_cost,
        fees: up_fee + down_fee,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn book(levels: &[(u32, f64)]) -> AskBook {
        let mut b = AskBook::default();
        for &(p, s) in levels {
            b.set(p, s);
        }
        b
    }

    fn lim() -> Limits {
        Limits {
            max_pair_cost: 0.98,
            max_shares: 1_000.0,
            max_usdc: 10_000.0,
            min_shares: 5.0,
            min_leg_usdc: 1.0,
        }
    }

    const NO_FEE: FeeModel = FeeModel {
        rate: 0.0,
        exponent: 0,
    };

    #[test]
    fn no_arb_when_sum_too_high() {
        let up = book(&[(5000, 100.0)]);
        let down = book(&[(4900, 100.0)]);
        assert!(find(&up, &down, &NO_FEE, &NO_FEE, &lim()).is_none());
    }

    #[test]
    fn simple_arb() {
        let up = book(&[(4800, 100.0)]);
        let down = book(&[(4900, 60.0)]);
        let o = find(&up, &down, &NO_FEE, &NO_FEE, &lim()).unwrap();
        assert_eq!(o.shares, 60.0);
        assert_eq!((o.up_px, o.down_px), (4800, 4900));
        assert!((o.avg_pair_cost() - 0.97).abs() < 1e-9);
        assert!((o.expected_profit() - 1.8).abs() < 1e-9);
    }

    #[test]
    fn walks_multiple_levels_until_threshold() {
        // 50 @ 0.45+0.50=0.95, then 30 @ 0.47+0.50=0.97, then 0.49+0.50=0.99 (stop)
        let up = book(&[(4500, 50.0), (4700, 30.0), (4900, 500.0)]);
        let down = book(&[(5000, 1000.0)]);
        let o = find(&up, &down, &NO_FEE, &NO_FEE, &lim()).unwrap();
        assert_eq!(o.shares, 80.0);
        assert_eq!((o.up_px, o.down_px), (4700, 5000));
        assert!((o.up_cost - (50.0 * 0.45 + 30.0 * 0.47)).abs() < 1e-9);
    }

    #[test]
    fn respects_budget() {
        let up = book(&[(4000, 1000.0)]);
        let down = book(&[(5000, 1000.0)]);
        let mut l = lim();
        l.max_usdc = 90.0; // 0.90 per pair -> 100 shares
        let o = find(&up, &down, &NO_FEE, &NO_FEE, &l).unwrap();
        assert_eq!(o.shares, 100.0);
        assert!(o.total_cost() <= 90.0 + 1e-9);
    }

    #[test]
    fn fees_can_kill_the_edge() {
        let up = book(&[(4850, 100.0)]);
        let down = book(&[(4850, 100.0)]);
        // 0.97 before fees; a 2.5% rate at p(1-p)=0.2498 with exponent 1 adds ~0.0125 total.
        let fee = FeeModel {
            rate: 0.025,
            exponent: 1,
        };
        assert!(find(&up, &down, &NO_FEE, &NO_FEE, &lim()).is_some());
        assert!(find(&up, &down, &fee, &fee, &lim()).is_none());
    }

    #[test]
    fn below_min_size_is_ignored() {
        let up = book(&[(4000, 3.0)]);
        let down = book(&[(4000, 3.0)]);
        assert!(find(&up, &down, &NO_FEE, &NO_FEE, &lim()).is_none());
    }
}
