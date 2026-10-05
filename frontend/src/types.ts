export type Level = "green" | "yellow" | "orange" | "red";
export type Rating = "fine" | "uneasy" | "bad";

export interface AnalysisSummary {
  id: number;
  name: string;
  createdAt: string;
  lengthM: number;
  level: Level;
  maxScore: number;
  terrainSource: string;
  confidence: "high" | "low";
  rating: Rating | null;
  /** 'hike' from a GPX file, 'route' from a Google Maps link. */
  kind: "hike" | "route";
  sourceUrl: string | null;
  /** Whether it has been done, or is only being considered. */
  status: Status;
}

export type Status = "planned" | "done";

/** How something not done yet stands against your marks elsewhere. */
export interface Verdict {
  tone: "beyond" | "difficult" | "unknown" | "fine";
  reference: ReferenceLink | null;
  /** Length at or above the reference's score, metres. */
  lengthAtOrAboveM: number;
  /** Set when only a spot or two reach that level: how many, where the first starts, and how the rest stands. */
  brief: { spots: number; firstAtM: number; restTone: Verdict["tone"] } | null;
}

export type LegMode = "hike" | "walk" | "drive" | "bus" | "rail" | "lift" | "ferry";
export type NoGoKind = "cableCars" | "funiculars" | "rackRailways";

/** One stretch of a route travelled in one way, e.g. a single train ride. */
export interface Leg {
  mode: LegMode;
  label: string;
  startM: number;
  endM: number;
  /** For rides: which side the drops are on, per stretch between reversals of direction. */
  sides?: SideSummary[];
}

export interface SideSummary {
  startM: number;
  endM: number;
  /** Flagged length with the drop on the left only, the right only, or both sides. */
  leftM: number;
  rightM: number;
  bothM: number;
  /** Side to sit on, relative to the direction of travel; 'either' when nothing is flagged, 'none' when neither is better. */
  sit: "left" | "right" | "either" | "none";
}

export interface PointMetrics {
  elevation: number;
  slopeDeg: number;
  crossSlopeDeg: number;
  fallLeft: number;
  fallRight: number;
  drop10: number;
  drop30: number;
  drop100: number;
  dropLeft30: number;
  dropRight30: number;
  trackGradeDeg: number;
  bridgeGap: number;
}

export interface PointContext {
  forest: boolean;
  matched: boolean;
  tunnel: boolean;
  bridge: boolean;
  wide: boolean;
  sacGrade: number | null;
  aided: boolean;
  cliff: boolean;
  noGo?: NoGoKind | null;
}

export interface AnalysedPoint {
  dist: number;
  lon: number;
  lat: number;
  score: number | null;
  /** Terrain-only score, before forest, tunnels and track width are applied. */
  rawScore?: number | null;
  /** The part of the score from the ground beside the route, and the part from the view. */
  dropScore: number | null;
  viewScore: number | null;
  /** Depth of the view down across the arc that counts, metres. */
  viewDepthM: number | null;
  context?: PointContext | null;
  scoreLow: number | null;
  scoreHigh: number | null;
  level: Level | null;
  metrics: PointMetrics | null;
}

/** A stretch you marked, on this or another hike. */
export interface ReferenceLink {
  analysisId: number;
  name: string;
  kind: MarkKind;
  startM: number;
  endM: number;
}

export interface Section {
  level: Level;
  startM: number;
  endM: number;
  lengthM: number;
  maxScore: number;
  rawMaxScore?: number;
  context?: {
    forest: boolean;
    tunnel: boolean;
    bridge: boolean;
    wideTrack: boolean;
    sacGrade: number | null;
    aided: boolean;
    cliff: boolean;
    noGo?: NoGoKind | null;
  } | null;
  robustScore: number;
  maxFallM: number;
  maxDrop30M: number;
  maxCrossSlopeDeg: number;
  side: "left" | "right" | "both";
  dropTowards: string;
  /** What flagged this stretch: the ground beside the route, the view, or both. */
  cause: "drops" | "view" | "both";
  maxViewDepthM: number;
  /** Your own verdict on this stretch, if you marked it. */
  yourMark?: MarkKind | null;
  /** A marked stretch, here or on another hike, that measures much the same. */
  similar?: ReferenceLink | null;
  /** Set when nothing similar is marked but this scores above the hardest stretch you found difficult. */
  harderThan?: ReferenceLink | null;
  possibleBridge: boolean;
  worst: { dist: number; lon: number; lat: number; elevation: number };
  links: { swisstopo: string | null; google: string };
}

