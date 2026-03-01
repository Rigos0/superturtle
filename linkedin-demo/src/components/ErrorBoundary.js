import React, { Component } from "react";
import { Box, Button, Paper, Typography } from "@material-ui/core";

class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  componentDidCatch(error, errorInfo) {
    console.error("Error boundary caught an error:", error, errorInfo);
    this.setState({ hasError: true });
  }

  handleRetry = () => {
    this.setState({ hasError: false });
  };

  render() {
    const { hasError } = this.state;
    const { children } = this.props;

    if (hasError) {
      return (
        <Paper
          elevation={1}
          style={{
            width: "100%",
            minHeight: 260,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
          }}
        >
          <Box
            display="flex"
            flexDirection="column"
            alignItems="center"
            gridGap={12}
          >
            <Typography variant="h6">Something went wrong</Typography>
            <Button
              variant="contained"
              onClick={this.handleRetry}
              style={{ backgroundColor: "#2e7d32", color: "#ffffff" }}
            >
              Retry
            </Button>
          </Box>
        </Paper>
      );
    }

    return children;
  }
}

export default ErrorBoundary;
