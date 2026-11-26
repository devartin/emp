import { createContext, useContext } from "react";

/** True inside dialogs/sheets so floating content portals above them (z 70, §3.7). */
export const OverlayLayer = createContext(false);
export const useInOverlay = () => useContext(OverlayLayer);
export const floatingZ = (inOverlay: boolean) => (inOverlay ? { zIndex: 70 } : undefined);
