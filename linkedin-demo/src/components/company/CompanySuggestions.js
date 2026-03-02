import { useState } from "react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { Avatar, Button, Paper, Typography } from "@material-ui/core";
import { makeStyles } from "@material-ui/core/styles";
import { fade } from "@material-ui/core/styles/colorManipulator";
import BusinessIcon from "@material-ui/icons/Business";
import { useNavigate } from "react-router-dom";
import { api } from "../../convex/_generated/api";
import { darkSecondary } from "../../assets/Colors";

const useStyles = makeStyles((theme) => ({
  suggestions: {
    overflow: "hidden",
    borderRadius: 10,
  },
  heading: {
    padding: "16px 14px 10px",
    borderBottom: `1px solid ${theme.palette.divider}`,
    "& > h4": {
      margin: 0,
      fontSize: 15,
      fontWeight: 600,
      color: theme.palette.text.primary,
    },
  },
  list: {
    display: "flex",
    flexDirection: "column",
  },
  companyRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing(1),
    padding: "10px 12px",
    cursor: "pointer",
    transition: "background-color 0.2s ease",
    "&:hover": {
      backgroundColor: theme.palette.type === "dark" ? darkSecondary : "#f3f2ef",
    },
  },
  companyInfo: {
    minWidth: 0,
    display: "flex",
    alignItems: "center",
    gap: theme.spacing(1),
    flex: 1,
  },
  avatar: {
    width: 42,
    height: 42,
    backgroundColor: fade(theme.palette.primary.main, 0.12),
    color: theme.palette.primary.main,
    flexShrink: 0,
  },
  textBlock: {
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: 2,
  },
  name: {
    fontSize: 14,
    fontWeight: 600,
    color: theme.palette.text.primary,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  industry: {
    fontSize: 12,
    color: theme.palette.text.secondary,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  followButton: {
    borderRadius: 16,
    minWidth: 88,
    textTransform: "none",
    fontWeight: 600,
    borderColor: theme.palette.primary.main,
    color: theme.palette.primary.main,
    "&:hover": {
      borderColor: theme.palette.primary.main,
      backgroundColor: fade(theme.palette.primary.main, 0.08),
    },
  },
  emptyState: {
    padding: "14px 12px",
    fontSize: 13,
    color: theme.palette.text.secondary,
  },
}));

const getFollowerLabel = (count) => {
  if (count === 1) {
    return "1 follower";
  }

  return `${count || 0} followers`;
};

const CompanySuggestions = () => {
  const classes = useStyles();
  const navigate = useNavigate();
  const { isAuthenticated } = useConvexAuth();
  const suggestions = useQuery(api.companies.getCompanySuggestions);
  const followCompany = useMutation(api.companyFollowers.followCompany);
  const [pendingByCompanyId, setPendingByCompanyId] = useState({});

  const handleOpenCompany = (slug) => {
    if (!slug) {
      return;
    }

    navigate(`/company/${encodeURIComponent(slug)}`);
  };

  const handleFollow = async (event, companyId) => {
    event.stopPropagation();

    if (!isAuthenticated || !companyId || pendingByCompanyId[companyId]) {
      return;
    }

    setPendingByCompanyId((prev) => ({ ...prev, [companyId]: true }));

    try {
      await followCompany({ companyId });
    } catch (error) {
      // Keep this silent for now to avoid breaking current UX flow.
      console.error("Failed to follow company", error);
    } finally {
      setPendingByCompanyId((prev) => {
        const next = { ...prev };
        delete next[companyId];
        return next;
      });
    }
  };

  return (
    <Paper className={classes.suggestions}>
      <div className={classes.heading}>
        <h4>Companies you may want to follow</h4>
      </div>

      <div className={classes.list}>
        {suggestions === undefined ? (
          <Typography className={classes.emptyState}>Loading suggestions...</Typography>
        ) : suggestions.length === 0 ? (
          <Typography className={classes.emptyState}>No company suggestions yet.</Typography>
        ) : (
          suggestions.map((company) => {
            const isPending = Boolean(pendingByCompanyId[company._id]);
            const buttonLabel = !isAuthenticated
              ? "Follow"
              : isPending
                ? "Following..."
                : "Follow";

            return (
              <div
                key={company._id}
                className={classes.companyRow}
                onClick={() => handleOpenCompany(company.slug)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    handleOpenCompany(company.slug);
                  }
                }}
                role="button"
                tabIndex={0}
              >
                <div className={classes.companyInfo}>
                  <Avatar className={classes.avatar} src={company.logoURL || undefined}>
                    {!company.logoURL ? <BusinessIcon fontSize="small" /> : null}
                  </Avatar>
                  <div className={classes.textBlock}>
                    <Typography className={classes.name}>{company.name}</Typography>
                    <Typography className={classes.industry}>
                      {`${company.industry || "Unknown industry"} • ${getFollowerLabel(
                        company.followerCount,
                      )}`}
                    </Typography>
                  </div>
                </div>

                <Button
                  variant="outlined"
                  className={classes.followButton}
                  disabled={!isAuthenticated || isPending}
                  onClick={(event) => handleFollow(event, company._id)}
                >
                  {buttonLabel}
                </Button>
              </div>
            );
          })
        )}
      </div>
    </Paper>
  );
};

export default CompanySuggestions;
