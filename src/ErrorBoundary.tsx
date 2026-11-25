import { Component, type ReactNode, type ErrorInfo } from "react";

import { trace } from "./trace";

const STORAGE_KEY = "ecnu-receipt-desk:v1";

type Props = { label: string; children: ReactNode };
type State = { error: Error | null; stack: string };

/**
 * 渲染错误边界（红灯）：任何子组件运行时抛错只点亮本区域的错误卡，
 * 不再把整个应用卸载成白屏。label 标明出错区域，栈信息可展开定位。
 * 本地暂存与当前版本不兼容（长期未刷新的浏览器窗口）时提供一键重置——服务器数据不受影响。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, stack: "" };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ stack: info.componentStack ?? "" });
    trace({ level: "error", scope: "ui", event: "render-error" });
    console.error(`[ErrorBoundary:${this.props.label}]`, error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="error-boundary" role="alert">
          <strong>⛔ {this.props.label} 渲染出错</strong>
          <code>{this.state.error.message}</code>
          <div>
            <button type="button" onClick={() => this.setState({ error: null, stack: "" })}>重试</button>
            <button
              type="button"
              title="清空浏览器本地暂存并重新加载；服务器端数据不受影响"
              onClick={() => {
                try { localStorage.removeItem(STORAGE_KEY); } catch { /* 忽略 */ }
                location.reload();
              }}
            >
              清空本地数据并刷新
            </button>
          </div>
          {this.state.stack && (
            <details className="error-boundary-stack">
              <summary>组件栈</summary>
              <pre>{this.state.stack}</pre>
            </details>
          )}
        </div>
      );
    }
    return this.props.children;
  }
}
