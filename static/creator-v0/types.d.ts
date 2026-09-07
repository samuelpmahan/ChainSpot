export interface DiscFacts {
  manufacturer: string;
  mold: string;
  flight: [number, number, number, number]; // speed, glide, turn, fade; no classifier
}
export type DiscPhoto =
  | { kind: 'sample'; hue: number }
  | { kind: 'upload'; dataUrl: string; fileName: string; width: number; height: number }
  | null;
/** One physical object, not a catalog record. Facts are editable value snapshots. */
export interface Disc {
  id: string;
  facts: DiscFacts;
  label: string;
  plastic: string;
  weight: string;
  photo: DiscPhoto;
}
export interface BattleEntry { id: string; discId: string; score: string }
export interface DiscBattle {
  id: string;
  title: string;
  entries: BattleEntry[];
  highlightedEntryId: string | null;
  winnerEntryId: string | null;
}
export interface Presentation {
  mode: 'card' | 'battle';
  theme: 'dark' | 'light';
  anchor: 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right' | 'center';
  scale: number;
  cardLayout: 'wide' | 'portrait';
  battleLayout: 'row' | 'stack';
  showInstanceLabel: boolean;
  showFlightNumbers: boolean;
}
export interface Workspace {
  schemaVersion: 1;
  discs: Disc[];
  card: { discId: string | null };
  battle: DiscBattle;
  presentation: Presentation;
}
