import { Component, type ReactNode } from "react";

// A render crash in one pane shows this instead of unmounting the whole page.
export class ErrorBoundary extends Component<{ children: ReactNode; label?: string }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError = (error: Error) => ({ error });
  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="banner error" role="alert">
        <b>{this.props.label ?? "This view"} crashed:</b> <span className="mono">{error.message}</span>{" "}
        <button onClick={() => this.setState({ error: null })}>Try again</button>
      </div>
    );
  }
}
