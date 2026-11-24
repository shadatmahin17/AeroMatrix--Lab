import { create } from 'zustand';
import type { AircraftModelType } from '../types/aerodynamics';
import type { CustomGlbAsset } from '../components/GlbUploader';
import type { GeometryTransformMetadata, MeshValidationReport } from '../geometry/contracts/GeometryMetadata';

interface AircraftStoreState {
  modelType: AircraftModelType;
  customGlbAsset: CustomGlbAsset | null;
  meshValidation: MeshValidationReport | null;
  geometryMetadata: GeometryTransformMetadata | null;
  customGlbFlipNose: boolean;
  customGlbYawDeg: number;
  setModelType: (modelType: AircraftModelType) => void;
  setCustomGlbAsset: (asset: CustomGlbAsset | null) => void;
  setOrientationOverrides: (flipNose: boolean, yawDeg: number) => void;
}

export const useAircraftStore = create<AircraftStoreState>((set) => ({
  modelType: 'f22',
  customGlbAsset: null,
  meshValidation: null,
  geometryMetadata: null,
  customGlbFlipNose: false,
  customGlbYawDeg: 0,
  setModelType: (modelType) => set({ modelType }),
  setCustomGlbAsset: (customGlbAsset) =>
    set({
      customGlbAsset,
      meshValidation: customGlbAsset?.meshValidation ?? null,
      geometryMetadata: customGlbAsset?.geometryMetadata ?? null,
    }),
  setOrientationOverrides: (customGlbFlipNose, customGlbYawDeg) =>
    set({ customGlbFlipNose, customGlbYawDeg }),
}));
