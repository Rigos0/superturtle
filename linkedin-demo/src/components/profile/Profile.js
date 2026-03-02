import React, { useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  Avatar,
  Button,
  Paper,
  Typography,
  Divider,
  Tabs,
  Tab,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  IconButton,
  Chip,
} from "@material-ui/core";
import ArrowBackIcon from "@material-ui/icons/ArrowBack";
import CameraAltIcon from "@material-ui/icons/CameraAlt";
import LocationOnIcon from "@material-ui/icons/LocationOn";
import ReactTimeago from "react-timeago";
import { api } from "../../convex/_generated/api";
import { DEFAULT_PHOTO } from "../../constants";
import useConvexUser from "../../hooks/useConvexUser";
import LoadingGate from "../LoadingGate";
import Post from "../posts/post/Post";
import Style from "./Style";

const DEFAULT_PROFILE = {
  displayName: "User",
  photoURL: DEFAULT_PHOTO,
  title: "",
  headline: "",
  location: "",
  about: "",
};
const MAX_PROFILE_PHOTO_SIZE_BYTES = 5 * 1024 * 1024;
const MAX_COVER_PHOTO_SIZE_BYTES = 5 * 1024 * 1024;

const resolveProfilePhoto = (photoURL) => {
  if (typeof photoURL !== "string" || photoURL.length === 0) {
    return DEFAULT_PHOTO;
  }

  if (photoURL.startsWith("/")) {
    return DEFAULT_PHOTO;
  }

  return photoURL;
};

const resolveProfileText = (value, fallback = "") => {
  if (typeof value !== "string") {
    return fallback;
  }

  const trimmedValue = value.trim();
  return trimmedValue.length > 0 ? trimmedValue : fallback;
};

const resolveCoverPhoto = (coverURL) => {
  if (typeof coverURL !== "string" || coverURL.length === 0) {
    return "";
  }

  if (coverURL.startsWith("/")) {
    return "";
  }

  return coverURL;
};

const buildProfileFormData = (user) => ({
  displayName:
    resolveProfileText(user?.displayName) ||
    resolveProfileText(user?.name, DEFAULT_PROFILE.displayName),
  title: resolveProfileText(user?.title, DEFAULT_PROFILE.title),
  headline: resolveProfileText(user?.headline, DEFAULT_PROFILE.headline),
  location: resolveProfileText(user?.location, DEFAULT_PROFILE.location),
  about: resolveProfileText(user?.about, DEFAULT_PROFILE.about),
});

const buildExperienceFormData = (entry = null) => ({
  title: resolveProfileText(entry?.title),
  company: resolveProfileText(entry?.company),
  startDate: resolveProfileText(entry?.startDate),
  endDate: resolveProfileText(entry?.endDate),
  description: resolveProfileText(entry?.description),
});

const buildEducationFormData = (entry = null) => ({
  school: resolveProfileText(entry?.school),
  degree: resolveProfileText(entry?.degree),
  field: resolveProfileText(entry?.field),
  startYear: resolveProfileText(entry?.startYear),
  endYear: resolveProfileText(entry?.endYear),
});

const formatExperienceDateRange = (startDate, endDate) => {
  const hasStartDate = typeof startDate === "string" && startDate.trim().length > 0;
  const hasEndDate = typeof endDate === "string" && endDate.trim().length > 0;

  if (hasStartDate && hasEndDate) {
    return `${startDate} - ${endDate}`;
  }

  if (hasStartDate) {
    return `${startDate} - Present`;
  }

  return "";
};

const truncateText = (value, maxLength = 180) => {
  if (typeof value !== "string") {
    return "";
  }

  const normalizedValue = value.trim();
  if (normalizedValue.length <= maxLength) {
    return normalizedValue;
  }

  return `${normalizedValue.slice(0, maxLength - 1).trimEnd()}...`;
};

const renderInlineRichText = (line, lineIndex) => {
  const tokens = line.split(/(\*\*[^*\n]+\*\*|\*[^*\n]+\*)/g);

  return tokens.map((token, tokenIndex) => {
    if (!token) {
      return null;
    }

    const key = `${lineIndex}-${tokenIndex}`;

    if (token.startsWith("**") && token.endsWith("**") && token.length > 4) {
      return <strong key={key}>{token.slice(2, -2)}</strong>;
    }

    if (token.startsWith("*") && token.endsWith("*") && token.length > 2) {
      return <em key={key}>{token.slice(1, -1)}</em>;
    }

    return <React.Fragment key={key}>{token}</React.Fragment>;
  });
};

const renderBasicRichText = (value, fallback = "") => {
  if (typeof value !== "string" || value.trim().length === 0) {
    return fallback;
  }

  const lines = value.split("\n");

  return lines.map((line, lineIndex) => (
    <React.Fragment key={`line-${lineIndex}`}>
      {renderInlineRichText(line, lineIndex)}
      {lineIndex < lines.length - 1 && <br />}
    </React.Fragment>
  ));
};

const formatEducationDateRange = (startYear, endYear) => {
  const hasStartYear = typeof startYear === "string" && startYear.trim().length > 0;
  const hasEndYear = typeof endYear === "string" && endYear.trim().length > 0;

  if (hasStartYear && hasEndYear) {
    return `${startYear} - ${endYear}`;
  }

  if (hasStartYear) {
    return `${startYear} - Present`;
  }

  return "";
};

