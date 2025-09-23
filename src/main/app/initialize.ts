// Copyright ...
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

import { app, ipcMain, nativeTheme, net, protocol, session, BrowserWindow } from 'electron';
import installExtension, { REACT_DEVELOPER_TOOLS, REDUX_DEVTOOLS } from 'electron-devtools-installer';
import isDev from 'electron-is-dev';
import { installScreenShareHandler } from '../screenShare';

import {
    FOCUS_BROWSERVIEW,
    QUIT,
    NOTIFY_MENTION,
    UPDATE_SHORTCUT_MENU,
    GET_AVAILABLE_SPELL_CHECKER_LANGUAGES,
    USER_ACTIVITY_UPDATE,
    START_UPGRADE,
    START_UPDATE_DOWNLOAD,
    PING_DOMAIN,
    OPEN_APP_MENU,
    GET_CONFIGURATION,
    GET_LOCAL_CONFIGURATION,
    UPDATE_CONFIGURATION,
    UPDATE_PATHS,
    SERVERS_MODIFIED,
    GET_DARK_MODE,
    DOUBLE_CLICK_ON_WINDOW,
    TOGGLE_SECURE_INPUT,
    GET_APP_INFO,
    SHOW_SETTINGS_WINDOW,
    DEVELOPER_MODE_UPDATED,
} from 'common/communication';
import Config from 'common/config';
import { SECURE_STORAGE_KEYS } from 'common/constants/secureStorage';
import { Logger } from 'common/log';
import ServerManager from 'common/servers/serverManager';
import { parseURL } from 'common/utils/url';
import AllowProtocolDialog from 'main/allowProtocolDialog';
import AppVersionManager from 'main/AppVersionManager';
import AuthManager from 'main/authManager';
import AutoLauncher from 'main/AutoLauncher';
import updateManager from 'main/autoUpdater';
import { setupBadge } from 'main/badge';
import CertificateManager from 'main/certificateManager';
import { configPath, updatePaths } from 'main/constants';
import CriticalErrorHandler from 'main/CriticalErrorHandler';
import DeveloperMode from 'main/developerMode';
import downloadsManager from 'main/downloadsManager';
import i18nManager from 'main/i18nManager';
import NonceManager from 'main/nonceManager';
import { getDoNotDisturb } from 'main/notifications';
import parseArgs from 'main/ParseArgs';
import PerformanceMonitor from 'main/performanceMonitor';
import PermissionsManager from 'main/permissionsManager';
import secureStorage from 'main/secureStorage';
import Tray from 'main/tray/tray';
import TrustedOriginsStore from 'main/trustedOrigins';
import UserActivityMonitor from 'main/UserActivityMonitor';
import ViewManager from 'main/views/viewManager';
import MainWindow from 'main/windows/mainWindow';

import {
    handleAppBeforeQuit,
    handleAppBrowserWindowCreated,
    handleAppCertificateError,
    handleAppSecondInstance,
    handleAppWillFinishLaunching,
    handleAppWindowAllClosed,
    handleChildProcessGone,
} from './app';
import {
    handleConfigUpdate,
    handleDarkModeChange,
    handleGetConfiguration,
    handleGetLocalConfiguration,
    handleUpdateTheme,
    updateConfiguration,
} from './config';
import {
    handleMainWindowIsShown,
    handleAppVersion,
    handleMentionNotification,
    handleOpenAppMenu,
    handleQuit,
    handlePingDomain,
    handleToggleSecureInput,
    handleShowSettingsModal,
} from './intercom';
import {
    clearAppCache,
    getDeeplinkingURL,
    handleUpdateMenuEvent,
    shouldShowTrayIcon,
    updateSpellCheckerLocales,
    wasUpdated,
    migrateMacAppStore,
    updateServerInfos,
    flushCookiesStore,
} from './utils';
import {
    handleDoubleClick,
    handleGetDarkMode,
} from './windows';

import { protocols } from '../../../electron-builder.json';

// ===== PTT (встроено здесь, без новых файлов)
import {
    uIOhook,
    UiohookKey,
    UiohookKeyboardEvent,
    UiohookMouseEvent,
} from 'uiohook-napi';

