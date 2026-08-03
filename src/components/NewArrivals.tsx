import { useEffect, useMemo, useState } from "react";
import stocksData from "../data/stocks.json";
import { reviewKey } from "../reviewAlerts";
import type { Stock } from "../types";
import { addedInfo, agoLabel, consClass, consLabel, DATE_LOCALE, firstSeen, fmtMc, fmtPx, LIST_LABEL, NEW_WINDOW_DAYS, scoreColor } from "../lib";
import { consDir, type ConsDir } from "../consensus";
import { Chip, UpBar } from "./StockTable";
import type { Mark, MarkEntry } from "../watchlist";
import ThumbMark from "./ThumbMark";

function symMark(v?: Mark): string {
  return v === "up" ? "mk-up" : v === "down" ? "mk-down" : "";
}

const STOCKS = stocksData as Stock[];

const fmtDate = (iso: string): string => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(DATE_LOCALE, { month: "numeric", day: "numeric" });
};

interface Change {
  k: string;
  o: string;
  n: string;
  dir: ConsDir; // null = direction unknown, render the change with no up/down colour
}

// what moved for this ticker since it was first tracked (baseline in seen.json → current)
function changesFor(s: Stock): Change[] {
  const fs = firstSeen(s.t);
  if (!fs) return [];
  const out: Change[] = [];
  if (fs.ss != null && s.ss != null && fs.ss !== s.ss)
    out.push({ k: "Smart Score", o: String(fs.ss), n: String(s.ss), dir: s.ss > fs.ss ? "up" : "down" });
  if (fs.ai != null && s.ai != null && fs.ai !== s.ai)
    out.push({ k: "AI Score", o: String(fs.ai), n: String(s.ai), dir: s.ai > fs.ai ? "up" : "down" });
  if (fs.con && s.con && fs.con !== s.con)
    out.push({
      k: "Consensus",
      o: consLabel(fs.con),
      n: consLabel(s.con),
      dir: consDir(fs.con, s.con),
    });
  return out;
}

// newest analyst review per ticker, from public/reviews-recent.json (built by CI)
interface ReviewItem {
  t: string;
  n: string | null; // analyst
  f: string | null; // firm
  r: string | null; // Buy/Hold/Sell
  pt: number | null; // new target
  opt: number | null; // prior target (shows "old → new")
  d: string; // review date
}

interface NewArrivalsProps {
  onOpen: (s: Stock, list?: Stock[]) => void;
  onOpenReview: (s: Stock, list: Stock[], key: string) => void; // opens the forecast view + glows this review
  marks: Record<string, MarkEntry>;
  onMark: (t: string, v: Mark) => void;
}

