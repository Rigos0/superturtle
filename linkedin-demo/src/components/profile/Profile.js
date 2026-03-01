import { useState } from "react";
import { useQuery } from "convex/react";
import {
  Avatar,
  Button,
  Paper,
  Typography,
  Divider,
  Tabs,
  Tab,
} from "@material-ui/core";
import ArrowBackIcon from "@material-ui/icons/ArrowBack";
import LocationOnIcon from "@material-ui/icons/LocationOn";
import { api } from "../../convex/_generated/api";
import useConvexUser from "../../hooks/useConvexUser";
import Post from "../posts/post/Post";
import Style from "./Style";

const DEFAULT_PROFILE = {
  displayName: "Alex Turner",
  photoURL: "https://i.pravatar.cc/200?img=68",
  title: "Turtle In builder",
  location: "San Francisco, CA",
  about:
    "Passionate developer with a love for clean code and great UX. Previously built products at startups and scale-ups.",
  experience: [
    "Senior Developer - TechStartup",
    "Product Engineer - ScaleUp Inc",
    "CS Graduate - State University",
  ],
  connections: 500,
  followers: 750,
};

const DEFAULT_PROFILE_PHOTO = DEFAULT_PROFILE.photoURL;

const resolveProfilePhoto = (photoURL) => {
  if (typeof photoURL !== "string" || photoURL.length === 0) {
    return DEFAULT_PROFILE_PHOTO;
  }

  if (photoURL.startsWith("/")) {
    return DEFAULT_PROFILE_PHOTO;
  }

  return photoURL;
};

const Profile = ({ onBack, userId = null }) => {
  const classes = Style();
  const authUser = useConvexUser();
  const profileUser = useQuery(api.users.getUser, userId ? { id: userId } : "skip");
  const resolvedUser = profileUser ?? (!userId ? authUser : null);
  const resolvedUserId = userId ?? authUser?._id ?? null;
  const posts = useQuery(
    api.posts.listPostsByUser,
    resolvedUserId ? { authorId: resolvedUserId } : "skip",
  );

  const [activeTab, setActiveTab] = useState(0);

  const userAvatar = resolveProfilePhoto(
    resolvedUser?.photoURL ?? resolvedUser?.image ?? DEFAULT_PROFILE.photoURL,
  );
  const userName =
    resolvedUser?.displayName ??
    resolvedUser?.name ??
    DEFAULT_PROFILE.displayName;
  const userTitle = resolvedUser?.title ?? DEFAULT_PROFILE.title;
  const location = resolvedUser?.location ?? DEFAULT_PROFILE.location;
  const connections = resolvedUser?.connections ?? DEFAULT_PROFILE.connections;
  const followers = resolvedUser?.followers ?? DEFAULT_PROFILE.followers;
  const about =
    typeof resolvedUser?.about === "string" && resolvedUser.about.trim().length > 0
      ? resolvedUser.about
      : "No about information yet.";
  const experience =
    Array.isArray(resolvedUser?.experience) && resolvedUser.experience.length > 0
      ? resolvedUser.experience
      : ["No experience added yet."];
  const userPosts = posts ?? [];

  return (
    <div className={classes.profile}>
      <Paper elevation={1} className={classes.card}>
        <div className={classes.backButtonRow}>
          <Button
            variant="text"
            onClick={onBack}
            className={classes.backButton}
            startIcon={<ArrowBackIcon fontSize="small" />}
          >
            Back to feed
          </Button>
        </div>

        <div className={classes.coverArea}>
          <Avatar src={userAvatar} className={classes.avatar} />
        </div>

        <Typography variant="h6" className={classes.name}>
          {userName}
        </Typography>
        <Typography variant="body2" className={classes.title}>
          {userTitle}
        </Typography>

        <div className={classes.metaRow}>
          {location && (
            <Typography variant="body2" color="textSecondary" className={classes.metaItem}>
              <LocationOnIcon style={{ fontSize: 16, marginRight: 4 }} />
              <span>{location}</span>
            </Typography>
          )}
          <Typography variant="body2" className={classes.networkMeta}>
            {connections} connections · {followers} followers
          </Typography>
        </div>

        <div className={classes.actionRow}>
          <Button
            variant="contained"
            size="small"
            style={{
              backgroundColor: "#2e7d32",
              color: "#fff",
              textTransform: "none",
              borderRadius: 16,
              fontWeight: 600,
              padding: "4px 16px",
            }}
          >
            Connect
          </Button>
          <Button
            variant="outlined"
            size="small"
            style={{
              textTransform: "none",
              borderRadius: 16,
              borderColor: "#2e7d32",
              color: "#2e7d32",
              fontWeight: 600,
              padding: "4px 16px",
            }}
          >
            Message
          </Button>
        </div>

        <Divider style={{ margin: "16px 0 0" }} />

        <Tabs
          value={activeTab}
          onChange={(_, nextTab) => setActiveTab(nextTab)}
          indicatorColor="primary"
          textColor="primary"
          variant="fullWidth"
          className={classes.tabs}
        >
          <Tab label="Posts" className={classes.tab} />
          <Tab label="About" className={classes.tab} />
        </Tabs>

        {activeTab === 0 && (
          <div className={`${classes.section} ${classes.postsSection}`}>
            {posts === undefined ? (
              <Typography variant="body2" color="textSecondary">
                Loading posts...
              </Typography>
            ) : userPosts.length === 0 ? (
              <Typography variant="body2" color="textSecondary">
                No posts yet.
              </Typography>
            ) : (
              <div className={classes.postsList}>
                {userPosts.map((post) => (
                  <Post
                    key={post._id}
                    postId={post._id}
                    authorId={post.authorId}
                    likesCount={post.likesCount}
                    commentsCount={post.commentsCount}
                    profile={resolveProfilePhoto(post.author?.photoURL ?? userAvatar)}
                    username={post.author?.displayName ?? userName}
                    timestamp={{ toDate: () => new Date(post.createdAt) }}
                    description={post.description}
                    fileType={post.fileType}
                    fileData={post.fileData}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === 1 && (
          <div className={classes.section}>
            <Typography variant="subtitle2" style={{ fontWeight: 700, marginBottom: 6 }}>
              About
            </Typography>
            <Typography
              variant="body2"
              color="textSecondary"
              style={{ lineHeight: 1.65, whiteSpace: "pre-line" }}
            >
              {about}
            </Typography>

            <Divider style={{ margin: "16px 0 12px" }} />

            <Typography variant="subtitle2" style={{ fontWeight: 700, marginBottom: 6 }}>
              Experience
            </Typography>
            {experience.map((exp, index) => (
              <Typography
                key={`${exp}-${index}`}
                variant="body2"
                color="textSecondary"
                style={{ marginBottom: 4, lineHeight: 1.55 }}
              >
                {exp}
              </Typography>
            ))}
          </div>
        )}
      </Paper>
    </div>
  );
};

export default Profile;
