import React, { useEffect, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { useParams } from "react-router-dom";
import {
  Avatar,
  Card,
  CardContent,
  CircularProgress,
  Tab,
  Tabs,
  Typography,
} from "@material-ui/core";
import { useTheme } from "@material-ui/core/styles";
import BusinessIcon from "@material-ui/icons/Business";
import { api } from "../../convex/_generated/api";
import CompanyAnalytics from "./CompanyAnalytics";

const TABS = {
  ABOUT: "about",
  POSTS: "posts",
  ANALYTICS: "analytics",
};

const formatFollowerCount = (count) => {
  const resolvedCount = typeof count === "number" ? count : 0;
  return `${resolvedCount.toLocaleString()} follower${resolvedCount === 1 ? "" : "s"}`;
};

const CompanyPage = ({ slug: slugProp }) => {
  const theme = useTheme();
  const params = useParams();
  const [activeTab, setActiveTab] = useState(TABS.ABOUT);
  const resolvedSlug = useMemo(
    () => (slugProp ?? params.slug ?? "").trim().toLowerCase(),
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

  useEffect(() => {
    if (!isAdmin && activeTab === TABS.ANALYTICS) {
      setActiveTab(TABS.ABOUT);
    }
  }, [activeTab, isAdmin]);

  if (!resolvedSlug) {
    return (
      <Card elevation={0} style={{ border: `1px solid ${theme.palette.divider}` }}>
        <CardContent>
          <Typography variant="h6" style={{ color: theme.palette.text.primary }}>
            Company not found
          </Typography>
        </CardContent>
      </Card>
    );
  }

  if (company === undefined) {
    return (
      <Card elevation={0} style={{ border: `1px solid ${theme.palette.divider}` }}>
        <CardContent style={{ display: "flex", justifyContent: "center", padding: 24 }}>
          <CircularProgress size={24} />
        </CardContent>
      </Card>
    );
  }

  if (company === null) {
    return (
      <Card elevation={0} style={{ border: `1px solid ${theme.palette.divider}` }}>
        <CardContent>
          <Typography variant="h6" style={{ color: theme.palette.text.primary }}>
            Company not found
          </Typography>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card elevation={0} style={{ border: `1px solid ${theme.palette.divider}` }}>
      <CardContent style={{ borderBottom: `1px solid ${theme.palette.divider}` }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <Avatar
            src={company.logoURL ?? undefined}
            alt={company.name}
            style={{
              width: 56,
              height: 56,
              backgroundColor: theme.palette.background.default,
              color: theme.palette.text.secondary,
            }}
          >
            {!company.logoURL ? <BusinessIcon /> : null}
          </Avatar>
          <div>
            <Typography
              variant="h6"
              style={{ color: theme.palette.text.primary, fontWeight: 700, marginBottom: 2 }}
            >
              {company.name}
            </Typography>
            <Typography variant="body2" style={{ color: theme.palette.text.secondary }}>
              {`${company.industry} • ${company.size} • ${formatFollowerCount(followerCount)}`}
            </Typography>
          </div>
        </div>
      </CardContent>

      <Tabs
        value={activeTab}
        onChange={(_, value) => setActiveTab(value)}
        indicatorColor="primary"
        textColor="primary"
        variant="scrollable"
        scrollButtons="auto"
      >
        <Tab value={TABS.ABOUT} label="About" />
        <Tab value={TABS.POSTS} label="Posts" />
        {isAdmin ? <Tab value={TABS.ANALYTICS} label="Analytics" /> : null}
      </Tabs>

      <CardContent>
        {activeTab === TABS.ABOUT ? (
          <div>
            <Typography variant="subtitle2" style={{ color: theme.palette.text.secondary }}>
              Description
            </Typography>
            <Typography
              variant="body1"
              style={{ color: theme.palette.text.primary, marginTop: 6, whiteSpace: "pre-wrap" }}
            >
              {company.description || "No company description available yet."}
            </Typography>
          </div>
        ) : null}

        {activeTab === TABS.POSTS ? (
          <Typography variant="body2" style={{ color: theme.palette.text.secondary }}>
            Company posts will appear here.
          </Typography>
        ) : null}

        {isAdmin && activeTab === TABS.ANALYTICS ? (
          <CompanyAnalytics companyId={company._id} />
        ) : null}
      </CardContent>
    </Card>
  );
};

export default CompanyPage;