// IPC имена (дублируются также в preload)
const PTT_GET_CONFIG = 'PTT_GET_CONFIG';
const PTT_SET_ENABLED = 'PTT_SET_ENABLED';
const PTT_START_CAPTURE = 'PTT_START_CAPTURE';
const PTT_EVENT_PRESSED = 'PTT_EVENT_PRESSED';
const PTT_EVENT_RELEASED = 'PTT_EVENT_RELEASED';
const PTT_EVENT_TOGGLE_MIC = 'PTT_EVENT_TOGGLE_MIC';

type PTTInputType = 'key' | 'mouse';
type PTTHotkey = {
    type: PTTInputType;
    // key
    keycode?: number;
    // mouse
    mouseButton?: number; // 1=Left, 2=Right, 3=Middle, 4/5=Side buttons
    // modifiers
    ctrl: boolean;
    alt: boolean;
    shift: boolean;
    meta: boolean;
    // UI label
    label: string;
};
type PTTConfig = { enabled: boolean; ptt?: PTTHotkey | null; toggleMic?: PTTHotkey | null };

// Модификаторы — именно как в твоей версии (generic + right-variants)
const isMod = (kc: number) =>
    kc === UiohookKey.Shift || kc === UiohookKey.ShiftRight ||
    kc === UiohookKey.Ctrl || kc === UiohookKey.CtrlRight ||
    kc === UiohookKey.Alt || kc === UiohookKey.AltRight ||
    kc === UiohookKey.Meta || kc === UiohookKey.MetaRight;

// ==== Надёжная обратная мапа HID-кодов в читаемые названия
const KEY_NAME_MAP: Record<number, string> = buildKeyNameMap();

function buildKeyNameMap(): Record<number, string> {
    const map: Record<number, string> = {};
    const K: any = UiohookKey as any;

    // Буквы A..Z
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').forEach((ch) => {
        const val = K[ch];
        if (typeof val === 'number') map[val] = ch;
    });

    // Цифры верхнего ряда 1..9, 0 — у разных версий бывают _1.._0 или DIGIT1..DIGIT0
    const digitAliases = [
        ['_1', '1'], ['_2', '2'], ['_3', '3'], ['_4', '4'], ['_5', '5'],
        ['_6', '6'], ['_7', '7'], ['_8', '8'], ['_9', '9'], ['_0', '0'],
        ['DIGIT1', '1'], ['DIGIT2', '2'], ['DIGIT3', '3'], ['DIGIT4', '4'], ['DIGIT5', '5'],
        ['DIGIT6', '6'], ['DIGIT7', '7'], ['DIGIT8', '8'], ['DIGIT9', '9'], ['DIGIT0', '0'],
        ['ONE', '1'], ['TWO', '2'], ['THREE', '3'], ['FOUR', '4'], ['FIVE', '5'],
        ['SIX', '6'], ['SEVEN', '7'], ['EIGHT', '8'], ['NINE', '9'], ['ZERO', '0'],
    ] as const;
    for (const [prop, label] of digitAliases) {
        if (typeof K[prop] === 'number') map[K[prop]] = label;
    }

    // Numpad 0..9
    const numpad = [
        ['NUMPAD0', 'Num0'], ['NUMPAD1', 'Num1'], ['NUMPAD2', 'Num2'], ['NUMPAD3', 'Num3'], ['NUMPAD4', 'Num4'],
        ['NUMPAD5', 'Num5'], ['NUMPAD6', 'Num6'], ['NUMPAD7', 'Num7'], ['NUMPAD8', 'Num8'], ['NUMPAD9', 'Num9'],
    ] as const;
    for (const [prop, label] of numpad) {
        if (typeof K[prop] === 'number') map[K[prop]] = label;
    }

    // F1..F24
    for (let i = 1; i <= 24; i++) {
        const prop = `F${i}`;
        if (typeof K[prop] === 'number') map[K[prop]] = prop;
    }

    // Частые спецклавиши (названия могут отличаться между версиями — добавлены альтернативы)
    const specials: Array<[string, string]> = [
        ['Space', 'Space'], ['SPACE', 'Space'],
        ['Enter', 'Enter'], ['RETURN', 'Enter'],
        ['Escape', 'Esc'], ['ESCAPE', 'Esc'], ['ESC', 'Esc'],
        ['Backspace', 'Backspace'], ['BACKSPACE', 'Backspace'],
        ['Tab', 'Tab'], ['TAB', 'Tab'],
        ['Insert', 'Insert'], ['INSERT', 'Insert'],
        ['Delete', 'Delete'], ['DELETE', 'Delete'],
        ['Home', 'Home'], ['HOME', 'Home'],
        ['End', 'End'], ['END', 'End'],
        ['PageUp', 'PageUp'], ['PAGE_UP', 'PageUp'],
        ['PageDown', 'PageDown'], ['PAGE_DOWN', 'PageDown'],
        ['ArrowLeft', 'ArrowLeft'], ['LEFT', 'ArrowLeft'],
        ['ArrowRight', 'ArrowRight'], ['RIGHT', 'ArrowRight'],
        ['ArrowUp', 'ArrowUp'], ['UP', 'ArrowUp'],
        ['ArrowDown', 'ArrowDown'], ['DOWN', 'ArrowDown'],
        ['Minus', '-'], ['EQUALS', '='],
        ['BracketLeft', '['], ['BracketRight', ']'],
        ['Backslash', '\\'], ['Semicolon', ';'], ['Quote', '\''],
        ['Comma', ','], ['Period', '.'], ['Slash', '/'],
    ];
    for (const [prop, label] of specials) {
        if (typeof K[prop] === 'number') map[K[prop]] = label;
    }

    return map;
}

