// src/main/pttManager.ts
import { BrowserWindow } from 'electron';
import ViewManager from 'main/views/viewManager';

type PTTConfig = {
    enabled: boolean;
    pttAccelerator: string;         // e.g. "CommandOrControl+Shift+V"
    toggleMicAccelerator: string;   // e.g. "Alt+M"
};

const PTT_EVENT_DOWN = 'PTT_EVENT_DOWN';
const PTT_EVENT_UP = 'PTT_EVENT_UP';
const PTT_EVENT_TOGGLE = 'PTT_EVENT_TOGGLE';

let config: PTTConfig = {
    enabled: false,
    pttAccelerator: '',
    toggleMicAccelerator: '',
};

let uiohook: any | null = null;
let hookStarted = false;

// Текущее состояние PTT (зажата ли комбинация)
let pttActive = false;

type ParsedAccel = {
    keyCode: number | null;
    requireCtrl: boolean;
    requireShift: boolean;
    requireAlt: boolean;
    requireSuper: boolean;
    requireCmdOrCtrl: boolean;
};
let parsedPTT: ParsedAccel | null = null;
let parsedToggleMic: ParsedAccel | null = null;

function tryLoadUiohook() {
    if (uiohook) return;
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        uiohook = require('uiohook-napi');
    } catch {
        uiohook = null;
    }
}

function sendAll(channel: string) {
    ViewManager.sendToAllViews(channel);
}

function normKeyName(raw: string) {
    return raw.trim().toUpperCase();
}

function parseAccelerator(accel: string): ParsedAccel | null {
    if (!accel || typeof accel !== 'string') return null;
    tryLoadUiohook();
    const parts = accel.split('+').map(normKeyName).filter(Boolean);
    if (!parts.length) return null;

    let requireCtrl = false;
    let requireShift = false;
    let requireAlt = false;
    let requireSuper = false;
    let requireCmdOrCtrl = false;

    let keyPart: string | null = null;

    for (const p of parts) {
        if (p === 'CTRL' || p === 'CONTROL') requireCtrl = true;
        else if (p === 'SHIFT') requireShift = true;
        else if (p === 'ALT') requireAlt = true;
        else if (p === 'META' || p === 'SUPER' || p === 'COMMAND') requireSuper = true;
        else if (p === 'COMMANDORCONTROL' || p === 'CMDORCTRL') requireCmdOrCtrl = true;
        else keyPart = p;
    }

    let keyCode: number | null = null;

    if (keyPart) {
        // Попробуем сопоставить с enum UiohookKey
        if (uiohook?.UiohookKey && keyPart in uiohook.UiohookKey) {
            keyCode = uiohook.UiohookKey[keyPart];
        } else if (keyPart.startsWith('F') && /^\d+$/.test(keyPart.substring(1)) && uiohook?.UiohookKey) {
            // F1..F24 — на всякий случай (хотя UiohookKey уже содержит F1..F24)
            const n = keyPart as keyof typeof uiohook.UiohookKey;
            if (n in uiohook.UiohookKey) {
                keyCode = uiohook.UiohookKey[n];
            }
        } else if (uiohook?.UiohookKey) {
            // Буквы/цифры: 'A'..'Z', '0'..'9'
            if (keyPart.length === 1) {
                const k = keyPart.toUpperCase();
                if (k in uiohook.UiohookKey) {
                    keyCode = uiohook.UiohookKey[k];
                }
            }
            // Популярные спец-клавиши
            const aliases: Record<string, string> = {
                'SPACE': 'SPACE',
                'TAB': 'TAB',
                'ENTER': 'ENTER',
                'RETURN': 'ENTER',
                'ESC': 'ESCAPE',
                'ESCAPE': 'ESCAPE',
                'BACKSPACE': 'BACKSPACE',
                'DELETE': 'DELETE',
                'INS': 'INSERT',
                'INSERT': 'INSERT',
                'HOME': 'HOME',
                'END': 'END',
                'PAGEUP': 'PAGEUP',
                'PAGEDOWN': 'PAGEDOWN',
                'LEFT': 'LEFT',
                'RIGHT': 'RIGHT',
                'UP': 'UP',
                'DOWN': 'DOWN',
                'BACKQUOTE': 'BACKQUOTE',
                '`': 'BACKQUOTE',
            };
            const alias = aliases[keyPart];
            if (alias && alias in uiohook.UiohookKey) {
                keyCode = uiohook.UiohookKey[alias];
            }
        }
    }

    return {
        keyCode,
        requireCtrl,
        requireShift,
        requireAlt,
        requireSuper,
        requireCmdOrCtrl,
    };
}

function matchAccel(ev: any, parsed: ParsedAccel): boolean {
    if (!parsed) return false;
    // проверяем модификаторы
    const ctrl = !!ev.ctrlKey;
    const shift = !!ev.shiftKey;
    const alt = !!ev.altKey;
    const meta = !!ev.metaKey;

    if (parsed.requireShift && !shift) return false;
    if (parsed.requireAlt && !alt) return false;

    if (parsed.requireCmdOrCtrl) {
        if (!(ctrl || meta)) return false;
    } else {
        if (parsed.requireCtrl && !ctrl) return false;
        if (parsed.requireSuper && !meta) return false;
    }

    if (parsed.keyCode != null) {
        if (ev.keycode !== parsed.keyCode) return false;
    } else {
        // Нет основного ключа — не считаем совпадением
        return false;
    }
    return true;
}

function startHook() {
    tryLoadUiohook();
    if (!uiohook || hookStarted) return;

    uiohook.uIOhook.on('keydown', (ev: any) => {
        if (!config.enabled || !parsedPTT) return;

        // PTT down
        if (!pttActive && parsedPTT && matchAccel(ev, parsedPTT)) {
            pttActive = true;
            sendAll(PTT_EVENT_DOWN);
        }

        // Toggle mic
        if (parsedToggleMic && matchAccel(ev, parsedToggleMic)) {
            sendAll(PTT_EVENT_TOGGLE);
        }
    });

    uiohook.uIOhook.on('keyup', (ev: any) => {
        if (!config.enabled || !parsedPTT) return;
        if (!pttActive) return;

        // Отпустили основной ключ PTT — отпускаем PTT
        if (parsedPTT.keyCode != null && ev.keycode === parsedPTT.keyCode) {
            pttActive = false;
            sendAll(PTT_EVENT_UP);
        }
    });

    try {
        uiohook.uIOhook.start();
        hookStarted = true;
    } catch {
        hookStarted = false;
    }
}

function stopHook() {
    try {
        if (uiohook?.uIOhook && hookStarted) {
            uiohook.uIOhook.stop();
        }
    } catch {
        // ignore
    } finally {
        hookStarted = false;
        pttActive = false;
    }
}

function reconfigure() {
    stopHook();
    parsedPTT = parseAccelerator(config.pttAccelerator || '');
    parsedToggleMic = parseAccelerator(config.toggleMicAccelerator || '');
    if (config.enabled && (parsedPTT || parsedToggleMic)) {
        startHook();
    }
}

export function setPTTConfig(next: PTTConfig) {
    config = {
        enabled: !!next.enabled,
        pttAccelerator: next.pttAccelerator || '',
        toggleMicAccelerator: next.toggleMicAccelerator || '',
    };
    reconfigure();
}

export function getPTTConfig(): PTTConfig {
    return { ...config };
}

export function shutdownPTT() {
    stopHook();
}
