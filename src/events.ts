export interface ChatEvents extends WindowEventMap {
    'chat:settings-changed': CustomEvent;
}

declare global {
    interface WindowEventMap {
        'chat:settings-changed': CustomEvent;
    }
} 