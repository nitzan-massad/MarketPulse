export interface Stock {
  /** Ticker symbol */
  t: string;
  /** Company name */
  n: string;
  /** Sector */
  sec: string;
  /** Last price */
  px: number | null;
  /** Day change % */
  chg: number | null;
  /** Best price target */
  pt: number | null;
  /** Upside % to target */
  up: number | null;
  /** Consensus name e.g. "StrongBuy" / "Buy" / "Hold" / "Sell" / "StrongSell" */
  con: string;
  /** Analyst buy count */
  b: number;
  /** Analyst hold count */
  h: number;
  /** Analyst sell count */
  s: number;
  /** Smart score 1–10 or null */
  ss: number | null;
  /** AI score 0–100 or null */
  ai: number | null;
  /** AI rating text */
  air: string | null;
  /** AI price target */
  aipt: number | null;
  /** Market cap in $millions */
  mc: number | null;
  /** Company description (from screener) */
  desc?: string | null;
  /** Bull/bear signal labels: blogger, hedge fund, insider, news consensus + investor sentiment (0–1) */
  sig?: {
    bl: string | null;
    hf: string | null;
    ins: string | null;
    nw: string | null;
    iv: number | null;
  };
}

export type ViewId = "analyst" | "smart" | "ai";

export interface View {
  title: string;
  dek: string;
  tab: string;
  sub: string;
  sort: keyof Stock;
  dir: number;
  hl: keyof Stock;
}

export interface Col {
  k: string;
  l: string;
  cls?: string;
  sortable: boolean;
}
