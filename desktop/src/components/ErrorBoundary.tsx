import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button, EmptyState } from "../ui";

type Props = {
  children: ReactNode;
  title?: string;
};

type State = {
  error: Error | null;
};

/** 拦住子树渲染错误，避免一整页变成白屏。 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(this.props.title || "页面渲染失败", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="panel error-boundary">
        <EmptyState
          title={this.props.title || "这一页出错了"}
          description={error.message || "渲染失败"}
          action={
            <Button onClick={() => this.setState({ error: null })}>重试</Button>
          }
        />
      </div>
    );
  }
}
