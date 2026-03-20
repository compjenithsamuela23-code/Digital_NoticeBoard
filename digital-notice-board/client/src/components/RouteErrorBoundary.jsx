import React from 'react';
import { useLocation } from 'react-router-dom';

class RouteErrorBoundaryInner extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      error: null
    };
  }

  static getDerivedStateFromError(error) {
    return {
      error
    };
  }

  componentDidCatch(error, errorInfo) {
    console.error('Route rendering failed:', error, errorInfo);
  }

  componentDidUpdate(prevProps) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  handleReload = () => {
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  };

  handleOpenAdminLogin = () => {
    if (typeof window !== 'undefined') {
      window.location.assign('/admin/login');
    }
  };

  render() {
    const { children, routePath } = this.props;
    const { error } = this.state;

    if (!error) {
      return children;
    }

    const errorMessage = String(error?.message || 'Unexpected application error.');

    return (
      <div className="route-loader route-error" role="alert" aria-live="assertive">
        <div className="route-error__shell">
          <div className="route-error__eyebrow">Workspace Recovery</div>
          <h1>Something broke while loading this page.</h1>
          <p className="route-error__message">
            The app caught a runtime error and stopped the white-screen failure. You can reload safely or
            return to login.
          </p>
          <div className="route-error__details">
            <span>Route: {routePath || '/'}</span>
            <span>Error: {errorMessage}</span>
          </div>
          <div className="route-error__actions">
            <button className="btn btn--primary" type="button" onClick={this.handleReload}>
              Reload Page
            </button>
            <button className="btn btn--ghost" type="button" onClick={this.handleOpenAdminLogin}>
              Open Admin Login
            </button>
          </div>
        </div>
      </div>
    );
  }
}

const RouteErrorBoundary = ({ children }) => {
  const location = useLocation();

  return (
    <RouteErrorBoundaryInner resetKey={location.key || location.pathname} routePath={location.pathname}>
      {children}
    </RouteErrorBoundaryInner>
  );
};

export default RouteErrorBoundary;
