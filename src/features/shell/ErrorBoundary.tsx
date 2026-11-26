/**
 * Error boundaries. `AppErrorBoundary` wraps the whole app (a full-window recovery screen); `RouteErrorBoundary`
 * wraps each route view so one broken screen never takes down the shell. Both reset when `resetKey` changes.
 * Error details are kept local (never logged with content, §9.23); "Copy details" copies only the message and stack.
 */
import { AlertTriangle, Copy, RotateCcw } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { AppMark } from "@/features/vault/AppMark";
import { Button } from "@/ui/Button";
import { EmptyState } from "@/ui/EmptyState";
import "@/features/vault/vault.css";

interface Props {
  children: ReactNode;
  resetKey?: unknown;
  fallback?: (error: Error, reset: () => void) => ReactNode;
  onError?: (error: Error, info: ErrorInfo) => void;
}
interface State {
  error: Error | null;
  key: unknown;
}

class Boundary extends Component<Props, State> {
  state: State = { error: null, key: this.props.resetKey };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.resetKey !== state.key) return { key: props.resetKey, error: null };
    return null;
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.props.onError?.(error, info);
  }

  reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) return this.props.fallback ? this.props.fallback(this.state.error, this.reset) : null;
    return this.props.children;
  }
}

function details(error: Error): string {
  return `${error.name}: ${error.message}\n${(error.stack ?? "").split("\n").slice(1, 8).join("\n")}`;
}

function copy(error: Error) {
  void navigator.clipboard?.writeText(details(error)).catch(() => undefined);
}

export function RouteErrorBoundary({ children, resetKey }: { children: ReactNode; resetKey?: unknown }) {
  return (
    <Boundary
      resetKey={resetKey}
      fallback={(error, reset) => (
        <div className="flex h-full min-h-[360px] w-full items-center justify-center p-8" role="alert">
          <EmptyState
            icon={AlertTriangle}
            title="This view ran into a problem"
            body="Your data is safe. Try again, or go somewhere else and come back."
            actions={
              <>
                <Button variant="primary" icon={RotateCcw} iconMotion="refresh" onClick={reset}>
                  Try again
                </Button>
                <Button variant="ghost" icon={Copy} onClick={() => copy(error)}>
                  Copy details
                </Button>
              </>
            }
          />
        </div>
      )}
    >
      {children}
    </Boundary>
  );
}

export function AppErrorBoundary({ children }: { children: ReactNode }) {
  return (
    <Boundary
      fallback={(error) => (
        <div className="emp-stage emp-vault-stage" role="alert">
          <span className="emp-stage-light" aria-hidden />
          <div className="emp-vault-card w-[420px] max-w-full p-8">
            <div className="relative mb-5 h-14 w-14">
              <AppMark size={56} stage="jolt" />
              <span className="emp-lock-badge" style={{ color: "var(--warning-text)" }} aria-hidden>
                <AlertTriangle size={12} strokeWidth={2.4} />
              </span>
            </div>
            <h1 className="text-title text-primary">Ultra Note needs to restart</h1>
            <p className="mt-2 text-body text-secondary">
              Something unexpected happened. Your workspace is saved on this device; restarting reloads it.
            </p>
            <div className="mt-6 flex gap-2">
              <Button variant="primary" icon={RotateCcw} iconMotion="refresh" onClick={() => window.location.reload()}>
                Restart Ultra Note
              </Button>
              <Button variant="ghost" icon={Copy} onClick={() => copy(error)}>
                Copy details
              </Button>
            </div>
          </div>
        </div>
      )}
    >
      {children}
    </Boundary>
  );
}

export default AppErrorBoundary;
