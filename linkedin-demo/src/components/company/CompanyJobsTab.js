import React from "react";
import { Card, CardContent, Typography } from "@material-ui/core";
import { useTheme } from "@material-ui/core/styles";
import WorkOutlineIcon from "@material-ui/icons/WorkOutline";

const CompanyJobsTab = () => {
  const theme = useTheme();

  return (
    <Card
      elevation={0}
      style={{
        border: `1px solid ${theme.palette.divider}`,
        backgroundColor: theme.palette.background.paper,
      }}
    >
      <CardContent
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
          minHeight: 180,
          textAlign: "center",
        }}
      >
        <WorkOutlineIcon style={{ fontSize: 36, color: theme.palette.text.secondary }} />
        <Typography variant="body1" style={{ color: theme.palette.text.secondary }}>
          No job postings yet. Check back soon!
        </Typography>
      </CardContent>
    </Card>
  );
};

export default CompanyJobsTab;