export interface Analysis {
  name: string | null;
  lengthM: number;
  spacingM: number;
  terrain: { source: string; cellSize: number; confidence: "high" | "low" };
  /** Absent on hikes analysed before map context existed. */
  mapContext?: boolean;
  /** Score at which Mild, Exposed and Severe start. */
  thresholds: [number, number, number];
  profile: "hike" | "road";
  legs: Leg[];
  summary: {
    maxScore: number;
    level: Level;
    lengthByLevelM: Record<Level, number>;
    noDataM: number;
  };
  sections: Section[];
  points: AnalysedPoint[];
}

export type MarkKind = "fine" | "uneasy" | "bad" | "turned_back";

/** How a stretch of the hike felt in reality; a point when startM equals endM. */
export interface Mark {
  id: number;
  kind: MarkKind;
  startM: number;
  endM: number;
  note: string | null;
  createdAt: string;
}

/** A stretch of the route, in metres from the start. */
export interface Range {
  startM: number;
  endM: number;
}

export interface AnalysisDetail {
  summary: AnalysisSummary;
  marks: Mark[];
  /** Only present while the entry is planned and there are marks to judge by. */
  verdict: Verdict | null;
  result: Analysis;
}

type Pair = [number, number];

/** Every tweakable knob; one set applies to all hikes. Mirrors the backend. */
export interface ScoreSettings {
    fallHeightM: Pair;
    drop10M: Pair;
    drop30M: Pair;
    drop100M: Pair;
    crossSlopeDeg: Pair;
    trackGradeDeg: Pair;
    bridgeGapM: Pair;
    ridgeDropM: number;
    ridgeFactor: number;
    thresholds: [number, number, number];
    forestFactor: number;
    wideTrackFactor: number;
    dropWeight: number;
    mergeGapM: number;
    minLengthM: number;
    viewDepthM: Pair;
    viewArcDeg: number;
    viewFarWeight: number;
    viewForestFactor: number;
    viewFactor: number;
}

export interface Settings {
  /** For hikes and walked stretches. */
  score: ScoreSettings;
  /** The same knobs for car, bus and train. */
  road: ScoreSettings;
  measure: {
    fallSlopeDeg: number;
    fallRunoutM: number;
    gpsErrorM: number;
    forestCheckM: number;
  };
  noGo: { cableCars: boolean; funiculars: boolean; rackRailways: boolean };
}

export interface Disagreement {
  analysisId: number;
  name: string;
  kind: MarkKind;
  startM: number;
  endM: number;
  level: Level;
}

export interface SettingsResponse {
  settings: Settings;
  defaults: Settings;
  /** How the current settings agree with the marks across all hikes. */
  fit: { marks: number; overFlagged: Disagreement[]; missed: Disagreement[] };
  /** Whether an applied suggestion can still be undone. */
  canRevert: boolean;
}

export interface EntryState {
  level: Level;
  maxScore: number;
  /** Forecast tone, for entries still planned. */
  forecast: Verdict["tone"] | null;
}

/** Settings that would fit your marks better, and what applying them would change. Nothing is saved until applied. */
export interface Proposal {
  profile: "hike" | "road";
  /** 'none': no marks of this kind; 'fits': the present settings already agree; 'changes': see `changes`. */
  outcome: "none" | "fits" | "changes";
  marks: number;
  changes: Array<{ key: string; current: number | [number, number]; proposed: number | [number, number] }>;
  settings: Settings;
  before: { overFlagged: Disagreement[]; missed: Disagreement[] };
  after: { overFlagged: Disagreement[]; missed: Disagreement[] };
  library: Array<{ id: number; name: string; kind: "hike" | "route"; before: EntryState; after: EntryState }>;
}