export default function NewArrivals({ onOpen, onOpenReview, marks, onMark }: NewArrivalsProps) {
  // recent analyst reviews across the screener, from the CI-built feed
  const [reviews, setReviews] = useState<Record<string, ReviewItem>>({});
  useEffect(() => {
    let cancelled = false;
    fetch(`${import.meta.env.BASE_URL}reviews-recent.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled || !j || !Array.isArray(j.items)) return;
        const m: Record<string, ReviewItem> = {};
        for (const it of j.items as ReviewItem[]) m[it.t] = it;
        setReviews(m);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // unified arrivals: newly-listed stocks and/or stocks with a fresh review, newest first
  const items = useMemo(() => {
    const day = (iso: string) => Date.parse(iso.slice(0, 10) + "T00:00:00") || 0;
    type Row = { s: Stock; info: ReturnType<typeof addedInfo>; review: ReviewItem | null; when: number };
    const byT = new Map<string, Row>();
    for (const s of STOCKS) {
      const info = addedInfo(s.t);
      if (info) byT.set(s.t, { s, info, review: null, when: day(info.date) });
    }
    for (const t of Object.keys(reviews)) {
      const s = STOCKS.find((x) => x.t === t);
      if (!s) continue;
      const rev = reviews[t];
      const ex = byT.get(t);
      if (ex) {
        ex.review = rev;
        ex.when = Math.max(ex.when, day(rev.d));
      } else {
        byT.set(t, { s, info: null, review: rev, when: day(rev.d) });
      }
    }
    return [...byT.values()].sort((a, b) => b.when - a.when || (b.s.up ?? -Infinity) - (a.s.up ?? -Infinity));
  }, [reviews]);
  const listStocks = useMemo(() => items.map((x) => x.s), [items]);

  return (
    <div className="bob">
      <header className="bob-masthead">
        <div className="bob-eyebrow">New · last {NEW_WINDOW_DAYS} days</div>
        <h2 className="bob-title">
          New <span className="em">Arrivals</span>
        </h2>
        <div className="bob-counts">
          <span>
            <b>{items.filter((x) => x.info && !x.review).length}</b> newly listed
          </span>
          <span>
            <b>{items.filter((x) => x.review).length}</b> with a fresh review
          </span>
        </div>
      </header>

      {items.length === 0 ? (
        <div className="bob-empty">No new names this month.</div>
      ) : (
        <div className="na-wrap">
          <table className="na-table">
            <thead>
              <tr>
                <th className="l">Added</th>
                <th className="l">Changes</th>
                <th className="l">Ticker / Company</th>
                <th className="l">Sector</th>
                <th>Upside</th>
                <th>Price</th>
                <th className="c">Consensus</th>
                <th>Smart Score</th>
                <th>AI Score</th>
                <th>Mkt Cap</th>
              </tr>
            </thead>
            <tbody>
              {items.map(({ s, info, review }) => {
                const chg = changesFor(s);
                const lists = firstSeen(s.t)?.l ?? [];
                const raised = !review || review.opt == null || review.pt == null || review.pt >= review.opt;
                return (
                  <tr
                    key={s.t}
                    className="row-open"
                    onClick={() => (review ? onOpenReview(s, listStocks, reviewKey(review)) : onOpen(s, listStocks))}
                  >
                    <td className="na-added">
                      {review ? (
                        <>
                          <span className="na-pill rev">
                            <span className="na-pd" aria-hidden="true" />
                            <span className="na-pt">review</span>
                          </span>
                          <span className="na-date">{fmtDate(review.d)}</span>
                        </>
                      ) : info ? (
                        <>
                          <span className={`na-pill ${info.daysAgo <= 2 ? "" : "old"}`}>
                            <span className="na-pd" aria-hidden="true" />
                            <span className="na-pt">{agoLabel(info.daysAgo, info.hoursAgo)}</span>
                          </span>
                          <span className="na-date">{fmtDate(info.date)}</span>
                        </>
                      ) : null}
                    </td>
                    <td className="na-chg l">
                      {review ? (
                        <div className="na-rev">
                          <span className="na-revan">
                            <b>{review.n || "—"}</b>
                            {review.f ? <small> · {review.f}</small> : null}
                          </span>
                          <span className="na-revpt">
                            {review.opt != null && (
                              <>
                                <span className="o">{fmtPx(review.opt)}</span>
                                <span className="a">→</span>
                              </>
                            )}
                            <span className={raised ? "up" : "dn"}>{fmtPx(review.pt)}</span>
                          </span>
                        </div>
                      ) : (
                        <>
                          {(lists.length > 0 || chg.length === 0) && (
                            <div className="na-chgline">
                              {lists.map((k) => (
                                <span key={k} className={`na-list ${k}`}>{LIST_LABEL[k] ?? k}</span>
                              ))}
                              {chg.length === 0 && (
                                <span className="na-new">
                                  <span className="na-newdot" aria-hidden="true" />New
                                </span>
                              )}
                            </div>
                          )}
                          {chg.map((c, i) => (
                            <div className="na-chgrow" key={i}>
                              <span className="na-chgk">{c.k}</span>
                              <span className="na-chip">{c.o}</span>
                              <span className="na-arr">→</span>
                              <span className={c.dir ? `na-chip n ${c.dir}` : "na-chip n"}>{c.n}</span>
                            </div>
                          ))}
                        </>
                      )}
                    </td>
                    <td className="tk">
                      <div className="tk-inner">
                        <div className="tk-main">
                          <span className="tk-top">
                            <button className={`sym ${symMark(marks[s.t]?.v)}`} type="button">
                              {s.t}
                            </button>
                          </span>
                          <div className="co">{s.n || ""}</div>
                        </div>
                        <ThumbMark mark={marks[s.t]} onMark={(v) => onMark(s.t, v)} />
                      </div>
                    </td>
                    <td className="na-sec l">{s.sec || "—"}</td>
                    <td className="na-up">
                      <UpBar up={s.up} />
                    </td>
                    <td className="num">{fmtPx(s.px)}</td>
                    <td className="con-cell">
                      <span className={`pill ${consClass(s.con)}`}>{consLabel(s.con)}</span>
                      <div className="dist">{s.b}·{s.h}·{s.s}</div>
                    </td>
                    <td>
                      <Chip v={s.ss} max={10} />
                    </td>
                    <td>
                      {s.ai == null ? (
                        <span className="dash">—</span>
                      ) : (
                        <span className="na-ai" style={{ color: scoreColor(s.ai, 100)! }}>
                          {s.ai}
                          {s.air ? <small>{s.air}</small> : null}
                        </span>
                      )}
                    </td>
                    <td className="num">{fmtMc(s.mc)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