function keyLabel(kc: number): string {
    return KEY_NAME_MAP[kc] ?? `KeyCode ${kc}`;
}

function mouseButtonLabel(btn?: number): string {
    switch (btn) {
        case 1: return 'Mouse1 (Left)';
        case 2: return 'Mouse2 (Right)';
        case 3: return 'Mouse3 (Middle)';
        case 4: return 'Mouse4';
        case 5: return 'Mouse5';
        default: return typeof btn === 'number' ? `Mouse${btn}` : 'Mouse';
    }
}

function formatHotkeyLabel(hk: Omit<PTTHotkey, 'label'>): string {
    const parts: string[] = [];
    if (hk.ctrl) parts.push('Ctrl');
    if (hk.alt) parts.push('Alt');
    if (hk.shift) parts.push('Shift');
    if (hk.meta) parts.push(process.platform === 'darwin' ? 'Cmd' : 'Meta');
    if (hk.type === 'mouse') {
        parts.push(mouseButtonLabel(hk.mouseButton));
    } else {
        parts.push(keyLabel(hk.keycode!));
    }
    return parts.join('+');
}

function matchesKeyboardHotkey(e: UiohookKeyboardEvent, hk?: PTTHotkey | null): boolean {
    if (!hk || hk.type !== 'key') return false;
    return !!e.ctrlKey === !!hk.ctrl &&
        !!e.altKey === !!hk.alt &&
        !!e.shiftKey === !!hk.shift &&
        !!e.metaKey === !!hk.meta &&
        e.keycode === hk.keycode;
}

function matchesMouseHotkey(e: UiohookMouseEvent, hk?: PTTHotkey | null): boolean {
    if (!hk || hk.type !== 'mouse') return false;
    // В uiohook-napi в mouse-событиях также приходят флаги модификаторов
    return !!(e as any).ctrlKey === !!hk.ctrl &&
        !!(e as any).altKey === !!hk.alt &&
        !!(e as any).shiftKey === !!hk.shift &&
        !!(e as any).metaKey === !!hk.meta &&
        e.button === hk.mouseButton;
}

const broadcastPTT = (channel: string, ...args: any[]) => {
    try { ViewManager.sendToAllViews(channel, ...args); } catch { /* noop */ }
    try {
        BrowserWindow.getAllWindows().forEach((bw) => {
            try { bw.webContents.send(channel, ...args); } catch { /* noop */ }
        });
    } catch { /* noop */ }
};

let pttConfig: PTTConfig = { enabled: false, ptt: null, toggleMic: null };
let pttAttached = false;

// Чтобы корректно закрывать PTT при отпускании именно той кнопки,
// запоминаем какой «источник» активировал зажатие
let pttActive = false;
let pttActiveSource: null | { type: PTTInputType; code: number } = null;

let toggleTs = 0;

let capturing: null | ('ptt' | 'toggleMic') = null;
let captureResolve: ((hk: PTTHotkey) => void) | null = null;
let captureReject: ((err: any) => void) | null = null;

const pttConfigPath = () => path.join(app.getPath('userData'), 'ptt.json');

