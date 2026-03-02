import React, { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { useParams } from "react-router-dom";
import {
  Avatar,
  Card,
  CardContent,
  CircularProgress,
  IconButton,
  Menu,
  MenuItem,
  Tab,
  Tabs,
  Typography,
} from "@material-ui/core";
import useMediaQuery from "@material-ui/core/useMediaQuery";
import { makeStyles, useTheme } from "@material-ui/core/styles";
import BusinessIcon from "@material-ui/icons/Business";
import MoreVertIcon from "@material-ui/icons/MoreVert";
import VerifiedUserIcon from "@material-ui/icons/VerifiedUser";
import { api } from "../../convex/_generated/api";
import CompanyAnalytics from "./CompanyAnalytics";
import CompanyJobsTab from "./CompanyJobsTab";

const useStyles = makeStyles((theme) => ({
  pageCard: {
    border: `1px solid ${theme.palette.divider}`,
    borderRadius: 10,
    overflow: "hidden",
  },
  stateCard: {
    border: `1px solid ${theme.palette.divider}`,
    borderRadius: 10,
  },
  stateContent: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    minHeight: 140,
  },
  cover: {
    height: 190,
    backgroundSize: "cover",
    backgroundPosition: "center",
    backgroundRepeat: "no-repeat",
    backgroundColor: theme.palette.primary.main,
    borderBottom: `1px solid ${theme.palette.divider}`,
  },
  headerContent: {
    position: "relative",
    paddingTop: 0,
    paddingBottom: theme.spacing(3),
    "@media (max-width:767px)": {
      padding: theme.spacing(1.5, 2, 2),
    },
  },
  logo: {
    width: 108,
    height: 108,
    border: `4px solid ${theme.palette.background.paper}`,
    marginTop: -54,
    backgroundColor: theme.palette.background.default,
    color: theme.palette.primary.main,
    "@media (max-width:767px)": {
      width: 84,
      height: 84,
      marginTop: 0,
      borderWidth: 3,
    },
  },
  topRow: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: theme.spacing(2),
  },
  companyMeta: {
    marginTop: theme.spacing(1),
    "@media (max-width:767px)": {
      marginTop: theme.spacing(0.75),
    },
  },
  companyName: {
    fontWeight: 700,
    color: theme.palette.text.primary,
    "@media (max-width:767px)": {
      fontSize: "1.35rem",
      lineHeight: 1.25,
    },
  },
  companyNameRow: {
    display: "flex",
    alignItems: "center",
    gap: theme.spacing(0.75),
  },
  verifiedIcon: {
    color: "#1a73e8",
    fontSize: 22,
    flexShrink: 0,
  },
  companyDetails: {
    marginTop: theme.spacing(0.75),
    color: theme.palette.text.secondary,
  },
  tabs: {
    marginTop: theme.spacing(2),
    borderTop: `1px solid ${theme.palette.divider}`,
    borderBottom: `1px solid ${theme.palette.divider}`,
    "@media (max-width:767px)": {
      marginTop: theme.spacing(1.5),
    },
  },
  tab: {
    textTransform: "none",
    fontWeight: 600,
    minHeight: 44,
    minWidth: 108,
    "@media (max-width:767px)": {
      minWidth: 92,
    },
  },
  tabPanel: {
    marginTop: theme.spacing(2),
    "@media (max-width:767px)": {
      marginTop: theme.spacing(1.5),
    },
  },
  aboutSection: {
    marginTop: 0,
  },
  aboutTitle: {
    color: theme.palette.text.secondary,
    fontWeight: 600,
    textTransform: "uppercase",
    fontSize: 12,
    letterSpacing: 0.4,
  },
  aboutBody: {
    marginTop: theme.spacing(1),
    color: theme.palette.text.primary,
    whiteSpace: "pre-wrap",
  },
  adminButton: {
    color: theme.palette.primary.main,
  },
  emptyStateCard: {
    border: `1px solid ${theme.palette.divider}`,
    backgroundColor: theme.palette.background.paper,
  },
  emptyStateBody: {
    color: theme.palette.text.secondary,
    textAlign: "center",
  },
}));

const normalizeSlug = (value = "") => value.trim().toLowerCase();

const formatFollowerCount = (count) => {
  const resolvedCount = typeof count === "number" ? count : 0;
  return `${resolvedCount.toLocaleString()} follower${resolvedCount === 1 ? "" : "s"}`;
};

const TAB_ABOUT = "about";
const TAB_POSTS = "posts";
const TAB_JOBS = "jobs";
const TAB_ANALYTICS = "analytics";

