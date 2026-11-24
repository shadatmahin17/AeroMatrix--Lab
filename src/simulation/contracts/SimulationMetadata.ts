import { CoordinateSystemSpec, FlowConditions } from './ScientificContracts';

export type ValidationStatus = 'verified' | 'unverified' | 'failed';

export interface ValidationIssue {
  code: string;
  severity: 'error' | 'warning';
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

export interface SimulationContext {
  runId: string;
  signal?: AbortSignal;
  onProgress?: (progress: number, stage?: string) => void;
}

export interface SimulationEngine<I, O> {
  readonly id: string;
  readonly version: string;
  validate(input: I): ValidationResult;
  run(input: I, context: SimulationContext): Promise<O>;
  cancel(runId: string): void;
}

export interface SimulationMetadata {
  id: string;
  projectId?: string;
  softwareVersion: string;
  engine: string;
  engineVersion: string;
  geometryHash: string;
  inputHash: string;
  createdAt: string;
  solverSettings: Record<string, unknown>;
  coordinateSystem: CoordinateSystemSpec;
  environmentalConditions: Partial<FlowConditions>;
  numericalPrecision: 'float64' | 'float32' | 'hybrid-f32-f64';
  meshResolution?: {
    x: number;
    y: number;
    z?: number;
  };
  convergence?: {
    converged: boolean;
    iterations: number;
    residual: number;
  };
  assumptions: string[];
  warnings: string[];
  validationStatus: ValidationStatus;
}

export interface SimulationRecord<O = unknown> {
  metadata: SimulationMetadata;
  summary: {
    modelName: string;
    cl?: number | null;
    cd?: number | null;
    ldRatio?: number | null;
    mach?: number;
    reynolds?: number;
  };
  result: O;
}

/**
 * Deterministic 64-bit FNV-1a hexadecimal digest (isomorphic in Browser & Node/Vitest without crypto.subtle async overhead).
 */
export function computeDeterministicHash(payload: unknown): string {
  const serialized = canonicalStringify(payload);
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5;
  for (let i = 0; i < serialized.length; i++) {
    const ch = serialized.charCodeAt(i);
    h1 ^= ch;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= (ch ^ (i & 0xff));
    h2 = Math.imul(h2, 0x01000193);
  }
  const part1 = (h1 >>> 0).toString(16).padStart(8, '0');
  const part2 = (h2 >>> 0).toString(16).padStart(8, '0');
  return `${part1}${part2}`;
}

function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (ArrayBuffer.isView(value)) {
    const view = new Uint8Array(value.buffer, value.byteOffset, Math.min(256, value.byteLength));
    let acc = `TypedArray(${value.byteLength}):`;
    for (let i = 0; i < view.length; i++) acc += view[i].toString(16);
    return acc;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalStringify(item)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`).join(',')}}`;
}