async function loadPTTConfig() {
    try {
        const raw = await fs.promises.readFile(pttConfigPath(), 'utf8');
        const data = JSON.parse(raw);

        // Нормализация старого формата (без type)
        const normalize = (v: any): PTTHotkey | null => {
            if (!v) return null;
            if (v.type === 'mouse') {
                return {
                    type: 'mouse',
                    mouseButton: Number(v.mouseButton ?? v.button ?? v.keycode ?? 3),
                    ctrl: !!v.ctrl, alt: !!v.alt, shift: !!v.shift, meta: !!v.meta,
                    label: v.label || formatHotkeyLabel({
                        type: 'mouse',
                        mouseButton: Number(v.mouseButton ?? v.button ?? 3),
                        ctrl: !!v.ctrl, alt: !!v.alt, shift: !!v.shift, meta: !!v.meta,
                    }),
                };
            }
            // по умолчанию — клавиатура
            return {
                type: 'key',
                keycode: Number(v.keycode ?? v.code ?? 0),
                ctrl: !!v.ctrl, alt: !!v.alt, shift: !!v.shift, meta: !!v.meta,
                label: v.label || formatHotkeyLabel({
                    type: 'key',
                    keycode: Number(v.keycode ?? v.code ?? 0),
                    ctrl: !!v.ctrl, alt: !!v.alt, shift: !!v.shift, meta: !!v.meta,
                }),
            };
        };

        pttConfig = {
            enabled: !!data.enabled,
            ptt: normalize(data.ptt),
            toggleMic: normalize(data.toggleMic),
        };
    } catch {
        pttConfig = { enabled: false, ptt: null, toggleMic: null };
    }
}
async function savePTTConfig() {
    try { await fs.promises.writeFile(pttConfigPath(), JSON.stringify(pttConfig, null, 2), 'utf8'); } catch { /* noop */ }
}

function finishCaptureFromKeyEvent(e: UiohookKeyboardEvent) {
    if (!capturing) return;
    const hkBase: Omit<PTTHotkey, 'label'> = {
        type: 'key',
        keycode: e.keycode,
        ctrl: !!e.ctrlKey, alt: !!e.altKey, shift: !!e.shiftKey, meta: !!e.metaKey,
    };
    const hk: PTTHotkey = { ...hkBase, label: formatHotkeyLabel(hkBase) };
    (pttConfig as any)[capturing] = hk;
    savePTTConfig().catch(() => { });
    const res = captureResolve; captureResolve = null; captureReject = null; capturing = null;
    res?.(hk);
}
function finishCaptureFromMouseEvent(e: UiohookMouseEvent) {
    if (!capturing) return;
    const hkBase: Omit<PTTHotkey, 'label'> = {
        type: 'mouse',
        mouseButton: e.button,
        ctrl: !!(e as any).ctrlKey, alt: !!(e as any).altKey, shift: !!(e as any).shiftKey, meta: !!(e as any).metaKey,
    };
    const hk: PTTHotkey = { ...hkBase, label: formatHotkeyLabel(hkBase) };
    (pttConfig as any)[capturing] = hk;
    savePTTConfig().catch(() => { });
    const res = captureResolve; captureResolve = null; captureReject = null; capturing = null;
    res?.(hk);
}

