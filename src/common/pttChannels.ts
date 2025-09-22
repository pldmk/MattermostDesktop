// Общие каналы IPC для PTT/горячих клавиш (Desktop ↔ Renderer)

export const PTT_GET_CONFIG = 'PTT_GET_CONFIG';
export const PTT_SET_ENABLED = 'PTT_SET_ENABLED';
export const PTT_START_CAPTURE = 'PTT_START_CAPTURE'; // args: {which: 'ptt'|'toggleMic'}

export const PTT_EVENT_PRESSED = 'PTT_EVENT_PRESSED';
export const PTT_EVENT_RELEASED = 'PTT_EVENT_RELEASED';
export const PTT_EVENT_TOGGLE_MIC = 'PTT_EVENT_TOGGLE_MIC';

// Типы для удобства импорта в main/preload
export type PTTWhich = 'ptt' | 'toggleMic';
export type PTTCapturedHotkey = {
    keycode: number;
    alt: boolean;
    ctrl: boolean;
    shift: boolean;
    meta: boolean;
    label: string;
};

export type PTTConfig = {
    enabled: boolean;
    ptt?: PTTCapturedHotkey | null;
    toggleMic?: PTTCapturedHotkey | null;
};