const Profile = ({
  onBack,
  onNavigateMessaging = () => {},
  onViewProfile = () => {},
  userId = null,
}) => {
  const classes = Style();
  const authUser = useConvexUser();
  const getOrCreateConversation = useMutation(api.messaging.getOrCreateConversation);
  const sendConnectionRequest = useMutation(api.connections.sendConnectionRequest);
  const acceptConnection = useMutation(api.connections.acceptConnection);
  const rejectConnection = useMutation(api.connections.rejectConnection);
  const removeConnection = useMutation(api.connections.removeConnection);
  const updateCurrentUserProfile = useMutation(api.users.updateCurrentUserProfile);
  const updateCurrentUserAbout = useMutation(api.users.updateCurrentUserAbout);
  const addExperience = useMutation(api.users.addExperience);
  const updateExperience = useMutation(api.users.updateExperience);
  const removeExperience = useMutation(api.users.removeExperience);
  const addEducation = useMutation(api.users.addEducation);
  const updateEducation = useMutation(api.users.updateEducation);
  const removeEducation = useMutation(api.users.removeEducation);
  const addSkill = useMutation(api.users.addSkill);
  const removeSkill = useMutation(api.users.removeSkill);
  const generateProfilePhotoUploadUrl = useMutation(api.users.generateUploadUrl);
  const saveProfilePhoto = useMutation(api.users.saveProfilePhoto);
  const generateCoverPhotoUploadUrl = useMutation(api.users.generateCoverUploadUrl);
  const saveCoverPhoto = useMutation(api.users.saveCoverPhoto);
  const profileUser = useQuery(api.users.getUser, userId ? { id: userId } : "skip");
  const resolvedUser = profileUser ?? (!userId ? authUser : null);
  const resolvedUserId = userId ?? authUser?._id ?? null;
  const [showConnections, setShowConnections] = useState(false);
  const [isConnectedActionHovered, setIsConnectedActionHovered] = useState(false);
  const connectionStatus = useQuery(
    api.connections.getConnectionStatus,
    authUser?._id && resolvedUserId
      ? { userId1: authUser._id, userId2: resolvedUserId }
      : "skip",
  );
  const connectionCount = useQuery(
    api.connections.getConnectionCount,
    resolvedUserId ? { userId: resolvedUserId } : "skip",
  );
  const profileConnections = useQuery(
    api.connections.listConnections,
    showConnections && resolvedUserId ? { userId: resolvedUserId } : "skip",
  );
  const posts = useQuery(
    api.posts.listPostsByUser,
    resolvedUserId ? { authorId: resolvedUserId } : "skip",
  );
  const activity = useQuery(
    api.users.getRecentActivity,
    resolvedUserId ? { userId: resolvedUserId, limit: 10 } : "skip",
  );
  const isUserLoading = userId ? profileUser === undefined : resolvedUser === null;
  const userPosts = React.useMemo(() => posts ?? [], [posts]);
  const activityItems = React.useMemo(() => activity ?? [], [activity]);

  const profilePostIds = React.useMemo(
    () => userPosts.map((post) => post._id),
    [userPosts],
  );

  const profileLikeStatuses = useQuery(
    api.likes.getLikeStatuses,
    authUser?._id && profilePostIds.length > 0
      ? { userId: authUser._id, postIds: profilePostIds }
      : "skip",
  );

  const [activeTab, setActiveTab] = useState(0);
  const [isStartingConversation, setIsStartingConversation] = useState(false);
  const [isConnectionActionPending, setIsConnectionActionPending] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [isProfileSavePending, setIsProfileSavePending] = useState(false);
  const [profileFormData, setProfileFormData] = useState(() => buildProfileFormData(null));
  const [isExperienceDialogOpen, setIsExperienceDialogOpen] = useState(false);
  const [editingExperienceId, setEditingExperienceId] = useState(null);
  const [experienceFormData, setExperienceFormData] = useState(() => buildExperienceFormData());
  const [isExperienceSavePending, setIsExperienceSavePending] = useState(false);
  const [isEducationDialogOpen, setIsEducationDialogOpen] = useState(false);
  const [editingEducationId, setEditingEducationId] = useState(null);
  const [educationFormData, setEducationFormData] = useState(() => buildEducationFormData());
  const [isEducationSavePending, setIsEducationSavePending] = useState(false);
  const [isPhotoUploadPending, setIsPhotoUploadPending] = useState(false);
  const [isCoverUploadPending, setIsCoverUploadPending] = useState(false);
  const [photoUploadError, setPhotoUploadError] = useState("");
  const [coverUploadError, setCoverUploadError] = useState("");
  const [skillInputValue, setSkillInputValue] = useState("");
  const [skillError, setSkillError] = useState("");
  const [isSkillMutationPending, setIsSkillMutationPending] = useState(false);
  const profilePhotoInputRef = useRef(null);
  const coverPhotoInputRef = useRef(null);

  const userAvatar = resolveProfilePhoto(
    resolvedUser?.photoURL ?? resolvedUser?.image ?? DEFAULT_PROFILE.photoURL,
  );
  const coverPhotoURL = resolveCoverPhoto(resolvedUser?.coverURL);
  const userName =
    resolveProfileText(resolvedUser?.displayName) ||
    resolveProfileText(resolvedUser?.name, DEFAULT_PROFILE.displayName);
  const userTitle = resolveProfileText(resolvedUser?.title, DEFAULT_PROFILE.title);
  const userHeadline = resolveProfileText(resolvedUser?.headline, DEFAULT_PROFILE.headline);
  const location = resolveProfileText(resolvedUser?.location, DEFAULT_PROFILE.location);
  const connections = connectionCount ?? 0;
  const about = resolveProfileText(resolvedUser?.about);
  const experienceEntries = Array.isArray(resolvedUser?.experienceEntries)
    ? resolvedUser.experienceEntries
    : [];
  const legacyExperience =
    experienceEntries.length === 0 &&
    Array.isArray(resolvedUser?.experience) &&
    resolvedUser.experience.length > 0
      ? resolvedUser.experience
      : [];
  const educationEntries = Array.isArray(resolvedUser?.educationEntries)
    ? resolvedUser.educationEntries
    : [];
  const skills = Array.isArray(resolvedUser?.skills) ? resolvedUser.skills : [];
  const isOwnProfile =
    Boolean(authUser?._id) &&
    Boolean(resolvedUserId) &&
    authUser?._id === resolvedUserId;
  const canShowProfileActions = Boolean(authUser?._id) && !isOwnProfile;
  const connectionState = connectionStatus?.status ?? "none";
  const isConnectionStatusLoading =
    Boolean(authUser?._id) &&
    Boolean(resolvedUserId) &&
    connectionStatus === undefined;
  const connectionsList = React.useMemo(() => profileConnections ?? [], [profileConnections]);
  const isConnectionsListLoading = showConnections && profileConnections === undefined;

  React.useEffect(() => {
    if (connectionState !== "accepted") {
      setIsConnectedActionHovered(false);
    }
  }, [connectionState]);

  React.useEffect(() => {
    setShowConnections(false);
    setIsEditDialogOpen(false);
    setIsExperienceDialogOpen(false);
    setEditingExperienceId(null);
    setExperienceFormData(buildExperienceFormData());
    setIsEducationDialogOpen(false);
    setEditingEducationId(null);
    setEducationFormData(buildEducationFormData());
    setPhotoUploadError("");
    setCoverUploadError("");
    setSkillInputValue("");
    setSkillError("");
    setIsSkillMutationPending(false);
  }, [resolvedUserId]);

  const handleMessageClick = async () => {
    if (!authUser?._id || !resolvedUserId || isStartingConversation) {
      return;
    }

    setIsStartingConversation(true);

    try {
      if (authUser._id !== resolvedUserId) {
        await getOrCreateConversation({
          userId1: authUser._id,
          userId2: resolvedUserId,
        });
      }
      onNavigateMessaging();
    } finally {
      setIsStartingConversation(false);
    }
  };

  const handleConnect = async () => {
    if (!authUser?._id || !resolvedUserId || isConnectionActionPending) {
      return;
    }

    setIsConnectionActionPending(true);

    try {
      await sendConnectionRequest({
        fromUserId: authUser._id,
        toUserId: resolvedUserId,
      });
    } catch (error) {
      console.error("Failed to send connection request:", error);
    } finally {
      setIsConnectionActionPending(false);
    }
  };

  const handleAcceptConnection = async () => {
    if (!connectionStatus?.connectionId || isConnectionActionPending) {
      return;
    }

    setIsConnectionActionPending(true);

    try {
      await acceptConnection({ connectionId: connectionStatus.connectionId });
    } catch (error) {
      console.error("Failed to accept connection request:", error);
    } finally {
      setIsConnectionActionPending(false);
    }
  };

  const handleRejectConnection = async () => {
    if (!connectionStatus?.connectionId || isConnectionActionPending) {
      return;
    }

    setIsConnectionActionPending(true);

    try {
      await rejectConnection({ connectionId: connectionStatus.connectionId });
    } catch (error) {
      console.error("Failed to reject connection request:", error);
    } finally {
      setIsConnectionActionPending(false);
    }
  };

  const handleRemoveConnection = async () => {
    if (!connectionStatus?.connectionId || isConnectionActionPending) {
      return;
    }

    if (!isConnectedActionHovered) {
      setIsConnectedActionHovered(true);
      return;
    }

    setIsConnectionActionPending(true);

    try {
      await removeConnection({ connectionId: connectionStatus.connectionId });
      setIsConnectedActionHovered(false);
    } catch (error) {
      console.error("Failed to remove connection:", error);
    } finally {
      setIsConnectionActionPending(false);
    }
  };

  const handleViewConnections = () => {
    if (!resolvedUserId) {
      return;
    }

    setShowConnections(true);
  };

  const handleCloseConnections = () => {
    setShowConnections(false);
  };

  const handleViewConnectionProfile = (targetUserId) => {
    if (!targetUserId) {
      return;
    }

    setShowConnections(false);
    onViewProfile(targetUserId);
  };

  const handleOpenEditDialog = () => {
    if (!isOwnProfile) {
      return;
    }

    setProfileFormData(buildProfileFormData(resolvedUser));
    setIsEditDialogOpen(true);
  };

  const handleCloseEditDialog = () => {
    if (isProfileSavePending) {
      return;
    }
    setIsEditDialogOpen(false);
  };

  const handleEditFieldChange = (fieldName) => (event) => {
    const nextValue = event.target.value;
    setProfileFormData((previousData) => ({
      ...previousData,
      [fieldName]: nextValue,
    }));
  };

  const handleSaveProfile = async () => {
    if (!isOwnProfile || isProfileSavePending) {
      return;
    }

    setIsProfileSavePending(true);

    try {
      await updateCurrentUserProfile({
        displayName: profileFormData.displayName,
        title: profileFormData.title,
        headline: profileFormData.headline,
        location: profileFormData.location,
      });
      await updateCurrentUserAbout({ about: profileFormData.about });
      setIsEditDialogOpen(false);
    } catch (error) {
      console.error("Failed to update profile:", error);
    } finally {
      setIsProfileSavePending(false);
    }
  };

  const handleOpenCreateExperienceDialog = () => {
    if (!isOwnProfile) {
      return;
    }

    setEditingExperienceId(null);
    setExperienceFormData(buildExperienceFormData());
    setIsExperienceDialogOpen(true);
  };

  const handleOpenEditExperienceDialog = (entry) => {
    if (!isOwnProfile || !entry) {
      return;
    }

    setEditingExperienceId(entry.id);
    setExperienceFormData(buildExperienceFormData(entry));
    setIsExperienceDialogOpen(true);
  };

  const handleCloseExperienceDialog = (force = false) => {
    if (isExperienceSavePending && !force) {
      return;
    }

    setIsExperienceDialogOpen(false);
    setEditingExperienceId(null);
    setExperienceFormData(buildExperienceFormData());
  };

  const handleExperienceFieldChange = (fieldName) => (event) => {
    const nextValue = event.target.value;
    setExperienceFormData((previousData) => ({
      ...previousData,
      [fieldName]: nextValue,
    }));
  };

  const handleSaveExperience = async () => {
    if (!isOwnProfile || isExperienceSavePending) {
      return;
    }

    setIsExperienceSavePending(true);

    try {
      if (editingExperienceId) {
        await updateExperience({
          entryId: editingExperienceId,
          title: experienceFormData.title,
          company: experienceFormData.company,
          startDate: experienceFormData.startDate,
          endDate: experienceFormData.endDate,
          description: experienceFormData.description,
        });
      } else {
        await addExperience({
          title: experienceFormData.title,
          company: experienceFormData.company,
          startDate: experienceFormData.startDate,
          endDate: experienceFormData.endDate,
          description: experienceFormData.description,
        });
      }

      handleCloseExperienceDialog(true);
    } catch (error) {
      console.error("Failed to save experience:", error);
    } finally {
      setIsExperienceSavePending(false);
    }
  };

  const handleRemoveExperience = async (entryId) => {
    if (!isOwnProfile || !entryId || isExperienceSavePending) {
      return;
    }

    if (!window.confirm("Remove this experience entry?")) {
      return;
    }

    setIsExperienceSavePending(true);

    try {
      await removeExperience({ entryId });
      if (editingExperienceId === entryId) {
        handleCloseExperienceDialog(true);
      }
    } catch (error) {
      console.error("Failed to remove experience:", error);
    } finally {
      setIsExperienceSavePending(false);
    }
  };

  const handleOpenCreateEducationDialog = () => {
    if (!isOwnProfile) {
      return;
    }

    setEditingEducationId(null);
    setEducationFormData(buildEducationFormData());
    setIsEducationDialogOpen(true);
  };

  const handleOpenEditEducationDialog = (entry) => {
    if (!isOwnProfile || !entry) {
      return;
    }

    setEditingEducationId(entry.id);
    setEducationFormData(buildEducationFormData(entry));
    setIsEducationDialogOpen(true);
  };

  const handleCloseEducationDialog = (force = false) => {
    if (isEducationSavePending && !force) {
      return;
    }

    setIsEducationDialogOpen(false);
    setEditingEducationId(null);
    setEducationFormData(buildEducationFormData());
  };

  const handleEducationFieldChange = (fieldName) => (event) => {
    const nextValue = event.target.value;
    setEducationFormData((previousData) => ({
      ...previousData,
      [fieldName]: nextValue,
    }));
  };

  const handleSaveEducation = async () => {
    if (!isOwnProfile || isEducationSavePending) {
      return;
    }

    setIsEducationSavePending(true);

    try {
      if (editingEducationId) {
        await updateEducation({
          entryId: editingEducationId,
          school: educationFormData.school,
          degree: educationFormData.degree,
          field: educationFormData.field,
          startYear: educationFormData.startYear,
          endYear: educationFormData.endYear,
        });
      } else {
        await addEducation({
          school: educationFormData.school,
          degree: educationFormData.degree,
          field: educationFormData.field,
          startYear: educationFormData.startYear,
          endYear: educationFormData.endYear,
        });
      }

      handleCloseEducationDialog(true);
    } catch (error) {
      console.error("Failed to save education:", error);
    } finally {
      setIsEducationSavePending(false);
    }
  };

  const handleRemoveEducation = async (entryId) => {
    if (!isOwnProfile || !entryId || isEducationSavePending) {
      return;
    }

    if (!window.confirm("Remove this education entry?")) {
      return;
    }

    setIsEducationSavePending(true);

    try {
      await removeEducation({ entryId });
      if (editingEducationId === entryId) {
        handleCloseEducationDialog(true);
      }
    } catch (error) {
      console.error("Failed to remove education:", error);
    } finally {
      setIsEducationSavePending(false);
    }
  };

  const handleSkillInputChange = (event) => {
    setSkillInputValue(event.target.value);
    if (skillError) {
      setSkillError("");
    }
  };

  const handleAddSkill = async () => {
    if (!isOwnProfile || isSkillMutationPending) {
      return;
    }

    const normalizedSkill = skillInputValue.trim().replace(/\s+/g, " ");
    if (!normalizedSkill) {
      setSkillError("Enter a skill first.");
      return;
    }

    if (skills.some((skill) => skill.trim().toLowerCase() === normalizedSkill.toLowerCase())) {
      setSkillError("That skill is already listed.");
      return;
    }

    setIsSkillMutationPending(true);
    setSkillError("");

    try {
      await addSkill({ skill: normalizedSkill });
      setSkillInputValue("");
    } catch (error) {
      console.error("Failed to add skill:", error);
      setSkillError("Could not add skill. Please try again.");
    } finally {
      setIsSkillMutationPending(false);
    }
  };

  const handleRemoveSkill = async (skill) => {
    if (!isOwnProfile || isSkillMutationPending) {
      return;
    }

    setIsSkillMutationPending(true);
    setSkillError("");

    try {
      await removeSkill({ skill });
    } catch (error) {
      console.error("Failed to remove skill:", error);
      setSkillError("Could not remove skill. Please try again.");
    } finally {
      setIsSkillMutationPending(false);
    }
  };

  const handleSelectProfilePhoto = () => {
    if (!isOwnProfile || isPhotoUploadPending) {
      return;
    }
    profilePhotoInputRef.current?.click();
  };

  const handleSelectCoverPhoto = () => {
    if (!isOwnProfile || isCoverUploadPending) {
      return;
    }
    coverPhotoInputRef.current?.click();
  };

  const handleProfilePhotoChange = async (event) => {
    const selectedFile = event.target.files?.[0];
    event.target.value = "";

    if (!selectedFile || !isOwnProfile || isPhotoUploadPending) {
      return;
    }

    if (!selectedFile.type.startsWith("image/")) {
      setPhotoUploadError("Please choose an image file.");
      return;
    }

    if (selectedFile.size > MAX_PROFILE_PHOTO_SIZE_BYTES) {
      setPhotoUploadError("Photo must be 5MB or smaller.");
      return;
    }

    setPhotoUploadError("");
    setIsPhotoUploadPending(true);

    try {
      const uploadUrl = await generateProfilePhotoUploadUrl({});
      const uploadResult = await fetch(uploadUrl, {
        method: "POST",
        headers: {
          "Content-Type": selectedFile.type || "application/octet-stream",
        },
        body: selectedFile,
      });

      if (!uploadResult.ok) {
        throw new Error("Upload failed");
      }

      const { storageId } = await uploadResult.json();
      if (!storageId) {
        throw new Error("Missing storage ID");
      }

      await saveProfilePhoto({ storageId });
    } catch (error) {
      console.error("Failed to upload profile photo:", error);
      setPhotoUploadError("Profile photo upload failed. Please try again.");
    } finally {
      setIsPhotoUploadPending(false);
    }
  };

  const handleCoverPhotoChange = async (event) => {
    const selectedFile = event.target.files?.[0];
    event.target.value = "";

    if (!selectedFile || !isOwnProfile || isCoverUploadPending) {
      return;
    }

    if (!selectedFile.type.startsWith("image/")) {
      setCoverUploadError("Please choose an image file.");
      return;
    }

    if (selectedFile.size > MAX_COVER_PHOTO_SIZE_BYTES) {
      setCoverUploadError("Cover photo must be 5MB or smaller.");
      return;
    }

    setCoverUploadError("");
    setIsCoverUploadPending(true);

    try {
      const uploadUrl = await generateCoverPhotoUploadUrl({});
      const uploadResult = await fetch(uploadUrl, {
        method: "POST",
        headers: {
          "Content-Type": selectedFile.type || "application/octet-stream",
        },
        body: selectedFile,
      });

      if (!uploadResult.ok) {
        throw new Error("Upload failed");
      }

      const { storageId } = await uploadResult.json();
      if (!storageId) {
        throw new Error("Missing storage ID");
      }

      await saveCoverPhoto({ storageId });
    } catch (error) {
      console.error("Failed to upload cover photo:", error);
      setCoverUploadError("Cover photo upload failed. Please try again.");
    } finally {
      setIsCoverUploadPending(false);
    }
  };

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

        <LoadingGate isLoading={isUserLoading}>
          <>
            <div
              className={`${classes.coverArea} ${coverPhotoURL ? classes.coverAreaWithImage : ""}`}
              style={
                coverPhotoURL
                  ? {
                      backgroundImage: `url(${coverPhotoURL})`,
                    }
                  : undefined
              }
            >
              <Avatar src={userAvatar} className={classes.avatar} />
              {isOwnProfile && (
                <>
                  <input
                    ref={coverPhotoInputRef}
                    type="file"
                    accept="image/*"
                    onChange={handleCoverPhotoChange}
                    className={classes.hiddenInput}
                  />
                  <IconButton
                    onClick={handleSelectCoverPhoto}
                    disabled={isCoverUploadPending}
                    className={classes.coverUploadButton}
                    aria-label="Update cover photo"
                  >
                    <CameraAltIcon fontSize="small" />
                  </IconButton>
                  <input
                    ref={profilePhotoInputRef}
                    type="file"
                    accept="image/*"
                    onChange={handleProfilePhotoChange}
                    className={classes.hiddenInput}
                  />
                  <Button
                    variant="contained"
                    size="small"
                    onClick={handleSelectProfilePhoto}
                    disabled={isPhotoUploadPending}
                    className={classes.photoUploadButton}
                  >
                    {isPhotoUploadPending ? "Uploading..." : "Update photo"}
                  </Button>
                </>
              )}
            </div>

            <Typography variant="h6" className={classes.name}>
              {userName}
            </Typography>
            <Typography variant="body2" className={classes.title}>
              {userTitle}
            </Typography>
            {userHeadline && (
              <Typography variant="body2" className={classes.title}>
                {userHeadline}
              </Typography>
            )}
            {photoUploadError && isOwnProfile && (
              <Typography variant="body2" className={classes.photoUploadError}>
                {photoUploadError}
              </Typography>
            )}
            {coverUploadError && isOwnProfile && (
              <Typography variant="body2" className={classes.photoUploadError}>
                {coverUploadError}
              </Typography>
            )}

            <div className={classes.metaRow}>
              {location && (
                <Typography variant="body2" color="textSecondary" className={classes.metaItem}>
                  <LocationOnIcon style={{ fontSize: 16, marginRight: 4 }} />
                  <span>{location}</span>
                </Typography>
              )}
              <Typography
                variant="body2"
                className={classes.networkMeta}
                role={resolvedUserId ? "button" : undefined}
                tabIndex={resolvedUserId ? 0 : undefined}
                onClick={handleViewConnections}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    handleViewConnections();
                  }
                }}
                style={{ cursor: resolvedUserId ? "pointer" : "default" }}
              >
                {connections} connections
              </Typography>
            </div>

            {isOwnProfile && (
              <div className={classes.actionRow}>
                <Button
                  variant="outlined"
                  size="small"
                  onClick={handleOpenEditDialog}
                  style={{
                    textTransform: "none",
                    borderRadius: 16,
                    borderColor: "#2e7d32",
                    color: "#2e7d32",
                    fontWeight: 600,
                    padding: "4px 16px",
                  }}
                >
                  Edit profile
                </Button>
              </div>
            )}

            {canShowProfileActions && (
              <div className={classes.actionRow}>
                {connectionState === "none" && (
                  <Button
                    variant="contained"
                    size="small"
                    onClick={handleConnect}
                    disabled={
                      isConnectionStatusLoading ||
                      isConnectionActionPending ||
                      !authUser?._id ||
                      !resolvedUserId
                    }
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
                )}
                {connectionState === "pending" && connectionStatus?.direction === "sent" && (
                  <Button
                    variant="outlined"
                    size="small"
                    disabled
                    style={{
                      textTransform: "none",
                      borderRadius: 16,
                      borderColor: "#9e9e9e",
                      color: "#757575",
                      fontWeight: 600,
                      padding: "4px 16px",
                    }}
                  >
                    Pending
                  </Button>
                )}
                {connectionState === "pending" && connectionStatus?.direction === "received" && (
                  <>
                    <Button
                      variant="contained"
                      size="small"
                      onClick={handleAcceptConnection}
                      disabled={isConnectionActionPending}
                      style={{
                        backgroundColor: "#2e7d32",
                        color: "#fff",
                        textTransform: "none",
                        borderRadius: 16,
                        fontWeight: 600,
                        padding: "4px 16px",
                      }}
                    >
                      Accept
                    </Button>
                    <Button
                      variant="outlined"
                      size="small"
                      onClick={handleRejectConnection}
                      disabled={isConnectionActionPending}
                      style={{
                        textTransform: "none",
                        borderRadius: 16,
                        borderColor: "#9e9e9e",
                        color: "#757575",
                        fontWeight: 600,
                        padding: "4px 16px",
                      }}
                    >
                      Reject
                    </Button>
                  </>
                )}
                {connectionState === "accepted" && (
                  <Button
                    variant="outlined"
                    size="small"
                    onClick={handleRemoveConnection}
                    onMouseEnter={() => setIsConnectedActionHovered(true)}
                    onMouseLeave={() => setIsConnectedActionHovered(false)}
                    onFocus={() => setIsConnectedActionHovered(true)}
                    onBlur={() => setIsConnectedActionHovered(false)}
                    disabled={isConnectionActionPending}
                    style={{
                      textTransform: "none",
                      borderRadius: 16,
                      borderColor: isConnectedActionHovered ? "#c62828" : "#2e7d32",
                      color: isConnectedActionHovered ? "#c62828" : "#2e7d32",
                      fontWeight: 600,
                      padding: "4px 16px",
                    }}
                  >
                    {isConnectedActionHovered ? "Remove" : "Connected ✓"}
                  </Button>
                )}
                <Button
                  variant="outlined"
                  size="small"
                  onClick={handleMessageClick}
                  disabled={isStartingConversation || !authUser?._id || !resolvedUserId}
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
            )}

            {showConnections && (
              <div className={classes.connectionsPanel}>
                <div className={classes.connectionsPanelHeader}>
                  <Typography variant="subtitle2" className={classes.connectionsPanelTitle}>
                    {connections} connections
                  </Typography>
                  <Button
                    size="small"
                    variant="text"
                    className={classes.closeConnectionsButton}
                    onClick={handleCloseConnections}
                  >
                    Close
                  </Button>
                </div>
                <LoadingGate isLoading={isConnectionsListLoading}>
                  {connectionsList.length === 0 ? (
                    <Typography variant="body2" color="textSecondary">
                      No connections to show yet.
                    </Typography>
                  ) : (
                    <div className={classes.connectionsList}>
                      {connectionsList.map((connection) => (
                        <div
                          key={connection.connectionId}
                          role="button"
                          tabIndex={0}
                          className={classes.connectionCard}
                          onClick={() => handleViewConnectionProfile(connection.user._id)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              handleViewConnectionProfile(connection.user._id);
                            }
                          }}
                        >
                          <Avatar
                            src={resolveProfilePhoto(connection.user.photoURL)}
                            alt={connection.user.displayName}
                            className={classes.connectionAvatar}
                          />
                          <div className={classes.connectionCardInfo}>
                            <Typography className={classes.connectionCardName}>
                              {connection.user.displayName}
                            </Typography>
                            <Typography className={classes.connectionCardTitle}>
                              {connection.user.title || "No title listed"}
                            </Typography>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </LoadingGate>
              </div>
            )}
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
              <Tab label="Activity" className={classes.tab} />
              <Tab label="About" className={classes.tab} />
            </Tabs>

            {activeTab === 0 && (
              <div className={`${classes.section} ${classes.postsSection}`}>
                <LoadingGate isLoading={posts === undefined}>
                  {userPosts.length === 0 ? (
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
                          liked={profileLikeStatuses?.[post._id] ?? undefined}
                          profile={resolveProfilePhoto(post.author?.photoURL ?? userAvatar)}
                          username={post.author?.displayName ?? userName}
                          timestamp={post.createdAt}
                          description={post.description}
                          fileType={post.fileType}
                          fileData={post.fileData}
                        />
                      ))}
                    </div>
                  )}
                </LoadingGate>
              </div>
            )}

            {activeTab === 1 && (
              <div className={classes.section}>
                <LoadingGate isLoading={activity === undefined}>
                  {activityItems.length === 0 ? (
                    <Typography variant="body2" color="textSecondary">
                      No recent activity yet.
                    </Typography>
                  ) : (
                    <div className={classes.activityList}>
                      {activityItems.map((activityItem) => {
                        const activityText = truncateText(activityItem.content);
                        const activityPostPreview = truncateText(activityItem.postPreview, 140);

                        return (
                          <div
                            key={`${activityItem.activityType}-${activityItem.activityId}`}
                            className={classes.activityCard}
                          >
                            <Typography className={classes.activityHeading}>
                              {activityItem.activityType === "post" ? "Posted" : "Commented"}
                            </Typography>
                            <Typography className={classes.activityTimestamp}>
                              <ReactTimeago
                                date={new Date(activityItem.createdAt).toUTCString()}
                                units="minute"
                              />
                            </Typography>
                            <Typography className={classes.activityBody}>
                              {activityText ||
                                (activityItem.activityType === "post"
                                  ? "Shared a post."
                                  : "Added a comment.")}
                            </Typography>
                            {activityItem.activityType === "comment" && activityPostPreview && (
                              <Typography className={classes.activityContext}>
                                On {activityItem.postAuthorName}&apos;s post: {activityPostPreview}
                              </Typography>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </LoadingGate>
              </div>
            )}

            {activeTab === 2 && (
              <div className={classes.section}>
                <Typography variant="subtitle2" style={{ fontWeight: 700, marginBottom: 6 }}>
                  About
                </Typography>
                <Typography
                  variant="body2"
                  color="textSecondary"
                  component="div"
                  style={{ lineHeight: 1.65 }}
                >
                  {renderBasicRichText(about, "No about information yet.")}
                </Typography>

                <Divider style={{ margin: "16px 0 12px" }} />

                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    marginBottom: 6,
                  }}
                >
                  <Typography variant="subtitle2" style={{ fontWeight: 700 }}>
                    Experience
                  </Typography>
                  {isOwnProfile && (
                    <Button
                      size="small"
                      variant="text"
                      onClick={handleOpenCreateExperienceDialog}
                      style={{
                        textTransform: "none",
                        color: "#2e7d32",
                        fontWeight: 600,
                        minHeight: 32,
                      }}
                    >
                      Add experience
                    </Button>
                  )}
                </div>

                {experienceEntries.length === 0 && legacyExperience.length === 0 && (
                  <Typography variant="body2" color="textSecondary">
                    No experience added yet.
                  </Typography>
                )}

                {experienceEntries.map((entry) => {
                  const dateRange = formatExperienceDateRange(entry.startDate, entry.endDate);
                  return (
                    <div
                      key={entry.id}
                      style={{
                        border: "1px solid rgba(46, 125, 50, 0.2)",
                        borderRadius: 10,
                        padding: "10px 12px",
                        marginBottom: 10,
                      }}
                    >
                      <Typography variant="subtitle2" style={{ fontWeight: 700, marginBottom: 2 }}>
                        {entry.title}
                      </Typography>
                      <Typography
                        variant="body2"
                        color="textSecondary"
                        style={{ fontWeight: 600, marginBottom: dateRange ? 2 : 6 }}
                      >
                        {entry.company}
                      </Typography>
                      {dateRange && (
                        <Typography
                          variant="body2"
                          color="textSecondary"
                          style={{ fontSize: "0.8rem", marginBottom: entry.description ? 6 : 2 }}
                        >
                          {dateRange}
                        </Typography>
                      )}
                      {entry.description && (
                        <Typography
                          variant="body2"
                          color="textSecondary"
                          style={{ whiteSpace: "pre-line", lineHeight: 1.55, marginBottom: 6 }}
                        >
                          {entry.description}
                        </Typography>
                      )}
                      {isOwnProfile && (
                        <div style={{ display: "flex", gap: 6 }}>
                          <Button
                            size="small"
                            variant="outlined"
                            onClick={() => handleOpenEditExperienceDialog(entry)}
                            disabled={isExperienceSavePending}
                            style={{
                              textTransform: "none",
                              borderRadius: 16,
                              borderColor: "#2e7d32",
                              color: "#2e7d32",
                              fontWeight: 600,
                              padding: "2px 10px",
                            }}
                          >
                            Edit
                          </Button>
                          <Button
                            size="small"
                            variant="outlined"
                            onClick={() => handleRemoveExperience(entry.id)}
                            disabled={isExperienceSavePending}
                            style={{
                              textTransform: "none",
                              borderRadius: 16,
                              borderColor: "#c62828",
                              color: "#c62828",
                              fontWeight: 600,
                              padding: "2px 10px",
                            }}
                          >
                            Delete
                          </Button>
                        </div>
                      )}
                    </div>
                  );
                })}

                {legacyExperience.map((exp, index) => (
                  <Typography
                    key={`${exp}-${index}`}
                    variant="body2"
                    color="textSecondary"
                    style={{ marginBottom: 4, lineHeight: 1.55 }}
                  >
                    {exp}
                  </Typography>
                ))}

                <Divider style={{ margin: "16px 0 12px" }} />

                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    marginBottom: 6,
                  }}
                >
                  <Typography variant="subtitle2" style={{ fontWeight: 700 }}>
                    Education
                  </Typography>
                  {isOwnProfile && (
                    <Button
                      size="small"
                      variant="text"
                      onClick={handleOpenCreateEducationDialog}
                      style={{
                        textTransform: "none",
                        color: "#2e7d32",
                        fontWeight: 600,
                        minHeight: 32,
                      }}
                    >
                      Add education
                    </Button>
                  )}
                </div>

                {educationEntries.length === 0 && (
                  <Typography variant="body2" color="textSecondary">
                    No education added yet.
                  </Typography>
                )}

                {educationEntries.map((entry) => {
                  const dateRange = formatEducationDateRange(entry.startYear, entry.endYear);
                  return (
                    <div
                      key={entry.id}
                      style={{
                        border: "1px solid rgba(46, 125, 50, 0.2)",
                        borderRadius: 10,
                        padding: "10px 12px",
                        marginBottom: 10,
                      }}
                    >
                      <Typography variant="subtitle2" style={{ fontWeight: 700, marginBottom: 2 }}>
                        {entry.school}
                      </Typography>
                      <Typography
                        variant="body2"
                        color="textSecondary"
                        style={{ fontWeight: 600, marginBottom: 2 }}
                      >
                        {[entry.degree, entry.field].filter(Boolean).join(", ")}
                      </Typography>
                      {dateRange && (
                        <Typography
                          variant="body2"
                          color="textSecondary"
                          style={{ fontSize: "0.8rem", marginBottom: isOwnProfile ? 6 : 2 }}
                        >
                          {dateRange}
                        </Typography>
                      )}
                      {isOwnProfile && (
                        <div style={{ display: "flex", gap: 6 }}>
                          <Button
                            size="small"
                            variant="outlined"
                            onClick={() => handleOpenEditEducationDialog(entry)}
                            disabled={isEducationSavePending}
                            style={{
                              textTransform: "none",
                              borderRadius: 16,
                              borderColor: "#2e7d32",
                              color: "#2e7d32",
                              fontWeight: 600,
                              padding: "2px 10px",
                            }}
                          >
                            Edit
                          </Button>
                          <Button
                            size="small"
                            variant="outlined"
                            onClick={() => handleRemoveEducation(entry.id)}
                            disabled={isEducationSavePending}
                            style={{
                              textTransform: "none",
                              borderRadius: 16,
                              borderColor: "#c62828",
                              color: "#c62828",
                              fontWeight: 600,
                              padding: "2px 10px",
                            }}
                          >
                            Delete
                          </Button>
                        </div>
                      )}
                    </div>
                  );
                })}

                <Divider style={{ margin: "16px 0 12px" }} />

                <Typography variant="subtitle2" style={{ fontWeight: 700, marginBottom: 8 }}>
                  Skills
                </Typography>

                {isOwnProfile && (
                  <div
                    style={{
                      display: "flex",
                      gap: 8,
                      alignItems: "flex-start",
                      marginBottom: 8,
                      flexWrap: "wrap",
                    }}
                  >
                    <TextField
                      value={skillInputValue}
                      onChange={handleSkillInputChange}
                      variant="outlined"
                      margin="dense"
                      placeholder="Add a skill"
                      size="small"
                      disabled={isSkillMutationPending}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          handleAddSkill();
                        }
                      }}
                      style={{ minWidth: 200, flexGrow: 1 }}
                    />
                    <Button
                      size="small"
                      variant="contained"
                      onClick={handleAddSkill}
                      disabled={isSkillMutationPending}
                      style={{
                        textTransform: "none",
                        backgroundColor: "#2e7d32",
                        color: "#fff",
                        fontWeight: 600,
                        minHeight: 40,
                        borderRadius: 18,
                        padding: "0 16px",
                      }}
                    >
                      Add
                    </Button>
                  </div>
                )}

                {skillError && (
                  <Typography
                    variant="body2"
                    style={{ color: "#c62828", fontSize: "0.8rem", marginBottom: 8 }}
                  >
                    {skillError}
                  </Typography>
                )}

                {skills.length === 0 ? (
                  <Typography variant="body2" color="textSecondary">
                    No skills added yet.
                  </Typography>
                ) : (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    {skills.map((skill, index) => (
                      <Chip
                        key={`${skill}-${index}`}
                        label={skill}
                        size="small"
                        onDelete={isOwnProfile ? () => handleRemoveSkill(skill) : undefined}
                        disabled={isSkillMutationPending}
                        style={{
                          backgroundColor: "rgba(46, 125, 50, 0.12)",
                          color: "#1b5e20",
                          fontWeight: 600,
                        }}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}

            <Dialog
              open={isExperienceDialogOpen}
              onClose={() => handleCloseExperienceDialog()}
              fullWidth
              maxWidth="sm"
              aria-labelledby="experience-dialog-title"
            >
              <DialogTitle id="experience-dialog-title">
                {editingExperienceId ? "Edit experience" : "Add experience"}
              </DialogTitle>
              <DialogContent dividers>
                <TextField
                  label="Title"
                  value={experienceFormData.title}
                  onChange={handleExperienceFieldChange("title")}
                  variant="outlined"
                  margin="dense"
                  fullWidth
                  required
                />
                <TextField
                  label="Company"
                  value={experienceFormData.company}
                  onChange={handleExperienceFieldChange("company")}
                  variant="outlined"
                  margin="dense"
                  fullWidth
                  required
                />
                <TextField
                  label="Start date"
                  placeholder="e.g. Jan 2022"
                  value={experienceFormData.startDate}
                  onChange={handleExperienceFieldChange("startDate")}
                  variant="outlined"
                  margin="dense"
                  fullWidth
                  required
                />
                <TextField
                  label="End date"
                  placeholder="e.g. Present"
                  value={experienceFormData.endDate}
                  onChange={handleExperienceFieldChange("endDate")}
                  variant="outlined"
                  margin="dense"
                  fullWidth
                />
                <TextField
                  label="Description"
                  value={experienceFormData.description}
                  onChange={handleExperienceFieldChange("description")}
                  variant="outlined"
                  margin="dense"
                  fullWidth
                  multiline
                  rows={3}
                />
              </DialogContent>
              <DialogActions>
                <Button
                  onClick={() => handleCloseExperienceDialog()}
                  disabled={isExperienceSavePending}
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleSaveExperience}
                  variant="contained"
                  color="primary"
                  disabled={isExperienceSavePending}
                >
                  {editingExperienceId ? "Update" : "Save"}
                </Button>
              </DialogActions>
            </Dialog>

            <Dialog
              open={isEducationDialogOpen}
              onClose={() => handleCloseEducationDialog()}
              fullWidth
              maxWidth="sm"
              aria-labelledby="education-dialog-title"
            >
              <DialogTitle id="education-dialog-title">
                {editingEducationId ? "Edit education" : "Add education"}
              </DialogTitle>
              <DialogContent dividers>
                <TextField
                  label="School"
                  value={educationFormData.school}
                  onChange={handleEducationFieldChange("school")}
                  variant="outlined"
                  margin="dense"
                  fullWidth
                  required
                />
                <TextField
                  label="Degree"
                  value={educationFormData.degree}
                  onChange={handleEducationFieldChange("degree")}
                  variant="outlined"
                  margin="dense"
                  fullWidth
                  required
                />
                <TextField
                  label="Field of study"
                  value={educationFormData.field}
                  onChange={handleEducationFieldChange("field")}
                  variant="outlined"
                  margin="dense"
                  fullWidth
                  required
                />
                <TextField
                  label="Start year"
                  placeholder="e.g. 2018"
                  value={educationFormData.startYear}
                  onChange={handleEducationFieldChange("startYear")}
                  variant="outlined"
                  margin="dense"
                  fullWidth
                  required
                />
                <TextField
                  label="End year"
                  placeholder="e.g. 2022 or Present"
                  value={educationFormData.endYear}
                  onChange={handleEducationFieldChange("endYear")}
                  variant="outlined"
                  margin="dense"
                  fullWidth
                />
              </DialogContent>
              <DialogActions>
                <Button
                  onClick={() => handleCloseEducationDialog()}
                  disabled={isEducationSavePending}
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleSaveEducation}
                  variant="contained"
                  color="primary"
                  disabled={isEducationSavePending}
                >
                  {editingEducationId ? "Update" : "Save"}
                </Button>
              </DialogActions>
            </Dialog>

            <Dialog
              open={isEditDialogOpen}
              onClose={handleCloseEditDialog}
              fullWidth
              maxWidth="sm"
              aria-labelledby="edit-profile-dialog-title"
            >
              <DialogTitle id="edit-profile-dialog-title">Edit profile</DialogTitle>
              <DialogContent dividers>
                <TextField
                  label="Display name"
                  value={profileFormData.displayName}
                  onChange={handleEditFieldChange("displayName")}
                  variant="outlined"
                  margin="dense"
                  fullWidth
                />
                <TextField
                  label="Title"
                  value={profileFormData.title}
                  onChange={handleEditFieldChange("title")}
                  variant="outlined"
                  margin="dense"
                  fullWidth
                />
                <TextField
                  label="Headline"
                  value={profileFormData.headline}
                  onChange={handleEditFieldChange("headline")}
                  variant="outlined"
                  margin="dense"
                  fullWidth
                />
                <TextField
                  label="Location"
                  value={profileFormData.location}
                  onChange={handleEditFieldChange("location")}
                  variant="outlined"
                  margin="dense"
                  fullWidth
                />
                <TextField
                  label="About"
                  value={profileFormData.about}
                  onChange={handleEditFieldChange("about")}
                  variant="outlined"
                  margin="dense"
                  fullWidth
                  multiline
                  rows={5}
                />
                <Typography
                  variant="caption"
                  color="textSecondary"
                  style={{ display: "block", marginTop: 6 }}
                >
                  Supports **bold**, *italic*, and line breaks.
                </Typography>
                <div
                  style={{
                    marginTop: 8,
                    border: "1px solid rgba(0, 0, 0, 0.12)",
                    borderRadius: 6,
                    padding: "10px 12px",
                    backgroundColor: "rgba(0, 0, 0, 0.02)",
                  }}
                >
                  <Typography variant="caption" style={{ fontWeight: 700, display: "block" }}>
                    Preview
                  </Typography>
                  <Typography
                    variant="body2"
                    color="textSecondary"
                    component="div"
                    style={{ marginTop: 6, lineHeight: 1.6 }}
                  >
                    {renderBasicRichText(profileFormData.about, "Preview appears here.")}
                  </Typography>
                </div>
              </DialogContent>
              <DialogActions>
                <Button onClick={handleCloseEditDialog} disabled={isProfileSavePending}>
                  Cancel
                </Button>
                <Button
                  onClick={handleSaveProfile}
                  variant="contained"
                  color="primary"
                  disabled={isProfileSavePending}
                >
                  Save
                </Button>
              </DialogActions>
            </Dialog>
          </>
        </LoadingGate>
      </Paper>
    </div>
  );
};

export default Profile;