const CompanyPage = ({ slug: slugProp }) => {
  const classes = useStyles();
  const theme = useTheme();
  const isMobileLayout = useMediaQuery("(max-width:767px)");
  const params = useParams();
  const [adminMenuAnchor, setAdminMenuAnchor] = useState(null);
  const [activeTab, setActiveTab] = useState(TAB_ABOUT);
  const resolvedSlug = useMemo(
    () => normalizeSlug(slugProp ?? params.slug ?? ""),
    [params.slug, slugProp],
  );

  const company = useQuery(
    api.companies.getCompanyBySlug,
    resolvedSlug ? { slug: resolvedSlug } : "skip",
  );
  const currentUser = useQuery(api.users.getCurrentUser, {});
  const followerCount = useQuery(
    api.companyFollowers.getFollowerCount,
    company?._id ? { companyId: company._id } : "skip",
  );

  const isAdmin =
    Boolean(currentUser?._id) &&
    Array.isArray(company?.admins) &&
    company.admins.some((adminId) => adminId === currentUser._id);

  const closeAdminMenu = () => setAdminMenuAnchor(null);

  const handleCopyCompanyLink = async () => {
    if (!company?.slug || !window?.navigator?.clipboard) {
      closeAdminMenu();
      return;
    }

    try {
      await window.navigator.clipboard.writeText(
        `${window.location.origin}/company/${encodeURIComponent(company.slug)}`,
      );
    } catch (error) {
      console.error("Failed to copy company link", error);
    } finally {
      closeAdminMenu();
    }
  };

  if (!resolvedSlug) {
    return (
      <Card elevation={0} className={classes.stateCard}>
        <CardContent className={classes.stateContent}>
          <Typography variant="h6" style={{ color: theme.palette.text.primary }}>
            Company not found
          </Typography>
        </CardContent>
      </Card>
    );
  }

  if (company === undefined) {
    return (
      <Card elevation={0} className={classes.stateCard}>
        <CardContent className={classes.stateContent}>
          <CircularProgress size={26} style={{ color: theme.palette.primary.main }} />
        </CardContent>
      </Card>
    );
  }

  if (company === null) {
    return (
      <Card elevation={0} className={classes.stateCard}>
        <CardContent className={classes.stateContent}>
          <Typography variant="h6" style={{ color: theme.palette.text.primary }}>
            Company not found
          </Typography>
        </CardContent>
      </Card>
    );
  }

  const coverStyle = company.coverURL
    ? { backgroundImage: `url(${company.coverURL})` }
    : {
        backgroundImage: `linear-gradient(135deg, ${theme.palette.primary.main}, #66bb6a)`,
      };

  const coverSectionStyle = isMobileLayout
    ? {
        ...coverStyle,
        height: 128,
      }
    : coverStyle;

  const companyDetails = [
    company.industry || "Industry not set",
    company.size || "Size not set",
    formatFollowerCount(followerCount),
  ].join(" • ");

  return (
    <Card elevation={0} className={classes.pageCard}>
      <div className={classes.cover} style={coverSectionStyle} />

      <CardContent className={classes.headerContent}>
        <div className={classes.topRow}>
          <Avatar src={company.logoURL || undefined} alt={company.name} className={classes.logo}>
            {!company.logoURL ? <BusinessIcon /> : null}
          </Avatar>

          {isAdmin ? (
            <>
              <IconButton
                className={classes.adminButton}
                aria-label="Company admin actions"
                onClick={(event) => setAdminMenuAnchor(event.currentTarget)}
              >
                <MoreVertIcon />
              </IconButton>

              <Menu
                anchorEl={adminMenuAnchor}
                keepMounted
                open={Boolean(adminMenuAnchor)}
                onClose={closeAdminMenu}
              >
                <MenuItem disabled>Edit company (coming soon)</MenuItem>
                <MenuItem disabled>Manage admins (coming soon)</MenuItem>
                <MenuItem onClick={handleCopyCompanyLink}>Copy company link</MenuItem>
              </Menu>
            </>
          ) : null}
        </div>

        <div className={classes.companyMeta}>
          <div className={classes.companyNameRow}>
            <Typography variant="h5" className={classes.companyName}>
              {company.name}
            </Typography>
            {company.isVerified ? (
              <VerifiedUserIcon className={classes.verifiedIcon} aria-label="Verified company" />
            ) : null}
          </div>
          <Typography variant="body2" className={classes.companyDetails}>
            {companyDetails}
          </Typography>
        </div>

        <Tabs
          value={activeTab}
          onChange={(_, nextTab) => setActiveTab(nextTab)}
          indicatorColor="primary"
          textColor="primary"
          variant={isMobileLayout ? "scrollable" : "fullWidth"}
          scrollButtons={isMobileLayout ? "auto" : "off"}
          className={classes.tabs}
        >
          <Tab value={TAB_ABOUT} label="About" className={classes.tab} />
          <Tab value={TAB_POSTS} label="Posts" className={classes.tab} />
          <Tab value={TAB_JOBS} label="Jobs" className={classes.tab} />
          {isAdmin ? <Tab value={TAB_ANALYTICS} label="Analytics" className={classes.tab} /> : null}
        </Tabs>

        <div className={classes.tabPanel}>
          {activeTab === TAB_ABOUT ? (
            <div className={classes.aboutSection}>
              <Typography className={classes.aboutTitle}>About</Typography>
              <Typography variant="body1" className={classes.aboutBody}>
                {company.description || "No company description available yet."}
              </Typography>
            </div>
          ) : null}

          {activeTab === TAB_POSTS ? (
            <Card elevation={0} className={classes.emptyStateCard}>
              <CardContent>
                <Typography variant="body2" className={classes.emptyStateBody}>
                  No company posts yet.
                </Typography>
              </CardContent>
            </Card>
          ) : null}

          {activeTab === TAB_JOBS ? <CompanyJobsTab /> : null}

          {activeTab === TAB_ANALYTICS && isAdmin ? <CompanyAnalytics companyId={company._id} /> : null}
        </div>
      </CardContent>
    </Card>
  );
};

export default CompanyPage;
