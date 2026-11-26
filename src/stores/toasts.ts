/**
 * Toasts (§5.7). Rendering and the queue live in the UI kit (`ui/Toast` → `<Toaster/>`); this module is the app-level
 * facade with the conventions the stores share: error → message mapping, "… · Undo" toasts (6 s), clipboard countdown.
 */
import { errorMessage, hasCode, isApiError } from '@/backend';
import { toast, type ToastOptions } from '@/ui/Toast';

export type { ToastOptions };

export const notify = {
  info: (title: string, o: Partial<ToastOptions> = {}) => toast.info(title, o),
  success: (title: string, o: Partial<ToastOptions> = {}) => toast.success(title, o),
  warning: (title: string, o: Partial<ToastOptions> = {}) => toast.warning(title, o),
  error: (title: string, o: Partial<ToastOptions> = {}) => toast.error(title, o),
  dismiss: (id?: string) => toast.dismiss(id),

  /** "Moved to Trash · Undo" — destructive actions keep their undo for 6 s (§13.4). */
  undo(title: string, onUndo: () => void | Promise<void>, o: Partial<ToastOptions> = {}): string {
    return toast({
      type: 'info',
      duration: 6000,
      ...o,
      title,
      action: {
        label: 'Undo',
        onClick: () => {
          void Promise.resolve()
            .then(onUndo)
            .catch((e) => notify.fromError(e, "Couldn't undo"));
        },
      },
    });
  },

  /** Map a backend error to a toast. LOCKED and CANCELLED are silent (the app reacts to those elsewhere). */
  fromError(e: unknown, fallbackTitle = 'Something went wrong'): string | null {
    if (hasCode(e, 'LOCKED', 'CANCELLED')) return null;
    if (isApiError(e) && e.code === 'OFFLINE') return toast.warning('Offline mode is on', { description: e.message });
    if (isApiError(e) && e.code === 'CONFLICT') {
      return toast.warning('This changed somewhere else', { description: 'Reload to see the latest version.' });
    }
    const message = errorMessage(e);
    return toast.error(fallbackTitle, message && message !== fallbackTitle ? { description: message } : {});
  },

  /** "Clipboard clears in 30s" with a live countdown and "Clear now". */
  clipboard: (seconds: number, clear: () => void) => toast.clipboard(seconds, clear),
};

export default notify;