function attachPTTHook() {
    if (pttAttached) return;
    pttAttached = true;

    // === KEYBOARD
    uIOhook.on('keydown', (e: UiohookKeyboardEvent) => {
        if (capturing) {
            if (!isMod(e.keycode)) finishCaptureFromKeyEvent(e);
            return;
        }

        // Toggle Mic — клавиатурой
        if (!isMod(e.keycode) && matchesKeyboardHotkey(e, pttConfig.toggleMic)) {
            const now = Date.now();
            if (now - toggleTs > 250) { toggleTs = now; broadcastPTT(PTT_EVENT_TOGGLE_MIC); }
        }

        // PTT — клавиатурой
        if (pttConfig.enabled && matchesKeyboardHotkey(e, pttConfig.ptt)) {
            if (!pttActive) {
                pttActive = true;
                pttActiveSource = { type: 'key', code: e.keycode };
                broadcastPTT(PTT_EVENT_PRESSED);
            }
        }
    });

    uIOhook.on('keyup', (e: UiohookKeyboardEvent) => {
        if (capturing) return;

        // PTT release — клавиатура
        if (pttConfig.enabled && pttActive && pttConfig.ptt?.type === 'key') {
            const relPart =
                e.keycode === pttConfig.ptt.keycode ||
                (pttConfig.ptt.shift && (e.keycode === UiohookKey.Shift || e.keycode === UiohookKey.ShiftRight)) ||
                (pttConfig.ptt.ctrl && (e.keycode === UiohookKey.Ctrl || e.keycode === UiohookKey.CtrlRight)) ||
                (pttConfig.ptt.alt && (e.keycode === UiohookKey.Alt || e.keycode === UiohookKey.AltRight)) ||
                (pttConfig.ptt.meta && (e.keycode === UiohookKey.Meta || e.keycode === UiohookKey.MetaRight));

            if (relPart && pttActiveSource?.type === 'key') {
                pttActive = false;
                pttActiveSource = null;
                broadcastPTT(PTT_EVENT_RELEASED);
            }
        }
    });

    // === MOUSE
    uIOhook.on('mousedown', (e: UiohookMouseEvent) => {
        if (capturing) {
            finishCaptureFromMouseEvent(e);
            return;
        }

        // Toggle Mic — мышью (щелчок по кнопке)
        if (matchesMouseHotkey(e, pttConfig.toggleMic)) {
            const now = Date.now();
            if (now - toggleTs > 250) { toggleTs = now; broadcastPTT(PTT_EVENT_TOGGLE_MIC); }
        }

        // PTT — мышью (зажатие кнопки)
        if (pttConfig.enabled && matchesMouseHotkey(e, pttConfig.ptt)) {
            if (!pttActive) {
                pttActive = true;
                pttActiveSource = { type: 'mouse', code: e.button };
                broadcastPTT(PTT_EVENT_PRESSED);
            }
        }
    });

    uIOhook.on('mouseup', (e: UiohookMouseEvent) => {
        if (capturing) return;

        if (pttConfig.enabled && pttActive && pttConfig.ptt?.type === 'mouse') {
            if (e.button === pttConfig.ptt.mouseButton && pttActiveSource?.type === 'mouse') {
                pttActive = false;
                pttActiveSource = null;
                broadcastPTT(PTT_EVENT_RELEASED);
            }
        }
    });

    try { uIOhook.start(); } catch { /* already started */ }
}
function detachPTTHook() {
    if (!pttAttached) return;
    pttAttached = false;
    try { uIOhook.removeAllListeners('keydown'); } catch { }
    try { uIOhook.removeAllListeners('keyup'); } catch { }
    try { uIOhook.removeAllListeners('mousedown'); } catch { }
    try { uIOhook.removeAllListeners('mouseup'); } catch { }
    try { uIOhook.stop(); } catch { }
}

// ===== конец блока PTT

export const mainProtocol = protocols?.[0]?.schemes?.[0];

const log = new Logger('App.Initialize');

/**
 * Main entry point for the application, ensures that everything initializes in the proper order
 */
export async function initialize() {
    CriticalErrorHandler.init();
    global.willAppQuit = false;

    // initialization that can run before the app is ready
    initializeArgs();
    await initializeConfig();
    initializeAppEventListeners();
    initializeBeforeAppReady();

    // wait for registry config data to load and app ready event
    await Promise.all([
        app.whenReady(),
        Config.initRegistry(),
    ]);

    if (global.willAppQuit) {
        return;
    }

    // eslint-disable-next-line no-undef
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    if (__IS_MAC_APP_STORE__) {
        migrateMacAppStore();
    }

    initializeInterCommunicationEventListeners();
    await initializeAfterAppReady();
}

function initializeArgs() {
    global.args = parseArgs(process.argv.slice(1));

    global.isDev = isDev && !global.args.disableDevMode;

    if (global.args.dataDir) {
        app.setPath('userData', path.resolve(global.args.dataDir));
        updatePaths(true);
    }
}

async function initializeConfig() {
    return new Promise<void>((resolve) => {
        Config.once('update', (configData) => {
            Config.on('update', handleConfigUpdate);
            Config.on('darkModeChange', handleDarkModeChange);
            Config.on('error', (error) => {
                log.error(error);
            });
            handleConfigUpdate(configData);

            // eslint-disable-next-line no-undef
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore
            if (Config.enableHardwareAcceleration === false || __DISABLE_GPU__) {
                app.disableHardwareAcceleration();
            }

            resolve();
        });
        Config.init(configPath, app.name, app.getAppPath());
        ipcMain.on(UPDATE_PATHS, () => {
            log.debug('Config.UPDATE_PATHS');

            Config.setConfigPath(configPath);
            if (Config.data) {
                Config.reload();
            }
        });
    });
}

