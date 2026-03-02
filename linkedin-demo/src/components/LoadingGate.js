import { useEffect, useRef, useState } from "react";
import CircularProgress from "@material-ui/core/CircularProgress";

const spinnerStyle = {
  color: "#2e7d32",
};

const LoadingGate = ({ isLoading, children, minDuration = 200, fullScreen = false }) => {
  const [showContent, setShowContent] = useState(false);
  const loadingStartRef = useRef(null);
  const timeoutRef = useRef(null);
  const previousIsLoadingRef = useRef(isLoading);

  useEffect(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }

    if (isLoading) {
      if (!previousIsLoadingRef.current || loadingStartRef.current === null) {
        loadingStartRef.current = Date.now();
      }

      setShowContent(false);
    } else if (loadingStartRef.current === null) {
      setShowContent(true);
    } else {
      const elapsed = Date.now() - loadingStartRef.current;
      const remaining = Math.max(minDuration - elapsed, 0);

      if (remaining === 0) {
        setShowContent(true);
        loadingStartRef.current = null;
      } else {
        timeoutRef.current = setTimeout(() => {
          setShowContent(true);
          timeoutRef.current = null;
          loadingStartRef.current = null;
        }, remaining);
      }
    }

    previousIsLoadingRef.current = isLoading;

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [isLoading, minDuration]);

  if (showContent) {
    return children || null;
  }

  const containerStyle = {
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    minHeight: fullScreen ? "100vh" : 200,
    width: "100%",
  };

  return (
    <div style={containerStyle}>
      <CircularProgress style={spinnerStyle} />
    </div>
  );
};

export default LoadingGate;
