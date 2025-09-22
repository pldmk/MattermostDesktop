// Copyright ...
import path from 'path';
import { pathToFileURL } from 'url';

import { app, ipcMain, nativeTheme, net, protocol, session } from 'electron';
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
