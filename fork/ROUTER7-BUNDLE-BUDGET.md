# React Router 7 startup budget

PR #49 upgrades React Router from 6.30.6 to 7.18.3. The startup-size gate
failed after this intentional runtime upgrade, although unit tests, production
build, and all browser shards passed.

## Measurements

| Revision | Eager gzip bytes | Evidence |
| --- | ---: | --- |
| Base `b19a2fb2e`, React Router 6 | 367116 | [Base CI build](https://github.com/jtn0123/frigate/actions/runs/34781116414/job/103788216562) |
| PR `408b5c63d`, React Router 7 | 373629 | [PR CI build](https://github.com/jtn0123/frigate/actions/runs/34784794671/job/103798196833) |
| Difference | 6513 (1.77%) | Same base, upgraded router and compatibility fixes |

The previous limit was 370844 bytes, based on an older 353185-byte measurement
plus 5%. The current base had already consumed most of that allowance. The
Router 7 build exceeds the old limit by 2785 bytes.

The refreshed budget is **392311 bytes**, the measured CI size of 373629 times
1.05, rounded up. This preserves the established 5% headroom policy and records
the accepted cost of the router upgrade. The size calculation, build artifact
selection, compression settings, and CI enforcement remain unchanged.

A local production build reproduced the old-budget failure at 372543 bytes.
After updating the limit, `npm run bundle:budget` passed on those same artifacts.
CI is the reference measurement for the new limit.

PR #51 adds data routing and navigation guards on top of this upgrade. Its
separately documented 412650-byte budget includes that additional feature cost;
this Router 7 baseline does not replace that later measurement.
