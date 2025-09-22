import { BrowserWindow } from 'electron';
import { PTTCapturedHotkey, PTTConfig, PTTWhich } from 'common/pttChannels';

/**
 * PTTManager — единая точка управления глобальными хоткеями PTT
 * Реализация использует iohook для глобального keydown/keyup (поддержка PTT "на удержание")
 * Если iohook недоступен (не собрался/не установился) — функционал PTT будет отключён.
 */
export default class PTTManager {
    private iohook: any | null = null;

    private enabled = false;

    private pttHotkey: PTTCapturedHotkey | null = null;
    private toggleMicHotkey: PTTCapturedHotkey | null = null;

    private isPTTPressed = false;
    private toggleMicDown = false;

    private captureResolver: ((hk: PTTCapturedHotkey) => void) | null = null;
    private captureTarget: PTTWhich | null = null;

    // Для подавления авто-повторов
    private lastToggleMicAt = 0;

    constructor(
        // отправка сообщений в renderer (все веб-вью)
        private emitToAllViews: (channel: string, ...args: unknown[]) => void,
    ) {
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            this.iohook = require('iohook');
        } catch (e) {
            this.iohook = null;
        }
    }

    public init() {
        if (!this.iohook) {
            return;
        }
        this.iohook.on('keydown', this.onKeyDown);
        this.iohook.on('keyup', this.onKeyUp);
        try {
            this.iohook.start();
        } catch {
            // игнор
        }
    }

    public destroy() {
        if (!this.iohook) {
            return;
        }
        try {
            this.iohook.removeAllListeners('keydown');
            this.iohook.removeAllListeners('keyup');
            this.iohook.stop();
        } catch {
            // ignore
        }
    }

    public setEnabled(enabled: boolean) {
        this.enabled = !!enabled;
        if (!this.enabled) {
            // сбрасываем активные состояния
            if (this.isPTTPressed) {
                this.isPTTPressed = false;
                this.emitReleased();
            }
            this.toggleMicDown = false;
        }
    }

    public getConfig(): PTTConfig {
        return {
            enabled: this.enabled,
            ptt: this.pttHotkey || null,
            toggleMic: this.toggleMicHotkey || null,
        };
    }

    public async startCapture(which: PTTWhich): Promise<PTTCapturedHotkey> {
        if (!this.iohook) {
            throw new Error('PTT not supported on this build (iohook not available)');
        }
        if (this.captureResolver) {
            throw new Error('Already capturing');
        }
        this.captureTarget = which;
        return new Promise<PTTCapturedHotkey>((resolve) => {
            this.captureResolver = resolve;
        });
    }

    private onKeyDown = (ev: any) => {
        // Формируем структуру события
        const e = this.norm(ev);

        // Режим "захвата" хоткея из Desktop — первая комбо, которую нажали
        if (this.captureResolver) {
            const hk = this.makeHotkeyFromEvent(e);
            const target = this.captureTarget;
            // Присваиваем хоткей сразу
            if (target === 'ptt') {
                this.pttHotkey = hk;
            } else if (target === 'toggleMic') {
                this.toggleMicHotkey = hk;
            }
            const res = this.captureResolver;
            this.captureResolver = null;
            this.captureTarget = null;
            res(hk);
            return;
        }

        if (!this.enabled) {
            return;
        }

        // PTT: нажатие — переходим в "говорю"
        if (this.pttHotkey && this.matches(e, this.pttHotkey) && !this.isPTTPressed) {
            this.isPTTPressed = true;
            this.emitPressed();
            return;
        }

        // ToggleMic: разовое событие по нажатию
        if (this.toggleMicHotkey && this.matches(e, this.toggleMicHotkey)) {
            const now = Date.now();
            if (!this.toggleMicDown || now - this.lastToggleMicAt > 400) { // простой анти-дабл
                this.toggleMicDown = true;
                this.lastToggleMicAt = now;
                this.emitToggleMic();
            }
        }
    };

    private onKeyUp = (ev: any) => {
        const e = this.norm(ev);

        if (!this.enabled) {
            return;
        }

        // PTT: отпускание — выключаем "говорю"
        if (this.pttHotkey && this.matches(e, this.pttHotkey)) {
            if (this.isPTTPressed) {
                this.isPTTPressed = false;
                this.emitReleased();
            }
            return;
        }

        // ToggleMic: снимаем флаг удержания
        if (this.toggleMicHotkey && this.matches(e, this.toggleMicHotkey)) {
            this.toggleMicDown = false;
        }
    };

    private emitPressed() {
        this.emitToAllViews('PTT_EVENT_PRESSED');
    }
    private emitReleased() {
        this.emitToAllViews('PTT_EVENT_RELEASED');
    }
    private emitToggleMic() {
        this.emitToAllViews('PTT_EVENT_TOGGLE_MIC');
    }

    // Сопоставление события жмана с хоткеем
    private matches(e: NK, hk: PTTCapturedHotkey) {
        return (
            !!hk &&
            e.keycode === hk.keycode &&
            e.alt === hk.alt &&
            e.ctrl === hk.ctrl &&
            e.shift === hk.shift &&
            e.meta === hk.meta
        );
    }

    // Нормализация события iohook → наш формат
    private norm(ev: any): NK {
        return {
            keycode: Number(ev?.keycode ?? 0),
            alt: !!ev?.altKey,
            ctrl: !!ev?.ctrlKey,
            shift: !!ev?.shiftKey,
            meta: !!ev?.metaKey,
            keychar: typeof ev?.keychar === 'number' ? ev.keychar : 0,
        };
    }

    private makeHotkeyFromEvent(e: NK): PTTCapturedHotkey {
        const mods: string[] = [];
        if (e.ctrl) mods.push(process.platform === 'darwin' ? 'Ctrl' : 'Ctrl');
        if (e.alt) mods.push(process.platform === 'darwin' ? 'Option' : 'Alt');
        if (e.shift) mods.push('Shift');
        if (e.meta) mods.push(process.platform === 'darwin' ? 'Cmd' : 'Win');

        let keyLabel = '';
        if (e.keychar && e.keychar >= 32 && e.keychar < 127) {
            keyLabel = String.fromCharCode(e.keychar).toUpperCase();
        } else {
            keyLabel = `Key${e.keycode}`;
        }
        const label = (mods.length ? mods.join('+') + '+' : '') + keyLabel;

        return {
            keycode: e.keycode,
            alt: e.alt,
            ctrl: e.ctrl,
            shift: e.shift,
            meta: e.meta,
            label,
        };
    }
}

type NK = {
    keycode: number;
    alt: boolean;
    ctrl: boolean;
    shift: boolean;
    meta: boolean;
    keychar: number;
};