function initializeAppEventListeners() {
    app.on('second-instance', handleAppSecondInstance);
    app.on('window-all-closed', handleAppWindowAllClosed);
    app.on('browser-window-created', handleAppBrowserWindowCreated);
    app.on('activate', () => MainWindow.show());
    app.on('before-quit', handleAppBeforeQuit);
    app.on('certificate-error', handleAppCertificateError);
    app.on('select-client-certificate', CertificateManager.handleSelectCertificate);
    app.on('child-process-gone', handleChildProcessGone);
    app.on('login', AuthManager.handleAppLogin);
    app.on('will-finish-launching', handleAppWillFinishLaunching);

    // Сохраняем куки при выходе
    app.on('before-quit', flushCookiesStore);

    // PTT: аккуратно снять hook
    app.on('before-quit', () => { try { detachPTTHook(); } catch { /* noop */ } });
}

function initializeBeforeAppReady() {
    if (!Config.data) {
        log.error('No config loaded');
        return;
    }
    if (process.env.NODE_ENV !== 'test') {
        app.enableSandbox();
    }
    TrustedOriginsStore.load();

    const expectedPath = path.dirname(process.execPath);
    if (process.cwd() !== expectedPath && !isDev) {
        log.warn(`Current working directory is ${process.cwd()}, changing into ${expectedPath}`);
        process.chdir(expectedPath);
    }

    Tray.refreshImages(Config.trayIconTheme);

    // eslint-disable-next-line no-undef
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    if (!__IS_MAC_APP_STORE__) {
        const gotTheLock = app.requestSingleInstanceLock();
        if (!gotTheLock) {
            app.exit();
            global.willAppQuit = true;
        }
    }

    AllowProtocolDialog.init();

    if (isDev && process.env.NODE_ENV !== 'test') {
        app.setAsDefaultProtocolClient('mattermost-dev', process.execPath, [path.resolve(process.cwd(), 'dist/')]);
    } else if (mainProtocol) {
        app.setAsDefaultProtocolClient(mainProtocol);
    }

    if (process.platform === 'darwin' || process.platform === 'win32') {
        nativeTheme.on('updated', handleUpdateTheme);
    }

    protocol.registerSchemesAsPrivileged([
        { scheme: 'mattermost-desktop', privileges: { standard: true } },
    ]);
}

function initializeInterCommunicationEventListeners() {
    ipcMain.handle(NOTIFY_MENTION, handleMentionNotification);
    ipcMain.handle(GET_APP_INFO, handleAppVersion);
    ipcMain.on(UPDATE_SHORTCUT_MENU, handleUpdateMenuEvent);
    ipcMain.on(FOCUS_BROWSERVIEW, ViewManager.focusCurrentView);

    if (process.platform !== 'darwin') {
        ipcMain.on(OPEN_APP_MENU, handleOpenAppMenu);
    }

    ipcMain.on(QUIT, handleQuit);

    ipcMain.handle(GET_AVAILABLE_SPELL_CHECKER_LANGUAGES, () => session.defaultSession.availableSpellCheckerLanguages);
    ipcMain.on(START_UPDATE_DOWNLOAD, handleStartDownload);
    ipcMain.on(START_UPGRADE, handleStartUpgrade);
    ipcMain.handle(PING_DOMAIN, handlePingDomain);
    ipcMain.handle(GET_CONFIGURATION, handleGetConfiguration);
    ipcMain.handle(GET_LOCAL_CONFIGURATION, handleGetLocalConfiguration);
    ipcMain.on(UPDATE_CONFIGURATION, updateConfiguration);

    ipcMain.handle(GET_DARK_MODE, handleGetDarkMode);
    ipcMain.on(DOUBLE_CLICK_ON_WINDOW, handleDoubleClick);

    ipcMain.on(TOGGLE_SECURE_INPUT, handleToggleSecureInput);

    if (process.env.NODE_ENV === 'test') {
        ipcMain.on(SHOW_SETTINGS_WINDOW, handleShowSettingsModal);
    }

    // === PTT: конфиг + IPC
    (async () => {
        try { await loadPTTConfig(); } catch { /* noop */ }
        ipcMain.handle(PTT_GET_CONFIG, async () => pttConfig);
        ipcMain.handle(PTT_SET_ENABLED, async (_evt, on: boolean) => {
            pttConfig.enabled = !!on; await savePTTConfig(); return pttConfig;
        });
        ipcMain.handle(PTT_START_CAPTURE, async (_evt, which: 'ptt' | 'toggleMic') => {
            if (which !== 'ptt' && which !== 'toggleMic') throw new Error('bad capture target');
            if (capturing) throw new Error('capture in progress');
            capturing = which;
            return new Promise<PTTHotkey>((resolve, reject) => {
                captureResolve = resolve; captureReject = reject;
                setTimeout(() => {
                    if (capturing) {
                        capturing = null;
                        const rej = captureReject; captureResolve = null; captureReject = null;
                        rej?.(new Error('Capture timeout'));
                    }
                }, 20000);
            });
        });
    })();
}

