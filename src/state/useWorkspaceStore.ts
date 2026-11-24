import { create } from 'zustand';

export type WorkspaceLabMode = '3d' | '2d';
export type WorkspacePaneTab = 'controls' | 'tunnel' | 'results';

interface WorkspaceStoreState {
  labMode: WorkspaceLabMode;
  mobileTab: WorkspacePaneTab;
  showLeftSidebar: boolean;
  showRightSidebar: boolean;
  activeProjectId: string;
  setLabMode: (mode: WorkspaceLabMode) => void;
  setMobileTab: (tab: WorkspacePaneTab) => void;
  setSidebars: (left: boolean, right: boolean) => void;
  setActiveProjectId: (projectId: string) => void;
}

export const useWorkspaceStore = create<WorkspaceStoreState>((set) => ({
  labMode: '3d',
  mobileTab: 'tunnel',
  showLeftSidebar: true,
  showRightSidebar: true,
  activeProjectId: 'default',
  setLabMode: (labMode) => set({ labMode }),
  setMobileTab: (mobileTab) => set({ mobileTab }),
  setSidebars: (showLeftSidebar, showRightSidebar) => set({ showLeftSidebar, showRightSidebar }),
  setActiveProjectId: (activeProjectId) => set({ activeProjectId }),
}));
