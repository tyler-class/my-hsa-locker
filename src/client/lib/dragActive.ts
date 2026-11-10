import { createContext } from 'react';

/** True while a row or group in a list is being dragged (rows turn off swiping). */
export const DragActive = createContext(false);
