export type Coord2D = number[];

export interface AirfoilSelection {
  id?: string;
  choice?: string;
  name: string;
  filename: string;
  coords: Coord2D[];
  fixes: string[] | null;
  isCustom: boolean;
  isShared?: boolean;
  uploaderName?: string;
}

export interface TunnelStats {
  cl: number | null;
  cd: number | null;
  reynolds: number;
  separationPct: number;
}

export interface TelemetrySample {
  id: number;
  airfoil: string;
  alpha: number;
  reynolds: number;
  cl: number | null;
  cd: number | null;
  ld: number | null;
  separationPct: number;
  stateLabel: string;
  fieldLabel: string;
  timestamp: string;
}

export interface TunnelController {
  setAlpha: (a: number) => void;
  setU0: (u: number) => void;
  setField: (modeIdx: number) => void;
  setCoords: (coords: Coord2D[], name?: string) => void;
  setPaused: (paused: boolean) => void;
  resetFlow: () => void;
  savePng: () => void;
  getCoords: () => Coord2D[];
  destroy: () => void;
}