async function initializeAfterAppReady() {

    protocol.handle('mattermost-desktop', (request: Request) => {
        const url = parseURL(request.url);
        if (!url) {
            return new Response('bad', { status: 400 });
        }

        const pathToServe = path.join(app.getAppPath(), 'renderer', url.pathname);
        const relativePath = path.relative(app.getAppPath(), pathToServe);
        const isSafe = relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
        if (!isSafe) {
            return new Response('bad', { status: 400 });
        }

        return net.fetch(pathToFileURL(pathToServe).toString());
    });

    ServerManager.reloadFromConfig();

    try {
        await secureStorage.init();
        const servers = ServerManager.getAllServers();
        await Promise.allSettled(
            servers.map(async (server) => {
                try {
                    const secret = await secureStorage.getSecret(server.url.toString(), SECURE_STORAGE_KEYS.PREAUTH);
                    if (secret) {
                        server.preAuthSecret = secret;
                        log.debug('Loaded pre-auth secret for server:', { serverId: server.id });
                    }
                } catch (error) {
                    log.warn('Failed to load pre-auth secret for server:', { serverId: server.id, error });
                }
            }),
        );
    } catch (error) {
        log.warn('Failed to initialize secure storage cache:', error);
    }

    ServerManager.on(SERVERS_MODIFIED, (serverIds?: string[]) => {
        if (serverIds && serverIds.length) {
            updateServerInfos(serverIds.map((srvId) => ServerManager.getServer(srvId)!));
        }
    });

    app.setAppUserModelId('Mattermost.Desktop');
    const defaultSession = session.defaultSession;
    defaultSession.webRequest.onHeadersReceived((details, callback) => {
        const url = parseURL(details.url);
        if (url?.protocol === 'mattermost-desktop:' && url?.pathname.endsWith('html')) {
            callback({
                responseHeaders: {
                    ...details.responseHeaders,
                    'Content-Security-Policy': [`default-src 'self'; style-src 'self' 'nonce-${NonceManager.create(details.url)}'; media-src data:; img-src 'self' data:`],
                },
            });
            return;
        }

        downloadsManager.webRequestOnHeadersReceivedHandler(details, callback);
    });

    defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
        try {
            const view = ServerManager.lookupViewByURL(details.url);

            if (view && view.server.preAuthSecret) {
                const secret = view.server.preAuthSecret;

                if (!('X-Mattermost-Preauth-Secret' in details.requestHeaders)) {
                    const requestHeaders = {
                        ...details.requestHeaders,
                        'X-Mattermost-Preauth-Secret': secret,
                    };

                    callback({ requestHeaders });
                    return;
                }
            }
        } catch (error) {
            log.debug('Error injecting preauth secret header:', error);
        }

        callback({ requestHeaders: details.requestHeaders });
    });

    if (process.platform !== 'darwin') {
        defaultSession.on('spellcheck-dictionary-download-failure', (event, lang) => {
            if (Config.spellCheckerURL) {
                log.error(`There was an error while trying to load the dictionary definitions for ${lang} from fully the specified url. Please review you have access to the needed files. Url used was ${Config.spellCheckerURL}`);
            } else {
                log.warn(`There was an error while trying to download the dictionary definitions for ${lang}, spellchecking might not work properly.`);
            }
        });

        if (Config.spellCheckerURL) {
            const spellCheckerURL = Config.spellCheckerURL.endsWith('/') ? Config.spellCheckerURL : `${Config.spellCheckerURL}/`;
            log.info(`Configuring spellchecker using download URL: ${spellCheckerURL}`);
            defaultSession.setSpellCheckerDictionaryDownloadURL(spellCheckerURL);

            defaultSession.on('spellcheck-dictionary-download-success', (event, lang) => {
                log.info(`Dictionary definitions downloaded successfully for ${lang}`);
            });
        }
        updateSpellCheckerLocales();
    }

    if (typeof Config.canUpgrade === 'undefined') {
        Config.once('update', () => {
            log.debug('checkForUpdates');
            if (Config.canUpgrade && Config.autoCheckForUpdates) {
                setTimeout(() => {
                    updateManager.checkForUpdates(false);
                }, 5000);
            } else {
                log.info(`Autoupgrade disabled: ${Config.canUpgrade}`);
            }
        });
    } else if (Config.canUpgrade && Config.autoCheckForUpdates) {
        setTimeout(() => {
            updateManager.checkForUpdates(false);
        }, 5000);
    } else {
        log.info(`Autoupgrade disabled: ${Config.canUpgrade}`);
    }

    if (!global.isDev) {
        AutoLauncher.upgradeAutoLaunch();
    }

    // eslint-disable-next-line no-undef
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    if (global.isDev || __IS_NIGHTLY_BUILD__) {
        installExtension([REACT_DEVELOPER_TOOLS, REDUX_DEVTOOLS], {
            loadExtensionOptions: {
                allowFileAccess: true,
            },
        }).
            then(([react, redux]) => log.info(`Added Extension:  ${react.name}, ${redux.name}`)).
            catch((err) => log.error('An error occurred: ', err));
    }

    handleUpdateTheme();
    MainWindow.show();

    let deeplinkingURL;

    if (process.platform !== 'darwin') {
        const args = process.argv.slice(1);
        if (Array.isArray(args) && args.length > 0) {
            deeplinkingURL = getDeeplinkingURL(args);
            if (deeplinkingURL) {
                ViewManager.handleDeepLink(deeplinkingURL);
            }
        }
    }

    getDoNotDisturb();

    DeveloperMode.switchOff('disableUserActivityMonitor', () => {
        UserActivityMonitor.on('status', onUserActivityStatus);
        UserActivityMonitor.startMonitoring();
    }, () => {
        UserActivityMonitor.off('status', onUserActivityStatus);
        UserActivityMonitor.stopMonitoring();
    });

    if (shouldShowTrayIcon()) {
        Tray.init(Config.trayIconTheme);
    }
    setupBadge();

    defaultSession.on('will-download', downloadsManager.handleNewDownload);

    if (Config.appLanguage) {
        i18nManager.setLocale(Config.appLanguage);
    } else if (!i18nManager.setLocale(app.getLocale())) {
        i18nManager.setLocale(app.getLocaleCountryCode());
    }

    handleUpdateMenuEvent();
    DeveloperMode.on(DEVELOPER_MODE_UPDATED, handleUpdateMenuEvent);

    ipcMain.emit('update-dict');

    defaultSession.setPermissionRequestHandler(PermissionsManager.handlePermissionRequest);

    const prev = PermissionsManager.handlePermissionRequest;
    defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
        if (permission === 'display-capture') {
            callback(true);
            return;
        }
        prev(webContents, permission, callback, details);
    });

    installScreenShareHandler();

    if (wasUpdated(AppVersionManager.lastAppVersion)) {
        clearAppCache();
    }
    AppVersionManager.lastAppVersion = app.getVersion();

    handleMainWindowIsShown();

    PerformanceMonitor.init();

    // === PTT: активируем глобальный hook
    try { attachPTTHook(); } catch { /* noop */ }
}

function onUserActivityStatus(status: {
    userIsActive: boolean;
    idleTime: number;
    isSystemEvent: boolean;
}) {
    const log = new Logger('UserActivity');
    log.debug('UserActivityMonitor.on(status)', status);
    ViewManager.sendToAllViews(USER_ACTIVITY_UPDATE, status.userIsActive, status.idleTime, status.isSystemEvent);
}

function handleStartDownload() {
    if (updateManager) {
        updateManager.handleDownload();
    }
}

function handleStartUpgrade() {
    if (updateManager) {
        updateManager.handleUpdate();
    }
}
